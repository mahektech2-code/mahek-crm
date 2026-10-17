import { createHmac, timingSafeEqual } from "node:crypto";

/* ---------------------------------------------------------------------------
 * THE PREVIEW LINK'S TOKEN.
 *
 * A preview is the real public page rendered from the working copy. The public
 * site must only enter that mode for somebody MahekOne has just authorised, and
 * it has no accounts of its own — so the link carries a short-lived token that
 * only MahekOne can mint: `<payload>.<signature>`, the payload a base64url JSON
 * object `{exp, path?}`, the signature HMAC-SHA256 of the payload under the
 * shared publish secret.
 *
 * The website verifies it with the same recipe (contract §3). Nothing in the
 * token is secret, and it cannot be forged or lengthened without the key; it is
 * valid for minutes, not days, and it names the page it opens.
 * ------------------------------------------------------------------------- */

export const PREVIEW_TTL_SECONDS = 15 * 60;
/** The website refuses a token claiming to live longer than this, whatever it says. */
export const PREVIEW_MAX_TTL_SECONDS = 30 * 60;

const b64 = (buf: Buffer) => buf.toString("base64url");

export type PreviewPayload = { exp: number; path?: string };

export function signPreviewToken(
  secret: string,
  opts: { path?: string; ttlSeconds?: number; nowMs?: number } = {},
): string {
  const nowS = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const payload: PreviewPayload = { exp: nowS + (opts.ttlSeconds ?? PREVIEW_TTL_SECONDS) };
  if (opts.path) payload.path = opts.path;
  const body = b64(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyPreviewToken(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): { ok: true; payload: PreviewPayload } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;
  const expected = createHmac("sha256", secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad signature" };
  let payload: PreviewPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PreviewPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const nowS = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number") return { ok: false, reason: "malformed" };
  if (payload.exp <= nowS) return { ok: false, reason: "expired" };
  if (payload.exp > nowS + PREVIEW_MAX_TTL_SECONDS) return { ok: false, reason: "too long-lived" };
  return { ok: true, payload };
}
