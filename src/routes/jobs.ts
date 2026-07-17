import { Router, Request, Response } from "express";
import { runQueueSweep } from "../lib/queue-processor";
import { config } from "../config";

const router = Router();

// POST /api/jobs/process - Trigger background execution sweeps
router.post("/process", async (req: Request, res: Response) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader ? authHeader.replace("Bearer ", "") : "";

  // The cron secret is always enforced — config.ts guarantees a real value
  // exists in production and provides a dev fallback locally.
  if (token !== config.cronSecret) {
    return res.status(401).json({ error: "Unauthorized cron process execution request" });
  }

  try {
    const trackingUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
    
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
