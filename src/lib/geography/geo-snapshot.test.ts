import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeoSnapshot, isMissingCode, ulbId, unitId, type GeoSnapshotInput } from "./geo-snapshot";
import { applyUlbPick, indexGeo, normalizeGeoPicks, selectedUlbs, statesOf, districtsIn, subdistrictsIn, ulbsInSubdistrict, ulbsUnder, unmappedUlbsIn } from "./geo-picker";

/* A tiny synthetic fixture shaped like the real findings: a ULB covering two
   talukas, a taluka with two ULBs, a district-only ULB, a ULB with no coverage,
   and a coverage code naming no ULB. Names and codes are test data, not a dataset. */
const input = (): GeoSnapshotInput => ({
  states: [{ code: "27", name: "Testland", stateOrUt: "State" }, { code: "28", name: "Emptyland", stateOrUt: "UT" }],
  districts: [
    { code: "480", name: "Alpha", stateCode: "27" },
    { code: "492", name: "Beta", stateCode: "27" },
  ],
  subdistricts: [
    { code: "4287", name: "Karv", districtCode: "480", stateCode: "27" },
    { code: "4285", name: "Hatk", districtCode: "480", stateCode: "27" },
    { code: "4269", name: "Chip", districtCode: "492", stateCode: "27" },
  ],
  ulbs: [
    { code: "1", name: "Metro", stateCode: "27", typeCode: "4" },
    { code: "2", name: "Hatk Town.", stateCode: "27", typeCode: "5" },
    { code: "3", name: "Edge Town", stateCode: "27", typeCode: "7" },
    { code: "4", name: "Districtonly", stateCode: "27", typeCode: "7" },
    { code: "5", name: "Nocoverage", stateCode: "27", typeCode: "5" },
  ],
  coverage: [
    { ulbCode: "1", districtCode: "480", subdistrictCode: "4287", villageCode: "10" },
    { ulbCode: "1", districtCode: "480", subdistrictCode: "4287", villageCode: "11" },
    { ulbCode: "1", districtCode: "480", subdistrictCode: "0", villageCode: "0" },
    { ulbCode: "2", districtCode: "480", subdistrictCode: "4285", villageCode: "20" },
    { ulbCode: "3", districtCode: "480", subdistrictCode: "4287", villageCode: "30" },
    { ulbCode: "3", districtCode: "480", subdistrictCode: "4285", villageCode: "31" },
    { ulbCode: "4", districtCode: "492", subdistrictCode: "0", villageCode: "0" },
    { ulbCode: "999", ulbName: "Ghost", stateName: "Testland", districtCode: "480", subdistrictCode: "4287", villageCode: "0" },
  ],
});

test("a clean snapshot validates and keeps every level, with the source's own codes as ids", () => {
  const v = buildGeoSnapshot(input());
  assert.equal(v.ok, true);
  assert.equal(v.summary.states, 2);
  assert.equal(v.summary.districts, 2);
  assert.equal(v.summary.subdistricts, 3);
  assert.equal(v.summary.ulbs, 5);
  assert.ok(v.snapshot.units.some((u) => u.id === unitId("subdistrict", "4287") && u.parentId === unitId("district", "480")));
});

test("a zero-district state is kept: the master does not depend on shops", () => {
  const v = buildGeoSnapshot(input());
  assert.ok(v.snapshot.units.some((u) => u.level === "state" && u.name === "Emptyland"));
});

test("names are kept as the source spells them; only the key is folded", () => {
  const v = buildGeoSnapshot(input());
  const u = v.snapshot.ulbs.find((x) => x.lgdCode === "2")!;
  assert.equal(u.name, "Hatk Town.");
  assert.equal(u.nameKey, "hatk town");
});

test("ULB type codes are kept as text and never given a label", () => {
  const v = buildGeoSnapshot(input());
  assert.deepEqual(
    v.snapshot.ulbs.map((u) => u.typeCode),
    ["4", "5", "7", "7", "5"],
  );
  assert.ok(!("typeLabel" in v.snapshot.ulbs[0]));
});

test("one ULB can link to several talukas; one taluka holds several ULBs", () => {
  const v = buildGeoSnapshot(input());
  const links = v.snapshot.ulbSubdistricts;
  assert.equal(links.filter((l) => l.ulbId === ulbId("3")).length, 2);
  assert.equal(links.filter((l) => l.subdistrictId === unitId("subdistrict", "4287")).length, 2);
  assert.equal(v.summary.ulbsInSeveralSubdistricts, 1);
  // village rows are counted, and the "0" placeholder village is not a village
  assert.equal(links.find((l) => l.ulbId === ulbId("1"))!.villageRows, 2);
});

test("a ULB the source ties to a district only is counted and still in its district", () => {
  const v = buildGeoSnapshot(input());
  assert.equal(v.summary.ulbsDistrictOnly, 1);
  assert.ok(v.snapshot.ulbDistricts.some((d) => d.ulbId === ulbId("4") && d.districtId === unitId("district", "492")));
});

