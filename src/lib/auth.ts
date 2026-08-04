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
 */
export async function createSession(userId: string, remember = true) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await db.insert(sessions).values({ id, userId, expiresAt });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(remember ? { expires: expiresAt } : {}),
  });
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
  return user;
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
