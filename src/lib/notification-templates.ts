// Transactional WhatsApp templates for Pratipal Website events (orders,
// e-book delivery, course/consultation bookings, invitation-form
// registrations). Kept separate from whatsapp-templates.ts (webinar-specific
// data shape/lifecycle) to avoid distorting that file's WhatsappTemplateData
// interface with unrelated order/booking fields.
//
// Mirrors the approved MSG91 template set documented in
// mail-pratipal-backend/docs/whatsapp-templates.md — if a template is
// renamed or its variables change after MSG91 approval, update both this
// file and that doc together.

export type TransactionalWhatsappEvent =
  | "invitation_registration_confirmed"
  | "order_confirmed_customer"
  | "order_confirmed_admin"
  | "order_status_update_customer"
  | "ebook_delivered_customer"
  | "ebook_sold_admin"
  | "booking_confirmed_customer"
  | "booking_confirmed_admin";

export const TRANSACTIONAL_WHATSAPP_EVENTS: TransactionalWhatsappEvent[] = [
  "invitation_registration_confirmed",
  "order_confirmed_customer",
  "order_confirmed_admin",
  "order_status_update_customer",
  "ebook_delivered_customer",
  "ebook_sold_admin",
  "booking_confirmed_customer",
  "booking_confirmed_admin",
];

// Template name in MSG91 is identical to the event name — one event, one
// template, no fan-out — so no separate mapping table is needed.

export interface TransactionalWhatsappData {
  // invitation_registration_confirmed
  firstName?: string;
  topicTitle?: string;

  // order_confirmed_customer / order_confirmed_admin / order_status_update_customer
  customerName?: string;
  customerPhone?: string;
  orderNumber?: string;
  /**
   * Pre-formatted "Name x2 (₹998.00), Name x1 (₹299.00)" line, built by the
   * caller (Pratipal Website's formatOrderItemsForWhatsapp()) — must not
   * contain newlines/tabs or 4+ consecutive spaces, which Meta's Cloud API
   * rejects in template parameter values. Kept pre-formatted here rather
   * than built from a raw items array since the number of {{n}} slots in an
   * approved template is fixed — a variable-length item list has to be
   * flattened into one string, not one variable per item.
   */
  itemsSummary?: string;
  total?: number;
  trackingStatusLabel?: string;

  // ebook_delivered_customer
  productName?: string;
  /** OrderItem._id — used as the download-button dynamic URL suffix, not shown in the body. */
  orderItemId?: string;

  // ebook_sold_admin — "{productName} — Order {orderNumber}" / "{customerName} ({customerEmail})".
  // Combined into single variables (rather than 5 separate ones) because Meta
  // rejects templates with too many variables relative to the surrounding
  // static text ("too many variables for its length") — see the note above
  // buildTransactionalWhatsappParams().
  orderSummary?: string;
  buyerSummary?: string;

  // booking_confirmed_customer / booking_confirmed_admin
  sessionTypeLabel?: string;
  /** "Booking #{bookingNumber} — {serviceName} ({frequencyLabel} plan)" — same variable-consolidation reason as above. */
  bookingSummary?: string;
  /** admin only: "{customerName} ({customerPhone})" */
  customerSummary?: string;
  amount?: number;
}

function money(n?: number): string {
  return (n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Builds the exact body_N values (in order) + button URL suffix for a given approved transactional template. */
export function buildTransactionalWhatsappParams(
  event: TransactionalWhatsappEvent,
  data: TransactionalWhatsappData
): { bodyParams: string[]; buttonUrlSuffix?: string } {
  switch (event) {
    case "invitation_registration_confirmed":
      // Body: "Hi {{1}}, thanks for registering for *{{2}}*! We've received
      // your details and will reach out here on WhatsApp with everything
      // you need to know. If you have any questions, feel free to reply to
      // this message."
      return { bodyParams: [data.firstName || "there", data.topicTitle || "your session"] };

    case "order_confirmed_customer":
      // Body: "Hi {{1}}, your order *{{2}}* has been confirmed! Items:
      // {{3}}. Total paid: *₹{{4}}*. Tap below to track your order status
      // anytime."
      // Button: URL, dynamic suffix -> /track/<orderNumber>
      // All orders are prepaid (Razorpay only, no COD) — no payment-method
      // variable needed.
      return {
        bodyParams: [
          data.customerName || "there",
          data.orderNumber || "",
          data.itemsSummary || "—",
          money(data.total),
        ],
        buttonUrlSuffix: data.orderNumber,
      };

    case "order_confirmed_admin":
      // Body: "New order *{{1}}* received from {{2}} ({{3}}). Items:
      // {{4}}. Total: *₹{{5}}* (paid). Please review and process it in the
      // admin dashboard."
      return {
        bodyParams: [
          data.orderNumber || "",
          data.customerName || "",
          data.customerPhone || "—",
          data.itemsSummary || "—",
          money(data.total),
        ],
      };

    case "order_status_update_customer":
      // Body: "Hi {{1}}, your order *{{2}}* status has been updated to
      // *{{3}}*. Tap below for full tracking details."
      // Button: URL, dynamic suffix -> /track/<orderNumber>
      return {
        bodyParams: [data.customerName || "there", data.orderNumber || "", data.trackingStatusLabel || ""],
        buttonUrlSuffix: data.orderNumber,
      };

    case "ebook_delivered_customer":
      // Body: "Hi {{1}}, your e-book *{{2}}* from order *{{3}}* is ready!
      // Tap the button below to download your copy."
      // Button: URL, dynamic suffix -> /api/download/<orderItemId>
      return {
        bodyParams: [data.customerName || "there", data.productName || "", data.orderNumber || ""],
        buttonUrlSuffix: data.orderItemId,
      };

    case "ebook_sold_admin":
      // Body: "An e-book purchase has been completed on Pratipal. Product
      // & order: {{1}}. Buyer: {{2}}. Amount paid: *₹{{3}}*. You can view
      // the full order details in the admin dashboard."
      return {
        bodyParams: [
          data.orderSummary || "",
          data.buyerSummary || "",
          money(data.amount ?? data.total),
        ],
      };

    case "booking_confirmed_customer":
      // Body: "Hi {{1}}, great news — your {{2}} booking with Pratipal is
      // confirmed! {{3}}. Amount paid: *₹{{4}}*. Our team will reach out to
      // you here on WhatsApp shortly to schedule your session. Thank you
      // for choosing us."
      return {
        bodyParams: [
          data.customerName || "there",
          data.sessionTypeLabel || "Session",
          data.bookingSummary || "",
          money(data.amount),
        ],
      };

    case "booking_confirmed_admin":
      // Body: "A new {{1}} booking has been received on Pratipal. {{2}}.
      // Customer: {{3}}. Amount paid: *₹{{4}}*. Please reach out to the
      // customer to schedule their session and update the booking status
      // in the admin dashboard."
      return {
        bodyParams: [
          data.sessionTypeLabel || "Session",
          data.bookingSummary || "",
          data.customerSummary || "",
          money(data.amount),
        ],
      };

    default:
      return { bodyParams: [] };
  }
}
