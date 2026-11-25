import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, readIndiaUlbCsv } from "./lgd-india-ulb";
import { buildGeoSnapshot } from "./geo-snapshot";

const H = "State/UT,District,City/Town,Type (as in LGD file),LGD code,Review flag,State code,District code,Type code (master),Census 2011 code,Local name,Version";
const csv = [
  H,
  "Alpha State,D One,Town A,Municipality,100,,10,501,5,0,Town A,1",
  'Alpha State,D One,"Town, B",Town Panchayat,101,,10,501,7,0,B,1',
  "Alpha State,D One,Twin,Municipal Corporation,102,SEVERAL DISTRICTS - verify,10,501,4,0,Twin,1",
  "Alpha State,D Two,Twin,Municipal Corporation,102,SEVERAL DISTRICTS - verify,10,502,4,0,Twin,1",
  "Alpha State,D Two,Camp,Cantonment Board,103,not in first master (Cantonment Board),10,502,,,,",
  "Alpha State,DISTRICT UNKNOWN,Lost,type not stated,104,UNRESOLVED - no district in either file,10,,7,0,Lost,1",
].join("\r\n");

test("quoted cells, CRLF and a BOM are read", () => {
  assert.deepEqual(parseCsv('﻿a,"b,c"\r\n"x ""y""",z\n'), [["a", "b,c"], ['x "y"', "z"]]);
});

test("every row, link and flag survives; nothing is invented", () => {
  const r = readIndiaUlbCsv(csv);
  assert.equal(r.rows, 6);
  assert.equal(r.input.states.length, 1);
  assert.equal(r.input.districts.length, 2);
  assert.equal(r.input.ulbs.length, 5);
  assert.equal(r.flags.length, 4);
  assert.deepEqual(r.flags.map((f) => f.flag).sort(), ["cantonment_not_in_first_master", "several_districts", "several_districts", "unresolved"]);
  assert.equal(r.flags.find((f) => f.flag === "unresolved")!.districtId, null);
  // "type not stated" is not a type
  assert.equal(r.input.ulbs.find((u) => u.code === "104")!.typeName, null);
  assert.equal(r.input.ulbs.find((u) => u.code === "101")!.name, "Town, B");
});

test("it validates as a snapshot: several districts are linked each, the unresolved one is kept as no_coverage", () => {
  const v = buildGeoSnapshot(readIndiaUlbCsv(csv).input);
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.snapshot.ulbDistricts.filter((l) => l.ulbId === "geo:ulb:102").length, 2);
  assert.equal(v.snapshot.ulbSubdistricts.length, 0);
  assert.deepEqual(v.snapshot.unresolved.map((u) => u.lgdCode), ["104"]);
  assert.equal(v.snapshot.ulbs.find((u) => u.lgdCode === "100")!.typeName, "Municipality");
});

test("a flag it does not know, a missing column and a code named two ways are refused, never dropped", () => {
  assert.throws(() => readIndiaUlbCsv(csv.replace("SEVERAL DISTRICTS - verify", "MAYBE").replace("SEVERAL DISTRICTS - verify", "MAYBE")), /does not know/);
  assert.throws(() => readIndiaUlbCsv(csv.replace("Local name,", "Local,")), /missing/);
  assert.throws(() => readIndiaUlbCsv(csv.replace("D Two,Camp", "Other Name,Camp")), /named two ways/);
});

import { indexGeo, unplacedUlbsIn, REVIEW_FLAG_LABEL } from "./geo-picker";

test("the picker's index carries the flags and lists the unplaced ULBs apart, per state", () => {
  const v = buildGeoSnapshot(readIndiaUlbCsv(csv).input);
  const flags = readIndiaUlbCsv(csv).flags.map((f) => ({ ulbId: f.ulbId, flag: f.flag }));
  const ix = indexGeo({
    units: v.snapshot.units,
    ulbs: v.snapshot.ulbs,
    ulbSubdistricts: v.snapshot.ulbSubdistricts,
    ulbDistricts: v.snapshot.ulbDistricts,
    ulbFlags: flags,
  });
  assert.deepEqual(unplacedUlbsIn(ix, ["geo:state:10"]).map((u) => u.name), ["Lost"]);
  assert.deepEqual(unplacedUlbsIn(ix, ["geo:state:99"]), []);
  assert.deepEqual(ix.flagsByUlb.get("geo:ulb:104"), ["unresolved"]);
  assert.deepEqual(ix.flagsByUlb.get("geo:ulb:102"), ["several_districts"]);
  assert.ok(Object.keys(REVIEW_FLAG_LABEL).length === 3);
  // a flagged ULB is still offered under every district it is linked to
  assert.equal((ix.ulbsByDistrict.get("geo:district:501") ?? []).some((u) => u.lgdCode === "102"), true);
  assert.equal((ix.ulbsByDistrict.get("geo:district:502") ?? []).some((u) => u.lgdCode === "102"), true);
});

