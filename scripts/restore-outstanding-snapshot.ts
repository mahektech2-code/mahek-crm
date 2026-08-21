/**
 * Puts bills, receipts and allocation lines back to a snapshot taken before an
 * outstanding-workbook run.
 *
 *   npm run outstanding:restore -- ~/mahek-outstanding-snapshot-<n>.json --dry-run
 *   npm run outstanding:restore -- ~/mahek-outstanding-snapshot-<n>.json
 *
 * `apply-outstanding` writes row by row rather than in one transaction, because
 * it touches ten thousand bills and a single transaction that size is its own
 * hazard. The cost of that choice is that a failure part way leaves the ledger
 * between two states, so the snapshot is what makes it recoverable — this is
 * the other half of that pair, and it exists so a partial run is never left to
 * be unpicked by hand.
 *
 * It only ever restores values it can see in the snapshot: an amount that has
 * drifted goes back, and anything the snapshot does not mention is left alone.
 * It creates nothing and deletes nothing.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { bills, payments, paymentReceipts } from "../src/db/schema";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error("Usage: npm run outstanding:restore -- <snapshot.json> [--dry-run]");
  process.exit(1);
}

type Snap = {
  takenAt: string;
  bills: Array<{ id: string; bill_no: string; paid_amount: number; payment_position: string; payment_decided_at: string | null }>;
  receipts: Array<{ id: string; amount: number }>;
  payments: Array<{ id: string; amount: number }>;
};

async function main() {
  const snap: Snap = JSON.parse(
    readFileSync(file!.replace(/^~/, process.env.HOME ?? "~"), "utf8"),
  );
  console.log(`\nsnapshot taken ${snap.takenAt}`);
  console.log(dryRun ? "DRY RUN — nothing will be written.\n" : "Restoring.\n");

  let lines = 0;
  for (const p of snap.payments) {
    const [now] = await db
      .select({ amount: payments.amount })
      .from(payments)
      .where(eq(payments.id, p.id));
    if (!now || now.amount === p.amount) continue;
    console.log(`  payment ${p.id}  ${now.amount / 100} -> ${p.amount / 100}`);
    if (!dryRun) await db.update(payments).set({ amount: p.amount }).where(eq(payments.id, p.id));
    lines++;
  }

  let receipts = 0;
  for (const r of snap.receipts) {
    const [now] = await db
      .select({ amount: paymentReceipts.amount })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, r.id));
    if (!now || now.amount === r.amount) continue;
    console.log(`  receipt ${r.id}  ${now.amount / 100} -> ${r.amount / 100}`);
    if (!dryRun) {
      await db.update(paymentReceipts).set({ amount: r.amount }).where(eq(paymentReceipts.id, r.id));
    }
    receipts++;
  }

  let billRows = 0;
  for (const b of snap.bills) {
    const [now] = await db
      .select({ paid: bills.paidAmount, position: bills.paymentPosition })
      .from(bills)
      .where(eq(bills.id, b.id));
    if (!now) continue;
    if (now.paid === b.paid_amount && now.position === b.payment_position) continue;
    console.log(`  bill ${b.bill_no}  paid ${now.paid / 100} -> ${b.paid_amount / 100}, ${now.position} -> ${b.payment_position}`);
    if (!dryRun) {
      await db
        .update(bills)
        .set({
          paidAmount: b.paid_amount,
          paymentPosition: b.payment_position as "stated" | "unstated",
        })
        .where(eq(bills.id, b.id));
    }
    billRows++;
  }

  console.log(`\n  payment lines ${lines}  receipts ${receipts}  bills ${billRows}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
