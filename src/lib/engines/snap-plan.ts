import { metresBetween } from "@/lib/geo";

/* ---------------------------------------------------------------------------
 * WHAT OF A TRAIL STILL HAS TO BE ASKED OF OLA MAPS, and what we already hold.
 *
 * The Live map's road line is bought from an outside service with a metered
 * bill on it: 1,00,000 requests a month, and a full working day's trail for
 * ONE salesman is around thirty of them. The whole team on every look is two
 * hundred, and the map is looked at all day by more than one person — which is
 * how a feature that draws a nicer line becomes a feature that runs out of
 * quota in the third week of the month and then draws no line at all.
 *
 * The waste is structural rather than accidental. A day grows at ONE END. The
 * first eight hours of a trail have not changed since the last time we asked
 * about them, and asking again buys back a road we already have — while the
 * two minutes of walking since is one request's worth. So this decides, per
 * run of fixes, which of four things is true:
 *
 *   reuse  — not one fix has been added; the geometry we hold is the answer.
 *   extend — it has grown; ask only about the tail and append.
 *   hold   — it has grown, but we asked very recently; the new tail is drawn
 *            raw for now rather than bought again (see `minRefreshMs`).
 *   full   — we hold nothing for this run, or what we hold is not a prefix of
 *            it any more, so there is nothing to build on.
 *
 * It is an ENGINE and not three lines inside the route for the reason every
 * engine here is one: the route imports `server-only`, reads secrets and
 * speaks to Ola, so nothing in it can be exercised without a network and a
 * key — and the thing that most needs pinning is a COUNT, which is invisible
 * to every other kind of check. `snap-plan.test.ts` grows a day two minutes at
 * a time and counts the requests.
 *
 * NOTHING HERE IS A SOURCE OF TRUTH. The raw fixes in `mbos_positions` are,
 * exactly as `road-snap-service.ts` says, and every plan this returns is
 * checked against them: a cached run is only ever built on where its first
 * point, its start time and the fix at its own far end all still match what
 * the database answers now. Anything else is thrown away and asked again.
 * ------------------------------------------------------------------------- */

/** `[lng, lat]`, GeoJSON's order — which is what the map draws and what the
    route's own pieces carry. `LatLng` below is Ola's order; the two meet in
    `road-snap-service.ts`. */
export type Coord = [number, number];

export type LatLng = { lat: number; lng: number };

/**
 * One run of fixes, snapped, as we hold it.
 *
 * `coveredCount` counts RAW fixes and `path` counts road corners, and the two
 * are deliberately unrelated: a road-following path has as many points as the
 * road has bends, so it can never be paired back up with the fixes one for
 * one. `seam` is the last raw fix the path actually reaches — the one point
 * both the held head and the next tail request will be told about, which is
 * what joins them (see `planRun`).
 */
export type SnappedRun = {
  fromMs: number;
  firstCoord: Coord;
  coveredCount: number;
  seam: Coord;
  path: Coord[];
  snappedAtMs: number;
};

export type RunPlan =
  | { kind: "reuse"; path: Coord[] }
  | { kind: "hold"; path: Coord[]; rawTail: Coord[] }
  | { kind: "extend"; head: SnappedRun; seam: Coord; tail: Coord[] }
  | { kind: "full"; coordinates: Coord[] };

export type RunInput = { coordinates: Coord[]; fromMs: number };

export type PlanOptions = {
  nowMs: number;
  /** How recently we may have asked before a grown run is left to draw its
      new tail raw rather than buying it again. Configuration — see
      `mbos.location.snapRefreshSeconds`. */
  minRefreshMs: number;
};

/* Coordinates come back out of the database as the same doubles that went in,
   so an exact comparison is the right one here — this is asking "is this the
   same stored fix", not "are these two readings near each other". A tolerance
   would quietly accept a DIFFERENT fix a metre away as the seam and join the
   line to the wrong point. */
function sameCoord(a: Coord, b: Coord): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Whether a held run is still a prefix of what the day now says.
 *
 * Three things have to agree, and each of them catches a different way the
 * ground can move under a cache. The start time and the first fix say this is
 * the same run and not a differently-cut one — trips are re-split from the
 * whole day on every read, and a dwell forming at the tail can change where
 * the last piece begins. The fix at `coveredCount - 1` says the stretch we
 * hold is still the stretch that is there: a fix withdrawn, corrected or
 * dropped for accuracy shifts everything after it, and appending to a head
 * that no longer matches would draw a road nobody walked.
 */
function stillAPrefixOf(head: SnappedRun, run: RunInput): boolean {
  if (head.fromMs !== run.fromMs) return false;
  if (run.coordinates.length < head.coveredCount || head.coveredCount < 1) return false;
  if (!sameCoord(head.firstCoord, run.coordinates[0])) return false;
  return sameCoord(head.seam, run.coordinates[head.coveredCount - 1]);
}

/**
 * What still has to be asked about one run.
 *
 * THE SEAM IS THE WHOLE JOIN, and it is the same answer `callSnap` already
 * gives between two batches of one request: two independently-snapped halves
 * meet at nothing, and what lands on the map is a notch or a little hook past
 * a corner. So the tail request is told about the head's last fix as its FIRST
 * point — both halves then see one point in common, both snap it to the same
 * place, and the tail's copy of it is dropped on the way in. The two are
 * joined at a point they agree on rather than butted together at two they
 * never compared.
 *
 * `hold` exists because a refresh has a bill attached. Drawing the newest
 * stretch raw for a minute or two is what the map does anyway for every trail
 * whose snap has not landed yet, and it is honest: those are the real fixes.
 * What it must never do is SHORTEN the line — the raw tail is carried, so the
 * answer still reaches the latest fix either way.
 */
