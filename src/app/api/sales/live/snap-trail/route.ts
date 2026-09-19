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
import {
  gapVerdict,
  joinGapPath,
  pathMetres,
  routeIsBelievable,
  type Coord,
} from "@/lib/engines/trail-gap-route";
import { roadRouteBetween } from "@/lib/services/ola-directions-service";

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
   * A run of fixes dense enough that there is nothing to invent is
   * reconstructed onto the road it was walked on — that is the boundary #251
   * drew and it still holds for everything the map calls EVIDENCE.
   *
   * A GAP IS THE OTHER THING, and it is now drawn in one of two ways rather
   * than one. A SHORT gap — inside `mbos.location.gapRouteMaxMinutes` and
   * `mbos.location.gapRouteMaxKm` — is drawn following the roads between its
   * two ends, because at this sampling density a gap of a minute or two is a
   * tunnel, a lift or a reaped tracker, and a straight line through three
   * blocks of buildings is a worse picture of that than the road is. Every
   * longer gap keeps the crow's flight it always had: real days here carry
   * single gaps of 437 and 999 minutes, and nothing should be drawn across
   * those at all.
   *
   * NEITHER IS PROMOTED TO EVIDENCE. Both stay dashed, faint and without the
   * casing that makes a line read as a route somebody took, the routed one
   * carries `inferred` so the hover can say in words that it is an estimate,
   * and neither adds a metre to the distance a salesman is measured on.
   */
  const gapMetres = config["mbos.location.trailGapMeters"];
  const gapLimits = {
    maxMinutes: config["mbos.location.gapRouteMaxMinutes"],
    maxKm: config["mbos.location.gapRouteMaxKm"],
  };
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
      ? await routedGap(raw, piece.fromAt, piece.toAt)
      : ((await roadPathFor(raw.map(([lng, lat]) => ({ lat, lng }))))?.map(
          (p) => [p.lng, p.lat] as [number, number],
        ) ?? null);
    /* Trips are 1-based and `NO_TRIP` is 0, which `tripOffset` would stagger
       the wrong way off the line. Ground in no journey sits where it is. */
    const offset = trip ? tripOffset(piece.trip) : 0;
    const drawn = offsetPolyline(road ?? raw, offset);
    const inferred = piece.gap && road !== null;

    /*
     * A GAP CONTRIBUTES ITS STRAIGHT LINE, and that does not change because
     * the map now draws a road across it.
     *
     * Nobody knows the road taken. Following one is a better PICTURE of a
     * short dropout than a line through three blocks of buildings, and it is
     * not better EVIDENCE — so what a salesman is measured on stays what it
     * always was, the crow's flight between two real fixes. Measuring `drawn`
     * here would have quietly added every routed detour to a day's distance,
     * which on a beat with a dozen small dropouts is a figure that grows
     * because the map got prettier.
     */
    const measured = inferred ? offsetPolyline(raw, offset) : drawn;
    if (trip) {
      let metres = 0;
      for (let i = 1; i < measured.length; i++) {
        metres += metresBetween(
          measured[i - 1][1],
          measured[i - 1][0],
          measured[i][1],
          measured[i][0],
        );
      }
      roadMetresByTrip.set(piece.trip, (roadMetresByTrip.get(piece.trip) ?? 0) + metres);
    }

    segments.push({
      gap: piece.gap,
      /*
       * WHICH DASHED LINES ARE A GUESS AT A ROAD, and which are no guess at
       * all. Both stay dashed and faint — a routed gap is never promoted to
       * the solid, cased treatment that says somebody was seen here — but the
       * two are not the same claim, and the hover says which in words.
       */
      inferred,
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

  /**
   * The road across a gap, or null for the straight line the map always drew.
   *
   * A GAP IS A STRETCH WITH NO FIXES IN IT, and this is the one place in the
   * request that asks an outside service to say what happened there. Whether
   * it may ask at all is `gapVerdict` — two configured ceilings, one on the
   * silence and one on the span, both of which have to hold — and whether the
   * answer is worth drawing is `routeIsBelievable`, measured on the geometry
   * that will actually be drawn rather than on a distance field beside it.
   *
   * Only the gap's TWO ENDS are sent. There is nothing in between to send;
   * that is what makes it a gap, and it is also what makes this cheap and
   * cacheable — a pair of endpoints is one question with one answer, and the
   * same pair recurs every morning of the week.
   *
   * Null at every refusal, exactly as `roadPathFor` is null at every failure.
   * The caller's fallback is identical in both cases and is the behaviour this
   * map shipped with.
   */
  async function routedGap(
    raw: [number, number][],
    fromAt: Date,
    toAt: Date,
  ): Promise<Coord[] | null> {
    if (raw.length < 2) return null;

    /*
     * HOP BY HOP, because a gap piece is not always one hop. `dayTrailSegments`
     * merges consecutive pairs that share a flag and a trip, so a handset that
     * woke for a single fix in the middle of a long silence produces ONE gap
     * piece with a REAL FIX inside it. Routing that end to end would draw a
     * road straight over the one reading anybody actually has, which is the
     * exact inversion of the rule this whole file is written around.
     *
     * The clock is shared out evenly across the hops: the piece carries two
     * timestamps and nothing finer, and a merged gap is a rare shape. Sharing
     * it out is not exact, and it errs the only safe way — each hop is judged
     * as SHORTER than the whole piece only in proportion to how many there
     * are, so a merged piece can never route a hop the whole piece would have
     * been refused for.
     */
    const hops = raw.length - 1;
    const perHopMs = Math.max(0, toAt.getTime() - fromAt.getTime()) / hops;

    const out: Coord[] = [raw[0]];
    let any = false;

    for (let i = 1; i < raw.length; i++) {
      const from = { lat: raw[i - 1][1], lng: raw[i - 1][0] };
      const to = { lat: raw[i][1], lng: raw[i][0] };
      const verdict = gapVerdict({ from, to, fromMs: 0, toMs: perHopMs }, gapLimits);
      const route = verdict.route ? await roadRouteBetween(from, to) : null;
      const believable =
        route !== null &&
        verdict.route &&
        routeIsBelievable(verdict.straightMetres, pathMetres(route.path), gapLimits);

      if (route && believable) {
        /* `joinGapPath` pins both ends to the real fixes, so dropping its
           first point joins this hop to the one before at a point they agree
           on rather than butting two copies of it together. */
        out.push(...joinGapPath(from, to, route.path).slice(1));
        any = true;
      } else {
        /* Refused, or Ola said nothing: this hop keeps the honest straight
           line, in the middle of a piece whose other hops may not have. */
        out.push(raw[i]);
      }
    }

    return any ? out : null;
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
