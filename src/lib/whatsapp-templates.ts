// Mirrors the approved MSG91 template set documented in
// mail-pratipal-backend/docs/whatsapp-templates.md. If a template is renamed
// or its variables change after MSG91 approval, update both this file and
// that doc together — they must stay in lockstep with what's actually live.
//
// Only "event_notify" is approved in MSG91 right now. It's used as a
// stand-in for every reminder type below until the other six templates
// clear approval — WHATSAPP_TEMPLATES (the list the admin UI/route
// validation actually offers) intentionally exposes only it. The other
// names stay in the type union and in buildWhatsappTemplateParams() so
// re-enabling each one later is just: add it back to WHATSAPP_TEMPLATES.

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
    name: "event_notify",
    label: "Event Reminder (generic)",
    description: "The only MSG91-approved template right now — used for every reminder offset until the others are approved. Text-only — the approved template has no button component, despite the copy mentioning one.",
    hasButton: false,
  },
];

export const DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET: Record<string, WhatsappTemplateName> = {
  "3_days_before": "event_notify",
  "2_days_before": "event_notify",
  "1_day_before": "event_notify",
  "30_min_before": "event_notify",
  at_start: "event_notify",
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
  /** Webinar._id — becomes the {{1}} suffix on https://pratipal.in/webinar/join/{{1}} */
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
      return { bodyParams: [data.firstName, data.webinarTitle], buttonUrlSuffix: data.joinSuffix };
    case "webinar_live_now":
      return { bodyParams: [data.firstName, data.webinarTitle], buttonUrlSuffix: data.joinSuffix };
    case "webinar_cancelled":
      return { bodyParams: [data.firstName, data.webinarTitle, data.originalDate ? formatDate(data.originalDate, data.timezone) : date] };
    case "webinar_rescheduled":
      return { bodyParams: [data.firstName, data.webinarTitle, date, time, data.timezone] };
    default:
      return { bodyParams: [] };
  }
}