test("a ULB with no coverage and an orphan coverage code are kept as unresolved, not dropped", () => {
  const v = buildGeoSnapshot(input());
  assert.deepEqual(
    v.snapshot.unresolved.map((r) => `${r.kind}:${r.lgdCode}`).sort(),
    ["no_coverage:5", "orphan_coverage:999"],
  );
  assert.equal(v.summary.ulbsNoCoverage, 1);
  assert.equal(v.summary.orphanCoverageCodes, 1);
});

test("missing parents and duplicates are errors, never guessed", () => {
  const bad = input();
  bad.districts.push({ code: "700", name: "Orphan", stateCode: "99" });
  bad.districts.push({ code: "480", name: "Dup", stateCode: "27" });
  bad.subdistricts.push({ code: "9", name: "Misfiled", districtCode: "492", stateCode: "28" });
  const v = buildGeoSnapshot(bad);
  assert.equal(v.ok, false);
  const codes = v.problems.map((p) => p.code);
  assert.ok(codes.includes("district_parent"));
  assert.ok(codes.includes("duplicate_unit"));
  assert.ok(codes.includes("subdistrict_state_mismatch"));
  assert.ok(!v.snapshot.units.some((u) => u.lgdCode === "700"));
});

test("a coverage pair whose taluka belongs to another district is refused, not linked", () => {
  const bad = input();
  bad.coverage.push({ ulbCode: "2", districtCode: "492", subdistrictCode: "4285", villageCode: "1" });
  const v = buildGeoSnapshot(bad);
  assert.ok(v.problems.some((p) => p.code === "coverage_pair_mismatch"));
  assert.ok(!v.snapshot.ulbSubdistricts.some((l) => l.ulbId === ulbId("2") && l.districtId === unitId("district", "492")));
});

test("0, 00 and blank are missing codes", () => {
  assert.equal(isMissingCode("0"), true);
  assert.equal(isMissingCode("000"), true);
  assert.equal(isMissingCode(" "), true);
  assert.equal(isMissingCode(null), true);
  assert.equal(isMissingCode("4287"), false);
});

/* ---------------------------------------------------------------- picker */

const data = () => {
  const s = buildGeoSnapshot(input()).snapshot;
  return indexGeo({
    units: s.units,
    ulbs: s.ulbs.map((u) => ({ id: u.id, name: u.name, lgdCode: u.lgdCode, stateUnitId: u.stateUnitId })),
    ulbSubdistricts: s.ulbSubdistricts,
    ulbDistricts: s.ulbDistricts,
  });
};
const sd = (c: string) => unitId("subdistrict", c);

test("each level depends on the one above, zero-shop places included", () => {
  const ix = data();
  assert.deepEqual(statesOf(ix).map((s) => s.name), ["Emptyland", "Testland"]);
  assert.deepEqual(districtsIn(ix, [unitId("state", "27")]).map((d) => d.name), ["Alpha", "Beta"]);
  assert.deepEqual(districtsIn(ix, [unitId("state", "28")]), []);
  assert.deepEqual(subdistrictsIn(ix, [unitId("district", "480")]).map((s) => s.name), ["Hatk", "Karv"]);
});

test("the same ULB is listed under every taluka it is linked to", () => {
  const ix = data();
  assert.ok(ulbsInSubdistrict(ix, sd("4287")).some((u) => u.name === "Edge Town"));
  assert.ok(ulbsInSubdistrict(ix, sd("4285")).some((u) => u.name === "Edge Town"));
});

test("several talukas ticked give the combined ULBs, each once, and say how many talukas it is in", () => {
  const ix = data();
  const options = ulbsUnder(ix, [sd("4287"), sd("4285")]);
  assert.deepEqual(options.map((o) => o.ulb.name), ["Edge Town", "Hatk Town.", "Metro"]);
  const edge = options.find((o) => o.ulb.name === "Edge Town")!;
  assert.equal(edge.subdistrictIds.length, 2);
  assert.equal(edge.linkedSubdistrictCount, 2);
});

test("district-only ULBs are listed apart and never under a taluka", () => {
  const ix = data();
  assert.deepEqual(unmappedUlbsIn(ix, [unitId("district", "492")]).map((u) => u.name), ["Districtonly"]);
  assert.deepEqual(unmappedUlbsIn(ix, [unitId("district", "480")]), []);
  assert.ok(!ulbsInSubdistrict(ix, sd("4269")).some((u) => u.name === "Districtonly"));
});

test("a ULB ticked through two talukas is saved as ONE allocation", () => {
  const ix = data();
  const edge = ulbId("3");
  const out = normalizeGeoPicks(ix, [
    { kind: "ulb", ulbId: edge, viaUnitId: sd("4287") },
    { kind: "ulb", ulbId: edge, viaUnitId: sd("4285") },
  ]);
  assert.equal(out.filter((a) => a.ulbId === edge).length, 1);
});

