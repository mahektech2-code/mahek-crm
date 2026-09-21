"use client";

import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { DwellStop } from "@/lib/engines/dwell";
import { type TrailSegment } from "@/lib/engines/trail-gaps";
import {
  dayTrailSegments,
  NO_TRIP_COLOUR,
  offsetPolyline,
  splitTrailIntoTrips,
  tripColour,
  tripOffset,
} from "@/lib/engines/trail-trips";
import { clock, clockSeconds } from "@/lib/format";
import { departedTrailIds, trailLayerIds, trailSourceId } from "@/lib/map-layers";
import { formatDistance } from "@/lib/geo";
import type { ActivityPoint, LastKnown, ShopPin, TrackPoint } from "@/lib/services/sales-service";
import { activityLabel } from "@/lib/mbos/activity-labels";
import { accountTypeLabel } from "@/lib/account-types";
import { markMs, numberVisits, otherMarks } from "@/lib/engines/visit-marks";
import { VISIT_OUTCOME_LABEL, label as wordFor } from "@/components/console/words";
import {
  OlaMapsStyleSwitcher,
  olaMapsStyle,
  olaMapsStyleUrl,
  olaMapsTransformRequest,
  type OlaMapsStyleMode,
} from "../ola-maps";
import {
  BOOK_PIN_COLOUR,
  BOOK_PIN_LABEL,
  addBookPinLayers,
  bookPinFeatures,
  countByTone,
  setBookPinsVisible,
  type BookPinTone,
} from "../book-pins";
import { CustomerQuickView } from "@/components/console/customer-quick-view";

/**
 * The map, with streets under it.
 *
 * It used to be pins on a bare grid, then OpenFreeMap — a supplier needing no
 * key, no account and no bill. This is Ola Maps now, and the reason to give
 * up "no key" is that the Live map already has one, for Snap-to-Road (see
 * the trail-snapping effect below): once a key exists anyway, running two
 * tile suppliers is two things to keep coverage and reliability current on,
 * for one screen.
 *
 * **The key has to reach the browser, and that is a real exception.** Every
 * other credential in `app_secrets` is read once, server-side, by the
 * request about to spend it, and never otherwise leaves the server — that is
 * the whole design of `readSecret`. A map tile key cannot follow that rule:
 * the BROWSER is what asks a tile server for squares of map, hundreds of
 * times over a session, so the key has to be readable there. That is true of
 * every tile provider — Mapbox, Google, Ola — and the standard mitigation is
 * the same one used elsewhere: restrict the key to this app's own domain in
 * the provider's own console, so a copied key is useless anywhere else. The
 * key is handed down as a plain prop from `page.tsx`'s one `readSecret` call
 * for this reason and no other — nothing downstream of this component ever
 * asks for it again.
 *
 * **THE PINS THEMSELVES STILL NEVER LEAVE MAHEKONE.** A tile server is asked
 * for squares of map — roughly which part of India is being looked at — and
 * that is a real signal, since the viewport centres on the team. It is not
 * the team's coordinates: those are drawn here, from MahekOne's own data,
 * and are never part of a tile request.
 *
 * **The renderer is MapLibre and the supplier is a URL.** That is deliberate:
 * if Ola Maps' coverage of a beat turns out to be thin, or the service
 * changes terms, `../ola-maps.tsx`'s style URLs and `transformRequest` are
 * the only things that change — shared with Territory's `shop-map.tsx`, the
 * other screen with an Ola Maps instance, so the two cannot drift into two
 * different authentication mechanisms. Pulling in a supplier's own SDK would
 * have made moving a rewrite instead of an edit — and that `transformRequest`
 * shape is exactly what Ola Maps' own web SDK does internally, so this is not
 * a workaround, it is the documented mechanism read out of their source.
 *
 * **Without a key, there is no map — said plainly, not drawn broken.** Every
 * request the tile source makes would 401 the moment there is no key to
 * attach, so this component does not attempt one: `apiKey` gates the whole
 * build, and its absence gets its own state below, pointing at Admin Console
 * → Platform → Maps rather than a screen full of missing tiles.
 *
 * **The bare-grid rules survive both changes of supplier.** A pin is drawn
 * only where there is a fix — nobody is placed by arithmetic, and somebody
 * with no position is in the team list saying so and nowhere on this map.
 * The view fits the data rather than filling the canvas.
 *
 * **A line says where; hovering a point says exactly when.** Direction arrows
 * tiled along the line were tried and dropped — a raw GPS fix wobbles a metre
 * or two off the true path even on a dead-straight walk, and packing enough
 * arrows to read as "a flow" meant placing one on nearly every wobble, which
 * read as noise rather than direction. A dot at every real fix, hovered
 * rather than decorated, tells the truer story: `clockSeconds` on hover
 * answers "when were you exactly here" from the fix's own timestamp, which
 * is evidence rather than an inferred bearing. `trail-points` is one shared
 * source and layer for every trail on screen, the same pattern `activity`
 * and `dwells` already use, so the hover handler is registered once rather
 * than once per salesman shown.
 *
 * **A stop is drawn differently from a stop-by-work.** `dwells` marks a run
 * of fixes that never drifted for long enough to mean something — see
 * `lib/engines/dwell.ts` — with a hollow ring rather than the solid "activity"
 * dot, because "paused here" and "did something here" are different answers
 * and a manager should not have to click both to tell them apart.
 *
 * **A solid line is evidence; a dashed one is a gap.** Two fixes far enough
 * apart — see `lib/engines/trail-gaps.ts` and `gapMetres` — mean nobody knows
 * which road was actually taken between them, most often a stretch driven
 * rather than walked, or a dropped signal. Drawing that stretch the same as a
 * densely-sampled one is how a manager ends up certain about a road that was
 * never confirmed; the dashed line says plainly that this part is a straight
 * line between two real points and nothing more.
 *
 * **THE SHOPS AROUND THE TEAM ARE DRAWN UNDER THE DAY.** A trail over blank
 * streets answers where somebody went and not the question a manager is
 * actually asking, which is what he went PAST: eleven shops in that lane,
 * four of them leads nobody has been to this quarter, and a line running
 * straight through the middle of them. Customers, leads and third-party
 * shops apart by colour — `../book-pins.tsx` holds the colours and the
 * layers, shared with Territory's map so the two cannot disagree about what
 * colour a lead is.
 *
 * **A CATCHMENT, not the book.** Everything within
 * `mbos.location.nearbyBookRadiusKm` of where each man actually is. The
 * whole book at national scale is a wash of dots that answers nothing, and
 * Territory is the screen for reading it — this one is about a day. Which
 * also means the count is small enough to draw honestly: no clustering, so
 * zooming out still shows every shop rather than a bubble reading 240, and
 * a bubble cannot be walked past.
 *
 * It is fetched by the CLIENT from `/api/sales/book-pins` rather than handed
 * down as a prop — see that route for why: this page re-runs its Server
 * Component every thirty seconds, and the shops do not move. It is asked
 * again only when the team has moved far enough for the catchment to mean
 * somewhere else.
 *
 * **It is deliberately NOT part of the fit.** `fitBounds` covers the day's
 * travel; letting the backdrop move the camera would zoom a day out to fit a
 * shop at the edge of the catchment, which is a version of a bug this file
 * already carries a long comment about.
 *
 * **Map and satellite are the same map, not two.** `setStyle` swaps the
 * style JSON in place rather than tearing the map down — the camera,
 * markers and event handlers are untouched, only the trail and activity
 * layers need re-drawing, because a style change wipes anything the STYLE
 * carried rather than the map object. `drawOverlays` runs off `style.load`
 * for exactly that reason: it fires on the first load and every switch
 * after it, so one function draws the same thing every time rather than the
 * initial build and a later switch drifting into two slightly different
 * pictures.
 */

/** Enough that a single pin does not open zoomed to the rooftop. */
const MAX_FIT_ZOOM = 15;

/**
 * HOW OFTEN A GROWING TRAIL IS ROAD-MATCHED AGAIN.
 *
 * The page polls every thirty seconds (see `live-panel.tsx`), and asking Ola
 * to re-match every trail on every one of those is the cost the snap was
 * gated behind a selection to avoid in the first place. Asking NEVER is the
 * other failure and the one this was: a trail snapped at ten past nine is the
 * line still on screen at one o'clock, because the snapped geometry is
 * preferred over the raw fixes and nothing ever replaced it.
 *
 * So a trail is re-matched only once it has actually grown AND only this often
 * — a few requests an hour per salesman rather than a few a minute. It is a
 * request cadence and not a business rule, which is why it is here rather than
 * in `lib/config/registry.ts`: nobody in the office has an opinion about it,
 * and the number it has to be balanced against is the poll above it.
 */
const SNAP_REFRESH_MS = 120_000;

/** "12 min", or "1h 5m" once a stop runs past the hour. */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * A trail's segments, as one GeoJSON source — dense runs and gaps alike, each
 * carrying which it is so `trail-${id}` and `trail-gap-${id}` can each filter
 * to their own half without needing two sources for one line.
 */
type TripSegment = TrailSegment & {
  trip: number;
  colour: string;
  /**
   * A dashed stretch whose ROAD was guessed rather than recorded.
   *
   * Only ever true on a gap, and only where the gap was short enough that the
   * server was willing to ask — see `lib/engines/trail-gap-route.ts`. It
   * changes nothing about the weight of the line, deliberately: a guess must
   * never be promoted to the solid, cased treatment that says somebody was
   * seen here. What it changes is the DASH and the WORDS, so a manager
   * pointing at a dashed line that follows a road is told it follows a road
   * Ola picked rather than one anybody was seen on.
   *
   * Absent on the client's own first draw, which is the honest default: the
   * browser has no key and asks nobody, so nothing it draws is ever inferred.
   */
  inferred?: boolean;
  /** Pixels to the right of travel — see `tripOffset`. */
  offset: number;
  /** The whole trip's figures, repeated on each of its segments — see `tripSegments`. */
  metres: number;
  fromMs: number;
  toMs: number;
};

/**
 * A day's line, cut into its journeys and coloured by which one.
 *
 * One colour for a whole day drew a road he walked three times as a single
 * line, and threw away the only thing a manager wanted from it — the order.
 * `splitTrailIntoTrips` cuts the day at the rests and the gaps it already
 * knows about, and each leg carries its own colour from there.
 *
 * The gap split still runs INSIDE each trip rather than instead of it: a trip
 * can contain a stretch nobody recorded, and that stretch is still dashed. So
 * the two facts stay independent — the colour says which journey, the dash
 * says how much of it is evidence.
 */
