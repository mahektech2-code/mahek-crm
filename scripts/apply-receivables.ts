/**
 * Applies Tally's Receivables export to bills the order sheet imported as paid.
 *
 *   npm run receivables -- "~/Downloads/Receivable-08 Aug 26.csv" --dry-run
 *   npm run receivables -- "~/Downloads/Receivable-08 Aug 26.csv"
 *
 * A dry run reads the file, matches every reference against the bills that
 * exist, and reports exactly what a real run would change while writing
 * nothing. Do that first: the unmatched list is the interesting part, and it
 * is easier to read before the ledger moves than after.
 *
 * This only ever UNPAYS. A bill the report does not name keeps whatever paid
 * position it already had, so running it cannot hide a debt.
 */
import { readFileSync } from "node:fs";
import { applyReceivables } from "../src/lib/services/receivables-service";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error('Usage: npm run receivables -- "<file.csv>" [--dry-run]');
  process.exit(1);
}

const rupees = (paise: number) =>
  `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function main() {
  const text = readFileSync(file!.replace(/^~/, process.env.HOME ?? "~"), "utf8");
  const r = await applyReceivables(text, { dryRun });

  console.log(dryRun ? "\nDRY RUN — nothing was written.\n" : "\nApplied.\n");
  console.log(`  bills matched by number   ${r.matched}`);
  console.log(`  one bill split over orders ${r.splitGroups} references over ${r.splitBills} bills`);
  console.log(`  bills changed             ${r.updated}`);
  console.log(`  due dates filled in       ${r.dueDatesSet}`);
  console.log(`  still owed, per the report ${rupees(r.pendingPaise)}`);
  console.log(`  credits not applied       ${r.credits} rows, ${rupees(r.creditsPaise)}`);

  if (r.unmatched.length) {
    const total = r.unmatched.reduce((a, u) => a + u.pendingPaise, 0);
    console.log(`\n  ${r.unmatched.length} references have no bill — ${rupees(total)} unaccounted:`);
    for (const u of r.unmatched.slice(0, 20)) {
      console.log(`    ${u.reference.padEnd(22)} ${u.customer.slice(0, 34).padEnd(36)} ${rupees(u.pendingPaise)}`);
    }
    if (r.unmatched.length > 20) console.log(`    … and ${r.unmatched.length - 20} more`);
  }
  for (const p of r.problems) console.log(`  ! ${p}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
