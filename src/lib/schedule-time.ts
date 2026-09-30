// The campaign scheduler's datetime picker sends a wall-clock string with no
// offset (e.g. "2026-10-01T01:30"). `new Date()` reads such a string in the
// *server's* timezone (UTC on the VPS), which silently shifted every schedule
// by 5h30m. Offset-less input is admin wall-clock time in IST.
const IST_OFFSET = "+05:30";
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export function parseScheduledAt(value: string | number | Date): Date {
  if (value instanceof Date || typeof value === "number") return new Date(value);
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) && !HAS_OFFSET.test(s)) {
    const withSeconds = s.length === 16 ? `${s}:00` : s;
    return new Date(`${withSeconds}${IST_OFFSET}`);
  }
  return new Date(s);
}
