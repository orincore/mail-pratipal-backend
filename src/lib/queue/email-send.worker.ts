import { Worker, UnrecoverableError } from "bullmq";
import EmailSubscriber from "../../models/EmailSubscriber";
import EmailTemplate from "../../models/EmailTemplate";
import EmailEvent from "../../models/EmailEvent";
import WebinarReminder from "../../models/WebinarReminder";
import Webinar from "../../models/Webinar";
import { getEmailProvider } from "../../providers/provider-factory";
import { prepareEmailHtml, replaceMergeTags, buildListUnsubscribeHeaders, TrackingSource } from "../tracking-parser";
import { isTransientSendError, getDailyQuotaRemaining } from "../send-throttle";
import { wrapTextTemplate } from "../queue-processor";
import { config } from "../../config";
import { redisConnection, queuePrefix } from "./connection";
import { emailSendQueue } from "./queues";

interface EmailSendJobData {
  reminderId: string;
  subscriberId: string;
}

// Re-fetches everything fresh at send time (not baked in at enqueue) so a job
// sitting behind the rate limiter for a while never sends stale content to a
// subscriber who e.g. unsubscribed in the meantime.
async function processEmailSend(job: { data: EmailSendJobData }): Promise<void> {
  const { reminderId, subscriberId } = job.data;

  const [reminder, subscriber] = await Promise.all([
    WebinarReminder.findById(reminderId),
    EmailSubscriber.findById(subscriberId),
  ]);
  if (!reminder || !subscriber || subscriber.status !== "subscribed" || !subscriber.email) return;

  const webinar = await Webinar.findById(reminder.webinar_id);
  if (!webinar || webinar.status === "cancelled") return;

  const template = await EmailTemplate.findById(reminder.template_id);
  if (!template) {
    throw new UnrecoverableError(`Template ${reminder.template_id} not found for reminder ${reminderId}`);
  }

  // Same rolling-24h SES quota shared with campaigns. If exhausted, pause
  // this queue for a few minutes rather than failing/retrying the job
  // immediately — it'll be picked back up once the window frees.
  const quotaRemaining = await getDailyQuotaRemaining();
  if (quotaRemaining <= 0) {
    await emailSendQueue.rateLimit(5 * 60 * 1000);
    throw Worker.RateLimitError();
  }

  const trackingUrl = config.appUrl;
  const source: TrackingSource = { type: "reminder", id: reminder._id.toString() };
  // The reminder's webinar is authoritative for {{join_link}}/{{webinar}} —
  // subscriber metadata can lag behind a registrant sync.
  const tagOverrides: Record<string, string> = {
    "{{join_link}}": `${config.mainWebsite.url}/webinar/join/${webinar.source_window_id}`,
    "{{webinar}}": webinar.title,
  };

  try {
    const customizedHtml = prepareEmailHtml({
      html: template.html_content || "",
      subscriber,
      source,
      trackingUrl,
      trackingEnabled: { opens: true, clicks: true },
      tagOverrides,
    });
    const finalHtml = wrapTextTemplate(customizedHtml, template.type);

    const provider = getEmailProvider();
    const { messageId } = await provider.sendEmail({
      to: subscriber.email,
      fromName: reminder.sender_name,
      fromEmail: reminder.sender_email,
      subject: replaceMergeTags(reminder.subject, subscriber, tagOverrides),
      html: finalHtml,
      headers: buildListUnsubscribeHeaders(trackingUrl, subscriber.email, source),
    });

    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email: subscriber.email.toLowerCase(),
      channel: "email",
      event_type: "sent",
      timestamp: new Date(),
      details: { messageId },
    });
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.sent": 1 } });
  } catch (err: any) {
    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email: subscriber.email.toLowerCase(),
      channel: "email",
      event_type: "failed",
      timestamp: new Date(),
      details: { error: err.message, transient: isTransientSendError(err) },
    });
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.failed": 1 } });

    if (!isTransientSendError(err)) {
      // Permanent failure (bad address, rejected identity) — don't burn retries.
      throw new UnrecoverableError(err.message);
    }
    throw err; // transient — BullMQ retries per job `attempts`/`backoff`.
  }
}

export const emailSendWorker = new Worker<EmailSendJobData>("email-send", processEmailSend, {
  connection: redisConnection,
  prefix: queuePrefix,
  concurrency: 8,
  limiter: { max: config.email.maxSendRatePerSecond, duration: 1000 },
  settings: {
    // Same 1s/4s/9s...capped-15s formula send-throttle.ts used for retries.
    backoffStrategy: (attemptsMade: number) => Math.min(15000, 1000 * attemptsMade * attemptsMade),
  },
});
