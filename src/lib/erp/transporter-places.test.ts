import { test } from "node:test";
import assert from "node:assert/strict";
import { leaves, lookup, optionsFor, placePath, repick, withAncestors, type PlaceOption } from "./transporter-places";

const nodes: PlaceOption[] = [
  { id: "mh", kind: "state", name: "Maharashtra", parentId: null },
  { id: "gj", kind: "state", name: "Gujarat", parentId: null },
  { id: "thane", kind: "district", name: "Thane", parentId: "mh" },
  { id: "pune-d", kind: "district", name: "Pune", parentId: "mh" },
  { id: "surat-d", kind: "district", name: "Surat", parentId: "gj" },
  { id: "bhiwandi", kind: "city", name: "Bhiwandi", parentId: "thane" },
  { id: "pune", kind: "city", name: "Pune", parentId: "pune-d" },
  { id: "surat", kind: "city", name: "Surat", parentId: "surat-d" },
  { id: "narpoli", kind: "area", name: "Narpoli", parentId: "bhiwandi" },
];
const byId = lookup(nodes);

test("only the narrowest pick in a branch is stored", () => {
  assert.deepEqual(leaves(["mh", "thane", "bhiwandi", "gj"], byId).sort(), ["bhiwandi", "gj"]);
});

test("reloaded picks tick the path above each godown", () => {
  assert.deepEqual(withAncestors(["narpoli"], byId).sort(), ["bhiwandi", "mh", "narpoli", "thane"]);
});

test("a rung offers what sits under the nearest picked rung above", () => {
  assert.deepEqual(optionsFor("city", ["mh"], nodes, byId).map((o) => o.value).sort(), ["bhiwandi", "pune"]);
  assert.deepEqual(optionsFor("city", ["mh", "thane"], nodes, byId).map((o) => o.value), ["bhiwandi"]);
  assert.equal(optionsFor("city", [], nodes, byId).length, 3);
  assert.equal(optionsFor("district", ["mh"], nodes, byId)[0].label, "Pune — Maharashtra");
});

test("unpicking a state drops the picks under it and keeps the rest", () => {
  const picks = ["mh", "gj", "bhiwandi", "surat"];
  assert.deepEqual(repick("state", ["gj"], picks, byId).sort(), ["gj", "surat"]);
  assert.deepEqual(repick("state", [], picks, byId).sort(), ["bhiwandi", "surat"]);
});

test("a path names the place and everything above it", () => {
  assert.equal(placePath("narpoli", byId), "Narpoli, Bhiwandi, Thane, Maharashtra");
});
