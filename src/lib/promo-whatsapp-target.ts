/* ---------------------------------------------------------------------------
 * The Promotional App's WhatsApp target: ONE lost lead's WhatsApp number, for ONE purpose.
 *
 * After a person presses "Open this lead's WhatsApp chat" in the Promotional App, and that app has checked its own sign-in and its
 * own single-use ticket, it asks this endpoint for the number so it can send the browser to the chat. Nothing is sent from here and
 * the app never sends anything: WhatsApp opens on the chat and the person presses send.
 *
 * The number is the most sensitive thing the feed could carry, so it is kept apart from everything else:
 *  - it is NOT a field of the feed (PROMO_FEED_FIELDS has none), and no list, facet, count or by-id answer can contain it;
 *  - it has its OWN secret (PROMO_WHATSAPP_TARGET_SECRET). A leak of the general feed secret cannot read a number, and the endpoint
 *    is closed (503) until that secret is set. It must differ from PROMO_FEED_SECRET or the endpoint refuses to answer;
 *  - one record per call, never a list; the number is withheld (null) for anything not eligible; at most RATE_LIMIT calls a minute;
 *  - it is read only at request time, from the database, and checked again then: a lead marked Do Not Contact a moment ago gets none.
 *
 * This file is PURE (no database, no framework) so all of it is tested without either. It is read-only end to end: GET only.
 * ------------------------------------------------------------------------- */

import { authorizePromoFeed } from "@/lib/promo-feed";

export const PROMO_WHATSAPP_CONTRACT = "promo-feed-v1";

/** The ONLY fields an answer may carry, in this order. Adding one is a contract change and breaks the contract test on purpose. */
export const PROMO_WHATSAPP_TARGET_FIELDS = ["id", "archived", "lost", "trashed", "dnc", "whatsappDnd", "whatsapp"] as const;

export type PromoWhatsappTarget = {
  id: string;
  /** A lead that is archived, or whose archived flag is not a clear `false`. */
  archived: boolean;
  /** A lead whose stage is `lost`. */
  lost: boolean;
  trashed: boolean;
  dnc: boolean;
  whatsappDnd: boolean;
  /** E.164 (`+` then 8 to 15 digits), or null: withheld, missing or not a usable number. Never a partial or guessed number. */
  whatsapp: string | null;
};

/** What the service reads for one record: flags and the two number columns, nothing else. */
export type PromoWhatsappRow = {
  id: string;
  kind: "lead" | "customer";
  leadStage: string | null;
  leadArchived: boolean | null;
  deletedAt: Date | string | null;
  doNotContact: boolean | null;
  whatsappDnd: boolean | null;
  whatsappPhone: string | null;
  phone: string | null;
};

/* ---- the phone number rule ---- */

/**
 * THE NORMALIZATION RULE (v1). A number is returned only if it can be written as E.164 without guessing a country:
 *
 *  1. Plain spaces, dots, dashes, parentheses and slashes are ignored: `+91 98765-43210` and `+91(98765)43210` are the same number.
 *     A tab, a line break or a non-breaking space inside the number is NOT a separator: it usually means two numbers or pasted text.
 *     (Spaces at either end are trimmed.)
 *  2. A leading `+` starts an international number. Everything after it must be ASCII digits: 8 to 15 of them, the first not 0.
 *  3. A leading `00` (the international call prefix) is the same as `+`: `0091 98765 43210` is `+919876543210`.
 *  4. Anything else is a LOCAL number and carries no country code, so it is NOT returned (`no_country_code`), whatever it looks like.
 *     In particular `919876543210` is not read as `+91...`: without a `+` there is no way to tell it from a local number.
 *  5. EXCEPT when the deployment names a default country on purpose (PROMO_WHATSAPP_DEFAULT_COUNTRY, off by default, set only by the
 *     owner). Then a local number is read as in that country, but only by a rule written down here for that country, and only a
 *     number of the right shape. Today the one country with a rule is India ("91"): ten digits starting 6, 7, 8 or 9, optionally with
 *     one leading `0`. A default country with no rule is ignored (and reported as `unsupported_default_country`): nothing is guessed.
 *  6. A number is never repaired, trimmed to fit, or completed. Letters, extensions, a second number in the same field, digits from
 *     other scripts, control characters and anything longer than 40 characters are refused.
 *
 * The default country applies ONLY to numbers that have no `+` / `00`. It never changes one that has its own country code.
 */
export const NATIONAL_NUMBER_RULES: Readonly<Record<string, RegExp>> = {
  // India: a mobile number is ten digits starting 6 to 9. One leading trunk 0 is allowed and dropped.
  "91": /^[6-9]\d{9}$/,
};

export type NormalizeOptions = { defaultCountry?: string | null | undefined };

export type NormalizeResult =
  | { ok: true; e164: string; via: "international" | "00-prefix" | "default-country" }
  | { ok: false; reason: "empty" | "invalid" | "no_country_code" | "unsupported_default_country" };

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_RAW = 40;

