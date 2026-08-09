"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, auditLog, users } from "@/db/schema";
import { requireUser, isManager } from "@/lib/auth";
import { APP_IDS, type AppId } from "@/lib/apps";
import { err as fail, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Writes for the People section.
 *
 * These are what the console's checkboxes used to only pretend to do. Every
 * one is checked server-side rather than by hiding a control: a screen that
 * disables a button has told the browser something, and the browser is not
 * where authority lives.
 *
 * Every change lands in the audit log with the manager who made it, because
 * "who can open payroll" is exactly the question somebody asks six months
 * later.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function manager() {
  const user = await requireUser();
  if (!isManager(user)) throw new Error("Only a manager can change accounts.");
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
    afterState: { detail } as never,
  });
}

function refresh() {
  try {
    revalidatePath("/admin");
    revalidatePath("/apps");
  } catch {
    /* outside a request, which is fine */
  }
}

/** The complete set of apps an account may open. */
export async function setUserApps(
  userId: string,
  apps: string[],
): Promise<Result<{ apps: string[] }>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const wanted = [...new Set(apps)].filter((a): a is AppId => APP_IDS.includes(a as AppId));
  const unknown = [...new Set(apps)].filter((a) => !APP_IDS.includes(a as AppId));
  if (unknown.length) return fail(`Not an app: ${unknown.join(", ")}`);

  const current = await db
    .select({ app: appAccess.app })
    .from(appAccess)
    .where(eq(appAccess.userId, userId));
  const had = current.map((c) => c.app as AppId);

  const add = wanted.filter((a) => !had.includes(a));
  const remove = had.filter((a) => !wanted.includes(a));
  if (!add.length && !remove.length) return ok({ apps: wanted }, "No change.");

  await db.transaction(async (tx) => {
    if (remove.length) {
      await tx
        .delete(appAccess)
        .where(and(eq(appAccess.userId, userId), inArray(appAccess.app, remove)));
    }
    if (add.length) {
      await tx.insert(appAccess).values(
        add.map((app) => ({ id: newId("acc"), userId, app, grantedById: actor.id })),
      );
    }
  });

  await audit(
    actor.id,
    "set-app-access",
    userId,
    `${had.sort().join(",") || "none"} → ${wanted.sort().join(",") || "none"}`,
  );
  refresh();

  const granted = add.length ? `granted ${add.join(", ")}` : "";
  const revoked = remove.length ? `revoked ${remove.join(", ")}` : "";
  return ok({ apps: wanted }, [granted, revoked].filter(Boolean).join("; "));
}

export async function setUserRole(
  userId: string,
  role: "telecaller" | "manager" | "accounts" | "admin",
): Promise<Result<null>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const [before] = await db
    .select({ role: users.role, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!before) return fail("That account no longer exists.");
  if (before.role === role) return ok(null, "No change.");

  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
  await audit(actor.id, "set-role", userId, `${before.role} → ${role}`);
  refresh();
  return ok(null, `${before.name} is now ${role}.`);
}

/**
 * Deactivation is a status, never a deletion — the same rule customers follow.
 * A leaver's calls, orders and audit trail outlive their login.
 */
export async function setUserActive(
  userId: string,
  active: boolean,
): Promise<Result<null>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const [before] = await db
    .select({ active: users.active, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!before) return fail("That account no longer exists.");
  if (before.active === active) return ok(null, "No change.");

  if (!active && userId === actor.id) {
    return fail("You cannot deactivate your own account.");
  }

  await db.update(users).set({ active, updatedAt: new Date() }).where(eq(users.id, userId));
  await audit(actor.id, active ? "reactivate-user" : "deactivate-user", userId, before.name);
  refresh();
  return ok(null, `${before.name} ${active ? "reactivated" : "deactivated"}.`);
}

/** Name, work number and sign-in address. Never the password. */
export async function updateUserIdentity(
  userId: string,
  input: { name?: string; email?: string; phone?: string | null },
): Promise<Result<null>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const [before] = await db
    .select({ name: users.name, email: users.email, phone: users.phone })
    .from(users)
    .where(eq(users.id, userId));
  if (!before) return fail("That account no longer exists.");

  const patch: Partial<typeof users.$inferInsert> = {};
  const changed: string[] = [];

  if (input.name && input.name.trim() && input.name !== before.name) {
    patch.name = input.name.trim();
    // The avatar follows the name, or it keeps the previous person's letters.
    const parts = patch.name.split(/\s+/).filter(Boolean);
    patch.initials = (
      (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : (parts[0]?.[1] ?? ""))
    ).toUpperCase();
    changed.push(`name ${before.name} → ${patch.name}`);
  }

  if (input.email && input.email.trim() && input.email !== before.email) {
    const email = input.email.trim().toLowerCase();
    const taken = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken.length && taken[0].id !== userId) {
      return fail(`${email} already belongs to another account.`);
    }
    patch.email = email;
    // This is a sign-in, not a label. Worth saying so where somebody will read
    // it rather than discovering it at the login screen.
    changed.push(`email ${before.email} → ${email} (this is their sign-in)`);
  }

  if (input.phone !== undefined) {
    const phone = input.phone ? input.phone.replace(/\D/g, "").slice(-10) : null;
    if (phone && !/^[6-9]\d{9}$/.test(phone)) {
      return fail("That is not a 10-digit Indian mobile number.");
    }
    if (phone !== before.phone) {
      patch.phone = phone;
      changed.push(`work number ${before.phone ?? "none"} → ${phone ?? "none"}`);
    }
  }

  if (!changed.length) return ok(null, "No change.");

  patch.updatedAt = new Date();
  await db.update(users).set(patch).where(eq(users.id, userId));
  await audit(actor.id, "update-user", userId, changed.join("; "));
  refresh();
  return ok(null, changed.join("; "));
}
