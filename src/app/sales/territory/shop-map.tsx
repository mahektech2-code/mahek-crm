"use client";

import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ProspectPin, ShopPin } from "@/lib/services/sales-service";
import { pinIndustryInfo } from "@/lib/field-customer-pin-labels";
import {
  OlaMapsStyleSwitcher,
  olaMapsStyleUrl,
  olaMapsTransformRequest,
  type OlaMapsStyleMode,
} from "../ola-maps";
import { CustomerQuickView } from "./customer-quick-view";

/**
 * The territory table's own gap ("N of M shops have no coordinates") drawn as
 * a map — same Ola Maps renderer, key and "fit never fill, a pin only where
 * there is a fix" discipline as the Live map's `street-map.tsx`, built
 * separately rather than shared because the two draw different things: that
 * one tracks salesmen live, this one is a static read of the book. What IS
 * shared is `../ola-maps.tsx` — the style URLs, the authenticating
 * `transformRequest` and the Map/Satellite switcher — because two Ola Maps
 * instances quietly disagreeing about how to authenticate is worse than one
 * shared answer.
 *
 * Two layers. Shops are real customers with a coordinate — clustered, since
 * the whole book can be a few thousand points. Prospects are field-collected
 * pins that never matched an existing customer: a shop the team has found,
 * not one MahekOne has a record of, drawn hollow so the two are never
 * mistaken for each other at a glance.
 *
 * A shop pin opens `customer-quick-view.tsx` — a real record, so it gets the
 * record, read through `/api/sales/customer-quick-view` from the same two
 * functions (`getCustomer`, `customerInformation`) the CRM's own record page
 * reads, so a figure shown here can never disagree with the CRM's answer for
 * the same account. A prospect pin keeps the plain text popup it always had:
 * there is no customer record behind it yet, only the name, territory and
 * industry already in the label.
 */

const MAX_FIT_ZOOM = 15;

const TONE_COLOUR: Record<string, string> = {
  positive: "#2E7D32",
  negative: "#8A8F98",
  neutral: "#C0392B",
};

