import { Worker } from "bullmq";
import WebinarReminder from "../../models/WebinarReminder";
import Webinar from "../../models/Webinar";
import { fanOutReminderLeg } from "./fan-out";
import { redisConnection, queuePrefix } from "./connection";
import { reminderSchedulerQueue, scheduleReminderJob } from "./queues";

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

  if (["pending", "sending"].includes(reminder.dispatch_status)) {
    await fanOutReminderLeg(reminder, webinar, "email");
  }
  if (["pending", "sending"].includes(reminder.whatsapp_dispatch_status)) {
    await fanOutReminderLeg(reminder, webinar, "whatsapp");
  }
}

// Correctness backstop, not the primary recovery path — BullMQ's own
// persistence (Redis AOF) + stalled-job recovery handles most restart
// scenarios natively. This catches the narrower case of a reminder that's
// due but was never actually enqueued (a bug, or genuine Redis data loss).
export async function reconcileDueReminders(): Promise<void> {
  const due = await WebinarReminder.find({
    status: "active",
    computed_send_at: { $lte: new Date() },
    $or: [
      { dispatch_status: { $in: ["pending", "sending"] } },
      { whatsapp_dispatch_status: { $in: ["pending", "sending"] } },
    ],
  });

  for (const reminder of due) {
    const existing = await reminderSchedulerQueue.getJob(`reminder:${reminder._id}`);
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
