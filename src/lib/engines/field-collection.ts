/**
 * WHERE A FIELD COLLECTION GOES WHEN A BILL IT NAMED WAS SETTLED MEANWHILE.
 *
 * Pure. `handlePayment` used to REFUSE the whole receipt (`bill_settled`)
 * whenever a bill the handset named had been paid off between the pull and the
 * sync — so money a salesman physically held was on Not accepted, and the only
 * way out was to "collect it again", which on a handset with no signal is a
 * second receipt for one handful of notes. The money is real; only where it
 * was going has moved. So it is ACCEPTED:
 *
 *  1. the named bills that are still open are filled first, oldest first;
 *  2. what is left goes against the customer's other open bills, oldest first;
 *  3. anything after that is money on account.
 *
 * And it is FLAGGED: the receipt is `reported` anyway, so accounts look at it
 * before anything counts, and `flag` is the sentence written on it saying
 * which bill was settled and how the money was spread instead. Nothing that
 * counts moves until accounts confirm — and `confirmReceipt` can re-point it.
 *
 * Where every named bill is still open, nothing changes: the named bills are
 * settled exactly as before (`settle`). With nothing named, it is the oldest
 * first spread it always was (`auto`).
 */
import { billBalance, oldestFirst, type AllocatableBill, type AllocationRequest } from "./allocation";

export type FieldCollectionPlan = {
  request: AllocationRequest;
  /** The sentence for accounts, or null where the named bills were all open. */
  flag: string | null;
  /** Bill numbers named and found settled; "an unknown bill" for one no longer on the account. */
  settledNamed: string[];
};

export function planFieldCollection(
  bills: readonly AllocatableBill[],
  input: { amountPaise: number; billIds?: readonly string[] | null },
): FieldCollectionPlan {
  const named = [...new Set(input.billIds ?? [])];
  if (!named.length) return { request: { mode: "auto", amount: input.amountPaise }, flag: null, settledNamed: [] };

  const byId = new Map(bills.map((b) => [b.id, b]));
  const liveNamed: AllocatableBill[] = [];
  const settledNamed: string[] = [];
  for (const id of named) {
    const b = byId.get(id);
    if (!b) settledNamed.push("a bill no longer on the account");
    else if (billBalance(b) <= 0) settledNamed.push(b.billNo);
    else liveNamed.push(b);
  }
  if (!settledNamed.length) {
    return { request: { mode: "settle", amount: input.amountPaise, selectedBillIds: named }, flag: null, settledNamed };
  }

  const custom: Record<string, number> = {};
  let left = input.amountPaise;
  const liveIds = new Set(liveNamed.map((b) => b.id));
  const others = oldestFirst(bills).filter((b) => !liveIds.has(b.id) && billBalance(b) > 0);
  for (const b of [...oldestFirst(liveNamed), ...others]) {
    if (left <= 0) break;
    const take = Math.min(left, billBalance(b));
    if (take > 0) {
      custom[b.id] = take;
      left -= take;
    }
  }

  const where = Object.keys(custom).length
    ? left > 0
      ? "applied to the open bills oldest first, the rest on account"
      : "applied to the open bills oldest first"
    : "put on account — nothing is open";
  const flag =
    `Collected against ${settledNamed.join(", ")}, which was already settled when this reached the office, so it was ${where}. ` +
    "Check where it should go before confirming.";

  return {
    request: Object.keys(custom).length
      ? { mode: "custom", amount: input.amountPaise, custom }
      : { mode: "auto", amount: input.amountPaise },
    flag,
    settledNamed,
  };
}
