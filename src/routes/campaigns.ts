import { Router, Response } from "express";
import mongoose from "mongoose";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailCampaign from "../models/EmailCampaign";
import EmailEvent from "../models/EmailEvent";
import { getEmailProvider } from "../providers/provider-factory";
import "../models/EmailTemplate"; // Ensure template model is registered for populate
import "../models/Segment"; // Ensure segment model is registered for populate
import { prepareEmailHtml, replaceMergeTags } from "../lib/tracking-parser";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import { getMergedWhatsappTemplates } from "../lib/whatsapp-template-sync";
import { config } from "../config";
import {
  DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET,
  buildWhatsappTemplateParams,
  type WhatsappTemplateName,
} from "../lib/whatsapp-templates";

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

const FRESH_STATS = {
  sent: 0,
  delivered: 0,
  opens: 0,
  clicks: 0,
  bounces: 0,
  complaints: 0,
  unsubscribed: 0,
  failed: 0,
  whatsapp_sent: 0,
  whatsapp_failed: 0,
};

function sanitizeAbTest(abTest: any) {
  if (!abTest?.enabled) return { enabled: false, split_percentage: 50 };
  const split = Math.min(99, Math.max(1, parseInt(abTest.split_percentage, 10) || 50));
  return {
    enabled: true,
    split_percentage: split,
    subject_b: abTest.subject_b || undefined,
    template_id_b: abTest.template_id_b || undefined,
  };
}

function sanitizeAudience(audience: any) {
  return {
    all: !!audience?.all,
    lists: Array.isArray(audience?.lists) ? audience.lists : [],
    tags: Array.isArray(audience?.tags) ? audience.tags : [],
    segment_id:
      audience?.segment_id && mongoose.isValidObjectId(audience.segment_id)
        ? audience.segment_id
        : undefined,
  };
}

