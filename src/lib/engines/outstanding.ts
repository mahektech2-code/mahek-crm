/* ---------------------------------------------------------------------------
 * What each customer still owes, and which bills it is made of.
 *
 * The bill ledger answers "what did we bill"; this answers "who owes us money",
 * which is the question a telecaller and an accounts clerk both start their day
 * with and neither screen was answering. One row per customer, and the bills
 * behind it on the same row rather than on another screen — the follow-up is
 * "how much" immediately followed by "against what", and making somebody
 * navigate between the two is what makes a chase call go quiet.
 *
 * PURE, like every other engine here: it takes bills and gives back the
 * grouping, so the rule is tested without a database.
 *
 * A bill nobody has stated a payment position for is NOT debt and is never
 * added to the figure — the same rule `recomputeOutstanding` follows. It is
 * still shown, counted separately and said in words, because a bill that is
 * open on the ledger and absent from this screen reads as a screen that has
 * lost it. Silence about a bill is a fact about the account; pretending the
 * bill does not exist is not.
 * ------------------------------------------------------------------------- */

export type OutstandingBillInput = {
  id: string;
  billNo: string;
  customerId: string;
  customerName: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  overdueDays: number;
  bucket: string;
  disputed: boolean;
  /** `unstated` means nobody has said whether this was paid. Not debt. */
  paymentPosition: "stated" | "unstated";
};

export type OutstandingBill = {
  id: string;
  billNo: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  overdueDays: number;
  bucket: string;
  disputed: boolean;
  unstated: boolean;
};

export type OutstandingCustomer = {
  customerId: string;
  customerName: string;
  /** Stated open balance. The figure every other screen means by outstanding. */
  outstanding: number;
  /** How many stated bills carry it. */
  openBills: number;
  /** The worst age on a stated bill. 0 where nothing is past its due date. */
  oldestOverdueDays: number;
  /** The oldest stated bill's aging bucket, so the row can be coloured by it. */
  worstBucket: string | null;
  disputedBills: number;
  /** Open bills nobody has spoken for, and what they add up to. Not debt. */
  unstatedBills: number;
  unstatedAmount: number;
  /** Every open bill, stated first, oldest due date first inside each half. */
  bills: OutstandingBill[];
};

/**
 * Group open bills into one row per customer.
 *
 * Ordered by what is actually owed, because the list exists to be worked from
 * the top. Customers who owe nothing stated sort below everybody who does,
 * ranked among themselves by what is unspoken for — they are work of a
 * different kind (somebody has to go and state those bills), not work of no
 * kind.
 */
export function groupOutstanding(
  rows: readonly OutstandingBillInput[],
): OutstandingCustomer[] {
  const byCustomer = new Map<string, OutstandingCustomer>();

  for (const r of rows) {
    // A settled bill is not outstanding, whoever asked for it. The caller
    // normally filters these out in SQL; guarding here means a caller that
    // does not cannot silently inflate a balance.
    if (r.balance <= 0) continue;

    let row = byCustomer.get(r.customerId);
    if (!row) {
      row = {
        customerId: r.customerId,
        customerName: r.customerName,
        outstanding: 0,
        openBills: 0,
        oldestOverdueDays: 0,
        worstBucket: null,
        disputedBills: 0,
        unstatedBills: 0,
        unstatedAmount: 0,
        bills: [],
      };
      byCustomer.set(r.customerId, row);
    }

    const unstated = r.paymentPosition !== "stated";
    if (unstated) {
      row.unstatedBills += 1;
      row.unstatedAmount += r.balance;
    } else {
      row.outstanding += r.balance;
      row.openBills += 1;
      if (r.disputed) row.disputedBills += 1;
      if (r.overdueDays > row.oldestOverdueDays) {
        row.oldestOverdueDays = r.overdueDays;
        row.worstBucket = r.bucket;
      }
    }

    row.bills.push({
      id: r.id,
      billNo: r.billNo,
      billDate: r.billDate,
      dueDate: r.dueDate,
      amount: r.amount,
      paid: r.paid,
      balance: r.balance,
      overdueDays: r.overdueDays,
      bucket: r.bucket,
      disputed: r.disputed,
      unstated,
    });
  }

  const out = [...byCustomer.values()];
  for (const row of out) {
    row.bills.sort((a, b) => {
      // Stated first: those are the ones somebody can act on today.
      if (a.unstated !== b.unstated) return a.unstated ? 1 : -1;
      // Then oldest due date first — the oldest debt is the one aging, and the
      // one that has to clear before the customer leaves the worklist.
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      return a.billNo < b.billNo ? -1 : 1;
    });
  }

  out.sort(
    (a, b) =>
      b.outstanding - a.outstanding ||
      b.unstatedAmount - a.unstatedAmount ||
      a.customerName.localeCompare(b.customerName),
  );
  return out;
}

/** The figures above the list, summed from the rows it is showing. */
export function outstandingTotals(rows: readonly OutstandingCustomer[]) {
  return {
    customers: rows.filter((r) => r.outstanding > 0).length,
    outstanding: rows.reduce((a, r) => a + r.outstanding, 0),
    bills: rows.reduce((a, r) => a + r.openBills, 0),
    overdueCustomers: rows.filter((r) => r.oldestOverdueDays > 0).length,
    overdue: rows.reduce(
      (a, r) =>
        a + r.bills.filter((b) => !b.unstated && b.overdueDays > 0).reduce((x, b) => x + b.balance, 0),
      0,
    ),
    unstatedCustomers: rows.filter((r) => r.unstatedBills > 0).length,
    unstatedAmount: rows.reduce((a, r) => a + r.unstatedAmount, 0),
  };
}
