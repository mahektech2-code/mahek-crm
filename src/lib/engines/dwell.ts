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

/**
 * The same runs, as INDEXES rather than as places.
 *
 * `dwellStops` answers "where did he stand still", which is what the map's
 * stop marks want. `splitTrailIntoTrips` needs the other half of the same
 * fact — WHICH FIXES those were — so it can end one trip where he stopped and
 * begin the next where he set off again.
 *
 * Both read this rather than each implementing the rule, because two copies
 * of "what counts as standing still" would drift, and the half that drifted
 * would be the half somebody was looking at: a stop drawn on the map with the
 * trail either side of it unbroken, or a colour change at a place with no
 * mark on it. One rule, two readers.
 */
export type DwellRun = { startIndex: number; endIndex: number; minutes: number };

export function dwellRuns(
  points: { lat: number; lng: number; at: Date }[],
  radiusMetres: number,
  minMinutes: number,
): DwellRun[] {
  const runs: DwellRun[] = [];
  if (points.length < 2) return runs;

  let anchor = points[0];
  let runStart = 0;

  const closeRun = (endIndex: number) => {
    const first = points[runStart];
    const last = points[endIndex];
    const minutes = (last.at.getTime() - first.at.getTime()) / 60_000;
    if (minutes >= minMinutes) runs.push({ startIndex: runStart, endIndex, minutes });
  };

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (metresBetween(anchor.lat, anchor.lng, p.lat, p.lng) <= radiusMetres) continue;

    closeRun(i - 1);
    runStart = i;
    anchor = p;
  }
  closeRun(points.length - 1);

  return runs;
}

/**
 * Where a run of fixes actually sat, as one point.
 *
 * The mean of the run rather than its first fix: the anchor is where he
 * ARRIVED, and on a twenty-minute stop the fixes spread out around the place
 * he stood rather than around the moment he got there. Exported because the
 * trip boundary has to land on the same spot the stop mark is drawn at — two
 * ways of averaging one stop would put the colour change a few metres from
 * the circle explaining it, which is exactly the kind of small wrongness
 * nobody can name and everybody stops trusting.
 */
export function centroidOf(points: { lat: number; lng: number }[]): { lat: number; lng: number } {
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length,
  };
}

export function dwellStops(
  points: { lat: number; lng: number; at: Date }[],
  radiusMetres: number,
  minMinutes: number,
): DwellStop[] {
  return dwellRuns(points, radiusMetres, minMinutes).map((r) => {
    const run = points.slice(r.startIndex, r.endIndex + 1);
    return {
      ...centroidOf(run),
      startAt: run[0].at,
      endAt: run[run.length - 1].at,
      minutes: r.minutes,
    };
  });
}
