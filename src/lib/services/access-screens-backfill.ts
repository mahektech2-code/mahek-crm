import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, appScreenAccess, auditLog, erpUserPowers, hrmsUserPowers, taskUserPowers, users } from "@/db/schema";
import type { AppId } from "@/lib/apps";
import type { Role } from "@/lib/role-levels";
import { compareConversion, convertGrant, type ConversionDifference, type GrantToday } from "@/lib/access/convert-grant";

/* ---------------------------------------------------------------------------
 * EVERY GRANT, CONVERTED TO POSITION AND SCREEN TICKS
 * (`npm run jobs -- access-screens-backfill [--dry-run]`).
 *
 * Reads each person's grant per app as the app reads it today — level,
 * narrowed screens, the ERP's, HRMS's and Tasks' powers, platform
 * administrator — converts it (`lib/access/convert-grant.ts`) and writes
 * `app_access.position` and the `app_screen_access` rows.
 *
 * IT REFUSES A GRANT THAT WOULD LOSE ANYTHING on a screen the person still
 * holds: that grant is left unconverted and listed. Nothing reads the new rows
 * yet, so a refusal costs nothing but a line in the report to look at.
 *
 * Idempotent: a converted grant is rewritten from the same inputs, so a
 * second run writes the same rows. `--dry-run` converts and compares
 * everything and writes nothing.
 * ------------------------------------------------------------------------- */

export type GrantReport = { userId: string; name: string; app: AppId; diff: ConversionDifference };

export type ScreensBackfill = {
  converted: number;
  refused: GrantReport[];
  /** Converted, but with something worth reading: gained, added, or gone with a narrowed-away screen. */
  noted: GrantReport[];
};

export async function accessScreensBackfill(opts: { dryRun?: boolean } = {}): Promise<ScreensBackfill> {
  const [grants, people, modules, erp, hrms, tasks] = await Promise.all([
    db.select({ userId: appAccess.userId, app: appAccess.app, role: appAccess.role }).from(appAccess),
    db.select({ id: users.id, name: users.name, role: users.role }).from(users),
    db.select({ userId: appModuleAccess.userId, app: appModuleAccess.app, module: appModuleAccess.module }).from(appModuleAccess),
    db.select({ userId: erpUserPowers.userId, power: erpUserPowers.power }).from(erpUserPowers),
    db.select({ userId: hrmsUserPowers.userId, power: hrmsUserPowers.power }).from(hrmsUserPowers),
    db.select({ userId: taskUserPowers.userId, power: taskUserPowers.power }).from(taskUserPowers),
  ]);

  const person = new Map(people.map((p) => [p.id, p]));
  const modulesOf = new Map<string, string[]>();
  for (const m of modules) {
    const k = `${m.userId} ${m.app}`;
    modulesOf.set(k, [...(modulesOf.get(k) ?? []), m.module]);
  }
  const powersOf = new Map<string, string[]>();
  for (const [app, rows] of [["erp", erp], ["hrms", hrms], ["tasks", tasks]] as const) {
    for (const r of rows) {
      const k = `${r.userId} ${app}`;
      powersOf.set(k, [...(powersOf.get(k) ?? []), r.power]);
    }
  }

  const out: ScreensBackfill = { converted: 0, refused: [], noted: [] };
  for (const g of grants) {
    const p = person.get(g.userId);
    if (!p) continue;
    const k = `${g.userId} ${g.app}`;
    const today: GrantToday = {
      app: g.app as AppId,
      role: (g.role as Role | null) ?? null,
      modules: modulesOf.get(k) ?? null,
      powers: powersOf.get(k) ?? [],
      platformAdmin: p.role === "admin",
    };
    const after = convertGrant(today);
    const diff = compareConversion(today, after);
    const line: GrantReport = { userId: g.userId, name: p.name, app: today.app, diff };
    if (diff.lost.length) {
      out.refused.push(line);
      continue;
    }
    if (diff.gained.length || diff.screensAdded.length || diff.lostWithScreen.length) out.noted.push(line);
    out.converted++;
    if (opts.dryRun) continue;

    await db.transaction(async (tx) => {
      await tx.delete(appScreenAccess).where(and(eq(appScreenAccess.userId, g.userId), eq(appScreenAccess.app, today.app)));
      const rows = [...after.screens].map(([screen, t]) => ({
        id: `scr_${randomUUID().slice(0, 16)}`,
        userId: g.userId,
        app: today.app,
        screen,
        canEdit: t.edit,
        canDelete: t.delete,
        editByDelete: t.autoEdit,
        grantedById: null,
      }));
      if (rows.length) await tx.insert(appScreenAccess).values(rows);
      await tx.update(appAccess).set({ position: after.position }).where(and(eq(appAccess.userId, g.userId), eq(appAccess.app, today.app)));
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        /* A terminal wears no hat: nobody is recorded, as `app:grant` records it. */
        actorId: null,
        action: "access.screens-backfill",
        entityType: "user",
        entityId: g.userId,
        afterState: {
          detail: `converted ${today.app} to position and screens (access-screens-backfill)`,
          app: today.app,
          position: after.position,
          screens: rows.length,
          gained: diff.gained,
          screensAdded: diff.screensAdded,
        } as never,
      });
    });
  }
  return out;
}

export function accessScreensBackfillReport(r: ScreensBackfill, dryRun: boolean): string {
  return [
    `${dryRun ? "dry run: " : ""}${r.converted} ${r.converted === 1 ? "grant" : "grants"} ${dryRun ? "would be converted" : "converted"}`,
    r.refused.length ? `${r.refused.length} refused — would lose something on a screen still held` : "",
    r.noted.length ? `${r.noted.length} with something to read` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
