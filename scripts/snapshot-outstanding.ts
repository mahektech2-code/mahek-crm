/**
 * Records the state of every bill the outstanding workbook names, before a run.
 *
 *   npm run outstanding:snapshot -- "~/Downloads/ALL OUTSTANDING BILLS.xlsx"
 *
 * `apply-outstanding` writes row by row rather than in one transaction — it
 * touches a thousand bills and a transaction that size is its own hazard — so
 * a failure part way leaves the ledger between two states. This is what makes
 * that recoverable, and `restore-outstanding-snapshot` is the other half.
 *
 * Take one BEFORE every real run. It is a few hundred kilobytes of JSON and it
 * is the difference between a partial run being undone in a minute and being
 * unpicked by hand.
 */
import { writeFileSync } from "node:fs";
import { inArray, sql } from "drizzle-orm";
import { db } from "../src/db";
import { bills, payments } from "../src/db/schema";
import { readXlsxCells } from "./xlsx-cells";
import { parseOutstanding } from "../src/lib/outstanding-parse";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error('Usage: npm run outstanding:snapshot -- "<file.xlsx>"');
  process.exit(1);
}

async function main() {
  const cells = readXlsxCells(file!.replace(/^~/, process.env.HOME ?? "~"));
  const parsed = parseOutstanding(cells);
  const numbers = [...parsed.rows.map((r) => r.billNo), ...parsed.unstated.map((u) => u.billNo)];

  const billRows = await db
    .select({
      id: bills.id,
      bill_no: bills.billNo,
      customer_id: bills.customerId,
      amount: bills.amount,
      paid_amount: bills.paidAmount,
      status: bills.status,
      payment_position: bills.paymentPosition,
      payment_decided_at: bills.paymentDecidedAt,
    })
    .from(bills)
    .where(inArray(bills.billNo, numbers));

  const ids = billRows.map((b) => b.id);
  const payRows = ids.length
    ? await db
        .select({ id: payments.id, receipt_id: payments.receiptId, bill_id: payments.billId, amount: payments.amount })
        .from(payments)
        .where(inArray(payments.billId, ids))
    : [];

  // Explicit columns, never a bare select: the deployed schema is older than
  // this checkout's model and a select() would name a column it lacks.
  const receiptRows = ids.length
    ? await db.execute<{ id: string; amount: number }>(sql`
        select distinct r.id, r.amount::int as amount
          from payment_receipts r
          join payments p on p.receipt_id = r.id
         where p.bill_id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}
      `)
    : [];

  const out = {
    takenAt: new Date().toISOString(),
    source: file,
    bills: billRows,
    payments: payRows,
    receipts: Array.from(receiptRows as Iterable<{ id: string; amount: number }>),
  };
  const path = `${process.env.HOME}/mahek-outstanding-snapshot-${out.takenAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, JSON.stringify(out, null, 1));

  console.log(`\nsnapshot written: ${path}`);
  console.log(`  bills ${out.bills.length} | payment lines ${out.payments.length} | receipts ${out.receipts.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
