import dns from "node:dns";
// Same fix as server.ts: pin outbound connections to IPv4 so MSG91's IP
// whitelist (which this VPS's rotating IPv6 addresses kept breaking) works.
dns.setDefaultResultOrder("ipv4first");

import dotenv from "dotenv";
import { connectDB } from "../lib/db";
import { runQueueSweep } from "../lib/queue-processor";
import { config } from "../config";

dotenv.config();

// Campaigns only — webinar reminders are dispatched via BullMQ delayed jobs
// (src/lib/queue/, run by src/scripts/queue-worker.ts) for exact-time firing
// and rate-limited fan-out instead of this polling sweep. This daemon is now
// the permanent campaign poller; deploy it as its own PM2 process
// (mail-campaign-worker) alongside mail-queue-worker.
const INTERVAL_MS = 10000; // Poll every 10 seconds
const TRACKING_URL = config.appUrl;

console.log("=====================================================================");
console.log("📧 Standalone Node.js Campaign Queue Daemon Started");
console.log(`Tracking URL:    ${TRACKING_URL}`);
console.log(`Polling Interv:  ${INTERVAL_MS / 1000}s`);
console.log("=====================================================================");

async function runWorkerCycle() {
  try {
    // Ensure DB connection is active
    await connectDB();

    // Execute queue sweep (campaigns only)
    const result = await runQueueSweep(TRACKING_URL);

    const campCount = result.campaigns?.length || 0;

    if (campCount > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Queue sweep completed:`);
      console.log(`  - Campaigns:`, JSON.stringify(result.campaigns));
    }
  } catch (err: any) {
    console.error(`[${new Date().toLocaleTimeString()}] Queue processing loop error:`, err.message);
  }
}

// Perform initial run immediately
runWorkerCycle();

// Schedule polling loop
const timer = setInterval(runWorkerCycle, INTERVAL_MS);

// Handle clean shutdown
process.on("SIGINT", () => {
  clearInterval(timer);
  console.log("\nQueue daemon stopped cleanly. Goodbye!");
  process.exit(0);
});