test("the narrowest pick is the allocation: the taluka a ULB was ticked under is the path, not a grant", () => {
  const ix = data();
  const out = normalizeGeoPicks(ix, [
    { kind: "unit", unitId: unitId("state", "27") },
    { kind: "unit", unitId: unitId("district", "480") },
    { kind: "unit", unitId: sd("4287") },
    { kind: "unit", unitId: sd("4285") },
    { kind: "ulb", ulbId: ulbId("1"), viaUnitId: sd("4287") },
  ]);
  const ids = out.map((a) => a.unitId ?? a.ulbId).sort();
  // state and district are paths; Karv is the path to Metro; Hatk (nothing ticked under it) stays whole.
  assert.deepEqual(ids, [sd("4285"), ulbId("1")].sort());
});

test("a ULB listed under two ticked talukas narrows BOTH: neither stays as a whole-taluka grant", () => {
  const ix = data();
  const out = normalizeGeoPicks(ix, [
    { kind: "unit", unitId: unitId("state", "27") },
    { kind: "unit", unitId: unitId("district", "480") },
    { kind: "unit", unitId: sd("4287") },
    { kind: "unit", unitId: sd("4285") },
    { kind: "ulb", ulbId: ulbId("3"), viaUnitId: sd("4287") },
  ]);
  assert.deepEqual(out.map((a) => a.unitId ?? a.ulbId), [ulbId("3")]);
});

test("a pick naming something not in the master is dropped, not guessed", () => {
  const ix = data();
  assert.deepEqual(normalizeGeoPicks(ix, [{ kind: "unit", unitId: "geo:district:nope" }, { kind: "ulb", ulbId: "geo:ulb:nope" }]), []);
});

/* ------------------------------------------- unmapped ULB ticks and chips */

test("ticking an unmapped ULB never unticks a mapped one (each picker only owns its own list)", () => {
  const ix = data();
  const mappedScope = new Set(ulbsUnder(ix, [sd("4287"), sd("4285")]).map((o) => o.ulb.id));
  const unmappedScope = new Set(unmappedUlbsIn(ix, [unitId("district", "492")]).map((u) => u.id));
  let ticks = new Map<string, string | undefined>();
  ticks = applyUlbPick(ticks, [ulbId("3")], mappedScope, () => sd("4287"));
  ticks = applyUlbPick(ticks, [ulbId("4")], unmappedScope, () => unitId("district", "492"));
  assert.deepEqual([...ticks.keys()].sort(), [ulbId("3"), ulbId("4")].sort());
});

test("unticking in one picker removes only that ULB and leaves the other picker's ticks", () => {
  const ix = data();
  const mappedScope = new Set(ulbsUnder(ix, [sd("4287"), sd("4285")]).map((o) => o.ulb.id));
  const unmappedScope = new Set(unmappedUlbsIn(ix, [unitId("district", "492")]).map((u) => u.id));
  const start = new Map<string, string | undefined>([[ulbId("3"), sd("4287")], [ulbId("4"), unitId("district", "492")]]);
  const afterUnmapped = applyUlbPick(start, [], unmappedScope, () => undefined);
  assert.deepEqual([...afterUnmapped.keys()], [ulbId("3")]);
  const afterMapped = applyUlbPick(start, [], mappedScope, () => undefined);
  assert.deepEqual([...afterMapped.keys()], [ulbId("4")]);
});

test("a ULB already ticked keeps the place it was ticked under", () => {
  const start = new Map<string, string | undefined>([[ulbId("3"), sd("4287")]]);
  const next = applyUlbPick(start, [ulbId("3")], new Set([ulbId("3")]), () => sd("4285"));
  assert.equal(next.get(ulbId("3")), sd("4287"));
});

test("selected ULBs are marked mapped or unmapped, and the two are never merged", () => {
  const ix = data();
  const picked = new Map<string, string | undefined>([[ulbId("3"), sd("4287")], [ulbId("4"), unitId("district", "492")], [ulbId("1"), sd("4287")]]);
  const out = selectedUlbs(ix, picked).map((s) => `${s.ulb.name}:${s.unmapped ? "unmapped" : "mapped"}`);
  assert.deepEqual(out, ["Districtonly:unmapped", "Edge Town:mapped", "Metro:mapped"]);
});

test("many-to-many is unchanged: an unmapped tick does not widen any taluka allocation", () => {
  const ix = data();
  const out = normalizeGeoPicks(ix, [
    { kind: "unit", unitId: unitId("state", "27") },
    { kind: "unit", unitId: unitId("district", "480") },
    { kind: "unit", unitId: sd("4287") },
    { kind: "unit", unitId: sd("4285") },
    { kind: "ulb", ulbId: ulbId("3"), viaUnitId: sd("4287") },
    { kind: "unit", unitId: unitId("district", "492") },
    { kind: "ulb", ulbId: ulbId("4"), viaUnitId: unitId("district", "492") },
  ]);
  assert.deepEqual(out.map((a) => a.unitId ?? a.ulbId).sort(), [ulbId("3"), ulbId("4")].sort());
});
