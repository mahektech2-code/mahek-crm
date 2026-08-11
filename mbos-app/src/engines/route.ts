import { haversineMetres, type Coords } from './geo';

/**
 * The order to visit today's shops in.
 *
 * Two things this is not. It is not a routing service — there is no road
 * network here, only straight-line distance, because the phone is offline in a
 * market lane and a route that arrives is worth more than a route that is
 * optimal. And it is not a filter: **a customer with no coordinate is appended
 * at the end and flagged, never dropped.** A shop missing from the day's list
 * because a lat/long was never captured is a shop nobody visits, and nobody
 * ever finds out why — the failure is completely silent, which is what makes it
 * the dangerous one.
 *
 * Construction is nearest-neighbour, then a bounded 2-opt improvement pass.
 * Nearest-neighbour alone tours reasonably and finishes with one long dash back
 * across the territory; 2-opt untangles exactly that. Both are bounded by
 * arguments rather than by a clock, so the same input always produces the same
 * route — a plan that reshuffled itself between two renders would be a plan
 * nobody trusts.
 *
 * Pure — no clock, no store, no network.
 */

export type RouteInput = {
  id: string;
  /** Null for a shop whose location was never captured. Kept, never dropped. */
  coords: Coords | null;
};

export type RouteOptions = {
  /**
   * Average speed used to turn metres into minutes. Configuration, because the
   * honest number differs by a factor of three between a city beat on a
   * two-wheeler and a district tour in a car.
   */
  averageSpeedKmph: number;
  /**
   * How many full 2-opt sweeps to attempt. Each sweep is O(n²); the pass stops
   * early the moment a sweep finds no improvement, so this is a ceiling and not
   * a target.
   */
  maxTwoOptPasses: number;
  /**
   * Above this many stops the 2-opt pass is skipped and nearest-neighbour's
   * answer stands. A day's beat is twenty to thirty shops; this exists so a
   * pathological list cannot lock the thread on a mid-range Android.
   */
  maxStopsForTwoOpt: number;
  /**
   * Minutes budgeted inside each shop. Travel time alone under-reads the day
   * badly enough to be useless for planning.
   */
  minutesPerStop?: number;
};

export type RouteLeg<S extends RouteInput> = {
  stop: S;
  /** 1-based, so it can be printed on a screen without arithmetic. */
  position: number;
  /** Null for an unlocated stop — a zero would read as "next door". */
  metresFromPrevious: number | null;
  travelMinutes: number | null;
  /** Running travel + dwell total to the point of arriving here. */
  cumulativeMinutes: number | null;
  located: boolean;
  /** Set only on the unlocated tail, and shown as-is. */
  flag: string | null;
};

export type RouteResult<S extends RouteInput> = {
  /** Located stops in visiting order, then the unlocated tail. */
  ordered: RouteLeg<S>[];
  /** The same unlocated stops again, so a screen can list them on their own. */
  unlocated: S[];
  totalDistanceMetres: number;
  /** Travel only. */
  totalTravelMinutes: number;
  /** Travel plus the per-stop dwell allowance, for every stop including the tail. */
  estimatedDayMinutes: number;
  /** True when the 2-opt pass was skipped because the list was too long. */
  twoOptSkipped: boolean;
};

const minutesFor = (metres: number, kmph: number): number =>
  kmph <= 0 ? 0 : (metres / (kmph * 1000)) * 60;

/**
 * Nearest-neighbour construction, then bounded 2-opt.
 *
 * `start` is where the salesman is when the day begins — home, the depot, or
 * his current fix. It is not a stop and never appears in the result; it only
 * decides which shop is first, which is the decision that matters most and the
 * one a route built from an arbitrary first row gets wrong every time.
 */
