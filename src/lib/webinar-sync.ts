import Webinar from "../models/Webinar";
import WebinarReminder from "../models/WebinarReminder";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailEvent from "../models/EmailEvent";
import { config } from "../config";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import { buildWhatsappTemplateParams } from "./whatsapp-templates";
import { normalizeWhatsappNumber } from "./phone";
import { scheduleReminderJob } from "./queue/queues";

export { normalizeWhatsappNumber };

export interface LifecycleDedup {
  webinarId: any;
  recipientEmail: string;
  /** e.g. "webinar_cancelled", or "webinar_rescheduled:<new ISO start>" so a
   * genuine second reschedule still notifies while the same one never
   * double-sends. */
  key: string;
}

// Shared by the cancellation and reschedule notices below — logs and swallows
// a send failure for one recipient rather than letting it interrupt the sync
// loop for everyone else.
//
// Idempotent per (webinar, dedup key, recipient), enforced by EmailEvent's
// partial unique index. Claim-FIRST: the "sent" row is inserted before the
// MSG91 call, so concurrent syncs from different processes (the API server's
// Sync Now vs. the queue worker's pre-dispatch force sync) can't both send —
// this exact race is how registrants used to receive the same lifecycle
// WhatsApp message multiple times. If the send then fails, the claim is
// rolled back so a later sync can retry.
export async function sendLifecycleWhatsapp(
  templateName: "webinar_cancelled" | "webinar_rescheduled",
  to: string,
  data: Parameters<typeof buildWhatsappTemplateParams>[1],
  dedup: LifecycleDedup
): Promise<void> {
  const recipient_email = dedup.recipientEmail.toLowerCase();
  try {
    try {
      await EmailEvent.create({
        webinar_id: dedup.webinarId,
        lifecycle_event: dedup.key,
        recipient_email,
        channel: "whatsapp",
        event_type: "sent",
        timestamp: new Date(),
        details: { template: templateName },
      });
    } catch (claimErr: any) {
      // Duplicate key: another sync already sent (or is sending) this exact
      // notice to this recipient — skip silently.
      if (claimErr?.code === 11000) return;
      throw claimErr;
    }

    try {
      const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(templateName, data);
      await sendWhatsappTemplate({ to, templateName, bodyParams, buttonUrlSuffix });
    } catch (sendErr) {
      await EmailEvent.deleteOne({
        webinar_id: dedup.webinarId,
        lifecycle_event: dedup.key,
        recipient_email,
        event_type: "sent",
      }).catch(() => {});
      throw sendErr;
    }
  } catch (err) {
    console.error(`${templateName} WhatsApp send failed (${recipient_email}):`, err);
  }
}

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
          window_name: w.window_name || undefined,
          starts_at: newStartsAt,
          timezone: w.webinar_timezone || config.branding.timezone,
          registration_start: w.registration_start ? new Date(w.registration_start) : undefined,
          registration_end: w.registration_end ? new Date(w.registration_end) : undefined,
          join_link: w.join_link || undefined,
          join_platform: w.join_platform || undefined,
        },
        $setOnInsert: { status: "upcoming" },
      },
      { upsert: true, new: true }
    );

    // Nothing else ever transitions a webinar out of "upcoming" once its
    // start time passes — cancellation is the only other status change, set
    // manually via PUT /api/webinars/:id. Without this, the dashboard shows
    // "upcoming" forever for webinars that happened weeks ago.
    if (webinar.status === "upcoming" && webinar.starts_at.getTime() < Date.now()) {
      webinar.status = "completed";
      await webinar.save();
    }

    if (startsAtChanged) {
      // Never touch reminders that already fired/are firing, and never
      // reinterpret an intentionally-fixed custom absolute date. $or on both
      // dispatch fields — an email-only query here used to silently skip
      // rescheduling whatsapp-only reminders when a webinar's start moved.
      const pendingReminders = await WebinarReminder.find({
        webinar_id: webinar._id,
        offset_type: { $ne: "custom" },
        $or: [{ dispatch_status: "pending" }, { whatsapp_dispatch_status: "pending" }],
      });
      for (const reminder of pendingReminders) {
        reminder.computed_send_at = computeSendAt(
          newStartsAt,
          reminder.offset_type,
          reminder.offset_value
        );
        await reminder.save();
        // Re-arm the delayed job to the new time — without this, a stale
        // BullMQ job would still fire at the old computed_send_at.
        await scheduleReminderJob(reminder);
      }

      // Let already-registered attendees know the time moved. Only for a
      // still-upcoming webinar — a cancelled one gets its own notice
      // instead (see the PUT /api/webinars/:id route), and a completed one
      // has nobody left to tell.
      if (webinar.status === "upcoming") {
        const tag = webinarTag(webinar);
        const subscribers = await EmailSubscriber.find({
          tags: tag,
          whatsapp_number: { $exists: true, $ne: null },
          whatsapp_opted_out: { $ne: true },
        }).lean();
        for (const sub of subscribers) {
          if (!sub.whatsapp_number) continue;
          await sendLifecycleWhatsapp(
            "webinar_rescheduled",
            sub.whatsapp_number,
            { firstName: sub.first_name || "there", webinarTitle: webinar.title, startsAt: newStartsAt, timezone: webinar.timezone },
            // Keyed by the NEW start time: a second genuine reschedule sends
            // its own notice, but re-running sync (or a racing concurrent
            // sync) for the same reschedule never re-sends this one.
            { webinarId: webinar._id, recipientEmail: sub.email, key: `webinar_rescheduled:${newStartsAt.toISOString()}` }
          );
        }
      }
    }
  }
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

  // Was previously one `exists` + one `findOneAndUpdate` PER registrant,
  // awaited sequentially — with several hundred registrants per window and
  // "Sync Now" force-syncing every upcoming webinar in one request, that was
  // ~2 DB round-trips per registrant (thousands total), which is what made
  // the dashboard's Sync Now button hang. Batched instead: one bulkWrite for
  // all the upserts.
  const bulkOps: any[] = [];

  for (const r of registrants || []) {
    if (!r.email) continue;
    const email = r.email.toLowerCase();
    currentEmails.add(email);
    const whatsapp_number = normalizeWhatsappNumber(r.whatsapp_number);

    // registered_at:<tag> — this registrant's created_at on the MAIN
    // WEBSITE for THIS specific webinar occurrence, keyed by the same tag
    // that marks them as its audience. Plain "created_at" on EmailSubscriber
    // is this record's own first-ever sync (or a prior, unrelated webinar's,
    // for anyone who's registered more than once) — no good for "audience of
    // this webinar between these dates." $set, not $setOnInsert: an existing
    // subscriber re-registering for the same occurrence (rare, but possible
    // after a cancelled + re-opened window) should pick up the latest date.
    const registeredAt = r.created_at ? new Date(r.created_at) : null;

    bulkOps.push({
      updateOne: {
        filter: { email },
        update: {
          $setOnInsert: { status: "subscribed" },
          $set: {
            first_name: r.first_name,
            "metadata.webinar": webinar.title,
            // Powers the {{join_link}} merge tag (tracking-parser.ts) so email
            // templates can point at this specific occurrence instead of a
            // hardcoded/static URL. Same redirect page the WhatsApp button's
            // dynamic suffix targets — see docs/whatsapp-templates.md.
            // Must be the main site's InvitationWindow id — /webinar/join/[windowId]
            // resolves InvitationWindow.findById(), not this backend's Webinar._id.
            "metadata.webinar_join_link": `${config.mainWebsite.url}/webinar/join/${webinar.source_window_id}`,
            ...(whatsapp_number ? { whatsapp_number } : {}),
            ...(registeredAt && !Number.isNaN(registeredAt.getTime())
              ? { [`metadata.registered_at:${tag}`]: registeredAt }
              : {}),
          },
          $addToSet: { tags: tag },
        },
        upsert: true,
      },
    });
  }

  if (bulkOps.length > 0) {
    await EmailSubscriber.bulkWrite(bulkOps, { ordered: false });
  }

  // NOTE: registration-confirmation WhatsApp is deliberately NOT sent here.
  // The main website already sends an instant confirmation
  // (invitation_registration_confirmed, via POST /api/notifications/whatsapp/
  // send) at the moment of registration. This sync used to ALSO message every
  // registrant it hadn't tagged yet — which meant the first sync of a window
  // (or any tag loss from the $pull reconciliation below, or two concurrent
  // syncs racing) re-classified long-registered people as "new" and blasted
  // "your seat is confirmed" again: clicking Sync Now could message the whole
  // registrant list, and individuals received the same confirmation several
  // times. Sync's job is tag reconciliation only; confirmation belongs to the
  // registration moment.

  await EmailSubscriber.updateMany(
    { tags: tag, email: { $nin: Array.from(currentEmails) } },
    { $pull: { tags: tag } }
  );

  webinar.last_synced_at = new Date();
  await webinar.save();
}
