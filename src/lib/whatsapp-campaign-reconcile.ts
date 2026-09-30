import { getWhatsappLogs } from "../providers/msg91-whatsapp-management.provider";

/**
 * MSG91's per-message status for a template send — the real, carrier-level
 * outcome, distinct from our own "did the API call to MSG91 succeed" sent/
 * failed EmailEvents. In particular "hold" is Meta throttling a marketing
 * template for ecosystem-engagement reasons — it's neither delivered nor a
 * hard failure, and lumping it into either would misrepresent what actually
 * happened to a large chunk of a campaign.
 */
export interface WhatsappStatusCounts {
  sent: number;
  delivered: number;
  read: number;
  hold: number;
  failed: number;
  other: number;
}

export interface WhatsappReconciledStats {
  /** Recipients we actually attempted to send to (our own "sent" + "failed" EmailEvents). */
  totalAttempted: number;
  /** Our-side failures — never reached MSG91 (missing number, template validation, network error, etc). */
  sendFailed: number;
  /** How many of our "sent" messageIds MSG91's logs actually had a row for. */
  matchedInMsg91: number;
  statusCounts: WhatsappStatusCounts;
  /** Top failure reasons, our-side and MSG91-side combined, most common first. */
  failureReasons: Array<{ reason: string; count: number }>;
}

export interface WhatsappMessageStatus {
  status: string;
  failureReason?: string | null;
}

const LOOKUP_LIMIT = 5000;

// The events log (GET /:id/events) re-fetches this on every page turn/search
// keystroke, and the analytics endpoint fetches it too — a short in-memory
// cache keeps a burst of admin interactions from each round-tripping to
// MSG91's control-panel API. Keyed by the (start, end) date window since
// that's the only thing that varies per campaign here.
const LOG_CACHE_TTL_MS = 60_000;
const logRowsCache = new Map<string, { fetchedAt: number; rows: any[] }>();

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * +/-1 day guards against the campaign's UTC timestamp landing on a
 * different calendar date than MSG91's IST-based report dates.
 */
async function fetchLogRowsAround(aroundDate: Date): Promise<any[]> {
  const start = new Date(aroundDate);
  start.setDate(start.getDate() - 1);
  const end = new Date(aroundDate);
  end.setDate(end.getDate() + 1);
  const cacheKey = `${toDateStr(start)}_${toDateStr(end)}`;

  const cached = logRowsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LOG_CACHE_TTL_MS) {
    return cached.rows;
  }

  const result = await getWhatsappLogs(toDateStr(start), toDateStr(end), LOOKUP_LIMIT);
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  logRowsCache.set(cacheKey, { fetchedAt: Date.now(), rows });
  return rows;
}

/**
 * Fetches MSG91's WhatsApp logs for the window around when a campaign sent
 * and reconciles them against the messageIds we recorded at send time.
 * Returns null if MSG91 config is missing or the log fetch fails (e.g. this
 * process isn't running from an IP whitelisted for MSG91's control-panel
 * API) — callers should fall back to locally-tracked stats in that case.
 */
export async function reconcileWhatsappCampaignStats(
  templateName: string,
  aroundDate: Date,
  sentMessageIds: string[],
  sendFailedDetails: string[]
): Promise<WhatsappReconciledStats | null> {
  if (sentMessageIds.length === 0 && sendFailedDetails.length === 0) {
    return {
      totalAttempted: 0,
      sendFailed: 0,
      matchedInMsg91: 0,
      statusCounts: { sent: 0, delivered: 0, read: 0, hold: 0, failed: 0, other: 0 },
      failureReasons: [],
    };
  }

  let rows: any[];
  try {
    rows = await fetchLogRowsAround(aroundDate);
  } catch (err: any) {
    console.error("MSG91 log reconciliation failed:", err.message);
    return null;
  }

  const targetIds = new Set(sentMessageIds);
  const byRequestId = new Map<string, any>();
  for (const row of rows) {
    if (row.direction === 1 && row.templateName === templateName && row.requestId && targetIds.has(row.requestId)) {
      byRequestId.set(row.requestId, row);
    }
  }

  const statusCounts: WhatsappStatusCounts = { sent: 0, delivered: 0, read: 0, hold: 0, failed: 0, other: 0 };
  const reasonCounts = new Map<string, number>();

  for (const id of sentMessageIds) {
    const row = byRequestId.get(id);
    if (!row) continue; // not yet reflected in MSG91's report, or outside the lookup window
    const status = (row.status || "").toLowerCase();
    if (status in statusCounts) {
      statusCounts[status as keyof WhatsappStatusCounts]++;
    } else {
      statusCounts.other++;
    }
    if (row.failureReason) {
      reasonCounts.set(row.failureReason, (reasonCounts.get(row.failureReason) || 0) + 1);
    }
  }

  for (const detail of sendFailedDetails) {
    reasonCounts.set(detail, (reasonCounts.get(detail) || 0) + 1);
  }

  const failureReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalAttempted: sentMessageIds.length + sendFailedDetails.length,
    sendFailed: sendFailedDetails.length,
    matchedInMsg91: byRequestId.size,
    statusCounts,
    failureReasons,
  };
}

/**
 * Per-message lookup for the recipient event log — given the messageIds we
 * recorded for a batch of "sent" EmailEvents, returns each one's real MSG91
 * status (sent/delivered/read/hold/failed) so the UI can show what actually
 * happened instead of just "sent" (which only ever meant "our call to
 * MSG91's send API succeeded", not that the recipient got it). Returns null
 * on fetch failure so callers can fall back to the raw EmailEvent type.
 */
export async function getWhatsappMessageStatusMap(
  templateName: string,
  aroundDate: Date,
  messageIds: string[]
): Promise<Map<string, WhatsappMessageStatus> | null> {
  const map = new Map<string, WhatsappMessageStatus>();
  if (messageIds.length === 0) return map;

  let rows: any[];
  try {
    rows = await fetchLogRowsAround(aroundDate);
  } catch (err: any) {
    console.error("MSG91 log lookup failed:", err.message);
    return null;
  }

  const targetIds = new Set(messageIds);
  for (const row of rows) {
    if (row.direction === 1 && row.templateName === templateName && row.requestId && targetIds.has(row.requestId)) {
      map.set(row.requestId, {
        status: (row.status || "").toLowerCase() || "sent",
        failureReason: row.failureReason || null,
      });
    }
  }
  return map;
}
