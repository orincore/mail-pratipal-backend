import { Worker } from "bullmq";
import WebinarReminder from "../../models/WebinarReminder";
import Webinar from "../../models/Webinar";
import { fanOutReminderLeg } from "./fan-out";
import { syncRegistrantsForWebinar } from "../webinar-sync";
import { redisConnection, queuePrefix } from "./connection";
import { reminderSchedulerQueue, scheduleReminderJob, reminderJobId } from "./queues";

interface DispatchJobData {
  reminderId: string;
}

async function handleDispatch(reminderId: string): Promise<void> {
  const reminder = await WebinarReminder.findById(reminderId);
  // Deleted or paused since this job was scheduled — no-op.
  if (!reminder || reminder.status !== "active") return;

  const webinar = await Webinar.findById(reminder.webinar_id);
  if (!webinar) return;

  if (webinar.status === "cancelled") {
    const updates: Record<string, string> = {};
    if (["pending", "sending"].includes(reminder.dispatch_status)) updates.dispatch_status = "skipped";
    if (["pending", "sending"].includes(reminder.whatsapp_dispatch_status)) updates.whatsapp_dispatch_status = "skipped";
    if (Object.keys(updates).length > 0) await WebinarReminder.updateOne({ _id: reminder._id }, { $set: updates });
    return;
  }
  if (webinar.status !== "upcoming") return;

  const dispatchingEmail = ["pending", "sending"].includes(reminder.dispatch_status);
  const dispatchingWhatsapp = ["pending", "sending"].includes(reminder.whatsapp_dispatch_status);
  if (!dispatchingEmail && !dispatchingWhatsapp) return;

  // Registrant tagging only otherwise happens on the manual "Sync Now"
  // button or right before a manual "Send Instantly" — a reminder firing on
  // its own delayed timer (the normal path, for every scheduled reminder)
  // never refreshed the registrant list itself. Since people keep
  // registering right up to send time, that meant a reminder due to fire
  // for e.g. 407 currently-registered people would only actually reach
  // whoever had been tagged as of the last manual sync — sometimes hours
  // stale — silently under-notifying the rest with no error or indication
  // anything was missed. force=true bypasses the normal 5-min sync
  // throttle so this pulls the truly current list right before sending,
  // not a stale in-window skip. A fetch failure here is swallowed inside
  // syncRegistrantsForWebinar itself (logged, not thrown) — dispatch still
  // proceeds against whatever's already tagged, same as before this fix.
  await syncRegistrantsForWebinar(webinar, true);

  if (dispatchingEmail) {
    await fanOutReminderLeg(reminder, webinar, "email");
  }
  if (dispatchingWhatsapp) {
    await fanOutReminderLeg(reminder, webinar, "whatsapp");
  }
}

// Correctness backstop, not the primary recovery path — BullMQ's own
// persistence (Redis AOF) + stalled-job recovery handles most restart
// scenarios natively. This catches the narrower case of a reminder that's
// due but was never actually enqueued (a bug, or genuine Redis data loss).
//
// Only "pending" (never claimed by fanOutReminderLeg) legs qualify — NOT
// "sending". This used to also match "sending", combined with a jobId typo
// below (`reminder:` vs. the real `reminder-` format from reminderJobId())
// that made the "already scheduled" guard never match anything. Since the
// scheduler's own dispatch job removes itself the instant handleDispatch
// returns (removeOnComplete: true) — which happens almost immediately, well
// before a large recipient list finishes draining through the rate limiter —
// that combination meant this backstop refired handleDispatch for every
// still-draining "sending" leg on every 5-minute tick, each time
// re-running fanOutReminderLeg while the previous fan-out was still in
// flight. This was the root cause of a production incident where a single
// webinar reminder's WhatsApp leg was redispatched repeatedly and recipients
// received the same message far more than once. "sending" means fan-out has
// already claimed the leg and enqueued jobs for it — that in-flight work (or
// the reminder-finalize job once it settles) is what should carry it to
// "sent", not another reconcile-triggered fan-out pass.
export async function reconcileDueReminders(): Promise<void> {
  const due = await WebinarReminder.find({
    status: "active",
    computed_send_at: { $lte: new Date() },
    $or: [{ dispatch_status: "pending" }, { whatsapp_dispatch_status: "pending" }],
  });

  for (const reminder of due) {
    const existing = await reminderSchedulerQueue.getJob(reminderJobId(reminder._id));
    if (!existing) {
      // Re-enqueuing a reminder that's actually already fully sent is a
      // cheap no-op — fanOutReminderLeg's pending-audience query comes back
      // empty and it just flips straight to "sent".
      await scheduleReminderJob(reminder);
    }
  }
}

async function processScheduler(job: { name: string; data: DispatchJobData }): Promise<void> {
  if (job.name === "reconcile") {
    await reconcileDueReminders();
    return;
  }
  await handleDispatch(job.data.reminderId);
}

export const reminderSchedulerWorker = new Worker("reminder-scheduler", processScheduler, {
  connection: redisConnection,
  prefix: queuePrefix,
  concurrency: 5,
});

/** Registers the repeatable reconciliation job — call once at worker boot. */
export async function registerReconciliationSchedule(): Promise<void> {
  await reminderSchedulerQueue.upsertJobScheduler(
    "reconcile",
    { every: 5 * 60 * 1000 },
    { name: "reconcile", data: {} }
  );
}
