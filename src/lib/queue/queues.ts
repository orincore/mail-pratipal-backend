import { Queue, FlowProducer } from "bullmq";
import { redisConnection, queuePrefix } from "./connection";

const opts = { connection: redisConnection, prefix: queuePrefix };

// Timing: one delayed job per reminder, fires at computed_send_at.
export const reminderSchedulerQueue = new Queue("reminder-scheduler", opts);
// Fan-out: one job per recipient per (reminder, channel) leg.
export const emailSendQueue = new Queue("email-send", opts);
export const whatsappSendQueue = new Queue("whatsapp-send", opts);
// Completion tracking: FlowProducer parent jobs, one per (reminder, channel) leg.
export const reminderFinalizeQueue = new Queue("reminder-finalize", opts);
export const flowProducer = new FlowProducer(opts);

export interface SchedulableReminder {
  _id: any;
  computed_send_at: Date;
}

// BullMQ rejects custom job IDs containing ":" (reserved as its own Redis key
// separator) — hyphens throughout instead. Exported so every caller that
// needs to look up this job (e.g. the reconcile backstop) derives the same
// string instead of hand-rolling it and drifting out of sync.
export function reminderJobId(reminderId: any): string {
  return `reminder-${reminderId}`;
}

/**
 * Upserts the delayed "fire this reminder" job for a reminder, scheduled at
 * its exact computed_send_at (sub-second precision — Redis's own timer, not
 * application polling). Safe to call repeatedly: reschedules an already
 * queued job in place, or drops+re-adds if it's already active/completed.
 */
export async function scheduleReminderJob(reminder: SchedulableReminder): Promise<void> {
  const jobId = reminderJobId(reminder._id);
  const delay = Math.max(0, reminder.computed_send_at.getTime() - Date.now());

  const existing = await reminderSchedulerQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "delayed") {
      await existing.changeDelay(delay);
      return;
    }
    // Already active/completed/failed under this jobId — drop it so the
    // fresh add() below isn't rejected as a duplicate.
    await existing.remove().catch(() => {});
  }

  await reminderSchedulerQueue.add(
    "dispatch",
    { reminderId: reminder._id.toString() },
    {
      jobId,
      delay,
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600 },
    }
  );
}

/** Drops a reminder's pending delayed job — e.g. on pause/cancel/delete/send-now. */
export async function cancelReminderJob(reminderId: any): Promise<void> {
  const job = await reminderSchedulerQueue.getJob(reminderJobId(reminderId));
  if (job) await job.remove().catch(() => {});
}
