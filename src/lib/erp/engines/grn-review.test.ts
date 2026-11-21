import { describe, test } from "node:test";
import assert from "node:assert/strict";
import "../calcs/purchase";
import type { FieldSpec } from "../ui";
import { grnReview, poNumberOf, NONE } from "./grn-review";

/* The goods receipt's fields as the form draws them (`inwardForm`), cut to what the review reads. */
const KG = { k: "item", map: "qtyBy", has: "scale" };
const COUNTED = { k: "item", map: "qtyBy", has: "typed" };
const line: FieldSpec[] = [
  { k: "poLine", l: "PO item", t: "select" },
  { k: "type", l: "Material type", t: "select", when: { k: "poLine", notEmpty: true } },
  { k: "item", l: "Item", t: "select", when: { k: "type", notEmpty: true } },
  { k: "pending", l: "Against the PO", t: "derived", calc: "inward.pending", when: { k: "poLine", notEmpty: true } },
  { k: "drums", l: "Drums", t: "num", qtyUnit: { base: "drums" }, when: { k: "type", eq: "Chemical" } },
  { k: "weight", l: "Weight with drum (kg)", t: "num", when: { k: "type", eq: "Chemical" } },
  { k: "emptyDrum", l: "Empty drum weight (kg, per drum)", t: "num", qtyUnit: { base: "Kg" }, when: { k: "type", eq: "Chemical" } },
  { k: "drumOwner", l: "Drums belong to", t: "select", when: { k: "type", eq: "Chemical" } },
  { k: "net", l: "Weight without drum", t: "derived", calc: "inward.net", when: KG },
  { k: "qty", l: "Quantity received", t: "num", qtyUnit: { by: ["item"], map: { "1 L Tin Can": "Pcs" } }, when: COUNTED },
  { k: "diff", l: "Against the PO", t: "derived", calc: "inward.diff", when: { calc: "inward.gap" } },
  { k: "extra", l: "The extra", t: "select", when: { calc: "inward.isMore" } },
  { k: "short", l: "Is more coming?", t: "select", when: { calc: "inward.isLess" } },
  { k: "unit", l: "Unit", t: "derived", calc: "inward.unit" },
  { k: "testing", l: "Testing required", t: "derived", calc: "inward.testing" },
  { k: "remark", l: "Remark", t: "area" },
];
const OWN = { k: "transportMode", eq: "Mahek Own Vehicle" };
const header: FieldSpec[] = [
  { k: "pr", l: "PR number", t: "derived", calc: "inward.pr" },
  { k: "po", l: "Purchase order", t: "select" },
  { k: "supplier", l: "Supplier", t: "derived", calc: "inward.supplier" },
  { k: "date", l: "Date received", t: "date" },
  { k: "godown", l: "Godown", t: "select" },
  { k: "transportMode", l: "Transport mode", t: "select" },
  { k: "transportCost", l: "Transport cost (₹)", t: "num", when: { k: "transportMode", in: ["Supplier Transport"] } },
  { k: "km", l: "Kilometres", t: "num", when: OWN },
  { k: "otherCost", l: "Other direct inward cost (₹)", t: "num" },
  { k: "otherNote", l: "What the other cost was", t: "text", when: { k: "otherCost", notEmpty: true } },
  { k: "landing", l: "Landing cost", t: "derived", calc: "inward.landing" },
];

const PO = "PO-33 · Jyotirling Enterprises";
const data = {
  supplierOf: { [PO]: "Jyotirling Enterprises", "PO-9 · Dharam Chem": "Dharam Chem" },
  pendingOf: { [`${PO}|1. Acetone`]: "1,800 Kg", [`${PO}|2. 1 L Tin Can`]: "500 Pcs", "PO-9 · Dharam Chem|1. Acetone": "600 Kg" },
  pendingQtyOf: { [`${PO}|1. Acetone`]: 1800, [`${PO}|2. 1 L Tin Can`]: 500, "PO-9 · Dharam Chem|1. Acetone": 600 },
  rateOf: {},
  unitOf: { Acetone: "Kg", "1 L Tin Can": "Pcs" },
  qtyBy: { Acetone: ["scale"], "1 L Tin Can": ["typed"] },
  testsOf: { Acetone: ["Smell", "Colour"], "1 L Tin Can": [] },
  ratePerKmPaise: 1000,
};

