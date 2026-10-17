import "server-only";
import { createHmac } from "node:crypto";
import { readSecret } from "./secrets";

/* ---------------------------------------------------------------------------
 * The one place MahekOne talks to Wati.
 *
 * Wati's v3 API (`/api/ext/v3/...`) with a Bearer token. v3 rather than the
 * legacy `/{tenantId}/api/v1/...` because the scoped `wati_…` keys Mahek holds
 * are v3 keys — the tenant is inside the key, not in the path.
 *
 * NOTHING IN THIS FILE DECIDES WHETHER TO SEND. It sends when asked. Whether a
 * message may go at all — the founder's switch, the approved template, the
 * number, the weekly limit — is `whatsapp-service.ts`'s question, asked before
 * this is ever called. A client that also checked would be a second answer to
 * the same question, and the two would disagree the first time one changed.
 * ------------------------------------------------------------------------- */

const DEFAULT_BASE = "https://live-mt-server.wati.io";
const TIMEOUT_MS = 15_000;

/**
 * Mahek's Wati ACCOUNT, for the v1 endpoints that are addressed by it. An id
 * names an account; it does not open one — the key does, and stays a secret —
 * so it is written here like the HR workbook's id, with `WATI_TENANT_ID` to
 * point a staging deploy at another account.
 */
const WATI_TENANT = process.env.WATI_TENANT_ID?.trim() || "10225208";

export type WatiConfig = { base: string; token: string };

export async function watiConfig(): Promise<WatiConfig | null> {
  const token = await readSecret("wati.apiToken");
  if (!token) return null;
  const base = (process.env.WATI_API_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
  return { base, token };
}

type Call<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; error: string };

