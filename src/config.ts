import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: process.env.PORT || 3002,
  mongodbUri: process.env.MONGODB_URI || "",
  jwtSecret: process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || "fallback-dev-secret",
  apiKey: process.env.API_KEY || "pratipal-api-key-2026-secure-dev-auth",
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
  }
};
