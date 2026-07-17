// Mirrors the approved MSG91 template set documented in
// mail-pratipal-backend/docs/whatsapp-templates.md. If a template is renamed
// or its variables change after MSG91 approval, update both this file and
// that doc together — they must stay in lockstep with what's actually live.
//
// All seven templates below are now approved in MSG91. WHATSAPP_TEMPLATES
// (the list the admin UI/route validation offers for reminder presets) and
// DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET both point at each preset's real,
// specific template rather than the "event_notify" generic — that one stays
// in the type union and selectable as a manual fallback, but is no longer
// anyone's default. webinar_registration_confirmation/_cancelled/_rescheduled
// aren't reminder-preset templates (they're sent automatically from
// webinar-sync.ts / the cancel route, not chosen per-reminder) so they're
// not part of this dropdown list.

export type WhatsappTemplateName =
  | "event_notify"
  | "webinar_registration_confirmation"
  | "webinar_remind"
  | "webinar_starting_soon"
  | "webinar_live_now"
  | "webinar_cancelled"
  | "webinar_rescheduled";

export interface WhatsappTemplateDef {
  name: WhatsappTemplateName;
  label: string;
  description: string;
  hasButton: boolean;
}

export const WHATSAPP_TEMPLATES: WhatsappTemplateDef[] = [
  {
    name: "webinar_remind",
    label: "Webinar Reminder",
    description: "For the 3-day / 2-day / 1-day-before reminders. Includes the relative-time phrase (e.g. \"in 3 days\"). Text-only, no button.",
    hasButton: false,
  },
  {
    name: "webinar_starting_soon",
    label: "Starting Soon (30 min before)",
    description: "For the 30-minutes-before reminder. Includes a \"Join Webinar\" button — currently a static URL, same link for every webinar (not per-recipient).",
    hasButton: true,
  },
  {
    name: "webinar_live_now",
    label: "Live Now (at start)",
    description: "For the at-start reminder. Includes a \"Join Webinar\" button — currently a static URL, same link for every webinar (not per-recipient).",
    hasButton: true,
  },
  {
    name: "event_notify",
    label: "Event Reminder (generic)",
    description: "Generic fallback — text-only, no button. Available to pick manually but no longer any preset's default now that the specific templates are approved.",
    hasButton: false,
  },
];

export const DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET: Record<string, WhatsappTemplateName> = {
  "3_days_before": "webinar_remind",
  "2_days_before": "webinar_remind",
  "1_day_before": "webinar_remind",
  "30_min_before": "webinar_starting_soon",
  at_start: "webinar_live_now",
};

/** Human phrase for the {{relative time}} variable in webinar_remind, e.g. "in 3 days" / "tomorrow". */
export function describeOffset(offsetType: string, offsetValue?: number): string {
  if (offsetType === "at_start") return "starting now";
  if (offsetType === "custom") return "coming up";
  const value = offsetValue || 0;
  if (offsetType === "days_before") return value === 1 ? "tomorrow" : `in ${value} days`;
  if (offsetType === "hours_before") return `in ${value} hour${value === 1 ? "" : "s"}`;
  if (offsetType === "minutes_before") return `in ${value} minutes`;
  return "soon";
}

function formatDate(date: Date, timezone: string): string {
  return date.toLocaleDateString("en-IN", { timeZone: timezone, day: "numeric", month: "long", year: "numeric" });
}

function formatTime(date: Date, timezone: string): string {
  return date.toLocaleTimeString("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true });
}

export interface WhatsappTemplateData {
  firstName: string;
  webinarTitle: string;
  startsAt: Date;
  timezone: string;
  relativeTimePhrase?: string;
  originalDate?: Date;
  /**
   * Webinar._id. Currently UNUSED by buildWhatsappTemplateParams — the
   * "Join Webinar" button on webinar_starting_soon/webinar_live_now was
   * changed from a dynamic to a static URL in MSG91, so there's no longer
   * a per-send suffix slot to fill. Left wired at call sites (queue-processor.ts,
   * routes/webinars.ts) so restoring a real per-webinar link is a one-line
   * change here if the button is ever switched back to dynamic, or if the
   * approved body text is amended to include the full join URL as its own
   * {{n}} variable instead.
   */
  joinSuffix?: string;
}

/** Builds the exact body_N values (in order) + button URL suffix for a given approved template. */
export function buildWhatsappTemplateParams(
  templateName: WhatsappTemplateName,
  data: WhatsappTemplateData
): { bodyParams: string[]; buttonUrlSuffix?: string } {
  const date = formatDate(data.startsAt, data.timezone);
  const time = formatTime(data.startsAt, data.timezone);

  switch (templateName) {
    case "event_notify":
      // Body: "Reminder: You registered for *{{1}}*. The event starts on *{{2}}* on *{{3}}*.
      // Use the button below to join the webinar at the scheduled time."
      // Despite that copy, the approved template has NO button component —
      // MSG91 rejects the send ("Template does not contain button
      // components, no parameters allowed") if button_1 is included.
      return { bodyParams: [data.webinarTitle, date, time] };
    case "webinar_registration_confirmation":
      return { bodyParams: [data.firstName, data.webinarTitle, date, time, data.timezone] };
    case "webinar_remind":
      return { bodyParams: [data.firstName, data.webinarTitle, data.relativeTimePhrase || "soon", date, time, data.timezone] };
    case "webinar_starting_soon":
      // No buttonUrlSuffix: the "Join Webinar" button was switched from a
      // dynamic to a static URL in MSG91 (fixed link, same for every send).
      // Meta's Cloud API rejects the whole send if a button_1 component is
      // attached to a button that has no variable to fill — see joinSuffix
      // doc comment above for how to restore a real per-webinar link.
      return { bodyParams: [data.firstName, data.webinarTitle] };
    case "webinar_live_now":
      return { bodyParams: [data.firstName, data.webinarTitle] };
    case "webinar_cancelled":
      return { bodyParams: [data.firstName, data.webinarTitle, data.originalDate ? formatDate(data.originalDate, data.timezone) : date] };
    case "webinar_rescheduled":
      return { bodyParams: [data.firstName, data.webinarTitle, date, time, data.timezone] };
    default:
      return { bodyParams: [] };
  }
}
