import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
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
import { planDay, type Coord, type SnappedRun } from "@/lib/engines/snap-plan";
import { trackForDay } from "@/lib/services/sales-service";
import { roadPathFor, roadPathTail } from "@/lib/services/road-snap-service";
import { heldRunsFor, holdRunsFor } from "@/lib/services/snap-cache";

/**
 * The Live map's road-snapped trail, for one salesman on one day.
 *
 * Deliberately its own request rather than folded into `tracksForDay` (which
 * `page.tsx` reads for every salesman drawing the "today" view): snapping the
 * whole team would turn one page load into dozens of calls to an outside
 * service, most of them for a trail nobody has selected. This is asked once, by the client, only when a manager
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

  /* The `sales` GRANT and the `sales.live` module together, in that order —
     see `canOpenModule`. Asking `listUserModules` alone answers "every module"
     for somebody who holds none of the app. */
  if (!(await canOpenModule(user.id, "sales.live"))) {
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
   *
   * AND THE LINE GOES BACK WITH THE FIGURE, which for a long time it did not.
   * This refused the collapsed METRES and still answered with the collapsed
   * COORDINATES — so the number on the hover was the honest raw one and the
   * shape under it was the shortcut, on the same segment, disagreeing. The map
   * replaces its geometry with whatever this returns and caches it, so the
   * straight line across the blocks he actually walked survived every redraw
   * and every poll for the rest of the day. A path this route has already
   * decided it does not believe is not a path to draw: where it collapsed the
   * raw fixes are what is sent, which is exactly what the map drew before Ola
   * was asked at all.
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
  /* Kept beside each segment, in step with it, so a leg the ratio disowns can
     be given its own fixes back. The verdict is per TRIP and cannot be reached
     until the whole leg has been walked, so the raw line has to survive the
     loop that builds the road one. */
  const rawByIndex: [number, number][][] = [];

  const pieces = dayTrailSegments(accurate, {
    gapMetres,
    dwellRadiusMetres: config["mbos.location.dwellRadiusMeters"],
    tripBreakMinutes: config["mbos.location.tripBreakMinutes"],
  });

  /*
   * ONLY WHAT IS NEW IS BOUGHT, and that is the whole of this block.
   *
   * Snap-to-Road is metered — a hundred thousand requests a month, and one
   * salesman's full day is around thirty of them. Asked for the whole day on
   * every look, a team of seven watched by one manager for a couple of hours
   * exceeds a month's quota on its own, and what it buys back is a road that
   * has not changed since the last look: a day grows at ONE END. So the held
   * geometry is extended by the walking since rather than replaced, which is
   * one request instead of thirty, and it is held HERE rather than in the
   * browser so a second manager and a page reload cost nothing at all.
   *
   * `planDay` decides, per run, whether anything is owed; `snap-cache.ts`
   * argues for the store and states its invalidation, which is that every
   * held run is re-checked against the fixes that have just been read. A run
   * that no longer matches is bought again, so the cache cannot drift into
   * disagreeing with the trail — it can only fail its own check.
   */
  const minRefreshMs = config["mbos.location.snapRefreshSeconds"] * 1_000;
  const askedAtMs = Date.now();
  const held = heldRunsFor(salesmanId, day);
  const plans = planDay(
    /* A gap is never snapped, so nothing is ever held for one — and a run
       nothing is held for must not invalidate the runs after it. */
    pieces.map((piece, i) => (piece.gap ? undefined : held[i])),
    pieces.map((piece) => ({
      coordinates: piece.coordinates as Coord[],
      fromMs: piece.fromAt.getTime(),
    })),
    { nowMs: askedAtMs, minRefreshMs },
  );
  const nextHeld: (SnappedRun | undefined)[] = [];

  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    const raw = piece.coordinates;
    const trip = byIndex.get(piece.trip);
    /* `[lng, lat]` on the wire, `{lat,lng}` through the service — GeoJSON
       and Ola disagree about the order and this is where they meet. */
    const road = piece.gap ? null : await roadFor(plans[index], raw as Coord[], index);
    /* Trips are 1-based and `NO_TRIP` is 0, which `tripOffset` would stagger
       the wrong way off the line. Ground in no journey sits where it is. */
    const offset = trip ? tripOffset(piece.trip) : 0;
    const drawn = offsetPolyline(
      /* `roadFor` answers in the drawn order already — `[lng, lat]`, the same
         as the raw piece — so there is nothing to turn round here. */
      road ?? raw,
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
    rawByIndex.push(offsetPolyline(raw, offset));
  }

  holdRunsFor(salesmanId, day, nextHeld);

  /**
   * The road under one piece: reused, extended by its tail, or bought whole.
   *
   * A FAILURE NEVER COSTS THE HEAD. Where a tail cannot be bought the held
   * road is kept and the new stretch is drawn as the raw fixes it is — which
   * is exactly what the map draws for every trail whose snap has not landed —
   * and the held run is left where it was, so the next look asks again. A
   * transient hiccup must not throw away eight hours of road that arrived
   * perfectly well.
   */
  async function roadFor(
    plan: (typeof plans)[number],
    raw: Coord[],
    index: number,
  ): Promise<Coord[] | null> {
    const keep = (path: Coord[], coveredCount: number, snappedAtMs: number) => {
      nextHeld[index] = {
        fromMs: pieces[index].fromAt.getTime(),
        firstCoord: raw[0],
        coveredCount,
        seam: raw[coveredCount - 1],
        path,
        snappedAtMs,
      };
    };

    if (plan.kind === "reuse") {
      /* Unchanged in every respect, including WHEN it was bought — the refresh
         window is measured from the last time Ola was actually asked. */
      nextHeld[index] = held[index];
      return plan.path;
    }

    if (plan.kind === "hold") {
      /*
       * THE LINE IS NEVER SHORTENED to save a request. The road we hold runs
       * out at the seam and the walking since is carried as the raw fixes it
       * is, joined at the seam's snapped position — a jog of whatever Ola
       * moved that one fix by, on the newest stretch only, and gone the next
       * time the tail is bought. Two consequences worth naming: that stretch
       * is drawn as fixes rather than as road, which is what every trail
       * looks like until its snap lands anyway; and the leg's distance is
       * measured over it with the jitter still in, so a hold reads very
       * slightly long for as many seconds as `mbos.location.snapRefreshSeconds`
       * says. The held run does not advance — nothing was bought — so the
       * next look past the window asks for exactly this tail.
       */
      nextHeld[index] = held[index];
      return [...plan.path, ...plan.rawTail];
    }

    if (plan.kind === "extend") {
      const tail = await roadPathTail(
        { lat: plan.seam[1], lng: plan.seam[0] },
        plan.tail.map(([lng, lat]) => ({ lat, lng })),
      );
      if (!tail) {
        /* Ola could not improve this stretch. That is a statement about the
           stretch and not about the eight hours behind it, so the head is
           kept and the new fixes are drawn raw — the same shape a hold
           takes, and the held run stays where it is so the next look tries
           again rather than the day going unsnapped for good. */
        nextHeld[index] = held[index];
        return [...plan.head.path, ...plan.tail];
      }
      const joined: Coord[] = [
        ...plan.head.path,
        ...tail.map((p) => [p.lng, p.lat] as Coord),
      ];
      keep(joined, raw.length, askedAtMs);
      return joined;
    }

    const snapped = await roadPathFor(raw.map(([lng, lat]) => ({ lat, lng })));
    if (!snapped) return null;
    const path = snapped.map((p) => [p.lng, p.lat] as Coord);
    keep(path, raw.length, askedAtMs);
    return path;
  }

  /* Written back onto each trip's segments now the whole leg is known — and
     where the leg collapsed, the raw geometry is written back with it. One
     verdict, both halves, so the shape and the figure can never disagree
     about a leg. */
  for (const [index, roadMetres] of roadMetresByTrip) {
    const trip = byIndex.get(index);
    if (!trip) continue;
    const measurable = roadMetres > 0 && roadMetres >= trip.metres * COLLAPSED_BELOW;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].trip !== index) continue;
      if (measurable) segments[i].metres = roadMetres;
      else segments[i].coordinates = rawByIndex[i];
    }
  }

  return NextResponse.json({ segments }, NO_STORE);
}
