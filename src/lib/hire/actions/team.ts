"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, hireUserRoles, users } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "../access";
import { HIRE_ROLES, ROLE_LABEL, type HireRole } from "../roles";
import { audit } from "../services/core";

/** Set somebody's job inside Hire. Granting the app itself is the Admin Console's Access screen. */
export async function setHireRole(userId: string, role: HireRole | "default"): Promise<Result> {
  try {
    const ctx = await requireHireCap("team");
    if (role !== "default" && !HIRE_ROLES.includes(role)) return err("That is not a Hire role.", "validation");
    const [grant] = await db.select({ id: appAccess.id }).from(appAccess).where(and(eq(appAccess.userId, userId), eq(appAccess.app, "hire"))).limit(1);
    if (!grant) return err("They do not hold Hire. Grant the app on the Admin Console’s Access screen first.", "rule_violation");
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