function tripSegments(
  /* Only what a trip is decided from — so the raw trail and the snapped one,
     which carries no accuracy or place, both go through the same function. */
  points: { lat: number; lng: number; at: Date }[],
  gapMetres: number,
  dwellRadiusMetres: number,
  tripBreakMinutes: number,
): TripSegment[] {
  const options = { gapMetres, dwellRadiusMetres, tripBreakMinutes };
  /* Every consecutive pair, exactly once — see `dayTrailSegments`. This used
     to draw the TRIPS alone, which is a different question to "what happened
     today": a day made mostly of long jumps between places somebody stood
     still came out as 71 metres of line beside a panel reading 4.1 km. */
  const trips = new Map(
    splitTrailIntoTrips(points, options).map((t) => [t.index, t] as const),
  );
  return dayTrailSegments(points, options).map((s) => {
    const trip = trips.get(s.trip);
    /* TRIPS ARE 1-BASED, and `dayTrailSegments` uses 0 for ground that belongs
       to no journey. Both helpers compute `(index - 1) % n`, so a 0 asks for
       `TRIP_COLOURS[-1]` — undefined, straight into a MapLibre paint property
       — and an offset staggered the wrong way off the line. A day of nothing
       but jumps between places somebody stood still is ALL trip 0, so this is
       the ordinary case on exactly the day this was built for, not an edge. */
    const offset = trip ? tripOffset(s.trip) : 0;
    return {
      coordinates: offsetPolyline(s.coordinates, offset),
      gap: s.gap,
      trip: s.trip,
      colour: trip ? tripColour(s.trip) : NO_TRIP_COLOUR,
      offset,
      /* The WHOLE trip's length on every segment of it, so a hover anywhere
         along the leg answers for the leg rather than for the piece of it
         under the cursor — which is what somebody pointing at a line is
         asking. GeoJSON carries no Date, so the two ends are milliseconds.
         A segment belonging to no journey has no leg to answer for, so it
         carries its own two ends and no distance — a hop nobody recorded a
         path for has no honest length to quote. */
      metres: trip ? trip.metres : 0,
      fromMs: (trip ? trip.startAt : s.fromAt).getTime(),
      toMs: (trip ? trip.endAt : s.toAt).getTime(),
    };
  });
}

function trailFeatureCollection(segments: TripSegment[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: segments.map((s) => ({
      type: "Feature",
      properties: {
        gap: s.gap,
        /* `?? false` rather than left undefined: a MapLibre filter comparing
           against a property that is not there is a different question to one
           comparing against false, and the two gap layers split on it. */
        inferred: s.inferred ?? false,
        trip: s.trip,
        colour: s.colour,
        offset: s.offset,
        metres: s.metres,
        fromMs: s.fromMs,
        toMs: s.toMs,
      },
      geometry: { type: "LineString", coordinates: s.coordinates },
    })),
  };
}

/**
 * How a trail is painted, given whichever trip the cursor is over.
 *
 * Nothing is hidden when one leg is picked out — the rest drop to a quarter
 * opacity rather than disappearing, because the answer to "which of these
 * lines is the 5pm one" is only useful while you can still see what it is
 * being distinguished FROM. `null` is the resting state and paints every trip
 * alike.
 */
/**
 * How wide a route is drawn, at the zoom it is being read at.
 *
 * A fixed pixel width is a different road at every zoom: four pixels is a
 * confident line over a street plan and a thread over a city. `interpolate`
 * ties it to the scale, so a beat looks like a route whether somebody is
 * reading one junction or a whole district.
 *
 * `base` is an EXPRESSION as readily as a number, and that is the whole point
 * of its shape. MapLibre allows exactly ONE zoom-based `interpolate` per
 * expression, so the hover states cannot be written the obvious way —
 * `["case", hovered, widthByZoom(6), widthByZoom(3)]` is two of them and the
 * map refuses the whole paint property, leaving the line at whatever it was.
 * Turning it inside out — one interpolate, with the case as its OUTPUT —
 * says the same thing and is legal.
 */
function widthByZoom(
  base: number | maplibregl.ExpressionSpecification,
): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    11,
    ["*", base, 0.6],
    14,
    base,
    18,
    ["*", base, 1.6],
  ] as unknown as maplibregl.ExpressionSpecification;
}

/** Pick between two widths by whether this feature is the hovered trip. */
function byHover(
  hovered: number,
  whenHovered: number,
  otherwise: number,
): maplibregl.ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "trip"], hovered],
    whenHovered,
    otherwise,
  ] as unknown as maplibregl.ExpressionSpecification;
}

function trailPaint(hovered: number | null) {
  return {
    colour: ["get", "colour"] as unknown as maplibregl.ExpressionSpecification,
    /* Nearly solid. It was three-quarters, which let the street plan show
       through the route and left every colour looking like a wash of the one
       underneath rather than its own. A route is the subject of this screen;
       the map is the context. Opacity carries no zoom interpolate, so the
       plain `case` is fine here — only the widths had to be turned inside
       out. */
    opacity:
      hovered === null
        ? 0.95
        : ([
            "case",
            ["==", ["get", "trip"], hovered],
            1,
            0.2,
          ] as unknown as maplibregl.ExpressionSpecification),
    width: hovered === null ? widthByZoom(4) : widthByZoom(byHover(hovered, 6, 3)),
    /* THE CASING — a white line under the coloured one, a couple of pixels
       proud of it either side.

       It is the whole difference between a route drawn ON a map and one drawn
       OVER it. Without it the line shares its edges with every road it runs
       along and every label it crosses, and the eye has to separate them by
       hue alone; with it the route carries its own border everywhere and
       reads as a single object at a glance. */
    casingWidth:
      hovered === null ? widthByZoom(7) : widthByZoom(byHover(hovered, 9.5, 5.5)),
    casingOpacity:
      hovered === null
        ? 0.9
        : ([
            "case",
            ["==", ["get", "trip"], hovered],
            0.95,
            0.15,
          ] as unknown as maplibregl.ExpressionSpecification),
  };
}

/**
 * Every real fix, across every trail on screen, as one point per hop.
 *
 * One shared source for all of them — the same choice `activity` and
 * `dwells` already made — rather than a per-salesman source and layer,
 * because a per-salesman layer id cannot be hovered by a handler registered
 * once outside `drawOverlays`: the id only exists once that salesman's trail
 * has been drawn, and a fresh handler added inside `drawOverlays` on every
 * style switch would stack a second one on top of the first. `atMs` is the
 * fix's own timestamp as milliseconds since the epoch — a plain number,
 * because GeoJSON properties do not carry a `Date` — read back and formatted
 * with `clockSeconds` only when a hover actually asks for it.
 */
function trailPointsFeatureCollection(trails: [string, { lat: number; lng: number; at: Date }[]][]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: trails.flatMap(([, points]) =>
      points.map((p) => ({
        type: "Feature" as const,
        properties: { atMs: p.at.getTime() },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      })),
    ),
  };
}

/**
 * Where a trail stood still, as its own collection.
 *
 * Lifted out of the drawing for the reason `trailPointsFeatureCollection` was:
 * a redraw writes the same features into a source that already exists, and a
 * collection built inline in the `addSource` call is one only the first draw
 * can ever reach — which is precisely how the map came to be frozen at first
 * paint.
 */
function dwellFeatureCollection(stops: DwellStop[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: stops.map((s) => ({
      type: "Feature" as const,
      properties: {
        label: `Stopped ${formatMinutes(s.minutes)} · ${clock(s.startAt)}–${clock(s.endAt)}`,
      },
      geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
    })),
  };
}

/** What one visit pin knows about itself — read back off the feature on a click. */
function visitFeatureCollection(
  visits: Array<ActivityPoint & { seq: number }>,
  staleAfterSeconds: number,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: visits.map((v) => ({
      type: "Feature" as const,
      properties: {
        seq: String(v.seq),
        customerId: v.customerId,
        customerName: v.customerName,
        accountType: accountTypeLabel({
          kind: v.customerKind ?? "customer",
          thirdParty: v.thirdParty ?? false,
        }),
        outcome: wordFor(VISIT_OUTCOME_LABEL, v.visitOutcome ?? "visited"),
        when: visitWhen(v),
        /* The same rule the activity dot follows: a stale fix is drawn hollow
           rather than hidden, because the visit is certain and only its place
           is not. */
        stale: (v.ageSeconds ?? 0) > staleAfterSeconds ? 1 : 0,
      },
      geometry: { type: "Point" as const, coordinates: [v.lng, v.lat] },
    })),
  };
}

/**
 * The visit's own hours, as far as they are known.
 *
 * A visit that never closed has no check-out and no duration — the salesman
 * walked out of signal, and `mbos_visits` says so with nulls rather than
 * guessing an end. The card says "from 10:42" in that case instead of drawing
 * a range whose second half nobody recorded.
 */
function visitWhen(v: ActivityPoint): string {
  const start = markMs(v.visitStartAt);
  if (!start) return "";
  const from = clock(new Date(start));
  const end = markMs(v.visitEndAt);
  if (!end) return `from ${from}`;
  const held = v.durationSeconds ? ` (${formatMinutes(v.durationSeconds / 60)})` : "";
  return `${from}\u2013${clock(new Date(end))}${held}`;
}

/** The work, marked where it was done — see `dwellFeatureCollection` above. */
function activityFeatureCollection(
  marks: ActivityPoint[],
  staleAfterSeconds: number,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: marks.map((a) => ({
      type: "Feature" as const,
      properties: {
        label: `${activityLabel(a.entityType)}${a.accuracyM ? ` · ±${a.accuracyM} m` : ""}`,
        /* A stale fix is drawn hollow rather than hidden: the act is certain
           and only its place is not. */
        stale: (a.ageSeconds ?? 0) > staleAfterSeconds ? 1 : 0,
      },
      geometry: { type: "Point" as const, coordinates: [a.lng, a.lat] },
    })),
  };
}

/** A ring round whoever the team list has picked, drawn above everybody else. */
/**
 * The first layer this file added, in the style's own draw order — what the
 * book has to be inserted beneath when it arrives after the map is up.
 *
 * Ola's own style layers are skipped by name: everything of ours is a trail,
 * a dwell ring or an activity dot, and anything else in the list is the
 * street map itself, which the book belongs on top of.
 */
function lowestOwnLayer(map: maplibregl.Map): string | undefined {
  return map
    .getStyle()
    .layers.map((l) => l.id)
    .find(
      (id) =>
        id.startsWith("trail-") || id === "dwells" || id === "activity" || id === "visits",
    );
}

