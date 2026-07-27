import dns from "node:dns";
// Same fix as server.ts/worker.ts: pin outbound connections to IPv4 so
// MSG91's IP whitelist (which this VPS's rotating IPv6 addresses kept
// breaking) works — WhatsApp sends happen in this process now.
dns.setDefaultResultOrder("ipv4first");

import dotenv from "dotenv";
dotenv.config();

import { connectDB } from "../lib/db";
import { emailSendWorker } from "../lib/queue/email-send.worker";
import { whatsappSendWorker } from "../lib/queue/whatsapp-send.worker";
import { reminderFinalizeWorker } from "../lib/queue/reminder-finalize.worker";
import { reminderSchedulerWorker, registerReconciliationSchedule, reconcileDueReminders } from "../lib/queue/reminder-scheduler.worker";

async function main() {
  await connectDB();

  console.log("=====================================================================");
  console.log("📬 Reminder Queue Worker Started");
  console.log("Queues: reminder-scheduler, email-send, whatsapp-send, reminder-finalize");
  console.log("=====================================================================");

  await registerReconciliationSchedule();
  // Also run once immediately on boot, rather than waiting for the first
  // 5-minute tick, so a restart doesn't leave a due reminder stalled longer
  // than necessary.
  await reconcileDueReminders().catch((err) => console.error("Startup reconciliation failed:", err));

  const workers = [emailSendWorker, whatsappSendWorker, reminderFinalizeWorker, reminderSchedulerWorker];
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      console.error(`[${worker.name}] job ${job?.id} failed:`, err.message);
    });
    worker.on("error", (err) => {
      console.error(`[${worker.name}] worker error:`, err);
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — closing workers gracefully (in-flight jobs finish first)...`);
    await Promise.all(workers.map((w) => w.close()));
    console.log("Queue worker stopped cleanly. Goodbye!");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Queue worker failed to start:", err);
  process.exit(1);
});
