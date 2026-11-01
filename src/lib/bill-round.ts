/* ---------------------------------------------------------------------------
 * A BILL'S FINAL AMOUNT IS A ROUND FIGURE, everywhere in MahekOne.
 *
 * Tally rounds an invoice's total to the rupee with a "Round off" line, so
 * the invoice the customer holds says ₹10,450 where line-by-line arithmetic
 * says ₹10,449.62. A MahekOne figure that kept the paise disagreed with the
 * real invoice by up to fifty paise, and on Accounts that is a balance of
 * ₹0.38 that never clears however exactly the customer paid.
 *
 * So the TOTAL of a bill — a sales bill, a purchase bill, a purchase order, a
 * debit or credit note — is rounded here and nowhere else, to the nearest
 * rupee with fifty paise going up, as Tally does. Line amounts are left
 * exact: rounding each line and adding them up is a different number from the
 * invoice's, and the round off is a fact about the bill, not a line.
 *
 * Pure and client-safe: a total on a screen and the same total stored on
 * Accounts are rounded by one function.
 * ------------------------------------------------------------------------- */

export type RoundedBill = {
  /** The bill's final amount: whole rupees, in paise. */
  totalPaise: number;
  /** What was added to the exact sum to reach it (negative when rounded down), as Tally prints it. */
  roundOffPaise: number;
};

/** An exact total in paise, rounded to the nearest rupee — fifty paise up, and symmetric for a negative total. */
export function roundBill(exactPaise: number): RoundedBill {
  const exact = Math.round(exactPaise);
  const sign = exact < 0 ? -1 : 1;
  const totalPaise = sign * Math.floor((Math.abs(exact) + 50) / 100) * 100;
  return { totalPaise, roundOffPaise: totalPaise - exact };
}

/** Only the rounded total, where the round off is not shown. */
export const roundedTotal = (exactPaise: number): number => roundBill(exactPaise).totalPaise;
