/* ---------------------------------------------------------------------------
 * THE PICKER'S RULES FOR THE OFFICIAL GEOGRAPHY — PURE and client-safe.
 *
 * State → district → taluka → city/town (urban local body), each level a
 * multi-select, each depending on the one above. What is offered comes from the
 * MASTER and not from the shops, so a place with no customer is still there.
 *
 * A ULB IS OFFERED UNDER EVERY TALUKA THE SOURCE LINKS IT TO, and is ONE
 * allocation however many of those talukas were ticked: the pick carries the
 * ULB's own id and `normalizeGeoPicks` collapses the rest. The ULBs the source
 * ties to a district and to no taluka are listed SEPARATELY (`unmappedUlbsIn`),
 * never inside a taluka they were not linked to.
 *
 * "City/Town" here means URBAN LOCAL BODIES — what the source actually holds. It
 * is not a list of every settlement in India and the screen must not say so.
 * ------------------------------------------------------------------------- */

export type GeoUnit = { id: string; level: "state" | "district" | "subdistrict"; name: string; parentId: string | null };
export type GeoUlb = { id: string; name: string; lgdCode: string; stateUnitId: string };
export type GeoData = {
  units: GeoUnit[];
  ulbs: GeoUlb[];
  /** ULB ↔ sub-district: many-to-many. */
  ulbSubdistricts: Array<{ ulbId: string; subdistrictId: string }>;
  /** ULB ↔ district, for every district the source puts it in. */
  ulbDistricts: Array<{ ulbId: string; districtId: string }>;
};

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export type GeoIndex = {
  unit: Map<string, GeoUnit>;
  ulb: Map<string, GeoUlb>;
  children: Map<string, GeoUnit[]>;
  ulbsBySub: Map<string, GeoUlb[]>;
  subsByUlb: Map<string, string[]>;
  ulbsByDistrict: Map<string, GeoUlb[]>;
};

export function indexGeo(data: GeoData): GeoIndex {
  const unit = new Map(data.units.map((u) => [u.id, u]));
  const ulb = new Map(data.ulbs.map((u) => [u.id, u]));
  const children = new Map<string, GeoUnit[]>();
  for (const u of data.units) {
    if (!u.parentId) continue;
    children.set(u.parentId, [...(children.get(u.parentId) ?? []), u]);
  }
  const ulbsBySub = new Map<string, GeoUlb[]>();
  const subsByUlb = new Map<string, string[]>();
  for (const l of data.ulbSubdistricts) {
    const u = ulb.get(l.ulbId);
    if (!u) continue;
    ulbsBySub.set(l.subdistrictId, [...(ulbsBySub.get(l.subdistrictId) ?? []), u]);
    subsByUlb.set(l.ulbId, [...(subsByUlb.get(l.ulbId) ?? []), l.subdistrictId]);
  }
  const ulbsByDistrict = new Map<string, GeoUlb[]>();
  for (const l of data.ulbDistricts) {
    const u = ulb.get(l.ulbId);
    if (!u) continue;
    ulbsByDistrict.set(l.districtId, [...(ulbsByDistrict.get(l.districtId) ?? []), u]);
  }
  return { unit, ulb, children, ulbsBySub, subsByUlb, ulbsByDistrict };
}

export const statesOf = (ix: GeoIndex): GeoUnit[] => [...ix.unit.values()].filter((u) => u.level === "state").sort(byName);

/** Districts of the ticked states — all of them, whether or not a shop is in one. */
export const districtsIn = (ix: GeoIndex, stateIds: Iterable<string>): GeoUnit[] =>
  [...stateIds].flatMap((id) => ix.children.get(id) ?? []).filter((u) => u.level === "district").sort(byName);

export const subdistrictsIn = (ix: GeoIndex, districtIds: Iterable<string>): GeoUnit[] =>
  [...districtIds].flatMap((id) => ix.children.get(id) ?? []).filter((u) => u.level === "subdistrict").sort(byName);

/** The ULBs linked to ONE taluka — what is drawn under that taluka. */
export const ulbsInSubdistrict = (ix: GeoIndex, subdistrictId: string): GeoUlb[] =>
  [...(ix.ulbsBySub.get(subdistrictId) ?? [])].sort(byName);

export type UlbOption = { ulb: GeoUlb; subdistrictIds: string[]; linkedSubdistrictCount: number };

/**
 * The combined ULBs of the ticked talukas, EACH ONCE. `subdistrictIds` says which
 * of the ticked talukas it was found under, and `linkedSubdistrictCount` how many
 * talukas the source links it to in all, so the screen can say "in several talukas".
 */
export function ulbsUnder(ix: GeoIndex, subdistrictIds: Iterable<string>): UlbOption[] {
  const ticked = new Set(subdistrictIds);
  const found = new Map<string, UlbOption>();
  for (const sid of ticked) {
    for (const ulb of ix.ulbsBySub.get(sid) ?? []) {
      const entry = found.get(ulb.id) ?? { ulb, subdistrictIds: [], linkedSubdistrictCount: (ix.subsByUlb.get(ulb.id) ?? []).length };
      entry.subdistrictIds.push(sid);
      found.set(ulb.id, entry);
    }
  }
  return [...found.values()].sort((a, b) => byName(a.ulb, b.ulb));
}

