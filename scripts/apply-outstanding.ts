/**
 * Applies the "ALL OUTSTANDING BILLS" workbook to the ledger.
 *
 *   npm run outstanding -- "~/Downloads/ALL OUTSTANDING BILLS.xlsx" --dry-run
 *   npm run outstanding -- "~/Downloads/ALL OUTSTANDING BILLS.xlsx"
 *
 * Do the dry run first and read the unmatched and conflict lists — they are
 * the interesting parts, and they are far easier to read before the ledger
 * moves than after.
 *
 * Unlike the receivables report, this file settles bills as well as opens
 * them: a `Paid` row means the money has gone. See the header of
 * `outstanding-import-service.ts` for what that is fenced by.
 */
import { readXlsxCells } from "./xlsx-cells";
import { applyOutstanding } from "../src/lib/services/outstanding-import-service";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error('Usage: npm run outstanding -- "<file.xlsx>" [--dry-run]');
  process.exit(1);
}

const rupees = (paise: number) =>
  `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function main() {
  const path = file!.replace(/^~/, process.env.HOME ?? "~");
  const cells = readXlsxCells(path);
  const r = await applyOutstanding(cells, { dryRun });

  console.log(r.dryRun ? "\nDRY RUN — nothing was written.\n" : "\nApplied.\n");
  console.log(`  rows read                 ${r.read}`);
  console.log(`  bills matched by number   ${r.matched}`);
  console.log(`  one bill split over orders ${r.splitGroups} references over ${r.splitBills} bills`);
  console.log(`  bills whose position moved ${r.updated}`);
  console.log(`  bills newly spoken for    ${r.stated}`);
  if (r.datesClamped) console.log(`  future dates pulled back  ${r.datesClamped}`);
  console.log(`  assumed receipts  created ${r.receiptsCreated}  adjusted ${r.receiptsAdjusted}  removed ${r.receiptsRemoved}`);
  console.log(`\n  still owed, per the sheet ${rupees(r.owedPaise)}`);
  console.log(`  settled, per the sheet    ${rupees(r.settledPaise)}`);

  if (r.unstated.length) {
    console.log(`\n  ${r.unstated.length} rows have no status — ${rupees(r.unstatedPaise)} left alone:`);
    const byCustomer = new Map<string, { n: number; paise: number }>();
    for (const u of r.unstated) {
      const e = byCustomer.get(u.customer) ?? { n: 0, paise: 0 };
      e.n++; e.paise += u.statedPaise;
      byCustomer.set(u.customer, e);
    }
    for (const [customer, e] of [...byCustomer].sort((a, b) => b[1].paise - a[1].paise)) {
      console.log(`    ${customer.slice(0, 40).padEnd(42)} ${String(e.n).padStart(3)} bills  ${rupees(e.paise)}`);
    }
  }

  if (r.conflicts.length) {
    console.log(`\n  ${r.conflicts.length} bills contradict confirmed receipts and were LEFT ALONE:`);
    for (const c of r.conflicts.slice(0, 20)) {
      console.log(`    ${c.billNo.padEnd(22)} ${c.customer.slice(0, 28).padEnd(30)} confirmed ${rupees(c.confirmedPaise)} > sheet ${rupees(c.statedSettledPaise)}`);
    }
    if (r.conflicts.length > 20) console.log(`    … and ${r.conflicts.length - 20} more`);
  }

  if (r.unmatched.length) {
    const total = r.unmatched.reduce((a, u) => a + u.owedPaise, 0);
    console.log(`\n  ${r.unmatched.length} bill numbers have no bill — ${rupees(total)} unaccounted:`);
    for (const u of r.unmatched.slice(0, 20)) {
      console.log(`    ${u.billNo.padEnd(22)} ${u.customer.slice(0, 34).padEnd(36)} ${rupees(u.owedPaise)}`);
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