export function optimiseRoute<S extends RouteInput>(
  stops: readonly S[],
  start: Coords | null,
  opts: RouteOptions,
): RouteResult<S> {
  const located: (S & { coords: Coords })[] = [];
  const unlocated: S[] = [];
  for (const s of stops) {
    if (s.coords) located.push(s as S & { coords: Coords });
    else unlocated.push(s);
  }

  const dwell = opts.minutesPerStop ?? 0;

  // Nearest-neighbour. With no starting point the first stop in the list is the
  // seed — arbitrary, but a stated arbitrary beats pretending we know better.
  const order: number[] = [];
  const taken = new Set<number>();
  let cursor: Coords | null = start;

  while (order.length < located.length) {
    let best = -1;
    let bestMetres = Infinity;
    for (let i = 0; i < located.length; i++) {
      if (taken.has(i)) continue;
      const d = cursor ? haversineMetres(cursor, located[i]!.coords) : 0;
      if (d < bestMetres) {
        bestMetres = d;
        best = i;
      }
      // With no cursor every distance is zero, so the first untaken wins.
      if (!cursor) break;
    }
    taken.add(best);
    order.push(best);
    cursor = located[best]!.coords;
  }

  // 2-opt: repeatedly reverse a segment where doing so shortens the tour. This
  // is what removes the long crossing dash nearest-neighbour leaves behind.
  const twoOptSkipped = located.length > opts.maxStopsForTwoOpt;
  if (!twoOptSkipped && located.length > 3) {
    const legMetres = (a: number, b: number): number =>
      haversineMetres(located[a]!.coords, located[b]!.coords);
    const fromStart = (i: number): number =>
      start ? haversineMetres(start, located[i]!.coords) : 0;

    for (let pass = 0; pass < opts.maxTwoOptPasses; pass++) {
      let improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let k = i + 1; k < order.length; k++) {
          // The edge before i: the start point when i is the first stop.
          const beforeA = i === 0 ? null : order[i - 1]!;
          const a = order[i]!;
          const b = order[k]!;
          const afterB = k === order.length - 1 ? null : order[k + 1]!;

          const currentHead = beforeA === null ? fromStart(a) : legMetres(beforeA, a);
          const swappedHead = beforeA === null ? fromStart(b) : legMetres(beforeA, b);
          // The tail edge vanishes when b is last — reversing then costs nothing
          // on that side, which is exactly the crossing dash we are hunting.
          const currentTail = afterB === null ? 0 : legMetres(b, afterB);
          const swappedTail = afterB === null ? 0 : legMetres(a, afterB);

          if (swappedHead + swappedTail < currentHead + currentTail - 1e-9) {
            reverse(order, i, k);
            improved = true;
          }
        }
      }
      // A sweep that changed nothing means every later sweep would change
      // nothing either, so the ceiling is rarely reached.
      if (!improved) break;
    }
  }

  const ordered: RouteLeg<S>[] = [];
  let totalDistanceMetres = 0;
  let totalTravelMinutes = 0;
  let cumulative = 0;
  let previous: Coords | null = start;

  order.forEach((idx, position) => {
    const stop = located[idx]!;
    const metres = previous ? haversineMetres(previous, stop.coords) : 0;
    const travel = minutesFor(metres, opts.averageSpeedKmph);
    totalDistanceMetres += metres;
    totalTravelMinutes += travel;
    cumulative += travel + dwell;
    ordered.push({
      stop,
      position: position + 1,
      metresFromPrevious: previous ? metres : null,
      travelMinutes: previous ? travel : null,
      cumulativeMinutes: cumulative,
      located: true,
      flag: null,
    });
    previous = stop.coords;
  });

  unlocated.forEach((stop, i) => {
    cumulative += dwell;
    ordered.push({
      stop,
      position: order.length + i + 1,
      metresFromPrevious: null,
      travelMinutes: null,
      cumulativeMinutes: null,
      located: false,
      flag: 'No location on file — fit this one in yourself, and drop a pin while you are there.',
    });
  });

  return {
    ordered,
    unlocated,
    totalDistanceMetres,
    totalTravelMinutes,
    estimatedDayMinutes: totalTravelMinutes + dwell * stops.length,
    twoOptSkipped,
  };
}

function reverse(order: number[], i: number, k: number): void {
  while (i < k) {
    const t = order[i]!;
    order[i] = order[k]!;
    order[k] = t;
    i++;
    k--;
  }
}
