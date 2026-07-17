import EmailEvent from "../models/EmailEvent";
import { config } from "../config";
import { SendEmailParams } from "../providers/email-provider.interface";

/**
 * Paces individual sends so the process never exceeds the provider's
 * per-second send rate (SES production quota: 14/sec). One shared instance
 * is used across all queue legs so campaigns + reminders in the same sweep
 * share the same budget.
 */
class SendRatePacer {
  private minIntervalMs: number;
  private nextAllowedAt = 0;

  constructor(ratePerSecond: number) {
    this.minIntervalMs = Math.ceil(1000 / Math.max(1, ratePerSecond));
  }

  /** Resolves when it is safe to dispatch the next message. */
  async waitTurn(): Promise<void> {
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextAllowedAt);
    this.nextAllowedAt = scheduledAt + this.minIntervalMs;

    const delay = scheduledAt - now;
    if (delay > 0) {
      await sleep(delay);
    }
  }
}

export const emailRatePacer = new SendRatePacer(config.email.maxSendRatePerSecond);

/**
 * Emails sent in the rolling 24h window, measured from actual sent events —
 * covers campaigns, reminders and test sends alike.
 */
export async function getEmailsSentLast24h(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return EmailEvent.countDocuments({
    channel: "email",
    event_type: "sent",
    timestamp: { $gte: since },
  });
}

/** Remaining daily quota headroom. Never negative. */
export async function getDailyQuotaRemaining(): Promise<number> {
  const used = await getEmailsSentLast24h();
  return Math.max(0, config.email.dailyQuota - used);
}

const TRANSIENT_ERROR_NAMES = new Set([
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "LimitExceededException",
  "SendingPausedException",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "InternalFailure",
  "TimeoutError",
]);

const TRANSIENT_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"]);

export function isTransientSendError(err: any): boolean {
  if (!err) return false;
  if (TRANSIENT_ERROR_NAMES.has(err.name)) return true;
  if (TRANSIENT_ERROR_CODES.has(err.code)) return true;
  const httpStatus = err.$metadata?.httpStatusCode;
  if (typeof httpStatus === "number" && (httpStatus === 429 || httpStatus >= 500)) return true;
  return false;
}

/**
 * Rate-paced send with bounded retry + exponential backoff for transient
 * provider failures. Permanent errors (bad address, rejected identity) fail
 * immediately without burning retries.
 */
export async function sendEmailThrottled(
  provider: { sendEmail(params: SendEmailParams): Promise<{ messageId: string }> },
  params: SendEmailParams
): Promise<{ messageId: string }> {
  const maxRetries = config.email.sendMaxRetries;
  let attempt = 0;

  // First attempt + up to maxRetries retries
  for (;;) {
    await emailRatePacer.waitTurn();
    try {
      return await provider.sendEmail(params);
    } catch (err: any) {
      if (attempt >= maxRetries || !isTransientSendError(err)) {
        throw err;
      }
      attempt += 1;
      // 1s, 4s, 9s... capped at 15s so a sweep can't stall indefinitely.
      const backoffMs = Math.min(15000, 1000 * attempt * attempt);
      console.warn(
        `Transient send error for ${params.to} (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms:`,
        err.message
      );
      await sleep(backoffMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
