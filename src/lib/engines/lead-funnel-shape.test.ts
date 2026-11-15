import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  SHARED_TRACKS,
  sharedFunnel,
  unpicturedLadders,
  type LadderTally,
} from "./lead-funnel-shape";
import {
  DIRECT_LADDER,
  DISPLAY_STAGES,
  DISTRIBUTOR_LADDER,
  THIRD_PARTY_LADDER,
  displayStageOf,
} from "./lead-ladder";
import { SALES_TYPES, type LeadSalesType, type LeadStage } from "../lead-labels";
import { LEGACY_SALES_TYPE, SALES_TYPE_BUCKETS } from "../lead-filters";

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

test("the shared funnel is the seven stages people see", () => {
  const f = sharedFunnel([tally("direct", DIRECT_LADDER, {})]);
  assert.deepEqual(f.rungs.map((r) => r.stage), [...DISPLAY_STAGES]);
});

test("every rung of both shop ladders is drawn under one of the seven", () => {
  for (const s of [...DIRECT_LADDER, ...THIRD_PARTY_LADDER]) {
    assert.ok(displayStageOf(s), `${s} is on a shop ladder and on no part of the funnel view`);
  }
});

test("both shop tracks carry the one Sample / Trial rung, so a zero there is a real zero", () => {
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, { sample_trial: 4 }),
    tally("third_party", THIRD_PARTY_LADDER, {}),
  ]);
  const row = f.rungs.find((r) => r.stage === "sample_trial")!;
  const direct = row.segments.find((s) => s.salesType === "direct")!;
  const third = row.segments.find((s) => s.salesType === "third_party")!;
  assert.equal(direct.carried, true);
  assert.equal(direct.count, 4);
  /* Carried by both: since Sample Received and Sample Review stopped being rungs
     there is no rung one shop track lacks, so nobody is standing there. */
  assert.equal(third.carried, true);
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
    tally("direct", DIRECT_LADDER, {}, { arrived: 40, arrivedByStage: { customer: rung("customer", 40, 12) } }),
  ]);
  assert.equal(f.rungs.find((r) => r.stage === "customer")!.total, 40);
});

/* "won is never counted onto a rung it was not on" was retired with the one
   ladder (Nov 2026): `foldStage` reads `won` as Customer, and every conversion
   writes it, so the Customer row counts it — see the test at the foot. */

test("delivery, payment and the second order are counted under First order", () => {
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, { delivery: 2, payment: 5, negotiation: 1 }),
    tally("third_party", THIRD_PARTY_LADDER, { payment: 3 }),
  ]);
  assert.equal(f.operational.length, 0);
  assert.equal(f.rungs.find((r) => r.stage === "first_order")!.total, 10);
  assert.equal(f.rungs.find((r) => r.stage === "negotiation")!.total, 1);
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

test("a lead with no sales type is part of the one funnel, so nothing is left unpictured", () => {
  const legacy = tally(null, DIRECT_LADDER, { suspect: 4 });
  const left = unpicturedLadders([
    tally("direct", DIRECT_LADDER, {}),
    tally("distributor", DISTRIBUTOR_LADDER, {}),
    tally("third_party", THIRD_PARTY_LADDER, {}),
    legacy,
  ]);
  assert.deepEqual(left.map((l) => l.salesType), []);
});

test("an arrived rung carries its median, not just its count", () => {
  /* The median is computed for every group and was being thrown away on the
     way into `arrived`. A rung reading 40 beside the words "no lead on this
     rung records when it arrived" is a screen arguing with itself. */
  const f = sharedFunnel([
    tally(
      "direct",
      DIRECT_LADDER,
      {},
      { arrived: 40, arrivedByStage: { customer: rung("customer", 40, 12) } },
    ),
  ]);
  const seg = f.rungs
    .find((r) => r.stage === "customer")!
    .segments.find((s) => s.salesType === "direct")!;
  assert.equal(seg.medianDaysHere, 12);
  assert.equal(seg.dated, 40);
});

test("every track the funnel can draw is one the list filter accepts", () => {
  /*
   * THE LINK AND THE LIST ARE JOINED BY A SPELLING, which is the failure this
   * pins. Each segment opens `leads?salesType=<track>&stage=<rung>`, and a
   * track the clause has never heard of does not fail — `leadFilterClause`
   * simply matches nothing, so the bar says 14 and the list it opens says 0,
   * with nothing on either screen able to say why. A fourth sales type added
   * to the enum without a bucket fails here instead.
   */
  const offered = new Set<string>(SALES_TYPE_BUCKETS.map((b) => b.value));
  for (const t of SALES_TYPES) {
    assert.ok(offered.has(t.code), `${t.code} is a sales type the list cannot be filtered to`);
  }
  /* And the fourth answer, which is not in the enum at all: a lead carrying no
     sales type is a population, and `in (…)` never matches NULL. */
  assert.ok(offered.has(LEGACY_SALES_TYPE));
});

test("the Customer row counts `won` (what every conversion writes) beside `customer`", () => {
  const f = sharedFunnel([
    tally("direct", DIRECT_LADDER, {}, {
      arrived: 7,
      arrivedByStage: { won: rung("won", 5), customer: rung("customer", 2) },
    }),
  ]);
  const customer = f.rungs.find((r) => r.stage === "customer")!;
  assert.equal(customer.total, 7);
});

test("Delivery and Payment are counted on the First order row", () => {
  const f = sharedFunnel([tally("direct", DIRECT_LADDER, { first_order: 1, delivery: 2, payment: 3 })]);
  assert.equal(f.rungs.find((r) => r.stage === "first_order")!.total, 6);
});
