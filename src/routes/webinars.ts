import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import Webinar from "../models/Webinar";
import WebinarReminder from "../models/WebinarReminder";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailTemplate from "../models/EmailTemplate";
import EmailEvent from "../models/EmailEvent";
import { syncWebinarsFromWebsite, syncRegistrantsForWebinar, computeSendAt, webinarTag, sendLifecycleWhatsapp } from "../lib/webinar-sync";
import { scheduleReminderJob, cancelReminderJob } from "../lib/queue/queues";
import { fanOutReminderLeg } from "../lib/queue/fan-out";
import { getEmailProvider } from "../providers/provider-factory";
import { prepareEmailHtml, replaceMergeTags } from "../lib/tracking-parser";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import {
  DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET,
  buildWhatsappTemplateParams,
  describeOffset,
  type WhatsappTemplateName,
} from "../lib/whatsapp-templates";
import { getMergedWhatsappTemplates } from "../lib/whatsapp-template-sync";
import { normalizeWhatsappNumber } from "../lib/phone";
import { config } from "../config";

const router = Router();

router.use(authMiddleware);

const PRESET_OFFSETS: Record<string, { offset_type: string; offset_value?: number; name: string }> = {
  "3_days_before": { offset_type: "days_before", offset_value: 3, name: "3 days before" },
  "2_days_before": { offset_type: "days_before", offset_value: 2, name: "2 days before" },
  "1_day_before": { offset_type: "days_before", offset_value: 1, name: "1 day before" },
  "30_min_before": { offset_type: "minutes_before", offset_value: 30, name: "30 minutes before" },
  at_start: { offset_type: "at_start", name: "At webinar start" },
};

// Maps each preset to the *name* of the EmailTemplate it should default to.
// Keyed by name (not _id) because EmailTemplate documents are admin-created
// per brand's isolated DB, so IDs differ across deployments while a template
// name stays a stable, human-meaningful anchor. Mirrors
// DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET's 3-way split: the 3/2/1-day-before
// reminders share a no-CTA "upcoming" template (the join link isn't live yet),
// while 30-min-before and at-start each get their own urgent, join-button
// template.
const DEFAULT_EMAIL_TEMPLATE_NAME_FOR_PRESET: Record<string, string> = {
  "3_days_before": "Webinar Upcoming Reminder",
  "2_days_before": "Webinar Upcoming Reminder",
  "1_day_before": "Webinar Upcoming Reminder",
  "30_min_before": "Webinar Starting Soon",
  at_start: "Webinar Live Now",
};

async function registrantCount(webinar: { source_window_id: string }) {
  return EmailSubscriber.countDocuments({ tags: webinarTag(webinar) });
}

// Registrant count above is everyone tagged for this occurrence, regardless
// of EmailSubscriber.status — a global email consent/deliverability flag
// that can be "unsubscribed"/"bounced"/"complained" from something entirely
// unrelated to this webinar (see fan-out.ts's pendingSubscribersForLeg for
// why WhatsApp doesn't gate on it, but email intentionally still does). This
// gives the dashboard the real number email reminders will reach, so a
// registrant count that includes people who will never get an email doesn't
// read as a delivery failure.
async function emailEligibleCount(webinar: { source_window_id: string }) {
  return EmailSubscriber.countDocuments({ tags: webinarTag(webinar), status: "subscribed" });
}

// GET /api/webinars/meta/whatsapp-templates - MSG91-synced template metadata for the reminder UI
router.get("/meta/whatsapp-templates", async (_req: AuthenticatedRequest, res: Response) => {
  const templates = await getMergedWhatsappTemplates();
  return res.json({
    templates,
    defaultForPreset: DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET,
    defaultEmailTemplateNameForPreset: DEFAULT_EMAIL_TEMPLATE_NAME_FOR_PRESET,
  });
});

