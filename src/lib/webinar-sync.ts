import Webinar from "../models/Webinar";
import WebinarReminder from "../models/WebinarReminder";
import EmailSubscriber from "../models/EmailSubscriber";
import { config } from "../config";

const SYNC_THROTTLE_MS = 5 * 60 * 1000; // don't hit the main website more than once per 5 min
let lastWebinarListSyncAt = 0;
const lastRegistrantSyncAt = new Map<string, number>();

// Tag subscribers per *occurrence* (window), not per landing page — the same
// landing page/slug can be reused across many separate webinar runs, and each
// needs its own independent audience so reminders never cross-contaminate.
export function webinarTag(webinar: { source_window_id: string }): string {
  return `webinar-window:${webinar.source_window_id}`;
}

export function computeSendAt(
  startsAt: Date,
  offsetType: string,
  offsetValue?: number,
  customAt?: Date
): Date {
  if (offsetType === "custom") {
    return customAt ? new Date(customAt) : new Date(startsAt);
  }
  if (offsetType === "at_start") {
    return new Date(startsAt);
  }
  const value = offsetValue || 0;
  let ms = 0;
  if (offsetType === "days_before") ms = value * 24 * 60 * 60 * 1000;
  else if (offsetType === "hours_before") ms = value * 60 * 60 * 1000;
  else if (offsetType === "minutes_before") ms = value * 60 * 1000;
  return new Date(startsAt.getTime() - ms);
}

/**
 * Pulls webinar occurrences (InvitationWindows) from the main website and
 * upserts them, one Webinar per window. Throttled internally so it's safe to
 * call on every sweep tick.
 */
export async function syncWebinarsFromWebsite(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastWebinarListSyncAt < SYNC_THROTTLE_MS) return;
  if (!config.mainWebsite.apiKey) return;
  lastWebinarListSyncAt = now;

  const res = await fetch(`${config.mainWebsite.url}/api/integrations/webinars`, {
    headers: { "x-api-key": config.mainWebsite.apiKey },
  });
  if (!res.ok) {
    console.error("syncWebinarsFromWebsite: fetch failed", res.status, await res.text().catch(() => ""));
    return;
  }
  const { webinars } = (await res.json()) as { webinars: any[] };

  for (const w of webinars || []) {
    if (!w.webinar_starts_at) continue;

    const existing = await Webinar.findOne({ source_window_id: w.id });
    const newStartsAt = new Date(w.webinar_starts_at);
    const startsAtChanged = existing && existing.starts_at.getTime() !== newStartsAt.getTime();

    const webinar = await Webinar.findOneAndUpdate(
      { source_window_id: w.id },
      {
        $set: {
          slug: w.slug,
          title: w.title,
          starts_at: newStartsAt,
          timezone: w.webinar_timezone || "Asia/Kolkata",
          registration_start: w.registration_start ? new Date(w.registration_start) : undefined,
          registration_end: w.registration_end ? new Date(w.registration_end) : undefined,
          join_link: w.join_link || undefined,
          join_platform: w.join_platform || undefined,
        },
        $setOnInsert: { status: "upcoming" },
      },
      { upsert: true, new: true }
    );

    if (startsAtChanged) {
      // Never touch reminders that already fired/are firing, and never reinterpret
      // an intentionally-fixed custom absolute date.
      const pendingReminders = await WebinarReminder.find({
        webinar_id: webinar._id,
        dispatch_status: "pending",
        offset_type: { $ne: "custom" },
      });
      for (const reminder of pendingReminders) {
        reminder.computed_send_at = computeSendAt(
          newStartsAt,
          reminder.offset_type,
          reminder.offset_value
        );
        await reminder.save();
      }
    }
  }
}

// Registrants type a bare 10-digit number (no country code) most of the time
// since the signup form is a plain <input type="tel">. Normalize to E.164 so
// numbers are usable by the MSG91 WhatsApp Cloud API without per-send cleanup.
export function normalizeWhatsappNumber(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return undefined;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length > 10) return `+${digits.replace(/^0+/, "")}`;
  return undefined;
}

/**
 * Pulls the current registrant list for a single webinar occurrence (already
 * scoped to its registration window server-side) and reconciles EmailSubscriber
 * tags to exactly match it: tags anyone new, and un-tags anyone previously
 * tagged who's no longer in the fresh list. Throttled per-webinar.
 */
export async function syncRegistrantsForWebinar(webinar: any, force = false): Promise<void> {
  const now = Date.now();
  const last = lastRegistrantSyncAt.get(webinar.source_window_id) || 0;
  if (!force && now - last < SYNC_THROTTLE_MS) return;
  if (!config.mainWebsite.apiKey) return;
  lastRegistrantSyncAt.set(webinar.source_window_id, now);

  const res = await fetch(
    `${config.mainWebsite.url}/api/integrations/webinars/${webinar.source_window_id}/registrants`,
    { headers: { "x-api-key": config.mainWebsite.apiKey } }
  );
  if (!res.ok) {
    console.error("syncRegistrantsForWebinar: fetch failed", webinar.source_window_id, res.status);
    return;
  }
  const { registrants } = (await res.json()) as { registrants: any[] };

  const tag = webinarTag(webinar);
  const currentEmails = new Set<string>();

  for (const r of registrants || []) {
    if (!r.email) continue;
    const email = r.email.toLowerCase();
    currentEmails.add(email);
    const whatsapp_number = normalizeWhatsappNumber(r.whatsapp_number);
    await EmailSubscriber.findOneAndUpdate(
      { email },
      {
        $setOnInsert: { status: "subscribed" },
        $set: {
          first_name: r.first_name,
          "metadata.webinar": webinar.title,
          ...(whatsapp_number ? { whatsapp_number } : {}),
        },
        $addToSet: { tags: tag },
      },
      { upsert: true }
    );
  }

  await EmailSubscriber.updateMany(
    { tags: tag, email: { $nin: Array.from(currentEmails) } },
    { $pull: { tags: tag } }
  );

  webinar.last_synced_at = new Date();
  await webinar.save();
}
