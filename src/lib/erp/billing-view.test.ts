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
  discountBp: null,
  transportCostPaise: 0,
  gstBp: 1800,
  invoiceNo: null,
  invoiceDate: null,
  transporter: null,
  creditDays: null,
  ...over,
});
const all = { rates: true, amounts: true };
const total = (s: { totals: { l: string; v: { copy: string } }[] }, l: string) => s.totals.find((t) => t.l === l)?.v.copy;

test("orders for one party make one invoice, and another party makes another", () => {
  const sheets = billingSheets([line({ orderNo: 102 }), line({ orderNo: 101 }), line({ orderNo: 103, billing: party("b") })], all);
  assert.equal(sheets.length, 2);
  const one = sheets.find((s) => s.buyer[0].v.show === "Party a")!;
  assert.equal(one.orderCount, 2);
  assert.deepEqual(one.rows.map((r) => r.orderNo.show), ["101", "102"]);
  assert.equal(one.head.find((f) => f.l === "Order no")!.v.copy, "101, 102");
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

test("an unbilled order says its GST is the usual rate; a billed one does not", () => {
  const [open] = billingSheets([line({ gstBp: null })], all);
  assert.equal(open.title, "New invoice");
  assert.equal(open.rows[0].gst.copy, "18");
  assert.ok(open.notes.some((n) => n.startsWith("Not billed yet")));
  const [billed] = billingSheets([line({ invoiceNo: "MMI/26-27/900", invoiceDate: "2026-11-06" })], all);
  assert.equal(billed.title, "Invoice MMI/26-27/900");
  assert.equal(billed.head.find((f) => f.l === "Invoice no")!.v.copy, "MMI/26-27/900");
  assert.deepEqual(billed.notes, []);
});

test("two invoices or two companies are never drawn as one sheet", () => {
  const twoInvoices = billingSheets([line({ invoiceNo: "A/1" }), line({ orderNo: 102, invoiceNo: "A/2" })], all);
  assert.equal(twoInvoices.length, 2);
  const spellings = billingSheets([line({ invoiceNo: "mmi/ 900" }), line({ orderNo: 102, invoiceNo: "MMI/900" })], all);
  assert.equal(spellings.length, 1);
  const twoCompanies = billingSheets([line({ invoiceNo: "A/1" }), line({ orderNo: 102, invoiceNo: "A/1", gstBp: 0 })], all);
  assert.equal(twoCompanies.length, 2);
});

test("each shop the goods go to is listed once, and blank party fields are left out", () => {
  const [s] = billingSheets([line({ delivery: party("x", { address: "12 MG Road", gstin: "  " }) }), line({ orderNo: 102, delivery: party("y") }), line({ orderNo: 103, delivery: party("x", { address: "12 MG Road" }) })], all);
  assert.deepEqual(s.consignees.map((c) => c.key), ["x", "y"]);
  assert.deepEqual(s.consignees[0].fields.map((f) => f.l), ["Name", "Address"]);
});
