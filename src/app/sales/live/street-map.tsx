"use client";

import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ActivityPoint, LastKnown, TrackPoint } from "@/lib/services/sales-service";
import { activityLabel } from "@/lib/mbos/activity-labels";

/**
 * The map, with streets under it.
 *
 * It used to be pins on a bare grid, and the reason was written into the file:
 * streets would mean "sending the coordinates of Mahek's salesmen to whoever
 * supplies them, on every render, plus a key and a bill". Two of those three
 * turned out not to be true of every supplier.
 *
 * **OpenFreeMap needs no key, no account and no bill**, and it sets no usage
 * limit — so the cost side of that argument is gone. What is left is the
 * privacy one, and it is smaller than the old comment claimed: THE PINS ARE
 * DRAWN HERE, from data that never leaves MahekOne. A tile server is asked for
 * squares of map, so what it learns is roughly which part of India is being
 * looked at, not where anybody is standing. That is a real signal and not
 * nothing — the viewport does centre on the team — but it is not the team's
 * coordinates, which is what the old note implied.
 *
 * **The renderer is MapLibre and the supplier is a URL.** That is deliberate:
 * if OpenFreeMap stops, or its coverage of a beat turns out to be thin, the
 * style URL below is the only thing that changes. Choosing a supplier's own
 * SDK would have made moving a rewrite instead of an edit.
 *
 * **The bare-grid rules survive the change.** A pin is drawn only where there
 * is a fix — nobody is placed by arithmetic, and somebody with no position is
 * in the team list saying so and nowhere on this map. The view fits the data
 * rather than filling the canvas.
 */

/* No key, no account, no limit. See the note above before swapping it. */
const STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** Enough that a single pin does not open zoomed to the rooftop. */
const MAX_FIT_ZOOM = 15;

export function StreetMap({
  rows,
  tracks,
  activity,
  staleAfterSeconds,
  view,
}: {
  rows: LastKnown[];
  tracks: Map<string, TrackPoint[]>;
  activity: ActivityPoint[];
  staleAfterSeconds: number;
  view: "now" | "today";
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const map = React.useRef<maplibregl.Map | null>(null);
  const [failed, setFailed] = React.useState(false);

  const pinned = rows.filter((r) => r.lat != null && r.lng != null);
  const marks = view === "today" ? activity : [];
  const trails = view === "today" ? [...tracks.entries()] : [];

  /* Everything being shown, so the fit covers the whole day's travel in the
     `today` view rather than only where each person ended up. */
  const points: [number, number][] = [
    ...pinned.map((r) => [r.lng as number, r.lat as number] as [number, number]),
    ...trails.flatMap(([, ps]) => ps.map((p) => [p.lng, p.lat] as [number, number])),
    ...marks.map((a) => [a.lng, a.lat] as [number, number]),
  ];

  const hasAnything = points.length > 0;

  React.useEffect(() => {
    if (!host.current || map.current || !hasAnything) return;

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

    const frame = requestAnimationFrame(() => {
      if (cancelled || !host.current) return;

      try {
        m = new maplibregl.Map({
          container: host.current,
          style: STYLE,
          center: [points[0][0], points[0][1]],
          zoom: 11,
          // Attribution is a condition of using OpenFreeMap, and the style
          // carries the OpenStreetMap credit it is built from.
          attributionControl: { compact: true },
        });
      } catch {
        // WebGL unavailable — an old machine, or a locked-down browser.
        setFailed(true);
        return;
      }

      const built = m;
      built.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      built.on("error", () => setFailed(true));
      map.current = built;

      built.on("load", () => {
      /* The trail first, so pins and marks sit on top of it. */
      for (const [id, ps] of trails) {
        if (ps.length < 2) continue;
        built.addSource(`trail-${id}`, {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: ps.map((p) => [p.lng, p.lat]) },
          },
        });
        built.addLayer({
          id: `trail-${id}`,
          type: "line",
          source: `trail-${id}`,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#5223E0", "line-width": 3, "line-opacity": 0.75 },
        });
      }

      /* The work, marked where it was done. An order taken two kilometres off
         the beat is obvious on a line and invisible in a list. */
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
      }

      /* One marker per salesman who has a fix. HTML rather than a symbol
         layer, because the initials and the colour are the same two things
         the team list shows and they should not be built twice. */
      for (const r of pinned) {
        const el = document.createElement("div");
        el.className =
          "flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white shadow-[0_1px_4px_rgba(22,22,22,0.4)]";
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
      m?.remove();
      map.current = null;
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

  if (!hasAnything) {
    return (
      <Frame>
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
      <Frame>
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
    <Frame>
      <div ref={host} className="h-full w-full" />
    </Frame>
  );
}

/** One shape for the map and both of the states that replace it. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="relative min-h-[320px] bg-[#F0F2F6]" style={{ aspectRatio: "2.4" }}>
        {children}
      </div>
    </div>
  );
}
