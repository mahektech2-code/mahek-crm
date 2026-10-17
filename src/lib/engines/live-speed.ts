import { metresBetween } from "../geo";

/**
 * How fast somebody is moving RIGHT NOW, read off the fixes already on the
 * Live map — or null, which is what this answers far more often than a number.
 *
 * **It is derived, because nothing stores a speed.** A position is a time, a
 * place and an accuracy; the handset's own speed reading never reaches us. So
 * this is distance over time between fixes the map already holds, and it is
 * pure so the browser can run it on every arrival and a test can pin it.
 *
 * **Displacement over a WINDOW, never the last hop.** Fixes arrive every few
 * seconds and each is good to tens of metres, so two neighbours can be 30 m
 * apart while a man stands at a counter — 36 km/h out of nothing. Over a
 * minute that jitter is a rounding error. And it is the straight line from the
 * window's first fix to its last, not the sum of the hops: summing adds every
 * wobble as travel, which is exactly the error being avoided. On a road that
 * bends inside a minute it reads a little low, which is the safe direction.
 *
 * **Null for each of the readings that would be a lie.** A latest fix older
 * than `maxAgeSeconds` — a handset flushing a backlog sends accurate speeds
 * from an hour ago, and printed beside a pin they read as now. A window
 * shorter than `minWindowSeconds` — too little time to beat the jitter. A gap
 * inside the window longer than `maxGapSeconds` — the jump across a hole in
 * the trail is not a speed. Below `minKmh` — walking pace and standing still
 * are where GPS noise lives, and the screen says nothing rather than "3 km/h"
 * about a man in a shop. And above `maxKmh` — no field salesman does that, so
 * it is a bad fix, not a reading.
 */
export type SpeedOptions = {
  /** Below this nothing is shown. Configuration: `mbos.location.liveSpeedMinKmh`. */
  minKmh: number;
  /** Fixes the handset rated worse than this are ignored, as the trail ignores them. */
  accuracyThresholdM: number;
  windowSeconds?: number;
  minWindowSeconds?: number;
  maxGapSeconds?: number;
  maxAgeSeconds?: number;
  maxKmh?: number;
};

const DEFAULTS = {
  windowSeconds: 60,
  minWindowSeconds: 20,
  maxGapSeconds: 30,
  maxAgeSeconds: 120,
  maxKmh: 150,
};

export function currentSpeedKmh(
  points: { lat: number; lng: number; at: Date; accuracyM: number | null }[],
  nowMs: number,
  options: SpeedOptions,
): number | null {
  const o = { ...DEFAULTS, ...options };
  const fixes = points.filter((p) => p.accuracyM == null || p.accuracyM <= o.accuracyThresholdM);
  if (fixes.length < 2) return null;

  const last = fixes[fixes.length - 1];
  const lastMs = last.at.getTime();
  /* The clock the panel holds ticks every thirty seconds, so a fix can be a
     little NEWER than it — that is fresh, not an error. */
  if (nowMs - lastMs > o.maxAgeSeconds * 1000) return null;

  /* Walk back from the newest fix, stopping at the window's edge or at a hole. */
  let first = last;
  for (let i = fixes.length - 2; i >= 0; i--) {
    const p = fixes[i];
    if (lastMs - p.at.getTime() > o.windowSeconds * 1000) break;
    if (first.at.getTime() - p.at.getTime() > o.maxGapSeconds * 1000) break;
    first = p;
  }

  const seconds = (lastMs - first.at.getTime()) / 1000;
  if (seconds < o.minWindowSeconds) return null;

  const kmh = (metresBetween(first.lat, first.lng, last.lat, last.lng) / seconds) * 3.6;
  if (kmh < o.minKmh || kmh > o.maxKmh) return null;
  return Math.round(kmh);
}