export function planRun(
  head: SnappedRun | undefined,
  run: RunInput,
  options: PlanOptions,
): RunPlan {
  if (run.coordinates.length < 2) return { kind: "full", coordinates: run.coordinates };
  if (!head || !stillAPrefixOf(head, run)) {
    return { kind: "full", coordinates: run.coordinates };
  }

  const grown = run.coordinates.slice(head.coveredCount);
  if (!grown.length) return { kind: "reuse", path: head.path };

  if (options.nowMs - head.snappedAtMs < options.minRefreshMs) {
    return { kind: "hold", path: head.path, rawTail: grown };
  }

  return { kind: "extend", head, seam: head.seam, tail: grown };
}

/**
 * The same, for a whole day's worth of runs.
 *
 * Held runs are matched to current ones BY POSITION, and a mismatch takes
 * everything after it with it. The day is cut from the start every time, so a
 * run that has stopped matching means the cut moved — and a held run further
 * along is then a held run for a stretch of trail that is now somebody else's
 * piece. Keeping it would be joining two lines that were never one.
 */
export function planDay(
  held: (SnappedRun | undefined)[],
  runs: RunInput[],
  options: PlanOptions,
): RunPlan[] {
  const plans: RunPlan[] = [];
  let broken = false;
  for (let i = 0; i < runs.length; i++) {
    const head = broken ? undefined : held[i];
    /* A MISMATCH breaks the chain; holding NOTHING does not. Nothing held for
       a run is the ordinary case — the first look of the day, and every gap,
       which is never snapped and so never held — and it says nothing at all
       about the run after it. Breaking on it too would mean one dashed hop in
       the morning threw away the whole afternoon's road on every request,
       which is most days. */
    if (head && !stillAPrefixOf(head, runs[i])) broken = true;
    plans.push(planRun(broken ? undefined : head, runs[i], options));
  }
  return plans;
}

/* ---------------------------------------------------------------------------
 * THE ARITHMETIC OF WHAT A PLAN COSTS.
 *
 * Both of these used to live in `road-snap-service.ts`, which imports
 * `server-only` and a secret — so the two numbers that decide the entire bill
 * could not be read by a test. They are pure, they are the same numbers the
 * service uses, and the service imports them from here.
 * ------------------------------------------------------------------------- */

/** Ola Maps' own ceiling per Snap-to-Road request — 50 points, not the 100
    the endpoint's naming suggests. Found rather than read off a spec; see the
    service's header. */
export const OLA_MAX_POINTS_PER_REQUEST = 50;

/** How far apart the points handed to Snap-to-Road are. At three-second
    sampling most fixes are within a stride of their neighbour, and thinning by
    DISTANCE TRAVELLED keeps every corner — a turn always has an anchor either
    side of it — while handing Ola the shape rather than the noise. */
export const PATH_ANCHOR_METRES = 20;

/**
 * A run thinned to one anchor per `PATH_ANCHOR_METRES`, with both ends kept.
 *
 * The greedy scan runs over every point INCLUDING the last, and the last is
 * then added only if the scan did not already take it. That is the same set
 * the older `points.slice(1, -1)` spelling produced — a final point 20 m or
 * more from the previous anchor is taken by the scan and not added twice,
 * below that it is added at the end either way — and it has one property that
 * spelling did not: the scan over a PREFIX of a run is a prefix of the scan
 * over the whole run. A day grows at one end, so that is the property the
 * whole incremental design rests on.
 */
export function downsampleForPath<P extends LatLng>(points: P[]): P[] {
  if (points.length <= 2) return points.slice();
  const kept: P[] = [points[0]];
  for (const p of points.slice(1)) {
    const last = kept[kept.length - 1];
    if (metresBetween(last.lat, last.lng, p.lat, p.lng) >= PATH_ANCHOR_METRES) kept.push(p);
  }
  const end = points[points.length - 1];
  if (kept[kept.length - 1] !== end) kept.push(end);
  return kept;
}

/**
 * How many requests `callSnap` makes for a given number of points.
 *
 * Batches overlap by one point, so each request after the first carries 49 new
 * ones. Exported so a test can pin the BILL rather than the behaviour — the
 * count is the thing this change exists to move, and it is invisible to a
 * type check, a lint and every assertion about the line that gets drawn.
 */
export function olaRequestCount(pointCount: number): number {
  if (pointCount < 2) return 0;
  const step = OLA_MAX_POINTS_PER_REQUEST - 1;
  let requests = 0;
  for (let i = 0; i < pointCount; i += step) {
    const batch = Math.min(OLA_MAX_POINTS_PER_REQUEST, pointCount - i);
    if (i > 0 && batch < 2) break;
    if (batch >= 2) requests += 1;
    if (i + OLA_MAX_POINTS_PER_REQUEST >= pointCount) break;
  }
  return requests;
}

/** What one plan costs in Ola requests, before anything is sent. */
export function requestsForPlan(plan: RunPlan): number {
  switch (plan.kind) {
    case "reuse":
    case "hold":
      return 0;
    case "extend":
      return olaRequestCount(downsampleForPath(asLatLng([plan.seam, ...plan.tail])).length);
    case "full":
      return olaRequestCount(downsampleForPath(asLatLng(plan.coordinates)).length);
  }
}

function asLatLng(coords: Coord[]): LatLng[] {
  return coords.map(([lng, lat]) => ({ lat, lng }));
}
