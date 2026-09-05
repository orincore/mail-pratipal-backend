import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";
import EmailTemplate from "../models/EmailTemplate";
import WebinarReminder from "../models/WebinarReminder";
import Webinar from "../models/Webinar";
import { config } from "../config";
import { getWhatsappAnalytics } from "../providers/msg91-whatsapp-management.provider";

const router = Router();

router.use(authMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant of local midnight, for whatever calendar day `instant` falls
 * on in `timeZone` — e.g. passing "now" returns "today" 00:00:00 in that
 * zone, as an absolute Date (not a Date built from process-local fields).
 *
 * Every "Today"/day-boundary computation in this route needs to line up
 * with the business's own calendar day (config.branding.timezone, IST),
 * not whatever timezone the Node process happens to be running in. Cloud
 * hosts default containers to UTC, which sits 5:30h behind IST; the old
 * code built boundaries with `Date#setHours()`, which resolves "midnight"
 * in the *process's* local zone. In the early IST morning that silently
 * queries UTC's midnight instead — a window that has barely started (or,
 * depending on the exact time of day, one that excludes the previous
 * evening's activity which is still "today" in IST's small hours) — which
 * is exactly why the "Today" filter could show every metric as 0 despite
 * real send activity.
 */
function startOfDayInTimezone(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  // Intl can format midnight as hour "24" under hour12: false — normalize to 0.
  const hour = get("hour") % 24;
  const msIntoDay = ((hour * 60 + get("minute")) * 60 + get("second")) * 1000 + instant.getMilliseconds();
  return new Date(instant.getTime() - msIntoDay);
}

// GET /api/auth/me - Retrieve current verified user payload
router.get("/auth/me", async (req: AuthenticatedRequest, res: Response) => {
  return res.json({ user: req.user });
});

