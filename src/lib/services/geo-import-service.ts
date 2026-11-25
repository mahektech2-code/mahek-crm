import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  geoLocalBodies,
  geoReviewFlags,
  geoSources,
  geoUlbDistricts,
  geoUlbSubdistricts,
  geoUnits,
  geoUnresolvedRecords,
} from "@/db/schema";
import type { GeoSnapshot } from "@/lib/geography/geo-snapshot";
import type { ReviewFlagRow } from "@/lib/geography/lgd-india-ulb";

/* ---------------------------------------------------------------------------
 * WRITING A VALIDATED GEOGRAPHY SNAPSHOT — the only door the master is filled by.
 *
 * It takes what `buildGeoSnapshot` accepted and writes it, and it is SAFE TO RERUN:
 * every row has a deterministic id from the source's own code (`geo:district:480`),
 * so a second run updates the same rows and creates no duplicate. Links
 * (ULB↔taluka, ULB↔district) are replaced for the ULBs in the snapshot, and the
 * unresolved records of this source are replaced, so a corrected report corrects
 * them rather than adding to them.
 *
 * It NEVER DELETES a unit or a ULB: a place that has left a later report stays
 * until somebody decides, because an allocation may name it. It touches no
 * `mbos_user_territories` row, no `places` row and no customer.
 * ------------------------------------------------------------------------- */

export type SourceMeta = {
  id: string;
  name: string;
  sourceClass: "official" | "community_mirror" | "derived";
  url: string | null;
  observedOn: string | null;
  retrievedOn: string | null;
  checksum: string | null;
  licenceStatus: "unverified" | "verified" | "blocked";
  licenceNote: string;
};

export type WriteOptions = {
  /**
   * ADDITIVE: only ever add. Existing taluka and district links are left alone, and a
   * ULB's existing row keeps the type CODE / census / local name an earlier source gave
   * it. Used by a source that is poorer than one already loaded (the All-India file has
   * no talukas), so loading it cannot erase Maharashtra's.
   */
  additive?: boolean;
  flags?: ReviewFlagRow[];
};

export type ImportCounts = {
  units: number;
  ulbs: number;
  ulbSubdistricts: number;
  ulbDistricts: number;
  unresolved: number;
  flags: number;
};

const LEVEL_ORDER = { state: 0, district: 1, subdistrict: 2 } as const;

