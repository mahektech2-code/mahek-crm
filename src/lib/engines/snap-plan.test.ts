import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  downsampleForPath,
  olaRequestCount,
  planDay,
  planRun,
  requestsForPlan,
  type Coord,
  type RunPlan,
  type SnappedRun,
} from "./snap-plan";

/* A straight walk, one fix every three seconds at about 1.4 m/s — the sampling
   and the pace the handset actually produces. Four metres a fix, so a twenty
   metre anchor is one in five. Longitude at Nagpur's latitude: 1e-5 degrees is
   roughly 1.02 m, which is close enough for an arithmetic test and is why the
   assertions below are on COUNTS rather than on exact positions. */
const METRE_IN_DEGREES = 1 / 102_000;

function walk(fixes: number, metresApart = 4): Coord[] {
  const out: Coord[] = [];
  for (let i = 0; i < fixes; i++) {
    out.push([79 + i * metresApart * METRE_IN_DEGREES, 21]);
  }
  return out;
}

function headFor(run: Coord[], fromMs: number, snappedAtMs: number): SnappedRun {
  return {
    fromMs,
    firstCoord: run[0],
    coveredCount: run.length,
    seam: run[run.length - 1],
    /* The shape of the held path does not matter to the plan — only that it
       is held. A road-following path is not one point per fix anyway. */
    path: run.slice(),
    snappedAtMs,
  };
}

const FRESH = { nowMs: 10_000_000, minRefreshMs: 120_000 };

test("a run that has not moved is reused and costs nothing", () => {
  const run = walk(100);
  const plan = planRun(headFor(run, 1, 0), { coordinates: run, fromMs: 1 }, FRESH);
  assert.equal(plan.kind, "reuse");
  assert.equal(requestsForPlan(plan), 0);
});

test("a grown run asks only about its tail, and carries the seam into it", () => {
  const before = walk(1_000);
  const after = walk(1_040);
  const plan = planRun(headFor(before, 1, 0), { coordinates: after, fromMs: 1 }, FRESH);
  assert.equal(plan.kind, "extend");
  if (plan.kind !== "extend") return;
  /* The seam is the last fix the held path already reaches, sent again as the
     first point of the tail so both halves snap one point in common. */
  assert.deepEqual(plan.seam, before[before.length - 1]);
  assert.equal(plan.tail.length, 40);
  assert.deepEqual(plan.tail[0], after[1_000]);
});

test("nothing held, or a head that is no longer a prefix, is snapped whole", () => {
  const run = walk(200);
  assert.equal(planRun(undefined, { coordinates: run, fromMs: 1 }, FRESH).kind, "full");

  /* A different start time is a differently-cut piece. */
  assert.equal(
    planRun(headFor(run, 1, 0), { coordinates: run, fromMs: 2 }, FRESH).kind,
    "full",
  );

  /* A fix withdrawn or corrected inside the stretch we hold shifts everything
     after it, so the seam no longer lands where we left it. */
  const moved = run.slice();
  moved[199] = [moved[199][0] + 0.01, moved[199][1]];
  assert.equal(
    planRun(headFor(run, 1, 0), { coordinates: moved, fromMs: 1 }, FRESH).kind,
    "full",
  );

  /* Shorter than what we hold cannot be an extension of it. */
  assert.equal(
    planRun(headFor(run, 1, 0), { coordinates: run.slice(0, 150), fromMs: 1 }, FRESH).kind,
    "full",
  );
});

test("a run asked about moments ago holds, and still reaches the newest fix", () => {
  const before = walk(1_000);
  const after = walk(1_040);
  const plan = planRun(headFor(before, 1, 9_999_000), { coordinates: after, fromMs: 1 }, FRESH);
  assert.equal(plan.kind, "hold");
  if (plan.kind !== "hold") return;
  assert.equal(requestsForPlan(plan), 0);
  /* THE LINE IS NEVER SHORTENED by a hold — the new stretch is carried raw. */
  assert.equal(plan.rawTail.length, 40);
  assert.deepEqual(plan.rawTail[plan.rawTail.length - 1], after[1_039]);
});

test("a run that stops matching takes every run after it with it", () => {
  const a = walk(50);
  const b = walk(50);
  const c = walk(50);
  const held = [headFor(a, 1, 0), headFor(b, 2, 0), headFor(c, 3, 0)];
  const plans = planDay(
    held,
    [
      { coordinates: a, fromMs: 1 },
      /* Re-cut: this piece now starts at a different moment. */
      { coordinates: b, fromMs: 22 },
      { coordinates: c, fromMs: 3 },
    ],
    FRESH,
  );
  assert.deepEqual(plans.map((p) => p.kind), ["reuse", "full", "full"]);
});

