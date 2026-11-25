/* ---------------------------------------------------------------------------
 * VALIDATING AND SHAPING A GEOGRAPHY SNAPSHOT — PURE, no I/O, source-independent.
 *
 * This is the whole of the import MECHANISM and none of the DATA. It takes rows
 * in a plain, source-neutral shape (what an LGD export or a mirror of one
 * carries) and answers: is this internally consistent, and what exactly would be
 * written. It writes nothing and names no source. Loading a real snapshot is a
 * separate, approved step — see `geo_sources.licence_status`.
 *
 * NOTHING IS INVENTED. A code the source writes as "0" or leaves blank is MISSING,
 * and is reported as such; a parent that is not in the file is a problem, never
 * a guess; a name is kept as the source spells it (trailing dots and all) and is
 * folded only into `nameKey`, which is what a match compares on. A ULB TYPE CODE
 * IS KEPT AS TEXT AND NEVER GIVEN A LABEL — no legend has been verified.
 *
 * A ULB reaches a sub-district only through the coverage rows, and the link is
 * MANY-TO-MANY: one ULB can cover villages in several sub-districts, and one
 * sub-district can hold several ULBs.
 * ------------------------------------------------------------------------- */

import { cityKey } from "@/lib/city-match";

export type RawState = { code: string; name: string; version?: number | null; stateOrUt?: string | null; census2011Code?: string | null };
export type RawDistrict = { code: string; name: string; stateCode: string; census2011Code?: string | null };
export type RawSubdistrict = { code: string; name: string; districtCode: string; stateCode: string; version?: number | null; census2011Code?: string | null };
export type RawUlb = {
  code: string;
  name: string;
  stateCode: string;
  typeCode?: string | null;
  /** The type as the source names it, where the source does. */
  typeName?: string | null;
  version?: number | null;
  nameLocal?: string | null;
  census2011Code?: string | null;
};
/** One coverage row: a ULB, the district it sits in, and (where the source says) a sub-district and village. */
export type RawCoverage = {
  ulbCode: string;
  ulbName?: string | null;
  stateName?: string | null;
  districtCode: string;
  subdistrictCode: string;
  villageCode?: string | null;
};

export type GeoSnapshotInput = {
  states: RawState[];
  districts: RawDistrict[];
  subdistricts: RawSubdistrict[];
  ulbs: RawUlb[];
  coverage: RawCoverage[];
};

export type UnitRow = {
  id: string;
  level: "state" | "district" | "subdistrict";
  lgdCode: string;
  name: string;
  nameKey: string;
  parentId: string | null;
  version: number | null;
  census2011Code: string | null;
  stateOrUt: string | null;
};
export type UlbRow = {
  id: string;
  lgdCode: string;
  name: string;
  nameKey: string;
  nameLocal: string | null;
  typeCode: string | null;
  typeName: string | null;
  stateUnitId: string;
  version: number | null;
  census2011Code: string | null;
};
export type UlbSubdistrictRow = { ulbId: string; subdistrictId: string; districtId: string; villageRows: number };
export type UlbDistrictRow = { ulbId: string; districtId: string };
export type UnresolvedRow = {
  kind: "no_coverage" | "orphan_coverage";
  lgdCode: string;
  name: string | null;
  stateName: string | null;
  note: string;
};

export type Problem = { severity: "error" | "warning"; code: string; message: string };

export type GeoSnapshot = {
  units: UnitRow[];
  ulbs: UlbRow[];
  ulbSubdistricts: UlbSubdistrictRow[];
  ulbDistricts: UlbDistrictRow[];
  unresolved: UnresolvedRow[];
};

export type GeoValidation = {
  /** False when any ERROR was found. Warnings never block; they are reported. */
  ok: boolean;
  problems: Problem[];
  snapshot: GeoSnapshot;
  summary: {
    states: number;
    districts: number;
    subdistricts: number;
    ulbs: number;
    ulbsWithSubdistrict: number;
    /** ULBs the source ties to a district and no sub-district. */
    ulbsDistrictOnly: number;
    ulbsNoCoverage: number;
    orphanCoverageCodes: number;
    ulbsInSeveralSubdistricts: number;
  };
};

/** The ids are the source's own codes under a level prefix — stable, and never a guess. */
export const unitId = (level: UnitRow["level"], code: string) => `geo:${level}:${code}`;
export const ulbId = (code: string) => `geo:ulb:${code}`;

