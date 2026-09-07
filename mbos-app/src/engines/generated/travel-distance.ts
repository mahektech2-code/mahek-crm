/* GENERATED FILE — DO NOT EDIT.
 * Copied from src/lib/engines/travel-distance.ts by scripts/sync-mbos-engines.mjs.
 * Edit the source and run `npm run mbos:sync-engines`. A stale copy fails
 * the test suite in both projects, which is the point: the handset and the
 * office must never disagree about what a day is worth.
 */
/* ---------------------------------------------------------------------------
 * E12 — how far, and how sure.
 *
 * Distance between two points, and along a day's GPS trail. Pure: points and
 * thresholds arrive as arguments, and nothing here reads a clock or a table.
 *
 * **A GPS number has to say what kind of number it is, and that is the whole
 * point of this file.** How good the number is depends entirely on how often
 * the phone reported, and that is configuration: at
 * `mbos.location.trackEverySeconds` = 3 the points are metres apart and the
 * line hugs the road actually walked; at a minute or more they are hundreds of
 * metres apart and the line cuts every corner, flyover and diversion. The
 * figure is a FLOOR on the real distance, and the floor gets looser as the
 * interval widens and as the person moves faster.
 *
 * So the interval is never assumed. It arrives as an argument, coverage is
 * measured against it, and every function returns its method and its coverage
 * beside its number — because the same code path produces a near-exact
 * distance on a three-second trail and a serious under-read on a stale one,
 * and only the coverage tells them apart. Presenting either as "the actual
 * distance travelled" would short-pay whoever covered the most ground.
 *
 * Metres and integers throughout, for the same reason money is paise: a float
 * of kilometres accumulates error across a day of legs and nobody can see it
 * happening.
 * ------------------------------------------------------------------------- */

export type Fix = {
  /** Epoch milliseconds. */
  at: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
};

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle metres between two points. */
export function haversineMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

export type TrailDistance = {
  metres: number | null;
  /** How the number was arrived at, so a screen can say it. */
  method: "trail" | "straight_line_factored" | null;
  fixCount: number;
  /** What share of the leg's duration the trail actually had fixes for. */
  coveragePct: number;
  /** Present only where nothing could be measured. */
  reason: string | null;
};

export type TrailOptions = {
  /** Fixes looser than this are dropped: a 500 m fix is not a position. */
  maxAccuracyM: number;
  /**
   * Expected gap between fixes, in SECONDS — `mbos.location.trackEverySeconds`.
   *
   * Seconds rather than minutes because the setting is seconds and its floor is
   * three: expressed in minutes that is 0.05, and integer arithmetic on it
   * would round the expected fix count to nonsense. Coverage is measured
   * against this, so a leg with half the fixes it should have reads as 50%
   * covered rather than as a confident short distance.
   */
  expectedFixEverySeconds: number;
  /**
   * Straight line → estimated road distance, in basis points of the straight
   * line. Only ever used where the trail could not answer, and the result is
   * always labelled an estimate.
   */
  roadFactorBps: number;
  /** Below this coverage the trail figure is evidence, never a payable source. */
  minCoveragePct: number;
};

/**
 * The length of the path the phone actually recorded between two instants.
 *
 * Fixes are taken in the order the trail holds them — the handset's own clock,
 * which is what makes a track a shape. A fix too loose to be a position is
 * dropped rather than smoothed: a 500 m circle joined to the one before it
 * invents up to a kilometre of travel that never happened.
 */
export function trailDistance(
  fixes: readonly Fix[],
  fromAt: number,
  toAt: number,
  opts: TrailOptions,
): TrailDistance {
  if (toAt <= fromAt) {
    return { metres: null, method: null, fixCount: 0, coveragePct: 0, reason: "The leg has no duration." };
  }

  const usable = fixes
    .filter((f) => f.at >= fromAt && f.at <= toAt)
    .filter((f) => f.accuracyM === null || f.accuracyM <= opts.maxAccuracyM)
    .sort((a, b) => a.at - b.at);

  if (usable.length < 2) {
    return {
      metres: null,
      method: null,
      fixCount: usable.length,
      coveragePct: 0,
      reason:
        usable.length === 0
          ? "The day's track has no positions over this leg — tracking was off, or the phone had no signal."
          : "One position is not a path.",
    };
  }

  let metres = 0;
  for (let i = 1; i < usable.length; i++) {
    metres += haversineMetres(usable[i - 1]!, usable[i]!);
  }

  /* Coverage is measured against how many fixes the cadence SHOULD have
     produced, not against the wall clock — a leg is covered when the phone was
     reporting throughout it, and that is a count. */
  const seconds = (toAt - fromAt) / 1000;
  const expected = Math.max(
    2,
    Math.floor(seconds / Math.max(1, opts.expectedFixEverySeconds)) + 1,
  );
  const coveragePct = Math.min(100, Math.round((usable.length / expected) * 100));

  return { metres, method: "trail", fixCount: usable.length, coveragePct, reason: null };
}

/**
 * What a straight line suggests the road might be.
 *
 * Deliberately a separate function with its own method name. It is a guess and
 * it is labelled a guess wherever it is shown — a factored crow-flies distance
 * silently returned as `method: "trail"` would be the whole point of this file
 * thrown away.
 */
export function straightLineEstimate(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  roadFactorBps: number,
): TrailDistance {
  const direct = haversineMetres(a, b);
  return {
    metres: Math.round((direct * roadFactorBps) / 10_000),
    method: "straight_line_factored",
    fixCount: 0,
    coveragePct: 0,
    reason: null,
  };
}

/**
 * The GPS answer for one leg: the trail where it covered the leg well enough,
 * a labelled estimate from the two endpoints where it did not, and null where
 * there is nothing at all to go on.
 *
 * **Null is a recorded fact, not a missing one.** The same rule
 * `mbos_activity_locations` already follows: coordinates absent with a reason
 * says we asked and could not, and no answer at all says nothing was asked.
 * A screen that could not tell those apart would say "no distance" for both.
 */
export function gpsDistanceForLeg(
  fixes: readonly Fix[],
  leg: {
    startedAt: number | null;
    endedAt: number | null;
    from: { lat: number; lng: number } | null;
    to: { lat: number; lng: number } | null;
  },
  opts: TrailOptions,
): TrailDistance {
  if (leg.startedAt !== null && leg.endedAt !== null) {
    const trail = trailDistance(fixes, leg.startedAt, leg.endedAt, opts);
    if (trail.metres !== null && trail.coveragePct >= opts.minCoveragePct) return trail;
    if (leg.from && leg.to) {
      const estimate = straightLineEstimate(leg.from, leg.to, opts.roadFactorBps);
      return {
        ...estimate,
        fixCount: trail.fixCount,
        coveragePct: trail.coveragePct,
        reason:
          trail.metres === null
            ? trail.reason
            : `The track covered ${trail.coveragePct}% of this leg, which is not enough to measure it — this is an estimate from the two ends.`,
      };
    }
    return trail;
  }

  if (leg.from && leg.to) return straightLineEstimate(leg.from, leg.to, opts.roadFactorBps);

  return {
    metres: null,
    method: null,
    fixCount: 0,
    coveragePct: 0,
    reason: "This leg has neither a start and end time nor two points, so nothing can measure it.",
  };
}
