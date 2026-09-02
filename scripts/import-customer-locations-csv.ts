/**
 * Import shop locations from a third-party field-tracking app's one-time CSV
 * export — the salesmen used it to pin shops before MBOS existed.
 *
 *   npm run jobs:customer-locations-csv -- "/path/to/All_Customer_....csv"
 *   npm run jobs:customer-locations-csv -- "/path/to/export.csv" --apply-gps
 *
 * Every row is staged into `field_customer_pins` and matched against
 * `customers` and `users`, whatever the flags. `--apply-gps` is the second,
 * separate step: it writes coordinates from confidently-matched pins onto
 * `customers.gps_lat`/`gps_lng`, never overwriting a real fix. Left optional
 * on this first run so the match summary — how many matched, how many are
 * still ambiguous — can be read before anything is written onto real
 * customer rows, the same discipline `--project` gives on the field-activity
 * import.
 */
import { readFileSync } from "node:fs";
import {
  applyMatchedGps,
  importCustomerLocationsCsv,
} from "../src/lib/services/customer-location-import-service";

async function main() {
  const args = process.argv.slice(2);
  const applyGps = args.includes("--apply-gps");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("Usage: import-customer-locations-csv.ts <path-to-csv> [--apply-gps]");
    process.exit(1);
  }

  const csvText = readFileSync(path, "utf-8");
  const outcome = await importCustomerLocationsCsv(csvText);
  console.log(`import: ${outcome.detail}`);

  if (applyGps) {
    const result = await applyMatchedGps();
    console.log(`apply-gps: ${result.applied} customers given a coordinate`);
  } else {
    console.log("apply-gps: skipped — re-run with --apply-gps once the match summary looks right");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
