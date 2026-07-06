import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import Webinar from "../models/Webinar";
import WebinarReminder from "../models/WebinarReminder";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailTemplate from "../models/EmailTemplate";
import { syncWebinarsFromWebsite, syncRegistrantsForWebinar, computeSendAt, webinarTag } from "../lib/webinar-sync";
import { getEmailProvider } from "../providers/provider-factory";
import { prepareEmailHtml, replaceMergeTags } from "../lib/tracking-parser";

const router = Router();

router.use(authMiddleware);

const PRESET_OFFSETS: Record<string, { offset_type: string; offset_value?: number; name: string }> = {
  "3_days_before": { offset_type: "days_before", offset_value: 3, name: "3 days before" },
  "2_days_before": { offset_type: "days_before", offset_value: 2, name: "2 days before" },
  "1_day_before": { offset_type: "days_before", offset_value: 1, name: "1 day before" },
  "30_min_before": { offset_type: "minutes_before", offset_value: 30, name: "30 minutes before" },
  at_start: { offset_type: "at_start", name: "At webinar start" },
};

async function registrantCount(webinar: { source_window_id: string }) {
  return EmailSubscriber.countDocuments({ tags: webinarTag(webinar) });
}

// GET /api/webinars - list webinars with live registrant counts + reminders
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const webinars = await Webinar.find().sort({ starts_at: 1 }).lean();

    const withDetails = await Promise.all(
      webinars.map(async (w: any) => {
        const [reminders, count] = await Promise.all([
          WebinarReminder.find({ webinar_id: w._id }).sort({ computed_send_at: 1 }).lean(),
          registrantCount(w),
        ]);
        return { ...w, id: w._id.toString(), reminders, registrant_count: count };
      })
    );

    return res.json({ webinars: withDetails });
  } catch (error: any) {
    console.error("GET webinars error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/webinars/sync - manual "Sync Now" trigger
router.post("/sync", async (req: AuthenticatedRequest, res: Response) => {
  try {
    await syncWebinarsFromWebsite(true);
    const webinars = await Webinar.find({ status: "upcoming" });
    for (const webinar of webinars) {
      await syncRegistrantsForWebinar(webinar, true);
    }
    return res.json({ success: true, synced: webinars.length });
  } catch (error: any) {
    console.error("POST webinars/sync error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/webinars/:id - detail + reminders + registrants
router.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const webinar: any = await Webinar.findById(req.params.id).lean();
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }

    const [reminders, registrants, count] = await Promise.all([
      WebinarReminder.find({ webinar_id: webinar._id }).sort({ computed_send_at: 1 }),
      EmailSubscriber.find({ tags: webinarTag(webinar) }).select("email first_name status created_at"),
      registrantCount(webinar),
    ]);

    return res.json({
      webinar: { ...webinar, id: webinar._id.toString(), registrant_count: count },
      reminders,
      registrants,
    });
  } catch (error: any) {
    console.error("GET webinar detail error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/webinars/:id - update status (e.g. cancel), cascades to pending reminders
router.put("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status } = req.body;
    if (!status || !["upcoming", "completed", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const webinar = await Webinar.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true });
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }

    if (status === "cancelled") {
      await WebinarReminder.updateMany(
        { webinar_id: webinar._id, dispatch_status: "pending" },
        { $set: { dispatch_status: "skipped" } }
      );
    }

    return res.json({ webinar });
  } catch (error: any) {
    console.error("PUT webinar error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/webinars/:id/reminders - create a reminder rule (preset or custom)
router.post("/:id/reminders", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const webinar = await Webinar.findById(req.params.id);
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }

    const { preset, offset_type, offset_value, custom_at, name, template_id, subject, sender_name, sender_email } =
      req.body;

    let resolvedOffsetType = offset_type;
    let resolvedOffsetValue = offset_value;
    let resolvedName = name;

    if (preset) {
      const p = PRESET_OFFSETS[preset];
      if (!p) {
        return res.status(400).json({ error: "Unknown preset" });
      }
      resolvedOffsetType = p.offset_type;
      resolvedOffsetValue = p.offset_value;
      resolvedName = resolvedName || p.name;
    }

    if (!resolvedOffsetType || !template_id || !subject || !sender_name || !sender_email) {
      return res.status(400).json({ error: "Missing required reminder fields" });
    }
    if (resolvedOffsetType === "custom" && !custom_at) {
      return res.status(400).json({ error: "custom_at is required for a custom offset_type" });
    }

    const computedSendAt = computeSendAt(
      webinar.starts_at,
      resolvedOffsetType,
      resolvedOffsetValue,
      custom_at ? new Date(custom_at) : undefined
    );

    const reminder = await WebinarReminder.create({
      webinar_id: webinar._id,
      name: resolvedName || "Reminder",
      offset_type: resolvedOffsetType,
      offset_value: resolvedOffsetValue,
      custom_at: custom_at ? new Date(custom_at) : undefined,
      template_id,
      subject,
      sender_name,
      sender_email,
      computed_send_at: computedSendAt,
      // A rule added after its own send time already passed shouldn't blast a stale reminder.
      dispatch_status: computedSendAt.getTime() <= Date.now() ? "skipped" : "pending",
    });

    return res.status(201).json({ reminder });
  } catch (error: any) {
    console.error("POST webinar reminder error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/webinars/:id/reminders/:reminderId - update / pause / reset a rule
router.put("/:id/reminders/:reminderId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reminder = await WebinarReminder.findOne({ _id: req.params.reminderId, webinar_id: req.params.id });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    const { status, offset_type, offset_value, custom_at, subject, sender_name, sender_email, template_id, reset } =
      req.body;

    if (reset && reminder.dispatch_status === "sent") {
      // Manual-only override — resending must never happen automatically.
      reminder.dispatch_status = "pending";
    }

    if (status) reminder.status = status;
    if (subject) reminder.subject = subject;
    if (sender_name) reminder.sender_name = sender_name;
    if (sender_email) reminder.sender_email = sender_email;
    if (template_id) reminder.template_id = template_id;

    const offsetChanged = offset_type !== undefined || offset_value !== undefined || custom_at !== undefined;
    if (offsetChanged && reminder.dispatch_status === "pending") {
      if (offset_type !== undefined) reminder.offset_type = offset_type;
      if (offset_value !== undefined) reminder.offset_value = offset_value;
      if (custom_at !== undefined) reminder.custom_at = new Date(custom_at);

      const webinar = await Webinar.findById(reminder.webinar_id);
      if (webinar) {
        reminder.computed_send_at = computeSendAt(
          webinar.starts_at,
          reminder.offset_type,
          reminder.offset_value,
          reminder.custom_at
        );
      }
    }

    await reminder.save();
    return res.json({ reminder });
  } catch (error: any) {
    console.error("PUT webinar reminder error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/webinars/:id/reminders/:reminderId/test-send - preview exactly what
// this reminder's email looks like, sent to an arbitrary address, with real
// merge-tag values (the webinar's actual title) instead of generic fallbacks.
router.post("/:id/reminders/:reminderId/test-send", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to } = req.body;
    if (!to) {
      return res.status(400).json({ error: "Recipient email 'to' is required" });
    }

    const reminder = await WebinarReminder.findOne({ _id: req.params.reminderId, webinar_id: req.params.id });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }

    const webinar = await Webinar.findById(reminder.webinar_id);
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }

    const template = await EmailTemplate.findById(reminder.template_id);
    if (!template) {
      return res.status(404).json({ error: "Template not found for this reminder" });
    }

    let finalHtml = template.html_content || "";
    if (template.type === "text") {
      finalHtml = `
        <div style="font-family: sans-serif; font-size: 15px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">
          ${finalHtml}
        </div>
      `;
    }

    // Build a minimal subscriber-like object so replaceMergeTags can
    // resolve {{webinar}}, {{first_name}}, etc. in the subject line.
    const testSubscriber = {
      email: to,
      first_name: "Test",
      last_name: "Recipient",
      status: "subscribed",
      metadata: new Map([["webinar", webinar.title]]),
    } as any;

    const trackingUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
    const parsedHtml = prepareEmailHtml({
      html: finalHtml,
      subscriber: testSubscriber,
      campaignId: reminder._id.toString(),
      trackingUrl,
      trackingEnabled: { opens: false, clicks: false },
    });

    const resolvedSubject = replaceMergeTags(`[TEST] ${reminder.subject}`, testSubscriber);

    const provider = getEmailProvider();
    const result = await provider.sendEmail({
      to,
      fromName: reminder.sender_name,
      fromEmail: reminder.sender_email,
      subject: resolvedSubject,
      html: parsedHtml,
    });

    return res.json({ success: true, messageId: result.messageId, dispatched_at: new Date().toISOString() });
  } catch (error: any) {
    console.error("Webinar reminder test-send error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/webinars/:id/reminders/:reminderId
router.delete("/:id/reminders/:reminderId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await WebinarReminder.findOneAndDelete({
      _id: req.params.reminderId,
      webinar_id: req.params.id,
    });
    if (!result) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    return res.json({ success: true });
  } catch (error: any) {
    console.error("DELETE webinar reminder error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