/**
 * The card a visit pin opens, built by hand because a MapLibre popup takes an
 * element and not a component.
 *
 * It reads the feature's own properties rather than looking the visit up
 * again: they were put there by `visitFeatureCollection` from the row the
 * server sent, and a second read would be a second answer. The classes are the
 * app's own — the stylesheet is global, so a popup is styled like everything
 * else rather than like a map library.
 */
function visitCard(
  props: Record<string, unknown>,
  onOpenRecord: (customerId: string) => void,
): HTMLElement {
  const text = (key: string) => (typeof props[key] === "string" ? (props[key] as string) : "");
  const el = document.createElement("div");
  el.className = "min-w-[190px] pr-3 text-[12px] text-ink";

  const head = document.createElement("p");
  head.className = "text-[11px] text-muted";
  head.textContent = [`Visit ${text("seq")}`, text("when")].filter(Boolean).join(" · ");
  el.append(head);

  const name = document.createElement("p");
  name.className = "mt-0.5 text-[13px] font-semibold text-ink";
  name.textContent = text("customerName");
  el.append(name);

  const what = document.createElement("p");
  what.className = "mt-0.5 text-muted";
  what.textContent = [text("accountType"), text("outcome")].filter(Boolean).join(" · ");
  el.append(what);

  /* A shop we can no longer name is a shop there is nothing to open, and a
     dead link is worse than none. It cannot happen from the query as written;
     it is guarded because a popup is built from whatever the feature carries. */
  const customerId = text("customerId");
  if (customerId) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "mt-1.5 text-[12px] font-medium text-[#5223E0] hover:underline";
    open.textContent = "Open record \u2192";
    open.addEventListener("click", () => onOpenRecord(customerId));
    el.append(open);
  }
  return el;
}

/**
 * WHETHER A CLICK LANDED ON A VISIT, asked by the two layers underneath it.
 *
 * MapLibre fires every layer-scoped handler whose features are under the
 * cursor, so clicking a numbered pin that happens to sit inside a dwell ring
 * — which is most of them, since a visit IS somewhere he stood still — opened
 * the visit card AND a "Stopped 5 min" popup on top of it, each half covering
 * the other. The visit is the more specific answer and the one that was aimed
 * at, so it wins and the general marks stand down. It is asked of the map
 * rather than tracked in a flag: two handlers firing in an order nothing
 * guarantees is exactly where a flag goes wrong.
 */
function overVisit(map: maplibregl.Map, point: maplibregl.Point): boolean {
  const layers = ["visits", "visit-labels"].filter((id) => map.getLayer(id));
  if (!layers.length) return false;
  return map.queryRenderedFeatures(point, { layers }).length > 0;
}

/**
 * Showing and hiding the numbered visits, moved on the map that already exists
 * — the same imperative pattern the book pins use, and for the same reason: a
 * toggle that rebuilt the map would refetch every tile to hide a dozen dots.
 */
