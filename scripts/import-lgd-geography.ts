/* ---------------------------------------------------------------------------
 * IMPORT ONE STATE'S OFFICIAL LGD GEOGRAPHY INTO THE MASTER.
 *
 *   npm run geo:import-lgd -- --dir <folder> --dry-run
 *   npm run geo:import-lgd -- --dir <folder>
 *
 * `<folder>` holds the four reports from lgdirectory.gov.in → Download Directory →
 * "Download All Entities of State" → Xls Report, unzipped (names are matched by
 * prefix, so the colons in the original names do not matter):
 *
 *   districtofSpecificState…xls        subDistrictofSpecificState…xls
 *   ulbSpecificState…xls               uLBWardforStateWithCov…xls
 *
 * A DRY RUN reads, validates and reports and touches no database. A real run
 * refuses to write unless validation found no ERROR, and is safe to repeat: see
 * `writeGeoSnapshot`. Nothing here deletes a row or touches an allocation.
 *
 * LICENCE: the reuse licence of LGD data is NOT confirmed. The source row is
 * written with `licence_status = 'unverified'` and says so in its note. Importing
 * is not a statement that commercial reuse is permitted.
 * ------------------------------------------------------------------------- */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeoSnapshot } from "@/lib/geography/geo-snapshot";
import { readLgdReports } from "@/lib/geography/lgd-import";
import { KNOWN_ULB_TYPES } from "@/lib/geography/lgd-ulb-types";

const FILES = {
  districts: "districtofSpecificState",
  subdistricts: "subDistrictofSpecificState",
  ulbs: "ulbSpecificState",
  coverage: "uLBWardforStateWithCov",
} as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const dir = arg("dir");
  if (!dir) throw new Error("Pass --dir <folder holding the four unzipped LGD reports>.");
  const names = readdirSync(dir);
  const text: Record<string, string> = {};
  const hashes: string[] = [];
  let stamp: string | null = null;
  for (const [key, prefix] of Object.entries(FILES)) {
    const found = names.filter((n) => n.startsWith(prefix));
    if (found.length !== 1) throw new Error(`Expected exactly one "${prefix}…" file in ${dir}, found ${found.length}.`);
    const raw = readFileSync(join(dir, found[0]));
    hashes.push(`${key}:${createHash("sha256").update(raw).digest("hex")}`);
    text[key] = raw.toString("utf8");
    stamp ??= /(\d{4})[_:](\d{2})[_:](\d{2})/.exec(found[0])?.slice(1, 4).join("-") ?? null;
  }

  const read = readLgdReports(text as never);
  const result = buildGeoSnapshot(read.input);
  const s = result.summary;

  console.log(`\nLGD import — ${read.stateName} (state code ${read.stateCode}) — files dated ${stamp ?? "unknown"}`);
  console.log(`  districts ${s.districts} | talukas ${s.subdistricts} | ULBs ${s.ulbs}`);
  console.log(`  ULBs with a taluka ${s.ulbsWithSubdistrict} | district only ${s.ulbsDistrictOnly} | no coverage ${s.ulbsNoCoverage} | orphan coverage codes ${s.orphanCoverageCodes}`);
  console.log(`  ULBs in several talukas ${s.ulbsInSeveralSubdistricts}`);
  console.log(`  links: ULB↔taluka ${result.snapshot.ulbSubdistricts.length} | ULB↔district ${result.snapshot.ulbDistricts.length}`);

  const types: Record<string, number> = {};
  for (const u of result.snapshot.ulbs) types[u.typeCode ?? "none"] = (types[u.typeCode ?? "none"] ?? 0) + 1;
  console.log("  ULB types (code → file's name → count):");
  for (const [code, n] of Object.entries(types)) console.log(`    ${code} → ${read.ulbTypeNames[code] ?? "(unnamed)"} → ${n}`);
  for (const [code, name] of Object.entries(read.ulbTypeNames)) {
    const ours = KNOWN_ULB_TYPES[code];
    if (!ours) console.log(`  NOTE: type ${code} "${name}" is named by this file and not yet in lgd-ulb-types.ts, so the screen shows no type for it.`);
    else if (ours !== name) result.problems.push({ severity: "error", code: "ulb_type_name", message: `Type ${code} is "${name}" in this file but "${ours}" in lgd-ulb-types.ts.` });
  }

  for (const n of read.notes) console.log(`  note: ${n}`);
  const errors = result.problems.filter((p) => p.severity === "error");
  const warnings = result.problems.filter((p) => p.severity === "warning");
  console.log(`  validation: ${errors.length} errors, ${warnings.length} warnings`);
  for (const p of result.problems.slice(0, 20)) console.log(`    ${p.severity.toUpperCase()} ${p.code}: ${p.message}`);
  console.log(`  unresolved records kept (${result.snapshot.unresolved.length}):`);
  for (const r of result.snapshot.unresolved) console.log(`    ${r.kind} ${r.lgdCode} ${r.name ?? ""} — ${r.note}`);

  const expect = arg("expect"); // e.g. districts=36,subdistricts=358,ulbs=422
  if (expect) {
    for (const pair of expect.split(",")) {
      const [k, v] = pair.split("=");
      const got = (s as Record<string, number>)[k];
      if (got !== Number(v)) throw new Error(`Expected ${k}=${v} but the files hold ${got}. Nothing was written.`);
    }
    console.log(`  expected counts matched (${expect})`);
  }

  if (!result.ok) throw new Error("Validation found errors. Nothing was written.");
  if (flag("dry-run")) {
    console.log("\nDRY RUN — nothing was written.\n");
    return;
  }

  const { writeGeoSnapshot, countGeoSource } = await import("@/lib/services/geo-import-service");
  const sourceId = arg("source-id") ?? `lgd-${read.stateCode}-${(stamp ?? "undated").replaceAll("-", "")}`;
  const counts = await writeGeoSnapshot(result.snapshot, {
    id: sourceId,
    name: `Local Government Directory — ${read.stateName} (official download)`,
    sourceClass: "official",
    url: "https://lgdirectory.gov.in/downloadDirectory.do",
    observedOn: stamp,
    retrievedOn: stamp,
    checksum: createHash("sha256").update(hashes.join("\n")).digest("hex"),
    licenceStatus: "unverified",
    licenceNote:
      "Downloaded from lgdirectory.gov.in by hand. The LGD pages state no reuse licence; commercial reuse rights are NOT established.",
  });
  console.log(`\nWROTE source ${sourceId}:`, counts);
  console.log("Counted back from the database:", await countGeoSource(sourceId), "\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\nFAILED: ${(e as Error).message}\n`);
    process.exit(1);
  });
