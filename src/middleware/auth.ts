import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export type UserRole = "admin" | "editor" | "viewer";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
    full_name: string | null;
  };
}

const ALLOWED_ROLES: UserRole[] = ["admin", "editor", "viewer"];

/**
 * Role model:
 * - admin:  full access, including sender-identity settings
 * - editor: can create/update/delete campaigns, templates, subscribers, etc.
 * - viewer: read-only — any non-GET request is rejected
 *
 * External integrations authenticate with the shared API key and act as admin.
 */
export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // 1. Check API Key Headers (for external application integration)
  const apiKeyHeader = req.header("X-API-Key") || req.header("x-api-key");
  const authHeader = req.header("Authorization");

  let bearerKey: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    bearerKey = authHeader.substring(7);
  }

  const presentedKey = apiKeyHeader || bearerKey;

  if (presentedKey && presentedKey === config.apiKey) {
    // Authenticated via API key, inject a system API administrator session
    let apiHost = "system.local";
    try {
      apiHost = new URL(config.branding.websiteUrl).hostname;
    } catch {
      // keep fallback host
    }
    req.user = {
      id: "system-api-user",
      email: `api@${apiHost}`,
      role: "admin",
      full_name: "API Integrated App",
    };
    return next();
  }

  // 2. Check Cookie Token (for Next.js frontend browser calls)
  const token = req.cookies[config.branding.sessionCookieName];

  if (!token) {
    return res.status(401).json({ error: "Authentication session required. Please log in." });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;

    if (!ALLOWED_ROLES.includes(payload.role)) {
      return res.status(403).json({ error: "Access denied. Insufficient privileges." });
    }

    // Viewers are read-only across the whole API surface.
    if (payload.role === "viewer" && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      return res.status(403).json({ error: "Read-only access: viewers cannot modify data." });
    }

    req.user = {
      id: payload.sub || payload.id,
      email: payload.email,
      role: payload.role,
      full_name: payload.full_name || null,
    };

    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid session token. Please log in again." });
  }
}

/**
 * Per-route role guard, e.g. `router.post("/", requireRole("admin"), handler)`.
 * Must run after authMiddleware.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied. Insufficient privileges." });
    }
    return next();
  };
}
