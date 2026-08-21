import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { bills, payments, paymentReceipts } from "@/db/schema";
import { calendarDate } from "../business-date";
import { modeForReason, parseOutstanding, type OutstandingRow } from "../outstanding-parse";
import {
  recomputeAllBillPaid,
  recomputeAllFollowUpStates,
  recomputeAllOutstanding,
  recomputeBillStatuses,
  recomputeSlowPayers,
} from "../recompute";

/* ---------------------------------------------------------------------------
 * Applying the "ALL OUTSTANDING BILLS" workbook to the ledger.
 *
 * This differs from `receivables-service` in the one way that matters, and it
 * is worth saying out loud: THAT one only ever unpays, so running it can never
 * hide a debt. This one moves in both directions — a `Paid` row settles a
 * bill — because the sheet states a position for every row rather than listing
 * only what is owed.
 *
 * That is a real power and it is fenced accordingly:
 *
 *   A PERSON IS BEHIND IT. This is not the Google Sheet sync, which may never
 *   write money by any path. It is a file somebody in accounts produced from
 *   Tally and applied by hand, on purpose, with a dry run first — the same
 *   standing as the receivables report, which also writes. `paymentPosition`
 *   moves to `stated` because a person HAS now spoken for these bills.
 *
 *   IT NEVER OVERRULES ACCOUNTS. Confirmed receipts recorded in the app are
 *   money somebody found in a bank statement with their name against it. Where
 *   this sheet claims LESS was received than those receipts already prove, the
 *   bill is reported as a conflict and left exactly as it stands. Only the
 *   assumed receipts — the sheet import's, and this import's own — are ever
 *   edited or removed.
 *
 *   A BLANK STATUS WRITES NOTHING. Rows the sheet left unfilled are counted
 *   and listed, never inferred from the figure beside them.
 *
 *   IT IS RE-RUNNABLE. Every receipt it creates carries a deterministic
 *   `TALLYOUT-<bill no>` key and its own `source`, so a second run converges on
 *   the same ledger instead of stacking a second payment on every bill, and
 *   the whole import stays identifiable — and reversible — afterwards.
 * ------------------------------------------------------------------------- */

/**
 * The source stamped on receipts this import creates.
 *
 * Deliberately NOT `sheet_import`: that value names the order sheet's assumed
 * receipts, `revertSheetSettledBills` deletes exactly those, and re-using it
 * would put this file's work inside the blast radius of a cleanup aimed at a
 * different mistake. It also keeps `matchesForEntry` and the duplicate check
 * behaving as they do today, since both key on `sheet_import` by name.
 */
export const OUTSTANDING_SOURCE = "tally_outstanding";

/** The receipts this import is allowed to edit: assumptions, not decisions. */
const ASSUMED = [OUTSTANDING_SOURCE, "sheet_import"];

export type OutstandingConflict = {
  billNo: string;
  customer: string;
  /** What the app has already confirmed, in paise. */
  confirmedPaise: number;
  /** What this sheet says was settled, in paise. */
  statedSettledPaise: number;
};

export type OutstandingReport = {
  /** Rows read from the sheet, excluding blanks and problems. */
  read: number;
  /** Bills matched by their exact number. */
  matched: number;
  /** References that were one Tally bill split across several orders. */
  splitGroups: number;
  splitBills: number;
  /** Bills whose settled position actually moved. */
  updated: number;
  /** Bills moved out of `unstated` — newly counted in outstanding. */
  stated: number;
  /**
   * Receipts whose date the sheet put in the future, pulled back to the run
   * date. Money cannot have been received tomorrow.
   */
  datesClamped: number;
  /** Assumed receipts created, edited and removed. */
  receiptsCreated: number;
  receiptsAdjusted: number;
  receiptsRemoved: number;
  /** What the sheet says is still owed, in paise. */
  owedPaise: number;
  /** What it says has been settled, in paise. */
  settledPaise: number;
  /** Rows with no bill behind them. */
  unmatched: Array<{ billNo: string; customer: string; owedPaise: number }>;
  /** Rows the sheet left with no status: counted, never applied. */
  unstated: Array<{ billNo: string; customer: string; statedPaise: number }>;
  unstatedPaise: number;
  /** Bills where the sheet contradicts money accounts have confirmed. */
  conflicts: OutstandingConflict[];
  problems: string[];
  dryRun: boolean;
};

