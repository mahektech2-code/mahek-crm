import { test } from "node:test";
import assert from "node:assert/strict";
import { billingSheets, type BillingLine, type BillingParty } from "./billing-view";

const party = (id: string, over: Partial<BillingParty> = {}): BillingParty => ({ id, name: `Party ${id}`, address: null, city: null, state: null, gstin: null, phone: null, ...over });
const line = (over: Partial<BillingLine> = {}): BillingLine => ({
  orderNo: 101,
  orderDate: "2026-11-06",
  billing: party("a"),
  delivery: party("a"),
  description: "Nano Thinner - 5 Liter (Loose)",
  skuId: "sku-nano-5",
  type: "Can",
  qtyCans: 10,
  litresPerCan: 5,
  boxes: null,
  ratePaise: 100_050,
  weightKg: null,
  discountBp: null,
  transportCostPaise: 0,
  gstBp: 1800,
  billed: false,
  transporter: null,
  creditDays: null,
  ...over,
});
const all = { rates: true, amounts: true };
const total = (s: { totals: { l: string; v: { copy: string } }[] }, l: string) => s.totals.find((t) => t.l === l)?.v.copy;

test("every ticked order is clubbed onto ONE invoice, whichever party it bills, each row keeping its order number", () => {
  const sheets = billingSheets([line({ orderNo: 102 }), line({ orderNo: 101 }), line({ orderNo: 103, billing: party("b"), creditDays: 30 }), line({ orderNo: 101, description: "PU Thinner" })], all);
  assert.equal(sheets.length, 1);
  const [s] = sheets;
  assert.equal(s.orderCount, 3);
  /* The three identical Nano lines fold into one row naming all three orders; PU stays its own. */
  assert.deepEqual(s.rows.map((r) => r.orderNo.show), ["101, 102, 103", "101"]);
  assert.equal(s.head.find((f) => f.l === "Order no")!.v.copy, "101, 102, 103");
  assert.deepEqual(s.buyers.map((b) => b.fields[0].v.show), ["Party a", "Party b"]);
  assert.equal(s.head.find((f) => f.l === "Terms of payment")!.v.copy, "30 days");
});

test("a billed line is left off, and the sheet says how many were", () => {
  const sheets = billingSheets([line({ orderNo: 101 }), line({ orderNo: 102, billed: true }), line({ orderNo: 102, billed: true })], all);
  assert.equal(sheets.length, 1);
  assert.deepEqual(sheets[0].rows.map((r) => r.orderNo.show), ["101"]);
  assert.ok(sheets[0].notes.includes("2 lines are already billed, so they are left off."));
  assert.deepEqual(billingSheets([line({ billed: true })], all), [], "nothing left to bill draws no invoice");
});

test("each row says what it weighs, and the invoice its total weight, whatever money the viewer may see", () => {
  /* Distinct products, so each stays its own row and the per-row weight is what is under test. */
  const [s] = billingSheets([line({ description: "P1", weightKg: 27 }), line({ orderNo: 102, description: "P2", weightKg: 7.7 }), line({ orderNo: 103, description: "P3", weightKg: 0.1 }), line({ orderNo: 104, description: "P4", weightKg: null })], { rates: false, amounts: false });
  assert.deepEqual(s.rows[0].weight, { show: "27 kg", copy: "27" });
  assert.equal(s.rows[3].weight, null);
  assert.equal(total(s, "Total weight"), "34.8", "summed in grams, not as floats");
  assert.ok(s.notes.some((n) => n.startsWith("1 line has no weight")));
});

test("a value is shown formatted and copied bare, ready for a Tally field", () => {
  const [s] = billingSheets([line({ qtyCans: 1200 })], all);
  assert.deepEqual(s.rows[0].rate, { show: "₹1,000.50", copy: "1000.50" });
  assert.deepEqual(s.rows[0].cans, { show: "1,200", copy: "1200" });
  assert.equal(s.rows[0].gst.copy, "18");
  assert.equal(total(s, "Value of goods"), "1200600.00");
});

