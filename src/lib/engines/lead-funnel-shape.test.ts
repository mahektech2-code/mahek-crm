import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  OPERATIONAL_STAGES,
  SHARED_TRACKS,
  distributorLadder,
  sharedFunnel,
  sharedRungOrder,
  unpicturedLadders,
  type LadderTally,
} from "./lead-funnel-shape";
import {
  DIRECT_LADDER,
  DISTRIBUTOR_LADDER,
  THIRD_PARTY_LADDER,
} from "./lead-ladder";
import type { LeadSalesType, LeadStage } from "../lead-labels";

/* ---------------------------------------------------------------------------
 * The rule these pin is that NO RUNG FALLS OFF THE SCREEN.
 *
 * There are twenty-three rungs across three ladders and a funnel that quietly
 * omits one draws a pipeline that shrinks as the team works it. Every test
 * below is a different way of asking the same question — is every rung of every
 * ladder drawn somewhere, and does every counted lead land in exactly one place.
 * ------------------------------------------------------------------------- */

function rung(stage: LeadStage, count: number, median: number | null = null) {
  return { stage, count, medianDaysHere: median, dated: median === null ? 0 : count, potentialPaise: 0 };
}

function tally(
  salesType: LeadSalesType | null,
  ladder: readonly LeadStage[],
  counts: Partial<Record<LeadStage, number>>,
  extra: Partial<LadderTally> = {},
): LadderTally {
  return {
    salesType,
    rungs: ladder.map((s) => rung(s, counts[s] ?? 0)),
    offLadder: [],
    parked: 0,
    lost: 0,
    arrived: 0,
    arrivedByStage: {},
    ...extra,
    /* `inFunnel` is on the ladder OR off it and still climbing — the service's
       own definition, restated here so the accounting test below is asking the
       real question rather than one this helper made easy. */
    inFunnel:
      Object.values(counts).reduce((n, v) => n + (v ?? 0), 0) +
      (extra.offLadder ?? []).reduce((n, r) => n + r.count, 0),
  };
}

test("the shared funnel is ten rungs, and the two it leaves out are named", () => {
  const order = sharedRungOrder();
  assert.equal(order.length, 10);
  for (const s of OPERATIONAL_STAGES) assert.ok(!order.includes(s));
  /* The union of the two shop ladders, which is what makes it ten rather than
     the nine an intersection would give. */
  assert.ok(order.includes("sample_received"));
});

test("every rung of both shop ladders is drawn somewhere", () => {
  const drawn = new Set<LeadStage>([...sharedRungOrder(), ...OPERATIONAL_STAGES]);
  for (const s of [...DIRECT_LADDER, ...THIRD_PARTY_LADDER]) {
    assert.ok(drawn.has(s), `${s} is on a shop ladder and on no part of the funnel view`);
  }
});

test("a rung one track does not carry says so rather than reading as empty", () => {
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, { sample_received: 4 }),
    tally("third_party", THIRD_PARTY_LADDER, {}),
  ]);
  const row = f.rungs.find((r) => r.stage === "sample_received")!;
  const direct = row.segments.find((s) => s.salesType === "direct")!;
  const third = row.segments.find((s) => s.salesType === "third_party")!;
  assert.equal(direct.carried, true);
  assert.equal(direct.count, 4);
  /* Zero AND not carried — §3C drops this rung, so "nobody is standing here"
     would be the wrong reading of the same number. */
  assert.equal(third.carried, false);
  assert.equal(third.count, 0);
});

test("a track with no leads at all is still a segment", () => {
  const f = sharedFunnel([tally("direct", DIRECT_LADDER, { suspect: 3 })]);
  for (const r of f.rungs) {
    assert.equal(r.segments.length, SHARED_TRACKS.length);
  }
  assert.equal(f.rungs.find((r) => r.stage === "suspect")!.total, 3);
});