export async function writeGeoSnapshot(snapshot: GeoSnapshot, source: SourceMeta, options: WriteOptions = {}): Promise<ImportCounts> {
  const additive = options.additive === true;
  const flags = options.flags ?? [];
  const units = [...snapshot.units].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  await db.transaction(async (tx) => {
    await tx
      .insert(geoSources)
      .values({ ...source })
      .onConflictDoUpdate({
        target: geoSources.id,
        set: {
          name: source.name,
          sourceClass: source.sourceClass,
          url: source.url,
          observedOn: source.observedOn,
          retrievedOn: source.retrievedOn,
          checksum: source.checksum,
          licenceStatus: source.licenceStatus,
          licenceNote: source.licenceNote,
        },
      });

    for (const u of units) {
      const row = { ...u, sourceId: source.id };
      if (additive) {
        await tx.insert(geoUnits).values(row).onConflictDoNothing();
        continue;
      }
      await tx
        .insert(geoUnits)
        .values(row)
        .onConflictDoUpdate({
          target: geoUnits.id,
          set: {
            name: row.name,
            nameKey: row.nameKey,
            parentId: row.parentId,
            version: row.version,
            census2011Code: row.census2011Code,
            stateOrUt: row.stateOrUt,
            sourceId: row.sourceId,
          },
        });
    }

    for (const u of snapshot.ulbs) {
      const row = { ...u, sourceId: source.id };
      await tx
        .insert(geoLocalBodies)
        .values(row)
        .onConflictDoUpdate({
          target: geoLocalBodies.id,
          set: additive
            ? { typeName: row.typeName }
            : {
                name: row.name,
                nameKey: row.nameKey,
                nameLocal: row.nameLocal,
                typeCode: row.typeCode,
                typeName: row.typeName,
                stateUnitId: row.stateUnitId,
                version: row.version,
                census2011Code: row.census2011Code,
                sourceId: row.sourceId,
              },
        });
    }

    const ulbIds = snapshot.ulbs.map((u) => u.id);
    if (!additive) {
      for (let i = 0; i < ulbIds.length; i += 500) {
        const chunk = ulbIds.slice(i, i + 500);
        await tx.delete(geoUlbSubdistricts).where(inArray(geoUlbSubdistricts.ulbId, chunk));
        await tx.delete(geoUlbDistricts).where(inArray(geoUlbDistricts.ulbId, chunk));
      }
    }
    for (let i = 0; i < snapshot.ulbSubdistricts.length; i += 500) {
      await tx.insert(geoUlbSubdistricts).values(snapshot.ulbSubdistricts.slice(i, i + 500).map((l) => ({ ...l, sourceId: source.id }))).onConflictDoNothing();
    }
    for (let i = 0; i < snapshot.ulbDistricts.length; i += 500) {
      await tx.insert(geoUlbDistricts).values(snapshot.ulbDistricts.slice(i, i + 500).map((l) => ({ ...l, sourceId: source.id }))).onConflictDoNothing();
    }

    // The source's own review flags, kept as written. Replaced per source so a re-run does not stack them.
    await tx.delete(geoReviewFlags).where(eq(geoReviewFlags.sourceId, source.id));
    for (let i = 0; i < flags.length; i += 500) {
      await tx.insert(geoReviewFlags).values(
        flags.slice(i, i + 500).map((f) => ({
          id: `geo_flag:${source.id}:${f.flag}:${f.ulbId}:${f.districtId ?? "none"}`,
          sourceId: source.id,
          ulbId: f.ulbId,
          districtId: f.districtId,
          flag: f.flag,
          note: f.note,
        })),
      );
    }

    await tx.delete(geoUnresolvedRecords).where(eq(geoUnresolvedRecords.sourceId, source.id));
    if (snapshot.unresolved.length) {
      await tx.insert(geoUnresolvedRecords).values(
        snapshot.unresolved.map((r) => ({
          id: `geo_unres:${source.id}:${r.kind}:${r.lgdCode}`,
          sourceId: source.id,
          kind: r.kind,
          lgdCode: r.lgdCode,
          name: r.name,
          stateName: r.stateName,
          note: r.note,
        })),
      );
    }
  });

  return {
    units: units.length,
    ulbs: snapshot.ulbs.length,
    ulbSubdistricts: snapshot.ulbSubdistricts.length,
    ulbDistricts: snapshot.ulbDistricts.length,
    unresolved: snapshot.unresolved.length,
    flags: flags.length,
  };
}

/** What the master holds for one source, counted from the database — for checking a write against the snapshot. */
export async function countGeoSource(sourceId: string) {
  const [units, ulbs, subs, dists, unresolved] = await Promise.all([
    db.select({ id: geoUnits.id, level: geoUnits.level }).from(geoUnits).where(eq(geoUnits.sourceId, sourceId)),
    db.select({ id: geoLocalBodies.id }).from(geoLocalBodies).where(eq(geoLocalBodies.sourceId, sourceId)),
    db.select({ u: geoUlbSubdistricts.ulbId }).from(geoUlbSubdistricts).where(eq(geoUlbSubdistricts.sourceId, sourceId)),
    db.select({ u: geoUlbDistricts.ulbId }).from(geoUlbDistricts).where(eq(geoUlbDistricts.sourceId, sourceId)),
    db.select({ id: geoUnresolvedRecords.id }).from(geoUnresolvedRecords).where(and(eq(geoUnresolvedRecords.sourceId, sourceId))),
  ]);
  const by = (l: string) => units.filter((u) => u.level === l).length;
  return {
    states: by("state"),
    districts: by("district"),
    subdistricts: by("subdistrict"),
    ulbs: ulbs.length,
    ulbSubdistricts: subs.length,
    ulbDistricts: dists.length,
    unresolved: unresolved.length,
  };
}
