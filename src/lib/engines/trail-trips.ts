import { metresBetween } from "../geo";
import { centroidOf, dwellRuns } from "./dwell";

/**
 * A day, cut into the journeys it was actually made of.
 *
 * One colour for a whole day answers "where did he go" and refuses to answer
 * the question a manager asks next, which is "and in what ORDER". A beat that
 * doubles back — down 14th Cross to a shop, back up it an hour later, down it
 * again at five — draws three lines on top of each other in one colour, and
 * what is on screen is a road he visited, with no way to tell one passage
 * from another. The information was there and the drawing threw it away.
 *
 * A TRIP IS A LEG BETWEEN RESTS. He sets off, he arrives somewhere and stays,
 * and that is one trip; leaving again begins the next. Numbered in the order
 * they were WALKED rather than by where they went, which is the whole point:
 * going from C to A this morning and from C to A again this evening are two
 * different trips and get two different colours, because they are two
 * different things that happened.
 *
 * **Both boundaries already existed and neither is invented here.** A trip
 * ends at a DWELL — `mbos.location.dwellRadiusMeters` held for
 * `dwellMinMinutes`, the same runs the map already draws stop marks for, read
 * through `dwellRuns` so the mark and the colour change can never disagree
 * about where he stopped. And it ends at a GAP — `mbos.location.trailGapMeters`,
 * the same threshold `splitTrailByGaps` dashes, because a stretch nobody
 * recorded is not the middle of a journey, it is the end of one and the start
 * of another.
 *
 * Consecutive trips SHARE their boundary fix, so the lines meet rather than
 * leaving a hole at every stop. That one point is deliberately in both: it is
 * where one journey ended and the next began, and it is a real reading either
 * way.
 *
 * Pure, like every engine here. It takes fixes and thresholds and returns
 * trips; nothing about MapLibre, colours-on-screen or the DOM belongs in it.
 */
export type TripPoint = { lat: number; lng: number; at: Date };

export type Trip<P extends TripPoint = TripPoint> = {
  /** 1-based, in the order walked. This is what the colour is chosen by. */
  index: number;
  points: P[];
  startAt: Date;
  endAt: Date;
  /** The trail's own length, summed hop by hop — never start-to-end. */
  metres: number;
};

export type TripOptions = {
  gapMetres: number;
  dwellRadiusMetres: number;
  dwellMinMinutes: number;
};

/**
 * A trip has to GO somewhere.
 *
 * Two fixes is not enough on its own. Splitting at the middle of a stop —
 * which is what putting the boundary under the stop mark means — leaves the
 * second half of that standing-still on the far side of the line, and a
 * twenty-minute stop at the end of a day would otherwise finish as a "trip"
 * of four metres of GPS jitter with a colour of its own in the key.
 *
 * The floor is `dwellRadiusMetres` and deliberately not a new number: that
 * setting already IS the answer to "how much movement is still standing
 * still". Anything under it the dwell rule itself could not have told apart
 * from a stop, so nothing that reaches this test as a real journey is lost by
 * measuring it the same way.
 */
function isJourney<P extends TripPoint>(points: P[], metres: number, dwellRadiusMetres: number): boolean {
  return points.length >= 2 && metres > dwellRadiusMetres;
}

export function splitTrailIntoTrips<P extends TripPoint>(
  points: P[],
  { gapMetres, dwellRadiusMetres, dwellMinMinutes }: TripOptions,
): Trip<P>[] {
  if (points.length < 2) return [];

  /*
   * Where he stopped — and specifically, WHERE ON THE GROUND, not merely when.
   *
   * The obvious index is the run's last fix, and it is wrong by up to the
   * dwell radius. A run holds while every fix stays within `dwellRadiusMetres`
   * of the run's FIRST fix, so it does not end when he leaves the shop; it
   * ends once he has walked far enough from where he arrived. Splitting there
   * put the colour change sixty metres up the road from the circle that
   * explains it — the departure's first sixty metres were painted as part of
   * the journey that had already finished, and the boundary landed at a
   * junction with nothing marked on it. Every stop had the same offset;
   * nobody could have named the cause from the screen.
   *
   * So the boundary is the fix NEAREST THE STOP'S CENTROID, which is the exact
   * point the map draws the mark at. The colour changes under the circle, the
   * walk away from the shop belongs to the trip that walks away, and the
   * handful of metres of jitter either side of the split are both honestly
   * "at the stop".
   */
  const restEnds = new Set(
    dwellRuns(points, dwellRadiusMetres, dwellMinMinutes)
      .map((r) => {
        const centre = centroidOf(points.slice(r.startIndex, r.endIndex + 1));
        let best = r.startIndex;
        let bestMetres = Infinity;
        for (let i = r.startIndex; i <= r.endIndex; i++) {
          const m = metresBetween(centre.lat, centre.lng, points[i].lat, points[i].lng);
          if (m < bestMetres) {
            bestMetres = m;
            best = i;
          }
        }
        return best;
      })
      /* A stop whose centre is the very last thing recorded starts nothing
         after it, and one at the very beginning ends nothing before it. */
      .filter((i) => i > 0 && i < points.length - 1),
  );

  const trips: Trip<P>[] = [];
  let start = 0;

  const close = (endIndex: number, nextStart: number) => {
    const slice = points.slice(start, endIndex + 1);
    let metres = 0;
    for (let i = 1; i < slice.length; i++) {
      metres += metresBetween(slice[i - 1].lat, slice[i - 1].lng, slice[i].lat, slice[i].lng);
    }
    if (isJourney(slice, metres, dwellRadiusMetres)) {
      trips.push({
        index: trips.length + 1,
        points: slice,
        startAt: slice[0].at,
        endAt: slice[slice.length - 1].at,
        metres,
      });
    }
    start = nextStart;
  };

  for (let i = 1; i < points.length; i++) {
    const hop = metresBetween(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);

    /* A gap ends a trip and the next one starts CLEAN on the far side — the
       two ends are not a journey between each other, which is exactly what
       the dashed line already says. */
    if (hop >= gapMetres) {
      close(i - 1, i);
      continue;
    }

    /* A stop ends a trip, and the next one sets off from the same fix. */
    if (restEnds.has(i - 1)) close(i - 1, i - 1);
  }
  close(points.length - 1, points.length);

  return trips;
}

/**
 * The colours, in the order trips take them.
 *
 * Chosen to be told apart at a glance on a pale street map, and ADJACENT
 * entries are the ones furthest apart in hue — consecutive trips are the pair
 * most often crossing the same junction, so those are the two that must never
 * look alike. It cycles: a day of more than ten legs repeats a colour, which
 * is honest, because by then the sequence is doing the work rather than any
 * single colour being memorable.
 *
 * The first is the brand violet, so a day made of one journey looks exactly
 * as it always has.
 */
export const TRIP_COLOURS = [
  "#5223E0",
  "#E5341C",
  "#0E8A5F",
  "#E07B00",
  "#0B72C4",
  "#B5179E",
  "#00868C",
  "#8B5E00",
  "#C2185B",
  "#3F51B5",
] as const;

export function tripColour(index: number): string {
  return TRIP_COLOURS[(index - 1) % TRIP_COLOURS.length];
}
