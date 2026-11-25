import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  geoLocalBodies,
  geoReviewFlags,
  geoUlbDistricts,
  geoUlbSubdistricts,
  geoUnits,
  mbosUserGeoTerritories,
} from "@/db/schema";
import { indexGeo, normalizeGeoPicks, type GeoAllocation, type GeoData, type GeoPick } from "@/lib/geography/geo-picker";

/* ---------------------------------------------------------------------------
 * THE OFFICIAL GEOGRAPHY MASTER, READ AND ALLOCATED. ADDITIVE.
 *
 * Nothing here is read by `territoryClause`, `places` or any shop match, and no
 * existing territory is touched. Until a reviewed snapshot is loaded the master
 * is empty and `loadGeoData` says so with `null`, so the screen can name the gap
 * instead of drawing an empty picker.
 * ------------------------------------------------------------------------- */

/** Whether anything has been loaded — one count, so a page can say so without carrying the master. */
export async function hasGeoMaster(): Promise<boolean> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(geoUnits);
  return n > 0;
}

/** The whole master, or null while nothing has been loaded. */
export async function loadGeoData(): Promise<GeoData | null> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(geoUnits);
  if (!n) return null;

  const [units, ulbs, subLinks, districtLinks, flags] = await Promise.all([
    db
      .select({ id: geoUnits.id, level: geoUnits.level, name: geoUnits.name, parentId: geoUnits.parentId })
      .from(geoUnits)
      .orderBy(asc(geoUnits.name)),
    db
      .select({ id: geoLocalBodies.id, name: geoLocalBodies.name, lgdCode: geoLocalBodies.lgdCode, stateUnitId: geoLocalBodies.stateUnitId, typeCode: geoLocalBodies.typeCode, typeName: geoLocalBodies.typeName })
      .from(geoLocalBodies)
      .orderBy(asc(geoLocalBodies.name)),
    db.select({ ulbId: geoUlbSubdistricts.ulbId, subdistrictId: geoUlbSubdistricts.subdistrictId }).from(geoUlbSubdistricts),
    db.select({ ulbId: geoUlbDistricts.ulbId, districtId: geoUlbDistricts.districtId }).from(geoUlbDistricts),
    db.selectDistinct({ ulbId: geoReviewFlags.ulbId, flag: geoReviewFlags.flag }).from(geoReviewFlags),
  ]);

  return {
    units: units.map((u) => ({ ...u, level: u.level as GeoData["units"][number]["level"] })),
    ulbs,
    ulbSubdistricts: subLinks,
    ulbDistricts: districtLinks,
    ulbFlags: flags.map((f) => ({ ulbId: f.ulbId, flag: f.flag as NonNullable<GeoData["ulbFlags"]>[number]["flag"] })),
  };
}

/** What somebody is allocated in the official geography. Empty means nothing. */
export async function geoAllocationsFor(userId: string): Promise<GeoAllocation[]> {
  const rows = await db
    .select({ level: mbosUserGeoTerritories.level, unitId: mbosUserGeoTerritories.unitId, ulbId: mbosUserGeoTerritories.ulbId })
    .from(mbosUserGeoTerritories)
    .where(eq(mbosUserGeoTerritories.userId, userId));
  return rows.map((r) => ({ level: r.level as GeoAllocation["level"], unitId: r.unitId, ulbId: r.ulbId }));
}

/** Everybody's official allocations in one read, keyed by user — for a list of people. */
export async function geoAllocationsByUser(): Promise<Record<string, GeoAllocation[]>> {
  const rows = await db
    .select({
      userId: mbosUserGeoTerritories.userId,
      level: mbosUserGeoTerritories.level,
      unitId: mbosUserGeoTerritories.unitId,
      ulbId: mbosUserGeoTerritories.ulbId,
    })
    .from(mbosUserGeoTerritories);
  const out: Record<string, GeoAllocation[]> = {};
  for (const r of rows) {
    (out[r.userId] ??= []).push({ level: r.level as GeoAllocation["level"], unitId: r.unitId, ulbId: r.ulbId });
  }
  return out;
}

/**
 * The names of the urban local bodies somebody is allocated BY NAME — what the
 * Propose days box offers beside his working towns. Names are the source's own
 * spelling; nothing is aliased or cleaned.
 */
export async function geoCityNamesFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: geoLocalBodies.name })
    .from(mbosUserGeoTerritories)
    .innerJoin(geoLocalBodies, eq(geoLocalBodies.id, mbosUserGeoTerritories.ulbId))
    .where(eq(mbosUserGeoTerritories.userId, userId));
  return rows.map((r) => r.name);
}

/**
 * Replace somebody's official allocations with the narrowest set of these picks:
 * a ULB ticked through several talukas is one row, and a wider pick that a
 * narrower one hangs from is dropped (`normalizeGeoPicks`). Returns what was
 * stored. Unknown ids are dropped there, never guessed.
 */
export async function setGeoAllocations(
  userId: string,
  picks: ReadonlyArray<GeoPick>,
  actorId: string,
  newId: () => string,
): Promise<{ before: GeoAllocation[]; after: GeoAllocation[] }> {
  const data = await loadGeoData();
  if (!data) throw new Error("The geography master has not been loaded yet, so there is nothing to allocate.");
  const after = normalizeGeoPicks(indexGeo(data), picks);

  const before = await geoAllocationsFor(userId);
  await db.transaction(async (tx) => {
    await tx.delete(mbosUserGeoTerritories).where(eq(mbosUserGeoTerritories.userId, userId));
    if (after.length) {
      await tx.insert(mbosUserGeoTerritories).values(
        after.map((a) => ({ id: newId(), userId, level: a.level, unitId: a.unitId, ulbId: a.ulbId, createdById: actorId })),
      );
    }
  });
  return { before, after };
}
