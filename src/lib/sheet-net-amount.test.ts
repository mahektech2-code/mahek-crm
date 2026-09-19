import { test } from "node:test";
import assert from "node:assert/strict";
import { netOfTaxPaise, parseOrderRow } from "./sheet-parse";

/* ---------------------------------------------------------------------------
 * The unit a sales target is written in. Pure, so no database.
 *
 * Mahek sets a revenue target on the sale EXCLUDING GST. The order sheet
 * carries two money columns per line and they are not the same figure:
 *
 *     Final Amount = Amount × (1 − discount) × (1 + GST)
 *
 * Revenue was scored off Final Amount, which is 18% above the unit the target
 * beside it was typed in — ₹29.5 cr read against targets written for ₹25.1 cr.
 * Every test here is one half of that sentence, because both halves are easy to
 * get wrong in a way no screen would ever show: reading `Amount` raw drops the
 * discount (₹33 lakh on this book), and dividing Final Amount by 1.18 is wrong
 * on the 820 lines that carry no GST at all.
 * ------------------------------------------------------------------------- */

test("the net is Amount after its discount, not Amount", () => {
  // ₹10,000 list, 5% off. The money actually billed, before tax, is ₹9,500.
  assert.equal(netOfTaxPaise({ amountPaise: 10_000_00, discountBp: 500 }), 9_500_00);

  // And NOT the list figure. A salesman must not be marked down for a discount
  // he was authorised to give.
  assert.notEqual(netOfTaxPaise({ amountPaise: 10_000_00, discountBp: 500 }), 10_000_00);
});

test("no discount leaves Amount alone, and null is no discount", () => {
  assert.equal(netOfTaxPaise({ amountPaise: 1_234_56, discountBp: 0 }), 1_234_56);
  assert.equal(netOfTaxPaise({ amountPaise: 1_234_56, discountBp: null }), 1_234_56);
});

test("a line with no Amount is worth nothing, because the caller is summing", () => {
  assert.equal(netOfTaxPaise({ amountPaise: null, discountBp: 300 }), 0);
});

test("the answer is whole paise", () => {
  // 3% off ₹333.33 is ₹323.3301 — a third of a paisa that must not travel into
  // a figure which has to tie back to a bill.
  const net = netOfTaxPaise({ amountPaise: 333_33, discountBp: 300 });
  assert.equal(net, Math.round(net));
  assert.equal(net, 323_33);
});

test("net × (1 + GST) reconciles to Final Amount, which is the whole point", () => {
  // The identity the sheet's own arithmetic check enforces. It is what lets an
  // ex-GST revenue figure and the bill raised against the same order be tied
  // back to each other.
  const line = { amountPaise: 20_000_00, discountBp: 400 };
  const net = netOfTaxPaise(line); // ₹19,200
  assert.equal(net, 19_200_00);
  assert.equal(Math.round(net * 1.18), 22_656_00); // what Final Amount says
});

test("a 0% GST line is already its own net, so no flat divisor would do", () => {
  // 820 lines on the real book carry no GST. Deriving the net by dividing
  // Final Amount by 1.18 would leave every one of them 18% short, with nothing
  // on any screen able to say which ones.
  const line = { amountPaise: 5_000_00, discountBp: null };
  assert.equal(netOfTaxPaise(line), 5_000_00);
  assert.notEqual(netOfTaxPaise(line), Math.round(5_000_00 / 1.18));
});

test("summing the rounded lines is not rounding the sum", () => {
  // Seven lines of a third of a paisa each. The order's net is the sum of what
  // each line is worth in whole paise, which is the figure a bill can be
  // reconciled against — not the rounding of an exact total.
  const lines = Array.from({ length: 7 }, () => ({
    amountPaise: 333_33,
    discountBp: 300,
  }));
  const summed = lines.reduce((s, l) => s + netOfTaxPaise(l), 0);
  assert.equal(summed, 7 * 323_33);
});

test("a real sheet row parses to columns the net can be read off", () => {
  const cells: Record<string, string> = {
    "Order No.": "26-27/1119",
    Amount: "20,000.00",
    Discount: "4%",
    GST: "18%",
    "Final Amount": "22656",
  };
  const row = parseOrderRow(cells);
  assert.equal(row.amountPaise, 20_000_00);
  assert.equal(row.discountBp, 400);
  assert.equal(netOfTaxPaise(row), 19_200_00);
  // And the row reconciles, so the arithmetic check raises nothing about it.
  assert.equal(
    row.issues.some((i) => i.column === "Final Amount"),
    false,
  );
});

test("a row that does not reconcile is still flagged", () => {
  // The check shares its expression with `netOfTaxPaise` now. It has to go on
  // catching the sheet's own errors, which is the only reason it exists.
  const row = parseOrderRow({
    "Order No.": "26-27/1120",
    Amount: "20,000.00",
    Discount: "4%",
    GST: "18%",
    "Final Amount": "30000",
  });
  assert.equal(
    row.issues.some((i) => i.column === "Final Amount"),
    true,
  );
});