// GET /api/campaigns - List campaigns (paginated)
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const status = (req.query.status as string) || "";
    const search = (req.query.search as string) || "";

    const query: any = {};
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { subject: { $regex: search, $options: "i" } },
      ];
    }

    const total = await EmailCampaign.countDocuments(query);
    const campaigns = await EmailCampaign.find(query)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("template_id", "name")
      .populate("ab_test.template_id_b", "name")
      .populate("audience.segment_id", "name");

    return res.json({
      campaigns,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error: any) {
    console.error("GET campaigns error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns/meta/whatsapp-templates - MSG91-synced templates for admin UI
router.get("/meta/whatsapp-templates", async (_req: AuthenticatedRequest, res: Response) => {
  // Reminder-only templates (webinar_starting_soon/webinar_live_now) need a
  // real Webinar to build their "Join Webinar" button link from — campaigns
  // have no webinar context, so offering them here would let an admin save
  // a campaign whose WhatsApp send Meta rejects outright at dispatch time.
  const templates = (await getMergedWhatsappTemplates()).filter((t) => !t.reminderOnly);
  return res.json({ templates, defaultForPreset: DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET });
});

// POST /api/campaigns - Create campaign (draft or launch)
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
      whatsapp_template,
      ab_test,
      save_as_draft,
    } = req.body;

    const resolvedChannel = channel || "email";
    if (!name) {
      return res.status(400).json({ error: "Campaign name is required" });
    }

    const isDraft = !!save_as_draft;

    // Drafts can be saved half-finished; a launch needs the full config.
    if (!isDraft) {
      if (resolvedChannel !== "whatsapp" && (!subject || !sender_name || !sender_email || !template_id)) {
        return res.status(400).json({ error: "Email configuration fields are required for email channel" });
      }
    }

    let resolvedWhatsappTemplate: string | undefined = whatsapp_template;
    if (!isDraft && resolvedChannel !== "email") {
      const templates = await getMergedWhatsappTemplates();
      // reminderOnly templates need a real Webinar to link to — never valid
      // for a campaign, which has no webinar context (see meta endpoint above).
      const valid = templates.some((t) => t.supported && !t.reminderOnly && t.name === resolvedWhatsappTemplate);
      if (!valid) {
        return res.status(400).json({ error: "A valid whatsapp_template is required for the WhatsApp channel" });
      }
    }

    const sanitizedAb = sanitizeAbTest(ab_test);
    if (!isDraft && sanitizedAb.enabled && resolvedChannel !== "whatsapp" && !sanitizedAb.subject_b && !sanitizedAb.template_id_b) {
      return res.status(400).json({ error: "A/B test needs a variant B subject and/or template" });
    }

    const scheduledDate = schedule_type === "scheduled" && scheduled_at ? new Date(scheduled_at) : new Date();

    const campaign = await EmailCampaign.create({
      name,
      subject: resolvedChannel !== "whatsapp" ? subject : undefined,
      sender_name: resolvedChannel !== "whatsapp" ? sender_name : undefined,
      sender_email: resolvedChannel !== "whatsapp" ? sender_email : undefined,
      reply_to: resolvedChannel !== "whatsapp" ? reply_to : undefined,
      template_id: resolvedChannel !== "whatsapp" && template_id ? template_id : undefined,
      channel: resolvedChannel,
      whatsapp_template: resolvedChannel !== "email" ? resolvedWhatsappTemplate : undefined,
      ab_test: resolvedChannel !== "whatsapp" ? sanitizedAb : undefined,
      audience: sanitizeAudience(audience),
      schedule_type: schedule_type || "immediate",
      scheduled_at: scheduledDate,
      status: isDraft ? "draft" : schedule_type === "immediate" ? "sending" : "scheduled",
      dispatch_status: resolvedChannel === "whatsapp" ? "skipped" : "pending",
      whatsapp_dispatch_status: resolvedChannel === "email" ? "skipped" : "pending",
      stats: { ...FRESH_STATS },
    });

    return res.json({ success: true, campaign });
  } catch (error: any) {
    console.error("POST campaign error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/campaigns - Update status, edit a draft/scheduled campaign, or launch a draft
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

    if (action === "launch") {
      if (campaign.status !== "draft") {
        return res.status(400).json({ error: "Only draft campaigns can be launched" });
      }
      if (campaign.channel !== "whatsapp" && (!campaign.subject || !campaign.sender_email || !campaign.template_id)) {
        return res.status(400).json({ error: "Draft is missing email configuration — edit it before launching" });
      }
      if (campaign.channel !== "email" && !campaign.whatsapp_template) {
        return res.status(400).json({ error: "Draft is missing a WhatsApp template — edit it before launching" });
      }

      const { schedule_type, scheduled_at } = req.body;
      if (schedule_type) campaign.schedule_type = schedule_type;
      if (campaign.schedule_type === "scheduled" && scheduled_at) {
        campaign.scheduled_at = new Date(scheduled_at);
      } else {
        campaign.scheduled_at = new Date();
      }
      campaign.status = campaign.schedule_type === "immediate" ? "sending" : "scheduled";
      await campaign.save();
      return res.json({ success: true, campaign });
    }

    // Field editing is only allowed before any sending has happened.
    if (!["draft", "scheduled", "paused"].includes(campaign.status)) {
      return res.status(400).json({ error: "Only draft, scheduled or paused campaigns can be edited" });
    }

    const editable: any = {};
    const allowedFields = [
      "name",
      "subject",
      "sender_name",
      "sender_email",
      "reply_to",
      "template_id",
      "channel",
      "whatsapp_template",
      "schedule_type",
      "scheduled_at",
    ];
    for (const field of allowedFields) {
      if (field in updateFields) editable[field] = updateFields[field];
    }
    if ("audience" in updateFields) editable.audience = sanitizeAudience(updateFields.audience);
    if ("ab_test" in updateFields) editable.ab_test = sanitizeAbTest(updateFields.ab_test);
    if (editable.scheduled_at) editable.scheduled_at = new Date(editable.scheduled_at);

    // Keep the per-channel dispatch legs consistent if the channel changed.
    if (editable.channel) {
      editable.dispatch_status = editable.channel === "whatsapp" ? "skipped" : "pending";
      editable.whatsapp_dispatch_status = editable.channel === "email" ? "skipped" : "pending";
    }

    const updatedCampaign = await EmailCampaign.findByIdAndUpdate(id, editable, { new: true });
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

// GET /api/campaigns/:id/analytics - Full analytics report for one campaign
router.get("/:id/analytics", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const campaign = await EmailCampaign.findById(id)
      .populate("template_id", "name")
      .populate("ab_test.template_id_b", "name")
      .populate("audience.segment_id", "name");
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaignId = new mongoose.Types.ObjectId(id);
    const baseMatch = { campaign_id: campaignId };

    const [uniqueOpens, uniqueClicks, timeline, devices, browsers, topLinks] = await Promise.all([
      EmailEvent.distinct("recipient_email", { ...baseMatch, event_type: "open" }).then((r) => r.length),
      EmailEvent.distinct("recipient_email", { ...baseMatch, event_type: "click" }).then((r) => r.length),
      EmailEvent.aggregate([
        { $match: { ...baseMatch, event_type: { $in: ["sent", "open", "click"] } } },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: "%Y-%m-%d %H:00", date: "$timestamp", timezone: config.branding.timezone } },
              type: "$event_type",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.day": 1 } },
      ]),
      EmailEvent.aggregate([
        { $match: { ...baseMatch, event_type: "open", device_type: { $ne: null } } },
        { $group: { _id: "$device_type", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      EmailEvent.aggregate([
        { $match: { ...baseMatch, event_type: "open", browser: { $ne: null } } },
        { $group: { _id: "$browser", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      EmailEvent.aggregate([
        { $match: { ...baseMatch, event_type: "click", link_url: { $ne: null } } },
        { $group: { _id: "$link_url", clicks: { $sum: 1 }, uniqueClickers: { $addToSet: "$recipient_email" } } },
        { $project: { clicks: 1, uniqueClickers: { $size: "$uniqueClickers" } } },
        { $sort: { clicks: -1 } },
        { $limit: 20 },
      ]),
    ]);

    // Fold the grouped timeline rows into per-bucket series points
    const timelineMap = new Map<string, { label: string; sent: number; opens: number; clicks: number }>();
    for (const row of timeline) {
      const label = row._id.day;
      if (!timelineMap.has(label)) {
        timelineMap.set(label, { label, sent: 0, opens: 0, clicks: 0 });
      }
      const bucket = timelineMap.get(label)!;
      if (row._id.type === "sent") bucket.sent = row.count;
      if (row._id.type === "open") bucket.opens = row.count;
      if (row._id.type === "click") bucket.clicks = row.count;
    }

    // A/B variant performance — variant is stamped on sent events at dispatch time
    let variants = null;
    if (campaign.ab_test?.enabled) {
      const [sentByVariant, openerEmails, clickerEmails] = await Promise.all([
        EmailEvent.aggregate([
          { $match: { ...baseMatch, event_type: "sent", channel: "email" } },
          { $group: { _id: { $ifNull: ["$details.variant", "A"] }, emails: { $addToSet: "$recipient_email" } } },
        ]),
        EmailEvent.distinct("recipient_email", { ...baseMatch, event_type: "open" }),
        EmailEvent.distinct("recipient_email", { ...baseMatch, event_type: "click" }),
      ]);

      const openerSet = new Set(openerEmails);
      const clickerSet = new Set(clickerEmails);

      variants = sentByVariant
        .map((group: any) => {
          const emails: string[] = group.emails || [];
          const opens = emails.filter((e) => openerSet.has(e)).length;
          const clicks = emails.filter((e) => clickerSet.has(e)).length;
          return {
            variant: group._id,
            sent: emails.length,
            uniqueOpens: opens,
            uniqueClicks: clicks,
            openRate: emails.length > 0 ? opens / emails.length : 0,
            clickRate: emails.length > 0 ? clicks / emails.length : 0,
          };
        })
        .sort((a: any, b: any) => a.variant.localeCompare(b.variant));
    }

    return res.json({
      campaign,
      totals: {
        ...((campaign.stats as any)?.toObject?.() ?? campaign.stats),
        uniqueOpens,
        uniqueClicks,
      },
      timeline: Array.from(timelineMap.values()),
      devices: devices.map((d: any) => ({ device: d._id, count: d.count })),
      browsers: browsers.map((b: any) => ({ browser: b._id, count: b.count })),
      topLinks: topLinks.map((l: any) => ({ url: l._id, clicks: l.clicks, uniqueClickers: l.uniqueClickers })),
      variants,
    });
  } catch (error: any) {
    console.error("GET campaign analytics error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns/:id/events - Paginated per-recipient event log
router.get("/:id/events", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid campaign ID" });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
    const type = (req.query.type as string) || "";
    const search = (req.query.search as string) || "";

    const query: any = { campaign_id: id };
    if (type) query.event_type = type;
    if (search) query.recipient_email = { $regex: search, $options: "i" };

    const total = await EmailEvent.countDocuments(query);
    const events = await EmailEvent.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.json({ events, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error: any) {
    console.error("GET campaign events error:", error);
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
    const trackingUrl = config.appUrl;
    const parsedHtml = prepareEmailHtml({
      html: finalHtml,
      subscriber: {
        email: to,
        first_name: "Test",
        last_name: "Recipient",
        status: "subscribed",
      } as any,
      source: { type: "campaign", id: campaign._id.toString() },
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
      ab_test: campaign.ab_test,
      audience: campaign.audience,
      schedule_type,
      scheduled_at: scheduledDate,
      status: schedule_type === "immediate" ? "sending" : "scheduled",
      dispatch_status: campaign.channel === "whatsapp" ? "skipped" : "pending",
      whatsapp_dispatch_status: campaign.channel === "email" ? "skipped" : "pending",
      stats: { ...FRESH_STATS },
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
      timezone: config.branding.timezone,
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
