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

// Same TRANSIENT_ERROR classification shape as send-throttle.ts's
// isTransientSendError, adapted for MSG91's error shape (httpStatus attached
// by msg91-whatsapp.provider.ts on throw).
function isTransientWhatsappError(err: any): boolean {
  if (!err) return false;
  const status = err.httpStatus;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"]);
  if (TRANSIENT_CODES.has(err.code)) return true;
  return false;
}

async function processWhatsappSend(job: { data: WhatsappSendJobData }): Promise<void> {
  const { reminderId, subscriberId } = job.data;

  const [reminder, subscriber] = await Promise.all([
    WebinarReminder.findById(reminderId),
    EmailSubscriber.findById(subscriberId),
  ]);
  if (!reminder || !subscriber || subscriber.status !== "subscribed" || !subscriber.email) return;

  const webinar = await Webinar.findById(reminder.webinar_id);
  if (!webinar || webinar.status === "cancelled") return;

  if (!subscriber.whatsapp_number) {
    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email: subscriber.email.toLowerCase(),
      channel: "whatsapp",
      event_type: "failed",
      timestamp: new Date(),
      details: { error: "No WhatsApp number on file" },
    });
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.whatsapp_failed": 1 } });
    throw new UnrecoverableError("No WhatsApp number on file");
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

    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email: subscriber.email.toLowerCase(),
      channel: "whatsapp",
      event_type: "sent",
      timestamp: new Date(),
      details: { messageId: result.messageId },
    });
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.whatsapp_sent": 1 } });
  } catch (err: any) {
    await EmailEvent.create({
      reminder_id: reminder._id,
      recipient_email: subscriber.email.toLowerCase(),
      channel: "whatsapp",
      event_type: "failed",
      timestamp: new Date(),
      details: { error: err.message },
    });
    await WebinarReminder.updateOne({ _id: reminder._id }, { $inc: { "stats.whatsapp_failed": 1 } });

    if (!isTransientWhatsappError(err)) {
      throw new UnrecoverableError(err.message);
    }
    throw err;
  }
}

export const whatsappSendWorker = new Worker<WhatsappSendJobData>("whatsapp-send", processWhatsappSend, {
  connection: redisConnection,
  prefix: queuePrefix,
  concurrency: 5,
  limiter: { max: config.whatsapp.maxSendRatePerSecond, duration: 1000 },
  settings: {
    backoffStrategy: (attemptsMade: number) => Math.min(15000, 1000 * attemptsMade * attemptsMade),
  },
});
