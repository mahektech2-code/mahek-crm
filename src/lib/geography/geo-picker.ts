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
export type GeoUlb = { id: string; name: string; lgdCode: string; stateUnitId: string; typeCode?: string | null; typeName?: string | null };
export type GeoData = {
  units: GeoUnit[];
  ulbs: GeoUlb[];
  /** ULB ↔ sub-district: many-to-many. */
  ulbSubdistricts: Array<{ ulbId: string; subdistrictId: string }>;
  /** ULB ↔ district, for every district the source puts it in. */
  ulbDistricts: Array<{ ulbId: string; districtId: string }>;
  /** The review flags the source file carried, as written — never resolved or hidden. */
  ulbFlags?: Array<{ ulbId: string; flag: GeoReviewFlag }>;
};

export type GeoReviewFlag = "unresolved" | "several_districts" | "cantonment_not_in_first_master";

/** What a flag is called on screen. The wording says what the SOURCE said and claims nothing more. */
export const REVIEW_FLAG_LABEL: Readonly<Record<GeoReviewFlag, { short: string; long: string }>> = {
  unresolved: { short: "Unresolved", long: "Unresolved — the official list gives this city/town no district." },
  several_districts: { short: "Several districts", long: "Several districts — the official list puts it in more than one district; not confirmed which is right." },
  cantonment_not_in_first_master: { short: "Cantonment Board", long: "Cantonment Board — in the district list only, not in the first local-body list." },
};

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export type GeoIndex = {
  unit: Map<string, GeoUnit>;
  ulb: Map<string, GeoUlb>;
  children: Map<string, GeoUnit[]>;
  ulbsBySub: Map<string, GeoUlb[]>;
  subsByUlb: Map<string, string[]>;
  ulbsByDistrict: Map<string, GeoUlb[]>;
  flagsByUlb: Map<string, GeoReviewFlag[]>;
  /** Every district the source puts a ULB in — by its district links and by the district of any taluka it is in. */
  districtsByUlb: Map<string, string[]>;
  /** ULBs linked to some district or taluka. The rest are the ones the source could not place. */
  placed: Set<string>;
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
  const flagsByUlb = new Map<string, GeoReviewFlag[]>();
  for (const f of data.ulbFlags ?? []) {
    const have = flagsByUlb.get(f.ulbId) ?? [];
    if (!have.includes(f.flag)) flagsByUlb.set(f.ulbId, [...have, f.flag]);
  }
  const placed = new Set<string>([...data.ulbDistricts.map((l) => l.ulbId), ...data.ulbSubdistricts.map((l) => l.ulbId)]);
  const districtsByUlb = new Map<string, string[]>();
  const noteDistrict = (ulbId: string, districtId: string | null | undefined) => {
    if (!districtId) return;
    const have = districtsByUlb.get(ulbId) ?? [];
    if (!have.includes(districtId)) districtsByUlb.set(ulbId, [...have, districtId]);
  };
  for (const l of data.ulbDistricts) noteDistrict(l.ulbId, l.districtId);
  for (const l of data.ulbSubdistricts) noteDistrict(l.ulbId, unit.get(l.subdistrictId)?.parentId);
  return { unit, ulb, children, ulbsBySub, subsByUlb, ulbsByDistrict, flagsByUlb, districtsByUlb, placed };
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

/**
 * Does the source put this ULB in a taluka OF THIS DISTRICT? A ULB can be linked to a
 * district by one report and to talukas of ANOTHER district by a second (Greater Mumbai:
 * the city district in one, suburban talukas in the other). Under the first district it
 * has no taluka, and must still be offered there.
 */
export const hasTalukaIn = (ix: GeoIndex, ulbId: string, districtId: string): boolean =>
  (ix.subsByUlb.get(ulbId) ?? []).some((s) => ix.unit.get(s)?.parentId === districtId);

/** ULBs the source puts in these districts and in NO taluka of that district — shown apart, never under a taluka. */
export function unmappedUlbsIn(ix: GeoIndex, districtIds: Iterable<string>): GeoUlb[] {
  const out = new Map<string, GeoUlb>();
  for (const did of districtIds) {
    for (const ulb of ix.ulbsByDistrict.get(did) ?? []) {
      if (!hasTalukaIn(ix, ulb.id, did)) out.set(ulb.id, ulb);
    }
  }
  return [...out.values()].sort(byName);
}

/**
 * HOW A PICKED CITY IS NAMED ON ITS CHIP — a display label only, never stored and never used to
 * match. Two towns can share a name (Karjat in Raigad and in Ahilyanagar), so the chip says where.
 * One in several districts is NOT given one of them: that would be choosing for the source.
 */
export function ulbChipLabel(ix: GeoIndex, ulbId: string): string {
  const u = ix.ulb.get(ulbId);
  if (!u) return ulbId;
  const districts = ix.districtsByUlb.get(ulbId) ?? [];
  if (districts.length === 1) return `${u.name} · ${ix.unit.get(districts[0])?.name ?? "district"}`;
  if (districts.length > 1) return `${u.name} · several districts`;
  return `${u.name} · no district`;
}

/** ULBs of these states the source places in NO district and no taluka — listed apart, never under a district. */
export function unplacedUlbsIn(ix: GeoIndex, stateIds: Iterable<string>): GeoUlb[] {
  const states = new Set(stateIds);
  return [...ix.ulb.values()].filter((u) => states.has(u.stateUnitId) && !ix.placed.has(u.id)).sort(byName);
}

/**
 * WHERE TO HANG A SAVED ULB'S TICK WHEN THE DIALOG IS REOPENED. A saved allocation does not
 * record which place a ULB was ticked under, and the place matters: ticking a ULB narrows
 * whatever it was ticked under, so choosing wrongly would make a re-save DROP a whole
 * district that was saved beside it (a town in Haridwar and Bageshwar, with Bageshwar
 * allocated whole, was restored under Bageshwar and the next save lost Bageshwar).
 *
 * The first place that is safe wins: a taluka, then a district, then (for a ULB the source
 * places in no district) its state — where "safe" means neither it nor anything above it is
 * itself a saved allocation. With no safe place the first one is used, as before.
 */
export function restoreVia(ix: GeoIndex, ulbId: string, savedUnits: ReadonlySet<string>): string | undefined {
  const chainSaved = (id: string) => {
    for (let u = ix.unit.get(id); u; u = u.parentId ? ix.unit.get(u.parentId) : undefined) if (savedUnits.has(u.id)) return true;
    return false;
  };
  const districts = [...ix.ulbsByDistrict].filter(([, list]) => list.some((u) => u.id === ulbId)).map(([d]) => d);
  const options = [...(ix.subsByUlb.get(ulbId) ?? []), ...districts];
  if (!ix.placed.has(ulbId)) {
    const state = ix.ulb.get(ulbId)?.stateUnitId;
    if (state) options.push(state);
  }
  return options.find((o) => !chainSaved(o)) ?? options[0];
}

export type CityOption = {
  ulb: GeoUlb;
  /** Names of the ticked places it is in. A ULB in several districts lists each — it is still ONE option. */
  places: string[];
  /** The place a tick of it is recorded under (a district, or the state for one with no district). */
  viaId: string;
};

/**
 * THE CITIES AND TOWNS OFFERED IN ONE DROPDOWN: every ULB the source puts in a ticked
 * district (whether or not it has a taluka there), those under a ticked taluka, and those
 * the source places in no district at all (listed under their ticked state). EACH ONCE,
 * however many districts link to it — all its district links stay in the master and are
 * never collapsed, and no district is chosen for it.
 */
export function cityOptions(
  ix: GeoIndex,
  ticked: { states: Iterable<string>; districts: Iterable<string>; subs: Iterable<string> },
): CityOption[] {
  const found = new Map<string, { ulb: GeoUlb; districts: Set<string>; via: string }>();
  const add = (ulb: GeoUlb, districtId: string | null | undefined) => {
    if (!districtId) return;
    const e = found.get(ulb.id) ?? { ulb, districts: new Set<string>(), via: districtId };
    e.districts.add(districtId);
    found.set(ulb.id, e);
  };
  for (const d of ticked.districts) for (const u of ix.ulbsByDistrict.get(d) ?? []) add(u, d);
  for (const s of ticked.subs) {
    const d = ix.unit.get(s)?.parentId;
    for (const u of ix.ulbsBySub.get(s) ?? []) add(u, d);
  }
  const out: CityOption[] = [...found.values()].map((e) => ({
    ulb: e.ulb,
    places: [...e.districts].map((id) => ix.unit.get(id)?.name ?? id).sort((a, b) => a.localeCompare(b)),
    viaId: e.via,
  }));
  for (const u of unplacedUlbsIn(ix, ticked.states)) {
    out.push({ ulb: u, places: [`${ix.unit.get(u.stateUnitId)?.name ?? ""} · no district listed`], viaId: u.stateUnitId });
  }
  return out.sort((a, b) => byName(a.ulb, b.ulb));
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
