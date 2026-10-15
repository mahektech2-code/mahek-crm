/**
 * THE EXPENSE LEDGER — one salesman's money, line by line, and what was paid.
 *
 * Every figure on the Expenses ledger is DERIVED here from two lists: the
 * expense lines (`mbos_expenses`, read through `lib/expense-money-sql.ts`) and
 * the reimbursements actually handed over (`mbos_expense_payouts`). Nothing is
 * stored beside them, so nothing can disagree with them.
 *
 * A PAYOUT IS PAID AGAINST THE BALANCE, never against one bill. That is how
 * reimbursement works here — one transfer at the end of the week covers a
 * dozen fares and a hotel — and pinning each transfer to lines would make the
 * ordinary case a chore. Which lines a payout covered is then worked out
 * OLDEST FIRST, the same rule the receivables ledger uses, so the per-line
 * "paid / part paid / unpaid" is a reading of the balance rather than a second
 * record of it. A line approved late slots into its own date; the allocation
 * is re-derived on every read, so it can never drift.
 *
 * Pure, like every engine: no I/O, no clock.
 */

export type LedgerLineState =
  | "allowance"
  | "pending"
  | "approved"
  | "partially_approved"
  | "rejected";

export type LedgerLine = {
  id: string;
  /** `YYYY-MM-DD` — the day the money was spent. */
  day: string;
  /** Tie-break inside a day: when it was logged. Any sortable text. */
  loggedAt: string | null;
  allowance: boolean;
  state: LedgerLineState;
  /** What he asked for (or, on an allowance, what it is worth). */
  claimedPaise: number;
  /** What the policy allows on it; null where the day has not been priced. */
  eligiblePaise: number | null;
  /** What the manager allowed, where it was decided. */
  approvedAmountPaise: number | null;
};

export type LedgerPayout = {
  id: string;
  /** `YYYY-MM-DD`. */
  paidOn: string;
  amountPaise: number;
  /** A voided payout is shown and never counted. */
  voided: boolean;
};

/** What the line is worth to him once decided — 0 while waiting or refused. */
export function payablePaise(l: LedgerLine): number {
  if (l.allowance) return l.claimedPaise;
  if (l.state === "approved") return l.approvedAmountPaise ?? l.claimedPaise;
  if (l.state === "partially_approved") return l.approvedAmountPaise ?? 0;
  return 0;
}

/**
 * What was asked for and NOT allowed: the whole of a refused line, the cut on
 * a part-approved one. Never negative — a flat hotel rate can pay more than
 * the bill, and that is not a negative refusal.
 */
export function disallowedPaise(l: LedgerLine): number {
  if (l.allowance || l.state === "pending") return 0;
  if (l.state === "rejected") return l.claimedPaise;
  return Math.max(0, l.claimedPaise - payablePaise(l));
}

export type Eligibility =
  /** Earned by the work log; the policy computed it. */
  | "allowance"
  /** The day has not been worked out against the policy yet. */
  | "unpriced"
  /** The policy allows nothing on it. */
  | "not_eligible"
  /** The policy allows some of it. */
  | "over_policy"
  /** The policy allows all of it. */
  | "within";

/** The policy's own verdict on a line — before any person decided anything. */
export function eligibilityOf(l: LedgerLine): Eligibility {
  if (l.allowance) return "allowance";
  if (l.eligiblePaise === null) return "unpriced";
  if (l.eligiblePaise <= 0 && l.claimedPaise > 0) return "not_eligible";
  if (l.eligiblePaise < l.claimedPaise) return "over_policy";
  return "within";
}