async function call<T>(
  cfg: WatiConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Call<T>> {
  let res: Response;
  try {
    res = await fetch(`${cfg.base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      status: null,
      error: e instanceof Error && e.name === "TimeoutError" ? "Wati did not answer in time." : "Wati could not be reached.",
    };
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body is reported as text below */
  }

  if (!res.ok) {
    const j = json as { message?: string; error?: { message?: string } | string; info?: string } | null;
    const detail =
      (typeof j?.error === "object" ? j.error?.message : j?.error) ??
      j?.message ??
      j?.info ??
      text.slice(0, 200);
    const why =
      res.status === 401 || res.status === 403
        ? `Wati refused the key (${res.status}). It may be revoked, or lack the permission this needs.`
        : res.status === 429
          ? "Wati is rate-limiting us. Try again in a minute."
          : `Wati answered ${res.status}${detail ? `: ${detail}` : ""}`;
    return { ok: false, status: res.status, error: why };
  }
  return { ok: true, data: json as T };
}

/* ------------------------------------------------------------ their files */

export type WatiFile =
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; status: number | null; error: string };

/**
 * A file a customer sent, read from Wati by its path (`data/images/….jpg`).
 *
 * The path must be one `watiMediaPath` accepted — it is checked again here,
 * because this is the call that would fetch whatever it was handed. Nothing is
 * stored: the bytes go straight to the person who asked, so a payment slip
 * lives in one place, Wati's, and MahekOne is only ever the door to it.
 */
export async function fetchWatiMedia(path: string): Promise<WatiFile> {
  if (!/^data\/[a-z]+\/[A-Za-z0-9._-]+$/.test(path) || path.includes("..")) {
    return { ok: false, status: 400, error: "Not a Wati file path." };
  }
  const cfg = await watiConfig();
  if (!cfg) return { ok: false, status: null, error: "No Wati key is configured." };
  let res: Response;
  try {
    res = await fetch(`${cfg.base}/${WATI_TENANT}/api/v1/getMedia?fileName=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: null, error: "Wati could not be reached." };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `Wati answered ${res.status}.` };
  return {
    ok: true,
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/* -------------------------------------------------------------- templates */

export type WatiTemplate = {
  id: string;
  name: string;
  status: string;
  category: string | null;
  language: string | null;
  body: string;
  /** The variable names the body uses, in Wati's own spelling. */
  params: string[];
};

type RawTemplate = {
  id?: string;
  elementName?: string;
  name?: string;
  status?: string;
  category?: string;
  language_option?: { key?: string; value?: string } | string | null;
  language?: { key?: string; value?: string } | string | null;
  body?: string;
  body_original?: string;
  bodyOriginal?: string;
  hsm?: string;
  custom_params?: Array<{ name?: string; paramName?: string }> | null;
  customParams?: Array<{ name?: string; paramName?: string }> | null;
};

function readTemplate(t: RawTemplate): WatiTemplate | null {
  const name = t.name ?? t.elementName;
  if (!name) return null;
  const body = t.body_original ?? t.bodyOriginal ?? t.body ?? t.hsm ?? "";
  // The parameter list is the authority where Wati sends one; the body is read
  // as well, because a template made in the dashboard does not always carry it.
  const fromList = (t.custom_params ?? t.customParams ?? [])
    .map((p) => p.name ?? p.paramName)
    .filter((n): n is string => Boolean(n));
  const fromBody = [...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  const lang = t.language_option ?? t.language ?? null;
  return {
    id: t.id ?? name,
    name,
    status: (t.status ?? "").toUpperCase(),
    category: t.category ?? null,
    language: typeof lang === "string" ? lang : (lang?.key ?? lang?.value ?? null),
    body,
    params: [...new Set([...fromList, ...fromBody])],
  };
}

let templateCache: { at: number; list: WatiTemplate[] } | null = null;
const TEMPLATE_CACHE_MS = 60_000;

/**
 * Every template in the Wati account, approved or not.
 *
 * Cached for a minute: a bulk run of forty customers must not be forty template
 * listings, and a template approved a minute ago can wait a minute. `fresh`
 * skips it, for the founder's screen, which is where somebody has just gone and
 * approved one and is looking for it.
 */
export async function listWatiTemplates(
  opts: { fresh?: boolean } = {},
): Promise<{ ok: true; templates: WatiTemplate[] } | { ok: false; error: string }> {
  if (!opts.fresh && templateCache && Date.now() - templateCache.at < TEMPLATE_CACHE_MS) {
    return { ok: true, templates: templateCache.list };
  }
  const cfg = await watiConfig();
  if (!cfg) return { ok: false, error: "No Wati key is configured." };

  const list: WatiTemplate[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await call<{ templates?: RawTemplate[]; total?: number }>(
      cfg,
      `/api/ext/v3/messageTemplates?page_number=${page}&page_size=100`,
    );
    if (!r.ok) return { ok: false, error: r.error };
    const rows = r.data?.templates ?? [];
    for (const raw of rows) {
      const t = readTemplate(raw);
      if (t) list.push(t);
    }
    if (rows.length < 100 || list.length >= (r.data?.total ?? 0)) break;
  }
  templateCache = { at: Date.now(), list };
  return { ok: true, templates: list };
}

export const isApproved = (t: WatiTemplate) => t.status === "APPROVED";

/* ------------------------------------------------------------------ send */

export type SendResult =
  | { ok: true; broadcastId: string | null }
  | { ok: false; error: string; /** true when we cannot tell whether it went */ uncertain: boolean };

/**
 * One template to one number. `localMessageId` is our `wa_messages.id`, and it
 * is what every delivery webhook Wati sends back afterwards is keyed on.
 */
export async function sendWatiTemplate(input: {
  templateName: string;
  phone: string;
  params: Array<{ name: string; value: string }>;
  localMessageId: string;
  broadcastName: string;
}): Promise<SendResult> {
  const cfg = await watiConfig();
  if (!cfg) return { ok: false, error: "No Wati key is configured.", uncertain: false };

  const r = await call<{
    success?: boolean;
    broadcast_id?: string | null;
    error?: string | null;
    recipients?: Array<{ local_message_id?: string; errors?: string[] | null }> | null;
  }>(cfg, "/api/ext/v3/messageTemplates/send", {
    method: "POST",
    body: {
      template_name: input.templateName,
      broadcast_name: input.broadcastName,
      recipients: [
        {
          phone_number: input.phone,
          local_message_id: input.localMessageId,
          custom_params: input.params,
        },
      ],
    },
  });

  // No answer at all is the one case where we genuinely do not know: the
  // request may have reached Wati and the answer been lost on the way back.
  if (!r.ok) return { ok: false, error: r.error, uncertain: r.status === null };

  const recipientErrors = (r.data?.recipients ?? []).flatMap((x) => x.errors ?? []);
  if (r.data?.success === false || recipientErrors.length) {
    return {
      ok: false,
      error: recipientErrors[0] ?? r.data?.error ?? "Wati did not accept the message.",
      uncertain: false,
    };
  }
  return { ok: true, broadcastId: r.data?.broadcast_id ?? null };
}

/**
 * A free-text WhatsApp message — a SESSION message — to one number.
 *
 * Only possible inside the 24 hours after the customer last wrote to us;
 * outside it WhatsApp accepts nothing but an approved template, and the caller
 * checks that window before calling here (Wati would refuse it anyway, but
 * after the person had typed it). Wati's answer carries WhatsApp's id for the
 * message under one of a few names depending on the version; whichever is
 * there is returned, because the delivery webhooks for a session message are
 * matched on it — they carry no id of ours.
 */
export async function sendWatiText(input: {
  phone: string;
  text: string;
}): Promise<{ ok: true; providerRef: string | null } | { ok: false; error: string; uncertain: boolean }> {
  const cfg = await watiConfig();
  if (!cfg) return { ok: false, error: "No Wati key is configured.", uncertain: false };
  const r = await call<Record<string, unknown> | null>(cfg, "/api/ext/v3/conversations/messages/text", {
    method: "POST",
    body: { target: input.phone, text: input.text },
  });
  if (!r.ok) return { ok: false, error: r.error, uncertain: r.status === null };
  const d = (r.data ?? {}) as Record<string, unknown>;
  if (d.result === false || d.success === false) {
    const why = typeof d.info === "string" ? d.info : typeof d.message === "string" ? d.message : null;
    return { ok: false, error: why ?? "Wati did not accept the message.", uncertain: false };
  }
  const inner = (typeof d.message === "object" && d.message ? d.message : d) as Record<string, unknown>;
  const ref = [inner.whatsappMessageId, inner.whatsapp_message_id, inner.message_id, inner.id, d.id].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return { ok: true, providerRef: ref ?? null };
}

/* -------------------------------------------- reading back what happened */


export type WatiContact = { waId: string; name: string | null; lastUpdated: string | null };

/** Every contact the business number has, a page at a time. */
export async function listWatiContacts(): Promise<{ ok: true; contacts: WatiContact[] } | { ok: false; error: string }> {
  const cfg = await watiConfig();
  if (!cfg) return { ok: false, error: "No Wati key is configured." };
  const out: WatiContact[] = [];
  for (let page = 1; page <= 100; page++) {
    const r = await call<{ contact_list?: Array<{ wa_id?: string; name?: string; last_updated?: string }> }>(
      cfg,
      `/api/ext/v3/contacts?page_size=100&page_number=${page}`,
    );
    if (!r.ok) return { ok: false, error: r.error };
    const list = r.data?.contact_list ?? [];
    for (const c of list) {
      if (c.wa_id) out.push({ waId: c.wa_id, name: c.name?.trim() || null, lastUpdated: c.last_updated ?? null });
    }
    if (list.length < 100) break;
  }
  return { ok: true, contacts: out };
}

/** One item of a conversation as Wati's v1 history returns it — only what we read. */
export type WatiHistoryItem = {
  id: string;
  eventType: string;
  /** False: the customer wrote it. True: we did (an agent in Wati, or MahekOne). */
  owner?: boolean;
  type?: string;
  text?: string | null;
  created: string;
  /** WhatsApp's own id — the same one the webhook files a reply under. */
  whatsappMessageId?: string | null;
  /** Wati's path to the file, where the message is a photograph, a PDF, a voice note. */
  data?: string | null;
  /** How far one of OURS got: SENT, DELIVERED, READ, FAILED. */
  statusString?: string | null;
  /** A template message's words as they went — `text` is empty on those. */
  finalText?: string | null;
};

/** A page of one number's conversation, newest first. */
export async function watiHistoryPage(
  waId: string,
  page: number,
  pageSize = 100,
): Promise<{ ok: true; items: WatiHistoryItem[] } | { ok: false; error: string }> {
  const cfg = await watiConfig();
  if (!cfg) return { ok: false, error: "No Wati key is configured." };
  const r = await call<{ messages?: { items?: WatiHistoryItem[] } }>(
    cfg,
    `/${WATI_TENANT}/api/v1/getMessages/${encodeURIComponent(waId)}?pageSize=${pageSize}&pageNumber=${page}`,
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, items: r.data?.messages?.items ?? [] };
}

/* ------------------------------------------------------ connection health */

export type WatiHealth =
  | { ok: true; channels: string[]; templates: number; approved: number }
  | { ok: false; error: string };

export async function watiHealth(): Promise<WatiHealth> {
  const cfg = await watiConfig();
  if (!cfg) return { ok: false, error: "No Wati key is configured." };
  const ch = await call<{ channels?: Array<{ name?: string; channel?: string }> }>(
    cfg,
    "/api/ext/v3/channels",
  );
  if (!ch.ok) return { ok: false, error: ch.error };
  const t = await listWatiTemplates({ fresh: true });
  if (!t.ok) return { ok: false, error: t.error };
  return {
    ok: true,
    channels: (ch.data?.channels ?? []).map((c) => `${c.channel ?? "?"} · ${c.name ?? "Default"}`),
    templates: t.templates.length,
    approved: t.templates.filter(isApproved).length,
  };
}

/* ------------------------------------------------------------- webhooks */

/**
 * The secret path segment Wati posts webhooks to.
 *
 * Wati's webhook settings take a URL and nothing else — no signing secret, no
 * header — so the URL itself is the credential. It is DERIVED from the API key
 * rather than stored: one less secret to keep, nothing to set up, and rotating
 * the key rotates the address with it, which is exactly what should happen to
 * an address anybody holding the old key could have worked out.
 */
export function webhookTokenFor(apiToken: string): string {
  return createHmac("sha256", apiToken).update("mahekone:wati:webhook").digest("hex").slice(0, 40);
}

export async function currentWebhookToken(): Promise<string | null> {
  const cfg = await watiConfig();
  return cfg ? webhookTokenFor(cfg.token) : null;
}
