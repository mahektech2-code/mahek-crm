import { metresBetween } from "../geo";

/**
 * Where a trail is confident, and where it is a guess.
 *
 * A trail is a string of real fixes joined by straight lines. At dense
 * sampling those lines already lie on the road, which is the whole reason
 * Snap-to-Road can afford to relocate a point onto its nearest road segment
 * and nothing more — see `road-snap-service.ts`. But two consecutive fixes
 * can still land far apart: a stretch driven rather than walked between two
 * dwell points, or a signal genuinely lost for a while. Nobody recorded what
 * happened between them, so the road actually taken there is unknown — it
 * could be any of several streets — and drawing a solid line across it reads
 * as a fact the trail does not have.
 *
 * `splitTrailByGaps` is what tells the two apart: every hop under
 * `gapMetres` is folded into the confident run it belongs to; a hop at or
 * above it becomes its own two-point segment, marked `gap: true`, so the map
 * can draw it differently — a dashed line rather than a solid one — instead
 * of pretending the same thing is known about both.
 */
export type TrailSegment = {
  coordinates: [number, number][];
  gap: boolean;
};

/**
 * A fix the handset itself rates as imprecise is not evidence of where
 * anybody was standing — the same reasoning `mbos.location.gpsAccuracyThresholdM`
 * already applies to visit verification (see AGENTS.md). A single 300-metre-
 * radius fix sitting between two tight ones manufactures a hop that never
 * happened: the road distance covered is invented by the bad fix, not by
 * anything the salesman did, and both the "gap" it draws and the direction
 * arrow on it are simply wrong.
 *
 * A `null` accuracy is not the same claim as a bad one — most of this book's
 * history predates the column, and a fix nobody rated is kept exactly as
 * every other engine here keeps missing confidence: whole, never penalised.
 * Only a fix the handset itself rated worse than the threshold is dropped —
 * never corrected or moved, per the standing rule that this trail shows only
 * what is known and never a prediction.
 */
export function dropInaccurateFixes<T extends { accuracyM: number | null }>(
  points: T[],
  thresholdMetres: number,
): T[] {
  return points.filter((p) => p.accuracyM === null || p.accuracyM <= thresholdMetres);
}

export function splitTrailByGaps(
  points: { lat: number; lng: number }[],
  gapMetres: number,
): TrailSegment[] {
  if (points.length < 2) return [];

  const segments: TrailSegment[] = [];
  let run: [number, number][] = [[points[0].lng, points[0].lat]];

  const closeRun = () => {
    if (run.length >= 2) segments.push({ coordinates: run, gap: false });
  };

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const coord: [number, number] = [b.lng, b.lat];

    if (metresBetween(a.lat, a.lng, b.lat, b.lng) >= gapMetres) {
      closeRun();
      segments.push({ coordinates: [[a.lng, a.lat], coord], gap: true });
      run = [coord];
    } else {
      run.push(coord);
    }
  }
  closeRun();

  return segments;
}
