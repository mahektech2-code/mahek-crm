import type { BusinessDate } from "../business-date";

/* ---------------------------------------------------------------------------
 * E8 — Payment Allocation
 *
 * One arrival of money, several bills it might settle. This decides which.
 *
 * Three ways of asking the same question, because accounts ask it three ways:
 * "put it against the oldest" (auto), "these two are settled" (settle), and
 * "₹40,000 of it is for bill 118" (custom). All three come back as the same
 * list of lines, so the caller writes one kind of row whichever was used.
 *
 * Money left over is not an error. A round-figure transfer against an awkward
 * balance, or money sent before the bill exists, both leave a remainder, and
 * refusing it at the door is how a receipt gets recorded for the wrong amount
 * to make the screen accept it. It becomes a line with no bill — on account —
 * and the next bill picks it up.
 *
 * Pure. Bills, an amount and an instruction go in; lines and a remainder come
 * out. Nothing here reads a clock or a database.
 * ------------------------------------------------------------------------- */

export type AllocatableBill = {
  id: string;
  billNo: string;
  billDate: BusinessDate;
  /** Paise. */
  amount: number;
  /** Paise already settled by confirmed money. */
  paid: number;
};

export type AllocationMode = "auto" | "settle" | "custom";

export type AllocationRequest = {
  mode: AllocationMode;
  /** Paise. The whole receipt. */
  amount: number;
  /** `settle`: the bills being cleared. Ignored by the other two. */
  selectedBillIds?: readonly string[];
  /** `custom`: paise against each bill, by bill id. Ignored by the other two. */
  custom?: Readonly<Record<string, number>>;
  /** When false, a remainder is refused instead of going on account. */
  allowOnAccount?: boolean;
};

export type AllocationLine = {
  /** Null is money on account — received, not yet against a bill. */
  billId: string | null;
  billNo: string | null;
  amount: number;
};

export type AllocationResult = {
  lines: AllocationLine[];
  /** Paise placed against bills. */
  allocated: number;
  /** Paise left on account. */
  onAccount: number;
  /** Empty when the allocation can be saved. */
  errors: string[];
};

export function billBalance(b: Pick<AllocatableBill, "amount" | "paid">): number {
  return Math.max(0, b.amount - b.paid);
}

/** Oldest first, and stably — two bills of the same date order by number. */
export function oldestFirst(bills: readonly AllocatableBill[]): AllocatableBill[] {
  return [...bills].sort(
    (a, b) => a.billDate.localeCompare(b.billDate) || a.billNo.localeCompare(b.billNo),
  );
}

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export function allocate(
  bills: readonly AllocatableBill[],
  request: AllocationRequest,
): AllocationResult {
  const errors: string[] = [];
  const { amount } = request;

  if (!Number.isInteger(amount) || amount <= 0) {
    return { lines: [], allocated: 0, onAccount: 0, errors: ["Enter the amount received."] };
  }

  const open = oldestFirst(bills).filter((b) => billBalance(b) > 0);
  const byId = new Map(open.map((b) => [b.id, b]));
  const lines: AllocationLine[] = [];

  if (request.mode === "auto") {
    let left = amount;
    for (const b of open) {
      if (left <= 0) break;
      const take = Math.min(left, billBalance(b));
      lines.push({ billId: b.id, billNo: b.billNo, amount: take });
      left -= take;
    }
  }

  if (request.mode === "settle") {
    const picked = (request.selectedBillIds ?? []).map((billId) => byId.get(billId));
    if (!picked.length) errors.push("Tick the bills this payment settles.");
    if (picked.some((b) => !b)) {
      errors.push("One of the bills selected is no longer open.");
    }
    const live = picked.filter((b): b is AllocatableBill => Boolean(b));
    const needed = live.reduce((sum, b) => sum + billBalance(b), 0);
    if (live.length && amount < needed) {
      // Not a rounding slip — the person ticked bills worth more than the money
      // that arrived, so say what settling them would take.
      errors.push(
        `Settling those bills takes ${rupees(needed)}, which is more than the ${rupees(amount)} received. Use a custom split instead.`,
      );
    }
    let left = amount;
    for (const b of oldestFirst(live)) {
      if (left <= 0) break;
      const take = Math.min(left, billBalance(b));
      lines.push({ billId: b.id, billNo: b.billNo, amount: take });
      left -= take;
    }
  }

  if (request.mode === "custom") {
    const entries = Object.entries(request.custom ?? {}).filter(([, v]) => v > 0);
    if (!entries.length) errors.push("Enter how much goes against at least one bill.");
    for (const [billId, value] of entries) {
      const b = byId.get(billId);
      if (!b) {
        errors.push("One of the bills is no longer open.");
        continue;
      }
      if (!Number.isInteger(value) || value < 0) {
        errors.push(`${b.billNo}: that is not an amount.`);
        continue;
      }
      const balance = billBalance(b);
      if (value > balance) {
        errors.push(`${b.billNo} has only ${rupees(balance)} open.`);
        continue;
      }
      lines.push({ billId: b.id, billNo: b.billNo, amount: value });
    }
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    if (total > amount) {
      errors.push(
        `The split comes to ${rupees(total)}, more than the ${rupees(amount)} received.`,
      );
    }
  }

  const allocated = lines.reduce((sum, l) => sum + l.amount, 0);
  const onAccount = Math.max(0, amount - allocated);

  if (onAccount > 0) {
    if (request.allowOnAccount === false) {
      errors.push(
        `${rupees(onAccount)} is not against any bill. Split the whole amount, or allow money on account.`,
      );
    } else {
      lines.push({ billId: null, billNo: null, amount: onAccount });
    }
  }

  return { lines, allocated, onAccount, errors };
}
