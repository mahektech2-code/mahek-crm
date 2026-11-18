import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Whether a request's Authorization header is `Bearer <secret>`, compared in
 * constant time. Both sides are hashed first so the comparison never depends
 * on how long the guess was.
 */
export function bearerMatches(header: string | null, secret: string): boolean {
  const a = createHash("sha256").update(header ?? "").digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}