// GET /api/webinars - list webinars with live registrant counts + reminders
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Auto-sync, replacing the old manual "Sync Now" button: both sync
    // functions are internally throttled to once per 5 minutes (see
    // webinar-sync.ts's SYNC_THROTTLE_MS) and were already written to be
    // "safe to call on every sweep tick" — so calling them here unconditionally
    // makes every page load double as that tick, with no separate cron needed.
    // Fire-and-forget (not awaited): this list reads straight from MongoDB, so
    // a slow upstream website fetch must never block the page — a sync that's
    // still in flight just means this response is the pre-sync state, caught
    // up by the next load.
    syncWebinarsFromWebsite(false).catch((err) => console.error("Auto webinar sync failed:", err));

    // syncRegistrantsForWebinar mutates and .save()s the doc it's given, so
    // it needs real Mongoose documents — the .lean() query below (used for
    // the actual response, for speed) would silently no-op it instead.
    Webinar.find({ status: "upcoming" }).then((upcoming) => {
      for (const w of upcoming) {
        syncRegistrantsForWebinar(w, false).catch((err) =>
          console.error("Auto registrant sync failed:", w.source_window_id, err)
        );
      }
    });

    const webinars = await Webinar.find().sort({ updated_at: -1 }).lean();

    const withDetails = await Promise.all(
      webinars.map(async (w: any) => {
        const [reminders, count, emailEligible] = await Promise.all([
          WebinarReminder.find({ webinar_id: w._id }).sort({ computed_send_at: 1 }).lean(),
          registrantCount(w),
          emailEligibleCount(w),
        ]);
        return { ...w, id: w._id.toString(), reminders, registrant_count: count, email_eligible_count: emailEligible };
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

    const [reminders, registrants, count, emailEligible] = await Promise.all([
      WebinarReminder.find({ webinar_id: webinar._id }).sort({ computed_send_at: 1 }),
      EmailSubscriber.find({ tags: webinarTag(webinar) }).select("email first_name status created_at"),
      registrantCount(webinar),
      emailEligibleCount(webinar),
    ]);

    return res.json({
      webinar: { ...webinar, id: webinar._id.toString(), registrant_count: count, email_eligible_count: emailEligible },
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
    const { status, notify } = req.body;
    if (!status || !["upcoming", "completed", "cancelled"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    // Defaults to true so existing callers that don't pass `notify` keep
    // their current behavior — the frontend cancel modal now sends this
    // explicitly (checked by default, uncheckable for a silent cancel).
    const shouldNotify = notify !== false;

    const existing = await Webinar.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Webinar not found" });
    }
    // Re-cancelling an already-cancelled webinar (a double-click, a client
    // retry after a slow/timed-out first request, or simply hitting the
    // endpoint twice) used to unconditionally re-run the entire cascade
    // below, including re-blasting a WhatsApp "cancelled" notice to every
    // registrant with no per-recipient dedup at all — the root cause of a
    // production incident where registrants got the same notice repeatedly.
    // If the status isn't actually changing, this is a no-op.
    if (existing.status === status) {
      return res.json({ webinar: existing });
    }

    // Reactivating clears the notified flag so a genuine future cancellation
    // of this same occurrence sends its own fresh notice rather than being
    // silently suppressed by a stale flag from the earlier cancellation.
    const mongoUpdate: Record<string, any> =
      status === "upcoming"
        ? { $set: { status }, $unset: { cancellation_notified_at: 1 } }
        : { $set: { status } };
    const webinar = await Webinar.findByIdAndUpdate(req.params.id, mongoUpdate, { new: true });
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }

    if (status === "cancelled") {
      await WebinarReminder.updateMany(
        { webinar_id: webinar._id, dispatch_status: "pending" },
        { $set: { dispatch_status: "skipped" } }
      );
      // The scheduler worker already defensively skips both legs for a
      // cancelled webinar's due reminders (reminder-scheduler.worker.ts), but
      // update it here too so the DB reflects "skipped" immediately rather
      // than only once/if that reminder's delayed job fires.
      await WebinarReminder.updateMany(
        { webinar_id: webinar._id, whatsapp_dispatch_status: "pending" },
        { $set: { whatsapp_dispatch_status: "skipped" } }
      );
      // Drop every pending delayed job for this webinar's reminders so a
      // stale one can't fire into a now-cancelled webinar.
      const affectedReminders = await WebinarReminder.find({ webinar_id: webinar._id }).select("_id");
      await Promise.all(affectedReminders.map((r: any) => cancelReminderJob(r._id)));

      // Notify everyone already registered for this occurrence — unless the
      // caller explicitly asked for a silent cancel, or this occurrence was
      // already notified (belt-and-suspenders alongside the status-unchanged
      // guard above, in case two cancel requests raced each other before
      // either one's findByIdAndUpdate had landed).
      if (shouldNotify && !webinar.cancellation_notified_at) {
        const tag = webinarTag(webinar);
        const subscribers = await EmailSubscriber.find({
          tags: tag,
          whatsapp_number: { $exists: true, $ne: null },
          whatsapp_opted_out: { $ne: true },
        }).lean();
        for (const sub of subscribers) {
          if (!sub.whatsapp_number) continue;
          await sendLifecycleWhatsapp(
            "webinar_cancelled",
            sub.whatsapp_number,
            { firstName: sub.first_name || "there", webinarTitle: webinar.title, startsAt: webinar.starts_at, timezone: webinar.timezone },
            // Per-recipient DB-level dedup on top of cancellation_notified_at:
            // two racing cancel requests can both pass the flag check, but
            // only one can claim each recipient's unique EmailEvent row.
            { webinarId: webinar._id, recipientEmail: sub.email, key: "webinar_cancelled" }
          );
        }
        webinar.cancellation_notified_at = new Date();
        await webinar.save();
      }
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

    const {
      preset,
      offset_type,
      offset_value,
      custom_at,
      name,
      channel,
      template_id,
      subject,
      sender_name,
      sender_email,
      whatsapp_template,
    } = req.body;

    const resolvedChannel: "email" | "whatsapp" | "both" = channel || "email";
    if (!["email", "whatsapp", "both"].includes(resolvedChannel)) {
      return res.status(400).json({ error: "channel must be 'email', 'whatsapp' or 'both'" });
    }

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

    if (!resolvedOffsetType) {
      return res.status(400).json({ error: "offset_type (or a valid preset) is required" });
    }
    if (resolvedOffsetType === "custom" && !custom_at) {
      return res.status(400).json({ error: "custom_at is required for a custom offset_type" });
    }

    // If the caller didn't pick an email template explicitly, fall back to
    // this preset's default (e.g. the 30-min-before reminder should default
    // to the join-button "Starting Soon" template, not whatever the last
    // reminder on this webinar happened to use).
    let resolvedTemplateId = template_id;
    let resolvedSubject = subject;
    if (resolvedChannel !== "whatsapp" && !resolvedTemplateId && preset) {
      const defaultTemplateName = DEFAULT_EMAIL_TEMPLATE_NAME_FOR_PRESET[preset];
      const defaultTemplate = defaultTemplateName ? await EmailTemplate.findOne({ name: defaultTemplateName }) : null;
      if (defaultTemplate) {
        resolvedTemplateId = defaultTemplate._id.toString();
        resolvedSubject = resolvedSubject || defaultTemplate.subject;
      }
    }

    if (resolvedChannel !== "whatsapp" && (!resolvedTemplateId || !resolvedSubject || !sender_name || !sender_email)) {
      return res.status(400).json({ error: "template_id, subject, sender_name and sender_email are required for the email channel" });
    }

    let resolvedWhatsappTemplate: WhatsappTemplateName | undefined = whatsapp_template;
    if (resolvedChannel !== "email") {
      if (!resolvedWhatsappTemplate && preset) {
        resolvedWhatsappTemplate = DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET[preset];
      }
      const availableTemplates = await getMergedWhatsappTemplates();
      if (
        !resolvedWhatsappTemplate ||
        !availableTemplates.some((t) => t.supported && t.name === resolvedWhatsappTemplate)
      ) {
        return res.status(400).json({ error: "A valid whatsapp_template is required for the WhatsApp channel" });
      }
    }

    const computedSendAt = computeSendAt(
      webinar.starts_at,
      resolvedOffsetType,
      resolvedOffsetValue,
      custom_at ? new Date(custom_at) : undefined
    );
    // A rule added after its own send time already passed shouldn't blast a stale reminder.
    const initialDispatchStatus = computedSendAt.getTime() <= Date.now() ? "skipped" : "pending";

    const reminder = await WebinarReminder.create({
      webinar_id: webinar._id,
      name: resolvedName || "Reminder",
      offset_type: resolvedOffsetType,
      offset_value: resolvedOffsetValue,
      custom_at: custom_at ? new Date(custom_at) : undefined,
      channel: resolvedChannel,
      template_id: resolvedChannel !== "whatsapp" ? resolvedTemplateId : undefined,
      subject: resolvedChannel !== "whatsapp" ? resolvedSubject : undefined,
      sender_name: resolvedChannel !== "whatsapp" ? sender_name : undefined,
      sender_email: resolvedChannel !== "whatsapp" ? sender_email : undefined,
      whatsapp_template: resolvedChannel !== "email" ? resolvedWhatsappTemplate : undefined,
      computed_send_at: computedSendAt,
      dispatch_status: resolvedChannel === "whatsapp" ? "skipped" : initialDispatchStatus,
      whatsapp_dispatch_status: resolvedChannel === "email" ? "skipped" : initialDispatchStatus,
    });

    if (initialDispatchStatus !== "skipped") {
      await scheduleReminderJob(reminder);
    }

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

    const {
      status,
      offset_type,
      offset_value,
      custom_at,
      channel,
      subject,
      sender_name,
      sender_email,
      template_id,
      whatsapp_template,
      reset,
    } = req.body;

    if (reset) {
      // Manual-only override — resending must never happen automatically.
      if (reminder.dispatch_status === "sent") reminder.dispatch_status = "pending";
      if (reminder.whatsapp_dispatch_status === "sent") reminder.whatsapp_dispatch_status = "pending";
    }

    if (status) reminder.status = status;
    if (subject) reminder.subject = subject;
    if (sender_name) reminder.sender_name = sender_name;
    if (sender_email) reminder.sender_email = sender_email;
    if (template_id) reminder.template_id = template_id;

    if (whatsapp_template) {
      const availableTemplates = await getMergedWhatsappTemplates();
      if (!availableTemplates.some((t) => t.supported && t.name === whatsapp_template)) {
        return res.status(400).json({ error: "A valid whatsapp_template is required for the WhatsApp channel" });
      }
      reminder.whatsapp_template = whatsapp_template;
    }

    const effectiveChannel = channel || reminder.channel;
    if (effectiveChannel !== "email" && !reminder.whatsapp_template) {
      return res.status(400).json({ error: "A valid whatsapp_template is required for the WhatsApp channel" });
    }

    if (channel && channel !== reminder.channel) {
      if (!["email", "whatsapp", "both"].includes(channel)) {
        return res.status(400).json({ error: "channel must be 'email', 'whatsapp' or 'both'" });
      }
      reminder.channel = channel;
      // Re-arm/disarm whichever leg the new channel does/doesn't need — only
      // touch legs that haven't already sent, so an in-flight/completed batch
      // is never silently reset by a channel change.
      const wantsEmail = channel !== "whatsapp";
      const wantsWhatsapp = channel !== "email";
      if (wantsEmail && reminder.dispatch_status === "skipped") {
        reminder.dispatch_status = reminder.computed_send_at.getTime() <= Date.now() ? "skipped" : "pending";
      } else if (!wantsEmail && reminder.dispatch_status !== "sent") {
        reminder.dispatch_status = "skipped";
      }
      if (wantsWhatsapp && reminder.whatsapp_dispatch_status === "skipped") {
        reminder.whatsapp_dispatch_status = reminder.computed_send_at.getTime() <= Date.now() ? "skipped" : "pending";
      } else if (!wantsWhatsapp && reminder.whatsapp_dispatch_status !== "sent") {
        reminder.whatsapp_dispatch_status = "skipped";
      }
    }

    const offsetChanged = offset_type !== undefined || offset_value !== undefined || custom_at !== undefined;
    if (offsetChanged && (reminder.dispatch_status === "pending" || reminder.whatsapp_dispatch_status === "pending")) {
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

    // Reconcile the delayed BullMQ job to match the reminder's final state —
    // simpler and more robust than trying to track exactly which field
    // change (reset, offset edit, channel switch) should re-arm/disarm it.
    const legsTerminal =
      ["sent", "skipped"].includes(reminder.dispatch_status) &&
      ["sent", "skipped"].includes(reminder.whatsapp_dispatch_status);
    if (reminder.status !== "active" || legsTerminal) {
      await cancelReminderJob(reminder._id);
    } else {
      await scheduleReminderJob(reminder);
    }

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

    if (!reminder.template_id) {
      return res.status(400).json({ error: "This reminder has no email leg configured (channel is whatsapp-only)" });
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
      metadata: new Map([
        ["webinar", webinar.title],
        // Same authoritative join URL the WhatsApp button suffix uses —
        // without this the {{join_link}} tag falls back to the website URL.
        ["webinar_join_link", `${config.mainWebsite.url}/webinar/join/${webinar.source_window_id}`],
      ]),
    } as any;

    const trackingUrl = config.appUrl;
    const parsedHtml = prepareEmailHtml({
      html: finalHtml,
      subscriber: testSubscriber,
      source: { type: "reminder", id: reminder._id.toString() },
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

// POST /api/webinars/:id/reminders/:reminderId/test-send-whatsapp - send this
// reminder's WhatsApp template to an arbitrary phone number, with real
// merge-tag values from the webinar itself.
router.post("/:id/reminders/:reminderId/test-send-whatsapp", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to } = req.body;
    if (!to) {
      return res.status(400).json({ error: "Recipient WhatsApp number 'to' is required" });
    }

    const reminder = await WebinarReminder.findOne({ _id: req.params.reminderId, webinar_id: req.params.id });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    if (!reminder.whatsapp_template) {
      return res.status(400).json({ error: "This reminder has no WhatsApp leg configured" });
    }

    const webinar = await Webinar.findById(reminder.webinar_id);
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }

    const relativePhrase = describeOffset(reminder.offset_type, reminder.offset_value);
    const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(reminder.whatsapp_template as WhatsappTemplateName, {
      firstName: "Test",
      webinarTitle: webinar.title,
      startsAt: webinar.starts_at,
      timezone: webinar.timezone,
      relativeTimePhrase: relativePhrase,
      joinSuffix: String(webinar.source_window_id),
    });

    const result = await sendWhatsappTemplate({
      to,
      templateName: reminder.whatsapp_template,
      bodyParams,
      buttonUrlSuffix,
    });

    return res.json({ success: true, messageId: result.messageId, dispatched_at: new Date().toISOString() });
  } catch (error: any) {
    console.error("Webinar reminder WhatsApp test-send error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/webinars/:id/reminders/:reminderId/send-now-preview - audience
// count for the confirmation dialog before an instant send. Mirrors the exact
// "not yet sent" query each leg sender uses, so the number shown matches what
// will actually happen.
router.get("/:id/reminders/:reminderId/send-now-preview", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reminder = await WebinarReminder.findOne({ _id: req.params.reminderId, webinar_id: req.params.id });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    const webinar = await Webinar.findById(reminder.webinar_id);
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }

    const tag = webinarTag(webinar);
    let emailPending = 0;
    let whatsappPending = 0;

    if (reminder.channel !== "whatsapp") {
      const subscribers = await EmailSubscriber.find({ status: "subscribed", tags: tag }).select("email").lean();
      const sentEmails = await EmailEvent.find({
        reminder_id: reminder._id,
        channel: "email",
        event_type: "sent",
      }).distinct("recipient_email");
      const sentSet = new Set(sentEmails.map((e) => e.toLowerCase()));
      emailPending = subscribers.filter((s) => s.email && !sentSet.has(s.email.toLowerCase())).length;
    }

    if (reminder.channel !== "email") {
      const subscribers = await EmailSubscriber.find({
        status: "subscribed",
        tags: tag,
        whatsapp_number: { $exists: true, $ne: null },
        whatsapp_opted_out: { $ne: true },
      }).select("email whatsapp_number").lean();
      const sentTo = await EmailEvent.find({
        reminder_id: reminder._id,
        channel: "whatsapp",
        event_type: "sent",
      }).distinct("recipient_email");
      const sentSet = new Set(sentTo.map((e) => e.toLowerCase()));
      const pending = subscribers.filter((s) => s.email && !sentSet.has(s.email.toLowerCase()));

      // Mirror fan-out.ts's phone dedup so this preview count matches what
      // send-now will actually deliver — duplicate registrations under
      // different emails but the same WhatsApp number collapse to one.
      const seenPhones = new Set<string>();
      for (const s of pending) {
        const phone = normalizeWhatsappNumber((s as any).whatsapp_number);
        if (phone) {
          if (seenPhones.has(phone)) continue;
          seenPhones.add(phone);
        }
        whatsappPending++;
      }
    }

    return res.json({
      channel: reminder.channel,
      webinar_status: webinar.status,
      email_pending: emailPending,
      whatsapp_pending: whatsappPending,
    });
  } catch (error: any) {
    console.error("Webinar reminder send-now-preview error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/webinars/:id/reminders/:reminderId/send-now - manual override that
// fires this reminder immediately to everyone currently registered who hasn't
// received it yet, regardless of its scheduled computed_send_at. Shares the
// exact same fan-out (audience selection + idempotency) the scheduled path
// uses via fanOutReminderLeg — enqueues the full audience as rate-limited
// BullMQ jobs and returns immediately; the queue workers (mail-queue-worker)
// drain it in the background. stats.sent/whatsapp_sent climb live as each
// per-recipient job completes — poll GET /:id to watch progress.
router.post("/:id/reminders/:reminderId/send-now", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reminder = await WebinarReminder.findOne({ _id: req.params.reminderId, webinar_id: req.params.id });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    const webinar = await Webinar.findById(reminder.webinar_id);
    if (!webinar) {
      return res.status(404).json({ error: "Webinar not found" });
    }
    if (webinar.status !== "upcoming") {
      return res.status(400).json({ error: `Can't send — this webinar is ${webinar.status}, not upcoming` });
    }

    if (reminder.computed_send_at.getTime() > Date.now()) {
      reminder.computed_send_at = new Date();
      await reminder.save();
    }
    // Drop any pending delayed job — we're firing now instead of waiting for it.
    await cancelReminderJob(reminder._id);

    await syncRegistrantsForWebinar(webinar);

    if (reminder.channel !== "whatsapp") await fanOutReminderLeg(reminder, webinar, "email");
    if (reminder.channel !== "email") await fanOutReminderLeg(reminder, webinar, "whatsapp");

    return res.status(202).json({ success: true, enqueued: true });
  } catch (error: any) {
    console.error("Webinar reminder send-now error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/webinars/:id/reminders/:reminderId
router.delete("/:id/reminders/:reminderId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    await cancelReminderJob(req.params.reminderId);
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