// GET /api/failed-events - Retrieve recent bounce/complaint/send-failure events with reasons
router.get("/failed-events", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const failedEvents = await EmailEvent.find({
      event_type: { $in: ["bounce", "complaint", "failed"] }
    })
      .sort({ timestamp: -1 })
      .populate("campaign_id", "name")
      .populate("reminder_id", "name")
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

    // A custom range is the only one with a real upper bound — the presets
    // all mean "since X, through right now." Parsed as a calendar date in
    // the business's own timezone (not the server process's) so "Jan 5"
    // means the same day here as it did in the date picker regardless of
    // which timezone this Node process happens to be running in.
    const parseLocalDate = (s?: string): Date | null => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
      if (!m) return null;
      const utcMidnight = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (Number.isNaN(utcMidnight.getTime())) return null;
      return startOfDayInTimezone(utcMidnight, config.branding.timezone);
    };
    // Per-day stats below cost 4 count queries each; an unbounded custom
    // range (someone fat-fingering a decade) would turn into thousands of
    // round trips. Three months is generous for "what happened between these
    // two dates" without opening that door.
    const MAX_CUSTOM_RANGE_DAYS = 90;

    // 1. Determine date filter boundaries — all computed as absolute instants
    // via pure day-count arithmetic off `todayStart` (today's midnight in
    // config.branding.timezone), never via Date#setHours()/setDate(), which
    // resolve to the process's own local timezone instead.
    const todayStart = startOfDayInTimezone(new Date(), config.branding.timezone);
    let startOfPeriod = todayStart;
    let endOfPeriod: Date | null = null; // non-null only for a bounded custom range
    if (timeframe === "custom") {
      const parsedFrom = parseLocalDate(req.query.from as string);
      const parsedTo = parseLocalDate(req.query.to as string);
      if (parsedFrom && parsedTo) {
        // Accept either order — swap if the two dates arrived backwards.
        const [from, to] = parsedFrom.getTime() <= parsedTo.getTime() ? [parsedFrom, parsedTo] : [parsedTo, parsedFrom];
        startOfPeriod = from;
        endOfPeriod = new Date(to.getTime() + DAY_MS - 1); // end of that calendar day
        const spanDays = Math.floor((endOfPeriod.getTime() - startOfPeriod.getTime()) / DAY_MS);
        if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
          startOfPeriod = new Date(endOfPeriod.getTime() - MAX_CUSTOM_RANGE_DAYS * DAY_MS + 1);
        }
      } else {
        // Malformed/missing dates — fall back to the weekly default rather
        // than erroring the whole dashboard out.
        startOfPeriod = new Date(todayStart.getTime() - 6 * DAY_MS);
      }
    } else if (timeframe === "daily") {
      startOfPeriod = todayStart;
    } else if (timeframe === "monthly") {
      startOfPeriod = new Date(todayStart.getTime() - 29 * DAY_MS);
    } else { // default to weekly (last 7 days)
      startOfPeriod = new Date(todayStart.getTime() - 6 * DAY_MS);
    }

    const eventQuery = endOfPeriod
      ? { timestamp: { $gte: startOfPeriod, $lte: endOfPeriod } }
      : { timestamp: { $gte: startOfPeriod } };

    // 2. Fetch metrics from MongoDB within timeframe
    const totalSubscribers = await EmailSubscriber.countDocuments({ status: "subscribed" });

    // Email specific metrics (exclude WhatsApp)
    const totalSent = await EmailEvent.countDocuments({ event_type: "sent", channel: { $ne: "whatsapp" }, ...eventQuery });
    const totalOpens = await EmailEvent.countDocuments({ event_type: "open", ...eventQuery });
    const totalClicks = await EmailEvent.countDocuments({ event_type: "click", ...eventQuery });
    const totalBounces = await EmailEvent.countDocuments({ event_type: "bounce", channel: { $ne: "whatsapp" }, ...eventQuery });
    const totalComplaints = await EmailEvent.countDocuments({ event_type: "complaint", ...eventQuery });
    const totalFailed = await EmailEvent.countDocuments({ event_type: "failed", channel: { $ne: "whatsapp" }, ...eventQuery });

    // WhatsApp specific metrics ("bounce" kept for rows recorded before the failed/bounce split)
    const totalWhatsappSent = await EmailEvent.countDocuments({ event_type: "sent", channel: "whatsapp", ...eventQuery });
    const totalWhatsappFailed = await EmailEvent.countDocuments({ event_type: { $in: ["bounce", "failed"] }, channel: "whatsapp", ...eventQuery });

    // "Opened" has no equivalent EmailEvent row to count: the inbound
    // webhook (routes/whatsapp.ts POST /webhook) only handles STOP/RESUME
    // replies and explicitly discards every delivery-report/read-receipt
    // callback MSG91 sends, so an "open" event for WhatsApp is never
    // recorded anywhere — this always read 0.0% before. MSG91's own
    // analytics endpoint (the same one the WhatsApp Analytics tab uses)
    // reports a "read" count for the period instead, so ask it directly
    // rather than a DB query. It's a real network call to a third party —
    // one failure here must never break the rest of the dashboard.
    // en-CA renders as YYYY-MM-DD directly — formatted in the business
    // timezone since `d` is now a business-timezone-midnight instant, and
    // `.toISOString()` (always UTC) would render the wrong calendar date
    // whenever that timezone sits ahead of UTC (e.g. IST rolls the date
    // forward ~5.5h before UTC does).
    const toDateStr = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: config.branding.timezone });
    let totalWhatsappOpens = 0;
    try {
      const analytics = await getWhatsappAnalytics(toDateStr(startOfPeriod), toDateStr(endOfPeriod || new Date()));
      totalWhatsappOpens = Number(analytics?.total?.read) || 0;
    } catch (err: any) {
      console.error("dashboard-stats: MSG91 analytics fetch failed, defaulting WhatsApp opens to 0:", err.message);
    }

    // Rolling 24h SES quota usage for the header gauge
    const quotaSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const quotaUsed = await EmailEvent.countDocuments({
      event_type: "sent",
      channel: { $ne: "whatsapp" },
      timestamp: { $gte: quotaSince },
    });

    const activeSchedules = await EmailCampaign.countDocuments({ status: "scheduled" });

    // 3. Fetch recent campaigns
    const recentCampaigns = await EmailCampaign.find()
      .sort({ created_at: -1 })
      .limit(5)
      .populate("template_id", "name");

    // 4. Generate performance timeline stats based on timeframe
    const dailyStats: any[] = [];

    if (timeframe === "custom" && endOfPeriod) {
      // One point per calendar day across whatever range was picked —
      // already clamped to MAX_CUSTOM_RANGE_DAYS above. Pure ms arithmetic
      // off `startOfPeriod` (already the business timezone's midnight for
      // that day) rather than Date#setDate()/setHours(), which resolve
      // against the process's own local timezone instead.
      const totalDays = Math.round((endOfPeriod.getTime() - startOfPeriod.getTime() + 1) / DAY_MS);
      for (let i = 0; i < totalDays; i++) {
        const startOfDay = new Date(startOfPeriod.getTime() + i * DAY_MS);
        const endOfDay = new Date(startOfDay.getTime() + DAY_MS - 1);

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
          event_type: { $in: ["bounce", "failed"] },
          channel: "whatsapp",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        chartStatsPush(
          dailyStats,
          startOfDay.toLocaleDateString("en-IN", { month: "short", day: "numeric", timeZone: config.branding.timezone }),
          sent,
          opens,
          whatsappSent,
          whatsappFailed
        );
      }
    } else if (timeframe === "daily") {
      // 24 hours of today, in the business timezone.
      const HOUR_MS = 60 * 60 * 1000;
      for (let i = 0; i < 24; i++) {
        const startOfHour = new Date(startOfPeriod.getTime() + i * HOUR_MS);
        const endOfHour = new Date(startOfHour.getTime() + HOUR_MS - 1);

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
          event_type: { $in: ["bounce", "failed"] },
          channel: "whatsapp",
          timestamp: { $gte: startOfHour, $lte: endOfHour },
        });

        chartStatsPush(dailyStats, `${i.toString().padStart(2, "0")}:00`, sent, opens, whatsappSent, whatsappFailed);
      }
    } else if (timeframe === "monthly") {
      // 30 days
      for (let i = 0; i < 30; i++) {
        const startOfDay = new Date(startOfPeriod.getTime() + i * DAY_MS);
        const endOfDay = new Date(startOfDay.getTime() + DAY_MS - 1);

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
          event_type: { $in: ["bounce", "failed"] },
          channel: "whatsapp",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        chartStatsPush(
          dailyStats,
          startOfDay.toLocaleDateString("en-IN", { month: "short", day: "numeric", timeZone: config.branding.timezone }),
          sent,
          opens,
          whatsappSent,
          whatsappFailed
        );
      }
    } else {
      // weekly (7 days)
      for (let i = 0; i < 7; i++) {
        const startOfDay = new Date(startOfPeriod.getTime() + i * DAY_MS);
        const endOfDay = new Date(startOfDay.getTime() + DAY_MS - 1);

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
          event_type: { $in: ["bounce", "failed"] },
          channel: "whatsapp",
          timestamp: { $gte: startOfDay, $lte: endOfDay },
        });

        chartStatsPush(
          dailyStats,
          startOfDay.toLocaleDateString("en-IN", { month: "short", day: "numeric", timeZone: config.branding.timezone }),
          sent,
          opens,
          whatsappSent,
          whatsappFailed
        );
      }
    }

    // Fetch recent reminders
    void Webinar;
    const recentReminders = await WebinarReminder.find()
      .sort({ computed_send_at: -1 })
      .limit(5)
      .populate("webinar_id", "title")
      .lean();

    return res.json({
      totalSubscribers,
      totalSent,
      totalOpens,
      totalClicks,
      totalBounces,
      totalComplaints,
      totalFailed,
      totalWhatsappSent,
      totalWhatsappFailed,
      totalWhatsappOpens,
      activeSchedules,
      recentCampaigns,
      recentReminders,
      dailyStats,
      quota: {
        used24h: quotaUsed,
        dailyLimit: config.email.dailyQuota,
        maxSendRatePerSecond: config.email.maxSendRatePerSecond,
      },
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

// GET /api/search - Unified search for pages, campaigns, templates, subscribers, and reminders
router.get("/search", async (req: AuthenticatedRequest, res: Response) => {
  const query = (req.query.q as string) || "";
  if (!query || query.trim().length < 2) {
    return res.json({
      navigation: [],
      campaigns: [],
      reminders: [],
      templates: [],
      subscribers: []
    });
  }

  try {
    const searchRegex = new RegExp(query, "i");

    // 1. Search Navigation / Pages
    const pagesList = [
      { label: "Dashboard", href: "/dashboard", desc: "View campaign analytics & metrics" },
      { label: "Subscribers", href: "/subscribers", desc: "Manage subscribers list, tags & CSV imports" },
      { label: "Campaigns", href: "/campaigns", desc: "Create, schedule and send marketing campaigns" },
      { label: "Templates", href: "/templates", desc: "Manage HTML templates & layouts" },
      { label: "Reminders", href: "/webinars", desc: "Setup WhatsApp reminder flows for webinars" },
    ];
    const matchedNavigation = pagesList.filter(
      (p) => searchRegex.test(p.label) || searchRegex.test(p.desc)
    );

    // 2. Search Campaigns
    const campaignsRaw = await EmailCampaign.find({
      $or: [
        { name: searchRegex },
        { subject: searchRegex }
      ]
    })
    .select("name subject scheduled_at channel")
    .limit(5);

    const matchedCampaigns = campaignsRaw.map((c) => {
      const dateStr = formatDate(c.scheduled_at);
      const tagStr = dateStr ? `${dateStr}, Campaign` : "Campaign";
      return {
        id: c._id.toString(),
        title: c.name,
        subtitle: c.subject || `${c.channel} campaign`,
        tag: tagStr,
        href: "/campaigns"
      };
    });

    // 3. Search Reminders (Webinars & WebinarReminders)
    void Webinar;
    const webinarsRaw = await Webinar.find({
      title: searchRegex
    })
    .select("title starts_at _id")
    .limit(5);

    const matchedWebinarReminders = webinarsRaw.map((w) => {
      const dateStr = formatDate(w.starts_at);
      const tagStr = dateStr ? `${dateStr}, Reminder` : "Reminder";
      return {
        id: w._id.toString(),
        title: w.title,
        subtitle: `Webinar scheduled run`,
        tag: tagStr,
        href: `/webinars/${w._id}`
      };
    });

    const remindersRaw = await WebinarReminder.find({
      name: searchRegex
    })
    .populate("webinar_id", "title starts_at")
    .limit(5);

    const matchedRemindersFromList = remindersRaw.map((r: any) => {
      const dateStr = formatDate(r.computed_send_at || r.webinar_id?.starts_at);
      const tagStr = dateStr ? `${dateStr}, Reminder` : "Reminder";
      return {
        id: r._id.toString(),
        title: `${r.name} - ${r.webinar_id?.title || "Webinar"}`,
        subtitle: `Reminder flow: ${r.channel}`,
        tag: tagStr,
        href: r.webinar_id ? `/webinars/${r.webinar_id._id}` : "/webinars"
      };
    });

    const combinedReminders = [...matchedWebinarReminders, ...matchedRemindersFromList].slice(0, 5);

    // 4. Search Templates
    const templatesRaw = await EmailTemplate.find({
      name: searchRegex
    })
    .select("name type subject")
    .limit(5);

    const matchedTemplates = templatesRaw.map((t) => {
      const typeStr = t.type ? `${t.type}, Template` : "Template";
      return {
        id: t._id.toString(),
        title: t.name,
        subtitle: t.subject || "No Subject",
        tag: typeStr,
        href: "/templates"
      };
    });

    // 5. Search Subscribers
    const subscribersRaw = await EmailSubscriber.find({
      $or: [
        { email: searchRegex },
        { first_name: searchRegex },
        { last_name: searchRegex }
      ]
    })
    .select("email first_name last_name status")
    .limit(5);

    const matchedSubscribers = subscribersRaw.map((s) => {
      const nameStr = s.first_name ? `${s.first_name} ${s.last_name || ""}`.trim() : "";
      const tagStr = s.status ? `${s.status}, Subscriber` : "Subscriber";
      return {
        id: s._id.toString(),
        title: s.email,
        subtitle: nameStr || "Subscriber Profile",
        tag: tagStr,
        href: `/subscribers?search=${encodeURIComponent(s.email)}`
      };
    });

    return res.json({
      navigation: matchedNavigation,
      campaigns: matchedCampaigns,
      reminders: combinedReminders,
      templates: matchedTemplates,
      subscribers: matchedSubscribers
    });
  } catch (error: any) {
    console.error("Backend Search error:", error);
    return res.status(500).json({ error: error.message });
  }
});

function formatDate(dateInput: Date | string | undefined): string {
  if (!dateInput) return "";
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// GET /api/notifications - Retrieve upcoming schedules and recent bounce alerts
router.get("/notifications", async (req: AuthenticatedRequest, res: Response) => {
  try {
    // 1. Fetch upcoming scheduled campaigns / reminders
    const upcomingSchedules = await EmailCampaign.find({
      status: "scheduled",
      scheduled_at: { $gte: new Date() }
    })
    .sort({ scheduled_at: 1 })
    .select("name channel scheduled_at")
    .limit(5);

    const scheduledNotifications = upcomingSchedules.map((camp) => ({
      id: `scheduled-${camp._id}`,
      type: "scheduled",
      title: camp.name,
      message: `Scheduled run via ${camp.channel} at ${new Date(camp.scheduled_at).toLocaleString("en-IN")}`,
      timestamp: camp.scheduled_at,
      badgeColor: camp.channel === "whatsapp" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700",
      channel: camp.channel
    }));

    // 2. Fetch recent bounces (last 24 hours)
    const activeSince = new Date();
    activeSince.setHours(activeSince.getHours() - 24);

    const recentBounces = await EmailEvent.find({
      event_type: { $in: ["bounce", "complaint"] },
      timestamp: { $gte: activeSince }
    })
    .sort({ timestamp: -1 })
    .limit(5);

    const alertNotifications = recentBounces.map((bounce) => ({
      id: `alert-${bounce._id}`,
      type: "alert",
      title: `Delivery Failure: ${bounce.event_type}`,
      message: `Permanent bounce detected for ${bounce.recipient_email}`,
      timestamp: bounce.timestamp,
      badgeColor: "bg-rose-100 text-rose-700",
      channel: bounce.channel || "email"
    }));

    const allNotifications = [...scheduledNotifications, ...alertNotifications];
    return res.json(allNotifications);
  } catch (error: any) {
    console.error("Backend Notifications error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