test("the top rung carries its arrivals rather than drawing zero", () => {
  /* `funnelByRung` files `customer` under `arrived`, so a ladder reading only
     `rungs` would draw its own last rung at zero on a book that has converted
     forty shops. */
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, {}, { arrived: 40, arrivedByStage: { customer: 40 } }),
  ]);
  assert.equal(f.rungs.find((r) => r.stage === "customer")!.total, 40);
});

test("won is never counted onto a rung it was not on", () => {
  /* `arrived` sums three stages. Reaching for it instead of `arrivedByStage`
     would put legacy `won` leads on the direct ladder's `customer` rung. */
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, {}, { arrived: 7, arrivedByStage: { won: 7 } }),
  ]);
  assert.equal(f.rungs.find((r) => r.stage === "customer")!.total, 0);
});

test("delivery and payment are counted, not filtered away", () => {
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, { delivery: 2, payment: 5, negotiation: 1 }),
    tally("third_party", THIRD_PARTY_LADDER, { payment: 3 }),
  ]);
  assert.deepEqual(
    f.operational.map((r) => [r.stage, r.total]),
    [["delivery", 2], ["payment", 8]],
  );
  /* And they are nowhere in the bars, or the funnel would report a lorry's
     position as a stage of the sale. */
  assert.ok(!f.rungs.some((r) => OPERATIONAL_STAGES.includes(r.stage)));
});

test("every counted lead lands in exactly one place", () => {
  const direct = tally(
    "direct",
    DIRECT_LADDER,
    { suspect: 10, sample_trial: 4, delivery: 2 },
    { parked: 3, lost: 6, offLadder: [rung("management_review", 1)] },
  );
  const f = sharedFunnel([direct]);
  const inBars = f.rungs.reduce((n, r) => n + r.total, 0);
  const inOps = f.operational.reduce((n, r) => n + r.total, 0);
  const off = f.offLadder.reduce((n, r) => n + r.count, 0);
  assert.equal(inBars + inOps + off, direct.inFunnel);
  assert.equal(f.parked, 3);
  assert.equal(f.lost, 6);
});

test("the widest rung is what the bars are measured against", () => {
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, { suspect: 40, prospect: 9 }),
    tally("third_party", THIRD_PARTY_LADDER, { suspect: 5 }),
  ]);
  assert.equal(f.widest, 45);
});

test("the distributor ladder draws all nine of its rungs, in order", () => {
  const l = distributorLadder([tally("distributor", DISTRIBUTOR_LADDER, { qualification: 2 })]);
  assert.deepEqual(l.steps.map((s) => s.stage), [...DISTRIBUTOR_LADDER]);
  assert.equal(l.climbing, 2);
});

test("the distributor ladder is drawn even where nobody is on it", () => {
  /* The track is retired for NEW leads and the screen must not read as dead —
     nor as being fed. An empty ladder is nine steps at zero, not an absence. */
  const l = distributorLadder([]);
  assert.equal(l.steps.length, DISTRIBUTOR_LADDER.length);
  assert.equal(l.climbing, 0);
});

test("§12's two approvals are marked and the conversations are not", () => {
  const l = distributorLadder([]);
  const approvals = l.steps.filter((s) => s.approval).map((s) => s.stage);
  assert.deepEqual(approvals, ["management_review", "distributor_approval"]);
});

test("the distributor top rung carries its arrivals too", () => {
  const l = distributorLadder([
    tally(
      "distributor",
      DISTRIBUTOR_LADDER,
      {},
      { arrived: 2, arrivedByStage: { active_distributor: 2 } },
    ),
  ]);
  assert.equal(l.steps.find((s) => s.stage === "active_distributor")!.count, 2);
});

test("the legacy ladder is neither picture, and is reported rather than dropped", () => {
  const legacy = tally(null, ["new", "contacted"], { new: 4 });
  const left = unpicturedLadders([
    tally("direct", DIRECT_LADDER, {}),
    tally("distributor", DISTRIBUTOR_LADDER, {}),
    tally("third_party", THIRD_PARTY_LADDER, {}),
    legacy,
  ]);
  assert.deepEqual(left.map((l) => l.salesType), [null]);
});
