import dotenv from "dotenv";
dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

/**
 * Resolves a secret from the environment. In production a missing value is a
 * hard startup failure — silently falling back to a known dev default would
 * leave auth/cron endpoints effectively unprotected.
 */
function requiredSecret(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value;
  if (isProduction) {
    throw new Error(
      `FATAL: Required environment variable ${name} is not set. ` +
        `Refusing to start in production with an insecure fallback value.`
    );
  }
  return devFallback;
}

function requiredValue(name: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value;
  if (isProduction) {
    throw new Error(`FATAL: Required environment variable ${name} is not set.`);
  }
  return "";
}

export const config = {
  port: process.env.PORT || 3002,
  mongodbUri: requiredValue("MONGODB_URI"),
  jwtSecret: process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || requiredSecret("AUTH_JWT_SECRET", "fallback-dev-secret"),
  apiKey: requiredSecret("API_KEY", "pratipal-api-key-2026-secure-dev-auth"),
  cronSecret: requiredSecret("CRON_SECRET", "fallback-cron-secret-change-me"),
  /**
   * This mail system's own public frontend URL (crm.pratipal.in) — used to
   * build tracking pixels, click-tracking redirects, and unsubscribe links
   * embedded in outgoing emails. NOT the NEXT_PUBLIC_APP_URL frontend env
   * var (that's a separate app's build-time value the backend can't see) —
   * set APP_URL explicitly in the backend's own .env.
   */
  appUrl: process.env.APP_URL || "http://localhost:3001",
  mainWebsite: {
    url: process.env.MAIN_WEBSITE_URL || "http://localhost:3000",
    apiKey: process.env.MAIN_WEBSITE_API_KEY || "",
  },
  /**
   * White-label branding. Onboarding a new client is a config change:
   * set these env vars (plus the NEXT_PUBLIC_BRAND_* ones on the frontend)
   * and the platform is fully re-branded — no code edits required.
   */
  branding: {
    name: process.env.BRAND_NAME || "Pratipal",
    websiteUrl: process.env.BRAND_WEBSITE_URL || "https://pratipal.in",
    /** Accent color used inside generated email footers/links. */
    primaryColor: process.env.BRAND_PRIMARY_COLOR || "#232d5f",
    timezone: process.env.BRAND_TIMEZONE || "Asia/Kolkata",
    /** Session cookie shared with the main admin app. */
    sessionCookieName: process.env.SESSION_COOKIE_NAME || "pratipal_session",
    /**
     * Comma-separated origin suffixes allowed by CORS in production,
     * e.g. ".pratipal.in,https://pratipal.in".
     */
    allowedOriginSuffixes: (process.env.CORS_ALLOWED_ORIGINS || ".pratipal.in,https://pratipal.in")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  email: {
    /**
     * Maximum SES send rate in emails/second. AWS production quota for this
     * account: 14/sec. The queue processor paces individual sends to stay
     * under this ceiling.
     */
    maxSendRatePerSecond: Math.max(1, parseInt(process.env.SES_MAX_SEND_RATE || "14", 10) || 14),
    /**
     * Daily sending quota (emails per rolling 24h period). AWS production
     * quota for this account: 50,000/24h. Sends beyond this are deferred to
     * the next sweep once the window frees up.
     */
    dailyQuota: Math.max(1, parseInt(process.env.SES_DAILY_QUOTA || "50000", 10) || 50000),
    /** Max retry attempts for transient provider failures per message. */
    sendMaxRetries: Math.max(0, parseInt(process.env.EMAIL_SEND_MAX_RETRIES || "2", 10) || 2),
  },
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    region: process.env.AWS_REGION || "ap-south-1",
  },
  smtp: {
    host: process.env.EMAIL_HOST || "",
    port: parseInt(process.env.EMAIL_PORT || "465", 10),
    user: process.env.EMAIL_USER || "",
    pass: process.env.EMAIL_PASS || "",
    from: process.env.EMAIL_FROM || "",
  },
  shiprocket: {
    email: process.env.SHIPROCKET_EMAIL || "",
    password: process.env.SHIPROCKET_PASSWORD || "",
    mock: process.env.SHIPROCKET_MOCK === "true",
  },
  whatsapp: {
    msg91: {
      authKey: process.env.MSG91_AUTH_KEY || "",
      integratedNumber: process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER || "",
      namespace: process.env.MSG91_WHATSAPP_NAMESPACE || "",
      languageCode: process.env.MSG91_WHATSAPP_LANGUAGE_CODE || "en",
    },
  },
};
