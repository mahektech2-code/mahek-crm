/**
 * A CUSTOMER'S ACCOUNT, as the salesman standing at the counter needs it.
 *
 * What was billed, what came in, and what was left after each line. It is the
 * handset's counterpart to MahekOne's own `customerLedger`, and the one rule
 * they share is the load-bearing one: **the running balance counts CONFIRMED
 * money only.** A receipt somebody reported this morning has moved nothing
 * anywhere else in this product and moves nothing here — it is shown, with its
 * status said in words, because the shopkeeper will say "we paid that" and the
 * salesman needs an answer, but it must never read as money in the bank.
 *
 * PURE, and an engine rather than three functions inside `data/customers.ts`,
 * for the reason every engine here is: that file imports the database, so
 * nothing in it can be exercised without a handset — and this is arithmetic
 * about money that a salesman reads out to a customer. Arithmetic nobody can
 * test is arithmetic nobody can be sure of.
 *
 * It is NOT a second opinion about what a shop owes. Every figure it adds up
 * was written by the office and sent down the wire; what is derived here is
 * the ORDER and the running total, which are presentation of those rows and
 * not a re-derivation of any of them. The outstanding figure on the card above
 * is still `customers.outstandingPaise`, the office's own, and this never
 * overwrites it.
 */

/** A bill, as the office holds it — the fields this engine reads. */
export type StatementBill = {
  id: string;
  billNo: string | null;
  billDate: string | null;
  dueDate: string | null;
  amountPaise: number | null;
  paidPaise: number | null;
  balancePaise: number | null;
  overdueDays: number | null;
  disputed: number | null;
  paymentPosition: string | null;
  status: string | null;
  lineCount: number | null;
};

/** A receipt, as the office holds it. */
export type StatementReceipt = {
  id: string;
  receivedAt: string | null;
  amountPaise: number | null;
  mode: string | null;
  reference: string | null;
  status: string | null;
};

/*
 * GENERIC OVER THE ROW, so a caller gets back exactly what it put in.
 *
 * The types above are the fields this engine READS, structurally — the same
 * shape rule `account-label.ts` follows and for the same reason: naming
 * `CustomerBill` here would point a pure engine at `data/customers.ts`, which
 * imports the database, and nothing in this file could be tested again. What
 * the screen needs back is its own row, with the columns this engine has no
 * opinion about still on it, so the entry carries `B` and `R` rather than the
 * narrowed shapes.
 */
export type StatementEntry<B extends StatementBill, R extends StatementReceipt> =
  | { kind: 'bill'; at: string; balancePaise: number; bill: B }
  | { kind: 'receipt'; at: string; balancePaise: number; receipt: R };

export type Statement<B extends StatementBill, R extends StatementReceipt> = {
  /** Newest first, which is reading order — see `buildStatement`. */
  entries: StatementEntry<B, R>[];
  /** What was owed before the window opened. */
  openingPaise: number;
  billedPaise: number;
  receivedPaise: number;
  /** Claimed and not yet found by accounts. Counted nowhere, said out loud. */
  awaitingPaise: number;
  awaitingCount: number;
};

/**
 * Only `confirmed` money has moved anything.
 *
 * `reported` and `held` are claims nobody has found yet; `rejected` never
 * arrived and `reversed` arrived and failed. All four are drawn and none of
 * them counts. This is spelled as one predicate rather than checked at three
 * call sites, because the day a fifth status appears the dangerous default is
 * "counts".
 */
export function countsAsMoney(status: string | null | undefined): boolean {
  return status === 'confirmed';
}

/**
 * The statement for one window.
 *
 * The running balance is CUMULATIVE, so it can only be computed oldest first —
 * reversing the computation would produce a column of numbers counting down
 * from nothing to the wrong answer. What is reversed is the reading order, and
 * only that, exactly as the Accounts screen does it: each entry keeps the
 * balance it was given, so the top row is what the customer owes today rather
 * than what they owed on the first bill of the year.
 *
 * A bill with NO DATE sorts last rather than being dropped — the same rule the
 * route engine follows for a shop with no pin, and for the same reason: a row
 * missing from a statement is a row nobody can account for, and the salesman
 * is the one who gets asked about it.
 */
