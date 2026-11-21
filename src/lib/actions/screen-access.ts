"use server";

import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, appScreenAccess, erpUserPowers, hrmsUserPowers, taskUserPowers, users } from "@/db/schema";
import { requirePlatformAdminUser, type Role } from "@/lib/access-control";
import type { AppId } from "@/lib/apps";
import { err as fail, ok, type Result } from "@/lib/result";
import { convertGrant } from "@/lib/access/convert-grant";
import type { Position } from "@/lib/access/permission-rules";
import { grantFromRows, moduleShape } from "@/lib/access/screen-permissions";

/* ---------------------------------------------------------------------------
 * WHAT THE MANAGE ACCESS DIALOG OPENS ON, for one person.
 *
 * Per app they hold: the position and each screen's ticks. A grant already
 * converted to the screen model is read as stored; one that is not yet is
 * converted on the fly (`convertGrant`) from its level, narrowed screens and
 * powers — the same reading the backfill writes — so the dialog shows what
 * the person can do today, and saving it is what converts the grant.
 *
 * Reports to is read from the account's reporting line, which HRMS keeps; the
 * dialog shows it and never edits it.
 * ------------------------------------------------------------------------- */

export type ScreenAccessApp = {
  app: AppId;
  position: Position;
  modules: string[];
  screens: { screen: string; edit: boolean; delete: boolean; autoEdit: boolean }[];
};

export type ScreenAccessView = {
  apps: ScreenAccessApp[];
  platformAdmin: boolean;
  reportsTo: { name: string } | null;
};

export async function loadScreenAccess(userId: string): Promise<Result<ScreenAccessView>> {
  try {
    await requirePlatformAdminUser();
  } catch {
    return fail("Only a platform administrator can change access.", "not_permitted");
  }

  const [person] = await db.select({ id: users.id, role: users.role, reportsToId: users.reportsToId }).from(users).where(eq(users.id, userId)).limit(1);
  if (!person) return fail("That account no longer exists.", "not_found");

  const [grants, modules, screens, erp, hrms, tasks, boss] = await Promise.all([
    db.select({ app: appAccess.app, role: appAccess.role, position: appAccess.position }).from(appAccess).where(eq(appAccess.userId, userId)),
    db.select({ app: appModuleAccess.app, module: appModuleAccess.module }).from(appModuleAccess).where(eq(appModuleAccess.userId, userId)),
    db
      .select({ app: appScreenAccess.app, screen: appScreenAccess.screen, edit: appScreenAccess.canEdit, del: appScreenAccess.canDelete, auto: appScreenAccess.editByDelete })
      .from(appScreenAccess)
      .where(eq(appScreenAccess.userId, userId)),
    db.select({ power: erpUserPowers.power }).from(erpUserPowers).where(eq(erpUserPowers.userId, userId)),
    db.select({ power: hrmsUserPowers.power }).from(hrmsUserPowers).where(eq(hrmsUserPowers.userId, userId)),
    db.select({ power: taskUserPowers.power }).from(taskUserPowers).where(eq(taskUserPowers.userId, userId)),
    person.reportsToId ? db.select({ name: users.name }).from(users).where(inArray(users.id, [person.reportsToId])).limit(1) : Promise.resolve([]),
  ]);

  const powersOf: Partial<Record<AppId, string[]>> = {
    erp: erp.map((r) => r.power),
    hrms: hrms.map((r) => r.power),
    tasks: tasks.map((r) => r.power),
  };
  const platformAdmin = person.role === "admin" || grants.some((g) => g.app === "admin" && g.role === "admin");

  const apps: ScreenAccessApp[] = grants.map((g) => {
    const app = g.app as AppId;
    const shape = moduleShape(app);
    const draft = g.position
      ? grantFromRows(g.position, screens.filter((s) => s.app === app))
      : convertGrant({
          app,
          role: (g.role as Role | null) ?? null,
          modules: modules.some((m) => m.app === app) ? modules.filter((m) => m.app === app).map((m) => m.module) : null,
          powers: powersOf[app] ?? [],
          platformAdmin,
        });
    const held = new Set(draft.screens.keys());
    return {
      app,
      position: draft.position,
      modules: shape.filter((m) => m.screens.some((s) => held.has(s))).map((m) => m.module),
      screens: [...draft.screens].map(([screen, t]) => ({ screen, edit: t.edit, delete: t.delete, autoEdit: t.autoEdit })),
    };
  });

  return ok({ apps, platformAdmin, reportsTo: boss[0] ? { name: boss[0].name } : null });
}