const acetone = { poLine: "1. Acetone", type: "Chemical", item: "Acetone", drums: "4", weight: "1000", emptyDrum: "20", drumOwner: "As the supplier's master says", remark: "Seal intact" };
const tin = { poLine: "2. 1 L Tin Can", type: "Can", item: "1 L Tin Can", qty: "500" };
const head = { po: PO, date: "2026-11-20", godown: "Ambernath", transportMode: "Supplier Transport", transportCost: "1500" };

const at = (rows: { label: string; value: string }[], label: string) => rows.find((r) => r.label === label)?.value;

describe("grnReview: the three sections", () => {
  test("a kg chemical lists its item, its PO and every receipt field", () => {
    const m = grnReview({ header, line, h: head, lines: [acetone], data });
    assert.equal(m.items.length, 1);
    assert.equal(at(m.items[0].rows, "Item"), "Acetone");
    assert.equal(at(m.items[0].rows, "Material type"), "Chemical");
    assert.equal(at(m.orders[0].rows, "PO number"), "PO-33");
    assert.equal(at(m.orders[0].rows, "Supplier"), "Jyotirling Enterprises");
    assert.equal(at(m.orders[0].rows, "PO item"), "1. Acetone");
    assert.equal(at(m.orders[0].rows, "Pending on the PO"), "1,800 Kg");
    const r = m.lines[0].rows;
    assert.equal(at(r, "Drums"), "4 drums");
    assert.equal(at(r, "Weight with drum (kg)"), "1000");
    assert.equal(at(r, "Empty drum weight (kg, per drum)"), "20");
    assert.equal(at(r, "Drums belong to"), "As the supplier's master says");
    assert.equal(at(r, "Weight without drum"), "920 kg");
    assert.equal(at(r, "Unit"), "Kg");
    assert.match(at(r, "Testing required")!, /^Yes · Smell, Colour/);
    assert.equal(at(r, "Remark"), "Seal intact");
  });

  test("a counted item shows its quantity and unit, and no drum or scale fields", () => {
    const r = grnReview({ header, line, h: head, lines: [tin], data }).lines[0].rows;
    assert.equal(at(r, "Quantity received"), "500 Pcs");
    assert.equal(at(r, "Drums"), undefined);
    assert.equal(at(r, "Weight with drum (kg)"), undefined);
    assert.equal(at(r, "Weight without drum"), undefined);
    assert.match(at(r, "Testing required")!, /^No/);
    assert.equal(at(r, "Remark"), NONE);
  });

  test("the PO fields are never repeated in the receipt details", () => {
    const labels = grnReview({ header, line, h: head, lines: [acetone], data }).lines[0].rows.map((r) => r.label);
    assert.ok(!labels.includes("PO item"));
    assert.ok(!labels.includes("Material type"));
    assert.ok(!labels.includes("Item"));
  });

  test("a difference from the PO shows the line and the choice that applies, and only that one", () => {
    const more = grnReview({ header, line, h: head, lines: [{ ...tin, qty: "520", extra: "Leave the PO as it is" }], data }).lines[0].rows;
    assert.match(at(more, "Against the PO")!, /20 Pcs more than/);
    assert.equal(at(more, "The extra"), "Leave the PO as it is");
    assert.equal(at(more, "Is more coming?"), undefined);
    const less = grnReview({ header, line, h: head, lines: [{ ...tin, qty: "480", short: "That is everything: take the rest off the PO" }], data }).lines[0].rows;
    assert.match(at(less, "Against the PO")!, /20 Pcs less than/);
    assert.equal(at(less, "The extra"), undefined);
    assert.equal(at(less, "Is more coming?"), "That is everything: take the rest off the PO");
  });
});

