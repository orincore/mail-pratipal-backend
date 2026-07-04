import { Router, Request, Response } from "express";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";

const router = Router();

// POST /api/unsubscribe - Handle unsubscribe and resubscribe
router.post("/", async (req: Request, res: Response) => {
  try {
    const { email, campaignId, resubscribe } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const cleanEmail = email.toLowerCase().trim();

    if (resubscribe) {
      // Re-subscribe the user
      await EmailSubscriber.findOneAndUpdate(
        { email: cleanEmail },
        { status: "subscribed" },
        { upsert: true }
      );

      if (campaignId) {
        await EmailEvent.create({
          campaign_id: campaignId,
          recipient_email: cleanEmail,
          event_type: "sent",
          details: { action: "resubscribe" },
          timestamp: new Date(),
        });
      }

      return res.json({ success: true, message: "Successfully resubscribed" });
    } else {
      // Unsubscribe the user
      await EmailSubscriber.findOneAndUpdate(
        { email: cleanEmail },
        { status: "unsubscribed" }
      );

      if (campaignId) {
        // Check if already unsubscribed
        const alreadyUnsubscribed = await EmailEvent.exists({
          campaign_id: campaignId,
          recipient_email: cleanEmail,
          event_type: "unsubscribe",
        });

        // 1. Log unsubscribe event
        await EmailEvent.create({
          campaign_id: campaignId,
          recipient_email: cleanEmail,
          event_type: "unsubscribe",
          timestamp: new Date(),
        });

        // 2. Increment stats
        if (!alreadyUnsubscribed) {
          await EmailCampaign.findByIdAndUpdate(campaignId, {
            $inc: { "stats.unsubscribed": 1 },
          });
        }
      } else {
        await EmailEvent.create({
          recipient_email: cleanEmail,
          event_type: "unsubscribe",
          timestamp: new Date(),
        });
      }

      return res.json({ success: true, message: "Successfully unsubscribed" });
    }
  } catch (error: any) {
    console.error("Unsubscribe API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