function setVisitLayersVisible(map: maplibregl.Map, visible: boolean) {
  for (const id of ["visits", "visit-labels"]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}

function highlightMarker(el: HTMLDivElement, selected: boolean) {
  el.style.boxShadow = selected
    ? "0 0 0 3px #5223E0, 0 2px 8px rgba(22,22,22,0.4)"
    : "0 1px 4px rgba(22,22,22,0.4)";
  el.style.zIndex = selected ? "1" : "0";
}

export function StreetMap({
  day,
  rows,
  tracks,
  activity,
  dwells,
  gapMetres,
  dwellRadiusMetres,
  tripBreakMinutes,
  staleAfterSeconds,
  view,
  fullscreen,
  onToggleFullscreen,
  selectedId,
  apiKey,
  keysSpent,
}: {
  day: string;
  rows: LastKnown[];
  tracks: Map<string, TrackPoint[]>;
  activity: ActivityPoint[];
  /** Where each salesman's trail stood still long enough to mean something. */
  dwells: Map<string, DwellStop[]>;
  /** Metres apart before a hop is drawn as an honest gap — see `lib/engines/trail-gaps.ts`. */
  gapMetres: number;
  /** What counts as standing still, and so as the end of one trip — see `lib/engines/trail-trips.ts`. */
  dwellRadiusMetres: number;
  tripBreakMinutes: number;
  staleAfterSeconds: number;
  view: "now" | "today";
  /** Whether the map has been given the whole window — see `live-panel.tsx`. */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Whoever is picked in the team list beside this — see the effect below. */
  selectedId: string | null;
  /** Ola Maps' key, read once server-side and handed down — see the doc comment above. */
  apiKey: string | null;
  /**
   * With no key: whether every key held has run out, or none is set at all.
   *
   * Two different silences and they need two different sentences. "Add a key"
   * to somebody who added five of them, four of which have run out, sends them
   * looking for a configuration mistake they did not make.
   */
  keysSpent: boolean;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const map = React.useRef<maplibregl.Map | null>(null);
  const markers = React.useRef(new Map<string, HTMLDivElement>());
  /** Whether the map has ever finished its first real paint — see the load timeout below. */
  const loadedOnce = React.useRef(false);
  /*
   * The same fact as `loadedOnce`, as STATE rather than a ref.
   *
   * The road-line effect below cannot start before the map exists, and a ref
   * cannot tell it when that changes: it ran once on mount with `map.current`
   * still null, returned, and — its dependencies never changing again — never
   * ran a second time. The old code only escaped that by depending on
   * `selectedId`, which a click changed after the map was up; taking the
   * selection requirement out took the accidental retry with it, and the
   * request simply stopped being made.
   */
  const [mapReady, setMapReady] = React.useState(false);
  /** Which trip the cursor is over, or null. A ref — see the mousemove handler. */
  const hoveredTrip = React.useRef<number | null>(null);
  const [failed, setFailed] = React.useState(false);
  /*
   * THE STREETS DREW AND THE DAY DID NOT — a third state, because it is a
   * third fact.
   *
   * `failed` is "the map could not be drawn" and hangs off the style never
   * loading, which is the one signal that does not depend on reading meaning
   * into MapLibre's error text (see the `error` note in the build effect).
   * That rule is right and it left a hole: everything this file draws ON the
   * map — the trail, the fixes, the dwell rings, the work — runs after the
   * style has loaded, so a throw in any of it used to leave a perfectly good
   * street map with no day on it, no failure anywhere, and nothing saying the
   * line was missing rather than absent. A manager reading an empty map
   * concludes the salesman did not move.
   */
  const [overlaysFailed, setOverlaysFailed] = React.useState(false);
  const [styleMode, setStyleMode] = React.useState<OlaMapsStyleMode>("map");
  /* The book, fetched once by the client — see the effect below and the
     route's own comment. Held in a ref as well as in state: `drawOverlays`
     runs again on every Map/Satellite switch and reads it imperatively, and
     it is the state copy that draws the legend. */
  const [book, setBook] = React.useState<ShopPin[]>([]);
  const bookRef = React.useRef<ShopPin[]>([]);
  const [showBook, setShowBook] = React.useState(true);
  /* What the office set the catchment to, as the route answered it — so the
     legend says the same number the query was run with rather than a second
     copy of the default. */
  const [radiusKm, setRadiusKm] = React.useState<number | null>(null);
  /* Declared beside its state rather than beside the effect that keeps it in
     step: `drawOverlays` reads it on every style switch, and a ref used
     above where it is written reads as an accident. */
  const showBookRef = React.useRef(true);
  /* The numbered visits, shown by default and turnable off for a manager who
     wants the bare shape of a day. Held as a ref beside its state for the same
     reason the book is: `drawOverlays` runs again on every Map/Satellite
     switch and reads it imperatively. */
  const [showVisits, setShowVisits] = React.useState(true);
  const showVisitsRef = React.useRef(true);
  /* Which shop's record is open. The same drawer Territory's map opens. */
  const [selectedShopId, setSelectedShopId] = React.useState<string | null>(null);

  const pinned = rows.filter((r) => r.lat != null && r.lng != null);
  const allMarks = view === "today" ? activity : [];
  /* THE VISITS COME OUT OF THE ACTIVITY AND ARE DRAWN AS THEIR OWN THING.
     Every act was one identical dot, so a visit — the only mark with a shop
     and an order behind it — read as the same event as an expense logged on
     the way home. A visit with no customer behind it stays in the general
     layer rather than being dropped: it is still a mark somebody made. */
  const visits = numberVisits(allMarks);
  const marks = otherMarks(allMarks);
  const trails = view === "today" ? [...tracks.entries()] : [];
  const stops = view === "today" ? [...dwells.values()].flat() : [];

  /* Everything being shown, so the fit covers the whole day's travel in the
     `today` view rather than only where each person ended up.

     THE BOOK IS NOT IN HERE, deliberately. The shops are drawn around where
     the team is; making them decide where the camera opens would let the
     backdrop move the subject, and a stray pin at the edge of the catchment
     would zoom the day out to fit it. */
  const points: [number, number][] = [
    ...pinned.map((r) => [r.lng as number, r.lat as number] as [number, number]),
    ...trails.flatMap(([, ps]) => ps.map((p) => [p.lng, p.lat] as [number, number])),
    /* Both halves of the activity. The visits were taken out of `marks` to be
       drawn as their own layer, and leaving them out here would let a shop
       reached on a handset whose trail is dead sit outside the opening view —
       the one visit on the day that most needs looking at. */
    ...marks.map((a) => [a.lng, a.lat] as [number, number]),
    ...visits.map((v) => [v.lng, v.lat] as [number, number]),
  ];

  const bookCounts = countByTone(book);

  const hasAnything = points.length > 0;

  /*
   * WHAT THE MAP IS CURRENTLY DRAWING, AS A REF — and this is the whole of the
   * "live tracking is dead" bug.
   *
   * The map is built once, in an effect with no dependencies, because
   * rebuilding it on a prop change refetched every tile and threw the camera
   * away (see that effect's own note, and the house rule: remount with a
   * `key`, never re-run on a prop). Both drawing functions were defined INSIDE
   * that effect, so they closed over the `pinned`, `trails`, `marks` and
   * `stops` computed on the FIRST render and nothing else — and they are
   * invoked from `style.load`, which fires on mount and on a Map/Satellite
   * switch. Never on new data.
   *
   * The page polls every thirty seconds and `page.tsx` keys this panel on the
   * day and the view, neither of which changes during a day, so the component
   * re-rendered with fresh props and no effect ever ran again. The team list
   * ticked forward beside a map frozen at first paint: a manager watching a
   * salesman cross a city saw him standing still, on a screen whose entire
   * subject is that he is moving.
   *
   * Holding the data in a ref and redrawing INTO the sources that already
   * exist is what fixes it without giving any of that up. A redraw is
   * `setData` on a handful of GeoJSON sources — no tiles refetched, no camera
   * touched, nothing to pay Ola Maps for — and `style.load` reads the same ref,
   * so a Satellite switch draws what is on screen now rather than what was on
   * screen at nine o'clock.
   */
  const frame = React.useRef({ pinned, trails, marks, visits, stops, points });
  /** Whose trail has a source and layers on the map — see `lib/map-layers.ts`. */
  const drawnTrails = React.useRef<string[]>([]);
  /** Read by the marker rebuild, which has to put the ring back where it was. */
  const selectedIdRef = React.useRef(selectedId);
  /** Set once the map exists; null until then, so an early poll is a no-op. */
  const redraw = React.useRef<(() => void) | null>(null);

  /*
   * A SIGNATURE, not the arrays themselves.
   *
   * Every one of them is a fresh object on every render — that is exactly what
   * made depending on them tear the map down in a loop before it was keyed —
   * so what a redraw has to key on is whether the CONTENT moved. Positions,
   * how many fixes each trail holds and its newest timestamp, and the two
   * counts: between them they change on every poll that brought anything and
   * on none that did not, which keeps a selection click or a legend toggle
   * from rebuilding every marker on the map.
   */
  const dataSignature = [
    pinned.map((r) => `${r.salesmanId}@${r.lat},${r.lng}`).join("|"),
    trails
      .map(([id, ps]) => `${id}#${ps.length}@${ps.length ? ps[ps.length - 1].at.getTime() : 0}`)
      .join("|"),
    `m${marks.length}`,
    `v${visits.length}`,
    `s${stops.length}`,
  ].join("~");

  React.useEffect(() => {
    frame.current = { pinned, trails, marks, visits, stops, points };
    redraw.current?.();
    /* The signature IS the dependency — see its own note. The arrays it is
       built from change identity every render and say nothing by doing so. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSignature]);

  React.useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  React.useEffect(() => {
    /*
     * BUILT ONCE THE FIRST TIME THERE IS ANYTHING TO PLACE — and `hasAnything`
     * is in the dependencies for a reason that cost a whole screen.
     *
     * This returned early when nothing had reported yet, and the host div was
     * not even mounted in that state: the component rendered a "nothing to
     * place yet" panel instead. When the first position arrived on a later
     * poll the component re-rendered WITH the host div — and this effect,
     * having no dependencies, never ran again. So a manager who opened the
     * Live map before anybody checked in had no map for the rest of the day,
     * however many salesmen reported afterwards, and reloading the page was
     * the only way anybody found out. The host is always mounted now and this
     * runs again the moment there is something to draw.
     *
     * `map.current` is still the real guard against building twice, so a
     * re-run after the map exists costs one comparison.
     */
    if (!host.current || map.current || !hasAnything || !apiKey) return;

    /*
     * Built one frame late, on purpose.
     *
     * Constructing the map can throw where there is no WebGL, and answering
     * that with `setFailed(true)` in the body of an effect is what the React
     * Compiler rules forbid. A frame's delay costs nothing here — the map is
     * asynchronous anyway, it has tiles to fetch — and it puts both the
     * failure and the success on the same footing: a callback.
     */
    let cancelled = false;
    let m: maplibregl.Map | null = null;
    let loadTimeout: ReturnType<typeof setTimeout> | undefined;
    const markerMap = markers.current;

    const build = requestAnimationFrame(async () => {
      if (cancelled || !host.current) return;

      /* Ola's own style declares a layer over data it does not serve, which
         MapLibre rejects on every load — see `olaMapsStyle`. Fetching and
         cleaning it first costs one request and buys a style that validates:
         no console error, and a `load` event that actually fires. A failure
         here falls back to the URL, which is exactly what it was before. */
      let cleanStyle: unknown = olaMapsStyleUrl("map");
      try {
        cleanStyle = await olaMapsStyle("map", apiKey);
      } catch {
        /* Left as the URL. */
      }
      if (cancelled || !host.current) return;

      try {
        m = new maplibregl.Map({
          container: host.current,
          style: cleanStyle as maplibregl.StyleSpecification,
          center: [points[0][0], points[0][1]],
          zoom: 11,
          // The style carries whatever attribution it is built from; the
          // control just has to be present to show it.
          attributionControl: { compact: true },
          transformRequest: olaMapsTransformRequest(apiKey),
        });
      } catch {
        // WebGL unavailable — an old machine, or a locked-down browser.
        setFailed(true);
        return;
      }

      const built = m;
      built.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      /*
       * "error" is NOT wired to `failed`, on purpose, and this took a real
       * bug to learn. MapLibre fires the same generic "error" event for a
       * single non-fatal problem as it does for something that stops the
       * map dead — and Ola Maps' own `default-light-standard` style ships
       * one: a layer named "3d_model_data" that points at a source-layer
       * ("3d_model") absent from the "vectordata" source's actual tiles.
       * MapLibre logs it and carries on rendering every other layer
       * perfectly — streets, labels, POIs — so a handler that flipped
       * `failed` on ANY "error" put every single page load into "the map
       * could not be drawn", even though the map was, provably, drawn.
       *
       * What actually distinguishes "broken" from "one bad layer reference"
       * is whether the map ever finishes its first paint at all — so that is
       * what is watched for instead, below, with a timeout standing in for
       * "never".
       */
      map.current = built;

      /*
       * The genuine failure case: nothing ever loads. A totally unreachable
       * style URL, or a key rejected outright, both mean `load` never fires,
       * which is the one signal that does not depend on reading meaning into
       * MapLibre's error text. Cleared the moment `load` actually fires.
       */
      loadTimeout = setTimeout(() => {
        if (!loadedOnce.current) setFailed(true);
      }, 15_000);

      /*
       * Bound to the MAP, not the layer, so it survives `setStyle` — the
       * map/satellite switcher tears the style down and rebuilds it, which
       * removes every custom source and layer (see `drawOverlays` below) but
       * leaves listeners registered on the map object alone. Registering
       * these once here, rather than inside `drawOverlays`, is what stops a
       * style switch from stacking a second popup handler on top of the
       * first. MapLibre resolves a layer-scoped listener at EVENT time, so
       * it is harmless that the "activity" layer does not exist yet on the
       * very first style load.
       */
      /* A shop pin opens the same record drawer Territory's map opens — a
         real account, so it gets the record rather than a text popup. Bound
         to the MAP rather than the layer for the reason every handler here
         is: `drawOverlays` runs again on every style switch, and a handler
         registered in there would stack a second copy each time. */
      built.on("click", "book-points", (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.customerId;
        if (typeof id === "string") setSelectedShopId(id);
      });
      built.on("mouseenter", "book-points", () => (built.getCanvas().style.cursor = "pointer"));
      built.on("mouseleave", "book-points", () => (built.getCanvas().style.cursor = ""));

      built.on("click", "activity", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f || overVisit(built, e.point)) return;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setText(String(f.properties?.label ?? ""))
          .addTo(built);
      });
      built.on("mouseenter", "activity", () => (built.getCanvas().style.cursor = "pointer"));
      built.on("mouseleave", "activity", () => (built.getCanvas().style.cursor = ""));

      /*
       * A VISIT PIN OPENS A CARD, not a line of text.
       *
       * Every other popup on this map is one sentence, and one sentence is the
       * right answer for a stop or a leg. A visit is four facts — which call of
       * the day, which shop, what kind of account, what came of it — and the
       * way into the record itself, which is the thing a manager is actually
       * reaching for when he clicks a shop he does not recognise. It opens the
       * SAME drawer a book pin opens, so a figure read off a visit and one read
       * off the shop underneath it are one answer.
       *
       * Bound to both layers IN ONE HANDLER, which is the part worth saying:
       * the number sits above the disc, so a click landing on a digit hits
       * `visit-labels` and one bound only to `visits` would do nothing — a pin
       * that works everywhere except its middle. Registered as two handlers
       * instead, a click landing on both opened two identical cards stacked on
       * each other, each covering the other's "Open record".
       */
      const VISIT_LAYERS = ["visits", "visit-labels"];
      built.on("click", VISIT_LAYERS, (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
          .setLngLat(e.lngLat)
          .addTo(built);
        popup.setDOMContent(
          visitCard(f.properties ?? {}, (id) => {
            setSelectedShopId(id);
            popup.remove();
          }),
        );
      });
      built.on("mouseenter", VISIT_LAYERS, () => (built.getCanvas().style.cursor = "pointer"));
      built.on("mouseleave", VISIT_LAYERS, () => (built.getCanvas().style.cursor = ""));

      built.on("click", "dwells", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f || overVisit(built, e.point)) return;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setText(String(f.properties?.label ?? ""))
          .addTo(built);
      });
      built.on("mouseenter", "dwells", () => (built.getCanvas().style.cursor = "pointer"));
      built.on("mouseleave", "dwells", () => (built.getCanvas().style.cursor = ""));

      /* A point is read on hover rather than click — a manager scanning
         along a trail to see how the pace changed should not have to click
         and dismiss a popup for every single fix. `hoverPopup` is closed
         over by both handlers below so a fast sweep across several points
         in a row never leaves more than one open. */
      let hoverPopup: maplibregl.Popup | null = null;
      /* Its own handle: a trip's figure and a fix's clock can be wanted at the
         same moment, and one shared popup would make each close the other. */
      let tripPopup: maplibregl.Popup | null = null;
      built.on("mouseenter", "trail-points", (e: maplibregl.MapLayerMouseEvent) => {
        built.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        const atMs = Number(f?.properties?.atMs);
        if (!Number.isFinite(atMs)) return;
        hoverPopup?.remove();
        hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
          .setLngLat(e.lngLat)
          .setText(clockSeconds(new Date(atMs)))
          .addTo(built);
      });
      built.on("mouseleave", "trail-points", () => {
        built.getCanvas().style.cursor = "";
        hoverPopup?.remove();
        hoverPopup = null;
      });

      /*
       * PICKING ONE JOURNEY OUT OF A DAY.
       *
       * Colour alone separates trips that run down different streets; it does
       * not separate two that run down the SAME one, which is the case this
       * whole feature exists for — the second line is simply drawn over the
       * first, and only its edges show. Hovering lifts one leg and drops the
       * rest to a quarter opacity, so the road he walked at five reads apart
       * from the one he walked at eleven even where they lie on top of each
       * other.
       *
       * ONE handler, registered here rather than per layer inside
       * `drawOverlays`, and for the reason `trail-points` is a single shared
       * source: a trail layer's id does not exist until that salesman has been
       * drawn, and `drawOverlays` runs again on every style switch, so a
       * handler added in there would stack a second copy on top of the first
       * each time somebody toggled Satellite. `queryRenderedFeatures` needs no
       * layer id up front — it asks what is actually under the cursor.
       *
       * The hovered trip is a REF, not state: this fires on every mouse move
       * across the map, and re-rendering a MapLibre host component that often
       * would tear down and rebuild the very layers being painted.
       */
      built.on("mousemove", (e: maplibregl.MapMouseEvent) => {
        const layers = built
          .getStyle()
          .layers.map((l) => l.id)
          /* The CASING is deliberately in here too. It reads the same source
             and so carries the same `trip`, and being the wider of the two it
             is what makes a line a few pixels thick comfortable to point at —
             the hit area is the white border, not just the colour. */
          .filter((id) => id.startsWith("trail-") && id !== "trail-points");
        if (!layers.length) return;

        const hit = built.queryRenderedFeatures(e.point, { layers });
        const trip = hit.length ? Number(hit[0].properties?.trip) : null;
        const next = Number.isFinite(trip) ? (trip as number) : null;
        if (next === hoveredTrip.current) return;
        hoveredTrip.current = next;

        const paint = trailPaint(next);
        for (const id of layers) {
          /* The dashed half keeps its own weight and opacity — it is a gap
             whether or not its trip is the one being pointed at, and fading
             it in with the rest would make an absence look like evidence. */
          if (id.startsWith("trail-gap-")) continue;
          if (id.startsWith("trail-casing-")) {
            built.setPaintProperty(id, "line-opacity", paint.casingOpacity);
            built.setPaintProperty(id, "line-width", paint.casingWidth);
            continue;
          }
          built.setPaintProperty(id, "line-opacity", paint.opacity);
          built.setPaintProperty(id, "line-width", paint.width);
        }

        /* WHAT THE LEG WAS, not merely which one it is. Lighting a line up
           answers "these two are different"; the figure answers the question
           that comes straight after it, which is how far he actually went.
           `formatDistance` is the same function the team list beside the map
           prints its own total with, so a leg and a day are read in one
           vocabulary rather than two. */
        tripPopup?.remove();
        tripPopup = null;
        if (next === null) return;
        const f = hit[0];
        const metres = Number(f.properties?.metres);
        const fromMs = Number(f.properties?.fromMs);
        const toMs = Number(f.properties?.toMs);
        if (!Number.isFinite(metres)) return;
        const when =
          Number.isFinite(fromMs) && Number.isFinite(toMs)
            ? ` · ${clock(new Date(fromMs))}–${clock(new Date(toMs))}`
            : "";
        /*
         * A DASHED LINE THAT FOLLOWS A ROAD HAS TO SAY SO IN WORDS.
         *
         * The dash pattern already says "not recorded" to anybody who knows
         * the key, and a line that bends round corners says "somebody drove
         * this" to everybody — which is the stronger of the two signals and is
         * the wrong one. So the stretch under the cursor names itself: the
         * road is Ola's guess at how he got between two fixes, nobody was seen
         * on it, and it is not in the distance quoted beside it. The figure is
         * the trip's own, measured on the crow's flight across every gap in
         * it, exactly as it was before this existed.
         */
        const inferred = f.properties?.inferred === true;
        const what = inferred
          ? " · estimated route, not recorded — not counted in the distance"
          : "";
        tripPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
          .setLngLat(e.lngLat)
          .setText(`Trip ${next} · ${formatDistance(metres)}${when}${what}`)
          .addTo(built);
      });

      /*
       * Everything the STYLE carries rather than the map: the trail and
       * activity sources and layers. `setStyle` throws all of this away and
       * rebuilds from the new style JSON, so it has to be re-drawn every
       * time — which is exactly what `style.load` fires for, including the
       * very first time. Markers are HTML overlays bound to the map object,
       * not the style, so they are untouched by a switch and are added
       * separately, once, in the `load` handler below.
       */
      function drawOverlays() {
        /*
         * THE HEALTH MARK IS MADE AT THE END, AND IT IS MADE EITHER WAY.
         *
         * Two separate facts, and they used to be one. The map is provably
         * working the moment its STYLE has loaded — well before every tile in
         * view has downloaded, which is what MapLibre's "load" event actually
         * measures, and Ola Maps serving a burst of dozens of tile, glyph and
         * sprite requests on one page can genuinely take longer than the load
         * timeout to finish all of them. So `loadedOnce` hangs off the first
         * `style.load` and is set in a `finally`: a throw in anything below is
         * not the map failing to draw, and turning it into "the map could not
         * be drawn" would be the same mistake as wiring MapLibre's `error`
         * event to `failed`, which put every page load into that state over
         * one bad layer reference in Ola's own style.
         *
         * But marking it at the TOP, as this did, meant a throw half way
         * through left the streets drawn, no failure state anywhere, and the
         * day's trail silently absent — which reads as a salesman who did not
         * move. Drawing gets its own answer, and the screen says which of the
         * two happened.
         */
        try {
          drawEverything();
          setOverlaysFailed(false);
        } catch {
          setOverlaysFailed(true);
        } finally {
          loadedOnce.current = true;
          setMapReady(true);
          clearTimeout(loadTimeout);
        }
      }

      /**
       * ADD IT, OR UPDATE WHAT IS ALREADY THERE.
       *
       * The same function serves both callers, which is what makes one drawing
       * path safe for two completely different moments: after a `setStyle`
       * every source this file owns has been thrown away and has to be built
       * again, and after a poll every one of them exists and only its data has
       * moved. Asking the map which of those it is, rather than tracking it,
       * means the two can never get out of step — and `setData` on an existing
       * source refetches nothing and repaints without touching the camera.
       *
       * An EMPTY collection is still written to a source that exists — a day's
       * activity does not vanish, but a dwell can stop being one as a trail
       * grows through it, and leaving the old features there would draw a ring
       * the engine no longer says is real.
       */
      function upsert(id: string, data: GeoJSON.FeatureCollection, add: () => void) {
        const source = built.getSource(id) as maplibregl.GeoJSONSource | undefined;
        if (source) source.setData(data);
        else if (data.features.length) add();
      }

      function drawEverything() {
        const { trails, marks, visits, stops } = frame.current;

        /* MapLibre's compact attribution starts EXPANDED, and stays that way
           until the map is DRAGGED — that is the only event its minimiser
           listens for, so nobody has yet triggered it on a map that has just
           appeared. The style loading also re-adds the class once the real
           source attributions are known, so stripping it earlier does not
           hold — this has to run after the style has settled, on every
           switch as well as the first load. Clicking the icon still toggles
           normally afterwards, since that handler manages the class itself. */
        built
          .getContainer()
          .querySelector(".maplibregl-ctrl-attrib")
          ?.classList.remove("maplibregl-compact-show");

        /* THE BOOK FIRST OF ALL, so every line, ring, fix and pin that
           follows lands on top of it. MapLibre draws in the order layers are
           added, and the shops are the ground a day is read against. Read
           from the ref rather than the closure: this function runs again on
           every style switch, and by then the fetch below has usually
           landed. */
        upsert("book", bookPinFeatures(bookRef.current), () =>
          addBookPinLayers(built, {
            features: bookPinFeatures(bookRef.current),
            visible: showBookRef.current,
            /* Underneath the day, however late the shops arrive — the same
               reasoning the fetch below spells out. On a fresh style load
               there is nothing of ours yet and this is undefined, which is
               the top of the stack and exactly where the book belongs. */
            beforeId: lowestOwnLayer(built),
          }),
        );

        /*
         * The trail next, so pins and marks sit on top of it.
         *
         * WORKED OUT FIRST, THEN DRAWN, because a trail with nothing to draw
         * has to count as absent for the teardown below as well as for the
         * drawing — otherwise a salesman whose line shrinks to nothing keeps
         * his layers for ever, and nothing on the map looks wrong.
         */
        const drawable = trails
          .map(([id, ps]) => {
            /* The road-matched line if it has arrived, the raw fixes until it
               does. Both are the same shape, so nothing below knows which. */
            return [
              id,
              roadLines.current.get(id) ??
                tripSegments(ps, gapMetres, dwellRadiusMetres, tripBreakMinutes),
            ] as const;
          })
          .filter(([, segments]) => segments.length > 0);

        /*
         * WHOEVER HAS LEFT THE MAP GOES FIRST, and all three of his layers go
         * with his source — MapLibre refuses to remove a source a layer is
         * still reading, and a half-done teardown throws in the middle of a
         * redraw and takes the rest of the day's drawing with it. Guarded on
         * what actually exists rather than on what was drawn, because a
         * `setStyle` has already thrown the lot away and this same function is
         * what rebuilds it.
         */
        for (const id of departedTrailIds(drawnTrails.current, drawable.map(([i]) => i))) {
          for (const layer of trailLayerIds(id)) {
            if (built.getLayer(layer)) built.removeLayer(layer);
          }
          if (built.getSource(trailSourceId(id))) built.removeSource(trailSourceId(id));
        }
        drawnTrails.current = drawable.map(([id]) => id);

        for (const [id, segments] of drawable) {
          const existing = built.getSource(`trail-${id}`) as maplibregl.GeoJSONSource | undefined;
          if (existing) {
            existing.setData(trailFeatureCollection(segments));
            continue;
          }
          /* A trail that appears mid-day — his first fix of the morning — is
             added UNDER the shared fix, dwell and activity layers if those are
             already up, so a late arrival is not drawn over the marks it is
             supposed to run beneath. */
          const under = ["trail-points", "dwells", "activity", "visits"].find((l) =>
            built.getLayer(l),
          );
          built.addSource(`trail-${id}`, {
            type: "geojson",
            data: trailFeatureCollection(segments),
          });
          /* Two layers reading the same source, split by the `gap` property
             each feature carries — see `lib/engines/trail-gaps.ts`. A dashed
             line for a hop nobody has evidence for, solid for one dense
             enough to trust. */
          /* The casing goes down FIRST, so the coloured line lands on top of
             it — MapLibre draws in the order layers are added. */
          built.addLayer({
            id: `trail-casing-${id}`,
            type: "line",
            source: `trail-${id}`,
            filter: ["==", ["get", "gap"], false],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#FFFFFF",
              "line-width": trailPaint(null).casingWidth,
              "line-opacity": trailPaint(null).casingOpacity,
            },
          }, under);
          built.addLayer({
            id: `trail-${id}`,
            type: "line",
            source: `trail-${id}`,
            filter: ["==", ["get", "gap"], false],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": trailPaint(null).colour,
              "line-width": trailPaint(null).width,
              "line-opacity": trailPaint(null).opacity,
            },
          }, under);
          built.addLayer({
            id: `trail-gap-${id}`,
            type: "line",
            source: `trail-${id}`,
            filter: [
              "all",
              ["==", ["get", "gap"], true],
              ["!=", ["get", "inferred"], true],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              /* The gap keeps its trip's colour too — it is part of that
                 journey, just the part nobody recorded. No casing and a
                 thinner, softer stroke: the casing is what makes a line read
                 as a route somebody actually took, which is the one claim a
                 gap must not make. */
              "line-color": trailPaint(null).colour,
              "line-width": widthByZoom(2.5),
              "line-opacity": 0.5,
              "line-dasharray": [1.5, 2],
            },
          }, under);
          /*
           * A GAP WHOSE ROAD WAS GUESSED, drawn as its own layer for one
           * reason: `line-dasharray` is the one paint property here that
           * MapLibre will not take a data-driven expression for, so two dash
           * patterns is two layers or it is nothing.
           *
           * Everything else about it is the gap treatment above, unchanged and
           * deliberately so — same colour, same half opacity, no casing. It is
           * NOT closer to the recorded line for following a road; a routed gap
           * is a plausible guess and the recorded line is a reading, and the
           * moment those two look alike this map has started lying. The dots
           * are finer than the dashes beside them, which reads as less certain
           * rather than more, and the hover says which in words for anybody who
           * does not read a dash pattern as a claim.
           *
           * Named `trail-gap-inferred-` and not `trail-inferred-`, because the
           * hover handler skips every `trail-gap-` layer when it thickens the
           * leg under the cursor — a guess must not brighten and fatten with
           * the evidence around it.
           */
          built.addLayer({
            id: `trail-gap-inferred-${id}`,
            type: "line",
            source: `trail-${id}`,
            filter: [
              "all",
              ["==", ["get", "gap"], true],
              ["==", ["get", "inferred"], true],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": trailPaint(null).colour,
              "line-width": widthByZoom(2.5),
              "line-opacity": 0.5,
              "line-dasharray": [0.5, 2],
            },
          }, under);
        }

        /* Every real fix, hoverable for its exact time — see
           `trailPointsFeatureCollection`. Sits on top of the lines just
           added, below the dwell rings and activity dots that follow. */
        upsert("trail-points", trailPointsFeatureCollection(trails), () => {
          built.addSource("trail-points", {
            type: "geojson",
            data: trailPointsFeatureCollection(trails),
          });
          built.addLayer({
            id: "trail-points",
            type: "circle",
            source: "trail-points",
            paint: {
              /*
               * VERTICES, not a second subject.
               *
               * These were solid brand-violet at a fixed three pixels, which
               * put a hard blue dot every few metres along a line that is now
               * carrying the day's colours — the dots read as the thing and
               * the route read as what joined them. They are white on the
               * coloured line now, so they mark where a real fix was without
               * arguing with the leg they sit on.
               *
               * And they grow with the zoom. A fix every three seconds is
               * hundreds of dots across a district: at the zoom a whole beat
               * is read at they are noise, and only close in — where somebody
               * is actually asking "when was he exactly here" — are they worth
               * the ink. They fade out entirely rather than shrink to a
               * speck, because a dot too small to hover is a control that
               * looks available and is not.
               */
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                0,
                15.5,
                1.8,
                18,
                3.2,
              ],
              "circle-color": "#FFFFFF",
              "circle-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                0,
                15.5,
                0.9,
              ],
              "circle-stroke-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                0,
                15.5,
                1,
              ],
              "circle-stroke-color": "rgba(22,22,22,0.35)",
            },
          });
        });

        /* Where a trail stood still — a bigger, hollow ring rather than the
           activity dot above, so a stop reads as "paused here" and not as a
           third kind of visit. */
        upsert("dwells", dwellFeatureCollection(stops), () => {
          built.addSource("dwells", {
            type: "geojson",
            data: dwellFeatureCollection(stops),
          });
          built.addLayer({
            id: "dwells",
            type: "circle",
            source: "dwells",
            paint: {
              "circle-radius": 9,
              "circle-color": "#FFFFFF",
              "circle-opacity": 0.85,
              "circle-stroke-width": 3,
              "circle-stroke-color": "#5223E0",
            },
          });
        });

        /* The work, marked where it was done. An order taken two kilometres
           off the beat is obvious on a line and invisible in a list. */
        upsert("activity", activityFeatureCollection(marks, staleAfterSeconds), () => {
          built.addSource("activity", {
            type: "geojson",
            data: activityFeatureCollection(marks, staleAfterSeconds),
          });
          built.addLayer({
            id: "activity",
            type: "circle",
            source: "activity",
            paint: {
              "circle-radius": 5,
              "circle-color": ["case", ["==", ["get", "stale"], 1], "#FFFFFF", "#5223E0"],
              "circle-stroke-width": 2,
              "circle-stroke-color": "#5223E0",
            },
          });
        });

        /*
         * THE VISITS, NUMBERED — the top layer on the map, and the only one
         * that names a shop.
         *
         * Two layers over one source rather than an HTML marker apiece: a
         * marker is bound to the map and would have to be torn down and
         * rebuilt on every delta, while a source takes `setData` and repaints.
         * It is also what keeps the numbers on top of everything — MapLibre
         * draws in the order layers were added, and these are added last.
         *
         * The number is drawn with `allow-overlap` and `ignore-placement` on
         * purpose. MapLibre's default is to drop a label that collides with
         * another, which on a beat where two shops are next door would silently
         * take a number off the map and leave a dot that says nothing — the
         * failure this whole layer exists to end, arriving from the other side.
         */
        upsert("visits", visitFeatureCollection(visits, staleAfterSeconds), () => {
          built.addSource("visits", {
            type: "geojson",
            data: visitFeatureCollection(visits, staleAfterSeconds),
          });
          built.addLayer({
            id: "visits",
            type: "circle",
            source: "visits",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 9, 16, 12],
              "circle-color": ["case", ["==", ["get", "stale"], 1], "#FFFFFF", "#5223E0"],
              /* A white ring, because a violet disc on the violet end of a
                 trail is the same shape twice. */
              "circle-stroke-width": 2,
              "circle-stroke-color": ["case", ["==", ["get", "stale"], 1], "#5223E0", "#FFFFFF"],
            },
          });
          built.addLayer({
            id: "visit-labels",
            type: "symbol",
            source: "visits",
            layout: {
              "text-field": ["get", "seq"],
              "text-size": 11,
              "text-allow-overlap": true,
              "text-ignore-placement": true,
            },
            paint: {
              "text-color": ["case", ["==", ["get", "stale"], 1], "#5223E0", "#FFFFFF"],
            },
          });
        });
        setVisitLayersVisible(built, showVisitsRef.current);
      }

      built.on("style.load", drawOverlays);

      /*
       * THE PINS AND THE FIRST FIT RUN OFF `style.load`, NOT `load`.
       *
       * `load` fires when the map considers itself fully loaded — style,
       * sources and the first frame — and against Ola's style it never fires
       * at all. Its own style JSON declares a layer over a source layer that
       * does not exist (`3d_model` on `vectordata`, which MapLibre reports as
       * an error on every single load), and the map never reaches the state
       * where it calls itself loaded.
       *
       * Everything attached to `load` therefore never ran: not one salesman
       * marker, and not the initial `fitBounds`. That is why the map opened
       * on the whole of Bangalore with the day's trail a few pixels wide
       * somewhere in the middle — the trail itself drew correctly, because
       * `drawOverlays` hangs off `style.load`, which does fire.
       *
       * So this hangs off the same event the trail does. It has to be
       * idempotent, because `style.load` fires again on every Map/Satellite
       * switch: the markers are torn down and rebuilt rather than added a
       * second time, and the fit only runs the FIRST time, so toggling
       * satellite does not yank the camera back from wherever somebody has
       * panned to.
       */
      let fittedOnce = false;
      function placePinsAndFit() {
        /* THE LATEST PINS, not the ones this closure was created with — see
           `frame`. The markers are torn down and rebuilt rather than moved
           because that is what already made a style switch idempotent, and a
           poll is the same problem: whoever has stopped reporting has to lose
           his pin, and whoever has started has to gain one. */
        const { pinned, points } = frame.current;

        for (const el of markerMap.values()) el.remove();
        markerMap.clear();

        /* One marker per salesman who has a fix. HTML rather than a symbol
           layer, because the initials and the colour are the same two things
           the team list shows and they should not be built twice. */
        for (const r of pinned) {
          const el = document.createElement("div");
          el.className =
            "flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white shadow-[0_1px_4px_rgba(22,22,22,0.4)] transition-shadow";
          el.style.background = r.checkOutAt ? "#8A8F98" : r.seenAt ? "#5223E0" : "#C0392B";
          el.textContent = r.initials;
          new maplibregl.Marker({ element: el })
            .setLngLat([r.lng as number, r.lat as number])
            .setPopup(
              new maplibregl.Popup({ closeButton: false, offset: 16 }).setText(
                `${r.salesmanName}${r.place ? ` · ${r.place}` : ""}${
                  r.accuracyM ? ` · ±${r.accuracyM} m` : ""
                }`,
              ),
            )
            .addTo(built);
          markerMap.set(r.salesmanId, el);
          /* THE RING GOES BACK ON. Every marker here is a new element, so the
             selection highlight applied by the effect below is on a node that
             no longer exists — without this, picking somebody and then waiting
             thirty seconds silently deselected them on the map while the team
             list went on showing them picked. */
          highlightMarker(el, r.salesmanId === selectedIdRef.current);
        }

        /* NEVER REFIT ON A POLL. The first draw frames the day; after that the
           camera belongs to whoever is looking at it, and yanking a manager
           back to the whole team every thirty seconds while he is reading one
           lane is the one thing that would make this screen unusable. */
        if (fittedOnce || !points.length) return;
        fittedOnce = true;
        /* FIT, never fill. One pin gets a sensible zoom instead of a rooftop. */
        const box = points.reduce(
          (b, p) => b.extend(p),
          new maplibregl.LngLatBounds(points[0], points[0]),
        );
        built.fitBounds(box, { padding: 56, maxZoom: MAX_FIT_ZOOM, animate: false });
      }

      built.on("style.load", placePinsAndFit);

      /*
       * AND RUN THEM NOW IF THE STYLE IS ALREADY UP.
       *
       * `style` used to be a URL, which MapLibre fetches — so the style was
       * always still loading when these listeners were attached a line later,
       * and `style.load` was always ahead of them. Handing it a style OBJECT
       * instead, which is what stripping Ola's bad layer requires, means it
       * can be applied synchronously inside the constructor: the event has
       * already fired by the time anything is listening, and every listener
       * waits for a second one that never comes.
       *
       * The whole map went blank on that — no trail, no pins, no fit, and
       * then "the map could not be drawn" fifteen seconds later from the
       * timeout, which is a real failure message for a map that had loaded
       * perfectly. Asking the map its state rather than trusting the ordering
       * costs one call and does not care which way round it happened.
       */
      if (built.isStyleLoaded()) {
        drawOverlays();
        placePinsAndFit();
      }

      /*
       * AND THIS IS WHAT A POLL CALLS. The two drawing functions have to stay
       * inside this effect — they close over the map instance, its load
       * timeout and its marker map, none of which outlive it — so the effect
       * that hears about new data reaches them through a ref rather than the
       * other way round. Set last, so nothing can call a half-built map.
       */
      redraw.current = () => {
        if (!built.isStyleLoaded()) return;
        drawOverlays();
        placePinsAndFit();
      };
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(build);
      clearTimeout(loadTimeout);
      redraw.current = null;
      drawnTrails.current = [];
      m?.remove();
      map.current = null;
      markerMap.clear();
    };
    /*
     * BUILT ONCE, AND REMOUNTED WHEN THE DATA CHANGES.
     *
     * These deps were `[view, rows, tracks, activity]`, and `rows` and the
     * rest are fresh arrays on every render — so the effect tore the map down
     * and built it again on a loop, and what reached the screen was whichever
     * half of that it caught. The house rule covers this: do not re-run on a
     * prop change, give the component a `key` and let it remount. The page
     * keys it on the day and the view, which are the only two things that can
     * change without a navigation. What DOES belong here is `hasAnything`:
     * with nothing to place there is no map to build, and this has to run
     * again on the poll that first brings a position — see the note at the
     * top of the effect.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAnything]);

  /*
   * Map / satellite is a property of the STYLE, so switching it calls
   * `setStyle` rather than rebuilding the map — the same reasoning as the
   * selection effect below: rebuilding would refetch everything for one
   * click. `setStyle` fires `style.load` again, which is what re-draws the
   * trail and activity layers it just threw away (see `drawOverlays`).
   *
   * The skip-on-mount guard matters here specifically: `styleMode` starts at
   * `"map"`, the same style the building effect already constructs the map
   * with, so running this on mount would call `setStyle` a second time on a
   * style that had not finished loading yet — a real style reload for
   * nothing, not just a wasted call.
   */
  const mountedStyleEffect = React.useRef(false);
  React.useEffect(() => {
    if (!mountedStyleEffect.current) {
      mountedStyleEffect.current = true;
      return;
    }
    const built = map.current;
    if (!built || !apiKey) return;
    void olaMapsStyle(styleMode, apiKey)
      .then((clean) => built.setStyle(clean as maplibregl.StyleSpecification))
      .catch(() => built.setStyle(olaMapsStyleUrl(styleMode)));
    /* `apiKey` cannot change without the whole component being keyed anew —
       it is read once, server-side, per page — so it is not a reason to
       re-run and swap the style out from under somebody. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleMode]);

  /*
   * THE SHOPS AROUND THE TEAM, FETCHED WHEN THE TEAM IS SOMEWHERE NEW.
   *
   * Not a prop, because this page re-runs its Server Component every thirty
   * seconds and the shops would ride down inside each of those answers to
   * move a handful of pins — see `/api/sales/book-pins`.
   *
   * `catchmentKey` is what decides when to ask again, and it is deliberately
   * COARSE: the positions themselves change on every poll, and refetching a
   * ten-kilometre catchment because somebody walked forty metres is a
   * request a minute for the same answer. Rounded to about five kilometres,
   * it changes when a man reaches a genuinely different part of the map, or
   * when somebody who had no fix this morning reports one — which are the
   * two moments the catchment really is somewhere else.
   *
   * A failure is silent and costs the shops, never the day. The trail, the
   * pins and the team list are all unaffected by it, and a manager looking
   * at where his salesmen are should not be shown an error about the
   * backdrop they are drawn on.
   */
  const centres = pinned.map((r) => ({ lat: r.lat as number, lng: r.lng as number }));
  const catchmentKey = [
    ...new Set(centres.map((c) => `${c.lat.toFixed(1)},${c.lng.toFixed(1)}`)),
  ]
    .sort()
    .join("|");
  React.useEffect(() => {
    /* No key means no map to draw them on — see the state below. Nobody with
       a fix means nothing to be near, and the route reads that the same way
       rather than answering with the whole book. */
    if (!apiKey || !catchmentKey) return;
    let cancelled = false;
    const near = centres.map((c) => `${c.lat},${c.lng}`).join("|");
    fetch(`/api/sales/book-pins?near=${encodeURIComponent(near)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { pins: ShopPin[]; radiusKm: number } | null) => {
        /* A NULL BODY is the request having failed; an EMPTY list is a real
           answer — the team has moved somewhere with nothing of ours around
           it. Treating the two alike would leave the morning's shops drawn
           around a man who is now forty kilometres away. */
        if (cancelled || !body?.pins) return;
        bookRef.current = body.pins;
        setBook(body.pins);
        setRadiusKm(body.radiusKm);
        /* If the map is already up, its `style.load` has been and gone and
           `drawOverlays` ran with an empty book — so the layers are added
           here instead. Every later style switch re-adds them from the ref. */
        const built = map.current;
        if (!built?.isStyleLoaded()) return;
        /* A SECOND ANSWER REPLACES THE FIRST rather than being dropped. The
           catchment moves when the team does, and a `getSource` guard alone
           would leave the morning's shops on the map for the rest of the
           day — the layers exist, so nothing would look wrong. */
        const existing = built.getSource("book") as maplibregl.GeoJSONSource | undefined;
        if (existing) {
          existing.setData(bookPinFeatures(body.pins));
        } else if (body.pins.length) {
          addBookPinLayers(built, {
            features: bookPinFeatures(body.pins),
            visible: showBookRef.current,
            /* UNDERNEATH THE DAY, however late it arrives. `drawOverlays`
               adds the book before the trail because it is drawn first;
               added here it is drawn LAST, which would put a few thousand
               shops over the line they are meant to be the ground for. So
               it goes in beneath the lowest layer this file owns. */
            beforeId: lowestOwnLayer(built),
          });
        }
      })
      .catch(() => {
        /* The map draws exactly as it did before the book existed. */
      });
    return () => {
      cancelled = true;
    };
    /* `centres` is a fresh array on every render and `apiKey` is read once,
       server-side, per page. The rounded key is the only thing here that
       carries a real change. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catchmentKey]);

  /* Showing and hiding moves visibility on the map that already exists,
     rather than rebuilding it — the same imperative-ref pattern the
     selection highlight below uses. The ref is what `drawOverlays` reads on
     a style switch, so a hidden book stays hidden across one. */
  React.useEffect(() => {
    showBookRef.current = showBook;
    const built = map.current;
    if (built) setBookPinsVisible(built, showBook);
  }, [showBook]);

  React.useEffect(() => {
    showVisitsRef.current = showVisits;
    const built = map.current;
    if (built) setVisitLayersVisible(built, showVisits);
  }, [showVisits]);

  /*
   * A MAP THAT HAS JUST BEEN GIVEN THE WHOLE WINDOW HAS TO BE TOLD.
   *
   * MapLibre watches its container and resizes itself, so this is belt and
   * braces rather than the mechanism — but the resize it sees is a CSS change
   * with no layout event behind it, and a canvas left at the old size draws a
   * fullscreen map into a third of the screen. It costs one call.
   */
  React.useEffect(() => {
    map.current?.resize();
  }, [fullscreen]);

  /*
   * Picking somebody in the team list moves the CAMERA on the map that
   * already exists — it does not rebuild it. Rebuilding would refetch the
   * style and every tile in view for one click, and it would throw away the
   * animation that is the whole point of "point me at them". This is the
   * imperative half of that: the map is a library instance behind a ref, and
   * a ref changing is exactly what an effect is for.
   *
   * Deselecting gives the view back to `fitBounds` over every point being
   * shown, which is the same call the map was built with — so leaving nobody
   * selected always reads the same as never having selected anybody.
   */
  React.useEffect(() => {
    const built = map.current;
    if (!built) return;

    for (const [id, el] of markers.current) highlightMarker(el, id === selectedId);

    if (selectedId) {
      const row = pinned.find((r) => r.salesmanId === selectedId);
      if (row) built.flyTo({ center: [row.lng as number, row.lat as number], zoom: 16 });
      return;
    }

    if (!points.length) return;
    const box = points.reduce(
      (b, p) => b.extend(p),
      new maplibregl.LngLatBounds(points[0], points[0]),
    );
    built.fitBounds(box, { padding: 56, maxZoom: MAX_FIT_ZOOM });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /*
   * The trail for whoever is picked, laid onto the road network — fetched
   * lazily, and only for them.
   *
   * Every other salesman's line stays the raw GPS trail the map was built
   * with. Snapping the whole team on every thirty-second poll would turn one
   * page load into dozens of calls to an outside service for lines nobody is
   * looking at; this asks for one, when a manager actually picks a name. If
   * no key is set, or the call fails, the raw line already drawn is exactly
   * what stays on screen — a failed snap is invisible, never a broken map.
   *
   * `snappedFor` remembers who has already been answered for this day, so
   * deselecting and reselecting the same name does not ask again.
   */
  /*
   * THE ROAD LINE, REMEMBERED — not merely pushed at the map once.
   *
   * `drawOverlays` builds each trail's source from the RAW fixes, and it runs
   * on `style.load`: on first paint, and again every time somebody toggles
   * Satellite. So a road line that was only ever `setData`'d into the source
   * lost twice over — overwritten by the next style load, and dropped
   * altogether whenever the fetch landed before the source it was written to
   * existed, which is a race the map won about as often as it lost.
   *
   * That is why the corrected line was not on screen even though the server
   * was returning it correctly. Held here, it survives both: `drawOverlays`
   * prefers it over the raw geometry, and a fetch that finishes early simply
   * has it waiting.
   */
  const roadLines = React.useRef(new Map<string, TripSegment[]>());
  /**
   * WHO HAS BEEN ASKED ABOUT, HOW BIG THEIR TRAIL WAS AND WHEN.
   *
   * It was a Set of "day and person", which answered "asked" once and for
   * ever — correct while the map was frozen at first paint and wrong the
   * moment it started redrawing, because `drawEverything` prefers the snapped
   * geometry over the raw fixes and nothing ever replaced it. A trail matched
   * at ten past nine would have stayed the line on screen all afternoon.
   *
   * The two numbers are what make re-asking affordable: a request goes only
   * where the trail has actually GROWN, and then at most once every
   * `SNAP_REFRESH_MS` — so a poll that brought nothing costs nothing, and a
   * man walking all morning costs a few requests an hour rather than two a
   * minute. Written at REQUEST time and not on the answer, so a slow call
   * cannot be fired again by the poll behind it, and a failed one waits its
   * turn instead of retrying every thirty seconds.
   */
  const snappedFor = React.useRef(new Map<string, { points: number; atMs: number }>());
  /* Stable across the thirty-second poll: `tracks` is a fresh Map every time,
     but WHO is on it rarely changes, and who is on it is all this needs. */
  const trailIds = [...tracks.keys()].sort().join(",");
  /* How much of each trail has arrived, which is the half that DOES change on
     a poll — the effect has to wake up for it, and the guard inside decides
     whether that is worth a request. */
  const trailSizes = [...tracks.entries()]
    .map(([id, ps]) => `${id}:${ps.length}`)
    .sort()
    .join(",");
  React.useEffect(() => {
    if (view !== "today" || !trailIds || !mapReady) return;
    const built = map.current;
    if (!built) return;

    let cancelled = false;
    /*
     * EVERY trail on screen, not only a selected one.
     *
     * It was gated on selection because snapping meant one request per fifty
     * FIXES — a working day was around a hundred calls, and the whole team on
     * every poll was out of the question. The road path is asked for in
     * twenty-metre anchors now, so a day is two or three requests and a team
     * is under ten, once per page rather than per poll. The reason for the
     * gate was cost, and the cost is gone.
     *
     * It mattered because the gate was invisible: the default view drew raw
     * GPS cutting across blocks, and the corrected line only appeared if you
     * happened to click a name. Nothing said so.
     */
    for (const id of trailIds.split(",")) {
      const cacheKey = `${day}:${id}`;
      const points = tracks.get(id)?.length ?? 0;
      const asked = snappedFor.current.get(cacheKey);
      /* Nothing new to match, or matched recently enough — see `snappedFor`. */
      if (asked && (points <= asked.points || Date.now() - asked.atMs < SNAP_REFRESH_MS)) {
        continue;
      }
      snappedFor.current.set(cacheKey, { points, atMs: Date.now() });
      void fetchRoadLine(id);
    }

    function fetchRoadLine(id: string) {
      return fetch(
        `/api/sales/live/snap-trail?salesmanId=${encodeURIComponent(id)}&day=${encodeURIComponent(day)}`,
      )
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { segments: TripSegment[] | null } | null) => {
        if (cancelled || !body?.segments?.length) return;
        roadLines.current.set(id, body.segments);
        const source = built!.getSource(`trail-${id}`) as maplibregl.GeoJSONSource | undefined;
        /*
         * DRAWN AS SENT. The server cut the day into trips, kept every gap
         * straight, and road-matched only the confident runs — see the route.
         * There is nothing left to re-derive here, and that is the point: a
         * road-following line has as many points as the road has corners, so
         * it can never be paired back up with the raw fixes one for one the
         * way a plain snap could. The timestamps stay where they already are.
         */
        source?.setData(trailFeatureCollection(body.segments));
      })
      .catch(() => {
        /* The raw trail stays exactly as drawn. */
      });
    }

    return () => {
      cancelled = true;
    };
    /* `tracks` is a fresh Map on every render and says nothing by being one;
       `trailSizes` is what actually changes when fixes arrive, and the guard
       above is what decides whether a change is worth a request. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailIds, trailSizes, day, view, mapReady]);

  if (!apiKey) {
    return (
      <Frame key="no-key" fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen}>
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">
            {keysSpent ? "Every Ola Maps key has run out" : "The map needs a key"}
          </p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            {keysSpent
              ? "Ola has refused every key held for quota, so there are no streets to draw until one of them resets at the start of the month or another is added in Admin Console → Platform → Maps."
              : "Add an Ola Maps key in Admin Console → Platform → Maps to draw the streets under this."}{" "}
            The team list beside this still shows everything that is known —
            nobody&rsquo;s position is lost, only the picture of it.
          </p>
        </div>
      </Frame>
    );
  }

  if (failed) {
    return (
      <Frame key="failed" fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen}>
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">The map could not be drawn</p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            The tiles did not load, or this browser cannot draw them. The positions are still
            recorded — nothing here is lost, and the team list beside this is unaffected.
          </p>
        </div>
      </Frame>
    );
  }

  return (
    <Frame key="map" fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen}>
      {/*
        THE HOST IS ALWAYS MOUNTED, and "nothing to place yet" is drawn OVER it
        rather than instead of it.

        It used to replace this div entirely, which made the empty state
        permanent: the build effect returns early with nothing to place, and
        when the first position arrived on a later poll the component
        re-rendered with a host div that no effect was ever going to run
        against again. Opening the Live map before anybody had checked in meant
        no map for the rest of the day. The message sits on top now, the div
        underneath it stays put, and the effect builds the map the moment there
        is something to draw.
      */}
      <div ref={host} className="h-full w-full" />
      {!hasAnything ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">Nothing to place yet</p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            No handset has sent a position {view === "today" ? "today" : "yet"}, so there is
            nothing to draw. Everybody is still listed beside this, with what is known about
            each of them.
          </p>
        </div>
      ) : null}
      {/* THE STREETS ARE THERE AND THE DAY IS NOT — said plainly, because the
          alternative is an empty map that reads as a salesman who did not
          move. It is not the failure frame above: that one is for a map that
          never drew at all, and calling this one that would be the same
          overstatement as flipping `failed` on any MapLibre error. */}
      {overlaysFailed ? (
        <div className="absolute top-2 right-2 left-2 z-20 mx-auto max-w-[520px] rounded-[6px] border border-line bg-surface/95 px-3 py-2 text-[12px] text-[#B3261E] shadow-[0_1px_4px_rgba(22,22,22,0.15)]">
          The streets drew, the day did not — the trail, the stops and the work could not be
          put on this map. Every position is still recorded and the team list beside this is
          unaffected; reloading the page is worth one try.
        </div>
      ) : null}
      <OlaMapsStyleSwitcher mode={styleMode} onChange={setStyleMode} />
      {/* The catchment's own legend, stacked under the style switcher rather
          than beside it — both anchored top-left read as one cluster of map
          controls, and MapLibre's zoom sits top-right. Drawn only once there
          is something to say: an empty legend beside an empty map is
          furniture.

          IT NAMES THE RADIUS, because a count on its own invites the wrong
          reading. "412 shops" beside a map reads as the book; "within 10 km
          of the team" says what it actually is, which is the half somebody
          would otherwise have to be told. */}
      {book.length || visits.length ? (
        <div className="absolute top-11 left-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[6px] border border-line bg-surface/95 px-3 py-2 text-[12px] text-ink shadow-[0_1px_4px_rgba(22,22,22,0.15)]">
          {/* THE VISITS FIRST, because they are the day and the shops are the
              ground it is read against. The count is what is PINNED: a visit
              made where the handset could get no fix is on no map, and a legend
              claiming otherwise would have somebody counting dots against the
              Visits screen and finding one missing. */}
          {visits.length ? (
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={showVisits}
                onChange={(e) => setShowVisits(e.target.checked)}
              />
              <span
                className="inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[9px] font-semibold text-white"
                style={{ background: "#5223E0" }}
                aria-hidden
              >
                1
              </span>
              Visits pinned ({visits.length})
            </label>
          ) : null}
          {book.length ? (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showBook}
              onChange={(e) => setShowBook(e.target.checked)}
            />
            {radiusKm
              ? `Within ${radiusKm} km of the team (${book.length})`
              : `Nearby shops (${book.length})`}
          </label>
          ) : null}
          {(["customer", "lead", "third", "closed"] as BookPinTone[])
            .filter((tone) => bookCounts[tone] > 0)
            .map((tone) => (
              <span key={tone} className="flex items-center gap-1.5 text-muted">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: BOOK_PIN_COLOUR[tone] }}
                />
                {BOOK_PIN_LABEL[tone]} ({bookCounts[tone]})
              </span>
            ))}
        </div>
      ) : null}
      {/* The same drawer Territory's map opens, from the same two reads the
          CRM record page makes — so a figure read off a pin here and one
          read off a pin there are one answer. */}
      <CustomerQuickView customerId={selectedShopId} onClose={() => setSelectedShopId(null)} />
    </Frame>
  );
}

/**
 * One shape for the map and the state that replaces it.
 *
 * **Fullscreen is a HEIGHT here and a layout in `live-panel.tsx`.** The panel
 * is what takes the window; this only has to stop imposing a height on itself,
 * because the fixed `calc(100vh-280px)` is subtracting a header, a banner and a
 * paragraph that are not on the screen any more. `min-h` goes with it — a
 * minimum taller than the window is a map you have to scroll to see the bottom
 * of, which is the opposite of what the button was pressed for.
 */
function Frame({
  children,
  fullscreen,
  onToggleFullscreen,
}: {
  children: React.ReactNode;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <div
      className={
        "relative overflow-hidden border border-line bg-surface " +
        (fullscreen ? "h-full rounded-none" : "rounded-[6px]")
      }
    >
      <div
        className={
          "relative bg-[#F0F2F6] " +
          (fullscreen ? "h-full" : "h-[calc(100vh-280px)] min-h-[480px]")
        }
      >
        {children}
        {/* BOTTOM-RIGHT, on its own. The style switcher and the legend are one
            cluster of controls about WHAT is drawn, top-left, and MapLibre owns
            the top-right; this is about how much of the screen the map gets,
            which is neither. It lives in the frame rather than beside the
            legend so that it is there in every state — a map that could not be
            drawn at all is exactly when somebody wants the window back. */}
        <button
          type="button"
          onClick={onToggleFullscreen}
          title={fullscreen ? "Leave full screen (Esc)" : "Fill the window"}
          className="absolute right-2 bottom-8 z-10 inline-flex items-center gap-1.5 rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-body shadow-[0_1px_4px_rgba(22,22,22,0.25)] hover:bg-canvas"
        >
          <span aria-hidden>{fullscreen ? "\u2921" : "\u2922"}</span>
          {fullscreen ? "Exit full screen" : "Full screen"}
        </button>
      </div>
    </div>
  );
}
