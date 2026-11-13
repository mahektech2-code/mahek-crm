import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { eq, and, gt } from "drizzle-orm";
import { db } from "@/db";
import { users, sessions, type User } from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";

export { hashPassword, verifyPassword };

const SESSION_COOKIE = "mahekone_session";
const SESSION_DAYS = 30;

/* -------------------------------------------------------------- sessions */

/**
 * `remember` is the "keep me signed in on this computer" box. Unticked, the
 * cookie dies with the browser — which is what a shared machine on the sales
 * floor needs.
 *
 * `confirmed` says the person just proved who they are — a password or a code
 * to their phone — which is what lets the Admin Console open without asking
 * again (`lib/console-confirm.ts`). An impersonation link proves nothing about
 * the person it signs in as, so it leaves this false.
 */
export async function createSession(userId: string, remember = true, confirmed = false) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await db.insert(sessions).values({ id, userId, expiresAt, confirmedAt: confirmed ? new Date() : null });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(remember ? { expires: expiresAt } : {}),
  });
}

/**
 * WHICH session this request is holding, or null.
 *
 * Exists for one caller: changing your own password ends every OTHER session
 * and keeps this one. Ending them all would sign somebody out of the tab they
 * are standing in as the reward for doing the responsible thing, and a
 * password change is not a leak being contained — that is `resetPassword`,
 * which deliberately ends the lot.
 *
 * Null is read as "cannot tell", and the caller then ends everything: the
 * safe direction, because a session this function could not name is one it
 * cannot promise is yours. Test runs take that path — they have no cookie jar
 * at all, which is the same seam `getCurrentUser` opens two functions below.
 */
export async function currentSessionId(): Promise<string | null> {
  if (process.env.NODE_ENV === "test") return null;
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

export async function destroySession() {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) await db.delete(sessions).where(eq(sessions.id, id));
  jar.delete(SESSION_COOKIE);
}

/**
 * The signed-in user, or null. Cached for the request: a layout and its page
 * both ask for it, and against a distant database each extra lookup is another
 * 300 ms.
 */
/**
 * Test-only seam. Integration tests run the real services — scope resolution,
 * capability checks and all — outside a request, where there is no cookie jar.
 * Guarded on NODE_ENV so it cannot be reached from a running server.
 */
const globalForTestUser = globalThis as unknown as { __mahekTestUser?: User | null };

export function setTestUser(user: User | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setTestUser is only available under NODE_ENV=test.");
  }
  globalForTestUser.__mahekTestUser = user;
}

export const getCurrentUser = cache(async function getCurrentUser(): Promise<User | null> {
  if (process.env.NODE_ENV === "test") {
    return globalForTestUser.__mahekTestUser ?? null;
  }

  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const user = rows[0]?.user ?? null;
  return user && user.active ? user : null;
});

/** Use in every page and action that requires a signed-in user. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    // Imported lazily: next/navigation pulls in the client React runtime, which
    // the integration tests cannot load outside a request.
    const { redirect } = await import("next/navigation");
    redirect("/login");
    throw new Error("unreachable"); // redirect() never returns
  }
  await refuseWhileLocked(user);
  return user;
}

/**
 * `requireUser` for an action that only READS — the header's polls (the
 * feedback summary, the tasks tray). The workday lock refuses saves, not a
 * badge count: refusing these would throw in every open tab every few seconds
 * while somebody is on a break, and save nothing by doing it.
 */
export async function requireReader(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
    throw new Error("unreachable");
  }
  return user;
}

/**
 * THE WORKDAY LOCK, ON THE SERVER. A lock drawn only on the screen is a curtain
 * anybody can open by typing a URL, so a SERVER ACTION — every save in
 * MahekOne — is refused while somebody is locked out (before punching in, on a
 * break, after punching out). Only actions: a page still renders behind the
 * lock screen, and punching in itself goes through `/api/workday`, a route,
 * so the way out of the lock is never behind it. Off by default
 * (`hrms.workday.lockEnabled`), and outside a request — a job, a test — there
 * is no action to refuse.
 */
async function refuseWhileLocked(user: User) {
  if (process.env.NODE_ENV === "test") return;
  let isAction = false;
  try {
    const { headers } = await import("next/headers");
    isAction = !!(await headers()).get("next-action");
  } catch {
    return;
  }
  if (!isAction) return;
  const { serverLocked } = await import("@/lib/hrms/services/workday");
  if (await serverLocked(user)) {
    throw new Error("MahekOne is locked. Punch in, or resume from your break, before saving anything.");
  }
}

export async function requireManager(): Promise<User> {
  const user = await requireUser();
  if (!isManager(user)) {
    throw new Error("That is a manager action.");
  }
  return user;
}

export function isManager(user: Pick<User, "role">): boolean {
  return user.role === "manager" || user.role === "admin";
}
