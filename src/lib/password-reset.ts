import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";
import { passwordResets } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * Reset links: minted here, hashed before storage, and read back in one place
 * so the page that renders the form and the action that consumes the token
 * cannot disagree about whether a link is still live.
 * ------------------------------------------------------------------------- */

/** Short enough that a forwarded link is not a standing key to the account. */
export const RESET_TTL_MINUTES = 30;

export function newResetToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What goes in the database. The token itself only ever exists in the email. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The reset row this token opens, or null if it is spent, expired or fake. */
export async function findLiveReset(token: string) {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.tokenHash, hashResetToken(token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The address to build the link against. Behind Vercel's proxy the request host
 * is the forwarded one; APP_URL wins when set, because a link mailed out has to
 * be right even when the mail is sent from a job rather than a request.
 */
export async function appOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
