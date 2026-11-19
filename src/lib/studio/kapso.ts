import "server-only";
import { readSecret } from "@/lib/secrets";

/* ---------------------------------------------------------------------------
 * KAPSO — the one place the Studio talks to it.
 *
 * Every call runs on the server with the project key, read for the request
 * that is about to spend it and never handed to a page. Nothing here retries
 * a send: a message is either accepted (and has an id) or it is not, and
 * sending twice is the one mistake this client must not make on its own.
 * ------------------------------------------------------------------------- */

const PLATFORM = "https://api.kapso.ai/platform/v1";
const META = "https://api.kapso.ai/meta/whatsapp/v24.0";
const TIMEOUT_MS = 15_000;

export type KapsoResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code: string | null };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** A test seam: only honoured under NODE_ENV=test, so nothing in production can redirect Kapso traffic. */
export function setKapsoFetch(f: FetchLike | null) {
  if (process.env.NODE_ENV !== "test") return;
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

export async function kapsoKeyHeld(): Promise<boolean> {
  return Boolean(await readSecret("kapso.apiKey"));
}

/** What a failed answer means, in words a person at a desk can act on. Never echoes a header or the key. */
function describe(status: number, body: unknown): { error: string; code: string | null } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : null;
  const message = typeof b.error === "string" ? b.error : typeof nested?.message === "string" ? nested.message : null;
  const code = typeof b.code === "string" ? b.code : nested?.code != null ? String(nested.code) : null;
  if (status === 401 || status === 403) return { error: "Kapso refused the key. Check the Kapso key in the Admin Console.", code };
  if (status === 402) return { error: "Kapso needs credit or a payment method before it will send. Nothing was sent.", code };
  if (status === 404) return { error: message ?? "Kapso could not find that number or conversation.", code };
  if (status === 409) return { error: message ?? "Kapso is already handling a message for this conversation. Try again in a moment.", code };
  if (status === 422) return { error: message ?? "WhatsApp would not accept that message.", code };
  if (status === 423) return { error: "Kapso has paused this project for review. Nothing was sent.", code };
  if (status === 429) return { error: "Kapso's request limit was reached. Wait a minute and try again.", code };
  return { error: message ?? `Kapso answered with an error (${status}).`, code };
}

async function call<T>(url: string, init: RequestInit): Promise<KapsoResult<T>> {
  const key = await readSecret("kapso.apiKey");
  if (!key) return { ok: false, status: 0, error: "The Kapso key is not set. Add it in the Admin Console under Integrations.", code: "no_key" };
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    return { ok: false, status: 0, error: "Could not reach Kapso. Check the connection and try again.", code: "unreachable" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) return { ok: false, status: res.status, ...describe(res.status, body) };
  return { ok: true, data: body as T };
}

const qs = (p: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

/* ------------------------------------------------------------------ numbers */

export type KapsoNumber = {
  phoneNumberId: string;
  name: string | null;
  displayPhone: string | null;
  /** Digits only, country code included. */
  digits: string;
  status: string | null;
  isCoexistence: boolean | null;
  /** Null for a SANDBOX number: Kapso documents `meta_app_id` as null for sandbox. A live number has one. */
  metaAppId: string | null;
  qualityRating: string | null;
};

type RawNumber = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v ? v : null);

export async function listNumbers(): Promise<KapsoResult<KapsoNumber[]>> {
  const out: KapsoNumber[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await call<{ data?: RawNumber[]; meta?: { total_pages?: number } }>(`${PLATFORM}/whatsapp/phone_numbers${qs({ per_page: 100, page })}`, { method: "GET" });
    if (!r.ok) return r;
    for (const n of r.data.data ?? []) {
      const id = s(n.phone_number_id) ?? s(n.id);
      if (!id) continue;
      out.push({
        phoneNumberId: id,
        name: s(n.name) ?? s(n.verified_name),
        displayPhone: s(n.display_phone_number),
        digits: (s(n.display_phone_number_normalized) ?? s(n.display_phone_number) ?? "").replace(/\D/g, ""),
        status: s(n.status),
        isCoexistence: typeof n.is_coexistence === "boolean" ? n.is_coexistence : null,
        metaAppId: s(n.meta_app_id),
        qualityRating: s(n.quality_rating),
      });
    }
    if (page >= (r.data.meta?.total_pages ?? 1)) break;
  }
  return { ok: true, data: out };
}

/* ------------------------------------------------------------ conversations */

export type RawPage = { data?: unknown[]; paging?: { cursors?: { after?: string | null }; next?: string | null } };

export function listConversations(phoneNumberId: string, opts: { limit?: number; after?: string } = {}) {
  return call<RawPage>(`${PLATFORM}/whatsapp/conversations${qs({ phone_number_id: phoneNumberId, limit: opts.limit ?? 50, after: opts.after })}`, { method: "GET" });
}

export function listMessages(phoneNumberId: string, conversationId: string, opts: { limit?: number; after?: string } = {}) {
  return call<RawPage>(`${PLATFORM}/whatsapp/messages${qs({ phone_number_id: phoneNumberId, conversation_id: conversationId, limit: opts.limit ?? 100, after: opts.after })}`, { method: "GET" });
}

/* ------------------------------------------------------------------ sending */

type SendAnswer = { messages?: { id?: string; message_status?: string }[] };

function wamidOf(a: SendAnswer): KapsoResult<{ wamid: string }> {
  const id = a.messages?.[0]?.id;
  return id ? { ok: true, data: { wamid: id } } : { ok: false, status: 0, error: "Kapso did not return a message id, so it is not known whether the message went. Check the conversation before sending again.", code: "no_id" };
}

export async function sendText(phoneNumberId: string, to: string, body: string): Promise<KapsoResult<{ wamid: string }>> {
  const r = await call<SendAnswer>(`${META}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body, preview_url: false } }),
  });
  return r.ok ? wamidOf(r.data) : r;
}

/** Uploads picture bytes to WhatsApp through Kapso, so a poster behind sign-in never needs a public link. */
export async function uploadImage(phoneNumberId: string, bytes: Uint8Array, filename: string, mime: string): Promise<KapsoResult<{ id: string }>> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
  const r = await call<{ id?: string }>(`${META}/${encodeURIComponent(phoneNumberId)}/media`, { method: "POST", body: form });
  if (!r.ok) return r;
  return r.data.id ? { ok: true, data: { id: r.data.id } } : { ok: false, status: 0, error: "Kapso did not accept the picture.", code: "no_media_id" };
}

export async function sendImage(phoneNumberId: string, to: string, mediaId: string, caption: string): Promise<KapsoResult<{ wamid: string }>> {
  const r = await call<SendAnswer>(`${META}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "image", image: caption ? { id: mediaId, caption } : { id: mediaId } }),
  });
  return r.ok ? wamidOf(r.data) : r;
}
