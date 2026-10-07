import { test } from "node:test";
import assert from "node:assert/strict";
import { diffBlueprints } from "./diff";
import { SALES_EXECUTIVE } from "../seed/blueprints";

test("identical versions differ in nothing", () => {
  assert.deepEqual(diffBlueprints(SALES_EXECUTIVE, structuredClone(SALES_EXECUTIVE)), []);
});

test("a reworded question is ONE changed row, not a removal and an addition", () => {
  const b = structuredClone(SALES_EXECUTIVE);
  b.stages.find((s) => s.key === "l2")!.questions[0].text = "Walk me through a normal working day.";
  const rows = diffBlueprints(SALES_EXECUTIVE, b);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "changed");
  assert.match(rows[0].where, /Level 2 · Q1/);
});

test("option points, blocking flags, thresholds, stages and the growth ladder are all seen", () => {
  const b = structuredClone(SALES_EXECUTIVE);
  const l2 = b.stages.find((s) => s.key === "l2")!;
  l2.passThreshold = 63;
  l2.questions.find((q) => q.key === "q7")!.options![2].points = null;
  b.stages.find((s) => s.key === "brf")!.briefing![1].blocking = false;
  b.stages = b.stages.filter((s) => s.key !== "scr");
  b.offer.growth[0] = { ...b.offer.growth[0], incrementType: "fixed_amount", value: 200000 };
  const rows = diffBlueprints(SALES_EXECUTIVE, b);
  const where = rows.map((r) => `${r.kind}:${r.where}`).join("\n");
  assert.match(where, /changed:Stage · Level 2 · pass mark/);
  assert.match(where, /changed:Level 2 · Q7 · options/);
  assert.match(where, /changed:Briefing · Level 2A · Monthly target/);
  assert.match(where, /removed:Stage · AI voice screen/);
  assert.match(where, /changed:Growth path/);
  assert.match(rows.find((r) => r.where === "Level 2 · Q7 · options")!.b, /no score/);
});
