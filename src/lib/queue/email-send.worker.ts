import { Worker, UnrecoverableError, Job } from "bullmq";
import EmailSubscriber from "../../models/EmailSubscriber";
import EmailTemplate from "../../models/EmailTemplate";
import EmailEvent from "../../models/EmailEvent";
import WebinarReminder from "../../models/WebinarReminder";
import Webinar from "../../models/Webinar";
import { getEmailProvider } from "../../providers/provider-factory";
import { prepareEmailHtml, replaceMergeTags, buildListUnsubscribeHeaders, TrackingSource } from "../tracking-parser";
import { isTransientSendError, getDailyQuotaRemaining, sendEmailThrottled } from "../send-throttle";
import { formatDate } from "../whatsapp-templates";
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
async function processEmailSend(job: Job<EmailSendJobData>): Promise<void> {
  const { reminderId, subscriberId } = job.data;

  const [reminder, subscriber] = await Promise.all([
    WebinarReminder.findById(reminderId),
    EmailSubscriber.findById(subscriberId),
  ]);
  if (!reminder || !subscriber || subscriber.status !== "subscribed" || !subscriber.email) return;

  const webinar = await Webinar.findById(reminder.webinar_id);
  if (!webinar || webinar.status === "cancelled") return;

  // Hard guard, checked immediately before actually sending — mirrors the
  // same check in whatsapp-send.worker.ts. See that file for why a retried
  // job or re-triggered fan-out sweep needs this in addition to fan-out.ts's
  // enqueue-time filter.
  const alreadySent = await EmailEvent.exists({
    reminder_id: reminder._id,
    recipient_email: subscriber.email.toLowerCase(),
    channel: "email",
    event_type: "sent",
  });
  if (alreadySent) return;

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
    "{{date}}": formatDate(webinar.starts_at, webinar.timezone),
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
    // Shared with the campaign send path (queue-processor.ts) — one process-
    // wide pacer, so a reminder sweep and a campaign sweep running at the
    // same moment split the SAME per-second SES budget instead of each
    // independently believing it owns the full rate and together blowing
    // past it. Also retries transient errors (SES throttling included) with
    // backoff internally, before this ever reaches the catch block below.
    const { messageId } = await sendEmailThrottled(provider, {
      to: subscriber.email,
      fromName: reminder.sender_name,
      fromEmail: reminder.sender_email,
      subject: replaceMergeTags(reminder.subject, subscriber, tagOverrides),
      html: finalHtml,
      headers: buildListUnsubscribeHeaders(trackingUrl, subscriber.email, source),
    });

    try {
      await EmailEvent.create({
        reminder_id: reminder._id,
        recipient_email: subscriber.email.toLowerCase(),
        channel: "email",
        event_type: "sent",
        timestamp: new Date(),
        details: { messageId },
      });
      await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.sent": 1 } });
    } catch (recordErr: any) {
      // See whatsapp-send.worker.ts's identical guard — a duplicate-key hit
      // here means the email already went out, just don't double-log it as
      // a failure.
      if (recordErr?.code !== 11000) throw recordErr;
    }
  } catch (err: any) {
    const transient = isTransientSendError(err);
    // sendEmailThrottled already retried transient errors (SES throttling
    // included) internally before ever throwing here, but BullMQ still has
    // its OWN retry budget on top (job.opts.attempts, set in fan-out.ts) —
    // this job isn't done for good until that's exhausted too. Recording a
    // "failed" EmailEvent on attempt 1 of N for something that goes on to
    // succeed on attempt 2 doubled-up as both "failed" and "sent" on the
    // dashboard, showing recipients as delivery failures when their email
    // actually went out a few seconds later — the exact false alarm this
    // guards against. Only log it once nothing more will be tried.
    const attemptsMade = job.attemptsMade ?? 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    const isFinalAttempt = !transient || attemptsMade >= maxAttempts;

    if (isFinalAttempt) {
      await EmailEvent.create({
        reminder_id: reminder._id,
        recipient_email: subscriber.email.toLowerCase(),
        channel: "email",
        event_type: "failed",
        timestamp: new Date(),
        details: { error: err.message, transient },
      });
      await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.failed": 1 } });
    }

    if (!transient) {
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
