import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";

const router = Router();

interface UnsubscribeSource {
  idField: "campaign_id" | "reminder_id";
  id: string;
  isCampaign: boolean;
}

function resolveSource(params: {
  campaignId?: string;
  sourceType?: string;
  sourceId?: string;
}): UnsubscribeSource | null {
  const id = params.sourceId || params.campaignId || "";
  if (!id || !mongoose.isValidObjectId(id)) return null;

  if (params.sourceType === "reminder") {
    return { idField: "reminder_id", id, isCampaign: false };
  }
  return { idField: "campaign_id", id, isCampaign: true };
}

async function recordUnsubscribe(email: string, source: UnsubscribeSource | null) {
  await EmailSubscriber.findOneAndUpdate({ email }, { status: "unsubscribed" });

  if (source) {
    // Check if already unsubscribed for this send
    const alreadyUnsubscribed = await EmailEvent.exists({
      [source.idField]: source.id,
      recipient_email: email,
      event_type: "unsubscribe",
    });

    // 1. Log unsubscribe event
    await EmailEvent.create({
      [source.idField]: source.id,
      recipient_email: email,
      event_type: "unsubscribe",
      timestamp: new Date(),
    });

    // 2. Increment stats (campaigns track unsubscribes; reminders don't carry the stat)
    if (!alreadyUnsubscribed && source.isCampaign) {
      await EmailCampaign.findByIdAndUpdate(source.id, {
        $inc: { "stats.unsubscribed": 1 },
      });
    }
  } else {
    await EmailEvent.create({
      recipient_email: email,
      event_type: "unsubscribe",
      timestamp: new Date(),
    });
  }
}

// POST /api/unsubscribe - Handle unsubscribe and resubscribe (from the /unsubscribe page)
router.post("/", async (req: Request, res: Response) => {
  try {
    const { email, campaignId, sourceType, sourceId, resubscribe } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const source = resolveSource({ campaignId, sourceType, sourceId });

    if (resubscribe) {
      // Re-subscribe the user
      await EmailSubscriber.findOneAndUpdate(
        { email: cleanEmail },
        { status: "subscribed" },
        { upsert: true }
      );

      if (source) {
        await EmailEvent.create({
          [source.idField]: source.id,
          recipient_email: cleanEmail,
          event_type: "sent",
          details: { action: "resubscribe" },
          timestamp: new Date(),
        });
      }

      return res.json({ success: true, message: "Successfully resubscribed" });
    }

    await recordUnsubscribe(cleanEmail, source);
    return res.json({ success: true, message: "Successfully unsubscribed" });
  } catch (error: any) {
    console.error("Unsubscribe API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/unsubscribe/one-click - RFC 8058 List-Unsubscribe one-click target.
// Mail clients POST here (body: "List-Unsubscribe=One-Click") with the
// recipient identified via the query string baked into the header at send time.
router.post("/one-click", async (req: Request, res: Response) => {
  try {
    const email = ((req.query.email as string) || "").toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const source = resolveSource({
      campaignId: req.query.campaignId as string,
      sourceType: req.query.sourceType as string,
      sourceId: req.query.sourceId as string,
    });

    await recordUnsubscribe(email, source);
    return res.json({ success: true });
  } catch (error: any) {
    console.error("One-click unsubscribe error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
