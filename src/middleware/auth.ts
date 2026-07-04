import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    full_name: string | null;
  };
}

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
    // Authenticated via API key, inject a mock system API administrator session
    req.user = {
      id: "system-api-user",
      email: "api@pratipal.in",
      role: "admin",
      full_name: "API Integrated App"
    };
    return next();
  }

  // 2. Check Cookie Token (for Next.js frontend browser calls)
  const token = req.cookies["pratipal_session"];
  
  if (!token) {
    return res.status(401).json({ error: "Authentication session required. Please log in." });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    
    // Enforce administrator role checks
    if (payload.role !== "admin") {
      return res.status(403).json({ error: "Access denied. Administrator privileges required." });
    }

    req.user = {
      id: payload.sub || payload.id,
      email: payload.email,
      role: payload.role,
      full_name: payload.full_name || null
    };

    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid session token. Please log in again." });
  }
}
