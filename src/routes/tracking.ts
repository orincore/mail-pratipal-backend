import { Router, Request, Response } from "express";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";

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

// GET /api/track/open - Record open event
router.get("/open", async (req: Request, res: Response) => {
  try {
    const campaignId = req.query.campaignId as string;
    const email = req.query.email as string;
    console.log(`[Tracking] Open request received: campaignId=${campaignId}, email=${email}`);

    if (campaignId && email) {
      const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "unknown";
      const userAgent = (req.headers["user-agent"] as string) || "";
      const { deviceType, browser } = parseUserAgent(userAgent);

      // Check if this subscriber has already opened this campaign
      const alreadyOpened = await EmailEvent.exists({
        campaign_id: campaignId,
        recipient_email: email.toLowerCase(),
        event_type: "open",
      });

      // 1. Create a detailed email log event
      await EmailEvent.create({
        campaign_id: campaignId,
        recipient_email: email.toLowerCase(),
        event_type: "open",
        ip_address: ipAddress,
        user_agent: userAgent,
        device_type: deviceType,
        browser,
        timestamp: new Date(),
      });

      // 2. Increment stats on the campaign if this is a unique open
      if (!alreadyOpened) {
        await EmailCampaign.findByIdAndUpdate(campaignId, {
          $inc: { "stats.opens": 1 },
        });
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
  const campaignId = req.query.campaignId as string;
  const email = req.query.email as string;
  const url = (req.query.url as string) || "";

  const fallbackUrl = "https://pratipal.in";
  const destinationUrl = url ? decodeURIComponent(url) : fallbackUrl;
  console.log(`[Tracking] Click request received: campaignId=${campaignId}, email=${email}, url=${destinationUrl}`);

  try {
    if (campaignId && email) {
      const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "unknown";
      const userAgent = (req.headers["user-agent"] as string) || "";
      const { deviceType, browser } = parseUserAgent(userAgent);

      const alreadyClicked = await EmailEvent.exists({
        campaign_id: campaignId,
        recipient_email: email.toLowerCase(),
        event_type: "click",
      });

      // 1. Log detailed click event in database
      await EmailEvent.create({
        campaign_id: campaignId,
        recipient_email: email.toLowerCase(),
        event_type: "click",
        link_url: destinationUrl,
        ip_address: ipAddress,
        user_agent: userAgent,
        device_type: deviceType,
        browser,
        timestamp: new Date(),
      });

      // 2. Increment stats on the campaign if this is a unique click
      if (!alreadyClicked) {
        await EmailCampaign.findByIdAndUpdate(campaignId, {
          $inc: { "stats.clicks": 1 },
        });
      }
    }
  } catch (error) {
    console.error("Click tracking error:", error);
  }

  // Redirection
  return res.redirect(302, destinationUrl);
});

export default router;