test("the figures are the bill's: discount, freight, GST, and a total rounded as Tally rounds it", () => {
  const [s] = billingSheets([line({ qtyCans: 3, ratePaise: 33_333, discountBp: 500, transportCostPaise: 10_000 })], all);
  /* 3 × 333.33 = 999.99; 5% off = 50.00; +100 freight = 1049.99; +18% = 1238.99 */
  assert.equal(total(s, "Value of goods"), "999.99");
  assert.equal(total(s, "Discount"), "50.00");
  assert.equal(total(s, "Freight"), "100.00");
  assert.equal(total(s, "Taxable value"), "1049.99");
  assert.equal(total(s, "GST 18%"), "189.00");
  assert.equal(total(s, "Round off"), "0.01");
  assert.equal(total(s, "Invoice total"), "1239.00");
  assert.equal(s.rows[0].amount?.copy, "949.99");
});

test("a drum is priced by the litre, and says so", () => {
  const [s] = billingSheets([line({ type: "Drum", qtyCans: 2, litresPerCan: 210, ratePaise: 10_000 })], all);
  assert.equal(s.rows[0].per.show, "Litre");
  assert.equal(s.rows[0].litres.copy, "420");
  assert.equal(s.rows[0].amount?.copy, "42000.00");
});

test("money somebody may not see is not built at all", () => {
  const [none] = billingSheets([line({ discountBp: 500 })], { rates: false, amounts: false });
  assert.equal(none.rows[0].rate, null);
  assert.equal(none.rows[0].discount, null);
  assert.equal(none.rows[0].amount, null);
  assert.deepEqual(none.totals.map((t) => t.l), ["Total can qty", "Total box qty"], "no money lines, only the can and box counts");
  assert.equal(none.rows[0].cans.copy, "10");
  assert.equal(none.rows[0].weight, null);
  assert.ok(!JSON.stringify(none).includes("1000.50"));
  const [rateOnly] = billingSheets([line()], { rates: true, amounts: false });
  assert.equal(rateOnly.rows[0].rate?.copy, "1000.50");
  assert.deepEqual(rateOnly.totals.map((t) => t.l), ["Total can qty", "Total box qty"]);
});

test("a line with no rate is said, and left out of the total", () => {
  const [s] = billingSheets([line({ qtyCans: 1, ratePaise: 10_000 }), line({ orderNo: 102, ratePaise: null })], all);
  assert.equal(s.rows[1].rate, null);
  assert.equal(s.rows[1].amount, null);
  assert.equal(total(s, "Value of goods"), "100.00");
  assert.ok(s.notes.some((n) => n.startsWith("1 line has no rate")));
});

test("an unbilled line says its GST is the usual rate", () => {
  const [open] = billingSheets([line({ gstBp: null })], all);
  assert.equal(open.title, "New invoice");
  assert.equal(open.rows[0].gst.copy, "18");
  assert.ok(open.notes.some((n) => n.startsWith("Not billed yet")));
  const [stated] = billingSheets([line({ weightKg: 5 })], all);
  assert.deepEqual(stated.notes, []);
});

test("two companies are never one invoice", () => {
  assert.equal(billingSheets([line(), line({ orderNo: 102, gstBp: 0 })], all).length, 2);
});

test("each shop the goods go to is listed once, and blank party fields are left out", () => {
  const [s] = billingSheets([line({ delivery: party("x", { address: "12 MG Road", gstin: "  " }) }), line({ orderNo: 102, delivery: party("y") }), line({ orderNo: 103, delivery: party("x", { address: "12 MG Road" }) })], all);
  assert.deepEqual(s.consignees.map((c) => c.key), ["x", "y"]);
  assert.deepEqual(s.consignees[0].fields.map((f) => f.l), ["Name", "Address"]);
});

/* ---- folding identical lines into one row ---------------------------------------------------- */

const fig = (s: { totals: { l: string; v: { copy: string } }[] }) => JSON.stringify(s.totals);

test("lines that differ only in quantity are ONE row: quantities and amount add up, every order is named", () => {
  const [s] = billingSheets(
    [
      line({ orderNo: 10289, qtyCans: 12, boxes: 3, weightKg: 99, ratePaise: 110_500 }),
      line({ orderNo: 10292, qtyCans: 12, boxes: 3, weightKg: 99, ratePaise: 110_500 }),
      line({ orderNo: 10290, qtyCans: 6, boxes: 1, weightKg: 49.5, ratePaise: 110_500 }),
    ],
    all,
  );
  assert.equal(s.rows.length, 1);
  const [r] = s.rows;
  assert.equal(r.orderNo.show, "10289, 10290, 10292");
  assert.deepEqual(r.cans, { show: "30", copy: "30" });
  assert.deepEqual(r.boxes, { show: "7", copy: "7" });
  assert.equal(r.litres.copy, "150");
  assert.deepEqual(r.weight, { show: "247.5 kg", copy: "247.5" });
  assert.equal(r.amount?.copy, "33150.00");
  assert.deepEqual(r.rate, { show: "₹1,105", copy: "1105.00" });
});

