import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { splitLabel } from "./field-label";
import { firstSentence, formSub, isSentence, promptSub } from "./quiet-copy";

test("a figure's unit moves out of its label and into the box", () => {
  assert.deepEqual(splitLabel("Use quantity (litres)", "num"), { label: "Use quantity", unit: "L" });
  assert.deepEqual(splitLabel("Rate (₹)", "num"), { label: "Rate", unit: "₹", unitBefore: true });
  assert.deepEqual(splitLabel("SFG available (litres)", "derived"), { label: "SFG available", unit: "L" });
  assert.deepEqual(splitLabel("Weight (kg)", "num"), { label: "Weight", unit: "kg" });
});

test("a select keeps its unit in the label, because the box cannot carry it", () => {
  assert.deepEqual(splitLabel("Can size (litres)", "select"), { label: "Can size (litres)" });
});

test("a bracket that is not a unit stays put", () => {
  assert.deepEqual(splitLabel("Lot (PR)", "num"), { label: "Lot (PR)" });
  assert.deepEqual(splitLabel("Packing (boxed SKU)", "select"), { label: "Packing (boxed SKU)" });
});

test("a typed '(optional)' is said once, by the field", () => {
  assert.deepEqual(splitLabel("Remarks (optional)", "text"), { label: "Remarks", optional: true });
  assert.deepEqual(splitLabel("Weight (kg) (optional)", "num"), { label: "Weight", unit: "kg", optional: true });
});

test("a form says nothing under its title that is a sentence, and keeps a record's name", () => {
  assert.equal(formSub("SFG from one lot, filled into cans or drums of one FG product."), null);
  assert.equal(formSub("FG-128 · FG12NA"), "FG-128 · FG12NA");
  assert.equal(formSub(undefined), null);
  assert.equal(isSentence("Every item the department needs."), true);
  assert.equal(isSentence("Nano Thinner · 5 L"), false);
});

test("a prompt keeps the first sentence — what the button will do", () => {
  assert.equal(
    promptSub("A rejected lot cannot be filled. What has already been filled from it stays traceable to it. Record the tests you ran."),
    "A rejected lot cannot be filled.",
  );
  assert.equal(promptSub("Nano Thinner · 12ASTOL1"), "Nano Thinner · 12ASTOL1");
  assert.equal(firstSentence("Pay 5.5 L. Then go."), "Pay 5.5 L.");
});

/* The guard. A screen's registry line was drawn under every ERP page title; it
   is a sentence a person reads once and skips for ever, so no page passes it. */
test("no ERP page draws its screen's registry line under the title", () => {
  const root = join(process.cwd(), "src/app/erp");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) files.push(p);
    }
  };
  walk(root);
  const offenders = files.filter((f) => /sub=\{(SCREEN|screen)\.sub\}/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});
