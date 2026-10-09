import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of an `Authorization: Bearer …` header against a secret.
 *
 * In its own file, with no imports of ours, because the public routes use it and
 * must not pull the access layer (and through it half the CRM) into their module
 * graph — the reason `enquiry-counts.ts` exists beside `enquiry-service.ts`.
 */
export function bearerMatches(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !secret) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  // Different lengths still take the constant-time path on SOME comparison, so
  // the length itself is not what leaks through timing.
  if (a.length !== b.length) return timingSafeEqual(a, a) && false;
  return timingSafeEqual(a, b);
}
