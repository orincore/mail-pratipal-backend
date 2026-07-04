import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailCampaign from "../models/EmailCampaign";
import "../models/EmailTemplate"; // Ensure template model is registered for populate

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

// GET /api/campaigns - List campaigns
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const campaigns = await EmailCampaign.find()
      .sort({ created_at: -1 })
      .populate("template_id", "name");
      
    return res.json(campaigns);
  } catch (error: any) {
    console.error("GET campaigns error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/campaigns - Launch campaign
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { 
      name, 
      subject, 
      sender_name, 
      sender_email, 
      reply_to, 
      template_id, 
      audience, 
      schedule_type,
      scheduled_at
    } = req.body;

    if (!name || !subject || !sender_name || !sender_email || !template_id) {
      return res.status(400).json({ error: "Required fields are missing" });
    }

    const scheduledDate = schedule_type === "scheduled" && scheduled_at 
      ? new Date(scheduled_at) 
      : new Date();

    const campaign = await EmailCampaign.create({
      name,
      subject,
      sender_name,
      sender_email,
      reply_to,
      template_id,
      audience,
      schedule_type,
      scheduled_at: scheduledDate,
      status: schedule_type === "immediate" ? "sending" : "scheduled",
      stats: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribed: 0 }
    });

    return res.json({ success: true, campaign });
  } catch (error: any) {
    console.error("POST campaign error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/campaigns - Update status or draft fields
router.put("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, action, ...updateFields } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Campaign ID is required" });
    }

    const campaign = await EmailCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Toggle runtime campaign status
    if (action === "pause") {
      if (campaign.status === "sending" || campaign.status === "scheduled") {
        campaign.status = "paused";
        await campaign.save();
        return res.json({ success: true, campaign });
      } else {
        return res.status(400).json({ error: "Only active campaigns can be paused" });
      }
    } 
    
    if (action === "resume") {
      if (campaign.status === "paused") {
        campaign.status = "sending";
        await campaign.save();
        return res.json({ success: true, campaign });
      } else {
        return res.status(400).json({ error: "Only paused campaigns can be resumed" });
      }
    }

    if (action === "cancel") {
      if (campaign.status === "sending" || campaign.status === "scheduled" || campaign.status === "paused") {
        campaign.status = "cancelled";
        await campaign.save();
        return res.json({ success: true, campaign });
      } else {
        return res.status(400).json({ error: "Campaign cannot be cancelled in current status" });
      }
    }

    // Basic updating for drafts
    const updatedCampaign = await EmailCampaign.findByIdAndUpdate(id, updateFields, { new: true });
    return res.json({ success: true, campaign: updatedCampaign });
  } catch (error: any) {
    console.error("PUT campaign error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/campaigns - Delete campaign
router.delete("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.query.id as string;

    if (!id) {
      return res.status(400).json({ error: "Campaign ID is required" });
    }

    const campaign = await EmailCampaign.findByIdAndDelete(id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    return res.json({ success: true, message: "Campaign deleted successfully" });
  } catch (error: any) {
    console.error("DELETE campaign error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
