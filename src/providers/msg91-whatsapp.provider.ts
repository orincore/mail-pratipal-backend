import { config } from "../config";

// MSG91 WhatsApp Cloud API — template message send.
// Request/response shape per https://docs.msg91.com/whatsapp/template-bulk
// (single-recipient send using the bulk endpoint's to_and_components array
// with one entry). Verify against the live MSG91 dashboard/Postman
// collection before going to production — field names below are correct per
// MSG91's public docs but the exact response envelope isn't publicly
// documented and is treated defensively here.
const MSG91_WHATSAPP_ENDPOINT = "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";

export interface SendWhatsappTemplateOptions {
  /** E.164 phone number, e.g. +919876543210 */
  to: string;
  /** Must exactly match an MSG91-approved template name */
  templateName: string;
  /** Mapped in order to body_1, body_2, ... in the template's components */
  bodyParams: string[];
  /** Mapped to button_1 (subtype: url) — the dynamic suffix appended to the template's static base URL */
  buttonUrlSuffix?: string;
}

export interface SendWhatsappResult {
  success: boolean;
  messageId?: string;
  raw: any;
}

// MSG91 wants country-code + digits only (their own example: 91xxxxxxxxxx) —
// no "+", spaces, or dashes. Strip defensively so a stray "+"/formatting in
// env vars or a registrant's saved number never silently breaks a send.
function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, "");
}

export async function sendWhatsappTemplate(opts: SendWhatsappTemplateOptions): Promise<SendWhatsappResult> {
  const { authKey, integratedNumber, namespace, languageCode } = config.whatsapp.msg91;
  if (!authKey || !integratedNumber) {
    throw new Error("MSG91 WhatsApp is not configured (set MSG91_AUTH_KEY and MSG91_WHATSAPP_INTEGRATED_NUMBER)");
  }

  const components: Record<string, any> = {};
  opts.bodyParams.forEach((value, i) => {
    components[`body_${i + 1}`] = { type: "text", value };
  });
  if (opts.buttonUrlSuffix) {
    components.button_1 = { subtype: "url", type: "text", value: opts.buttonUrlSuffix };
  }

  const body = {
    integrated_number: digitsOnly(integratedNumber),
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: opts.templateName,
        language: { code: languageCode, policy: "deterministic" },
        ...(namespace ? { namespace } : {}),
        to_and_components: [
          {
            to: [digitsOnly(opts.to)],
            components,
          },
        ],
      },
    },
  };

  const res = await fetch(MSG91_WHATSAPP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authkey: authKey,
    },
    body: JSON.stringify(body),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // MSG91's actual error shape is { status, hasError, errors, code, apiError }
    // — "errors" (plural), not "error"/"message". Surface all of it so e.g. a
    // 418 (IP not whitelisted for this authkey) is visible instead of a bare
    // "HTTP 401"/"HTTP 400".
    const detail = json?.errors || json?.error || json?.message;
    const apiErrorNote = json?.apiError ? ` [apiError ${json.apiError}]` : "";
    throw new Error(
      detail
        ? `MSG91 WhatsApp send failed: ${JSON.stringify(detail)}${apiErrorNote} (HTTP ${res.status})`
        : `MSG91 WhatsApp send failed (HTTP ${res.status}): ${JSON.stringify(json)}`
    );
  }

  return {
    success: true,
    messageId: json?.data?.[0]?.message_id ?? json?.request_id ?? undefined,
    raw: json,
  };
}
