import { Router, Request, Response } from "express";
import { runQueueSweep } from "../lib/queue-processor";

const router = Router();

// POST /api/jobs/process - Trigger background execution sweeps
router.post("/process", async (req: Request, res: Response) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader ? authHeader.replace("Bearer ", "") : "";
  const expectedToken = process.env.CRON_SECRET || "fallback-cron-secret-change-me";

  // Enforce validation in production mode
  if (process.env.NODE_ENV === "production" && token !== expectedToken) {
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