export function normalizeWhatsappNumber(raw: unknown, options: NormalizeOptions = {}): NormalizeResult {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  if (raw.length > MAX_RAW) return { ok: false, reason: "invalid" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  // only these separators may sit between digits; any other character (a letter, an extension, a second number's comma, a tab or line break, a control or non-ASCII character) refuses the number
  if (!/^[+\d ().\-/]+$/.test(trimmed)) return { ok: false, reason: "invalid" };
  const compact = trimmed.replace(/[ ().\-/]/g, "");

  if (compact.startsWith("+")) return E164.test(compact) ? { ok: true, e164: compact, via: "international" } : { ok: false, reason: "invalid" };
  if (!/^\d+$/.test(compact)) return { ok: false, reason: "invalid" }; // a `+` anywhere but the front

  if (compact.startsWith("00")) {
    const e164 = `+${compact.slice(2)}`;
    return E164.test(e164) ? { ok: true, e164, via: "00-prefix" } : { ok: false, reason: "invalid" };
  }

  // a local number: only with a default country the owner chose, and only by a written rule for that country
  const code = options.defaultCountry?.trim() ?? "";
  if (code === "") return { ok: false, reason: "no_country_code" };
  const rule = /^\d{1,3}$/.test(code) ? NATIONAL_NUMBER_RULES[code] : undefined;
  if (!rule) return { ok: false, reason: "unsupported_default_country" };
  const national = compact.startsWith("0") ? compact.slice(1) : compact;
  if (!rule.test(national)) return { ok: false, reason: "invalid" };
  const e164 = `+${code}${national}`;
  return E164.test(e164) ? { ok: true, e164, via: "default-country" } : { ok: false, reason: "invalid" };
}

/**
 * Which stored number to use. The WhatsApp number wins when there is one. If it is there but unusable, there is NO number: the
 * person's phone is never used instead, because a landline or another person's number could receive a message meant for WhatsApp.
 * Only when no WhatsApp number is stored at all is the phone used.
 */
export function chooseWhatsappNumber(row: Pick<PromoWhatsappRow, "whatsappPhone" | "phone">, options: NormalizeOptions = {}): string | null {
  const whatsapp = typeof row.whatsappPhone === "string" ? row.whatsappPhone.trim() : "";
  const chosen = whatsapp !== "" ? whatsapp : row.phone;
  const result = normalizeWhatsappNumber(chosen, options);
  return result.ok ? result.e164 : null;
}

/**
 * The answer for one record. The flags are read strictly: anything that is not a clear "yes it is eligible" fails closed, so a
 * missing value withholds the number rather than releasing it. The number is released only for a LEAD that is lost, clearly not
 * archived, not trashed, not Do Not Contact and not WhatsApp Do Not Disturb.
 */
export function shapeWhatsappTarget(row: PromoWhatsappRow, options: NormalizeOptions = {}): PromoWhatsappTarget {
  const isLead = row.kind === "lead";
  const target = {
    id: row.id,
    archived: !isLead || row.leadArchived !== false, // not a lead, or not a clear `false`: treated as archived
    lost: isLead && row.leadStage === "lost",
    trashed: row.deletedAt !== null && row.deletedAt !== undefined,
    dnc: row.doNotContact !== false, // null or missing reads as Do Not Contact
    whatsappDnd: row.whatsappDnd !== false,
  };
  const eligible = isLead && target.lost && !target.archived && !target.trashed && !target.dnc && !target.whatsappDnd;
  return { ...target, whatsapp: eligible ? chooseWhatsappNumber(row, options) : null };
}

/* ---- a small rate limit ---- */

export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 60_000;

export type RateLimiter = { allow(): boolean };

/** At most `max` answers in any `windowMs`, counted for the whole endpoint (the one caller is the Promotional App's server). */
export function createRateLimiter(options: { max?: number; windowMs?: number; now?: () => number } = {}): RateLimiter {
  const max = options.max ?? RATE_LIMIT;
  const windowMs = options.windowMs ?? RATE_WINDOW_MS;
  const now = options.now ?? Date.now;
  let times: number[] = [];
  return {
    allow() {
      const t = now();
      times = times.filter((x) => t - x < windowMs);
      if (times.length >= max) return false;
      times.push(t);
      return true;
    },
  };
}

/** Why no number was given, as a code, from the flags only (never from the number). */
export function withheldReason(t: PromoWhatsappTarget): string {
  if (!t.lost || t.archived || t.trashed) return "ineligible";
  if (t.dnc) return "dnc";
  if (t.whatsappDnd) return "whatsapp_dnd";
  return "no_number";
}

/* ---- the handler ---- */

/**
 * One line of the access trail for this endpoint: WHO asked is not known here (the caller is the Promotional App's server), so it records
 * WHAT happened. Only codes and, once it has been checked to be a plain id, the opaque record id. Never a number, a secret, a name, or any
 * text from the request. `released` means a number was handed out; `withheld` means the answer was given with no number.
 */
export type PromoWhatsappAudit = {
  outcome: "released" | "withheld" | "not_found" | "refused" | "failed";
  /** A short code: dnc, whatsapp_dnd, ineligible, no_number, unauthorized, not_configured, same_secret, rate_limited, bad_request, method, read_failed. */
  reason: string;
  /** The opaque record id, present only when the id passed the plain-id check. */
  lead?: string;
};

export type PromoWhatsappDeps = {
  /** PROMO_WHATSAPP_TARGET_SECRET. Null or empty closes the endpoint. */
  secret: string | null | undefined;
  /** PROMO_FEED_SECRET. If it is the same value the endpoint refuses to answer: one leaked secret must not open both. */
  feedSecret?: string | null | undefined;
  /** Reads one lost lead's target NOW, or null when there is none the endpoint may show. Read-only by its type. */
  target: (id: string, options: NormalizeOptions) => Promise<PromoWhatsappTarget | null>;
  /** PROMO_WHATSAPP_DEFAULT_COUNTRY, if the owner set one. */
  defaultCountry?: string | null | undefined;
  limiter?: RateLimiter;
  /** Receives one privacy-safe line per request. Optional; a failure inside it never changes the answer. */
  audit?: (event: PromoWhatsappAudit) => void;
  now?: () => Date;
};

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const refuse = (status: number, message: string, extra: Record<string, string> = {}) => Response.json({ ok: false, error: message }, { status, headers: { ...NO_STORE, ...extra } });

function logFailure(e: unknown): void {
  // only the kind of failure and a short code: never a message, a value, or anything that could hold a number
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code).replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "";
  console.error("promo-whatsapp-target: read failed", e instanceof Error ? e.name : "error", code);
}

