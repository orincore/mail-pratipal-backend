// Registrants/customers type a bare 10-digit number (no country code) most of
// the time since website forms use a plain <input type="tel">. Normalize to
// E.164 so numbers are usable by the MSG91 WhatsApp Cloud API without
// per-send cleanup. Shared by webinar-sync.ts and the transactional
// notifications route.
export function normalizeWhatsappNumber(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return undefined;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length > 10) return `+${digits.replace(/^0+/, "")}`;
  return undefined;
}
