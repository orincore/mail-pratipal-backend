import { Router, Request, Response } from "express";
import { AuthenticatedRequest, authMiddleware, requireRole } from "../middleware/auth";
import EmailSubscriber from "../models/EmailSubscriber";
import { normalizeWhatsappNumber } from "../lib/phone";
import { config } from "../config";
import {
  createWhatsappTemplate,
  updateWhatsappTemplate,
  deleteWhatsappTemplate,
  getWhatsappAnalytics,
  sendWhatsappSessionMessage,
  getWhatsappLogs,
  listWhatsappTemplates,
} from "../providers/msg91-whatsapp-management.provider";

const router = Router();

/**
 * Pulls the inbound message body out of MSG91's webhook payload. Field names
 * are per MSG91's "Webhook (New)" docs (msg91.com/help/webhook-new) — this
 * repo had no prior reference for the shape, so both the flat `text` field
 * and the `messages[0].text.body` fallback (seen in some MSG91 payload
 * variants) are handled defensively rather than trusting one exact shape.
 */
function extractInboundText(body: any): string {
  if (typeof body?.text === "string" && body.text.trim()) return body.text.trim();
  try {
    const messages = typeof body?.messages === "string" ? JSON.parse(body.messages) : body?.messages;
    const first = Array.isArray(messages) ? messages[0] : null;
    if (first?.text?.body) return String(first.text.body).trim();
  } catch {
    // malformed messages[] — fall through to empty
  }
  return "";
}

// POST /api/whatsapp/webhook - MSG91 inbound WhatsApp message webhook.
// Deliberately placed BEFORE the authMiddleware/requireRole("admin") gate
// below — MSG91 calls this directly with no admin session, so it must stay
// public. The only integrity check available is an optional shared-secret
// header (MSG91_WEBHOOK_SECRET; see config.ts) set as a custom header when
// registering the webhook in the MSG91 dashboard, since MSG91 doesn't sign
// or otherwise authenticate its webhook calls.
//
// Handles "reply STOP to opt out" / "reply RESUME to opt back in" — the
// WhatsApp equivalent of the email unsubscribe link (and its resubscribe
// counterpart). Delivery-report events on the same webhook carry a
// `direction` field that genuine inbound customer messages don't, so that's
// used to ignore everything else.
const STOP_CONFIRMATION_TEXT =
  'We have suppressed all WhatsApp notifications for your number. To resume notifications, type "RESUME".';
const RESUME_CONFIRMATION_TEXT =
  'We have resumed the notification service. If you want to stop notifications, type "STOP" to stop receiving WhatsApp notifications.';

router.post("/webhook", async (req: Request, res: Response) => {
  try {
    const secret = config.whatsapp.msg91.webhookSecret;
    if (secret) {
      const presented = req.header("x-webhook-secret");
      if (presented !== secret) {
        return res.status(401).json({ error: "Invalid webhook secret" });
      }
    }

    const body = req.body || {};

    if (body.direction !== undefined) {
      // A delivery report for one of our own outbound sends, not a reply.
      return res.status(200).json({ ok: true, skipped: "not an inbound message" });
    }

    const messageText = extractInboundText(body).trim().toLowerCase();
    const rawNumber = String(body.customerNumber || "");

    if ((messageText === "stop" || messageText === "resume") && rawNumber) {
      const normalized = normalizeWhatsappNumber(rawNumber);
      if (normalized) {
        const optingOut = messageText === "stop";
        // updateMany, not findOneAndUpdate: the same phone number can be on
        // several EmailSubscriber docs (duplicate registrations under
        // different emails — see fan-out.ts's phone dedup for the full
        // story), and every one of them must be updated together.
        const result = await EmailSubscriber.updateMany(
          { whatsapp_number: normalized },
          optingOut
            ? { $set: { whatsapp_opted_out: true, whatsapp_opted_out_at: new Date() } }
            : { $set: { whatsapp_opted_out: false }, $unset: { whatsapp_opted_out_at: "" } }
        );

        // STOP from a number with NO existing EmailSubscriber doc (never a
        // campaign/webinar registrant) previously vanished silently —
        // updateMany has nothing to match, so the opt-out was never
        // persisted anywhere and never showed up in the suppression list,
        // even though the confirmation reply still (correctly) went out.
        // Create a standalone record purely to remember the opt-out, so a
        // future registration under this number is caught by the same
        // whatsapp_opted_out gate everywhere else in the app.
        if (optingOut && result.matchedCount === 0) {
          await EmailSubscriber.create({
            whatsapp_number: normalized,
            first_name: body.customerName || undefined,
            whatsapp_opted_out: true,
            whatsapp_opted_out_at: new Date(),
          });
        }

        console.log(
          `WhatsApp ${optingOut ? "STOP" : "RESUME"} from ${normalized} — updated ${result.modifiedCount} existing, created ${
            optingOut && result.matchedCount === 0 ? 1 : 0
          } new subscriber record(s)`
        );

        // Confirmation is sent as a session reply (not a template) — the
        // customer just messaged us, so the 24h window is guaranteed open
        // right now. A failure here must never fail the webhook itself
        // (MSG91 would retry the whole inbound event), so it's caught and
        // only logged.
        await sendWhatsappSessionMessage({
          to: normalized,
          contentType: "text",
          text: optingOut ? STOP_CONFIRMATION_TEXT : RESUME_CONFIRMATION_TEXT,
        }).catch((err) => console.error(`Failed to send ${optingOut ? "STOP" : "RESUME"} confirmation:`, err.message));
      }
    }

    // Always ack 200: a webhook failure must never leave MSG91 retrying (or
    // surfacing an error to) an inbound message we've already read.
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error("POST /api/whatsapp/webhook error:", error);
    return res.status(200).json({ ok: false });
  }
});