/** A code the source writes as nothing, or as the placeholder "0", is MISSING. */
export function isMissingCode(code: string | null | undefined): boolean {
  const c = (code ?? "").trim();
  return c === "" || /^0+$/.test(c);
}

const text = (v: string | null | undefined) => (v ?? "").trim();
const orNull = (v: string | null | undefined) => (isMissingCode(v) ? null : text(v));

export function buildGeoSnapshot(input: GeoSnapshotInput): GeoValidation {
  const problems: Problem[] = [];
  const err = (code: string, message: string) => problems.push({ severity: "error", code, message });
  const warn = (code: string, message: string) => problems.push({ severity: "warning", code, message });

  const units: UnitRow[] = [];
  const stateIds = new Set<string>();
  const districtIds = new Map<string, string>(); // district id -> its state id
  const subdistrictIds = new Map<string, string>(); // sub-district id -> its district id
  const seen = new Set<string>();

  const add = (row: UnitRow) => {
    if (seen.has(row.id)) {
      err("duplicate_unit", `${row.level} code ${row.lgdCode} appears more than once.`);
      return false;
    }
    seen.add(row.id);
    units.push(row);
    return true;
  };

  for (const s of input.states) {
    if (isMissingCode(s.code) || !text(s.name)) {
      err("state_missing", `A state row has no code or no name (code "${s.code}").`);
      continue;
    }
    const id = unitId("state", text(s.code));
    if (add({ id, level: "state", lgdCode: text(s.code), name: text(s.name), nameKey: cityKey(s.name), parentId: null, version: s.version ?? null, census2011Code: orNull(s.census2011Code), stateOrUt: s.stateOrUt ?? null })) {
      stateIds.add(id);
    }
  }

  for (const d of input.districts) {
    if (isMissingCode(d.code) || !text(d.name)) {
      err("district_missing", `A district row has no code or no name (code "${d.code}").`);
      continue;
    }
    const parent = unitId("state", text(d.stateCode));
    if (!stateIds.has(parent)) {
      err("district_parent", `District ${d.code} ${d.name} names state code ${d.stateCode}, which is not in the file.`);
      continue;
    }
    const id = unitId("district", text(d.code));
    if (add({ id, level: "district", lgdCode: text(d.code), name: text(d.name), nameKey: cityKey(d.name), parentId: parent, version: null, census2011Code: orNull(d.census2011Code), stateOrUt: null })) {
      districtIds.set(id, parent);
    }
  }

  for (const s of input.subdistricts) {
    if (isMissingCode(s.code) || !text(s.name)) {
      err("subdistrict_missing", `A sub-district row has no code or no name (code "${s.code}").`);
      continue;
    }
    const parent = unitId("district", text(s.districtCode));
    const parentState = districtIds.get(parent);
    if (!parentState) {
      err("subdistrict_parent", `Sub-district ${s.code} ${s.name} names district code ${s.districtCode}, which is not in the file.`);
      continue;
    }
    if (parentState !== unitId("state", text(s.stateCode))) {
      err("subdistrict_state_mismatch", `Sub-district ${s.code} ${s.name} names state ${s.stateCode}, but its district belongs to another state.`);
      continue;
    }
    const id = unitId("subdistrict", text(s.code));
    if (add({ id, level: "subdistrict", lgdCode: text(s.code), name: text(s.name), nameKey: cityKey(s.name), parentId: parent, version: s.version ?? null, census2011Code: orNull(s.census2011Code), stateOrUt: null })) {
      subdistrictIds.set(id, parent);
    }
  }

  const ulbs: UlbRow[] = [];
  const ulbById = new Map<string, UlbRow>();
  for (const u of input.ulbs) {
    if (isMissingCode(u.code) || !text(u.name)) {
      err("ulb_missing", `A local-body row has no code or no name (code "${u.code}").`);
      continue;
    }
    const id = ulbId(text(u.code));
    if (ulbById.has(id)) {
      err("duplicate_ulb", `Local body code ${u.code} appears more than once.`);
      continue;
    }
    const stateUnitId = unitId("state", text(u.stateCode));
    if (!stateIds.has(stateUnitId)) {
      err("ulb_state", `Local body ${u.code} ${u.name} names state code ${u.stateCode}, which is not in the file.`);
      continue;
    }
    const row: UlbRow = {
      id,
      lgdCode: text(u.code),
      name: text(u.name),
      nameKey: cityKey(u.name),
      nameLocal: text(u.nameLocal) || null,
      typeCode: text(u.typeCode) || null,
      typeName: text(u.typeName) || null,
      stateUnitId,
      version: u.version ?? null,
      census2011Code: orNull(u.census2011Code),
    };
    ulbs.push(row);
    ulbById.set(id, row);
  }

  // Coverage: the ONLY route from a ULB to a sub-district.
  const subLinks = new Map<string, UlbSubdistrictRow>();
  const districtLinks = new Map<string, UlbDistrictRow>();
  const coveredCodes = new Set<string>();
  const orphanCodes = new Map<string, { name: string | null; stateName: string | null }>();

  for (const c of input.coverage) {
    const code = text(c.ulbCode);
    if (isMissingCode(code)) {
      warn("coverage_no_ulb_code", "A coverage row has no local-body code and was left out.");
      continue;
    }
    const uid = ulbId(code);
    coveredCodes.add(uid);
    if (!ulbById.has(uid)) {
      if (!orphanCodes.has(code)) orphanCodes.set(code, { name: text(c.ulbName) || null, stateName: text(c.stateName) || null });
      continue;
    }
    const did = unitId("district", text(c.districtCode));
    if (!isMissingCode(c.districtCode) && districtIds.has(did)) {
      districtLinks.set(`${uid}|${did}`, { ulbId: uid, districtId: did });
    } else if (!isMissingCode(c.districtCode)) {
      err("coverage_district", `Coverage for local body ${code} names district code ${c.districtCode}, which is not in the file.`);
    }
    if (isMissingCode(c.subdistrictCode)) continue; // a district-level row: no sub-district stated
    const sid = unitId("subdistrict", text(c.subdistrictCode));
    const sdDistrict = subdistrictIds.get(sid);
    if (!sdDistrict) {
      err("coverage_subdistrict", `Coverage for local body ${code} names sub-district code ${c.subdistrictCode}, which is not in the file.`);
      continue;
    }
    if (sdDistrict !== did) {
      err("coverage_pair_mismatch", `Coverage for local body ${code} pairs sub-district ${c.subdistrictCode} with a district that is not its own.`);
      continue;
    }
    const key = `${uid}|${sid}`;
    const link = subLinks.get(key) ?? { ulbId: uid, subdistrictId: sid, districtId: sdDistrict, villageRows: 0 };
    if (!isMissingCode(c.villageCode)) link.villageRows += 1;
    subLinks.set(key, link);
  }

  const withSub = new Set([...subLinks.values()].map((l) => l.ulbId));
  const subCount = new Map<string, number>();
  for (const l of subLinks.values()) subCount.set(l.ulbId, (subCount.get(l.ulbId) ?? 0) + 1);

  const unresolved: UnresolvedRow[] = [];
  for (const u of ulbs) {
    if (!coveredCodes.has(u.id)) {
      unresolved.push({ kind: "no_coverage", lgdCode: u.lgdCode, name: u.name, stateName: null, note: "The source has no coverage row for this local body, so no district or sub-district is known." });
    }
  }
  for (const [code, o] of orphanCodes) {
    unresolved.push({ kind: "orphan_coverage", lgdCode: code, name: o.name, stateName: o.stateName, note: "A coverage row names this local-body code and no such local body is in the local-body file." });
  }

  const ulbsDistrictOnly = ulbs.filter((u) => coveredCodes.has(u.id) && !withSub.has(u.id) && [...districtLinks.values()].some((d) => d.ulbId === u.id)).length;

  return {
    ok: !problems.some((p) => p.severity === "error"),
    problems,
    snapshot: { units, ulbs, ulbSubdistricts: [...subLinks.values()], ulbDistricts: [...districtLinks.values()], unresolved },
    summary: {
      states: stateIds.size,
      districts: districtIds.size,
      subdistricts: subdistrictIds.size,
      ulbs: ulbs.length,
      ulbsWithSubdistrict: withSub.size,
      ulbsDistrictOnly,
      ulbsNoCoverage: unresolved.filter((r) => r.kind === "no_coverage").length,
      orphanCoverageCodes: orphanCodes.size,
      ulbsInSeveralSubdistricts: [...subCount.values()].filter((n) => n > 1).length,
    },
  };
}
