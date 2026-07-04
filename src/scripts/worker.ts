import dotenv from "dotenv";
import path from "path";
import { connectDB } from "../lib/db";
import { runQueueSweep } from "../lib/queue-processor";

dotenv.config();

const INTERVAL_MS = 10000; // Poll every 10 seconds
const TRACKING_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";

console.log("=====================================================================");
console.log("📧 Standalone Node.js Queue Daemon Started");
console.log(`Tracking URL:    ${TRACKING_URL}`);
console.log(`Polling Interv:  ${INTERVAL_MS / 1000}s`);
console.log("=====================================================================");

async function runWorkerCycle() {
  try {
    // Ensure DB connection is active
    await connectDB();
    
    // Execute queue sweeps
    const result = await runQueueSweep(TRACKING_URL);
    
    const campCount = result.campaigns?.length || 0;
    const autoCount = result.automations?.length || 0;
    
    if (campCount > 0 || autoCount > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Drip queue sweep completed:`);
      if (campCount > 0) {
        console.log(`  - Campaigns:`, JSON.stringify(result.campaigns));
      }
      if (autoCount > 0) {
        console.log(`  - Automations:`, JSON.stringify(result.automations));
      }
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
