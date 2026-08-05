import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import {
  buildTransactionalWhatsappParams,
  TRANSACTIONAL_WHATSAPP_EVENTS,
  type TransactionalWhatsappEvent,
} from "../lib/notification-templates";
import { normalizeWhatsappNumber } from "../lib/phone";
import EmailSubscriber from "../models/EmailSubscriber";

const router = Router();

// External integrations only (Pratipal Website) — same shared API key as
// /api/test-send/whatsapp.
router.use(authMiddleware);

// POST /api/notifications/whatsapp/send
// Body: { event: TransactionalWhatsappEvent, to: string, data: TransactionalWhatsappData }
// Never throws past this handler — a WhatsApp/MSG91 failure must not surface
// as a hard error to the caller (Pratipal Website fires these best-effort
// alongside its email sends and must not let a notification failure affect
// checkout/booking/registration).
router.post("/whatsapp/send", async (req: AuthenticatedRequest, res: Response) => {
  const { event, to, data } = req.body || {};

  if (!event || !TRANSACTIONAL_WHATSAPP_EVENTS.includes(event)) {
    return res.status(400).json({
      success: false,
      error: `Unknown or missing event. Expected one of: ${TRANSACTIONAL_WHATSAPP_EVENTS.join(", ")}`,
    });
  }

  const toNumber = normalizeWhatsappNumber(to);
  if (!toNumber) {
    return res.status(400).json({ success: false, error: "Missing or invalid 'to' phone number" });
  }

  try {
    // Honor a past "STOP" reply even for transactional sends triggered
    // directly by phone number from an external caller (this route doesn't
    // otherwise look up an EmailSubscriber record at all) — WhatsApp
    // business policy blocks ALL business-initiated messages once a
    // recipient opts out, not just marketing ones, so this has to be
    // checked here too, not only on the campaign/reminder paths.
    const suppressed = await EmailSubscriber.exists({ whatsapp_number: toNumber, whatsapp_opted_out: true });
    if (suppressed) {
      return res.json({ success: false, error: "Recipient has opted out of WhatsApp messages" });
    }

    const { bodyParams, buttonUrlSuffix } = buildTransactionalWhatsappParams(
      event as TransactionalWhatsappEvent,
      data || {}
    );
    const result = await sendWhatsappTemplate({
      to: toNumber,
      templateName: event,
      bodyParams,
      buttonUrlSuffix,
    });
    return res.json({ success: true, messageId: result.messageId });
  } catch (err: any) {
    console.error(`Transactional WhatsApp send failed (event=${event}, to=${toNumber}):`, err?.message || err);
    return res.status(200).json({ success: false, error: err?.message || "WhatsApp send failed" });
  }
});

export default router;
