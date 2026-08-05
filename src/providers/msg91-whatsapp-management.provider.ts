import { config } from "../config";

// MSG91 WhatsApp template lifecycle (create/update/delete), analytics, logs,
// and session-message sending — distinct from msg91-whatsapp.provider.ts,
// which only handles the outbound *template message* send used by
// campaigns/reminders. These are account-management operations: creating a
// template submits it to Meta for review, deleting removes it from the
// account, and sendSessionMessage only succeeds inside an active 24h
// customer-service window (the recipient must have messaged the integrated
// number first) — none of that overlaps with the template-send path.

// create-template lives on api.msg91.com; everything else here (including
// update, despite being the same logical resource) is documented on
// control.msg91.com. Matches MSG91's own examples exactly — not a typo.
const CREATE_TEMPLATE_URL = "https://api.msg91.com/api/v5/whatsapp/client-panel-template/";
const UPDATE_TEMPLATE_URL = (templateId: string) =>
  `https://control.msg91.com/api/v5/whatsapp/client-panel-template/${encodeURIComponent(templateId)}/`;
const DELETE_TEMPLATE_URL = "https://control.msg91.com/api/v5/whatsapp/client-panel-template/";
const ANALYTICS_URL = "https://control.msg91.com/api/v5/report/analytics/p/wa/";
const SESSION_MESSAGE_URL = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/";
const LOGS_URL = "https://control.msg91.com/api/v5/report/logs/wa";
const LIST_TEMPLATES_URL = (integratedNumber: string) =>
  `https://control.msg91.com/api/v5/whatsapp/get-template-client/${integratedNumber}`;

function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function requireMsg91Config(): { authKey: string; integratedNumber: string } {
  const { authKey, integratedNumber } = config.whatsapp.msg91;
  if (!authKey || !integratedNumber) {
    throw new Error("MSG91 WhatsApp is not configured (set MSG91_AUTH_KEY and MSG91_WHATSAPP_INTEGRATED_NUMBER)");
  }
  return { authKey, integratedNumber };
}

/** MSG91's error envelope is inconsistent across these endpoints (errors/error/message, varying casing) — normalize into one Error with the raw body attached for callers that need it. */
async function raiseForStatus(res: Response, action: string): Promise<any> {
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.errors || json?.error || json?.message;
    const err = new Error(
      detail
        ? `MSG91 ${action} failed: ${JSON.stringify(detail)} (HTTP ${res.status})`
        : `MSG91 ${action} failed (HTTP ${res.status}): ${JSON.stringify(json)}`
    );
    (err as any).httpStatus = res.status;
    (err as any).raw = json;
    throw err;
  }
  return json;
}

export interface WhatsappTemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  text?: string;
  example?: Record<string, any>;
  buttons?: Array<{
    type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
    text: string;
    url?: string;
    phone_number?: string;
    example?: string[];
  }>;
}

export interface CreateWhatsappTemplateOptions {
  templateName: string;
  language: string;
  category: string;
  components: WhatsappTemplateComponent[];
  buttonUrl?: boolean;
}

export async function createWhatsappTemplate(opts: CreateWhatsappTemplateOptions): Promise<any> {
  const { authKey, integratedNumber } = requireMsg91Config();

  const res = await fetch(CREATE_TEMPLATE_URL, {
    method: "POST",
    headers: { authkey: authKey, "content-type": "application/json" },
    body: JSON.stringify({
      integrated_number: digitsOnly(integratedNumber),
      template_name: opts.templateName,
      language: opts.language,
      category: opts.category,
      button_url: opts.buttonUrl ?? false,
      components: opts.components,
    }),
  });

  return raiseForStatus(res, "template create");
}

export interface UpdateWhatsappTemplateOptions {
  templateId: string;
  components: WhatsappTemplateComponent[];
  buttonUrl?: boolean;
}

export async function updateWhatsappTemplate(opts: UpdateWhatsappTemplateOptions): Promise<any> {
  const { authKey, integratedNumber } = requireMsg91Config();

  const res = await fetch(UPDATE_TEMPLATE_URL(opts.templateId), {
    method: "PUT",
    headers: { authkey: authKey, "content-type": "application/json" },
    body: JSON.stringify({
      integrated_number: digitsOnly(integratedNumber),
      components: opts.components,
      button_url: opts.buttonUrl ?? false,
    }),
  });

  return raiseForStatus(res, "template update");
}

export async function deleteWhatsappTemplate(templateName: string): Promise<any> {
  const { authKey, integratedNumber } = requireMsg91Config();

  const url = new URL(DELETE_TEMPLATE_URL);
  url.searchParams.set("integrated_number", digitsOnly(integratedNumber));
  url.searchParams.set("template_name", templateName);

  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { authkey: authKey, "content-type": "application/json" },
  });

  return raiseForStatus(res, "template delete");
}

export async function getWhatsappAnalytics(startDate: string, endDate: string): Promise<any> {
  const { authKey } = requireMsg91Config();

  const url = new URL(ANALYTICS_URL);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json", Authkey: authKey },
  });

  return raiseForStatus(res, "analytics fetch");
}

export interface SendWhatsappSessionMessageOptions {
  /** Digits-only recipient number, country code + number, e.g. 919876543210 */
  to: string;
  contentType: string;
  text: string;
}

/**
 * Free-form (non-template) send inside an active 24h customer-service
 * session — only deliverable if the recipient has messaged the integrated
 * number within the last 24 hours. Outside that window Meta/MSG91 reject it
 * regardless of payload correctness; that's an account/session state issue,
 * not a bug here.
 */
export async function sendWhatsappSessionMessage(opts: SendWhatsappSessionMessageOptions): Promise<any> {
  const { authKey, integratedNumber } = requireMsg91Config();

  const url = new URL(SESSION_MESSAGE_URL);
  url.searchParams.set("integrated_number", digitsOnly(integratedNumber));
  url.searchParams.set("recipient_number", digitsOnly(opts.to));
  url.searchParams.set("content_type", opts.contentType);
  url.searchParams.set("text", opts.text);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { accept: "application/json", authkey: authKey, "content-type": "application/json" },
  });

  return raiseForStatus(res, "session message send");
}

export async function getWhatsappLogs(startDate: string, endDate: string): Promise<any> {
  const { authKey } = requireMsg91Config();

  const url = new URL(LOGS_URL);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { accept: "application/json", authkey: authKey },
  });

  return raiseForStatus(res, "logs fetch");
}

/**
 * Full-detail template list for the management UI — template_id (needed for
 * update), current approval status, category, and components/body content
 * (to prefill an edit form). Deliberately separate from
 * whatsapp-template-sync.ts's fetchRemoteTemplates(), which only extracts
 * name+status for the campaign/reminder picker and throws away everything
 * else this UI needs.
 */
export async function listWhatsappTemplates(): Promise<any[]> {
  const { authKey, integratedNumber } = requireMsg91Config();

  const res = await fetch(LIST_TEMPLATES_URL(digitsOnly(integratedNumber)), {
    method: "GET",
    headers: { accept: "application/json", authkey: authKey, "content-type": "text/plain" },
  });

  const json = await raiseForStatus(res, "template list fetch");
  return Array.isArray(json?.data) ? json.data : [];
}