export function ShopMap({
  shops,
  prospects,
  apiKey,
}: {
  shops: ShopPin[];
  prospects: ProspectPin[];
  /** Ola Maps' key, read once server-side and handed down — see `street-map.tsx`'s doc comment. */
  apiKey: string | null;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const map = React.useRef<maplibregl.Map | null>(null);
  /** Whether the map has ever finished its first real paint — see the load timeout below. */
  const loadedOnce = React.useRef(false);
  const [failed, setFailed] = React.useState(false);
  const [showShops, setShowShops] = React.useState(true);
  const [showProspects, setShowProspects] = React.useState(true);
  const [styleMode, setStyleMode] = React.useState<OlaMapsStyleMode>("map");
  const [selectedShopId, setSelectedShopId] = React.useState<string | null>(null);

  const points: [number, number][] = [
    ...shops.map((s) => [s.lng, s.lat] as [number, number]),
    ...prospects.map((p) => [p.lng, p.lat] as [number, number]),
  ];
  const hasAnything = points.length > 0;

  React.useEffect(() => {
    if (!host.current || map.current || !hasAnything || !apiKey) return;

    let cancelled = false;
    let m: maplibregl.Map | null = null;
    let loadTimeout: ReturnType<typeof setTimeout> | undefined;

    const frame = requestAnimationFrame(() => {
      if (cancelled || !host.current) return;

      try {
        m = new maplibregl.Map({
          container: host.current,
          style: olaMapsStyleUrl("map"),
          center: [points[0][0], points[0][1]],
          zoom: 5,
          attributionControl: { compact: true },
          transformRequest: olaMapsTransformRequest(apiKey),
        });
      } catch {
        setFailed(true);
        return;
      }

      const built = m;
      built.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.current = built;

      /*
       * The genuine failure case: nothing ever loads. "error" is NOT wired to
       * `failed` — see `street-map.tsx`'s identical note on why a single bad
       * layer in Ola Maps' own style must not read as the whole map being
       * broken. This timeout is the one signal that does not depend on
       * reading meaning into MapLibre's error text.
       */
      loadTimeout = setTimeout(() => {
        if (!loadedOnce.current) setFailed(true);
      }, 15_000);

      /*
       * Bound to the MAP, not the layer, so these survive `setStyle` — the
       * map/satellite switcher tears the style down and rebuilds it, which
       * removes every custom source and layer (see `drawOverlays` below) but
       * leaves listeners registered on the map object alone. MapLibre
       * resolves a layer-scoped listener at EVENT time, so it is harmless
       * that these layers do not exist yet on the very first style load.
       */
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
      /* A shop pin opens the customer quick-view drawer rather than a text
         popup — there is a real record behind it, and the drawer is where it
         is read. Prospects keep the popup: there is no customer record yet,
         only the name, territory and industry already in the label. */
      built.on("click", "shops-points", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const shopId = f?.properties?.shopId;
        if (typeof shopId === "string") setSelectedShopId(shopId);
      });
      built.on("click", "prospects-points", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setText(String(f.properties?.label ?? ""))
          .addTo(built);
      });
      for (const id of ["shops-clusters", "shops-points", "prospects-points"]) {
        built.on("mouseenter", id, () => (built.getCanvas().style.cursor = "pointer"));
        built.on("mouseleave", id, () => (built.getCanvas().style.cursor = ""));
      }

      /*
       * Everything the STYLE carries rather than the map: the shop and
       * prospect sources and layers. `setStyle` throws all of this away and
       * rebuilds from the new style JSON, so it has to be re-drawn every
       * time — which is exactly what `style.load` fires for, including the
       * very first time.
       */
      function drawOverlays() {
        /*
         * The map is provably working the moment its STYLE has loaded, well
         * before every tile in view has finished downloading — that wait is
         * what MapLibre's "load" event actually measures, and Ola Maps
         * serving a burst of tile/glyph/sprite requests on one page can
         * genuinely take longer than the load timeout to finish all of them.
         * Marking `loadedOnce` here, on the first `style.load` rather than
         * the eventual `load`, is what keeps a merely slow connection from
         * reading as a broken map.
         */
        loadedOnce.current = true;
        clearTimeout(loadTimeout);

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
                  shopId: s.id,
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
          for (const id of ["shops-clusters", "shops-cluster-count", "shops-points"]) {
            built.setLayoutProperty(id, "visibility", showShops ? "visible" : "none");
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
          built.setLayoutProperty(
            "prospects-points",
            "visibility",
            showProspects ? "visible" : "none",
          );
        }
      }

      built.on("style.load", drawOverlays);

      built.on("load", () => {
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
      clearTimeout(loadTimeout);
      m?.remove();
      map.current = null;
    };
    /* Built once. See street-map.tsx's identical note — a `rows`-shaped prop
       is a fresh array every render, so this must not re-run on a prop
       change; the page does not currently re-render this component with
       different data after mount. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Map / satellite calls `setStyle` rather than rebuilding — see
     street-map.tsx's identical effect and its skip-on-mount guard. */
  const mountedStyleEffect = React.useRef(false);
  React.useEffect(() => {
    if (!mountedStyleEffect.current) {
      mountedStyleEffect.current = true;
      return;
    }
    map.current?.setStyle(olaMapsStyleUrl(styleMode));
  }, [styleMode]);

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

  if (!apiKey) {
    return (
      <Frame key="no-key">
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">The map needs a key</p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            Add an Ola Maps key in Admin Console → Platform → Maps to draw the streets under
            this. The table above still has everything that is known.
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
            No shop has a coordinate, and no field-collected pin is waiting to be matched.
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
            The tiles did not load, or this browser cannot draw them. Nothing here is lost.
          </p>
        </div>
      </Frame>
    );
  }

  return (
    <Frame key="map">
      <div ref={host} className="h-full w-full" />
      <OlaMapsStyleSwitcher mode={styleMode} onChange={setStyleMode} />
      {/* Stacked below the style switcher rather than beside it — both anchored
          top-left reads as one cluster of map controls, and leaves MapLibre's
          own zoom control at top-right the width it needs. */}
      <div className="absolute top-11 left-2 z-10 flex gap-3 rounded-[6px] border border-line bg-surface/95 px-3 py-2 text-[12px] text-ink shadow-[0_1px_4px_rgba(22,22,22,0.15)]">
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
      <CustomerQuickView customerId={selectedShopId} onClose={() => setSelectedShopId(null)} />
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
