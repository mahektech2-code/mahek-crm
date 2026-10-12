import test from "node:test";
import assert from "node:assert/strict";
import { familyKey, familyLabel, planCanGroups, sameFamily } from "./can-groups";

test("the family is the name without its size or the words every can carries", () => {
  assert.equal(familyKey("Packing Material 1 liter Mahek Yellow"), "mahek yellow");
  assert.equal(familyKey("Mahek Yellow 5 Ltr"), "mahek yellow");
  assert.equal(familyKey("packing material 20LITER mahek yellow"), "mahek yellow");
  assert.equal(familyKey("Epoxy Thinner (FD) Plain Can - 1 Liter (32 Can/Box)"), "epoxy thinner fd plain");
  assert.equal(familyKey("PU Thinner M16 Plain Can - 10 Liter (Loose)"), "pu thinner m16 plain");
  assert.equal(familyKey("500 ml Naked"), "naked");
});

test("a name that is only a size and can-words has no family", () => {
  assert.equal(familyKey("1 L Tin Can"), "");
  assert.equal(familyKey("Packing material 5 Liter"), "");
});

test("near names are one family; different prints are not", () => {
  assert.ok(sameFamily("mahek yellow", "mahek yellow"));
  assert.ok(sameFamily("mahek yellow", "mahek yellow print"));
  assert.ok(!sameFamily("mahek yellow", "mahek red"));
  assert.ok(!sameFamily("plain", "naked"));
  assert.ok(!sameFamily("", "plain"));
});

test("label reads like a name", () => {
  assert.equal(familyLabel("mahek yellow"), "Mahek Yellow");
  assert.equal(familyLabel("pu thinner m16 plain"), "PU Thinner M16 Plain");
});

test("cans of one family become a group; a lone family and a familyless can are left", () => {
  const plan = planCanGroups(
    [
      { id: "a", name: "Packing Material 1 liter Mahek Yellow" },
      { id: "b", name: "Packing Material 5 liter Mahek Yellow" },
      { id: "c", name: "Naked 20 Liter" },
      { id: "d", name: "Naked 1 Liter" },
      { id: "e", name: "Blue Star 1 L" },
      { id: "f", name: "1 L Tin Can" },
    ],
    [],
  );
  assert.deepEqual(
    plan.create.map((g) => [g.name, [...g.memberIds].sort()]).sort(),
    [
      ["Mahek Yellow", ["a", "b"]],
      ["Naked", ["c", "d"]],
    ],
  );
  assert.deepEqual(plan.left.map((l) => [l.id, l.why]).sort(), [["e", "alone"], ["f", "no_family"]]);
  assert.deepEqual(plan.join, []);
});

test("a can joins an existing group of its family, even alone", () => {
  const plan = planCanGroups(
    [{ id: "x", name: "Mahek Yellow 10 Ltr" }],
    [{ id: "g1", name: "Yellow cans", memberNames: ["Packing Material 1 liter Mahek Yellow"] }],
  );
  assert.deepEqual(plan.join, [{ groupId: "g1", groupName: "Yellow cans", memberIds: ["x"] }]);
  assert.equal(plan.create.length, 0);
});

test("a new group never takes a name already used", () => {
  const plan = planCanGroups(
    [
      { id: "a", name: "Naked 1 L" },
      { id: "b", name: "Naked 5 L" },
    ],
    [{ id: "g", name: "Naked", memberNames: [] }],
  );
  // The existing group is named "Naked", so the cans join it rather than duplicating it.
  assert.deepEqual(plan.join.map((j) => j.groupId), ["g"]);
});
