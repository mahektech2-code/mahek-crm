import { metresBetween } from "../geo";

/**
 * Where a trail stood still for a while, not just passed through.
 *
 * A GPS trail is a string of fixes, and most of a working day is spent
 * inside a shop rather than walking between them — the fixes taken there sit
 * within a few metres of each other for minutes at a stretch, and a plain
 * line drawn through them looks identical to a fix taken while waiting at a
 * red light. `dwellStops` is what tells the two apart: a run of consecutive
 * fixes that never drifts more than `radiusMetres` from the run's own first
 * fix, held for at least `minMinutes`. GPS drifts even standing still, so the
 * radius has to clear ordinary drift; the minutes floor is what keeps a red
 * light from being drawn as a stop worth a manager's attention.
 *
 * The anchor is the run's FIRST fix, not a running centroid — a centroid
 * would let a stop slowly walk away from where it started, fix by fix, and
 * still read as one dwell so long as each step stayed inside the radius of
 * the step before it. Anchoring to the first fix is what makes "still there"
 * mean the same thing on fix two hundred as it did on fix one.
 *
 * Pure, like every other engine here — the map draws what this returns, and
 * nothing about GPS or the DOM belongs in it.
 */
export type DwellStop = {
  lat: number;
  lng: number;
  startAt: Date;
  endAt: Date;
  minutes: number;
};

export function dwellStops(
  points: { lat: number; lng: number; at: Date }[],
  radiusMetres: number,
  minMinutes: number,
): DwellStop[] {
  const stops: DwellStop[] = [];
  if (points.length < 2) return stops;

  let anchor = points[0];
  let runStart = 0;

  const closeRun = (endIndex: number) => {
    const run = points.slice(runStart, endIndex + 1);
    const first = run[0];
    const last = run[run.length - 1];
    const minutes = (last.at.getTime() - first.at.getTime()) / 60_000;
    if (minutes >= minMinutes) {
      stops.push({
        lat: run.reduce((sum, p) => sum + p.lat, 0) / run.length,
        lng: run.reduce((sum, p) => sum + p.lng, 0) / run.length,
        startAt: first.at,
        endAt: last.at,
        minutes,
      });
    }
  };

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (metresBetween(anchor.lat, anchor.lng, p.lat, p.lng) <= radiusMetres) continue;

    closeRun(i - 1);
    runStart = i;
    anchor = p;
  }
  closeRun(points.length - 1);

  return stops;
}
