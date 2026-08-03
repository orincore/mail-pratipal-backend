import { config } from "../config";
import { WHATSAPP_TEMPLATES, WhatsappTemplateDef } from "./whatsapp-templates";

/**
 * The admin UI's WhatsApp template list, kept in sync with MSG91.
 *
 * The local registry (whatsapp-templates.ts) stays the source of truth for
 * *variable mapping* — an approved template is only sendable when the code
 * knows which body_N params it takes. The remote MSG91 list is merged in so:
 *  - locally-known templates display their live approval status
 *  - templates approved in MSG91 but unknown to the code show up flagged
 *    `supported: false` (visible, not selectable) instead of being invisible
 */
export interface MergedWhatsappTemplate extends Omit<WhatsappTemplateDef, "name"> {
  name: string;
  remote_status?: string;
  /** Only supported templates have a param mapping and can actually be sent. */
  supported: boolean;
}

interface RemoteTemplate {
  name: string;
  status?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; templates: MergedWhatsappTemplate[] } | null = null;

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
async function fetchRemoteTemplates(): Promise<RemoteTemplate[]> {
  const { authKey, integratedNumber } = config.whatsapp.msg91;
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
    .map((row) => ({
      name: String(row?.name || row?.template_name || "").trim(),
      status: row?.status || row?.template_status ? String(row.status || row.template_status) : undefined,
    }))
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
        if (live) template.remote_status = live.status;
      }

      for (const live of remote) {
        const isApproved = (live.status || "").toLowerCase() === "approved";
        if (isApproved && !merged.some((t) => t.name === live.name)) {
          merged.push({
            name: live.name,
            label: live.name,
            description:
              "Approved in MSG91 but its variable mapping isn't configured in this app yet — add it to whatsapp-templates.ts to enable sending.",
            hasButton: false,
            remote_status: live.status,
            supported: false,
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
