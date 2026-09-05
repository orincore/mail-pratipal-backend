import { config } from "../config";
import { WHATSAPP_TEMPLATES, WhatsappTemplateDef } from "./whatsapp-templates";

/**
 * The admin UI's WhatsApp template list, kept in sync with MSG91.
 *
 * The local registry (whatsapp-templates.ts) stays the source of truth for
 * *variable mapping* — an approved template is only sendable automatically
 * when the code knows which body_N params it takes. The remote MSG91 list is
 * merged in so:
 *  - locally-known templates display their live approval status
 *  - templates approved in MSG91 but unknown to the code show up flagged
 *    `supported: false` (visible, not selectable as a one-click preset) —
 *    but `remote` below carries their real approved components, so the admin
 *    UI can still render an accurate preview and ask for exactly the right
 *    number of variables instead of guessing or requiring a manual paste.
 */
export interface WhatsappTemplateButton {
  type: string;
  text: string;
  /** Present for URL buttons — may itself contain a {{1}} placeholder. */
  url?: string;
  /** True when `url` has a {{n}} placeholder MSG91 expects a value for at send time. */
  needsParam: boolean;
}

export interface RemoteWhatsappTemplateContent {
  header?: string;
  /** Literal approved body text, {{1}}/{{2}}/... placeholders exactly as MSG91 has them. */
  body: string;
  footer?: string;
  buttons: WhatsappTemplateButton[];
  /** Count of distinct {{n}} placeholders in `body` — how many whatsapp_variables a send needs. */
  bodyVariableCount: number;
}

export interface MergedWhatsappTemplate extends Omit<WhatsappTemplateDef, "name"> {
  name: string;
  remote_status?: string;
  /** Only supported templates have a hardcoded param mapping for automatic sends. */
  supported: boolean;
  /** The real approved components, fetched live from MSG91 — see docs above. */
  remote?: RemoteWhatsappTemplateContent;
}

interface RemoteTemplate {
  name: string;
  status?: string;
  content?: RemoteWhatsappTemplateContent;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; templates: MergedWhatsappTemplate[] } | null = null;

function countBodyVariables(body: string): number {
  const ids = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) ids.add(m[1]);
  return ids.size;
}

