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
  assert.deepEqual(s.rows.map((r) => r.orderNo.show), ["101", "101", "102", "103"]);
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
  const [s] = billingSheets([line({ weightKg: 27 }), line({ orderNo: 102, weightKg: 7.7 }), line({ orderNo: 103, weightKg: 0.1 }), line({ orderNo: 104, weightKg: null })], { rates: false, amounts: false });
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
  assert.deepEqual(none.totals, []);
  assert.equal(none.rows[0].cans.copy, "10");
  assert.equal(none.rows[0].weight, null);
  assert.ok(!JSON.stringify(none).includes("1000.50"));
  const [rateOnly] = billingSheets([line()], { rates: true, amounts: false });
  assert.equal(rateOnly.rows[0].rate?.copy, "1000.50");
  assert.deepEqual(rateOnly.totals, []);
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
