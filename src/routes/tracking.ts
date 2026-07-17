import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";
import WebinarReminder from "../models/WebinarReminder";
import { config } from "../config";

const router = Router();

// 1x1 transparent GIF buffer
const TRANSPARENT_GIF_BUFFER = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

function parseUserAgent(userAgentString: string) {
  const ua = userAgentString.toLowerCase();

  let deviceType = "desktop";
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile|webos/.test(ua)) {
    deviceType = "mobile";
  } else if (/ipad|tablet/.test(ua)) {
    deviceType = "tablet";
  }

  let browser = "other";
  if (ua.includes("firefox")) {
    browser = "firefox";
  } else if (ua.includes("chrome") || ua.includes("chromium")) {
    browser = "chrome";
  } else if (ua.includes("safari")) {
    browser = "safari";
  } else if (ua.includes("edge")) {
    browser = "edge";
  } else if (ua.includes("msie") || ua.includes("trident")) {
    browser = "ie";
  }

  return { deviceType, browser };
}

interface ResolvedSource {
  type: "campaign" | "reminder";
  id: string;
  /** The EmailEvent field this send is keyed by. */
  idField: "campaign_id" | "reminder_id";
}

/**
 * Resolves the tracked send source from query params. Supports the current
 * sourceType/sourceId scheme plus the legacy campaignId param still baked
 * into the pixels/links of already-delivered emails.
 */
function resolveSource(req: Request): ResolvedSource | null {
  const sourceType = req.query.sourceType as string;
  const sourceId = (req.query.sourceId as string) || "";
  const legacyCampaignId = (req.query.campaignId as string) || "";

  const id = sourceId || legacyCampaignId;
  if (!id || !mongoose.isValidObjectId(id)) return null;

  if (sourceType === "reminder") {
    return { type: "reminder", id, idField: "reminder_id" };
  }
  // sourceType "campaign", or a legacy campaignId-only URL
  return { type: "campaign", id, idField: "campaign_id" };
}

async function incrementSourceStat(source: ResolvedSource, stat: "opens" | "clicks") {
  if (source.type === "campaign") {
    await EmailCampaign.findByIdAndUpdate(source.id, { $inc: { [`stats.${stat}`]: 1 } });
  } else {
    await WebinarReminder.findByIdAndUpdate(source.id, { $inc: { [`stats.${stat}`]: 1 } });
  }
}

// GET /api/track/open - Record open event
router.get("/open", async (req: Request, res: Response) => {
  try {
    const source = resolveSource(req);
    const email = req.query.email as string;

    if (source && email) {
      const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "unknown";
      const userAgent = (req.headers["user-agent"] as string) || "";
      const { deviceType, browser } = parseUserAgent(userAgent);

      // Check if this subscriber has already opened this send
      const alreadyOpened = await EmailEvent.exists({
        [source.idField]: source.id,
        recipient_email: email.toLowerCase(),
        event_type: "open",
      });

      // 1. Create a detailed email log event
      await EmailEvent.create({
        [source.idField]: source.id,
        recipient_email: email.toLowerCase(),
        event_type: "open",
        ip_address: ipAddress,
        user_agent: userAgent,
        device_type: deviceType,
        browser,
        timestamp: new Date(),
      });

      // 2. Increment stats on the owning model if this is a unique open
      if (!alreadyOpened) {
        await incrementSourceStat(source, "opens");
      }
    }
  } catch (error) {
    console.error("Open tracking error:", error);
  }

  // Always return the transparent 1x1 GIF to prevent broken image displays
  res.writeHead(200, {
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  return res.end(TRANSPARENT_GIF_BUFFER);
});

// GET /api/track/click - Record click and redirect
router.get("/click", async (req: Request, res: Response) => {
  const source = resolveSource(req);
  const email = req.query.email as string;
  const url = (req.query.url as string) || "";
  const channel = (req.query.channel as string) || "email";

  const fallbackUrl = config.branding.websiteUrl;
  const destinationUrl = url ? decodeURIComponent(url) : fallbackUrl;

  try {
    if (source && email) {
      const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "unknown";
      const userAgent = (req.headers["user-agent"] as string) || "";
      const { deviceType, browser } = parseUserAgent(userAgent);

      const alreadyClicked = await EmailEvent.exists({
        [source.idField]: source.id,
        recipient_email: email.toLowerCase(),
        event_type: "click",
        channel: channel === "whatsapp" ? "whatsapp" : "email",
      });

      // 1. Log detailed click event in database
      await EmailEvent.create({
        [source.idField]: source.id,
        recipient_email: email.toLowerCase(),
        event_type: "click",
        channel: channel === "whatsapp" ? "whatsapp" : "email",
        link_url: destinationUrl,
        ip_address: ipAddress,
        user_agent: userAgent,
        device_type: deviceType,
        browser,
        timestamp: new Date(),
      });

      // 2. Increment stats on the owning model if this is a unique click
      if (!alreadyClicked) {
        await incrementSourceStat(source, "clicks");
      }
    }
  } catch (error) {
    console.error("Click tracking error:", error);
  }

  // Redirection
  return res.redirect(302, destinationUrl);
});

export default router;