describe("grnReview: several items, one truck", () => {
  test("every item is a block of its own, numbered, each with its PO", () => {
    const m = grnReview({ header, line, h: head, lines: [acetone, tin], data });
    assert.deepEqual(m.items.map((b) => b.title), ["1. Acetone", "2. 1 L Tin Can"]);
    assert.deepEqual(m.orders.map((b) => b.title), ["1. Acetone", "2. 1 L Tin Can"]);
    assert.equal(m.lines.length, 2);
    assert.equal(at(m.orders[1].rows, "Pending on the PO"), "500 Pcs");
  });

  test("a receipt started from the item names its PO on each line, and the line's PO wins over the header's", () => {
    const m = grnReview({ header, line, h: { ...head, po: "" }, lines: [{ ...acetone, po: "PO-9 · Dharam Chem" }, { ...tin, po: PO }], data });
    assert.equal(at(m.orders[0].rows, "PO number"), "PO-9");
    assert.equal(at(m.orders[0].rows, "Supplier"), "Dharam Chem");
    assert.equal(at(m.orders[0].rows, "Pending on the PO"), "600 Kg");
    assert.equal(at(m.orders[1].rows, "PO number"), "PO-33");
  });

  test("the supplier falls back to the label when the server sent no map for it", () => {
    const m = grnReview({ header, line, h: head, lines: [acetone], data: { ...data, supplierOf: {} } });
    assert.equal(at(m.orders[0].rows, "Supplier"), "Jyotirling Enterprises");
  });

  test("no PO yet reads as the dash, never as an invented value", () => {
    const m = grnReview({ header, line, h: { ...head, po: "" }, lines: [acetone], data });
    assert.equal(at(m.orders[0].rows, "PO number"), NONE);
    assert.equal(at(m.orders[0].rows, "Supplier"), NONE);
  });
});

describe("grnReview: the delivery", () => {
  test("date, godown, transport and the other cost are listed; the PO, supplier and PR placeholder are not", () => {
    const d = grnReview({ header, line, h: { ...head, otherCost: "200", otherNote: "Unloading" }, lines: [acetone], data }).delivery;
    assert.equal(at(d, "Date received"), "20 Nov 2026");
    assert.equal(at(d, "Godown"), "Ambernath");
    assert.equal(at(d, "Transport mode"), "Supplier Transport");
    assert.equal(at(d, "Transport cost (₹)"), "1500");
    assert.equal(at(d, "Other direct inward cost (₹)"), "200");
    assert.equal(at(d, "What the other cost was"), "Unloading");
    assert.match(at(d, "Landing cost")!, /₹1,700/);
    for (const gone of ["Purchase order", "Supplier", "PR number", "Added to PR"]) assert.equal(at(d, gone), undefined, gone);
  });

  test("a field the form hides is not listed, and an empty optional one is the dash", () => {
    const d = grnReview({ header, line, h: head, lines: [acetone], data }).delivery;
    assert.equal(at(d, "Kilometres"), undefined);
    assert.equal(at(d, "What the other cost was"), undefined);
    assert.equal(at(d, "Other direct inward cost (₹)"), NONE);
  });

  test("own vehicle lists its kilometres instead of a typed cost", () => {
    const d = grnReview({ header, line, h: { ...head, transportMode: "Mahek Own Vehicle", km: "40" }, lines: [acetone], data }).delivery;
    assert.equal(at(d, "Kilometres"), "40");
    assert.equal(at(d, "Transport cost (₹)"), undefined);
  });

  test("adding to an existing PR says which PR", () => {
    const d = grnReview({ header, line, h: { ...head, prFixed: "1690" }, lines: [tin], data }).delivery;
    assert.equal(at(d, "Added to PR"), "1690");
  });
});

describe("grnReview: it only reads", () => {
  test("it does not change what it is given", () => {
    const h = { ...head };
    const lines = [{ ...acetone }];
    const before = JSON.stringify({ h, lines });
    grnReview({ header, line, h, lines, data });
    assert.equal(JSON.stringify({ h, lines }), before);
  });

  test("no lines is an empty review, not an error", () => {
    const m = grnReview({ header, line, h: head, lines: [], data });
    assert.deepEqual([m.items, m.orders, m.lines], [[], [], []]);
  });

  test("a PO number is the part before the vendor", () => {
    assert.equal(poNumberOf("PO-33 · Jyotirling Enterprises"), "PO-33");
    assert.equal(poNumberOf("PO-7"), "PO-7");
  });
});
