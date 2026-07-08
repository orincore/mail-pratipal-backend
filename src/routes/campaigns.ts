import { Router, Response } from "express";
import mongoose from "mongoose";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailCampaign from "../models/EmailCampaign";
import { getEmailProvider } from "../providers/provider-factory";
import "../models/EmailTemplate"; // Ensure template model is registered for populate
import { prepareEmailHtml, replaceMergeTags } from "../lib/tracking-parser";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import { 
  WHATSAPP_TEMPLATES, 
  DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET,
  buildWhatsappTemplateParams, 
  type WhatsappTemplateName 
} from "../lib/whatsapp-templates";

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

// GET /api/campaigns/meta/whatsapp-templates - approved MSG91 templates for admin UI
router.get("/meta/whatsapp-templates", async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({ templates: WHATSAPP_TEMPLATES, defaultForPreset: DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET });
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
      scheduled_at,
      channel,
      whatsapp_template
    } = req.body;

    const resolvedChannel = channel || "email";
    if (!name) {
      return res.status(400).json({ error: "Campaign name is required" });
    }

    if (resolvedChannel !== "whatsapp" && (!subject || !sender_name || !sender_email || !template_id)) {
      return res.status(400).json({ error: "Email configuration fields are required for email channel" });
    }

    let resolvedWhatsappTemplate: WhatsappTemplateName | undefined = whatsapp_template;
    if (resolvedChannel !== "email") {
      if (!resolvedWhatsappTemplate || !WHATSAPP_TEMPLATES.some((t) => t.name === resolvedWhatsappTemplate)) {
        return res.status(400).json({ error: "A valid whatsapp_template is required for the WhatsApp channel" });
      }
    }

    const scheduledDate = schedule_type === "scheduled" && scheduled_at 
      ? new Date(scheduled_at) 
      : new Date();

    const campaign = await EmailCampaign.create({
      name,
      subject: resolvedChannel !== "whatsapp" ? subject : undefined,
      sender_name: resolvedChannel !== "whatsapp" ? sender_name : undefined,
      sender_email: resolvedChannel !== "whatsapp" ? sender_email : undefined,
      reply_to: resolvedChannel !== "whatsapp" ? reply_to : undefined,
      template_id: resolvedChannel !== "whatsapp" ? template_id : undefined,
      channel: resolvedChannel,
      whatsapp_template: resolvedChannel !== "email" ? resolvedWhatsappTemplate : undefined,
      audience,
      schedule_type,
      scheduled_at: scheduledDate,
      status: schedule_type === "immediate" ? "sending" : "scheduled",
      dispatch_status: resolvedChannel === "whatsapp" ? "skipped" : "pending",
      whatsapp_dispatch_status: resolvedChannel === "email" ? "skipped" : "pending",
      stats: {
        sent: 0,
        delivered: 0,
        opens: 0,
        clicks: 0,
        bounces: 0,
        complaints: 0,
        unsubscribed: 0,
        whatsapp_sent: 0,
        whatsapp_failed: 0,
      }
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

// POST /api/campaigns/:id/test-send - Send test email for a campaign
router.post("/:id/test-send", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { to } = req.body;

    if (!to) {
      return res.status(400).json({ error: "Recipient email 'to' is required" });
    }

    const campaign = await EmailCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Load template
    const EmailTemplate = mongoose.model("EmailTemplate");
    const template = await EmailTemplate.findById(campaign.template_id);
    if (!template) {
      return res.status(404).json({ error: "Template not found for this campaign" });
    }

    const provider = getEmailProvider();
    
    // We can send the template's html
    let finalHtml = template.html_content || "";
    if (template.type === "text") {
      finalHtml = `
        <div style="font-family: sans-serif; font-size: 15px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">
          ${finalHtml}
        </div>
      `;
    }

    // Parse HTML to inject personalization mock values and the unsubscribe link (tracking disabled)
    const trackingUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
    const parsedHtml = prepareEmailHtml({
      html: finalHtml,
      subscriber: {
        email: to,
        first_name: "Test",
        last_name: "Recipient",
        status: "subscribed",
      } as any,
      campaignId: campaign._id.toString(),
      trackingUrl,
      trackingEnabled: { opens: false, clicks: false },
    });

    console.log(`Campaign Test Send: Dispatching test email for campaign ${campaign.name} to ${to}`);

    const result = await provider.sendEmail({
      to,
      fromName: campaign.sender_name,
      fromEmail: campaign.sender_email,
      subject: `[TEST] ${replaceMergeTags(campaign.subject || "", {
        email: to,
        first_name: "Test",
        last_name: "Recipient",
        status: "subscribed",
      } as any)}`,
      html: parsedHtml,
      replyTo: campaign.reply_to,
    });

    return res.json({
      success: true,
      messageId: result.messageId,
      dispatched_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Campaign test send error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/campaigns/:id/rerun - Duplicate and reschedule an existing campaign
router.post("/:id/rerun", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { schedule_type, scheduled_at } = req.body;

    const campaign = await EmailCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const scheduledDate = schedule_type === "scheduled" && scheduled_at 
      ? new Date(scheduled_at) 
      : new Date();

    // Create a duplicated campaign
    const newCampaign = await EmailCampaign.create({
      name: `${campaign.name} (Rerun)`,
      subject: campaign.subject,
      sender_name: campaign.sender_name,
      sender_email: campaign.sender_email,
      reply_to: campaign.reply_to,
      template_id: campaign.template_id,
      channel: campaign.channel,
      whatsapp_template: campaign.whatsapp_template,
      audience: campaign.audience,
      schedule_type,
      scheduled_at: scheduledDate,
      status: schedule_type === "immediate" ? "sending" : "scheduled",
      dispatch_status: campaign.channel === "whatsapp" ? "skipped" : "pending",
      whatsapp_dispatch_status: campaign.channel === "email" ? "skipped" : "pending",
      stats: {
        sent: 0,
        delivered: 0,
        opens: 0,
        clicks: 0,
        bounces: 0,
        complaints: 0,
        unsubscribed: 0,
        whatsapp_sent: 0,
        whatsapp_failed: 0,
      }
    });

    return res.json({ success: true, campaign: newCampaign });
  } catch (error: any) {
    console.error("Rerun campaign error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/campaigns/:id/test-send-whatsapp - Send test WhatsApp for a campaign
router.post("/:id/test-send-whatsapp", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { to } = req.body;

    if (!to) {
      return res.status(400).json({ error: "Recipient WhatsApp number 'to' is required" });
    }

    const campaign = await EmailCampaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (!campaign.whatsapp_template) {
      return res.status(400).json({ error: "This campaign has no WhatsApp template configured" });
    }

    const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(campaign.whatsapp_template as WhatsappTemplateName, {
      firstName: "Test Recipient",
      webinarTitle: campaign.name,
      startsAt: campaign.scheduled_at || new Date(),
      timezone: "Asia/Kolkata",
    });

    console.log(`Campaign Test WhatsApp Send: Dispatching test message for campaign ${campaign.name} to ${to}`);

    const result = await sendWhatsappTemplate({
      to,
      templateName: campaign.whatsapp_template,
      bodyParams,
      buttonUrlSuffix,
    });

    return res.json({
      success: true,
      messageId: result.messageId,
      dispatched_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Campaign WhatsApp test-send error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
