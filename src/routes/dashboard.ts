import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";
import EmailTemplate from "../models/EmailTemplate";
import WebinarReminder from "../models/WebinarReminder";
import Webinar from "../models/Webinar";

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
      totalWhatsappSent,
      totalWhatsappFailed,
      totalWhatsappOpens,
      activeSchedules,
      recentCampaigns,
      recentReminders,
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
