import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import { getEmailProvider } from "../providers/provider-factory";
import { prepareEmailHtml, replaceMergeTags } from "../lib/tracking-parser";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import { buildWhatsappTemplateParams, type WhatsappTemplateName } from "../lib/whatsapp-templates";
import { getMergedWhatsappTemplates } from "../lib/whatsapp-template-sync";
import { config } from "../config";

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

// POST /api/test-send/whatsapp - Dispatch test WhatsApp template
router.post("/whatsapp", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, templateName, eventName = "Test Campaign", variables, buttonParam } = req.body;

    if (!to || !templateName) {
      return res.status(400).json({ error: "Required fields (to, templateName) are missing" });
    }

    // Which branch to use must be decided by what KIND of template this is
    // (hardcoded/"supported" vs. a custom MSG91-approved one) — a custom
    // template has no case in buildWhatsappTemplateParams(), which silently
    // returns 0 params for an unrecognized name. MSG91 then rejects the send
    // ("localizable_params (0) does not match the expected number of params
    // (N)") with no useful error surfaced here.
    const templates = await getMergedWhatsappTemplates();
    const match = templates.find((t) => t.name === templateName);
    const isBuiltIn = match?.supported ?? true;

    let bodyParams: string[];
    let buttonUrlSuffix: string | undefined;
    if (!isBuiltIn) {
      const requiredBodyVars = match?.remote?.bodyVariableCount ?? 1;
      const savedVariables: string[] = Array.isArray(variables) ? variables : [];
      if (savedVariables.filter((v) => v?.trim()).length < requiredBodyVars) {
        return res.status(400).json({
          error: `"${templateName}" needs ${requiredBodyVars} variable value${requiredBodyVars === 1 ? "" : "s"} — fill them in before testing`,
        });
      }
      if (match?.remote?.buttons?.some((b) => b.needsParam) && !buttonParam?.trim()) {
        return res.status(400).json({ error: `"${templateName}"'s button link needs a value before testing` });
      }
      // Merge tags (e.g. {{first_name}}) typed into a custom template's
      // variables need something to resolve against — there's no real
      // subscriber for a test send, so a synthetic one stands in.
      const testSubscriber = {
        first_name: "Test",
        last_name: "Recipient",
        email: "test@example.com",
        whatsapp_number: to,
        metadata: new Map(),
      } as any;
      bodyParams = savedVariables.map((v) => replaceMergeTags(v, testSubscriber));
      buttonUrlSuffix = buttonParam ? replaceMergeTags(buttonParam, testSubscriber) : undefined;
    } else {
      ({ bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(templateName as WhatsappTemplateName, {
        firstName: "Test Recipient",
        webinarTitle: eventName,
        startsAt: new Date(),
        timezone: config.branding.timezone,
      }));
    }

    console.log(`Test WhatsApp Send: Dispatching test message to ${to}`);

    const result = await sendWhatsappTemplate({
      to,
      templateName,
      bodyParams,
      buttonUrlSuffix,
    });

    return res.json({
      success: true,
      messageId: result.messageId,
      dispatched_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Test WhatsApp send API error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/test-send - Dispatch test email
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, subject, html, fromName = config.branding.name, fromEmail = process.env.DEFAULT_SENDER_EMAIL || "" } = req.body;

    if (!fromEmail) {
      return res.status(400).json({ error: "fromEmail is required (or set DEFAULT_SENDER_EMAIL)" });
    }

    if (!to || !subject || !html) {
      return res.status(400).json({ error: "Required fields (to, subject, html) are missing" });
    }

    const provider = getEmailProvider();
    
    // Parse HTML to inject personalization mock values and the unsubscribe link (tracking disabled)
    const trackingUrl = config.appUrl;
    const mockSubscriber = {
      email: to,
      first_name: "Test",
      last_name: "Recipient",
      status: "subscribed",
      metadata: new Map([
        ["webinar", "Upcoming Webinar"],
        ["company", config.branding.name]
      ]),
    } as any;

    const parsedHtml = prepareEmailHtml({
      html,
      subscriber: mockSubscriber,
      // Synthetic id: test sends have tracking disabled, so this never
      // reaches the tracking endpoints — it only keys the unsubscribe URL.
      source: { type: "campaign", id: "000000000000000000000000" },
      trackingUrl,
      trackingEnabled: { opens: false, clicks: false },
    });

    const parsedSubject = replaceMergeTags(subject, mockSubscriber);

    console.log(`Test Send: Dispatching test email to ${to} via ${process.env.EMAIL_PROVIDER || "auto-detected driver"}`);
    
    const result = await provider.sendEmail({
      to,
      fromName,
      fromEmail,
      subject: parsedSubject,
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
