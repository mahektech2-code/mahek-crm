/**
 * The Tasks permissions: each widens exactly one reach, managing implies
 * seeing, an administrator holds them all, and a retired power on a stored
 * row grants nothing.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { cleanTaskPowers, heldTaskPowers, reachesEverybody, TASK_POWERS, TASK_POWER_LABEL, type TaskPower } from "./permissions";

const set = (...p: TaskPower[]) => new Set<TaskPower>(p);

describe("Tasks permissions", () => {
  test("nothing held reaches only the org chart, for every question", () => {
    for (const r of ["see", "give", "manage"] as const) assert.equal(reachesEverybody(set(), r), false);
  });

  test("each permission widens its own reach and no other", () => {
    assert.deepEqual(["see", "give", "manage"].map((r) => reachesEverybody(set("seeAll"), r as never)), [true, false, false]);
    assert.deepEqual(["see", "give", "manage"].map((r) => reachesEverybody(set("giveAnyone"), r as never)), [false, true, false]);
    assert.deepEqual(["see", "give", "manage"].map((r) => reachesEverybody(set("automations"), r as never)), [false, false, false]);
  });

  test("managing anybody's tasks includes seeing them, and not giving to them", () => {
    assert.deepEqual(["see", "give", "manage"].map((r) => reachesEverybody(set("manageAnyone"), r as never)), [true, false, true]);
  });

  test("an administrator holds every permission without a row", () => {
    assert.deepEqual([...heldTaskPowers({ administrator: true, rows: [] })].sort(), [...TASK_POWERS].sort());
  });

  test("a stored row naming a retired power is ignored", () => {
    assert.deepEqual([...heldTaskPowers({ administrator: false, rows: ["seeAll", "deleteEverything"] })], ["seeAll"]);
    assert.deepEqual(cleanTaskPowers(["automations", "seeAll", "seeAll"]), ["seeAll", "automations"]);
  });

  test("every permission has words for the Access screen", () => {
    for (const p of TASK_POWERS) {
      assert.ok(TASK_POWER_LABEL[p].label.length > 3, p);
      assert.ok(TASK_POWER_LABEL[p].source.length > 20, p);
    }
  });
});