test("it is generic: any number of orders and products fold by their own figures, nothing is special-cased", () => {
  const lines: BillingLine[] = [];
  for (let o = 1; o <= 40; o++) {
    lines.push(line({ orderNo: 5000 + o, description: "Product A", qtyCans: o, ratePaise: 20_000 }));
    lines.push(line({ orderNo: 5000 + o, description: "Product B", qtyCans: 2, ratePaise: 30_000, gstBp: 1200 }));
  }
  const [s] = billingSheets(lines, all);
  assert.equal(s.rows.length, 2);
  const a = s.rows.find((r) => r.description.show === "Product A")!;
  const b = s.rows.find((r) => r.description.show === "Product B")!;
  assert.equal(a.cans.copy, String((40 * 41) / 2));
  assert.equal(b.cans.copy, "80");
  assert.equal(a.orderNo.show.split(", ").length, 40);
  assert.equal(b.gst.copy, "12");
});

test("a different rate, GST, discount, pack, or per keeps its own row", () => {
  const base = line({ orderNo: 1, qtyCans: 2 });
  const [byRate] = billingSheets([base, line({ orderNo: 2, qtyCans: 2, ratePaise: 100_051 })], all);
  assert.equal(byRate.rows.length, 2);
  const [byGst] = billingSheets([base, line({ orderNo: 2, qtyCans: 2, gstBp: 1200 })], all);
  assert.equal(byGst.rows.length, 2);
  const [byDiscount] = billingSheets([base, line({ orderNo: 2, qtyCans: 2, discountBp: 500 })], all);
  assert.equal(byDiscount.rows.length, 2);
  const [byPack] = billingSheets([base, line({ orderNo: 2, qtyCans: 2, description: "Nano Thinner - 10 Liter (Loose)" })], all);
  assert.equal(byPack.rows.length, 2);
  const [byPer] = billingSheets([base, line({ orderNo: 2, qtyCans: 2, type: "Drum" })], all);
  assert.equal(byPer.rows.length, 2);
});

test("no discount, however it is spelt (null or 0), is the same discount", () => {
  const [s] = billingSheets([line({ orderNo: 1, discountBp: null }), line({ orderNo: 2, discountBp: 0 })], all);
  assert.equal(s.rows.length, 1);
});

test("rows hidden from the viewer still fold by the real figures, and never leak them", () => {
  const [s] = billingSheets([line({ orderNo: 1, ratePaise: 100_000 }), line({ orderNo: 2, ratePaise: 100_000 }), line({ orderNo: 3, ratePaise: 90_000 })], { rates: false, amounts: false });
  assert.equal(s.rows.length, 2, "different hidden rates are not one row");
  assert.equal(s.rows[0].orderNo.show, "1, 2");
  assert.ok(s.rows.every((r) => r.rate === null && r.amount === null));
  assert.ok(!JSON.stringify(s).includes("1000.00"));
});

test("a weight is shown only if every line folded in carries one; boxes add up when the pack is boxed", () => {
  const [s] = billingSheets([line({ orderNo: 1, weightKg: 10 }), line({ orderNo: 2, weightKg: null })], all);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].weight, null);
  const [boxed] = billingSheets([line({ orderNo: 1, boxes: 2, weightKg: 10 }), line({ orderNo: 2, boxes: 3, weightKg: 15 })], all);
  assert.equal(boxed.rows.length, 1);
  assert.equal(boxed.rows[0].boxes?.copy, "5");
  assert.equal(boxed.rows[0].weight?.copy, "25");
});

