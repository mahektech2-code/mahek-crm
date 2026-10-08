/* ---------------------------------------------------------------------------
 * CASH FLOW — what comes in, what goes out, and on which day. PURE.
 *
 * Money OUT is the vendor payouts, planned on a payment day (see
 * `vendor-payouts.ts`). Money IN is a PREDICTION, and it is predicted from how
 * each customer has actually paid — never from the credit term written on the
 * bill. A shop on 30 days that has always paid at 52 will pay at about 52, and
 * a plan built on the term would count that money three weeks early.
 *
 * A customer's PAYING HABIT is the amount-weighted average of the days from a
 * bill's date to the day money against it was confirmed, over real receipts
 * only (the caller leaves out sheet-assumed settlements, credit notes and
 * adjustments, none of which is the customer paying). Weighted by amount
 * because a ₹3 lakh bill paid in 60 days says more about when the next large
 * bill lands than three ₹2,000 ones paid in 10.
 *
 * A customer with too few payments to have a habit borrows the COMPANY's, and
 * every prediction made that way says so. Money a customer has already said is
 * on its way (a reported or held receipt) is not predicted at all: it is
 * expected on the date written on it.
 *
 * Every date is an IST calendar date `YYYY-MM-DD`, handed in.
 * ------------------------------------------------------------------------- */

export type PaidLine = { billDate: string; paidOn: string; amountPaise: number };

export type PayingHabit = {
  /** Amount-weighted average days from bill date to money confirmed. */
  avgDays: number;
  /** How far either side of the average this customer usually lands, in days. */
  spreadDays: number;
  /** Payments the habit was read from. */
  samples: number;
};

function parse(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(parse(iso));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * The habit read from a customer's paid lines, or null with none worth reading.
 * A line paid BEFORE its bill (an advance recorded against it later) counts as
 * day 0: it says the customer pays at once, not that time ran backwards.
 */
export function payingHabit(lines: PaidLine[]): PayingHabit | null {
  const usable = lines.filter((l) => l.amountPaise > 0);
  if (!usable.length) return null;
  const total = usable.reduce((a, l) => a + l.amountPaise, 0);
  const days = usable.map((l) => Math.max(0, daysBetween(l.billDate, l.paidOn)));
  const avg = usable.reduce((a, l, i) => a + days[i] * l.amountPaise, 0) / total;
  const variance = usable.reduce((a, l, i) => a + (days[i] - avg) ** 2 * l.amountPaise, 0) / total;
  return { avgDays: Math.round(avg), spreadDays: Math.round(Math.sqrt(variance)), samples: usable.length };
}

export type OpenBill = {
  billId: string;
  billNo: string;
  customerId: string;
  customerName: string;
  billDate: string;
  /** What is still to arrive, net of money already reported against it. */
  balancePaise: number;
};

export type ExpectedIn = {
  key: string;
  kind: "bill" | "reported";
  customerId: string;
  customerName: string;
  /** The bill, or the receipt's reference. */
  label: string;
  amountPaise: number;
  /** The day it is expected. Before today means it is later than the habit says. */
  expectedOn: string;
  /** own — this customer's habit; company — borrowed; reported — the customer said so. */
  basis: "own" | "company" | "reported";
  /** Days late against the habit, where the expected day has gone. */
  lateDays: number;
  habit: PayingHabit | null;
  billDate: string | null;
};

/**
 * When each open bill is expected: its date plus the customer's own habit,
 * or the company's where the customer has too few payments to have one.
 */
export function predictReceipts(input: {
  bills: OpenBill[];
  habits: Map<string, PayingHabit>;
  companyHabit: PayingHabit | null;
  minSamples: number;
  today: string;
}): ExpectedIn[] {
  const out: ExpectedIn[] = [];
  for (const b of input.bills) {
    if (b.balancePaise <= 0) continue;
    const own = input.habits.get(b.customerId) ?? null;
    const useOwn = !!own && own.samples >= input.minSamples;
    const habit = useOwn ? own : input.companyHabit;
    if (!habit) continue;
    const expectedOn = addDays(b.billDate, habit.avgDays);
    out.push({
      key: `bill:${b.billId}`,
      kind: "bill",
      customerId: b.customerId,
      customerName: b.customerName,
      label: b.billNo,
      amountPaise: b.balancePaise,
      expectedOn,
      basis: useOwn ? "own" : "company",
      lateDays: Math.max(0, daysBetween(expectedOn, input.today)),
      habit,
      billDate: b.billDate,
    });
  }
  return out;
}

export type DayFlow = {
  date: string;
  inPaise: number;
  outPaise: number;
  netPaise: number;
  /** Net from the first day of the window to this one, inclusive. */
  runningPaise: number;
  ins: number;
  outs: number;
};

/**
 * Day by day across a window: what is expected in, what is planned out, and
 * the running net. Anything dated before the window is NOT folded into its
 * first day — "late" and "overdue" are their own figures, because adding money
 * a customer is already late with to today's column is how a plan learns to
 * lie.
 */
export function dailyFlow(
  ins: { on: string; amountPaise: number }[],
  outs: { on: string; amountPaise: number }[],
  from: string,
  days: number,
): DayFlow[] {
  const rows: DayFlow[] = Array.from({ length: days }, (_, i) => ({
    date: addDays(from, i),
    inPaise: 0,
    outPaise: 0,
    netPaise: 0,
    runningPaise: 0,
    ins: 0,
    outs: 0,
  }));
  const index = new Map(rows.map((r, i) => [r.date, i]));
  for (const x of ins) {
    const i = index.get(x.on);
    if (i == null) continue;
    rows[i].inPaise += x.amountPaise;
    rows[i].ins += 1;
  }
  for (const x of outs) {
    const i = index.get(x.on);
    if (i == null) continue;
    rows[i].outPaise += x.amountPaise;
    rows[i].outs += 1;
  }
  let running = 0;
  for (const r of rows) {
    r.netPaise = r.inPaise - r.outPaise;
    running += r.netPaise;
    r.runningPaise = running;
  }
  return rows;
}