/** ULBs the source puts in these districts and in NO taluka — shown apart, never under a taluka. */
export function unmappedUlbsIn(ix: GeoIndex, districtIds: Iterable<string>): GeoUlb[] {
  const out = new Map<string, GeoUlb>();
  for (const did of districtIds) {
    for (const ulb of ix.ulbsByDistrict.get(did) ?? []) {
      if (!(ix.subsByUlb.get(ulb.id) ?? []).length) out.set(ulb.id, ulb);
    }
  }
  return [...out.values()].sort(byName);
}

/* ------------------------------------------------------------ what is saved */

export type GeoPick =
  | { kind: "unit"; unitId: string }
  /** `viaUnitId` is the taluka (or, for a ULB with no taluka, the district) it was ticked under. */
  | { kind: "ulb"; ulbId: string; viaUnitId?: string };

export type GeoAllocation = { level: "state" | "district" | "subdistrict" | "ulb"; unitId: string | null; ulbId: string | null };

/**
 * WHAT TO STORE FOR A SET OF PICKS.
 *
 *   - The same ULB picked through several talukas is ONE allocation.
 *   - The narrowest pick in a branch is the allocation: a unit with a picked
 *     unit below it, or a taluka that a ULB was ticked UNDER, is the path to that
 *     pick and not a second grant — stored as both, the rule would hand over
 *     the whole of the wider one. (The same rule `territoryLeaves` keeps.)
 *   - A pick that names nothing in the master is dropped, not guessed at.
 */
export function normalizeGeoPicks(ix: GeoIndex, picks: ReadonlyArray<GeoPick>): GeoAllocation[] {
  const units = new Set<string>();
  const ulbs = new Map<string, string | undefined>();
  for (const p of picks) {
    if (p.kind === "unit" && ix.unit.has(p.unitId)) units.add(p.unitId);
    if (p.kind === "ulb" && ix.ulb.has(p.ulbId) && !ulbs.has(p.ulbId)) ulbs.set(p.ulbId, p.viaUnitId);
  }

  const hungFrom = new Set<string>();
  for (const id of units) {
    for (let at = ix.unit.get(id)?.parentId; at; at = ix.unit.get(at)?.parentId) hungFrom.add(at);
  }
  /* A ULB is listed under EVERY taluka it is linked to, so picking it narrows each of
     them, not only the one it happened to be ticked under — otherwise the other
     ticked taluka would stay as a whole-taluka grant the person never meant. A ULB
     with no taluka narrows the district it was ticked under (`via`). */
  for (const [id, via] of ulbs) {
    if (via) hungFrom.add(via);
    for (const sub of ix.subsByUlb.get(id) ?? []) hungFrom.add(sub);
  }

  const out: GeoAllocation[] = [];
  for (const id of units) {
    if (hungFrom.has(id)) continue;
    out.push({ level: ix.unit.get(id)!.level, unitId: id, ulbId: null });
  }
  for (const id of ulbs.keys()) out.push({ level: "ulb", unitId: null, ulbId: id });
  return out;
}

/* ------------------------------------------------- the ULB ticks of the dialog */

/**
 * THE ULB TICKS AFTER ONE PICKER CHANGED. Each picker may only untick what IT
 * offers (`scope`): the list under the talukas and the "not mapped to a taluka"
 * list are two pickers over two disjoint sets of ULBs, and one of them dropping
 * the other's ticks is a bug this shipped with. A ULB newly ticked records the
 * place it was ticked under (`via`).
 */
export function applyUlbPick(
  current: ReadonlyMap<string, string | undefined>,
  ids: ReadonlyArray<string>,
  scope: ReadonlySet<string>,
  via: (id: string) => string | undefined,
): Map<string, string | undefined> {
  const next = new Map(current);
  const wanted = new Set(ids);
  for (const id of [...next.keys()]) if (scope.has(id) && !wanted.has(id)) next.delete(id);
  for (const id of ids) if (!next.has(id)) next.set(id, via(id));
  return next;
}

/**
 * The ticked ULBs, each marked MAPPED (the source links it to a taluka) or not
 * (district only). The dialog draws them differently and never merges the two.
 */
export function selectedUlbs(
  ix: GeoIndex,
  ticked: ReadonlyMap<string, string | undefined>,
): Array<{ ulb: GeoUlb; unmapped: boolean }> {
  return [...ticked.keys()]
    .map((id) => ix.ulb.get(id))
    .filter((u): u is GeoUlb => !!u)
    .map((ulb) => ({ ulb, unmapped: !(ix.subsByUlb.get(ulb.id) ?? []).length }))
    .sort((a, b) => a.ulb.name.localeCompare(b.ulb.name));
}
