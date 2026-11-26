import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeXml, lgdTable, spreadsheetRows, column } from "./lgd-spreadsheet";
import { readLgdReports, stateOfTitle } from "./lgd-import";
import { buildGeoSnapshot } from "./geo-snapshot";
import { ulbTypeName } from "./lgd-ulb-types";

/* A miniature of the real reports' SHAPE (SpreadsheetML), with invented rows. */
const cell = (v: string, idx?: number) => `<Cell${idx ? ` ss:Index="${idx}"` : ""}><Data ss:Type="String">${v}</Data></Cell>`;
const row = (...c: string[]) => `<Row>${c.join("")}</Row>`;
const book = (...rows: string[]) => `<?xml version="1.0"?><Workbook><Worksheet><Table>${rows.join("")}</Table></Worksheet></Workbook>`;

const districts = book(
  row(cell("Local Government Directory")),
  row(cell("All Districts of Testland(State Code:27) State")),
  row(cell("S. No."), cell("District Code"), cell("District Version"), cell("District Name"), cell("District Name"), cell("Census 2001 Code"), cell("Census 2011 Code")),
  row(cell(""), cell(""), cell(""), cell("(In English)"), cell("(In Local)")),
  row(cell("1.0"), cell("480"), cell("1"), cell("Alpha"), cell("a"), cell("01"), cell("530")),
  row(cell("2.0"), cell("492"), cell("1"), cell("Beta &amp; Co"), cell("b"), cell("02"), cell("531")),
);
const subs = book(
  row(cell("All Subdistricts of Testland(State Code:27) State")),
  row(cell("S.No."), cell("District code"), cell("District Name"), cell("Subdistrict Code"), cell("Subdistrict Version"), cell("Subdistrict Name"), cell("Subdistrict Name"), cell("Census 2001 Code"), cell("Census 2011 Code")),
  row(cell(""), cell(""), cell(""), cell(""), cell(""), cell("(In English)")),
  row(cell("1"), cell("480"), cell("Alpha"), cell("4287"), cell("1"), cell("Karv"), cell("k"), cell("1"), cell("04287")),
  row(cell("2"), cell("480"), cell("Alpha"), cell("4285"), cell("2"), cell("Hatk"), cell("h"), cell("2"), cell("04285")),
  row(cell("3"), cell("492"), cell("Beta"), cell("4269"), cell("1"), cell("Empty Taluka"), cell("e"), cell("3"), cell("04269")),
);
const ulbs = book(
  row(cell("Urban Local bodies of Testland(State Code:27) State")),
  row(cell("S.No."), cell("Localbody Type Code"), cell("Localbody Type Name"), cell("Localbody Code"), cell("Localbody Version"), cell("Local Body Name"), cell("Local Body Name"), cell("Census 2001 Code"), cell("Census 2011 Code")),
  row(cell(""), cell(""), cell(""), cell(""), cell(""), cell("(In English)")),
  row(cell("1.0"), cell("4"), cell("Municipal Corporation"), cell("251625"), cell("3"), cell("Metro"), cell("m"), cell("802887"), cell("4")),
  row(cell("2.0"), cell("7"), cell("Nagar Panchayat"), cell("300001"), cell("1"), cell("Hatk Town."), cell("t"), cell("802001"), cell("7")),
  row(cell("3.0"), cell("5"), cell("Municipality"), cell("300002"), cell("1"), cell("Edge"), cell("e"), cell("802002"), cell("5")),
  row(cell("4.0"), cell("5"), cell("Municipality"), cell("300003"), cell("1"), cell("Nocoverage"), cell("n"), cell("802003"), cell("5")),
);
const coverage = book(
  row(cell("Urban local bodies and wards of Testland state")),
  row(cell("S.No."), cell("Local Body Code"), cell("Local Body Name"), cell("Ward Code"), cell("Ward Number"), cell("Ward Name"), cell("District Code"), cell("District Name"), cell("Subdistrict Code"), cell("Subdistrict Name")),
  row(cell("1"), cell("251625"), cell("Metro"), cell("w1"), cell("Ward No.1"), cell("1"), cell("480"), cell("Alpha"), cell("4287"), cell("Karv")),
  row(cell("2"), cell("251625"), cell("Metro"), cell("w1"), cell("Ward No.1"), cell("1"), cell(""), cell(""), cell(""), cell("")),
  row(cell("3"), cell("251625"), cell("Metro"), cell("w1"), cell("Ward No.1"), cell("1"), cell("480"), cell("Alpha"), cell("4287"), cell("Karv")),
  row(cell("4"), cell("300001"), cell("Hatk Town."), cell("w2"), cell("Ward No.2"), cell("2"), cell("480"), cell("Alpha"), cell("4285"), cell("Hatk")),
  row(cell("5"), cell("300002"), cell("Edge"), cell("w3"), cell("Ward No.3"), cell("3"), cell(""), cell(""), cell("4287"), cell("Karv")),
  row(cell("6"), cell("300002"), cell("Edge"), cell("w4"), cell("Ward No.4"), cell("4"), cell("480"), cell("Alpha"), cell("4285"), cell("Hatk")),
);
const reports = { districts, subdistricts: subs, ulbs, coverage };

