"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  auditLog,
  erpDesignationModules,
  erpDesignationPowers,
  erpDesignations,
  erpUserDesignations,
  users,
} from "@/db/schema";
import { requirePlatformAdminUser, widestRole, type Role } from "@/lib/access-control";
import { ConsoleNotConfirmedError } from "@/lib/console-confirm";
import { moduleKeysForApp } from "@/lib/modules";
import { isErpPower } from "@/lib/erp/powers";
import { isDepartmentSeat, SEAT_LABEL, type ErpDepartmentSeat } from "@/lib/erp/departments";
import {
  designationShape,
  draftFor,
  grantableModules,
  heldShape,
  matchesDesignation,
  type ErpLevel,
} from "@/lib/erp/designations";
import { erpHeldBy, getErpDesignation } from "@/lib/services/erp-designation-service";
import { writeErpPowers, writeModules } from "@/lib/services/access-writes";
import { notifyUsers } from "@/lib/notify";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import { ADMIN } from "@/lib/admin-routes";

/* ---------------------------------------------------------------------------
 * Creating, editing and deleting ERP designations.
 *
 * A designation is LINKED: editing one moves everybody who still holds
 * exactly what it held, in the same transaction as the edit, and leaves alone
 * everybody somebody customised by hand — because that difference is a
 * decision a person made about one person, and an edit to "Quality tester"
 * says nothing about it. Who matches is measured against the designation AS
 * IT WAS, before this edit, with the same arithmetic the Access dialog shows.
 *
 * Platform administrators only, the same door as `setAccess`: a designation
 * IS access, granted to several people at once.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const LEVELS: ErpLevel[] = ["associate", "manager", "admin"];

async function actor() {
  try {
    return await requirePlatformAdminUser();
  } catch (e) {
    if (e instanceof ConsoleNotConfirmedError) throw e;
    throw new Error("Only a platform administrator can change designations.");
  }
}

async function audit(actorId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId,
    action,
    entityType,
    entityId,
    actorRole: "admin",
    actorApp: "admin",
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

function refresh() {
  try {
    revalidatePath(ADMIN.designations);
    revalidatePath(ADMIN.access);
    revalidatePath("/erp", "layout");
  } catch {
    /* outside a request */
  }
}

export type DesignationInput = {
  /** Absent creates one. */
  id?: string | null;
  name: string;
  description?: string | null;
  level: ErpLevel;
  allScreens: boolean;
  modules: string[];
  powers: string[];
  /** The production department; null or absent for any other job. */
  department?: ErpDepartmentSeat | null;
};

export type DesignationSaved = {
  id: string;
  /** People whose access moved with the edit. */
  moved: string[];
  /** Holders left alone because they were customised. */
  leftAlone: string[];
};

