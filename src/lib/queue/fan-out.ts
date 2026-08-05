import WebinarReminder from "../../models/WebinarReminder";
import EmailSubscriber from "../../models/EmailSubscriber";
import EmailEvent from "../../models/EmailEvent";
import { webinarTag } from "../webinar-sync";
import { flowProducer } from "./queues";
import { config } from "../../config";
import { normalizeWhatsappNumber } from "../phone";

export type ReminderChannel = "email" | "whatsapp";

// "subscribed" is an EMAIL deliverability/consent flag — set to
// "unsubscribed"/"bounced"/"complained" by email-specific events (an
// unsubscribe link click, an SES bounce/complaint webhook). None of those
// have any bearing on WhatsApp: a bounced email address or a past email
// unsubscribe doesn't mean the person opted out of WhatsApp, and blocking
// WhatsApp sends on it was why a webinar with 407 registrants only reached
// 281 on WhatsApp too, not just email — the whatsapp leg was silently gated
// by an unrelated email-channel status. Only the email leg honors it.
async function pendingSubscribersForLeg(reminderId: any, tag: string, channel: ReminderChannel) {
  const query: Record<string, any> = { tags: tag };
  if (channel === "email") query.status = "subscribed";
  // WhatsApp's own opt-out signal (replied "STOP" — see routes/whatsapp.ts's
  // POST /webhook), deliberately separate from the email `status` field per
  // the comment above.
  if (channel === "whatsapp") query.whatsapp_opted_out = { $ne: true };
  const subscribers = await EmailSubscriber.find(query);
  const sentTo = await EmailEvent.find({
    reminder_id: reminderId,
    channel,
    event_type: "sent",
  }).distinct("recipient_email");
  const sentSet = new Set(sentTo.map((e: string) => e.toLowerCase()));
  const pending = subscribers.filter((sub: any) => sub.email && !sentSet.has(sub.email.toLowerCase()));

  if (channel !== "whatsapp") return pending;

  // A re-registration under a different/typo'd email creates a SEPARATE
  // EmailSubscriber doc (email is the only unique key on that model — see
  // its schema), but carries the same whatsapp_number. Nothing upstream
  // merges those, so without this the loop below would enqueue one real
  // WhatsApp send per duplicate doc, all landing on the same phone. Email
  // never hits this because the email-unique index already collapses
  // same-email re-registrations to one doc before we even get here. Keep
  // exactly one representative per normalized number.
  const seenPhones = new Set<string>();
  const deduped: typeof pending = [];
  for (const sub of pending) {
    const phone = normalizeWhatsappNumber(sub.whatsapp_number);
    if (!phone) {
      deduped.push(sub); // no number on file — let the worker record its existing "failed: no number" outcome
      continue;
    }
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);
    deduped.push(sub);
  }
  return deduped;
}

/**
 * Enqueues one send job per pending recipient for a single (reminder,
 * channel) leg, wrapped in a FlowProducer parent job that flips the leg's
 * dispatch_status to "sent" once every child has settled. Shared by both the
 * scheduled delayed-job path (reminder-scheduler.worker.ts) and the manual
 * "Send Instantly" route — one implementation, no duplicated audience/claim
 * logic between "scheduled" and "instant".
 *
 * Job data carries only IDs, not rendered content — a job can sit queued for
 * a while behind the rate limiter, and each worker re-fetches fresh
 * subscriber/template/webinar state at send time so nothing stale (e.g. a
 * mid-flight unsubscribe) gets baked in at enqueue time.
 */
export async function fanOutReminderLeg(reminder: any, webinar: any, channel: ReminderChannel): Promise<void> {
  const statusField = channel === "email" ? "dispatch_status" : "whatsapp_dispatch_status";

  // Leg-wide config problem (not per-recipient) — fail fast before enqueuing
  // anything, same as the old sweep's upfront check.
  if (channel === "email" && !reminder.template_id) {
    await WebinarReminder.updateOne({ _id: reminder._id }, { $set: { [statusField]: "skipped" } });
    return;
  }
  if (channel === "whatsapp" && !reminder.whatsapp_template) {
    await WebinarReminder.updateOne({ _id: reminder._id }, { $set: { [statusField]: "skipped" } });
    return;
  }

  const tag = webinarTag(webinar);
  const pending = await pendingSubscribersForLeg(reminder._id, tag, channel);

  if (pending.length === 0) {
    await WebinarReminder.updateOne({ _id: reminder._id }, { $set: { [statusField]: "sent" } });
    return;
  }

  // Atomically claim "pending" -> "sending" so two concurrent triggers (the
  // scheduled job firing at the same instant an admin clicks Send Instantly)
  // can't both snapshot the audience and enqueue duplicate flows. If it's
  // already "sending" (e.g. a reconciliation re-check while a previous flow
  // is still draining), proceed anyway — the per-recipient jobId below makes
  // re-adding a no-op for anyone already enqueued.
  if (reminder[statusField] === "pending") {
    const claimed = await WebinarReminder.findOneAndUpdate(
      { _id: reminder._id, [statusField]: "pending" },
      { $set: { [statusField]: "sending" } }
    );
    if (!claimed) return; // someone else just claimed it
  }

  const queueName = channel === "email" ? "email-send" : "whatsapp-send";
  // WhatsApp: exactly ONE attempt, never retried. WHATSAPP_SEND_MAX_RETRIES
  // used to grant 3 attempts, and any "transient" failure (a timeout/429/5xx
  // that MSG91 returned AFTER actually accepting the message) re-sent the
  // whole message on each retry — recipients received the same reminder up to
  // 3 times. A genuinely failed single attempt is recorded as "failed" and
  // stays visible in stats; it is never silently re-fired. Email keeps its
  // retries: a duplicate email is annoying, a failed one is invisible, and
  // SES throttling (the usual transient failure) happens before acceptance.
  const attempts = channel === "email" ? config.email.sendMaxRetries + 1 : 1;

  await flowProducer.add({
    name: "finalize",
    queueName: "reminder-finalize",
    data: { reminderId: reminder._id.toString(), channel },
    opts: {
      // BullMQ rejects ":" in custom job IDs (its own Redis key separator).
      jobId: `finalize-${channel}-${reminder._id}`,
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600 },
    },
    children: pending.map((sub: any) => ({
      name: "send",
      queueName,
      data: { reminderId: reminder._id.toString(), subscriberId: sub._id.toString() },
      opts: {
        // BullMQ-level dedup — defense-in-depth alongside the EmailEvent check.
        jobId: `${channel}-${reminder._id}-${sub._id}`,
        attempts,
        ...(channel === "email" ? { backoff: { type: "custom" as const } } : {}),
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    })),
  });
}