test("XML text is decoded, and a cell's ss:Index keeps later columns in place", () => {
  assert.equal(decodeXml("A &amp; B &lt;c&gt; &#65; &#x42;"), "A & B <c> A B");
  const rows = spreadsheetRows(book(`<Row>${cell("a")}${cell("c", 3)}</Row>`));
  assert.deepEqual(rows, [["a", "", "c"]]);
});

test("a table is found by its S.No. header, caption rows are skipped, and columns are found by name", () => {
  const t = lgdTable(districts);
  assert.equal(t.rows.length, 2);
  assert.ok(t.title.some((l) => l.includes("State Code:27")));
  assert.equal(column(t.headers, "District Name", 0), 3);
  assert.equal(column(t.headers, "District Name", 1), 4);
  assert.throws(() => column(t.headers, "Nope"));
  assert.throws(() => lgdTable(book(row(cell("hello")))), /not an LGD report/);
});

test("the state is read from the title, and a mismatched report is refused", () => {
  assert.deepEqual(stateOfTitle(["x", "All Districts of Maharashtra(State Code:27) State"]), { name: "Maharashtra", code: "27" });
  assert.equal(stateOfTitle(["nothing"]), null);
  assert.throws(() => readLgdReports({ ...reports, ulbs: ulbs.replace("State Code:27", "State Code:28") }), /not 27/);
});

test("names keep their spelling, entities decoded, and census is not stored for a ULB", () => {
  const r = readLgdReports(reports);
  assert.equal(r.input.districts[1].name, "Beta & Co");
  assert.equal(r.input.ulbs.find((u) => u.code === "300001")!.name, "Hatk Town.");
  assert.ok(r.input.ulbs.every((u) => u.census2011Code === null));
  assert.deepEqual(r.ulbTypeNames, { "4": "Municipal Corporation", "7": "Nagar Panchayat", "5": "Municipality" });
});

test("coverage is de-duplicated and a missing district comes from the sub-district's own parent", () => {
  const r = readLgdReports(reports);
  const edge = r.input.coverage.filter((c) => c.ulbCode === "300002");
  assert.deepEqual(edge.map((c) => `${c.districtCode}/${c.subdistrictCode}`), ["480/4287", "480/4285"]);
  assert.equal(r.input.coverage.filter((c) => c.ulbCode === "251625" && c.subdistrictCode === "4287").length, 1);
  assert.ok(r.notes.some((n) => n.includes("district was taken from the sub-district report")));
});

test("the whole thing validates and keeps the ULB with no coverage as unresolved, never mapped", () => {
  const v = buildGeoSnapshot(readLgdReports(reports).input);
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.summary.districts, 2);
  assert.equal(v.summary.subdistricts, 3);
  assert.equal(v.summary.ulbs, 4);
  assert.equal(v.summary.ulbsNoCoverage, 1);
  assert.equal(v.summary.ulbsInSeveralSubdistricts, 1);
  assert.deepEqual(v.snapshot.unresolved.map((u) => `${u.kind}:${u.lgdCode}`), ["no_coverage:300003"]);
  // the empty taluka stays in the master with no ULB under it
  assert.ok(v.snapshot.units.some((u) => u.name === "Empty Taluka"));
  assert.ok(!v.snapshot.ulbSubdistricts.some((l) => l.subdistrictId === "geo:subdistrict:4269"));
  // ULB type codes are kept, not labelled, in the snapshot
  assert.equal(v.snapshot.ulbs.find((u) => u.lgdCode === "251625")!.typeCode, "4");
});

test("ULB type names come only from codes an official report named", () => {
  assert.equal(ulbTypeName("4"), "Municipal Corporation");
  assert.equal(ulbTypeName("5"), "Municipality");
  assert.equal(ulbTypeName("7"), "Nagar Panchayat");
  assert.equal(ulbTypeName("6"), null);
  assert.equal(ulbTypeName(null), null);
});
