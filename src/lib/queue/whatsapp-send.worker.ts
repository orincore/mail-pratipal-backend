import { Worker, UnrecoverableError } from "bullmq";
import EmailSubscriber from "../../models/EmailSubscriber";
import EmailEvent from "../../models/EmailEvent";
import WebinarReminder from "../../models/WebinarReminder";
import Webinar from "../../models/Webinar";
import { sendWhatsappTemplate } from "../../providers/msg91-whatsapp.provider";
import { buildWhatsappTemplateParams, describeOffset, WhatsappTemplateName } from "../whatsapp-templates";
import { config } from "../../config";
import { redisConnection, queuePrefix } from "./connection";

interface WhatsappSendJobData {
  reminderId: string;
  subscriberId: string;
}

async function processWhatsappSend(job: { data: WhatsappSendJobData }): Promise<void> {
  const { reminderId, subscriberId } = job.data;

  const [reminder, subscriber] = await Promise.all([
    WebinarReminder.findById(reminderId),
    EmailSubscriber.findById(subscriberId),
  ]);
  // status ("subscribed"/"unsubscribed"/"bounced"/"complained") is an
  // EMAIL-channel concept — see fan-out.ts's pendingSubscribersForLeg for why
  // WhatsApp sends don't gate on it. Re-checking it here would silently drop
  // every job fan-out just deliberately enqueued for a non-"subscribed"
  // recipient, undoing that fix.
  if (!reminder || !subscriber || !subscriber.email) return;

  const webinar = await Webinar.findById(reminder.webinar_id);
  if (!webinar || webinar.status === "cancelled") return;

  const recipient_email = subscriber.email.toLowerCase();

  if (!subscriber.whatsapp_number) {
    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email,
      channel: "whatsapp",
      event_type: "failed",
      timestamp: new Date(),
      details: { error: "No WhatsApp number on file" },
    });
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.whatsapp_failed": 1 } });
    throw new UnrecoverableError("No WhatsApp number on file");
  }

  // Claim-FIRST: insert the unique-indexed "sent" row BEFORE calling MSG91.
  // The old order (check exists → send → record) left a window where a
  // re-triggered fan-out, a stalled-job re-run, or a concurrent worker could
  // all pass the check and each deliver a real message — the unique index
  // only caught the duplicate *record*, after the duplicate message had
  // already gone out. With the claim first, exactly one process can ever own
  // this (reminder, recipient) send; every other attempt hits a
  // duplicate-key error here and skips without touching MSG91.
  try {
    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email,
      channel: "whatsapp",
      event_type: "sent",
      timestamp: new Date(),
      details: { claimed: true },
    });
  } catch (claimErr: any) {
    if (claimErr?.code === 11000) return; // already sent (or being sent) — never re-send
    throw claimErr;
  }

  try {
    const relativePhrase = describeOffset(reminder.offset_type, reminder.offset_value);
    const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(
      reminder.whatsapp_template as WhatsappTemplateName,
      {
        firstName: subscriber.first_name || "there",
        webinarTitle: webinar.title,
        startsAt: webinar.starts_at,
        timezone: webinar.timezone,
        relativeTimePhrase: relativePhrase,
        joinSuffix: String(webinar.source_window_id),
      }
    );

    const result = await sendWhatsappTemplate({
      to: subscriber.whatsapp_number,
      templateName: reminder.whatsapp_template,
      bodyParams,
      buttonUrlSuffix,
    });

    await EmailEvent.updateOne(
      { reminder_id: reminder._id, recipient_email, channel: "whatsapp", event_type: "sent" },
      { $set: { "details.messageId": result.messageId, "details.claimed": false } }
    );
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.whatsapp_sent": 1 } });
  } catch (err: any) {
    // Release the claim so the failure is visible as "failed", not a phantom
    // "sent" — but this job is NEVER retried (attempts: 1 in fan-out.ts):
    // WhatsApp sends get exactly one attempt, because a "failure" here can be
    // a response-side error (timeout/429/5xx) on a message MSG91 actually
    // accepted and delivered, and retrying used to send recipients the same
    // message up to 3 times. A manual Send Instantly re-fire is the recovery
    // path for genuinely failed recipients.
    await EmailEvent.deleteOne({
      reminder_id: reminder._id,
      recipient_email,
      channel: "whatsapp",
      event_type: "sent",
      "details.claimed": true,
    }).catch(() => {});
    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email,
      channel: "whatsapp",
      event_type: "failed",
      timestamp: new Date(),
      details: { error: err.message },
    });
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.whatsapp_failed": 1 } });

    throw new UnrecoverableError(err.message);
  }
}

export const whatsappSendWorker = new Worker<WhatsappSendJobData>("whatsapp-send", processWhatsappSend, {
  connection: redisConnection,
  prefix: queuePrefix,
  concurrency: 5,
  limiter: { max: config.whatsapp.maxSendRatePerSecond, duration: 1000 },
});
