"use client";

import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { DwellStop } from "@/lib/engines/dwell";
import { splitTrailByGaps, type TrailSegment } from "@/lib/engines/trail-gaps";
import { splitTrailIntoTrips, tripColour } from "@/lib/engines/trail-trips";
import { clock, clockSeconds } from "@/lib/format";
import type { ActivityPoint, LastKnown, TrackPoint } from "@/lib/services/sales-service";
import { activityLabel } from "@/lib/mbos/activity-labels";
import {
  OlaMapsStyleSwitcher,
  olaMapsStyleUrl,
  olaMapsTransformRequest,
  type OlaMapsStyleMode,
} from "../ola-maps";

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
type TripSegment = TrailSegment & { trip: number; colour: string };

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
  dwellMinMinutes: number,
): TripSegment[] {
  return splitTrailIntoTrips(points, { gapMetres, dwellRadiusMetres, dwellMinMinutes }).flatMap(
    (trip) =>
      splitTrailByGaps(trip.points, gapMetres).map((s) => ({
        ...s,
        trip: trip.index,
        colour: tripColour(trip.index),
      })),
  );
}

function trailFeatureCollection(segments: TripSegment[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: segments.map((s) => ({
      type: "Feature",
      properties: { gap: s.gap, trip: s.trip, colour: s.colour },
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
function trailPaint(hovered: number | null) {
  return {
    colour: ["get", "colour"] as unknown as maplibregl.ExpressionSpecification,
    opacity:
      hovered === null
        ? 0.75
        : ([
            "case",
            ["==", ["get", "trip"], hovered],
            0.95,
            0.22,
          ] as unknown as maplibregl.ExpressionSpecification),
    width:
      hovered === null
        ? 3
        : ([
            "case",
            ["==", ["get", "trip"], hovered],
            5,
            2,
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

/** A ring round whoever the team list has picked, drawn above everybody else. */
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
  dwellMinMinutes,
  staleAfterSeconds,
  view,
  selectedId,
  apiKey,
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
  dwellMinMinutes: number;
  staleAfterSeconds: number;
  view: "now" | "today";
  /** Whoever is picked in the team list beside this — see the effect below. */
  selectedId: string | null;
  /** Ola Maps' key, read once server-side and handed down — see the doc comment above. */
  apiKey: string | null;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const map = React.useRef<maplibregl.Map | null>(null);
  const markers = React.useRef(new Map<string, HTMLDivElement>());
  /** Whether the map has ever finished its first real paint — see the load timeout below. */
  const loadedOnce = React.useRef(false);
  /** Which trip the cursor is over, or null. A ref — see the mousemove handler. */
  const hoveredTrip = React.useRef<number | null>(null);
  /*
   * The trails, reachable from an effect that must not re-run for them.
   *
   * `tracks` is a fresh Map on every render and the page refreshes itself on a
   * timer, so listing it as a dependency of the snap effect below would fire a
   * new snap request every tick. What that effect actually needs is the
   * CURRENT timestamps at the moment its fetch returns, which is what a ref
   * gives it — the identity of the Map is not the thing it cares about.
   */
  const tracksRef = React.useRef(tracks);
  React.useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);
  const [failed, setFailed] = React.useState(false);
  const [styleMode, setStyleMode] = React.useState<OlaMapsStyleMode>("map");

  const pinned = rows.filter((r) => r.lat != null && r.lng != null);
  const marks = view === "today" ? activity : [];
  const trails = view === "today" ? [...tracks.entries()] : [];
  const stops = view === "today" ? [...dwells.values()].flat() : [];

  /* Everything being shown, so the fit covers the whole day's travel in the
     `today` view rather than only where each person ended up. */
  const points: [number, number][] = [
    ...pinned.map((r) => [r.lng as number, r.lat as number] as [number, number]),
    ...trails.flatMap(([, ps]) => ps.map((p) => [p.lng, p.lat] as [number, number])),
    ...marks.map((a) => [a.lng, a.lat] as [number, number]),
  ];

  const hasAnything = points.length > 0;

  React.useEffect(() => {
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

    const frame = requestAnimationFrame(() => {
      if (cancelled || !host.current) return;

      try {
        m = new maplibregl.Map({
          container: host.current,
          style: olaMapsStyleUrl("map"),
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
      built.on("click", "activity", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setText(String(f.properties?.label ?? ""))
          .addTo(built);
      });
      built.on("mouseenter", "activity", () => (built.getCanvas().style.cursor = "pointer"));
      built.on("mouseleave", "activity", () => (built.getCanvas().style.cursor = ""));

      built.on("click", "dwells", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
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
          built.setPaintProperty(id, "line-opacity", paint.opacity);
          built.setPaintProperty(id, "line-width", paint.width);
        }
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
         * The map is provably working the moment its STYLE has loaded, which
         * is well before every tile in view has finished downloading — that
         * wait is what MapLibre's "load" event actually measures, and Ola
         * Maps serving a burst of dozens of tile/glyph/sprite requests on one
         * page can genuinely take longer than the load timeout to finish all
         * of them. Marking `loadedOnce` here, on the first `style.load`
         * rather than on the eventual `load`, is what keeps a merely slow
         * connection from reading as a broken map.
         */
        loadedOnce.current = true;
        clearTimeout(loadTimeout);

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

        /* The trail first, so pins and marks sit on top of it. */
        for (const [id, ps] of trails) {
          const segments = tripSegments(ps, gapMetres, dwellRadiusMetres, dwellMinMinutes);
          if (!segments.length) continue;
          built.addSource(`trail-${id}`, {
            type: "geojson",
            data: trailFeatureCollection(segments),
          });
          /* Two layers reading the same source, split by the `gap` property
             each feature carries — see `lib/engines/trail-gaps.ts`. A dashed
             line for a hop nobody has evidence for, solid for one dense
             enough to trust. */
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
          });
          built.addLayer({
            id: `trail-gap-${id}`,
            type: "line",
            source: `trail-${id}`,
            filter: ["==", ["get", "gap"], true],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              /* The gap keeps its trip's colour too — it is part of that
                 journey, just the part nobody recorded. */
              "line-color": trailPaint(null).colour,
              "line-width": 2,
              "line-opacity": 0.45,
              "line-dasharray": [2, 2],
            },
          });
        }

        /* Every real fix, hoverable for its exact time — see
           `trailPointsFeatureCollection`. Sits on top of the lines just
           added, below the dwell rings and activity dots that follow. */
        if (trails.length) {
          built.addSource("trail-points", {
            type: "geojson",
            data: trailPointsFeatureCollection(trails),
          });
          built.addLayer({
            id: "trail-points",
            type: "circle",
            source: "trail-points",
            paint: {
              "circle-radius": 3,
              "circle-color": "#5223E0",
              "circle-stroke-width": 1,
              "circle-stroke-color": "#ffffff",
            },
          });
        }

        /* Where a trail stood still — a bigger, hollow ring rather than the
           activity dot above, so a stop reads as "paused here" and not as a
           third kind of visit. */
        if (stops.length) {
          built.addSource("dwells", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: stops.map((s) => ({
                type: "Feature" as const,
                properties: {
                  label: `Stopped ${formatMinutes(s.minutes)} · ${clock(s.startAt)}–${clock(s.endAt)}`,
                },
                geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
              })),
            },
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
        }

        /* The work, marked where it was done. An order taken two kilometres
           off the beat is obvious on a line and invisible in a list. */
        if (marks.length) {
          built.addSource("activity", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: marks.map((a) => ({
                type: "Feature" as const,
                properties: {
                  label: `${activityLabel(a.entityType)}${
                    a.accuracyM ? ` · ±${a.accuracyM} m` : ""
                  }`,
                  // A stale fix is drawn hollow rather than hidden: the act is
                  // certain and only its place is not.
                  stale: (a.ageSeconds ?? 0) > staleAfterSeconds ? 1 : 0,
                },
                geometry: { type: "Point" as const, coordinates: [a.lng, a.lat] },
              })),
            },
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
        }
      }

      built.on("style.load", drawOverlays);

      built.on("load", () => {
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
        }

        /* FIT, never fill. One pin gets a sensible zoom instead of a rooftop. */
        const box = points.reduce(
          (b, p) => b.extend(p),
          new maplibregl.LngLatBounds(points[0], points[0]),
        );
        built.fitBounds(box, { padding: 56, maxZoom: MAX_FIT_ZOOM, animate: false });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(loadTimeout);
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
     * change without a navigation.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    map.current?.setStyle(olaMapsStyleUrl(styleMode));
  }, [styleMode]);

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
  const snappedFor = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!selectedId || view !== "today") return;
    const built = map.current;
    if (!built) return;

    const cacheKey = `${day}:${selectedId}`;
    if (snappedFor.current.has(cacheKey)) return;

    let cancelled = false;
    fetch(
      `/api/sales/live/snap-trail?salesmanId=${encodeURIComponent(selectedId)}&day=${encodeURIComponent(day)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { points: { lat: number; lng: number }[] | null } | null) => {
        if (cancelled || !body?.points || body.points.length < 2) return;
        snappedFor.current.add(cacheKey);
        const source = built.getSource(`trail-${selectedId}`) as maplibregl.GeoJSONSource | undefined;
        /* Snapping relocates each real fix onto its nearest road and returns
           exactly one point per fix (see `road-snap-service.ts`) — it never
           fills a gap with an invented path — so the SAME gap threshold
           still applies to the snapped points, one-for-one with the raw
           ones. A gap does not become confident just because its two ends
           each moved a few metres onto a road. */
        /* The snapped points carry no clock of their own, and a trip boundary
           is a question about TIME as much as distance — a stop is a place
           held for minutes. They are one-for-one with the raw fixes, so each
           takes its own fix's timestamp back; if that ever stops being true
           the trail is left unsnapped rather than paired up wrongly, because
           a mismatched pairing would move every boundary silently. */
        const raw = tracksRef.current.get(selectedId) ?? [];
        if (raw.length !== body.points.length) return;
        const timed = body.points.map((p, i) => ({ ...p, at: raw[i].at }));
        source?.setData(
          trailFeatureCollection(
            tripSegments(timed, gapMetres, dwellRadiusMetres, dwellMinMinutes),
          ),
        );
      })
      .catch(() => {
        /* The raw trail stays exactly as drawn. */
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, day, view, gapMetres, dwellRadiusMetres, dwellMinMinutes]);

  if (!apiKey) {
    return (
      <Frame key="no-key">
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">The map needs a key</p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            Add an Ola Maps key in Admin Console → Platform → Maps to draw the streets under
            this. The team list beside this still shows everything that is known —
            nobody&rsquo;s position is lost, only the picture of it.
          </p>
        </div>
      </Frame>
    );
  }

  if (!hasAnything) {
    return (
      <Frame key="empty">
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">Nothing to place yet</p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            No handset has sent a position {view === "today" ? "today" : "yet"}, so there is
            nothing to draw. Everybody is still listed beside this, with what is known about
            each of them.
          </p>
        </div>
      </Frame>
    );
  }

  if (failed) {
    return (
      <Frame key="failed">
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
    <Frame key="map">
      <div ref={host} className="h-full w-full" />
      <OlaMapsStyleSwitcher mode={styleMode} onChange={setStyleMode} />
    </Frame>
  );
}

/** One shape for the map and both of the states that replace it. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="relative h-[calc(100vh-280px)] min-h-[480px] bg-[#F0F2F6]">{children}</div>
    </div>
  );
}