import { hasTalukaIn, unmappedUlbsIn } from "./geo-picker";

test("a ULB linked to a district whose talukas it is not in is offered there (Greater Mumbai)", () => {
  const ix = indexGeo({
    units: [
      { id: "s", level: "state", name: "S", parentId: null },
      { id: "dCity", level: "district", name: "City", parentId: "s" },
      { id: "dSub", level: "district", name: "Suburban", parentId: "s" },
      { id: "tk", level: "subdistrict", name: "Andheri", parentId: "dSub" },
    ],
    ulbs: [{ id: "u", name: "Greater", lgdCode: "1", stateUnitId: "s" }],
    ulbSubdistricts: [{ ulbId: "u", subdistrictId: "tk" }],
    ulbDistricts: [{ ulbId: "u", districtId: "dCity" }, { ulbId: "u", districtId: "dSub" }],
  });
  assert.equal(hasTalukaIn(ix, "u", "dSub"), true);
  assert.equal(hasTalukaIn(ix, "u", "dCity"), false);
  assert.deepEqual(unmappedUlbsIn(ix, ["dCity"]).map((u) => u.name), ["Greater"]);
  assert.deepEqual(unmappedUlbsIn(ix, ["dSub"]), []);
});

import { cityOptions } from "./geo-picker";

test("the cities dropdown lists each ULB once, needs no taluka, keeps every district link and adds the unplaced of a ticked state", () => {
  const ix = indexGeo({
    units: [
      { id: "s", level: "state", name: "S", parentId: null },
      { id: "dA", level: "district", name: "Alpha", parentId: "s" },
      { id: "dB", level: "district", name: "Beta", parentId: "s" },
      { id: "tk", level: "subdistrict", name: "Tk", parentId: "dA" },
    ],
    ulbs: [
      { id: "u1", name: "InTaluka", lgdCode: "1", stateUnitId: "s" },
      { id: "u2", name: "Twin", lgdCode: "2", stateUnitId: "s" },
      { id: "u3", name: "Lost", lgdCode: "3", stateUnitId: "s" },
    ],
    ulbSubdistricts: [{ ulbId: "u1", subdistrictId: "tk" }],
    ulbDistricts: [
      { ulbId: "u1", districtId: "dA" },
      { ulbId: "u2", districtId: "dA" },
      { ulbId: "u2", districtId: "dB" },
    ],
  });
  // a ULB that has a taluka is offered with the district alone ticked — no taluka needed
  const alpha = cityOptions(ix, { states: ["s"], districts: ["dA"], subs: [] });
  assert.deepEqual(alpha.map((c) => c.ulb.name), ["InTaluka", "Lost", "Twin"]);
  // both districts ticked: Twin is ONE option and names both districts
  const both = cityOptions(ix, { states: ["s"], districts: ["dA", "dB"], subs: [] });
  assert.equal(both.filter((c) => c.ulb.name === "Twin").length, 1);
  assert.deepEqual(both.find((c) => c.ulb.name === "Twin")!.places, ["Alpha", "Beta"]);
  // its master links are not touched by listing it
  assert.equal(ix.ulbsByDistrict.get("dA")!.length + ix.ulbsByDistrict.get("dB")!.length, 3);
  // no district ticked: only the unplaced one of the ticked state, marked as such
  const none = cityOptions(ix, { states: ["s"], districts: [], subs: [] });
  assert.deepEqual(none.map((c) => c.ulb.name), ["Lost"]);
  assert.match(none[0].places[0], /no district/);
  assert.equal(none[0].viaId, "s");
  // an unticked state offers nothing
  assert.deepEqual(cityOptions(ix, { states: [], districts: [], subs: [] }), []);
});

import { normalizeGeoPicks } from "./geo-picker";

test("ticking a ULB that has a taluka, from the cities dropdown, saves the ULB alone and widens nothing", () => {
  const ix = indexGeo({
    units: [
      { id: "s", level: "state", name: "S", parentId: null },
      { id: "d", level: "district", name: "D", parentId: "s" },
      { id: "t1", level: "subdistrict", name: "T1", parentId: "d" },
      { id: "t2", level: "subdistrict", name: "T2", parentId: "d" },
    ],
    ulbs: [{ id: "u", name: "U", lgdCode: "1", stateUnitId: "s" }, { id: "w", name: "W", lgdCode: "2", stateUnitId: "s" }],
    ulbSubdistricts: [{ ulbId: "u", subdistrictId: "t1" }],
    ulbDistricts: [{ ulbId: "u", districtId: "d" }, { ulbId: "w", districtId: "d" }],
  });
  const saved = normalizeGeoPicks(ix, [
    { kind: "unit", unitId: "s" },
    { kind: "unit", unitId: "d" },
    { kind: "ulb", ulbId: "u", viaUnitId: "d" },
  ]);
  assert.deepEqual(saved, [{ level: "ulb", unitId: null, ulbId: "u" }]);
  // a second ULB of the same district, no taluka, narrows the same way
  const two = normalizeGeoPicks(ix, [{ kind: "unit", unitId: "d" }, { kind: "ulb", ulbId: "u", viaUnitId: "d" }, { kind: "ulb", ulbId: "w", viaUnitId: "d" }]);
  assert.deepEqual(two.map((a) => a.ulbId).sort(), ["u", "w"]);
});

