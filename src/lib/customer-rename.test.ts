import { test } from "node:test";
import assert from "node:assert/strict";
import { renameValues, sheetKeys } from "./customer-rename";

test("the first rename keeps the name the sheets use", () => {
  assert.deepEqual(renameValues({ name: "Acme Paints", sheetName: null }, "Acme Paint House"), {
    name: "Acme Paint House",
    sheetName: "Acme Paints",
  });
});

test("a second rename keeps the sheet's name, not the first rename", () => {
  assert.deepEqual(renameValues({ name: "Acme Paint House", sheetName: "Acme Paints" }, "Acme Coatings"), {
    name: "Acme Coatings",
    sheetName: "Acme Paints",
  });
});

test("renaming back to the sheet's spelling clears it", () => {
  assert.deepEqual(renameValues({ name: "Acme Coatings", sheetName: "Acme Paints" }, "Acme  Paints"), {
    name: "Acme Paints",
    sheetName: null,
  });
});

test("a change of case or spacing is a rename too, so the sync cannot undo it", () => {
  assert.deepEqual(renameValues({ name: "acme paints", sheetName: null }, " Acme   Paints "), {
    name: "Acme Paints",
    sheetName: "acme paints",
  });
  assert.deepEqual(sheetKeys({ name: "Acme Paints", sheetName: "acme paints" }), ["ACME PAINTS"]);
});

test("the same name, or a blank one, is not a rename", () => {
  assert.equal(renameValues({ name: "Acme Paints", sheetName: null }, "Acme Paints"), null);
  assert.equal(renameValues({ name: "Acme Paints", sheetName: null }, "   "), null);
});

test("a renamed party answers to both names", () => {
  assert.deepEqual(sheetKeys({ name: "Acme Coatings", sheetName: "Acme  Paints" }), ["ACME COATINGS", "ACME PAINTS"]);
  assert.deepEqual(sheetKeys({ name: "Acme Paints", sheetName: null }), ["ACME PAINTS"]);
});
