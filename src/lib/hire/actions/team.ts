"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, auditLog, hireUserRoles, users } from "@/db/schema";
import { notifyUser } from "@/lib/notify";
import { grantAppWithDefaultModules, rederiveAccountLevel, revokeApps } from "@/lib/services/app-provisioning";
import { err, ok, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "../access";
import { HIRE_ROLES, ROLE_LABEL, type HireRole } from "../roles";
import { audit } from "../services/core";

/** Set somebody's job inside Hire. */
export async function setHireRole(userId: string, role: HireRole | "default"): Promise<Result> {
  try {
    const ctx = await requireHireCap("team");
    if (role !== "default" && !HIRE_ROLES.includes(role)) return err("That is not a Hire role.", "validation");
    const [grant] = await db.select({ id: appAccess.id }).from(appAccess).where(and(eq(appAccess.userId, userId), eq(appAccess.app, "hire"))).limit(1);
    if (!grant) return err("They do not hold Hire — add them first.", "rule_violation");
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    const [before] = await db.select({ role: hireUserRoles.role }).from(hireUserRoles).where(eq(hireUserRoles.userId, userId)).limit(1);
    if (role === "default") await db.delete(hireUserRoles).where(eq(hireUserRoles.userId, userId));
    else
      await db
        .insert(hireUserRoles)
        .values({ userId, role, grantedById: ctx.user.id })
        .onConflictDoUpdate({ target: hireUserRoles.userId, set: { role, grantedById: ctx.user.id, grantedAt: new Date() } });
    await audit(ctx, {
      entityType: "hire_role",
      entityId: userId,
      eventType: "role_changed",
      summary: `${u?.name ?? "Somebody"}: ${before ? ROLE_LABEL[before.role as HireRole] ?? before.role : "level default"} → ${role === "default" ? "level default" : ROLE_LABEL[role]}`,
      before: before ?? null,
      after: { role },
    });
    revalidatePath("/hire/team");
    return ok(undefined, "Saved.");
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    throw e;
  }
}

/** The MahekOne level a Hire role is held at — admin for Admin, manager for the deciding roles. */
const LEVEL_FOR: Record<HireRole, "associate" | "manager" | "admin"> = {
  recruiter: "associate",
  interviewer: "associate",
  onboarding: "associate",
  hiring_manager: "manager",
  hr_head: "manager",
  admin: "admin",
};

/**
 * Give somebody Hire, with their job in it, from Hire's own Team screen.
 *
 * Hire is ONE module and its narrowing is the role, so granting it here and
 * granting it on the Access screen are the same write — `grantAppWithDefaultModules`,
 * the account level re-derived, a platform audit row — and cannot disagree.
 * Only Admin may hand out Admin.
 */
export async function addToHire(userId: string, role: HireRole): Promise<Result> {
  try {
    const ctx = await requireHireCap("team");
    if (!HIRE_ROLES.includes(role)) return err("That is not a Hire role.", "validation");
    if (role === "admin" && ctx.role !== "admin") return err("Only a Hire Admin can make somebody an Admin.", "not_permitted");
    const [u] = await db.select({ name: users.name, active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return err("No such person.", "not_found");
    if (!u.active) return err(`${u.name}’s sign-in is disabled. Enable it on the Admin Console first.`, "rule_violation");
    const [grant] = await db.select({ id: appAccess.id }).from(appAccess).where(and(eq(appAccess.userId, userId), eq(appAccess.app, "hire"))).limit(1);
    if (grant) return err(`${u.name} already holds Hire — change their role in the list.`, "conflict");
    await db.transaction(async (tx) => {
      await grantAppWithDefaultModules(tx, { userId, app: "hire", grantedById: ctx.user.id, level: LEVEL_FOR[role] });
      await tx.insert(hireUserRoles).values({ userId, role, grantedById: ctx.user.id }).onConflictDoUpdate({ target: hireUserRoles.userId, set: { role, grantedById: ctx.user.id, grantedAt: new Date() } });
      const accountLevel = await rederiveAccountLevel(tx, userId);
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: ctx.user.id,
        action: "app-grant",
        entityType: "user",
        entityId: userId,
        afterState: { detail: `granted hire as ${LEVEL_FOR[role]} (${ROLE_LABEL[role]}, from Hire's Team screen)`, accountLevel } as never,
      });
      await audit(ctx, { entityType: "hire_role", entityId: userId, eventType: "added", summary: `${u.name} given Hire as ${ROLE_LABEL[role]}`, after: { role } }, tx);
    });
    await notifyUser({ userId, title: "You now have Hire", body: `${ctx.user.name} gave you Hire as ${ROLE_LABEL[role]}.`, href: "/hire" });
    revalidatePath("/hire/team");
    return ok(undefined, `${u.name} can now open Hire, as ${ROLE_LABEL[role]}.`);
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    throw e;
  }
}

/** Take Hire away. Their decisions, scores and audit lines stay — the record is theirs, not the grant's. */
export async function removeFromHire(userId: string): Promise<Result> {
  try {
    const ctx = await requireHireCap("team");
    if (userId === ctx.user.id) return err("You cannot remove yourself — ask another HR Head or Admin.", "rule_violation");
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    const [r] = await db.select({ role: hireUserRoles.role }).from(hireUserRoles).where(eq(hireUserRoles.userId, userId)).limit(1);
    if (r?.role === "admin" && ctx.role !== "admin") return err("Only a Hire Admin can remove an Admin.", "not_permitted");
    await db.transaction(async (tx) => {
      await revokeApps(tx, userId, ["hire"]);
      await tx.delete(hireUserRoles).where(eq(hireUserRoles.userId, userId));
      const accountLevel = await rederiveAccountLevel(tx, userId);
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: ctx.user.id,
        action: "app-revoke",
        entityType: "user",
        entityId: userId,
        afterState: { detail: "revoked hire (from Hire's Team screen)", accountLevel } as never,
      });
      await audit(ctx, { entityType: "hire_role", entityId: userId, eventType: "removed", summary: `${u?.name ?? "Somebody"} removed from Hire` }, tx);
    });
    revalidatePath("/hire/team");
    return ok(undefined, `${u?.name ?? "They"} no longer have Hire.`);
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    throw e;
  }
}

/** People who could be added: active accounts not holding Hire, matching a search. */
export async function searchPeopleForHire(term: string): Promise<{ id: string; name: string; meta: string }[]> {
  await requireHireCap("team");
  const q = `%${term.trim().toLowerCase()}%`;
  if (term.trim().length < 2) return [];
  const rows = (await db.execute(sql`
    select u.id, u.name, u.email, u.phone from users u
    where u.active and not exists (select 1 from app_access g where g.user_id = u.id and g.app = 'hire')
      and (lower(u.name) like ${q} or lower(coalesce(u.email, '')) like ${q} or coalesce(u.phone, '') like ${q})
    order by u.name limit 8`)) as unknown as { id: string; name: string; email: string | null; phone: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, meta: [r.email, r.phone].filter(Boolean).join(" · ") }));
}
