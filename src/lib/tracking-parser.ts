import { IEmailSubscriber } from "../models/EmailSubscriber";

interface ParseParams {
  html: string;
  subscriber: IEmailSubscriber;
  campaignId: string;
  trackingUrl: string;
  trackingEnabled: {
    opens: boolean;
    clicks: boolean;
  };
}

/**
 * Parses email HTML body to:
 * 1. Inject personalization variables: {{name}}, {{email}}, {{company}}, etc.
 * 2. Rewrite normal anchor tags to click tracking URLs.
 * 3. Append a 1x1 tracking pixel to track email opens.
 * 4. Append/Verify unsubscribe link is present.
 */
export function prepareEmailHtml({
  html,
  subscriber,
  campaignId,
  trackingUrl,
  trackingEnabled,
}: ParseParams): string {
  let parsedHtml = html || "";

  // 1. Personalization Variable Replacement
  const name = subscriber.first_name 
    ? `${subscriber.first_name} ${subscriber.last_name || ""}`.trim()
    : "Subscriber";
  const firstName = subscriber.first_name || "there";
  
  const replacements: Record<string, string> = {
    "{{name}}": name,
    "{{first_name}}": firstName,
    "{{email}}": subscriber.email,
    "{{company}}": (subscriber.metadata?.get("company") as string) || "Pratipal",
    "{{webinar}}": (subscriber.metadata?.get("webinar") as string) || "Upcoming Webinar",
    "{{date}}": new Date().toLocaleDateString("en-IN", { dateStyle: "long" }),
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
      // Skip if it's already a tracking URL
      if (url.includes("/api/track/click")) {
        return match;
      }
      
      const trackingClickUrl = `${trackingUrl}/api/track/click?campaignId=${campaignId}&email=${encodeURIComponent(
        subscriber.email
      )}&url=${encodeURIComponent(url)}`;
      
      return match.replace(url, trackingClickUrl);
    });
  }

  // 3. Unsubscribe Link Injection/Parsing
  // Ensure unsubscribe tags like {{unsubscribe}} are replaced
  const unsubscribeUrl = `${trackingUrl}/unsubscribe?email=${encodeURIComponent(
    subscriber.email
  )}&campaignId=${campaignId}`;

  if (parsedHtml.includes("{{unsubscribe}}")) {
    parsedHtml = parsedHtml.replaceAll("{{unsubscribe}}", unsubscribeUrl);
  }

  // Always append a standardized unsubscribe footer at the bottom of the email content
  const unsubscribeFooter = `
    <div style="margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center; font-size: 12px; color: #64748b; font-family: sans-serif; line-height: 1.5;">
      To unsubscribe from these emails, please <a href="${unsubscribeUrl}" style="color: #059669; text-decoration: underline; font-weight: 500;">click here</a>.
    </div>
  `;

  if (parsedHtml.includes("</body>")) {
    parsedHtml = parsedHtml.replace("</body>", `${unsubscribeFooter}</body>`);
  } else {
    parsedHtml += unsubscribeFooter;
  }

  // 4. Open Tracking Pixel Injection (1x1 transparent image)
  if (trackingEnabled.opens) {
    const trackingPixelUrl = `${trackingUrl}/api/track/open?campaignId=${campaignId}&email=${encodeURIComponent(
      subscriber.email
    )}`;
    
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
 * Uses the webinar title stored in subscriber.metadata("webinar") for {{webinar}}.
 */
export function replaceMergeTags(text: string, subscriber: IEmailSubscriber): string {
  const name = subscriber.first_name
    ? `${subscriber.first_name} ${subscriber.last_name || ""}`.trim()
    : "Subscriber";
  const firstName = subscriber.first_name || "there";

  const replacements: Record<string, string> = {
    "{{name}}": name,
    "{{first_name}}": firstName,
    "{{email}}": subscriber.email,
    "{{company}}": (subscriber.metadata?.get("company") as string) || "Pratipal",
    "{{webinar}}": (subscriber.metadata?.get("webinar") as string) || "Upcoming Webinar",
    "{{date}}": new Date().toLocaleDateString("en-IN", { dateStyle: "long" }),
  };

  let result = text;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}
