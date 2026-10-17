import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { signInFailures } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { minutesShut, shutMessage } from "@/lib/sign-in-throttle-rules";
import { otpAvailability } from "@/lib/services/otp-service";

/* ---------------------------------------------------------------------------
 * Wrong passwords, counted.
 *
 * Nothing limited them: the form could be posted as fast as a script could
 * post it, against any account, and an administrator's password was the whole
 * of what stood between the internet and every power in the console. Two
 * counts, because they stop two different attacks — one account guessed many
 * times, and one common password tried against everybody — and the second is
 * set well above the first because an office shares one address.
 *
 * Asked BEFORE the password is checked, so a paused account answers the same
 * way whether or not the password was right: otherwise the pause would be an
 * oracle that says "that one was correct" by letting it through.
 * ------------------------------------------------------------------------- */

/**
 * The client's address as Caddy reports it. Caddy sets X-Forwarded-For from
 * the connection itself and does not trust one the client sent, so the first
 * entry is the real peer. Null outside a request and in development, where
 * nothing sets it — the per-address count is then simply not applied.
 */
export async function clientAddress(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return first || h.get("x-real-ip") || null;
  } catch {
    return null;
  }
}

/** A matched person counts by id, so their phone and their email share one count. */
export function accountKey(userId: string | null, typed: string): string {
  return userId ? `user:${userId}` : `name:${typed.trim().toLowerCase()}`;
}

/** The failure at position `limit` from the newest, inside the window — or null. */
async function nthNewest(
  where: ReturnType<typeof eq>,
  limit: number,
  since: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ at: signInFailures.at })
    .from(signInFailures)
    .where(and(where, gt(signInFailures.at, since)))
    .orderBy(desc(signInFailures.at))
    .limit(1)
    .offset(limit - 1);
  return row?.at ?? null;
}

/** The refusal to show, or null when this attempt may go ahead. */
export async function signInRefusal(account: string, address: string | null): Promise<string | null> {
  const config = await getConfig();
  const windowMinutes = Number(config["auth.password.failureWindowMinutes"]);
  const now = new Date();
  const since = new Date(now.getTime() - windowMinutes * 60_000);

  const byAccount = minutesShut(
    await nthNewest(eq(signInFailures.account, account), Number(config["auth.password.maxFailures"]), since),
    windowMinutes,
    now,
  );
  const byAddress = address
    ? minutesShut(
        await nthNewest(
          eq(signInFailures.address, address),
          Number(config["auth.password.maxFailuresPerAddress"]),
          since,
        ),
        windowMinutes,
        now,
      )
    : null;

  const wait = Math.max(byAccount ?? 0, byAddress ?? 0);
  if (!wait) return null;
  const codes = await otpAvailability();
  return shutMessage(wait, codes.available);
}

export async function recordSignInFailure(account: string, address: string | null): Promise<void> {
  await db.insert(signInFailures).values({ id: `sif_${randomUUID().slice(0, 12)}`, account, address });
  // Nothing reads further back than the window, whose ceiling is four hours.
  await db.delete(signInFailures).where(lt(signInFailures.at, new Date(Date.now() - 86_400_000)));
}

/** A right password wipes the account's run — the next typo starts from one. */
export async function clearSignInFailures(account: string): Promise<void> {
  await db.delete(signInFailures).where(eq(signInFailures.account, account));
}
