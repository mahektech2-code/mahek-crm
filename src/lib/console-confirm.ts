import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { currentSessionId } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";

/* ---------------------------------------------------------------------------
 * THE CONSOLE ASKS FOR THE PASSWORD AGAIN.
 *
 * A session lasts thirty days, and the Admin Console can sign in as anybody,
 * grant anybody anything and read every credential the deployment holds. A
 * laptop left open, a cookie lifted off a machine, a browser somebody else
 * borrowed: any of those used to be the whole of a platform administrator.
 * Now the console wants a password proved within
 * `auth.console.confirmMinutes`, and each console page opened moves that
 * forward, so somebody working in it is asked once and left alone.
 *
 * It is enforced twice, for the reason every check here is: the console's
 * layout redirects to `/login/confirm`, and `requirePlatformAdminUser` — the
 * gate on every act that changes who can reach what — refuses a stale
 * session, because a server action is a URL and the layout is not in front of
 * it. Sales → People's credential controls are behind that same gate, so they
 * ask too; that is the point rather than a side effect.
 * ------------------------------------------------------------------------- */

export class ConsoleNotConfirmedError extends Error {
  constructor() {
    super("For safety, confirm your password first: open the Admin Console and it will ask, then try again.");
    this.name = "ConsoleNotConfirmedError";
  }
}

async function cutoff(): Promise<Date> {
  const minutes = Number((await getConfig())["auth.console.confirmMinutes"]);
  return new Date(Date.now() - minutes * 60_000);
}

/**
 * Whether this request's session proved its password recently enough.
 * Integration tests have no cookie jar and sign in through `setTestUser`, so
 * they read as confirmed — the same seam `getCurrentUser` opens.
 */
export async function isConsoleConfirmed(): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;
  const id = await currentSessionId();
  if (!id) return false;
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.confirmedAt, await cutoff())))
    .limit(1);
  return !!row;
}

export async function requireConsoleConfirmed(): Promise<void> {
  if (!(await isConsoleConfirmed())) throw new ConsoleNotConfirmedError();
}

/**
 * Moves a still-fresh confirmation forward — called by the console's layout,
 * so the clock measures time AWAY from the console rather than time in it. A
 * stale one is left stale: only a password brings it back.
 */
export async function keepConsoleConfirmed(): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  const id = await currentSessionId();
  if (!id) return;
  await db
    .update(sessions)
    .set({ confirmedAt: new Date() })
    .where(and(eq(sessions.id, id), gt(sessions.confirmedAt, await cutoff())));
}

/** The password was just proved for this session. */
export async function markConsoleConfirmed(): Promise<void> {
  const id = await currentSessionId();
  if (!id) return;
  await db.update(sessions).set({ confirmedAt: new Date() }).where(eq(sessions.id, id));
}
