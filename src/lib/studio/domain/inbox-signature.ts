import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Kapso signs every webhook body with HMAC-SHA256 keyed on the secret we gave
 * it, and sends the lowercase hex digest — no `sha256=` prefix — in
 * `X-Webhook-Signature`. It is checked against the RAW bytes, never a
 * re-serialised body, and compared in constant time. An empty secret verifies
 * nothing: without one every request is refused, never waved through.
 */
export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifySignature(rawBody: string, header: string | null, secret: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const given = header.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const want = Buffer.from(signBody(rawBody, secret), "hex");
  const got = Buffer.from(given, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
