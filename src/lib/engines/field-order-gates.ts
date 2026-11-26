/**
 * THE OVERDUE-DAYS BLOCK ON A NEW FIELD ORDER — pure.
 *
 * `mbos.credit.overdueDaysBlockOrders`: a billing party with a bill this many
 * days past its due date is not offered new orders in the field. 0 is off. It
 * sat on the Settings screen read by nothing for the life of the module; it is
 * read now by `handleOrder` and, through its own copy of this rule
 * (`mbos-app/src/engines/order-gates.ts`), by the handset before the order is
 * taken — so the phone says it in the shop rather than the office refusing it
 * at sync.
 *
 * A debt policy, not a credit one: an account inside its limit can still be
 * months late. Two kinds of bill never block: an `unstated` one (nobody has
 * said it is owed — `recomputeOutstanding` leaves it out of the debt for the
 * same reason) and a disputed one (the customer says it is wrong, and that is
 * accounts' conversation, not a reason to refuse the next order).
 */

export type OverdueBill = {
  billNo: string | null;
  balance: number;
  overdueDays: number;
  paymentPosition?: string | null;
  disputed?: boolean | null;
};

export function overdueBlockingBill(
  bills: readonly OverdueBill[],
  blockDays: number,
): { billNo: string | null; overdueDays: number } | null {
  if (!(blockDays > 0)) return null;
  let worst: OverdueBill | null = null;
  for (const b of bills) {
    if (b.balance <= 0) continue;
    if (b.paymentPosition === "unstated") continue;
    if (b.disputed) continue;
    if (b.overdueDays < blockDays) continue;
    if (!worst || b.overdueDays > worst.overdueDays) worst = b;
  }
  return worst ? { billNo: worst.billNo, overdueDays: worst.overdueDays } : null;
}
