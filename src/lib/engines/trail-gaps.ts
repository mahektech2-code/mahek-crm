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
