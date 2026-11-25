/* ---------------------------------------------------------------------------
 * FROM FOUR OFFICIAL LGD REPORTS TO A GEOGRAPHY SNAPSHOT — PURE, no I/O.
 *
 * The reports, all downloaded from lgdirectory.gov.in ("Download All Entities of
 * State", Xls Report) and handed in as text:
 *
 *   districts      "All Districts of <State>(State Code:NN) State"
 *   subdistricts   "All Subdistricts of <State>(State Code:NN) State"
 *   ulbs           "Urban Local bodies of <State>(State Code:NN) State"
 *   coverage       "ULBs State Specific Ward with Coverage" — one row per WARD,
 *                  naming the ULB and the district and sub-district it sits in
 *
 * It turns them into the neutral `GeoSnapshotInput` that `buildGeoSnapshot` then
 * validates. It decides nothing about the data: every code, name and parent is
 * the report's own, names keep their trailing punctuation ("Chandgad."), and a
 * code the report does not give is left out rather than worked out.
 *
 * TWO THINGS THE REPORTS SAY AND THIS DOES NOT TRUST:
 *
 *   - The ULB file's two "Census" columns do not line up with their headers (one
 *     row reads 802828 under 2001 and 4 under 2011, which is a 2011 town code and a
 *     2001 one in the wrong places). A census code is not needed to place anything,
 *     so none is stored for a ULB rather than guessing which column is which.
 *   - A coverage row can name a sub-district and no district. The district is then
 *     the sub-district's own parent, read from the sub-district report — the
 *     official relationship, not an inference from a name.
 *
 * THE COVERAGE COLUMN `village_rows` COUNTS WARDS for this source (the report is
 * ward-level and a ward is what it has). It is read by nothing that decides who
 * may see what, and the importer says so in its own report.
 * ------------------------------------------------------------------------- */

import { column, lgdTable } from "@/lib/geography/lgd-spreadsheet";
import type { GeoSnapshotInput, RawCoverage } from "@/lib/geography/geo-snapshot";

export type LgdReports = { districts: string; subdistricts: string; ulbs: string; coverage: string };

export type LgdImport = {
  stateCode: string;
  stateName: string;
  input: GeoSnapshotInput;
  /** The ULB type codes the file carried, with the names it gave them — for checking against what we display. */
  ulbTypeNames: Record<string, string>;
  /** Things worth saying that are not errors. */
  notes: string[];
};

/** "All Districts of Maharashtra(State Code:27) State" → the state's name and code. */
export function stateOfTitle(title: ReadonlyArray<string>): { name: string; code: string } | null {
  for (const line of title) {
    const m = /\bof\s+(.+?)\s*\(\s*State Code\s*:\s*(\d+)\s*\)/i.exec(line);
    if (m) return { name: m[1].trim(), code: m[2] };
  }
  return null;
}

export function readLgdReports(reports: LgdReports): LgdImport {
  const notes: string[] = [];
  const districts = lgdTable(reports.districts);
  const subs = lgdTable(reports.subdistricts);
  const ulbs = lgdTable(reports.ulbs);
  const coverage = lgdTable(reports.coverage);

  const state = stateOfTitle(districts.title);
  if (!state) throw new Error('The district report does not name its state ("…(State Code:NN) State").');
  for (const [label, t] of [["sub-district", subs], ["local-body", ulbs]] as const) {
    const s = stateOfTitle(t.title);
    if (!s || s.code !== state.code) {
      throw new Error(`The ${label} report is for state ${s?.code ?? "?"}, not ${state.code} (${state.name}). All four must be one state's.`);
    }
  }

  // ---- districts
  const dc = { code: column(districts.headers, "District Code"), name: column(districts.headers, "District Name"), census: column(districts.headers, "Census 2011 Code") };
  const districtRows = districts.rows
    .filter((r) => /^\d+$/.test(r[dc.code] ?? ""))
    .map((r) => ({ code: r[dc.code], name: r[dc.name], stateCode: state.code, census2011Code: r[dc.census] || null }));

  // ---- sub-districts
  const sc = {
    district: column(subs.headers, "District code"),
    code: column(subs.headers, "Subdistrict Code"),
    version: column(subs.headers, "Subdistrict Version"),
    name: column(subs.headers, "Subdistrict Name"),
    census: column(subs.headers, "Census 2011 Code"),
  };
  const subRows = subs.rows
    .filter((r) => /^\d+$/.test(r[sc.code] ?? ""))
    .map((r) => ({
      code: r[sc.code],
      name: r[sc.name],
      districtCode: r[sc.district],
      stateCode: state.code,
      version: /^\d+$/.test(r[sc.version] ?? "") ? Number(r[sc.version]) : null,
      census2011Code: r[sc.census] || null,
    }));
  const districtOfSub = new Map(subRows.map((s) => [s.code, s.districtCode]));

  // ---- urban local bodies
  const uc = {
    typeCode: column(ulbs.headers, "Localbody Type Code"),
    typeName: column(ulbs.headers, "Localbody Type Name"),
    code: column(ulbs.headers, "Localbody Code"),
    version: column(ulbs.headers, "Localbody Version"),
    name: column(ulbs.headers, "Local Body Name", 0),
    local: column(ulbs.headers, "Local Body Name", 1),
  };
  const ulbTypeNames: Record<string, string> = {};
  const ulbRows = ulbs.rows
    .filter((r) => /^\d+$/.test(r[uc.code] ?? ""))
    .map((r) => {
      if (r[uc.typeCode]) ulbTypeNames[r[uc.typeCode]] = r[uc.typeName];
      return {
        code: r[uc.code],
        name: r[uc.name],
        stateCode: state.code,
        typeCode: r[uc.typeCode] || null,
        version: /^\d+$/.test(r[uc.version] ?? "") ? Number(r[uc.version]) : null,
        nameLocal: r[uc.local] || null,
        census2011Code: null,
      };
    });
  notes.push("ULB census codes are not stored: the report's two census columns do not match their headers.");

  // ---- coverage, one row per ward, de-duplicated to (ULB, district, sub-district, ward)
  const cc = {
    ulb: column(coverage.headers, "Local Body Code"),
    ward: column(coverage.headers, "Ward Code"),
    district: column(coverage.headers, "District Code"),
    sub: column(coverage.headers, "Subdistrict Code"),
  };
  const seen = new Set<string>();
  const coverageRows: RawCoverage[] = [];
  let districtFromSub = 0;
  for (const r of coverage.rows) {
    const ulbCode = r[cc.ulb] ?? "";
    if (!/^\d+$/.test(ulbCode)) continue;
    const sub = r[cc.sub] ?? "";
    let district = r[cc.district] ?? "";
    if (sub && !district && districtOfSub.has(sub)) {
      district = districtOfSub.get(sub)!;
      districtFromSub++;
    }
    const key = `${ulbCode}|${district}|${sub}|${r[cc.ward] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coverageRows.push({ ulbCode, districtCode: district, subdistrictCode: sub, villageCode: r[cc.ward] ?? "" });
  }
  if (districtFromSub) notes.push(`${districtFromSub} coverage rows named a sub-district and no district; the district was taken from the sub-district report.`);
  notes.push("geo_ulb_subdistricts.village_rows counts WARDS for this source.");

  return {
    stateCode: state.code,
    stateName: state.name,
    ulbTypeNames,
    notes,
    input: {
      states: [{ code: state.code, name: state.name, stateOrUt: null }],
      districts: districtRows,
      subdistricts: subRows,
      ulbs: ulbRows,
      coverage: coverageRows,
    },
  };
}