import { restoreVia } from "./geo-picker";

test("reopening a saved allocation hangs a multi-district town where it cannot drop a district saved beside it", () => {
  const ix = indexGeo({
    units: [
      { id: "s", level: "state", name: "S", parentId: null },
      { id: "dH", level: "district", name: "Haridwar", parentId: "s" },
      { id: "dB", level: "district", name: "Bageshwar", parentId: "s" },
    ],
    ulbs: [{ id: "u", name: "Haridwar", lgdCode: "1", stateUnitId: "s" }],
    ulbSubdistricts: [],
    ulbDistricts: [{ ulbId: "u", districtId: "dB" }, { ulbId: "u", districtId: "dH" }],
  });
  // Bageshwar saved whole beside the town: the town must be hung from Haridwar
  assert.equal(restoreVia(ix, "u", new Set(["dB"])), "dH");
  // the other way round
  assert.equal(restoreVia(ix, "u", new Set(["dH"])), "dB");
  // nothing else saved: the first place, as before
  assert.ok(["dB", "dH"].includes(restoreVia(ix, "u", new Set())!));
  // round trip: save {Bageshwar whole + town}, restore, save again -> the same allocation
  const first = normalizeGeoPicks(ix, [
    { kind: "unit", unitId: "s" }, { kind: "unit", unitId: "dH" }, { kind: "unit", unitId: "dB" },
    { kind: "ulb", ulbId: "u", viaUnitId: "dH" },
  ]);
  const savedUnits = new Set(first.flatMap((a) => (a.unitId ? [a.unitId] : [])));
  assert.deepEqual(first.map((a) => a.unitId ?? a.ulbId).sort(), ["dB", "u"]);
  const via = restoreVia(ix, "u", savedUnits)!;
  const again = normalizeGeoPicks(ix, [
    { kind: "unit", unitId: "s" }, { kind: "unit", unitId: "dB" }, { kind: "unit", unitId: via },
    { kind: "ulb", ulbId: "u", viaUnitId: via },
  ]);
  assert.deepEqual(again.map((a) => a.unitId ?? a.ulbId).sort(), ["dB", "u"]);
  // an unplaced ULB is hung from its state
  const lost = indexGeo({ units: [{ id: "s", level: "state", name: "S", parentId: null }], ulbs: [{ id: "x", name: "X", lgdCode: "9", stateUnitId: "s" }], ulbSubdistricts: [], ulbDistricts: [] });
  assert.equal(restoreVia(lost, "x", new Set()), "s");
});

import { ulbChipLabel } from "./geo-picker";

test("a chip names where the town is: its district, 'several districts', or 'no district' — display only", () => {
  const ix = indexGeo({
    units: [
      { id: "s", level: "state", name: "S", parentId: null },
      { id: "dR", level: "district", name: "Raigad", parentId: "s" },
      { id: "dA", level: "district", name: "Ahilyanagar", parentId: "s" },
      { id: "dB", level: "district", name: "Bageshwar", parentId: "s" },
      { id: "tk", level: "subdistrict", name: "Tk", parentId: "dA" },
    ],
    ulbs: [
      { id: "k1", name: "Karjat", lgdCode: "1", stateUnitId: "s" },
      { id: "k2", name: "Karjat", lgdCode: "2", stateUnitId: "s" },
      { id: "h", name: "Haridwar", lgdCode: "3", stateUnitId: "s" },
      { id: "t", name: "Tharali", lgdCode: "4", stateUnitId: "s" },
    ],
    ulbSubdistricts: [{ ulbId: "k2", subdistrictId: "tk" }],
    ulbDistricts: [{ ulbId: "k1", districtId: "dR" }, { ulbId: "k2", districtId: "dA" }, { ulbId: "h", districtId: "dA" }, { ulbId: "h", districtId: "dB" }],
  });
  assert.equal(ulbChipLabel(ix, "k1"), "Karjat · Raigad");
  assert.equal(ulbChipLabel(ix, "k2"), "Karjat · Ahilyanagar"); // the district link and the taluka's district are one district
  assert.equal(ulbChipLabel(ix, "h"), "Haridwar · several districts");
  assert.equal(ulbChipLabel(ix, "t"), "Tharali · no district");
  // listing a label changes nothing it describes
  assert.deepEqual(ix.districtsByUlb.get("h"), ["dA", "dB"]);
  assert.equal(ix.ulbsByDistrict.get("dB")!.length, 1);
});
