"use client";

import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ProspectPin, ShopPin } from "@/lib/services/sales-service";
import { pinIndustryInfo } from "@/lib/field-customer-pin-labels";

/**
 * The territory table's own gap ("N of M shops have no coordinates") drawn as
 * a map — same OpenFreeMap renderer and "fit never fill, a pin only where
 * there is a fix" discipline as the Live map's `street-map.tsx`, built
 * separately rather than shared because the two draw different things: that
 * one tracks salesmen live, this one is a static read of the book.
 *
 * Two layers. Shops are real customers with a coordinate — clustered, since
 * the whole book can be a few thousand points. Prospects are field-collected
 * pins that never matched an existing customer: a shop the team has found,
 * not one MahekOne has a record of, drawn hollow so the two are never
 * mistaken for each other at a glance.
 */

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAX_FIT_ZOOM = 15;

const TONE_COLOUR: Record<string, string> = {
  positive: "#2E7D32",
  negative: "#8A8F98",
  neutral: "#C0392B",
};

export function ShopMap({ shops, prospects }: { shops: ShopPin[]; prospects: ProspectPin[] }) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const map = React.useRef<maplibregl.Map | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [showShops, setShowShops] = React.useState(true);
  const [showProspects, setShowProspects] = React.useState(true);

  const points: [number, number][] = [
    ...shops.map((s) => [s.lng, s.lat] as [number, number]),
    ...prospects.map((p) => [p.lng, p.lat] as [number, number]),
  ];
  const hasAnything = points.length > 0;

  React.useEffect(() => {
    if (!host.current || map.current || !hasAnything) return;

    let cancelled = false;
    let m: maplibregl.Map | null = null;

    const frame = requestAnimationFrame(() => {
      if (cancelled || !host.current) return;

      try {
        m = new maplibregl.Map({
          container: host.current,
          style: STYLE,
          center: [points[0][0], points[0][1]],
          zoom: 5,
          attributionControl: { compact: true },
        });
      } catch {
        setFailed(true);
        return;
      }

      const built = m;
      built.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      built.on("error", () => setFailed(true));
      map.current = built;

      built.on("load", () => {
        built
          .getContainer()
          .querySelector(".maplibregl-ctrl-attrib")
          ?.classList.remove("maplibregl-compact-show");

        if (shops.length) {
          built.addSource("shops", {
            type: "geojson",
            cluster: true,
            clusterRadius: 40,
            clusterMaxZoom: 13,
            data: {
              type: "FeatureCollection",
              features: shops.map((s) => ({
                type: "Feature" as const,
                properties: {
                  label: `${s.name} · ${s.city}${s.salesmanName ? ` · ${s.salesmanName}` : ""}`,
                },
                geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
              })),
            },
          });
          built.addLayer({
            id: "shops-clusters",
            type: "circle",
            source: "shops",
            filter: ["has", "point_count"],
            paint: {
              "circle-radius": ["step", ["get", "point_count"], 14, 25, 18, 100, 24],
              "circle-color": "#5223E0",
              "circle-opacity": 0.85,
            },
          });
          built.addLayer({
            id: "shops-cluster-count",
            type: "symbol",
            source: "shops",
            filter: ["has", "point_count"],
            layout: { "text-field": "{point_count_abbreviated}", "text-size": 11 },
            paint: { "text-color": "#FFFFFF" },
          });
          built.addLayer({
            id: "shops-points",
            type: "circle",
            source: "shops",
            filter: ["!", ["has", "point_count"]],
            paint: {
              "circle-radius": 5,
              "circle-color": "#5223E0",
              "circle-stroke-width": 2,
              "circle-stroke-color": "#FFFFFF",
            },
          });

          built.on("click", "shops-clusters", (e: maplibregl.MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (!f || f.geometry.type !== "Point") return;
            const geometry = f.geometry;
            const clusterId = f.properties?.cluster_id;
            const source = built.getSource("shops") as maplibregl.GeoJSONSource;
            if (clusterId == null) return;
            source.getClusterExpansionZoom(clusterId).then((zoom) => {
              built.easeTo({ center: geometry.coordinates as [number, number], zoom });
            });
          });
          built.on("click", "shops-points", (e: maplibregl.MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (!f) return;
            new maplibregl.Popup({ closeButton: false })
              .setLngLat(e.lngLat)
              .setText(String(f.properties?.label ?? ""))
              .addTo(built);
          });
          for (const id of ["shops-clusters", "shops-points"]) {
            built.on("mouseenter", id, () => (built.getCanvas().style.cursor = "pointer"));
            built.on("mouseleave", id, () => (built.getCanvas().style.cursor = ""));
          }
        }

        if (prospects.length) {
          built.addSource("prospects", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: prospects.map((p) => ({
                type: "Feature" as const,
                properties: {
                  label:
                    `${p.name}${p.territory ? ` · ${p.territory}` : ""} · not yet in the customer book` +
                    (p.industryLabel ? ` · ${p.industryLabel}` : ""),
                  tone: pinIndustryInfo(p.industryLabel).tone,
                },
                geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
              })),
            },
          });
          built.addLayer({
            id: "prospects-points",
            type: "circle",
            source: "prospects",
            paint: {
              "circle-radius": 5,
              "circle-color": "#FFFFFF",
              "circle-stroke-width": 2,
              "circle-stroke-color": [
                "match",
                ["get", "tone"],
                "positive",
                TONE_COLOUR.positive,
                "negative",
                TONE_COLOUR.negative,
                TONE_COLOUR.neutral,
              ],
            },
          });
          built.on("click", "prospects-points", (e: maplibregl.MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (!f) return;
            new maplibregl.Popup({ closeButton: false })
              .setLngLat(e.lngLat)
              .setText(String(f.properties?.label ?? ""))
              .addTo(built);
          });
          built.on("mouseenter", "prospects-points", () => (built.getCanvas().style.cursor = "pointer"));
          built.on("mouseleave", "prospects-points", () => (built.getCanvas().style.cursor = ""));
        }

        /* FIT, never fill. */
        const box = points.reduce(
          (b, p) => b.extend(p),
          new maplibregl.LngLatBounds(points[0], points[0]),
        );
        built.fitBounds(box, { padding: 40, maxZoom: MAX_FIT_ZOOM, animate: false });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      m?.remove();
      map.current = null;
    };
    /* Built once. See street-map.tsx's identical note — a `rows`-shaped prop
       is a fresh array every render, so this must not re-run on a prop
       change; the page does not currently re-render this component with
       different data after mount. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Layer toggles move visibility on the map that already exists, rather
     than rebuilding it — the same imperative-ref pattern street-map.tsx
     uses for the selected-salesman highlight. */
  React.useEffect(() => {
    const built = map.current;
    if (!built) return;
    const setVisible = (id: string, visible: boolean) => {
      if (built.getLayer(id)) {
        built.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    };
    setVisible("shops-clusters", showShops);
    setVisible("shops-cluster-count", showShops);
    setVisible("shops-points", showShops);
    setVisible("prospects-points", showProspects);
  }, [showShops, showProspects]);

  if (!hasAnything) {
    return (
      <Frame>
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">Nothing to place yet</p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            No shop has a coordinate, and no field-collected pin is waiting to be matched.
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
            The tiles did not load, or this browser cannot draw them. Nothing here is lost.
          </p>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <div ref={host} className="h-full w-full" />
      <div className="absolute left-3 top-3 flex gap-3 rounded-[6px] border border-line bg-surface/95 px-3 py-2 text-[12px] text-ink shadow-[0_1px_4px_rgba(22,22,22,0.15)]">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showShops}
            onChange={(e) => setShowShops(e.target.checked)}
          />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#5223E0" }} />
          Shops ({shops.length})
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showProspects}
            onChange={(e) => setShowProspects(e.target.checked)}
          />
          <span
            className="inline-block h-2.5 w-2.5 rounded-full border-2 bg-white"
            style={{ borderColor: TONE_COLOUR.neutral }}
          />
          Prospects ({prospects.length})
        </label>
      </div>
    </Frame>
  );
}

/** Same frame shape as the Live map's, so the two read as one family of screen. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="relative min-h-[320px] bg-[#F0F2F6]" style={{ aspectRatio: "2.4" }}>
        {children}
      </div>
    </div>
  );
}
