import { metresBetween } from "../geo";
import { dwellRuns } from "./dwell";

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
 * A trip of one point is not a journey.
 *
 * Standing still through two consecutive dwells, or a single stray fix
 * between two gaps, would otherwise become a "trip" with no line to draw and
 * a colour in the key that points at nothing.
 */
function isJourney<P extends TripPoint>(points: P[]): boolean {
  return points.length >= 2;
}

export function splitTrailIntoTrips<P extends TripPoint>(
  points: P[],
  { gapMetres, dwellRadiusMetres, dwellMinMinutes }: TripOptions,
): Trip<P>[] {
  if (points.length < 2) return [];

  /* Where he stopped. `endIndex` is the last fix of the stop, which is the
     fix the NEXT trip starts from — he set off from where he was standing. */
  const restEnds = new Set(
    dwellRuns(points, dwellRadiusMetres, dwellMinMinutes)
      .map((r) => r.endIndex)
      /* A stop that runs to the end of the day starts nothing after it. */
      .filter((i) => i < points.length - 1),
  );

  const trips: Trip<P>[] = [];
  let start = 0;

  const close = (endIndex: number, nextStart: number) => {
    const slice = points.slice(start, endIndex + 1);
    if (isJourney(slice)) {
      let metres = 0;
      for (let i = 1; i < slice.length; i++) {
        metres += metresBetween(slice[i - 1].lat, slice[i - 1].lng, slice[i].lat, slice[i].lng);
      }
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
