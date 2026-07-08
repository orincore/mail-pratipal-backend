import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";
import "../models/EmailTemplate"; // Ensure template model is registered

const router = Router();

router.use(authMiddleware);

// GET /api/auth/me - Retrieve current verified user payload
router.get("/auth/me", async (req: AuthenticatedRequest, res: Response) => {
  return res.json({ user: req.user });
});

// GET /api/failed-events - Retrieve recent bounce and complaint events with reasons
router.get("/failed-events", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const failedEvents = await EmailEvent.find({
      event_type: { $in: ["bounce", "complaint"] }
    })
      .sort({ timestamp: -1 })
      .populate("campaign_id", "name")
      .limit(100);

    return res.json(failedEvents);
  } catch (error: any) {
    console.error("GET failed-events error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/dashboard-stats - Fetch all dashboard metrics
router.get("/dashboard-stats", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const timeframe = (req.query.timeframe as string) || "weekly";

    // 1. Determine date filter boundaries
    let startOfPeriod = new Date();
    if (timeframe === "daily") {
      startOfPeriod.setHours(0, 0, 0, 0);
    } else if (timeframe === "monthly") {
      startOfPeriod.setDate(startOfPeriod.getDate() - 29);
      startOfPeriod.setHours(0, 0, 0, 0);
    } else { // default to weekly (last 7 days)
      startOfPeriod.setDate(startOfPeriod.getDate() - 6);
      startOfPeriod.setHours(0, 0, 0, 0);
    }

    const eventQuery = { timestamp: { $gte: startOfPeriod } };

    // 2. Fetch metrics from MongoDB within timeframe
    const totalSubscribers = await EmailSubscriber.countDocuments({ status: "subscribed" });

    // Email specific metrics (exclude WhatsApp)
    const totalSent = await EmailEvent.countDocuments({ event_type: "sent", channel: { $ne: "whatsapp" }, ...eventQuery });
    const totalOpens = await EmailEvent.countDocuments({ event_type: "open", ...eventQuery });
    const totalClicks = await EmailEvent.countDocuments({ event_type: "click", ...eventQuery });
    const totalBounces = await EmailEvent.countDocuments({ event_type: "bounce", channel: { $ne: "whatsapp" }, ...eventQuery });
    const totalComplaints = await EmailEvent.countDocuments({ event_type: "complaint", ...eventQuery });

    // WhatsApp specific metrics
    const totalWhatsappSent = await EmailEvent.countDocuments({ event_type: "sent", channel: "whatsapp", ...eventQuery });
    const totalWhatsappFailed = await EmailEvent.countDocuments({ event_type: "bounce", channel: "whatsapp", ...eventQuery });
    const totalWhatsappOpens = await EmailEvent.countDocuments({ event_type: "open", channel: "whatsapp", ...eventQuery });

    const activeSchedules = await EmailCampaign.countDocuments({ status: "scheduled" });

    // 3. Fetch recent campaigns
    const recentCampaigns = await EmailCampaign.find()
      .sort({ created_at: -1 })
      .limit(5)
      .populate("template_id", "name");

    // 4. Generate performance timeline stats based on timeframe
    const dailyStats: any[] = [];

    if (timeframe === "daily") {
      // 24 hours of today
      for (let i = 0; i < 24; i++) {
        const startOfHour = new Date(startOfPeriod);
        startOfHour.setHours(i, 0, 0, 0);
        const endOfHour = new Date(startOfPeriod);
        endOfHour.setHours(i, 59, 59, 999);

        const sent = await EmailEvent.countDocuments({
          event_type: "sent",
          channel: { $ne: "whatsapp" },
          timestamp: { $gte: startOfHour, $lte: endOfHour },
        });

        const opens = await EmailEvent.countDocuments({
          event_type: "open",
          timestamp: { $gte: startOfHour, $lte: endOfHour },
        });

        const whatsappSent = await EmailEvent.countDocuments({
          event_type: "sent",
          channel: "whatsapp",
          timestamp: { $gte: startOfHour, $lte: endOfHour },
        });

        const whatsappFailed = await EmailEvent.countDocuments({
          event_type: "bounce",
          channel: "whatsapp",
          timestamp: { $gte: startOfHour, $lte: endOfHour },
        });

        chartStatsPush(dailyStats, `${i.toString().padStart(2, "0")}:00`, sent, opens, whatsappSent, whatsappFailed);
      }
    } else if (timeframe === "monthly") {
      // 30 days
      for (let i = 0; i < 30; i++) {
        const day = new Date(startOfPeriod);
        day.setDate(day.getDate() + i);

        const startOfDay = new Date(day.setHours(0, 0, 0, 0));
        const endOfDay = new Date(day.setHours(23, 59, 59, 999));

        const sent = await EmailEvent.countDocuments({
          event_type: "sent",
          channel: { $ne: "whatsapp" },
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        const opens = await EmailEvent.countDocuments({
          event_type: "open",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        const whatsappSent = await EmailEvent.countDocuments({
          event_type: "sent",
          channel: "whatsapp",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        const whatsappFailed = await EmailEvent.countDocuments({
          event_type: "bounce",
          channel: "whatsapp",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        chartStatsPush(
          dailyStats,
          day.toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
          sent,
          opens,
          whatsappSent,
          whatsappFailed
        );
      }
    } else {
      // weekly (7 days)
      for (let i = 0; i < 7; i++) {
        const day = new Date(startOfPeriod);
        day.setDate(day.getDate() + i);

        const startOfDay = new Date(day.setHours(0, 0, 0, 0));
        const endOfDay = new Date(day.setHours(23, 59, 59, 999));

        const sent = await EmailEvent.countDocuments({
          event_type: "sent",
          channel: { $ne: "whatsapp" },
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        const opens = await EmailEvent.countDocuments({
          event_type: "open",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        const whatsappSent = await EmailEvent.countDocuments({
          event_type: "sent",
          channel: "whatsapp",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        const whatsappFailed = await EmailEvent.countDocuments({
          event_type: "bounce",
          channel: "whatsapp",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        chartStatsPush(
          dailyStats,
          day.toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
          sent,
          opens,
          whatsappSent,
          whatsappFailed
        );
      }
    }

    return res.json({
      totalSubscribers,
      totalSent,
      totalOpens,
      totalClicks,
      totalBounces,
      totalComplaints,
      totalWhatsappSent,
      totalWhatsappFailed,
      totalWhatsappOpens,
      activeSchedules,
      recentCampaigns,
      dailyStats,
      emailProvider: process.env.EMAIL_PROVIDER || "mock"
    });
  } catch (error: any) {
    console.error("GET dashboard-stats error:", error);
    return res.status(500).json({ error: error.message });
  }
});

function chartStatsPush(arr: any[], dateLabel: string, sent: number, opens: number, whatsappSent: number, whatsappFailed: number) {
  arr.push({ dateLabel, sent, opens, whatsappSent, whatsappFailed });
}

export default router;
