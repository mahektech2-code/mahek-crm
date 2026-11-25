/* ---------------------------------------------------------------------------
 * THE ALL-INDIA CITY/TOWN FILE -> a geography snapshot — PURE, no I/O.
 *
 * Input is `all_india_towns_final_with_codes.csv`: one row per (local body,
 * district), built from two LGD reports joined on the local-body code. Nothing
 * here guesses. A row with no district stays UNRESOLVED (the snapshot builder
 * keeps it as `no_coverage`), a local body listed under several districts is
 * linked to each of them and flagged, and every review flag in the file is
 * carried through to `flags` exactly as written.
 *
 * There is no sub-district in this file, so every link is district-only; those
 * are the "unmapped" ULBs the picker already draws under their district.
 * ------------------------------------------------------------------------- */

import type { GeoSnapshotInput, RawCoverage, RawDistrict, RawState, RawUlb } from "./geo-snapshot";
import { ulbId, unitId } from "./geo-snapshot";

export type ReviewFlagKind = "unresolved" | "several_districts" | "cantonment_not_in_first_master";
export type ReviewFlagRow = { ulbId: string; districtId: string | null; flag: ReviewFlagKind; note: string };

export type IndiaUlbRead = {
  input: GeoSnapshotInput;
  flags: ReviewFlagRow[];
  notes: string[];
  rows: number;
};

/** A small RFC-4180 reader: quoted cells, doubled quotes, CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) out.push(row);
  return out;
}

const REQUIRED = [
  "State/UT", "District", "City/Town", "Type (as in LGD file)", "LGD code", "Review flag",
  "State code", "District code", "Type code (master)", "Census 2011 code", "Local name", "Version",
] as const;

const num = (v: string) => (/^\d+$/.test(v.trim()) ? v.trim() : "");

export function flagKind(flag: string): ReviewFlagKind | null {
  if (flag.startsWith("UNRESOLVED")) return "unresolved";
  if (flag.startsWith("SEVERAL DISTRICTS")) return "several_districts";
  if (flag.startsWith("not in first master")) return "cantonment_not_in_first_master";
  return null;
}

export function readIndiaUlbCsv(csvText: string): IndiaUlbRead {
  const table = parseCsv(csvText);
  if (!table.length) throw new Error("The file is empty.");
  const head = table[0].map((h) => h.trim());
  const at = Object.fromEntries(REQUIRED.map((h) => [h, head.indexOf(h)])) as Record<(typeof REQUIRED)[number], number>;
  for (const h of REQUIRED) if (at[h] < 0) throw new Error(`Column "${h}" is missing — is this the with_codes file?`);

  const notes: string[] = [];
  const states = new Map<string, RawState>();
  const districts = new Map<string, RawDistrict>();
  const ulbs = new Map<string, RawUlb>();
  const coverage: RawCoverage[] = [];
  const flags: ReviewFlagRow[] = [];
  const unknownFlags = new Set<string>();

  for (const r of table.slice(1)) {
    const c = (h: (typeof REQUIRED)[number]) => (r[at[h]] ?? "").trim();
    const stateCode = num(c("State code"));
    const code = num(c("LGD code"));
    if (!stateCode || !code) throw new Error(`A row has no state code or no LGD code: ${r.join(" | ").slice(0, 120)}`);
    if (!states.has(stateCode)) states.set(stateCode, { code: stateCode, name: c("State/UT") });
    else if (states.get(stateCode)!.name !== c("State/UT")) throw new Error(`State code ${stateCode} is named two ways in the file.`);

    const unresolved = c("District") === "DISTRICT UNKNOWN";
    const dcode = num(c("District code"));
    if (!unresolved) {
      if (!dcode) throw new Error(`${c("City/Town")} (${code}) has a district name and no district code.`);
      const prior = districts.get(dcode);
      if (!prior) districts.set(dcode, { code: dcode, name: c("District"), stateCode });
      else if (prior.name !== c("District") || prior.stateCode !== stateCode) throw new Error(`District code ${dcode} is named two ways in the file.`);
    }

    if (!ulbs.has(code)) {
      ulbs.set(code, {
        code,
        name: c("City/Town"),
        stateCode,
        typeCode: num(c("Type code (master)")) || null,
        // An unresolved row's type column says "type not stated" — that is NOT a type.
        typeName: unresolved ? null : c("Type (as in LGD file)") || null,
        version: num(c("Version")) ? Number(num(c("Version"))) : null,
        nameLocal: c("Local name") || null,
        census2011Code: num(c("Census 2011 code")) || null,
      });
    }
    if (!unresolved) coverage.push({ ulbCode: code, ulbName: c("City/Town"), stateName: c("State/UT"), districtCode: dcode, subdistrictCode: "" });

    const kind = flagKind(c("Review flag"));
    if (c("Review flag") && !kind) unknownFlags.add(c("Review flag"));
    if (kind) flags.push({ ulbId: ulbId(code), districtId: unresolved ? null : unitId("district", dcode), flag: kind, note: c("Review flag") });
  }
  if (unknownFlags.size) throw new Error(`Review flags this reader does not know (nothing was dropped silently): ${[...unknownFlags].join("; ")}`);

  notes.push("The file has no sub-district, so every local body is linked to its district only.");
  return {
    input: { states: [...states.values()], districts: [...districts.values()], subdistricts: [], ulbs: [...ulbs.values()], coverage },
    flags,
    notes,
    rows: table.length - 1,
  };
}