test("folding moves nothing: totals, GST, round-off and the invoice total are the same as for the unfolded lines", () => {
  const rate = 33_333;
  const together = billingSheets([line({ orderNo: 1, qtyCans: 3, ratePaise: rate, discountBp: 500, transportCostPaise: 10_000, weightKg: 7.7 }), line({ orderNo: 2, qtyCans: 5, ratePaise: rate, discountBp: 500, transportCostPaise: 4_000, weightKg: 12.3 })], all);
  /* Same two lines, made unfoldable by a distinct description: the unfolded reference. */
  const apart = billingSheets([line({ orderNo: 1, description: "X1", qtyCans: 3, ratePaise: rate, discountBp: 500, transportCostPaise: 10_000, weightKg: 7.7 }), line({ orderNo: 2, description: "X2", qtyCans: 5, ratePaise: rate, discountBp: 500, transportCostPaise: 4_000, weightKg: 12.3 })], all);
  assert.equal(together[0].rows.length, 1);
  assert.equal(apart[0].rows.length, 2);
  assert.equal(fig(together[0]), fig(apart[0]));
  /* And the folded row's amount is exactly the two rows' amounts added. */
  const sum = apart[0].rows.reduce((n, r) => n + Math.round(Number(r.amount!.copy) * 100), 0);
  assert.equal(Math.round(Number(together[0].rows[0].amount!.copy) * 100), sum);
  assert.deepEqual(together[0].notes, apart[0].notes);
  assert.equal(together[0].orderCount, apart[0].orderCount);
});

test("a folded sheet still prints the same invoice total as the same lines one by one", () => {
  const lines = [101, 102, 103, 104].map((o) => line({ orderNo: o, qtyCans: o - 100, ratePaise: 55_750, gstBp: 1800 }));
  const [folded] = billingSheets(lines, all);
  const singles = lines.map((l) => billingSheets([l], all)[0]);
  assert.equal(folded.rows.length, 1);
  const grossSingles = singles.reduce((n, s) => n + Math.round(Number(total(s, "Value of goods")) * 100), 0);
  assert.equal(Math.round(Number(total(folded, "Value of goods")) * 100), grossSingles);
  assert.equal(total(folded, "Taxable value"), "5575.00");
  assert.equal(total(folded, "GST 18%"), "1003.50");
  assert.equal(total(folded, "Round off"), "0.50");
  assert.equal(total(folded, "Invoice total"), "6579.00");
});

test("product identity and pack count even where the wording is identical: a different SKU, litres per can, or loose-versus-boxed never folds", () => {
  const a = line({ orderNo: 1 });
  assert.equal(billingSheets([a, line({ orderNo: 2 })], all)[0].rows.length, 1, "control: the same SKU does fold");
  assert.equal(billingSheets([a, line({ orderNo: 2, skuId: "sku-other" })], all)[0].rows.length, 2, "same wording, different SKU");
  assert.equal(billingSheets([a, line({ orderNo: 2, litresPerCan: 10 })], all)[0].rows.length, 2, "same wording, different litres per can");
  assert.equal(billingSheets([a, line({ orderNo: 2, boxes: 2 })], all)[0].rows.length, 2, "loose versus boxed");
});

test("total box qty adds the boxes of every boxed line, and a loose line adds none", () => {
  const [s] = billingSheets([line({ orderNo: 1, description: "A", boxes: 2 }), line({ orderNo: 2, description: "B", boxes: 3 }), line({ orderNo: 3, description: "C", boxes: null })], { rates: false, amounts: false });
  assert.equal(total(s, "Total box qty"), "5");
  assert.equal(total(s, "Total can qty"), "10", "only the loose line's cans; the boxed lines are in boxes");
  assert.equal(s.rows.find((r) => r.description.copy === "C")?.boxes, null);
  const [loose] = billingSheets([line()], { rates: false, amounts: false });
  assert.equal(total(loose, "Total box qty"), "0");
});

test("totals across several orders: loose cans, boxes and weight add up over every unbilled line, and a billed line adds nothing", () => {
  const [s] = billingSheets(
    [
      line({ orderNo: 1, description: "Loose A", skuId: "a", qtyCans: 20, boxes: null, weightKg: 14 }),
      line({ orderNo: 1, description: "Boxed B", skuId: "b", qtyCans: 88, boxes: 2, weightKg: 54 }),
      line({ orderNo: 2, description: "Loose A", skuId: "a", qtyCans: 5, boxes: null, weightKg: 3.5 }),
      line({ orderNo: 2, description: "Boxed B", skuId: "b", qtyCans: 44, boxes: 1, weightKg: 27 }),
      line({ orderNo: 3, description: "Boxed C", skuId: "c", qtyCans: 12, boxes: 3, weightKg: 9 }),
      line({ orderNo: 4, description: "Billed", skuId: "d", qtyCans: 999, boxes: 99, weightKg: 999, billed: true }),
    ],
    { rates: false, amounts: false },
  );
  assert.equal(total(s, "Total can qty"), "25", "loose cans only: 20 + 5");
  assert.equal(total(s, "Total box qty"), "6", "2 + 1 + 3");
  assert.equal(total(s, "Total weight"), "107.5");
});
