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
  /**
   * How long somebody has to be still before the colour changes.
   *
   * Deliberately NOT `dwellMinMinutes`, which is the threshold for putting a
   * mark on the map. Every pause worth marking is not a new journey: a day
   * spent in one market has a stop at every counter, and colouring each of
   * them as its own leg turns a morning into a rainbow that answers nothing.
   */
  tripBreakMinutes: number;
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

/**
 * ONE STOP THAT WANDERED IS ONE STOP.
 *
 * `dwellRuns` anchors each run on its FIRST fix and closes it the moment
 * anything strays past the radius — so somebody standing outside a shop for a
 * quarter of an hour, drifting sixty metres across a forecourt in the middle
 * of it, comes back as two stops three seconds apart rather than one. Each of
 * those produced its own colour change, and the "leg" between them was six
 * minutes of a man who had not gone anywhere.
 *
 * So runs are joined back up before anything is measured: consecutive runs
 * with no real travelling between them are the same rest, however many times
 * the anchor was reset inside it. Only then is the length asked about, and
 * only a rest longer than `tripBreakMinutes` ends a leg.
 *
 * `SETTLING_SECONDS` is what "no real travelling" means — a few seconds of
 * walking across a yard, not a trip to another street. It is small and fixed
 * rather than configurable because it is a property of how `dwellRuns` cuts,
 * not a decision anybody would want to make differently.
 */
const SETTLING_SECONDS = 90;

function mergeAdjacentRests<P extends TripPoint>(
  runs: { startIndex: number; endIndex: number; minutes: number }[],
  points: P[],
  tripBreakMinutes: number,
): { startIndex: number; endIndex: number; minutes: number }[] {
  const merged: { startIndex: number; endIndex: number; minutes: number }[] = [];

  for (const run of runs) {
    const last = merged[merged.length - 1];
    const apart = last
      ? (points[run.startIndex].at.getTime() - points[last.endIndex].at.getTime()) / 1000
      : Infinity;

    if (last && apart <= SETTLING_SECONDS) {
      last.endIndex = run.endIndex;
      last.minutes =
        (points[last.endIndex].at.getTime() - points[last.startIndex].at.getTime()) / 60_000;
      continue;
    }
    merged.push({ ...run });
  }

  return merged.filter((r) => r.minutes >= tripBreakMinutes);
}

export function splitTrailIntoTrips<P extends TripPoint>(
  points: P[],
  { gapMetres, dwellRadiusMetres, tripBreakMinutes }: TripOptions,
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
    mergeAdjacentRests(
      /* Runs shorter than this are not rests at all — they are the ordinary
         cadence of walking, where the anchor resets every few strides. Merging
         those would join an entire journey into one enormous "stop". */
      dwellRuns(points, dwellRadiusMetres, SETTLING_SECONDS / 60),
      points,
      tripBreakMinutes,
    )
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

/**
 * How far a leg is nudged sideways from the centre of the road, in METRES.
 *
 * TWO PASSES DOWN ONE STREET ARE ONE LINE, and that is a real loss: walking
 * out and back is drawn as a single stroke, so the turn at the far end is
 * invisible and a road worked twice looks like a road worked once. Colour
 * cannot fix it — the second line is exactly under the first, and only its
 * ends show.
 *
 * `offsetPolyline` moves each point to the RIGHT OF TRAVEL, so one constant
 * offset does the whole of the out-and-back case for free — the return leg is
 * travelling the other way, so its right is the other side of the road, and
 * the two passes separate into lanes exactly as traffic does. It reads the way
 * somebody already understands a road.
 *
 * The stagger on top is for the case lanes cannot answer: two legs down the
 * same street in the SAME direction, which sit on the same side. Three
 * positions is enough — a fourth pass down one street in one direction is
 * rare, and by then the colours are doing the work.
 */
/*
 * JUST ENOUGH THAT TWO LINES TOUCH RATHER THAN MERGE.
 *
 * This started at 3.5 m plus 3 m a step, which put the third leg nine and a
 * half metres from the centreline — off the carriageway and along the
 * buildings, undoing the road-matching it was drawn on top of. Narrowing it
 * to 1.8 + 1.2 fixed the road but was still visible as a line running beside
 * its street rather than down it.
 *
 * The measure that settled it: feeding each drawn line back to Snap-to-Road
 * and asking how far it is from a road. The answer came back as exactly these
 * constants — 1.8, 3.0, 4.2 — which is the proof that the geometry was never
 * off-road at all and every metre of the gap was this.
 *
 * So it is a hair now. The separation between two passes is TWICE the base,
 * which at the zoom somebody reads a junction at is about the width of the
 * line itself: they sit against each other rather than on top of each other,
 * which is all that was ever needed to see there were two. Anything more is
 * a route drawn next to its road.
 */
const LANE_METRES = 1.1;
const STAGGER_METRES = 0.7;

export function tripOffset(index: number): number {
  return LANE_METRES + ((index - 1) % 3) * STAGGER_METRES;
}

export function tripColour(index: number): string {
  return TRIP_COLOURS[(index - 1) % TRIP_COLOURS.length];
}

/**
 * The same line, moved sideways by a few metres.
 *
 * MapLibre has `line-offset` and it is the obvious way to do this. It offsets
 * each SEGMENT and then tries to join them, and at the ninety-degree corners a
 * street grid is made of the joins come apart — the line arrives at the turn,
 * stops, and starts again a few pixels away, so a route reads as broken at
 * exactly the corners somebody is trying to follow. It is the renderer's
 * problem and there is no setting that fixes it.
 *
 * Offsetting the COORDINATES has no such seam: what comes out is an ordinary
 * polyline, and the corner is a corner like any other, drawn with the same
 * round join as the rest of the line.
 *
 * Each point moves perpendicular to the direction through it — the average of
 * the way in and the way out, so a corner mitres rather than stepping — and to
 * the RIGHT of travel, which is what makes an out-and-back separate into two
 * lanes without anything having to notice it doubled back.
 *
 * In METRES rather than pixels, which is the other reason to do it here: a
 * lane is a real width on the ground, so it stays the same width of road at
 * every zoom instead of swelling into a smear as you go out.
 */
export function offsetPolyline(
  coordinates: [number, number][],
  metres: number,
): [number, number][] {
  if (coordinates.length < 2 || metres === 0) return coordinates;

  return coordinates.map(([lng, lat], i) => {
    const before = coordinates[Math.max(0, i - 1)];
    const after = coordinates[Math.min(coordinates.length - 1, i + 1)];

    /* The direction through this point, in metres rather than degrees, so the
       perpendicular is square on the ground and not stretched by latitude. */
    const cos = Math.cos((lat * Math.PI) / 180);
    const dx = (after[0] - before[0]) * cos;
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) return [lng, lat];

    /* Right of travel: rotate the heading by -90 degrees. */
    const px = dy / length;
    const py = -dx / length;

    const dLat = (metres * py) / 111_320;
    const dLng = (metres * px) / (111_320 * (cos || 1));
    return [lng + dLng, lat + dLat];
  });
}
