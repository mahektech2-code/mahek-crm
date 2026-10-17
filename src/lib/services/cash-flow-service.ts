import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import {
  daysBetween,
  payingHabit,
  predictReceipts,
  type ExpectedIn,
  type PaidLine,
  type PayingHabit,
} from "@/lib/engines/cash-flow";
import { today } from "@/lib/recompute";

/* ---------------------------------------------------------------------------
 * MONEY IN, predicted — the half of Cash flow the vendor payouts are not.
 *
 * Read off the ledger and handed to `engines/cash-flow.ts`:
 *
 *  - HISTORY: every confirmed allocation line against a bill in the lookback
 *    window, from real receipts only. A `sheet_import` receipt is the old
 *    importer assuming a bill was settled, not the customer paying; an
 *    Adjustment or a Credit note is not money arriving. Counting either would
 *    teach the prediction a habit nobody has.
 *  - OPEN BILLS: stated, not disputed, still unpaid — the same three tests
 *    outstanding uses — less whatever a customer has already REPORTED or had
 *    HELD against them, because that money is expected on its own date.
 *  - CLAIMS: reported and held receipts, expected on the date written on the
 *    cheque, else the day they were reported.
 *
 * Accounts sees every book, so nothing here narrows by scope; the module gate
 * is the screen's layout.
 * ------------------------------------------------------------------------- */

export type CashInForecast = {
  items: ExpectedIn[];
  companyHabit: PayingHabit | null;
  minSamples: number;
  lookbackMonths: number;
  /** Customers with open bills whose prediction is borrowed from the company. */
  borrowed: number;
  /** Open bills nothing could predict — no habit anywhere yet. */
  unpredicted: { count: number; amountPaise: number };
};

export async function cashInForecast(): Promise<CashInForecast> {
  const [config, day] = await Promise.all([getConfig(), today()]);
  const lookbackMonths = config["payments.cashflowLookbackMonths"];
  const minSamples = config["payments.cashflowMinPayments"];

  const [history, bills, claims] = await Promise.all([
    db.execute<{ customer_id: string; bill_date: string; paid_on: string; amount: string }>(sql`
      select p.customer_id, b.bill_date::text as bill_date, p.paid_at::text as paid_on, p.amount
        from payments p
        join payment_receipts r on r.id = p.receipt_id
        join bills b on b.id = p.bill_id
       where r.status = 'confirmed'
         and r.source <> 'sheet_import'
         and r.mode not in ('Adjustment', 'Credit note')
         and p.amount > 0
         and p.paid_at >= (${day}::date - make_interval(months => ${lookbackMonths}::int))::date
    `),
    db.execute<{
      bill_id: string;
      bill_no: string;
      customer_id: string;
      customer_name: string;
      bill_date: string;
      balance: string;
    }>(sql`
      select b.id as bill_id, b.bill_no, b.customer_id, c.name as customer_name,
             b.bill_date::text as bill_date,
             (b.amount - b.paid_amount - coalesce(claimed.amount, 0)) as balance
        from bills b
        join customers c on c.id = b.customer_id
        left join (
          select p.bill_id, sum(p.amount) as amount
            from payments p
            join payment_receipts r on r.id = p.receipt_id
           where r.status in ('reported', 'held') and p.bill_id is not null
           group by p.bill_id
        ) claimed on claimed.bill_id = b.id
       where b.payment_position = 'stated'
         and not b.disputed
         and b.amount - b.paid_amount - coalesce(claimed.amount, 0) > 0
    `),
    db.execute<{
      id: string;
      customer_id: string;
      customer_name: string;
      amount: string;
      expected_on: string;
      status: string;
      mode: string;
      reference: string | null;
    }>(sql`
      select r.id, r.customer_id, c.name as customer_name, r.amount,
             coalesce(r.instrument_date, r.received_at)::text as expected_on,
             r.status, r.mode, r.reference
        from payment_receipts r
        join customers c on c.id = r.customer_id
       where r.status in ('reported', 'held')
    `),
  ]);

  const byCustomer = new Map<string, PaidLine[]>();
  const all: PaidLine[] = [];
  for (const h of history) {
    const line = { billDate: h.bill_date, paidOn: h.paid_on, amountPaise: Number(h.amount) };
    all.push(line);
    const list = byCustomer.get(h.customer_id) ?? [];
    list.push(line);
    byCustomer.set(h.customer_id, list);
  }
  const habits = new Map<string, PayingHabit>();
  for (const [id, lines] of byCustomer) {
    const h = payingHabit(lines);
    if (h) habits.set(id, h);
  }
  const companyHabit = payingHabit(all);

  const open = bills.map((b) => ({
    billId: b.bill_id,
    billNo: b.bill_no,
    customerId: b.customer_id,
    customerName: b.customer_name,
    billDate: b.bill_date,
    balancePaise: Number(b.balance),
  }));
  const predicted = predictReceipts({ bills: open, habits, companyHabit, minSamples, today: day });

  const claimItems: ExpectedIn[] = claims.map((c) => {
    // A claim whose date has gone is money that should be in the bank already:
    // it is late, not due today.
    const expectedOn = c.expected_on;
    return {
      key: `receipt:${c.id}`,
      kind: "reported",
      customerId: c.customer_id,
      customerName: c.customer_name,
      label: `${c.status === "held" ? "Held" : "Reported"} · ${c.mode}${c.reference ? ` ${c.reference}` : ""}`,
      amountPaise: Number(c.amount),
      expectedOn,
      basis: "reported",
      lateDays: Math.max(0, daysBetween(expectedOn, day)),
      habit: null,
      billDate: null,
    };
  });

  const borrowedCustomers = new Set(predicted.filter((p) => p.basis === "company").map((p) => p.customerId));
  const unpredicted = companyHabit
    ? { count: 0, amountPaise: 0 }
    : { count: open.length, amountPaise: open.reduce((a, b) => a + b.balancePaise, 0) };

  return {
    items: [...predicted, ...claimItems].sort((a, b) => a.expectedOn.localeCompare(b.expectedOn) || b.amountPaise - a.amountPaise),
    companyHabit,
    minSamples,
    lookbackMonths,
    borrowed: borrowedCustomers.size,
    unpredicted,
  };
}

