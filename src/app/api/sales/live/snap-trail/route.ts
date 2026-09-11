import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { dropInaccurateFixes } from "@/lib/engines/trail-gaps";
import { metresBetween } from "@/lib/geo";
import {
  dayTrailSegments,
  NO_TRIP_COLOUR,
  offsetPolyline,
  splitTrailIntoTrips,
  tripColour,
  tripOffset,
} from "@/lib/engines/trail-trips";
import { trackForDay } from "@/lib/services/sales-service";
import { roadPathFor } from "@/lib/services/road-snap-service";

/**
 * The Live map's road-snapped trail, for one salesman on one day.
 *
 * Deliberately its own request rather than folded into `tracksForDay` (which
 * `page.tsx` reads for every salesman on every thirty-second poll of the
 * "today" view): snapping the whole team on every poll would turn one page
 * load into dozens of calls to an outside service, most of them for a trail
 * nobody has selected. This is asked once, by the client, only when a manager
 * picks a name — see `street-map.tsx`.
 *
 * A 401 or a 403 answers exactly like a missing trail: `{ points: null }`.
 * There is nothing here worth telling an attacker the shape of.
 *
 * **Explicitly dynamic, and explicitly `no-store`.** The client's own cache is
 * keyed on `salesmanId` and `day` and never asks twice for a name already
 * answered — which means whatever this route answers the FIRST time is what a
 * manager is stuck looking at for the rest of the day, with no natural retry.
 * A transient Ola Maps hiccup, an inaccurate fix dropping the count under two,
 * or the day still being written to are all real, ordinary reasons this can
 * legitimately return `null` on one call and real points on the next — and
 * Next.js caching a GET route handler's response by default is exactly the
 * kind of thing that would silently freeze whichever answer arrived first.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ points: null }, { status: 401, ...NO_STORE });

  const modules = await listUserModules(user.id, "sales");
  if (!modules.some((m) => m.key === "sales.live")) {
    return NextResponse.json({ points: null }, { status: 403, ...NO_STORE });
  }

  const params = new URL(request.url).searchParams;
  const salesmanId = params.get("salesmanId");
  const day = params.get("day");
  if (!salesmanId || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ points: null }, { status: 400, ...NO_STORE });
  }

  // Scoped inside `trackForDay` itself — a manager outside this salesman's
  // territory gets an empty day, not somebody else's trail.
  const track = await trackForDay(salesmanId, day);
  // A fix the handset itself rated as imprecise is dropped before it ever
  // reaches Snap-to-Road — see `dropInaccurateFixes`. Handing it a wildly
  // imprecise fix would have it snap that point onto whatever road happens
  // to be nearest, which is exactly the kind of invented precision the road
  // snap must never produce.
  const config = await getConfig();
  const accurate = dropInaccurateFixes(track, config["mbos.location.gpsAccuracyThresholdM"]);

  /*
   * THE WHOLE LINE IS BUILT HERE, not just a list of moved points.
   *
   * It used to answer with one snapped point per fix and leave the client to
   * cut it into trips and gaps again — which meant the client had to pair the
   * answer back up with the raw fixes to recover their times, one for one, and
   * a road-FOLLOWING path can never be one for one: it has as many points as
   * the road has corners. Doing it here keeps the timestamps where they
   * already are, so trips and gaps are decided from the real fixes and only
   * the drawing is road-matched.
   *
   * A gap keeps the raw straight line between its two ends. That is the
   * boundary #251 drew and it is kept exactly: the road is reconstructed only
   * inside a run of fixes dense enough that there is nothing to invent.
   */
  const gapMetres = config["mbos.location.trailGapMeters"];
  const trips = splitTrailIntoTrips(accurate, {
    gapMetres,
    dwellRadiusMetres: config["mbos.location.dwellRadiusMeters"],
    tripBreakMinutes: config["mbos.location.tripBreakMinutes"],
  });

  /*
   * DISTANCE IS MEASURED ON THE ROAD, not on the fixes.
   *
   * Summing the hops between raw fixes counts every metre of GPS jitter, and
   * at three-second sampling that is most of them: a leg Google Maps calls
   * 750 m came back as 1.1 km, and the figure on the hover was wrong by half
   * on every walk. The road-matched path has the jitter taken out of it by
   * construction — it is the road, and its length is the length of the road.
   *
   * Where the path COLLAPSED it is not measured. Twenty-metre anchors are kept
   * by DISPLACEMENT from the last one, so somebody who milled about in one spot
   * for an hour leaves two or three of them however far he actually walked —
   * and the road drawn through those is a shortcut, not his afternoon. One leg
   * of 391 m came back as 35 m that way.
   *
   * The tell is the RATIO. A real walk loses roughly a third to a half of its
   * raw length when the jitter comes out — the two legs measured against Google
   * Maps here came back at 65% and 41% of raw. A tenth is not jitter being
   * removed, it is a leg that was never followed. Below a quarter the raw
   * figure stands: inflated, and still the better of two wrong answers, because
   * it at least reflects that he moved about.
   */
  const COLLAPSED_BELOW = 0.25;

  /*
   * EVERY PIECE OF THE DAY, not only the journeys in it.
   *
   * This walked `trips` and pushed a segment per piece of each, which is the
   * same hole the map itself had: a hop of `gapMetres` or more belongs to no
   * trip, and what is left between such hops is standing still, which is not
   * a journey either. On a real day — 95 fixes, 4.07 km, four hops carrying
   * 3.85 km of it because the handset slept between stops — `trips` held one
   * leg of 71 metres, so that is what this answered and that is what the map
   * drew. Worse than the client's own copy of the bug, because the client
   * REPLACES its geometry with whatever this returns: fixing the map alone
   * changed nothing on screen.
   *
   * `dayTrailSegments` covers every consecutive pair exactly once. Which
   * pieces reach Ola is unchanged — only a solid run inside a trip is
   * road-matched, a gap keeps its straight line — so this costs no extra call.
   */
  const byIndex = new Map(trips.map((t) => [t.index, t] as const));
  const segments = [];
  const roadMetresByTrip = new Map<number, number>();

  for (const piece of dayTrailSegments(accurate, {
    gapMetres,
    dwellRadiusMetres: config["mbos.location.dwellRadiusMeters"],
    tripBreakMinutes: config["mbos.location.tripBreakMinutes"],
  })) {
    const raw = piece.coordinates;
    const trip = byIndex.get(piece.trip);
    /* `[lng, lat]` on the wire, `{lat,lng}` through the service — GeoJSON
       and Ola disagree about the order and this is where they meet. */
    const road = piece.gap
      ? null
      : await roadPathFor(raw.map(([lng, lat]) => ({ lat, lng })));
    /* Trips are 1-based and `NO_TRIP` is 0, which `tripOffset` would stagger
       the wrong way off the line. Ground in no journey sits where it is. */
    const offset = trip ? tripOffset(piece.trip) : 0;
    const drawn = offsetPolyline(
      road ? (road.map((p) => [p.lng, p.lat]) as [number, number][]) : raw,
      offset,
    );

    /* A gap contributes its straight line — nobody knows the road taken, and
       pretending it was longer than the crow flies would be an invention. */
    if (trip) {
      let metres = 0;
      for (let i = 1; i < drawn.length; i++) {
        metres += metresBetween(drawn[i - 1][1], drawn[i - 1][0], drawn[i][1], drawn[i][0]);
      }
      roadMetresByTrip.set(piece.trip, (roadMetresByTrip.get(piece.trip) ?? 0) + metres);
    }

    segments.push({
      gap: piece.gap,
      trip: piece.trip,
      colour: trip ? tripColour(piece.trip) : NO_TRIP_COLOUR,
      offset,
      /* A piece in no journey has no leg to answer for, so it carries its own
         two ends and no distance — a hop nobody recorded a path for has no
         honest length to quote. */
      metres: trip ? trip.metres : 0,
      fromMs: (trip ? trip.startAt : piece.fromAt).getTime(),
      toMs: (trip ? trip.endAt : piece.toAt).getTime(),
      /* Nudged into its lane in the geometry rather than by the renderer —
         see `offsetPolyline` for why `line-offset` breaks at exactly the
         corners somebody is trying to follow. */
      coordinates: drawn,
    });
  }

  /* Written back onto each trip's segments now the whole leg is known. */
  for (const [index, roadMetres] of roadMetresByTrip) {
    const trip = byIndex.get(index);
    if (!trip) continue;
    const measurable = roadMetres >= trip.metres * COLLAPSED_BELOW;
    if (measurable && roadMetres > 0) {
      for (const seg of segments) if (seg.trip === index) seg.metres = roadMetres;
    }
  }

  return NextResponse.json({ segments }, NO_STORE);
}
