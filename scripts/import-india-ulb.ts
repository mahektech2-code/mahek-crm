/* ---------------------------------------------------------------------------
 * LOAD THE ALL-INDIA CITY/TOWN FILE INTO THE OFFICIAL GEOGRAPHY MASTER.
 *
 *   npm run geo:import-india-ulb -- --file <all_india_towns_final_with_codes.csv> --dry-run
 *   npm run geo:import-india-ulb -- --file <...csv>
 *
 * A dry run reads and validates and touches no database. A real run refuses to
 * write unless validation found no ERROR, is ADDITIVE (it never removes a taluka
 * link, a district link or a row an earlier source loaded) and is safe to repeat.
 * It touches no allocation, no shop and no customer.
 *
 * LICENCE: the source row is written `unverified`. Loading is not a statement
 * that commercial reuse of LGD data is permitted.
 * ------------------------------------------------------------------------- */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildGeoSnapshot } from "@/lib/geography/geo-snapshot";
import { readIndiaUlbCsv } from "@/lib/geography/lgd-india-ulb";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const file = arg("file");
  if (!file) throw new Error("Pass --file <all_india_towns_final_with_codes.csv>.");
  const raw = readFileSync(file);
  const read = readIndiaUlbCsv(raw.toString("utf8"));
  const result = buildGeoSnapshot(read.input);
  const s = result.summary;
  const byFlag: Record<string, number> = {};
  for (const f of read.flags) byFlag[f.flag] = (byFlag[f.flag] ?? 0) + 1;

  console.log(`\nAll-India ULB load — ${read.rows} rows`);
  console.log(`  states ${s.states} | districts ${s.districts} | ULBs ${s.ulbs}`);
  console.log(`  ULB↔district links ${result.snapshot.ulbDistricts.length} | district-only ${s.ulbsDistrictOnly} | no district (unresolved) ${s.ulbsNoCoverage}`);
  console.log(`  review flags kept: ${read.flags.length}`, byFlag);
  for (const n of read.notes) console.log(`  note: ${n}`);
  const errors = result.problems.filter((p) => p.severity === "error");
  console.log(`  validation: ${errors.length} errors, ${result.problems.length - errors.length} warnings`);
  for (const p of result.problems.slice(0, 20)) console.log(`    ${p.severity.toUpperCase()} ${p.code}: ${p.message}`);

  const expect = arg("expect"); // e.g. states=35,districts=752,ulbs=5078
  if (expect) {
    for (const pair of expect.split(",")) {
      const [k, v] = pair.split("=");
      const got = (s as Record<string, number>)[k];
      if (got !== Number(v)) throw new Error(`Expected ${k}=${v} but the file holds ${got}. Nothing was written.`);
    }
    console.log(`  expected counts matched (${expect})`);
  }
  if (!result.ok) throw new Error("Validation found errors. Nothing was written.");
  if (flag("dry-run")) {
    console.log("\nDRY RUN — nothing was written.\n");
    return;
  }

  const { writeGeoSnapshot, countGeoSource } = await import("@/lib/services/geo-import-service");
  const sourceId = arg("source-id") ?? "lgd-india-ulb-20261125";
  const counts = await writeGeoSnapshot(
    result.snapshot,
    {
      id: sourceId,
      name: "Local Government Directory — All-India urban local bodies by district (official download)",
      sourceClass: "official",
      url: "https://lgdirectory.gov.in/downloadDirectory.do",
      observedOn: "2026-11-25",
      retrievedOn: "2026-11-25",
      checksum: createHash("sha256").update(raw).digest("hex"),
      licenceStatus: "unverified",
      licenceNote: "Downloaded from lgdirectory.gov.in by hand. The LGD pages state no reuse licence; commercial reuse rights are NOT established.",
    },
    { additive: true, flags: read.flags },
  );
  console.log(`\nWROTE source ${sourceId}:`, counts);
  console.log("Counted back from the database:", await countGeoSource(sourceId), "\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\nFAILED: ${(e as Error).message}\n`);
    process.exit(1);
  });
