import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { impersonationTokens } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * Sign-in-as-somebody links: minted here, hashed before storage, read back in
 * one place — the same shape as `lib/password-reset.ts` and for the same
 * reason, so the page that offers to sign somebody in and the action that
 * actually does it cannot disagree about whether a link is still live.
 *
 * Short and single-use on purpose. This is not a password reset — the
 * account is never told, nothing about it changes, and the link itself IS
 * the sign-in. A copy of it sitting in a chat log or a screenshot is a
 * standing key to the account for as long as it works, so the window it
 * works in is minutes, not the half hour a mailed password link gets.
 * ------------------------------------------------------------------------- */

export const IMPERSONATION_TTL_MINUTES = 10;

export function newImpersonationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What goes in the database. The token itself only ever exists in the URL. */
export function hashImpersonationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The row this token opens, or null if it is spent, expired or fake. */
export async function findLiveImpersonation(token: string) {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(impersonationTokens)
    .where(
      and(
        eq(impersonationTokens.tokenHash, hashImpersonationToken(token)),
        isNull(impersonationTokens.usedAt),
        gt(impersonationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}
