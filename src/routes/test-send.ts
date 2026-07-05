import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import { getEmailProvider } from "../providers/provider-factory";
import { prepareEmailHtml } from "../lib/tracking-parser";

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

// POST /api/test-send - Dispatch test email
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, subject, html, fromName = "Pratipal", fromEmail = "contact@notifications.pratipal.in" } = req.body;

    if (!to || !subject || !html) {
      return res.status(400).json({ error: "Required fields (to, subject, html) are missing" });
    }

    const provider = getEmailProvider();
    
    // Parse HTML to inject personalization mock values and the unsubscribe link (tracking disabled)
    const trackingUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
    const parsedHtml = prepareEmailHtml({
      html,
      subscriber: {
        email: to,
        first_name: "Test",
        last_name: "Recipient",
        status: "subscribed",
      } as any,
      campaignId: "test-campaign",
      trackingUrl,
      trackingEnabled: { opens: false, clicks: false },
    });

    console.log(`Test Send: Dispatching test email to ${to} via ${process.env.EMAIL_PROVIDER || "auto-detected driver"}`);
    
    const result = await provider.sendEmail({
      to,
      fromName,
      fromEmail,
      subject,
      html: parsedHtml,
    });

    return res.json({
      success: true,
      messageId: result.messageId,
      dispatched_at: new Date().toISOString(),
      provider: process.env.EMAIL_PROVIDER || "auto-detected",
    });
  } catch (error: any) {
    console.error("Test send API error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