// Per https://docs.msg91.com/whatsapp/get-templates — a completely different
// host and path from what this used to hit (api.msg91.com/.../whatsapp-template/
// is not this endpoint at all, which is why remote sync silently always fell
// back to the local registry). Real endpoint: GET
// control.msg91.com/api/v5/whatsapp/get-template-client/:number, :number
// being the digits-only integrated WhatsApp number as a path segment, not a
// query param. Omitting template_name/template_status/template_language/
// pagination entirely (rather than passing them empty) gets the full
// non-paginated list per the docs ("if any one of the parameters is missing
// or passed as an empty string, the API response will return non-paginated
// data") — capped at 500 templates, far more than this app will ever have.
//
// Each row's real approved content (header/body/footer/buttons) lives under
// `languages[].code[]` as a list of components ({type, text}/{type, buttons}),
// NOT flat on the row — confirmed by hitting the live endpoint (MSG91's own
// docs give no real response example, just a literal "{}").
async function fetchRemoteTemplates(): Promise<RemoteTemplate[]> {
  const { authKey, integratedNumber, languageCode } = config.whatsapp.msg91;
  if (!authKey || !integratedNumber) return [];

  const digits = integratedNumber.replace(/[^\d]/g, "");
  const res = await fetch(
    `https://control.msg91.com/api/v5/whatsapp/get-template-client/${digits}`,
    {
      headers: {
        accept: "application/json",
        authkey: authKey,
        // Documented header for this GET, despite there being no body — MSG91's
        // own curl example sends it, so matching it rather than guessing it's safe to drop.
        "content-type": "text/plain",
      },
    }
  );
  if (!res.ok) {
    throw new Error(`MSG91 template list fetch failed (HTTP ${res.status})`);
  }

  const json: any = await res.json().catch(() => ({}));
  // MSG91's docs give no real example of the response body (their own sample
  // is a literal "{}") — accept the shapes seen in practice ({ data: [...] },
  // { templates: [...] }, or a bare array) and ignore anything unrecognized
  // rather than throwing, since a shape mismatch here must degrade to the
  // local registry, not break the admin UI.
  const rows: any[] = Array.isArray(json)
    ? json
    : Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.templates)
    ? json.templates
    : [];

  return rows
    .map((row) => {
      const name = String(row?.name || row?.template_name || "").trim();
      // Approval status AND the real components both live per-language under
      // `languages[]`, not on the template row itself. Prefer the language
      // this app actually sends in; fall back to the first entry if absent.
      const languages: any[] = Array.isArray(row?.languages) ? row.languages : [];
      const lang = languages.find((l) => l?.language === languageCode) || languages[0];
      const status = lang?.status || row?.status || row?.template_status;

      const components: any[] = Array.isArray(lang?.code) ? lang.code : [];
      const headerComp = components.find((c) => c?.type === "HEADER" && c?.format === "TEXT");
      const bodyComp = components.find((c) => c?.type === "BODY");
      const footerComp = components.find((c) => c?.type === "FOOTER");
      const buttonsComp = components.find((c) => c?.type === "BUTTONS");
      const buttons: WhatsappTemplateButton[] = Array.isArray(buttonsComp?.buttons)
        ? buttonsComp.buttons.map((b: any) => ({
            type: String(b?.type || "URL"),
            text: String(b?.text || ""),
            url: typeof b?.url === "string" ? b.url : undefined,
            needsParam: typeof b?.url === "string" && /\{\{\s*\d+\s*\}\}/.test(b.url),
          }))
        : [];

      const bodyText = typeof bodyComp?.text === "string" ? bodyComp.text : undefined;
      const content: RemoteWhatsappTemplateContent | undefined = bodyText
        ? {
            header: typeof headerComp?.text === "string" ? headerComp.text : undefined,
            body: bodyText,
            footer: typeof footerComp?.text === "string" ? footerComp.text : undefined,
            buttons,
            bodyVariableCount: countBodyVariables(bodyText),
          }
        : undefined;

      return { name, status: status ? String(status) : undefined, content };
    })
    .filter((row) => row.name.length > 0);
}

export async function getMergedWhatsappTemplates(forceRefresh = false): Promise<MergedWhatsappTemplate[]> {
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.templates;
  }

  const merged: MergedWhatsappTemplate[] = WHATSAPP_TEMPLATES.map((t) => ({ ...t, supported: true }));

  try {
    const remote = await fetchRemoteTemplates();
    if (remote.length > 0) {
      const remoteByName = new Map(remote.map((r) => [r.name, r]));

      for (const template of merged) {
        const live = remoteByName.get(template.name);
        if (live) {
          template.remote_status = live.status;
          // A live-fetched body is the real approved copy — prefer it over
          // the hardcoded `body` string above even for local templates, so
          // this stays correct if MSG91's copy is ever edited without a code
          // change to match.
          if (live.content) template.remote = live.content;
        }
      }

      for (const live of remote) {
        const isApproved = (live.status || "").toLowerCase() === "approved";
        if (isApproved && !merged.some((t) => t.name === live.name)) {
          merged.push({
            name: live.name,
            label: live.name,
            description:
              "Approved in MSG91 but not one of this app's built-in presets — its variables are read directly from the approved template below.",
            hasButton: (live.content?.buttons.length || 0) > 0,
            remote_status: live.status,
            supported: false,
            remote: live.content,
          });
        }
      }
    }
  } catch (err: any) {
    // MSG91 being unreachable must never break the admin UI — fall back to
    // the local registry silently (it is always sendable).
    console.warn("WhatsApp template sync failed, using local registry:", err.message);
  }

  cache = { at: Date.now(), templates: merged };
  return merged;
}
