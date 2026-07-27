import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import {
  reminderSchedulerQueue,
  emailSendQueue,
  whatsappSendQueue,
  reminderFinalizeQueue,
} from "../lib/queue/queues";

// Real visibility into queue depth / active / failed jobs (with payload +
// error inspection, manual retry) instead of hand-querying Mongo to diagnose
// "is it stuck" — which is literally how the reminder-batching outage this
// queue replaced was originally found. Mount behind admin auth in server.ts.
const BASE_PATH = "/api/admin/queues";

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(BASE_PATH);

createBullBoard({
  queues: [
    new BullMQAdapter(reminderSchedulerQueue),
    new BullMQAdapter(emailSendQueue),
    new BullMQAdapter(whatsappSendQueue),
    new BullMQAdapter(reminderFinalizeQueue),
  ],
  serverAdapter,
});

export const queueAdminRouter = serverAdapter.getRouter();
export const queueAdminBasePath = BASE_PATH;
