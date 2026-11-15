import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DISPLAY_STAGES, displayStageOf, foldStage } from "./engines/lead-ladder";
import { ALL_LEAD_STAGES, type LeadStage } from "./lead-labels";
import {
  displayStageLabel,
  displayStageOptions,
  foldStageOptions,
  rawStagesOf,
  stagesForFilterKey,
} from "./lead-display";

test("every stored stage is under exactly one display stage or off the bar", () => {
  const covered = DISPLAY_STAGES.flatMap(rawStagesOf);
  assert.equal(new Set(covered).size, covered.length);
  for (const s of ALL_LEAD_STAGES) {
    assert.equal(covered.includes(s), displayStageOf(s) !== null, s);
  }
});

test("won reads Customer, contacted reads Suspect, as foldStage reads them", () => {
  assert.equal(displayStageLabel("won"), displayStageLabel("customer"));
  assert.equal(displayStageOf("contacted"), "suspect");
  assert.equal(displayStageOf(foldStage("contacted")), "suspect");
  assert.ok(!rawStagesOf("prospect").includes("contacted"));
});

test("Negotiation covers every rung the record draws under it", () => {
  const n = rawStagesOf("negotiation");
  for (const s of ["negotiation", "commercial_discussion", "distributor_approval", "distributor_agreement"] as LeadStage[]) {
    assert.ok(n.includes(s), s);
  }
});

test("a stage filter offers each display stage once, and a pick expands to its rungs", () => {
  const keys = displayStageOptions().map((o) => o.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.includes("won"));
  assert.deepEqual(new Set(stagesForFilterKey("customer")), new Set(rawStagesOf("customer")));
  assert.deepEqual(stagesForFilterKey("lost"), ["lost"]);
  assert.deepEqual(stagesForFilterKey("nonsense"), []);
});

test("grouped counts fold into one option per display stage", () => {
  const opts = foldStageOptions([
    { value: "won", count: 3 },
    { value: "customer", count: 2 },
    { value: "lost", count: 1 },
    { value: null, count: 9 },
  ]);
  assert.deepEqual(opts.map((o) => [o.value, o.count]), [["customer", 5], ["lost", 1]]);
});
