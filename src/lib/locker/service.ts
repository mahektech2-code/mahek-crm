import "server-only";
import { cache } from "react";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  lockerAssetTypes,
  lockerAssets,
  lockerEntities,
  lockerPaymentMethods,
  lockerReminderSchedules,
  lockerSettings,
  lockerSites,
  employees,
  users,
} from "@/db/schema";
import { today } from "@/lib/format";
import { DEFAULT_LADDERS, type TimeModel } from "./catalogue";
import { lockerAccess } from "./access";
import { actionDays, daysLeft, daysSinceCheck, isComplete, isLive, isUnchecked, statusOf, type Status } from "./engine";
import { mergeSettings, type LockerSettings } from "./settings";

/* ---------------------------------------------------------------------------
 * THE LOCKER'S READS. One read of the register, scoped to the categories the
 * person may open and decorated with everything derived (status, days left,
 * the day somebody must act, whether it has been checked) — so the dashboard,
 * the register, the calendar and the risk screen are one function apart and
 * cannot disagree about a single asset.
 *
 * The register is a few thousand rows at most (the design's full book is
 * ~1,100), which is why it is read whole and filtered in memory: every screen
 * needs counts across all of it, and a count per filter in SQL would be the
 * same rows read twenty times.
 * ------------------------------------------------------------------------- */

export type AssetType = typeof lockerAssetTypes.$inferSelect;
/** `title` and `code` come from the HR employee master where the account is linked to one. */
export type Person = { id: string; name: string; title: string; code: string; email: string | null };

export type AssetRow = typeof lockerAssets.$inferSelect & {
  type: AssetType;
  model: TimeModel;
  status: Status;
  /** End date minus today, in days; null for lifetime. */
  d: number | null;
  /** Days until somebody must act (notice day for a contract). */
  actionIn: number | null;
  live: boolean;
  unchecked: boolean;
  checkedAgo: number | null;
  complete: boolean;
  ownerName: string | null;
  backupName: string | null;
  entityName: string | null;
  siteName: string | null;
  siteState: string | null;
};

export const lockerTypes = cache(async function lockerTypes(): Promise<AssetType[]> {
  return db.select().from(lockerAssetTypes).orderBy(asc(lockerAssetTypes.category), asc(lockerAssetTypes.name));
});

export const lockerEntitiesList = cache(async () => db.select().from(lockerEntities).orderBy(asc(lockerEntities.name)));
export const lockerSitesList = cache(async () => db.select().from(lockerSites).orderBy(asc(lockerSites.name)));
export const lockerPaymentMethodsList = cache(async () => db.select().from(lockerPaymentMethods).orderBy(asc(lockerPaymentMethods.label)));

/** Everybody who can be named as an owner, backup or approver: active MahekOne accounts. */
export const lockerPeople = cache(async function lockerPeople(): Promise<Person[]> {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, position: employees.position, code: employees.employeeCode })
    .from(users)
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.active, true))
    .orderBy(asc(users.name));
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, title: r.position ?? "", code: r.code ?? "" }));
});

export const lockerSettingsRow = cache(async function lockerSettingsRow(): Promise<LockerSettings> {
  const [row] = await db.select().from(lockerSettings).where(eq(lockerSettings.id, "locker"));
  return mergeSettings(row?.values);
});

export const reminderLadders = cache(async function reminderLadders(): Promise<Record<number, number[]>> {
  const rows = await db.select().from(lockerReminderSchedules);
  const out: Record<number, number[]> = { ...DEFAULT_LADDERS };
  for (const r of rows) out[r.criticality] = r.offsets;
  return out;
});

/** Every asset, decorated. Unscoped — callers that show it to a person use `registerFor`. */
export const allAssets = cache(async function allAssets(day: string = today()): Promise<AssetRow[]> {
  const [rows, types, people, ents, sites] = await Promise.all([
    db.select().from(lockerAssets),
    lockerTypes(),
    db.select({ id: users.id, name: users.name }).from(users),
    lockerEntitiesList(),
    lockerSitesList(),
  ]);
  const T = new Map(types.map((t) => [t.code, t]));
  const P = new Map(people.map((p) => [p.id, p.name]));
  const E = new Map(ents.map((e) => [e.id, e.name]));
  const S = new Map(sites.map((s) => [s.id, s]));
  return rows.flatMap((a) => {
    const type = T.get(a.typeCode);
    if (!type) return [];
    const model = type.model as TimeModel;
    const status = statusOf(a, type, day);
    const site = a.siteId ? S.get(a.siteId) : undefined;
    return [
      {
        ...a,
        type,
        model,
        status,
        d: daysLeft(a.endDate, day),
        actionIn: actionDays(a, model, day),
        live: isLive(a),
        unchecked: isUnchecked(a, day),
        checkedAgo: daysSinceCheck(a, day),
        complete: isComplete(a, day),
        ownerName: a.ownerId ? (P.get(a.ownerId) ?? null) : null,
        backupName: a.backupId ? (P.get(a.backupId) ?? null) : null,
        entityName: a.entityId ? (E.get(a.entityId) ?? null) : null,
        siteName: site?.name ?? null,
        siteState: site?.state ?? null,
      },
    ];
  });
});

/** The register as THIS person may see it: only the categories they hold. */
export async function registerFor(userId: string, day: string = today()): Promise<AssetRow[]> {
  const [access, rows] = await Promise.all([lockerAccess(userId), allAssets(day)]);
  return rows.filter((a) => access.catOk(a.category));
}

export async function assetFor(userId: string, id: string): Promise<AssetRow | null> {
  const rows = await registerFor(userId);
  return rows.find((a) => a.id === id) ?? null;
}

export async function assetsByIds(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(lockerAssets).where(and(inArray(lockerAssets.id, ids)));
}

export { today };
