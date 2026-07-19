import { IEmailSubscriber } from "../models/EmailSubscriber";
import { config } from "../config";

/**
 * Identifies what kind of send an email belongs to, so tracking events land
 * on the right model (EmailCampaign vs WebinarReminder) instead of
 * everything being attributed to campaigns.
 */
export type TrackingSourceType = "campaign" | "reminder";

export interface TrackingSource {
  type: TrackingSourceType;
  id: string;
}

interface ParseParams {
  html: string;
  subscriber: IEmailSubscriber;
  source: TrackingSource;
  trackingUrl: string;
  trackingEnabled: {
    opens: boolean;
    clicks: boolean;
  };
  /**
   * Authoritative values that win over subscriber.metadata for merge tags,
   * e.g. {"{{join_link}}": "..."} on webinar reminder sends where the send
   * context knows the webinar — avoids depending on per-subscriber sync
   * timing for the correct join URL.
   */
  tagOverrides?: Record<string, string>;
}

function sourceQuery(source: TrackingSource, email: string): string {
  return `sourceType=${source.type}&sourceId=${source.id}&email=${encodeURIComponent(email)}`;
}

/**
 * Unsubscribe URLs for a given recipient/send:
 * - pageUrl: the human-facing /unsubscribe page linked in the footer
 * - oneClickUrl: RFC 8058 one-click POST target for the List-Unsubscribe header
 */
export function buildUnsubscribeUrls(trackingUrl: string, email: string, source: TrackingSource) {
  const query = sourceQuery(source, email);
  return {
    pageUrl: `${trackingUrl}/unsubscribe?email=${encodeURIComponent(email)}&${
      source.type === "campaign" ? `campaignId=${source.id}` : `sourceType=${source.type}&sourceId=${source.id}`
    }`,
    oneClickUrl: `${trackingUrl}/api/unsubscribe/one-click?${query}`,
  };
}

/**
 * RFC 8058 / Gmail+Yahoo bulk-sender compliant unsubscribe headers.
 */
export function buildListUnsubscribeHeaders(
  trackingUrl: string,
  email: string,
  source: TrackingSource
): Record<string, string> {
  const { oneClickUrl } = buildUnsubscribeUrls(trackingUrl, email, source);
  return {
    "List-Unsubscribe": `<${oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Parses email HTML body to:
 * 1. Inject personalization variables: {{name}}, {{email}}, {{company}}, etc.
 * 2. Rewrite normal anchor tags to click tracking URLs.
 * 3. Append/Verify unsubscribe link is present.
 * 4. Append a 1x1 tracking pixel to track email opens.
 */
export function prepareEmailHtml({
  html,
  subscriber,
  source,
  trackingUrl,
  trackingEnabled,
  tagOverrides,
}: ParseParams): string {
  let parsedHtml = html || "";
  const recipientEmail = subscriber.email || "";

  // 1. Personalization Variable Replacement
  const name = subscriber.first_name
    ? `${subscriber.first_name} ${subscriber.last_name || ""}`.trim()
    : "Subscriber";
  const firstName = subscriber.first_name || "there";

  const replacements: Record<string, string> = {
    "{{name}}": name,
    "{{first_name}}": firstName,
    "{{email}}": recipientEmail,
    "{{company}}": (subscriber.metadata?.get("company") as string) || config.branding.name,
    "{{webinar}}": (subscriber.metadata?.get("webinar") as string) || "Upcoming Webinar",
    // Resolved here (before the click-tracking rewrite) so the join button's
    // href becomes a real URL that mail clients render as tappable AND gets
    // wrapped for click tracking like any other link.
    "{{join_link}}": (subscriber.metadata?.get("webinar_join_link") as string) || config.branding.websiteUrl,
    "{{date}}": new Date().toLocaleDateString("en-IN", { dateStyle: "long" }),
    ...(tagOverrides || {}),
  };

  // Replace standard variables
  for (const [placeholder, value] of Object.entries(replacements)) {
    parsedHtml = parsedHtml.replaceAll(placeholder, value);
  }

  // 2. Click Tracking Rewrite
  if (trackingEnabled.clicks) {
    // Regular expression to find <a href="..."> links
    // Avoids matching tracking links, mailto:, tel:, anchor jumps, or unsubscribe placeholders
    const hrefRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(https?:\/\/[^\s"'<>]+)\1/gi;

    parsedHtml = parsedHtml.replace(hrefRegex, (match, quote, url) => {
      // Skip if it's already a tracking URL or an unsubscribe URL
      if (url.includes("/api/track/click") || url.includes("/unsubscribe")) {
        return match;
      }

      const trackingClickUrl = `${trackingUrl}/api/track/click?${sourceQuery(
        source,
        recipientEmail
      )}&url=${encodeURIComponent(url)}`;

      return match.replace(url, trackingClickUrl);
    });
  }

  // 3. Unsubscribe Link Injection/Parsing
  const { pageUrl: unsubscribeUrl } = buildUnsubscribeUrls(trackingUrl, recipientEmail, source);

  if (parsedHtml.includes("{{unsubscribe}}")) {
    parsedHtml = parsedHtml.replaceAll("{{unsubscribe}}", unsubscribeUrl);
  }

  // Always append a standardized unsubscribe footer at the bottom of the email content
  const unsubscribeFooter = `
    <div style="margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center; font-size: 12px; color: #64748b; font-family: sans-serif; line-height: 1.5;">
      To unsubscribe from these emails, please <a href="${unsubscribeUrl}" style="color: ${config.branding.primaryColor}; text-decoration: underline; font-weight: 500;">click here</a>.
    </div>
  `;

  if (parsedHtml.includes("</body>")) {
    parsedHtml = parsedHtml.replace("</body>", `${unsubscribeFooter}</body>`);
  } else {
    parsedHtml += unsubscribeFooter;
  }

  // 4. Open Tracking Pixel Injection (1x1 transparent image)
  if (trackingEnabled.opens) {
    const trackingPixelUrl = `${trackingUrl}/api/track/open?${sourceQuery(source, recipientEmail)}`;

    const pixelImg = `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none; width:0px; height:0px; border:0;" alt="" />`;

    if (parsedHtml.includes("</body>")) {
      parsedHtml = parsedHtml.replace("</body>", `${pixelImg}</body>`);
    } else {
      parsedHtml += pixelImg;
    }
  }

  return parsedHtml;
}

/**
 * Applies the same personalization merge tags to any plain string (e.g. email subject line).
 * Uses the webinar title/join link stored in subscriber.metadata("webinar") /
 * metadata("webinar_join_link") — set by syncRegistrantsForWebinar() in
 * webinar-sync.ts — for {{webinar}} / {{join_link}}.
 */
export function replaceMergeTags(
  text: string,
  subscriber: IEmailSubscriber,
  tagOverrides?: Record<string, string>
): string {
  const name = subscriber.first_name
    ? `${subscriber.first_name} ${subscriber.last_name || ""}`.trim()
    : "Subscriber";
  const firstName = subscriber.first_name || "there";

  const replacements: Record<string, string> = {
    "{{name}}": name,
    "{{first_name}}": firstName,
    "{{email}}": subscriber.email || "",
    "{{company}}": (subscriber.metadata?.get("company") as string) || config.branding.name,
    "{{webinar}}": (subscriber.metadata?.get("webinar") as string) || "Upcoming Webinar",
    "{{join_link}}": (subscriber.metadata?.get("webinar_join_link") as string) || config.branding.websiteUrl,
    "{{date}}": new Date().toLocaleDateString("en-IN", { dateStyle: "long" }),
    ...(tagOverrides || {}),
  };

  let result = text;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}
