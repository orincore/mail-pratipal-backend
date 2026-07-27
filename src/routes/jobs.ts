import { Router, Request, Response } from "express";
import { runQueueSweep } from "../lib/queue-processor";
import { config } from "../config";

const router = Router();

// POST /api/jobs/process - Trigger a campaigns sweep (external cron target).
// Webinar reminders no longer go through this path — they're dispatched via
// BullMQ delayed jobs (src/lib/queue/, run by src/scripts/queue-worker.ts)
// for exact-time firing. This endpoint now only matters for campaigns; the
// standalone src/scripts/worker.ts (mail-campaign-worker PM2 process) calls
// the same runQueueSweep() directly in its own poll loop instead of hitting
// this route — deploy at least one of the two, or nothing sweeps campaigns.
router.post("/process", async (req: Request, res: Response) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader ? authHeader.replace("Bearer ", "") : "";

  // The cron secret is always enforced — config.ts guarantees a real value
  // exists in production and provides a dev fallback locally.
  if (token !== config.cronSecret) {
    return res.status(401).json({ error: "Unauthorized cron process execution request" });
  }

  try {
    const trackingUrl = config.appUrl;
    
    // Execute queue processor sweep
    const result = await runQueueSweep(trackingUrl);

    return res.json({
      success: true,
      processed_at: new Date().toISOString(),
      ...result
    });
  } catch (error: any) {
    console.error("Queue execution sweep failed:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
