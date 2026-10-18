import { test } from "node:test";
import assert from "node:assert/strict";
import { pageOfError, planPages, plural } from "./form-pages";

const f = (k: string, sec?: string) => ({ k, sec });

test("a short form is one page with no review", () => {
  const p = planPages([f("a"), f("b", "X"), f("c", "Y")]);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0], { kind: "fields", title: "", keys: ["a", "b", "c"] });
});

test("a long form is cut at its sections, small ones packed, and ends on Review", () => {
  const fields = [
    ...["a1", "a2", "a3", "a4", "a5"].map((k) => f(k, "Vendor")),
    ...["b1", "b2"].map((k) => f(k, "Money")),
    ...["c1", "c2", "c3", "c4"].map((k) => f(k, "Delivery")),
  ];
  const p = planPages(fields);
  assert.deepEqual(
    p.map((x) => x.title),
    ["Vendor & Money", "Delivery", "Review"],
  );
  assert.deepEqual(p[0].kind === "fields" && p[0].keys, ["a1", "a2", "a3", "a4", "a5", "b1", "b2"]);
});

test("fields before the first heading are Details, and a field with no heading stays with the one above", () => {
  const fields = [f("x"), f("y"), ...["a", "b", "c", "d", "e", "g", "h"].map((k) => f(k, "More")), f("z")];
  const p = planPages(fields);
  assert.equal(p[0].title, "Details");
  assert.ok(p.some((x) => x.kind === "fields" && x.keys.includes("z") && x.keys.includes("h")));
});

test("lines are their own page after the header, then Review", () => {
  const p = planPages([f("date"), f("godown")], { lines: "Item" });
  assert.deepEqual(
    p.map((x) => `${x.kind}:${x.title}`),
    ["fields:Details", "lines:Items", "review:Review"],
  );
});

test("a lines-only form is the lines and nothing to review", () => {
  const p = planPages([], { lines: "Line" });
  assert.deepEqual(p.map((x) => x.kind), ["lines"]);
});

test("one long section is one page, and one page needs no review", () => {
  const p = planPages(Array.from({ length: 12 }, (_, i) => f(`k${i}`, "Only")));
  assert.deepEqual(p.map((x) => x.title), ["Only"]);
});

test("an error is found on its page", () => {
  const p = planPages([f("date")], { lines: "Item" });
  assert.equal(pageOfError(p, "h.date"), 0);
  assert.equal(pageOfError(p, "l2.qty"), 1);
  assert.equal(pageOfError(p, "h.nope"), -1);
});

test("plurals", () => {
  assert.equal(plural("Item"), "Items");
  assert.equal(plural("Delivery"), "Deliveries");
  assert.equal(plural("Lines"), "Lines");
  assert.equal(plural(""), "Lines");
  assert.equal(plural("Raw material (litres)"), "Raw materials (litres)");
});