export function buildStatement<B extends StatementBill, R extends StatementReceipt>(
  bills: B[],
  receipts: R[],
  range?: { from?: string; to?: string },
): Statement<B, R> {
  type Row =
    | { kind: 'bill'; at: string; debit: number; credit: number; bill: B }
    | { kind: 'receipt'; at: string; debit: number; credit: number; receipt: R };

  const rows: Row[] = [];

  for (const b of bills) {
    rows.push({
      kind: 'bill',
      at: b.billDate ?? '',
      debit: b.amountPaise ?? 0,
      credit: 0,
      bill: b,
    });
  }
  for (const r of receipts) {
    rows.push({
      kind: 'receipt',
      at: r.receivedAt ?? '',
      debit: 0,
      credit: countsAsMoney(r.status) ? (r.amountPaise ?? 0) : 0,
      receipt: r,
    });
  }

  /* Oldest first to compute, and a BILL before a receipt on the same day: an
     invoice raised and settled the same afternoon reads as owed and then paid,
     which is what happened, rather than as a credit standing before the debt
     that explains it. The id breaks the remaining tie so two runs over one set
     can never disagree — the same reason a paged read in the CRM carries one. */
  rows.sort((a, z) => {
    const noA = a.at === '';
    const noZ = z.at === '';
    if (noA !== noZ) return noA ? 1 : -1;
    if (a.at !== z.at) return a.at.localeCompare(z.at);
    if (a.kind !== z.kind) return a.kind === 'bill' ? -1 : 1;
    const ida = a.kind === 'bill' ? a.bill.id : a.receipt.id;
    const idz = z.kind === 'bill' ? z.bill.id : z.receipt.id;
    return ida.localeCompare(idz);
  });

  const from = range?.from;
  const to = range?.to;
  let balance = 0;
  let opening = 0;
  let billed = 0;
  let received = 0;
  let awaiting = 0;
  let awaitingCount = 0;
  const entries: StatementEntry<B, R>[] = [];

  for (const r of rows) {
    balance += r.debit - r.credit;

    /* A row with no date is inside every window. It cannot be compared, and
       hiding it because a filter is on is how a bill disappears from a screen
       for a reason nobody can see. */
    const dated = r.at !== '';
    if (dated && from && r.at < from) {
      /* Before the window: it is not shown, but it is what the window opens
         at. A statement starting from zero on the 1st of April tells a
         customer they owe this year's bills alone. */
      opening = balance;
      continue;
    }
    if (dated && to && r.at > to) continue;

    if (r.kind === 'bill') {
      billed += r.debit;
      entries.push({ kind: 'bill', at: r.at, balancePaise: balance, bill: r.bill });
    } else {
      received += r.credit;
      if (r.receipt.status === 'reported' || r.receipt.status === 'held') {
        awaiting += r.receipt.amountPaise ?? 0;
        awaitingCount += 1;
      }
      entries.push({ kind: 'receipt', at: r.at, balancePaise: balance, receipt: r.receipt });
    }
  }

  entries.reverse();
  return {
    entries,
    openingPaise: opening,
    billedPaise: billed,
    receivedPaise: received,
    awaitingPaise: awaiting,
    awaitingCount,
  };
}

/* ------------------------------------------------------------- the periods */

export type PeriodKey = 'this_month' | 'last_month' | 'three_months' | 'this_year' | 'all';

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'three_months', label: 'Last 3 months' },
  { key: 'this_year', label: 'This year' },
  /* The window the phone actually holds, which is not "everything" and must
     not be labelled as though it were — see `mbos.sync.statementMonths`. The
     screen says how far back it reaches. */
  { key: 'all', label: 'Everything here' },
];

/**
 * A period as two dates, from the day the salesman is standing in.
 *
 * "This year" is the FINANCIAL year, April to March — that is the year a bill
 * number on this book is stamped with (`MMI/26-27/1119`), it is the year the
 * office's own ledger is cut by, and it is what a shopkeeper means when he
 * asks what he has bought this year. A calendar year here would answer a
 * question nobody asked and disagree with the invoice in his hand.
 *
 * NO `Date` ANYWHERE IN HERE. A `YYYY-MM-DD` and a number of months is integer
 * arithmetic, and every spelling that reaches for a Date has to be read twice
 * before anybody can say whether it is one of the ones that was wrong:
 * `new Date('2026-09-13')` parses as UTC and every local getter then answers in
 * the phone's own zone, and `toISOString().slice(0, 10)` answers in UTC
 * whatever it was built from. MahekOne's own grep guard refuses the second
 * outright — see §11 — and this file is the same rule one runtime over.
 */
export function periodRange(period: PeriodKey, today: string): { from?: string; to?: string } {
  const [y, m] = today.split('-').map(Number);

  /** A month index counted from year 0, so "one month back" needs no branch. */
  const first = (months: number) => {
    const total = y * 12 + (m - 1) - months;
    const yy = Math.floor(total / 12);
    const mm = total - yy * 12 + 1;
    return `${yy}-${String(mm).padStart(2, '0')}-01`;
  };

  switch (period) {
    case 'this_month':
      return { from: first(0), to: today };
    case 'last_month': {
      /* The WHOLE of it, which is what somebody means by "last month" — not
         the same span ending today. Its last day is counted rather than found
         by stepping back from the 1st of this one, because that step is the
         Date this function exists without. */
      const start = first(1);
      const [ly, lm] = start.split('-').map(Number);
      return { from: start, to: `${start.slice(0, 7)}-${daysInMonth(ly, lm)}` };
    }
    case 'three_months':
      /* The two whole months before this one, plus this one to date. A rolling
         ninety days would cut a month in half, and a salesman comparing it
         against a month-end figure the office quoted would be reading two
         different things. */
      return { from: first(2), to: today };
    case 'this_year': {
      /* April to March. Before April, the year that started last April. */
      const startYear = m >= 4 ? y : y - 1;
      return { from: `${startYear}-04-01`, to: today };
    }
    case 'all':
    default:
      return {};
  }
}

/** How long a month is, leap years included. `mm` is 1-based. */
function daysInMonth(yy: number, mm: number): string {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = mm === 2 && (yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0));
  return String(lengths[mm - 1] + (leap ? 1 : 0));
}
