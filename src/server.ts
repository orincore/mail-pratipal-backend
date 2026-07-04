import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config";
import { connectDB } from "./lib/db";

// Routes imports
import campaignsRouter from "./routes/campaigns";
import templatesRouter from "./routes/templates";
import subscribersRouter from "./routes/subscribers";
import settingsRouter from "./routes/settings";
import testSendRouter from "./routes/test-send";
import trackingRouter from "./routes/tracking";
import unsubscribeRouter from "./routes/unsubscribe";
import jobsRouter from "./routes/jobs";

const app = express();

// 1. Establish Database Connection
connectDB().catch((err) => {
  console.error("Critical database connection error on startup:", err);
  process.exit(1);
});

// 2. Register Global Middlewares
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server calls)
      if (!origin) return callback(null, true);
      
      // Allow localhost connections (port 3000, 3001, etc.)
      if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
        return callback(null, true);
      }
      
      // In production, allow pratipal domains
      if (origin.endsWith(".pratipal.in") || origin === "https://pratipal.in") {
        return callback(null, true);
      }
      
      return callback(null, true); // Allow all for high compatibility in development
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// 3. Mount API Endpoints (matching Next.js patterns exactly)
app.use("/api/campaigns", campaignsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/subscribers", subscribersRouter);
app.use("/api", settingsRouter); // mounts /domains and /senders -> /api/domains & /api/senders
app.use("/api/test-send", testSendRouter);
app.use("/api/track", trackingRouter); // mounts /open and /click -> /api/track/open & /api/track/click
app.use("/api/unsubscribe", unsubscribeRouter);
app.use("/api/jobs", jobsRouter);

// Standard Health Check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  });
});

// 4. Register Express Error Handlers
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Express App Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "An internal server error occurred",
  });
});

// 5. Start Server Listening
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`📧 Standalone Mail Backend Listening on port ${PORT}`);
  console.log(`=================================================`);
});