type BillRow = {
  id: string;
  billNo: string;
  customerId: string;
  amount: number;
  paymentPosition: string;
};

type Effect = {
  created: number;
  adjusted: number;
  removed: number;
  clamped: number;
  moved: boolean;
};

const NOTHING: Effect = { created: 0, adjusted: 0, removed: 0, clamped: 0, moved: false };

/**
 * Brings one bill's assumed receipts to leave exactly `owed` outstanding.
 *
 * Paid is derived from confirmed receipts, so this edits receipts rather than
 * writing `paid_amount` — that column already has an author in `recompute.ts`,
 * and a second one would simply be undone by the next pass.
 */
async function settleTo(
  bill: BillRow,
  owed: number,
  row: OutstandingRow,
  runDate: string,
  dryRun: boolean,
  report: OutstandingReport,
): Promise<Effect> {
  const target = Math.max(0, bill.amount - owed);

  // Money accounts actually confirmed, which this import may not touch.
  const [real] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)::bigint` })
    .from(payments)
    .innerJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
    .where(
      and(
        eq(payments.billId, bill.id),
        eq(paymentReceipts.status, "confirmed"),
        sql`${paymentReceipts.source} not in ${sql`(${sql.join(ASSUMED.map((s) => sql`${s}`), sql`, `)})`}`,
      ),
    );
  const confirmed = Number(real?.total ?? 0);

  if (confirmed > target) {
    // The sheet says less was received than accounts have already proved. That
    // is a disagreement between a spreadsheet and somebody holding a bank
    // statement, and the spreadsheet does not win it silently.
    report.conflicts.push({
      billNo: bill.billNo,
      customer: row.customer,
      confirmedPaise: confirmed,
      statedSettledPaise: target,
    });
    return NOTHING;
  }

  const want = target - confirmed;

  // CONFIRMED only, and that word is load-bearing.
  //
  // A `reversed` or `rejected` receipt is not an assumption this import may
  // tidy up — it is somebody recording that money counted and then failed, or
  // was looked for and never found. It already weighs nothing, since paid is
  // derived from confirmed receipts alone, so editing one moves no figure on
  // any screen and simply rewrites the record of a decision. Production
  // carries `sheet_import` receipts in exactly that state, left behind by an
  // earlier cleanup; without this filter the import walked in and restated
  // their amounts. Where they exist the honest move is to leave them and
  // write a new receipt for what is actually owed.
  const ours = await db
    .select({ paymentId: payments.id, receiptId: payments.receiptId, amount: payments.amount })
    .from(payments)
    .innerJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
    .where(
      and(
        eq(payments.billId, bill.id),
        eq(paymentReceipts.status, "confirmed"),
        inArray(paymentReceipts.source, ASSUMED),
      ),
    );

  const have = ours.reduce((a, o) => a + o.amount, 0);
  if (have === want) return NOTHING;

  const effect: Effect = { created: 0, adjusted: 0, removed: 0, clamped: 0, moved: true };

  if (want === 0) {
    for (const o of ours) {
      if (!dryRun) await removeAssumed(o.paymentId, o.receiptId);
      effect.removed++;
    }
    return effect;
  }

  if (ours.length) {
    // Keep the first and make it carry the whole figure; anything else on this
    // bill was a second assumption about the same money.
    const [keep, ...rest] = ours;
    for (const o of rest) {
      if (!dryRun) await removeAssumed(o.paymentId, o.receiptId);
      effect.removed++;
    }
    if (!dryRun) {
      await db.update(payments).set({ amount: want, updatedAt: new Date() })
        .where(eq(payments.id, keep.paymentId));
      await syncReceiptAmount(keep.receiptId);
    }
    effect.adjusted++;
    return effect;
  }

  if (row.date && row.date > runDate) effect.clamped++;
  if (!dryRun) await createAssumed(bill, want, row, runDate);
  effect.created++;
  return effect;
}

/** Drops one assumed allocation, and its receipt once nothing is left on it. */
async function removeAssumed(paymentId: string, receiptId: string) {
  await db.delete(payments).where(eq(payments.id, paymentId));
  const rest = await db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.receiptId, receiptId));
  if (!rest.length) await db.delete(paymentReceipts).where(eq(paymentReceipts.id, receiptId));
  else await syncReceiptAmount(receiptId);
}

/** A receipt is worth what its lines are worth. */
async function syncReceiptAmount(receiptId: string) {
  await db.execute(sql`
    update payment_receipts r
       set amount = coalesce((select sum(p.amount) from payments p where p.receipt_id = r.id), 0),
           updated_at = now()
     where r.id = ${receiptId}
  `);
}

async function createAssumed(bill: BillRow, amount: number, row: OutstandingRow, runDate: string) {
  const receiptId = `rcp_${randomUUID().slice(0, 12)}`;
  // The sheet's own date where it gave a readable one, and the day of the run
  // where it did not. A receipt must carry a date, and an invented precise one
  // is worse than an honest approximate one.
  //
  // A date AFTER the run is pulled back rather than stored: 13 rows in this
  // book are dated weeks ahead, and money cannot have been received tomorrow.
  // `received_at` feeds the aging and the collections worklist, where a future
  // date reads as a payment that has not happened yet.
  const stated = row.date ?? runDate;
  const receivedAt = stated > runDate ? runDate : stated;
  const mode = modeForReason(row.reason);

  const note = `ALL OUTSTANDING BILLS — ${row.status}${row.reason ? ` (${row.reason})` : ""}`;

  // Written as raw SQL naming ONLY the columns this row actually needs.
  //
  // Drizzle's insert builder names every column in the model, defaults
  // included, so it fails outright against a database whose schema is older
  // than the checkout — which is exactly what production is: the deployed app
  // predates `0053_receipt_cash_deposit`, and `payment_receipts` there has no
  // `deposited_at`. This import is a hand-run correction to a live ledger, and
  // it must not require a schema migration as a side effect of being run. The
  // columns below have existed since the table did.
  await db.execute(sql`
    insert into payment_receipts
      (id, customer_id, amount, received_at, mode, status, source, note, idempotency_key)
    values
      (${receiptId}, ${bill.customerId}, ${amount}, ${receivedAt}, ${mode},
       'confirmed', ${OUTSTANDING_SOURCE}, ${note},
       -- Deterministic, so a second run finds this one instead of writing another.
       ${`TALLYOUT-${bill.billNo}`})
  `);

  // Raw for the same reason as the receipt above: this tool has to run against
  // the deployed schema, not only the one in the checkout.
  await db.execute(sql`
    insert into payments (id, receipt_id, bill_id, customer_id, amount, paid_at, mode)
    values (${`pay_${randomUUID().slice(0, 12)}`}, ${receiptId}, ${bill.id},
            ${bill.customerId}, ${amount}, ${receivedAt}, ${mode})
  `);
}

/**
 * Marks the bill as one somebody has spoken for.
 *
 * `paymentPosition` is set unconditionally — the sheet naming this bill IS the
 * statement, and that is what lifts it into outstanding, the aging strip and
 * the collections worklist. `paymentDecidedAt` is set only where there is none:
 * it records WHEN the position was first decided, and overwriting it would
 * restamp a decision somebody else made earlier with today's date.
 */
async function markStated(bill: BillRow) {
  await db
    .update(bills)
    .set({
      paymentPosition: "stated",
      paymentDecidedAt: sql`coalesce(${bills.paymentDecidedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(eq(bills.id, bill.id));
}

export async function applyOutstanding(
  cells: string[][],
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<OutstandingReport> {
  const parsed = parseOutstanding(cells);
  const dryRun = options.dryRun ?? false;
  const runDate = calendarDate(options.now ?? new Date());

  const report: OutstandingReport = {
    read: parsed.rows.length,
    matched: 0,
    splitGroups: 0,
    splitBills: 0,
    updated: 0,
    stated: 0,
    datesClamped: 0,
    receiptsCreated: 0,
    receiptsAdjusted: 0,
    receiptsRemoved: 0,
    owedPaise: 0,
    settledPaise: 0,
    unmatched: [],
    unstated: parsed.unstated.map((u) => ({
      billNo: u.billNo,
      customer: u.customer,
      statedPaise: u.statedPaise,
    })),
    unstatedPaise: parsed.unstated.reduce((a, u) => a + u.statedPaise, 0),
    conflicts: [],
    problems: parsed.problems,
    dryRun,
  };

  const numbers = [...new Set(parsed.rows.map((r) => r.billNo))];
  const exact: BillRow[] = numbers.length
    ? await db
        .select({
          id: bills.id,
          billNo: bills.billNo,
          customerId: bills.customerId,
          amount: bills.amount,
          paymentPosition: bills.paymentPosition,
        })
        .from(bills)
        .where(inArray(bills.billNo, numbers))
    : [];
  const byNo = new Map(exact.map((b) => [b.billNo, b]));

  const apply = async (bill: BillRow, owed: number, row: OutstandingRow) => {
    if (bill.paymentPosition !== "stated") report.stated++;
    if (!dryRun) await markStated(bill);
    const e = await settleTo(bill, owed, row, runDate, dryRun, report);
    report.receiptsCreated += e.created;
    report.receiptsAdjusted += e.adjusted;
    report.receiptsRemoved += e.removed;
    report.datesClamped += e.clamped;
    if (e.moved) report.updated++;
  };

  for (const row of parsed.rows) {
    report.owedPaise += row.owedPaise;
    report.settledPaise += row.status === "paid" ? row.statedPaise : 0;

    const direct = byNo.get(row.billNo);
    if (direct) {
      report.matched++;
      await apply(direct, row.owedPaise, row);
      continue;
    }

    // One Tally bill can cover several orders, and the import made one bill per
    // order — `MMI/26-27/0718` became `.../0718/8590`, `/8591`, `/8592`. The
    // position is against the Tally bill as a whole, so what is owed is spread
    // over the group oldest first, exactly as a real payment would be applied.
    const group: BillRow[] = await db
      .select({
        id: bills.id,
        billNo: bills.billNo,
        customerId: bills.customerId,
        amount: bills.amount,
        paymentPosition: bills.paymentPosition,
      })
      .from(bills)
      .where(like(bills.billNo, `${row.billNo}/%`))
      .orderBy(bills.billDate, bills.billNo);

    if (!group.length) {
      report.unmatched.push({
        billNo: row.billNo,
        customer: row.customer,
        owedPaise: row.owedPaise,
      });
      continue;
    }

    report.splitGroups++;
    report.splitBills += group.length;

    let left = row.owedPaise;
    for (const b of group) {
      const owing = Math.min(left, b.amount);
      left -= owing;
      await apply(b, owing, row);
    }
  }

  if (!dryRun) {
    // Everything downstream is a cache over what just changed.
    await recomputeAllBillPaid();
    await recomputeBillStatuses();
    await recomputeAllOutstanding();
    await recomputeAllFollowUpStates();
    await recomputeSlowPayers();
  }

  return report;
}
