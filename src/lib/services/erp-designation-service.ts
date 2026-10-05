import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  erpDesignationModules,
  erpDesignationPowers,
  erpDesignations,
  erpUserDesignations,
  erpUserPowers,
  users,
} from "@/db/schema";
import { moduleKeysForApp } from "@/lib/modules";
import { isErpPower } from "@/lib/erp/powers";
import {
  designationShape,
  diffFromDesignation,
  heldShape,
  isEmptyDiff,
  type DesignationDiff,
  type ErpDesignationDef,
  type ErpHeld,
  type ErpLevel,
} from "@/lib/erp/designations";

/* ---------------------------------------------------------------------------
 * ERP designations, read. The arithmetic is `lib/erp/designations.ts`; this is
 * where it meets the tables. Writes are `lib/actions/erp-designations.ts` and,
 * for one person, `setAccess`.
 * ------------------------------------------------------------------------- */

const asLevel = (v: string | null | undefined): ErpLevel => (v === "admin" || v === "manager" ? v : "associate");

export async function listErpDesignations(): Promise<ErpDesignationDef[]> {
  const [rows, mods, pows] = await Promise.all([
    db.select().from(erpDesignations).orderBy(asc(erpDesignations.sortOrder), asc(erpDesignations.name)),
    db.select().from(erpDesignationModules),
    db.select().from(erpDesignationPowers),
  ]);
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    level: asLevel(d.level),
    allScreens: d.allScreens,
    modules: mods.filter((m) => m.designationId === d.id).map((m) => m.module).sort(),
    powers: pows.filter((p) => p.designationId === d.id).map((p) => p.power).filter(isErpPower),
  }));
}

export async function getErpDesignation(id: string): Promise<ErpDesignationDef | null> {
  return (await listErpDesignations()).find((d) => d.id === id) ?? null;
}

/** What each of these people holds in the ERP today; absent means they do not hold it. */
export async function erpHeldBy(userIds?: string[]): Promise<Map<string, ErpHeld>> {
  if (userIds && !userIds.length) return new Map();
  const [grants, mods, pows] = await Promise.all([
    db
      .select({ userId: appAccess.userId, role: appAccess.role })
      .from(appAccess)
      .where(userIds ? and(eq(appAccess.app, "erp"), inArray(appAccess.userId, userIds)) : eq(appAccess.app, "erp")),
    db
      .select({ userId: appModuleAccess.userId, module: appModuleAccess.module })
      .from(appModuleAccess)
      .where(userIds ? and(eq(appModuleAccess.app, "erp"), inArray(appModuleAccess.userId, userIds)) : eq(appModuleAccess.app, "erp")),
    db
      .select({ userId: erpUserPowers.userId, power: erpUserPowers.power })
      .from(erpUserPowers)
      .where(userIds ? inArray(erpUserPowers.userId, userIds) : undefined),
  ]);
  const out = new Map<string, ErpHeld>();
  for (const g of grants) {
    out.set(g.userId, {
      level: asLevel(g.role),
      moduleRows: mods.filter((m) => m.userId === g.userId).map((m) => m.module),
      powers: pows.filter((p) => p.userId === g.userId).map((p) => p.power),
    });
  }
  return out;
}

export type DesignationStanding = {
  id: string;
  name: string;
  /** True while their access is exactly the designation's — an edit to it moves them. */
  matches: boolean;
  diff: DesignationDiff;
};

/** Who holds a designation, and whether each still matches it. */
export async function designationStandings(): Promise<Map<string, DesignationStanding>> {
  const [defs, links, held] = await Promise.all([
    listErpDesignations(),
    db.select({ userId: erpUserDesignations.userId, designationId: erpUserDesignations.designationId }).from(erpUserDesignations),
    erpHeldBy(),
  ]);
  const all = moduleKeysForApp("erp");
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out = new Map<string, DesignationStanding>();
  for (const l of links) {
    const d = byId.get(l.designationId);
    const h = held.get(l.userId);
    if (!d || !h) continue;
    const diff = diffFromDesignation(heldShape(h, all), designationShape(d, all), all);
    out.set(l.userId, { id: d.id, name: d.name, matches: isEmptyDiff(diff), diff });
  }
  return out;
}

export type DesignationMember = {
  userId: string;
  name: string;
  email: string | null;
  active: boolean;
  matches: boolean;
  diff: DesignationDiff;
};

export type DesignationWithMembers = ErpDesignationDef & { members: DesignationMember[] };

/** Every designation with the people who hold it — the Designations page. */
export async function designationRoster(): Promise<DesignationWithMembers[]> {
  const [defs, standings, people] = await Promise.all([
    listErpDesignations(),
    designationStandings(),
    db.select({ id: users.id, name: users.name, email: users.email, active: users.active }).from(users),
  ]);
  const person = new Map(people.map((p) => [p.id, p]));
  return defs.map((d) => ({
    ...d,
    members: [...standings]
      .filter(([, s]) => s.id === d.id)
      .map(([userId, s]) => ({
        userId,
        name: person.get(userId)?.name ?? userId,
        email: person.get(userId)?.email ?? null,
        active: person.get(userId)?.active ?? false,
        matches: s.matches,
        diff: s.diff,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export type PreviewTargets = {
  designations: { id: string; name: string }[];
  people: { id: string; name: string; designation: string | null }[];
};

/** What an ERP administrator may preview the ERP as: every designation, and everybody who holds the ERP. */
export async function erpPreviewTargets(): Promise<PreviewTargets> {
  const [defs, holders, links] = await Promise.all([
    listErpDesignations(),
    db
      .select({ id: users.id, name: users.name })
      .from(appAccess)
      .innerJoin(users, eq(users.id, appAccess.userId))
      .where(and(eq(appAccess.app, "erp"), eq(users.active, true)))
      .orderBy(asc(users.name)),
    db.select({ userId: erpUserDesignations.userId, name: erpDesignations.name }).from(erpUserDesignations).innerJoin(erpDesignations, eq(erpDesignations.id, erpUserDesignations.designationId)),
  ]);
  const designationOf = new Map(links.map((l) => [l.userId, l.name]));
  return {
    designations: defs.map((d) => ({ id: d.id, name: d.name })),
    people: holders.map((p) => ({ id: p.id, name: p.name, designation: designationOf.get(p.id) ?? null })),
  };
}