// Template lifecycle + account-level send/analytics/logs are admin-only:
// creating/deleting a template affects the shared MSG91/Meta account for
// every brand touchpoint, and send-message dispatches a real WhatsApp
// message — editor/viewer roles (scoped to campaign/subscriber content
// elsewhere) shouldn't reach any of this.
router.use(authMiddleware, requireRole("admin"));

function defaultDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

// GET /api/whatsapp/templates - Full-detail template list (id, status, category, components) for the management UI
router.get("/templates", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const templates = await listWhatsappTemplates();
    return res.json({ success: true, templates });
  } catch (error: any) {
    console.error("GET /api/whatsapp/templates error:", error);
    return res.status(error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500).json({ error: error.message });
  }
});

// POST /api/whatsapp/templates - Create a new WhatsApp template (submits to Meta for review)
router.post("/templates", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { template_name, language, category, components, button_url } = req.body;

    if (!template_name || !language || !category || !Array.isArray(components)) {
      return res.status(400).json({ error: "template_name, language, category, and components[] are required" });
    }

    const result = await createWhatsappTemplate({
      templateName: template_name,
      language,
      category,
      components,
      buttonUrl: !!button_url,
    });

    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("POST /api/whatsapp/templates error:", error);
    return res.status(error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500).json({ error: error.message });
  }
});

// PUT /api/whatsapp/templates/:templateId - Update an existing template's components
router.put("/templates/:templateId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { templateId } = req.params;
    const { components, button_url } = req.body;

    if (!Array.isArray(components)) {
      return res.status(400).json({ error: "components[] is required" });
    }

    const result = await updateWhatsappTemplate({
      templateId,
      components,
      buttonUrl: !!button_url,
    });

    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("PUT /api/whatsapp/templates/:templateId error:", error);
    return res.status(error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500).json({ error: error.message });
  }
});

// DELETE /api/whatsapp/templates?template_name=... - Delete a template
router.delete("/templates", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const templateName = String(req.query.template_name || "");
    if (!templateName) {
      return res.status(400).json({ error: "template_name query param is required" });
    }

    const result = await deleteWhatsappTemplate(templateName);
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("DELETE /api/whatsapp/templates error:", error);
    return res.status(error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500).json({ error: error.message });
  }
});

// GET /api/whatsapp/analytics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD - defaults to the last 7 days
router.get("/analytics", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const defaults = defaultDateRange();
    const startDate = String(req.query.startDate || defaults.startDate);
    const endDate = String(req.query.endDate || defaults.endDate);

    const result = await getWhatsappAnalytics(startDate, endDate);
    return res.json({ success: true, startDate, endDate, result });
  } catch (error: any) {
    console.error("GET /api/whatsapp/analytics error:", error);
    return res.status(error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500).json({ error: error.message });
  }
});

// POST /api/whatsapp/send-message - Free-form send inside an active 24h session
// (recipient must have messaged the integrated number within the last 24h;
// a template send is required outside that window — see msg91-whatsapp.provider.ts).
router.post("/send-message", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, content_type = "text", text } = req.body;

    if (!to || !text) {
      return res.status(400).json({ error: "to and text are required" });
    }

    const result = await sendWhatsappSessionMessage({ to, contentType: content_type, text });
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("POST /api/whatsapp/send-message error:", error);
    return res.status(error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500).json({ error: error.message });
  }
});

// GET /api/whatsapp/logs?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD - defaults to the last 7 days
router.get("/logs", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const defaults = defaultDateRange();
    const startDate = String(req.query.startDate || defaults.startDate);
    const endDate = String(req.query.endDate || defaults.endDate);

    const result = await getWhatsappLogs(startDate, endDate);
    return res.json({ success: true, startDate, endDate, result });
  } catch (error: any) {
    console.error("GET /api/whatsapp/logs error:", error);
    return res.status(error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500).json({ error: error.message });
  }
});

export default router;
