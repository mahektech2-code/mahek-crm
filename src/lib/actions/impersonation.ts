"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, impersonationTokens, users } from "@/db/schema";
import { createSession, requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getApp } from "@/lib/apps";
import { appOrigin } from "@/lib/password-reset";
import {
  findLiveImpersonation,
  hashImpersonationToken,
  IMPERSONATION_TTL_MINUTES,
  newImpersonationToken,
} from "@/lib/impersonation";
import { err as fail, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Signing in as somebody else, without their password.
 *
 * Two actions, deliberately kept apart from `actions/people.ts`'s manager-
 * gated writes: minting a link needs nobody's password and is checked here
 * against `role === "admin"` specifically, and consuming one needs nobody
 * to be signed in at all — the whole point is that it signs somebody IN. A
 * shared file would have made it easy to reach for the wrong guard.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function admin() {
  const user = await requireUser();
  if (user.role !== "admin") {
    throw new Error("Only an admin can generate a sign-in link for another account.");
  }
  return user;
}

async function audit(
  actorId: string,
  action: string,
  userId: string,
  detail: string,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId,
    action,
    entityType: "user",
    entityId: userId,
    actorRole: "admin",
    afterState: { detail } as never,
  });
}

/**
 * Mints a one-time sign-in link for `userId` and hands the URL back — it is
 * shown once, on this screen, for the admin to copy themselves. Nothing is
 * mailed: unlike a password reset, this is not something the account holder
 * asked for or needs to know about, and a link that bypasses a password
 * entirely has no business travelling through an inbox.
 *
 * Minting is harmless on its own — the link does nothing until somebody
 * opens it and confirms — so there is no confirmation step here. The
 * confirmation lives on the other end, at `/login/impersonate/[token]`.
 */
export async function mintImpersonationLink(
  userId: string,
): Promise<Result<{ url: string; expiresInMinutes: number }>> {
  let actor;
  try {
    actor = await admin();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const [user] = await db
    .select({ name: users.name, active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return fail("That account no longer exists.", "not_found");
  if (!user.active) {
    return fail(`${user.name}'s sign-in is disabled, so there is nothing to sign in to.`);
  }

  const token = newImpersonationToken();
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60_000);

  await db.transaction(async (tx) => {
    // Only one live link per person at a time — the same rule a password
    // reset follows, so an old link copied into a chat last week cannot
    // still be sitting there working.
    await tx
      .update(impersonationTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(impersonationTokens.userId, userId), isNull(impersonationTokens.usedAt)));
    await tx.insert(impersonationTokens).values({
      id: newId("imp"),
      userId,
      createdById: actor.id,
      tokenHash: hashImpersonationToken(token),
      expiresAt,
    });
  });

  await audit(
    actor.id,
    "impersonate.start",
    userId,
    `Sign-in link minted for ${user.name}, expires in ${IMPERSONATION_TTL_MINUTES} minutes`,
  );

  const url = `${await appOrigin()}/login/impersonate/${token}`;
  return ok({ url, expiresInMinutes: IMPERSONATION_TTL_MINUTES }, `Sign-in link ready for ${user.name}.`);
}

/**
 * Spends the link and signs in as whoever it names.
 *
 * `createSession` sets a fresh cookie in whatever browser this runs in — it
 * does not first look for or clear anyone else's session, because it does
 * not need to: a cookie holds exactly one value, so setting a new one is
 * already the previous account being signed out of THIS browser. Every
 * other browser or device that account was signed into is untouched.
 *
 * Neither `recordSignIn` nor `lastLoginAt` is touched here, unlike an
 * ordinary sign-in — those exist to say when the ACCOUNT HOLDER opened
 * MahekOne, and recording one here would say Priya opened the app at an
 * hour it was actually an admin looking through her account. The true fact
 * of who did this and when is `audit_log`, under the admin's own id.
 */
export async function enterImpersonatedSession(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  const token = String(formData.get("token") ?? "");
  const row = await findLiveImpersonation(token);
  if (!row) {
    return fail("That link has expired or has already been used.");
  }

  const [user] = await db
    .select({ id: users.id, name: users.name, active: users.active })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user || !user.active) {
    return fail("That account can no longer be signed in to.");
  }

  await db
    .update(impersonationTokens)
    .set({ usedAt: new Date() })
    .where(eq(impersonationTokens.id, row.id));

  await createSession(user.id);
  await audit(
    row.createdById,
    "impersonate.enter",
    user.id,
    `Signed in as ${user.name}`,
  );

  // Imported lazily: next/navigation pulls in the client React runtime,
  // which cannot be loaded outside a request — see requireUser() in
  // lib/auth.ts, the same reasoning applies here.
  const { redirect } = await import("next/navigation");
  const apps = await listUserApps(user.id);
  if (!apps.length) redirect("/apps");
  if (apps.length === 1) redirect(getApp(apps[0])?.href ?? "/apps");
  redirect("/apps");
  throw new Error("unreachable"); // redirect() never returns
}