test("a run nothing is held for does not throw away the runs after it", () => {
  /* Every gap in a day is a run nothing is ever held for — it is never
     snapped — so a break on an absent entry would cost the whole afternoon's
     road on every request of most days. */
  const a = walk(50);
  const b = walk(50);
  const c = walk(50);
  const plans = planDay(
    [headFor(a, 1, 0), undefined, headFor(c, 3, 0)],
    [
      { coordinates: a, fromMs: 1 },
      { coordinates: b, fromMs: 2 },
      { coordinates: c, fromMs: 3 },
    ],
    FRESH,
  );
  assert.deepEqual(plans.map((p) => p.kind), ["reuse", "full", "reuse"]);
});

test("the anchor scan over a prefix is a prefix of the scan over the whole", () => {
  /* The property the whole design rests on: a day grows at one end, so what
     was already sent to Ola must not be re-chosen differently once more fixes
     land behind it. */
  const whole = walk(500).map(([lng, lat]) => ({ lat, lng }));
  const anchors = downsampleForPath(whole);
  for (const cut of [100, 237, 400]) {
    const prefix = downsampleForPath(whole.slice(0, cut));
    /* Every anchor but the last — the last is the run's own end point, forced
       in, and a run that has grown no longer ends there. */
    for (let i = 0; i < prefix.length - 1; i++) {
      assert.deepEqual(prefix[i], anchors[i], `anchor ${i} of a ${cut}-fix prefix`);
    }
  }
});

test("batching overlaps by one point, so a request carries 49 new ones", () => {
  assert.equal(olaRequestCount(0), 0);
  assert.equal(olaRequestCount(1), 0);
  assert.equal(olaRequestCount(2), 1);
  assert.equal(olaRequestCount(50), 1);
  assert.equal(olaRequestCount(51), 2);
  assert.equal(olaRequestCount(99), 2);
  assert.equal(olaRequestCount(100), 3);
});

/* -------------------------------------------------------------------------
 * THE BILL. This is the test the change exists for: everything else here can
 * pass while the map quietly costs five times what it should, because a
 * request count is invisible to a type check, a lint, and every assertion
 * about the line that gets drawn.
 * ---------------------------------------------------------------------- */
test("a day watched all the way through costs its tails, not its length again", () => {
  /* 30 km at four metres a fix is 7,500 fixes: a full working day's walking
     and driving, at the sampling the handset actually uses. */
  const FIXES = 7_500;
  const whole = walk(FIXES);

  const fullEveryTime = requestsForPlan({ kind: "full", coordinates: whole });
  /* ~1,500 anchors at one per twenty metres, 49 new points a request. */
  assert.ok(fullEveryTime >= 30 && fullEveryTime <= 34, `full day = ${fullEveryTime}`);

  /* Now watch it grow: a look every two minutes from an empty morning to the
     end of the day. Two minutes at this pace is 50 fixes, 200 metres, ten
     anchors — ONE request, whatever the day has behind it. */
  const STEP = 50;
  let held: SnappedRun | undefined;
  let requests = 0;
  let nowMs = 0;
  for (let n = STEP; n <= FIXES; n += STEP) {
    nowMs += 120_000;
    const run = { coordinates: whole.slice(0, n), fromMs: 1 };
    const plan = planRun(held, run, { nowMs, minRefreshMs: 120_000 });
    requests += requestsForPlan(plan);
    held = advance(held, run, plan, nowMs);
  }

  const looks = FIXES / STEP;
  /* One request per look and not one day per look: the naive design pays the
     whole trail again every time, which is what puts this over quota. */
  assert.equal(requests, looks, `incremental = ${requests} over ${looks} looks`);
  assert.ok(
    requests * 20 < looks * fullEveryTime,
    `incremental ${requests} vs naive ${looks * fullEveryTime}`,
  );

  /* And the whole day is covered exactly once, however many looks it took. */
  assert.equal(held?.coveredCount, FIXES);
});

test("a second reader of the same day pays nothing at all", () => {
  const run = walk(3_000);
  const input = { coordinates: run, fromMs: 1 };
  const first = planRun(undefined, input, FRESH);
  const held = advance(undefined, input, first, FRESH.nowMs);
  const second = planRun(held, input, FRESH);
  assert.ok(requestsForPlan(first) > 10);
  assert.equal(requestsForPlan(second), 0);
});

/** What the route does with a plan once Ola has answered, as far as the plan
    itself is concerned — the geometry is the service's business, the coverage
    is this. */
function advance(
  held: SnappedRun | undefined,
  run: { coordinates: Coord[]; fromMs: number },
  plan: RunPlan,
  nowMs: number,
): SnappedRun | undefined {
  if (plan.kind === "hold") return held;
  return {
    fromMs: run.fromMs,
    firstCoord: run.coordinates[0],
    coveredCount: run.coordinates.length,
    seam: run.coordinates[run.coordinates.length - 1],
    path: run.coordinates.slice(),
    snappedAtMs: nowMs,
  };
}
