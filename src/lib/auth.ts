import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
export const getCurrentUser = cache(async function getCurrentUser(): Promise<User | null> {
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
  if (!user) redirect("/login");
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