/**
 * GET only, authenticated with its own secret, no-store, one record. Everything that is not a clean, authorised request for a lost
 * lead answers with a refusal and no number.
 */
export async function handlePromoWhatsappTargetRequest(request: Request, id: string, deps: PromoWhatsappDeps): Promise<Response> {
  const audit = (event: PromoWhatsappAudit) => {
    try {
      deps.audit?.(event);
    } catch {
      // a broken audit sink must never change what the caller is told
    }
  };

  if (request.method !== "GET") {
    audit({ outcome: "refused", reason: "method" });
    return refuse(405, "This endpoint is read-only.", { Allow: "GET" });
  }

  const auth = authorizePromoFeed(request.headers.get("authorization"), deps.secret);
  if (!auth.ok) {
    audit({ outcome: "refused", reason: auth.status === 503 ? "not_configured" : "unauthorized" });
    return refuse(auth.status, auth.status === 503 ? "This endpoint is not configured." : auth.message);
  }
  if (deps.feedSecret && deps.feedSecret === deps.secret) {
    audit({ outcome: "refused", reason: "same_secret" });
    return refuse(503, "This endpoint is not configured.");
  }

  if (deps.limiter && !deps.limiter.allow()) {
    audit({ outcome: "refused", reason: "rate_limited" });
    return refuse(429, "Too many requests.", { "Retry-After": "60" });
  }

  try {
    const url = new URL(request.url);
    const seen = new Set<string>();
    const bad = (message: string) => {
      audit({ outcome: "refused", reason: "bad_request", ...(ID.test(id) ? { lead: id } : {}) });
      return refuse(400, message);
    };
    for (const key of url.searchParams.keys()) {
      if (key !== "scope") return bad(`Unknown parameter "${key}".`);
      if (seen.has(key)) return bad('Parameter "scope" was given more than once.');
      seen.add(key);
    }
    // the scope must be named, and it can only be `lost`: this endpoint is part of the Lost Leads section and nothing else
    if (url.searchParams.get("scope") !== "lost") return bad('scope must be "lost".');
    if (!ID.test(id)) return bad("id is not a valid id.");

    const found = await deps.target(id, { defaultCountry: deps.defaultCountry });
    if (!found) {
      audit({ outcome: "not_found", reason: "no_such_lost_lead", lead: id });
      return refuse(404, "There is no such record.");
    }
    audit(found.whatsapp !== null ? { outcome: "released", reason: "eligible", lead: id } : { outcome: "withheld", reason: withheldReason(found), lead: id });
    // belt and braces: whatever the service returned, only allow-listed fields leave
    const target = Object.fromEntries(PROMO_WHATSAPP_TARGET_FIELDS.map((f) => [f, found[f]]));
    return Response.json({ ok: true, contract: PROMO_WHATSAPP_CONTRACT, generatedAt: (deps.now ?? (() => new Date()))().toISOString(), target }, { headers: NO_STORE });
  } catch (e) {
    logFailure(e);
    audit({ outcome: "failed", reason: "read_failed", ...(ID.test(id) ? { lead: id } : {}) });
    return refuse(503, "The target could not be read.");
  }
}