function lineOrder(a: LedgerLine, b: LedgerLine): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  const x = a.loggedAt ?? "";
  const y = b.loggedAt ?? "";
  if (x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type PayStatus = "paid" | "part_paid" | "unpaid" | "nothing_to_pay";

export type Allocation = {
  /** How much of each payable line the payouts have covered. */
  paidByLine: Map<string, number>;
  /** Paid beyond everything payable — an advance against what is still waiting. */
  advancePaise: number;
};

/** Spread every counted payout over the payable lines, oldest first. */
export function allocatePayouts(
  lines: LedgerLine[],
  payouts: LedgerPayout[],
): Allocation {
  let left = payouts
    .filter((p) => !p.voided)
    .reduce((n, p) => n + p.amountPaise, 0);
  const paidByLine = new Map<string, number>();
  for (const l of [...lines].sort(lineOrder)) {
    const owed = payablePaise(l);
    if (owed <= 0) continue;
    const take = Math.min(owed, Math.max(0, left));
    paidByLine.set(l.id, take);
    left -= take;
  }
  return { paidByLine, advancePaise: Math.max(0, left) };
}

export function payStatusOf(l: LedgerLine, alloc: Allocation): PayStatus {
  const owed = payablePaise(l);
  if (owed <= 0) return "nothing_to_pay";
  const paid = alloc.paidByLine.get(l.id) ?? 0;
  if (paid >= owed) return "paid";
  return paid > 0 ? "part_paid" : "unpaid";
}

export type LedgerTotals = {
  /** Expenses he logged — allowances not included. */
  claimedPaise: number;
  claimedCount: number;
  /** Logged expenses allowed, at the amount allowed. */
  approvedPaise: number;
  approvedCount: number;
  partCount: number;
  /** Asked for and not allowed: refusals plus the cuts on part approvals. */
  disallowedPaise: number;
  refusedPaise: number;
  refusedCount: number;
  /** Logged and nobody has decided yet. */
  pendingPaise: number;
  pendingCount: number;
  /** Logged expenses the policy allows nothing on. */
  notEligibleCount: number;
  /** Logged expenses over what the policy allows, by how much in total. */
  overPolicyPaise: number;
  overPolicyCount: number;
  /** Earned by the work log. */
  allowancePaise: number;
  allowanceCount: number;
  /** Approved + allowances: what he is owed in all. */
  payablePaise: number;
  /** Reimbursements handed over (voided ones never count). */
  paidPaise: number;
  /** Owed and not yet paid. */
  duePaise: number;
  /** Paid beyond what is owed. */
  advancePaise: number;
};

/**
 * Totals over the lines and payouts GIVEN. Narrow both to a period for the
 * period's figures; pass everything for the balance. `due` and `advance` are
 * only meaningful over everything — a payout in October settles a September
 * fare — which is why the screens take the balance from an all-time call.
 */
export function ledgerTotals(
  lines: LedgerLine[],
  payouts: LedgerPayout[],
): LedgerTotals {
  const t: LedgerTotals = {
    claimedPaise: 0,
    claimedCount: 0,
    approvedPaise: 0,
    approvedCount: 0,
    partCount: 0,
    disallowedPaise: 0,
    refusedPaise: 0,
    refusedCount: 0,
    pendingPaise: 0,
    pendingCount: 0,
    notEligibleCount: 0,
    overPolicyPaise: 0,
    overPolicyCount: 0,
    allowancePaise: 0,
    allowanceCount: 0,
    payablePaise: 0,
    paidPaise: 0,
    duePaise: 0,
    advancePaise: 0,
  };
  for (const l of lines) {
    t.payablePaise += payablePaise(l);
    if (l.allowance) {
      t.allowancePaise += l.claimedPaise;
      t.allowanceCount += 1;
      continue;
    }
    t.claimedPaise += l.claimedPaise;
    t.claimedCount += 1;
    t.disallowedPaise += disallowedPaise(l);
    const e = eligibilityOf(l);
    if (e === "not_eligible") t.notEligibleCount += 1;
    if (e === "over_policy") {
      t.overPolicyCount += 1;
      t.overPolicyPaise += l.claimedPaise - (l.eligiblePaise ?? 0);
    }
    if (l.state === "pending") {
      t.pendingPaise += l.claimedPaise;
      t.pendingCount += 1;
    } else if (l.state === "rejected") {
      t.refusedPaise += l.claimedPaise;
      t.refusedCount += 1;
    } else {
      t.approvedPaise += payablePaise(l);
      t.approvedCount += 1;
      if (l.state === "partially_approved") t.partCount += 1;
    }
  }
  t.paidPaise = payouts
    .filter((p) => !p.voided)
    .reduce((n, p) => n + p.amountPaise, 0);
  t.duePaise = Math.max(0, t.payablePaise - t.paidPaise);
  t.advancePaise = Math.max(0, t.paidPaise - t.payablePaise);
  return t;
}

export type StatementEntry =
  | {
      kind: "line";
      line: LedgerLine;
      creditPaise: number;
      balancePaise: number;
    }
  | {
      kind: "payout";
      payout: LedgerPayout;
      debitPaise: number;
      balancePaise: number;
    };

/**
 * The statement: every line and every payout in date order, with the balance
 * he is owed after each. A line counts at what it is PAYABLE — a waiting or
 * refused line moves nothing, and is still listed so the statement explains
 * itself. On one day lines come before payouts: the fare is spent before it
 * is repaid. A voided payout is listed and moves nothing.
 */
export function statement(
  lines: LedgerLine[],
  payouts: LedgerPayout[],
): StatementEntry[] {
  type Item = {
    day: string;
    rank: number;
    key: string;
    line?: LedgerLine;
    payout?: LedgerPayout;
  };
  const items: Item[] = [
    ...lines.map((l) => ({
      day: l.day,
      rank: 0,
      key: `${l.loggedAt ?? ""}|${l.id}`,
      line: l,
    })),
    ...payouts.map((p) => ({ day: p.paidOn, rank: 1, key: p.id, payout: p })),
  ];
  items.sort((a, b) =>
    a.day !== b.day
      ? a.day < b.day
        ? -1
        : 1
      : a.rank !== b.rank
        ? a.rank - b.rank
        : a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : 0,
  );
  let balance = 0;
  return items.map((it) => {
    if (it.line) {
      const credit = payablePaise(it.line);
      balance += credit;
      return {
        kind: "line",
        line: it.line,
        creditPaise: credit,
        balancePaise: balance,
      };
    }
    const p = it.payout!;
    const debit = p.voided ? 0 : p.amountPaise;
    balance -= debit;
    return {
      kind: "payout",
      payout: p,
      debitPaise: debit,
      balancePaise: balance,
    };
  });
}