export async function saveErpDesignation(input: DesignationInput): Promise<Result<DesignationSaved>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return err(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) return fieldErr("name", "A designation needs a name.");
  if (name.length > 60) return fieldErr("name", "Keep the name under 60 characters.");
  if (!LEVELS.includes(input.level)) return fieldErr("level", "Not a level.");
  const all = moduleKeysForApp("erp");
  const modules = input.allScreens ? [] : grantableModules(input.modules).filter((k) => all.includes(k));
  const unknown = grantableModules(input.modules).filter((k) => !all.includes(k));
  if (unknown.length) return fieldErr("modules", `Not an ERP screen: ${unknown.join(", ")}`);
  if (!input.allScreens && !modules.length) {
    return fieldErr("modules", "Tick at least one screen. A designation that opens nothing but the dashboard is not a job.");
  }
  /* An administrator holds every power without a row, so rows on an admin
     designation would be a list nothing reads. */
  const powers = input.level === "admin" ? [] : [...new Set(input.powers)].filter(isErpPower);
  if (input.department != null && !isDepartmentSeat(input.department)) return fieldErr("department", "Not a department.");
  const department = input.department ?? null;

  const clash = await db
    .select({ id: erpDesignations.id })
    .from(erpDesignations)
    .where(input.id ? and(eq(erpDesignations.name, name), ne(erpDesignations.id, input.id)) : eq(erpDesignations.name, name))
    .limit(1);
  if (clash.length) return fieldErr("name", "Another designation already has that name.");

  const before = input.id ? await getErpDesignation(input.id) : null;
  if (input.id && !before) return err("That designation no longer exists.", "not_found");
  const id = before?.id ?? newId("erpd");
  const next = { level: input.level, allScreens: input.allScreens, modules, powers };

  /* WHO MOVES: the holders whose access is exactly the designation as it was. */
  const links = before
    ? await db.select({ userId: erpUserDesignations.userId }).from(erpUserDesignations).where(eq(erpUserDesignations.designationId, id))
    : [];
  const held = await erpHeldBy(links.map((l) => l.userId));
  const oldShape = before ? designationShape(before, all) : null;
  const moving = links.map((l) => l.userId).filter((u) => {
    const h = held.get(u);
    return !!h && !!oldShape && matchesDesignation(heldShape(h, all), oldShape, all);
  });
  const leftAlone = links.map((l) => l.userId).filter((u) => !moving.includes(u));
  const draft = draftFor(next, all);

  await db.transaction(async (tx) => {
    if (before) {
      await tx
        .update(erpDesignations)
        .set({ name, description: input.description?.trim() || null, level: input.level, allScreens: input.allScreens, department, updatedAt: new Date(), updatedById: me.id })
        .where(eq(erpDesignations.id, id));
    } else {
      const [last] = await tx.select({ n: erpDesignations.sortOrder }).from(erpDesignations).orderBy(desc(erpDesignations.sortOrder)).limit(1);
      await tx.insert(erpDesignations).values({
        id,
        name,
        description: input.description?.trim() || null,
        level: input.level,
        allScreens: input.allScreens,
        department,
        sortOrder: (last?.n ?? 0) + 1000,
        updatedById: me.id,
      });
    }
    await tx.delete(erpDesignationModules).where(eq(erpDesignationModules.designationId, id));
    if (modules.length) await tx.insert(erpDesignationModules).values(modules.map((module) => ({ designationId: id, module })));
    await tx.delete(erpDesignationPowers).where(eq(erpDesignationPowers.designationId, id));
    if (powers.length) await tx.insert(erpDesignationPowers).values(powers.map((power) => ({ designationId: id, power })));

    /* THE HOLDERS WHO MATCHED, moved in the same transaction: a designation
       that saved while its people stayed behind would turn every one of them
       "customised" in a moment, and the next edit would reach nobody. */
    for (const userId of moving) {
      await tx.update(appAccess).set({ role: draft.level }).where(and(eq(appAccess.userId, userId), eq(appAccess.app, "erp")));
      await writeModules(tx, userId, "erp", draft.modules, me.id);
      await writeErpPowers(tx, userId, draft.powers, me.id);
      /* The account level is a cache of the hats — see `widestRole`. */
      const hats = await tx.select({ app: appAccess.app, role: appAccess.role }).from(appAccess).where(eq(appAccess.userId, userId));
      await tx
        .update(users)
        .set({ role: widestRole(hats.map((h) => ({ app: h.app, role: (h.role ?? "associate") as Role }))) })
        .where(eq(users.id, userId));
    }
  });

  const people = links.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, links.map((l) => l.userId)))
    : [];
  const nameOf = (u: string) => people.find((p) => p.id === u)?.name ?? u;

  await audit(
    me.id,
    before ? "access.erp-designation.edit" : "access.erp-designation.create",
    "erp_designation",
    id,
    before ? { name: before.name, level: before.level, allScreens: before.allScreens, modules: before.modules, powers: before.powers, department: before.department ?? null } : null,
    { name, level: input.level, allScreens: input.allScreens, modules, powers, department: department ? SEAT_LABEL[department] : null, moved: moving.map(nameOf), leftAlone: leftAlone.map(nameOf) },
  );
  for (const userId of moving) {
    await audit(me.id, "set-app-access", "user", userId, null, { detail: `ERP access moved with the ${name} designation` });
  }
  if (moving.length) {
    await notifyUsers(
      moving.map((userId) => ({
        userId,
        title: `Your ERP access changed — ${name}`,
        body: `The ${name} designation was updated, and your ERP screens and powers moved with it.`,
        href: "/erp/settings",
      })),
    );
  }
  refresh();

  const said = [
    before ? `${name} saved` : `${name} created`,
    moving.length ? `${moving.length} ${moving.length === 1 ? "person" : "people"} moved with it` : "",
    leftAlone.length ? `${leftAlone.length} customised left as they are` : "",
  ].filter(Boolean);
  return ok({ id, moved: moving.map(nameOf), leftAlone: leftAlone.map(nameOf) }, `${said.join(" · ")}.`);
}

/**
 * Delete a designation. Its holders KEEP their access exactly as it is and
 * simply stop holding the name — deleting a job title must never take a
 * screen away from anybody, and the dialog says so before it is pressed.
 */
export async function deleteErpDesignation(id: string): Promise<Result<{ unlinked: number }>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return err(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }
  const d = await getErpDesignation(id);
  if (!d) return err("That designation no longer exists.", "not_found");
  const links = await db.select({ userId: erpUserDesignations.userId }).from(erpUserDesignations).where(eq(erpUserDesignations.designationId, id));
  await db.transaction(async (tx) => {
    await tx.delete(erpUserDesignations).where(eq(erpUserDesignations.designationId, id));
    await tx.delete(erpDesignations).where(eq(erpDesignations.id, id));
  });
  await audit(me.id, "access.erp-designation.delete", "erp_designation", id, { name: d.name, holders: links.length }, null);
  refresh();
  return ok(
    { unlinked: links.length },
    links.length
      ? `${d.name} deleted. ${links.length} ${links.length === 1 ? "person keeps" : "people keep"} their ERP access, with no designation.`
      : `${d.name} deleted.`,
  );
}
