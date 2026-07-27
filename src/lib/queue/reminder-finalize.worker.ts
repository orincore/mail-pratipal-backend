import { Worker } from "bullmq";
import WebinarReminder from "../../models/WebinarReminder";
import { redisConnection, queuePrefix } from "./connection";
import { ReminderChannel } from "./fan-out";

interface FinalizeJobData {
  reminderId: string;
  channel: ReminderChannel;
}

// FlowProducer parent job — BullMQ only runs this once every child (one per
// recipient) has settled (completed or exhausted retries), so reaching this
// handler at all means the leg is fully drained. No hand-rolled counters.
async function processFinalize(job: { data: FinalizeJobData }): Promise<void> {
  const { reminderId, channel } = job.data;
  const statusField = channel === "email" ? "dispatch_status" : "whatsapp_dispatch_status";

  // Guarded by current-value check so this is safe to run more than once
  // (e.g. a retried finalize job) without clobbering a later state change.
  await WebinarReminder.updateOne(
    { _id: reminderId, [statusField]: "sending" },
    { $set: { [statusField]: "sent" } }
  );
}

export const reminderFinalizeWorker = new Worker<FinalizeJobData>("reminder-finalize", processFinalize, {
  connection: redisConnection,
  prefix: queuePrefix,
  concurrency: 5,
});
