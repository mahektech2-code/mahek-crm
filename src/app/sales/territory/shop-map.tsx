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
import { CustomerQuickView } from "@/components/console/customer-quick-view";

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

/**
 * A PIN'S COLOUR SAYS WHAT THE SHOP IS, and it is one expression rather than
 * three.
 *
 * The map used to draw one thing — an active customer — because everything
 * else was filtered out in SQL, where nobody could see it had been. Now that
 * leads and closed shops are here, drawing them all alike would be the same
 * error wearing different clothes: a manager reading coverage off this map
 * would count a deactivated shop and a lead that has never ordered as trade.
 *
 * Closed wins over kind, because "this shop is shut" is the thing that changes
 * what somebody does with it. `approximate` is unchanged and still hollows the
 * fill — a geocode is a locality centre, not a doorway — so a hollow teal pin
 * reads as "a lead, somewhere near here", which is exactly what it is.
 */
const PIN_CUSTOMER = "#5223E0";
const PIN_LEAD = "#0E7C6B";
const PIN_CLOSED = "#8A8F98";

const PIN_TONE: maplibregl.ExpressionSpecification = [
  "case",
  ["get", "closed"], PIN_CLOSED,
  ["==", ["get", "kind"], "lead"], PIN_LEAD,
  PIN_CUSTOMER,
];

/** `active` is open for business; everything else is shut in some way. */
const isClosed = (status: string) => status !== "active";

const TONE_COLOUR: Record<string, string> = {
  positive: "#2E7D32",
  negative: "#8A8F98",
  neutral: "#C0392B",
};

export function ShopMap({
  shops,
  prospects,
  apiKey,
  keysSpent,
}: {
  shops: ShopPin[];
  prospects: ProspectPin[];
  /** Ola Maps' key, read once server-side and handed down — see `street-map.tsx`'s doc comment. */
  apiKey: string | null;
  /**
   * With no key: whether every key held has run out, or none is set at all.
   * Two silences, two sentences — see `live/street-map.tsx`.
   */
  keysSpent: boolean;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const map = React.useRef<maplibregl.Map | null>(null);
  /** Whether the map has ever finished its first real paint — see the load timeout below. */
  const loadedOnce = React.useRef(false);
  const [failed, setFailed] = React.useState(false);
  const [showShops, setShowShops] = React.useState(true);
  const [showProspects, setShowProspects] = React.useState(true);
  /*
   * WHAT IS DRAWN, and every one of them starts ON.
   *
   * The filtering used to happen in SQL, so a manager could not find out that
   * three quarters of the pinned shops were missing — there was no control to
   * notice, no count to compare against, and the map simply looked like the
   * whole book. Here it is a control with the numbers on it: turning a kind
   * off is a decision somebody made and can undo, and the default shows
   * everything the office holds a pin for.
   */
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [kindOn, setKindOn] = React.useState<Record<string, boolean>>({
    customer: true,
    lead: true,
  });
  const [statusOn, setStatusOn] = React.useState<Record<string, boolean>>({
    active: true,
    inactive: true,
    deactivated: true,
  });
  const [styleMode, setStyleMode] = React.useState<OlaMapsStyleMode>("map");
  const [selectedShopId, setSelectedShopId] = React.useState<string | null>(null);

  /* An unknown kind or status is SHOWN rather than hidden. The two columns are
     open vocabularies — a status nobody has taught this screen about would
     otherwise vanish from the map the day it is added, which is the failure
     this whole change exists to undo. */
  const visibleShops = React.useMemo(
    () => shops.filter((s) => kindOn[s.kind] !== false && statusOn[s.status] !== false),
    [shops, kindOn, statusOn],
  );

  /* What the filter is keeping off the screen. Drawn on the button itself,
     because a filter whose effect is only visible as an absence is the thing
     that made this map unreadable before. */
  const hidden = shops.length - visibleShops.length;

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
            data: shopFeatures(visibleShops),
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
              /* A LOOKED-UP PIN IS DRAWN HOLLOW, the same way a stale activity
                 fix is. An address outside a metro geocodes to the locality
                 centre, which can be a few hundred metres from the door — so
                 the shop is certainly somewhere near here and this is not a
                 measurement of where it is. Filled and hollow says that
                 without a legend; drawing both alike would make a guess look
                 like a fix taken in the doorway. */
              "circle-color": ["case", ["get", "approximate"], "#FFFFFF", PIN_TONE],
              "circle-stroke-width": 2,
              "circle-stroke-color": PIN_TONE,
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

  /* The FILTER redraws the source rather than toggling layers, because a
     cluster has to recount: hiding half the pins with a layer filter would
     leave the cluster bubbles still claiming the old numbers, and the number
     on a cluster is the whole reason it is there. */
  React.useEffect(() => {
    const built = map.current;
    const source = built?.getSource("shops");
    if (source && "setData" in source) {
      (source as maplibregl.GeoJSONSource).setData(shopFeatures(visibleShops));
    }
  }, [visibleShops]);

  if (!apiKey) {
    return (
      <Frame key="no-key">
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <p className="text-[15px] font-semibold text-ink">
            {keysSpent ? "Every Ola Maps key has run out" : "The map needs a key"}
          </p>
          <p className="mt-1 max-w-[420px] text-[13px] text-muted">
            {keysSpent
              ? "Ola has refused every key held for quota, so there are no streets to draw until one of them resets at the start of the month or another is added in Admin Console → Platform → Maps."
              : "Add an Ola Maps key in Admin Console → Platform → Maps to draw the streets under this."}{" "}
            The table above still has everything that is known.
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
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: PIN_CUSTOMER }} />
          {/* The number is what the filter is DOING, so it counts what is drawn
              — and says what it is a slice of whenever those differ. A bare
              "Shops (1,367)" beside a filter that had quietly removed 3,563 is
              how this screen misled somebody in the first place. */}
          Shops ({visibleShops.length.toLocaleString("en-IN")}
          {visibleShops.length === shops.length
            ? ""
            : ` of ${shops.length.toLocaleString("en-IN")}`}
          )
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

        {/*
          THE FILTER, and it is a dropdown because there are five boxes and the
          strip it sits in is a legend rather than a control panel. Kept in the
          same cluster as the two toggles beside it: they answer the same
          question — what is on this map — and splitting them across two
          corners would make one of them the one nobody finds.
        */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
            className="flex cursor-pointer items-center gap-1 rounded-[4px] border border-line px-1.5 py-0.5 text-[12px] text-ink hover:bg-wash"
          >
            Filter
            {hidden > 0 ? (
              <span className="rounded-full bg-ink px-1.5 text-[10px] leading-[15px] text-surface">
                {hidden.toLocaleString("en-IN")} hidden
              </span>
            ) : null}
            <span aria-hidden>{filterOpen ? "▴" : "▾"}</span>
          </button>

          {filterOpen ? (
            <div className="absolute top-6 left-0 z-20 w-[220px] rounded-[6px] border border-line bg-surface p-2 shadow-[0_2px_8px_rgba(22,22,22,0.18)]">
              <p className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                Kind
              </p>
              {KINDS.map((k) => (
                <FilterBox
                  key={k.key}
                  label={k.label}
                  swatch={k.swatch}
                  count={shops.filter((s) => s.kind === k.key).length}
                  checked={kindOn[k.key] !== false}
                  onChange={(on) => setKindOn((prev) => ({ ...prev, [k.key]: on }))}
                />
              ))}
              <p className="mt-2 px-1 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                Status
              </p>
              {STATUSES.map((st) => (
                <FilterBox
                  key={st.key}
                  label={st.label}
                  swatch={st.key === "active" ? null : PIN_CLOSED}
                  count={shops.filter((s) => s.status === st.key).length}
                  checked={statusOn[st.key] !== false}
                  onChange={(on) => setStatusOn((prev) => ({ ...prev, [st.key]: on }))}
                />
              ))}
              <button
                type="button"
                onClick={() => {
                  setKindOn({ customer: true, lead: true });
                  setStatusOn({ active: true, inactive: true, deactivated: true });
                }}
                className="mt-2 w-full cursor-pointer rounded-[4px] border border-line px-2 py-1 text-[12px] text-ink hover:bg-wash"
              >
                Show everything
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <CustomerQuickView customerId={selectedShopId} onClose={() => setSelectedShopId(null)} />
    </Frame>
  );
}

/**
 * WHAT CAN BE FILTERED, named once.
 *
 * Written out rather than derived from the rows on screen, so a box does not
 * appear and disappear as the data changes underneath it — a filter that loses
 * an option the moment nothing matches it is one somebody cannot use to find
 * out that nothing matches it.
 */
const KINDS = [
  { key: "customer", label: "Customers", swatch: PIN_CUSTOMER },
  { key: "lead", label: "Leads", swatch: PIN_LEAD },
] as const;

const STATUSES = [
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "deactivated", label: "Deactivated" },
] as const;

/** One row of the filter: a box, a swatch where the colour means something,
 *  the label, and how many there are. The count is of the WHOLE book rather
 *  than of what is drawn — it is what somebody is deciding whether to turn on. */
function FilterBox({
  label,
  swatch,
  count,
  checked,
  onChange,
}: {
  label: string;
  swatch: string | null;
  count: number;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 rounded-[4px] px-1 py-1 text-[12px] text-ink hover:bg-wash">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {swatch ? (
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: swatch }} />
      ) : (
        <span className="inline-block h-2.5 w-2.5" />
      )}
      <span className="flex-1">{label}</span>
      <span className="text-muted">{count.toLocaleString("en-IN")}</span>
    </label>
  );
}

/**
 * The pins as GeoJSON. ONE builder, used by the first paint and by every
 * change of the filter — two copies would drift, and the half that drifts is
 * the one somebody is looking at.
 *
 * `closed` is computed here rather than sent as a boolean from the server so
 * that the raw status survives onto the row for the label: "shut" is what the
 * map needs to draw and "deactivated" is what a person needs to read.
 */
function shopFeatures(list: ShopPin[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((s) => ({
      type: "Feature" as const,
      properties: {
        shopId: s.id,
        approximate: s.approximate,
        kind: s.kind,
        closed: isClosed(s.status),
        label:
          `${s.name} · ${s.city}${s.salesmanName ? ` · ${s.salesmanName}` : ""}` +
          (s.kind === "lead" ? " · lead" : "") +
          (isClosed(s.status) ? ` · ${s.status}` : "") +
          (s.approximate ? " · approximate, from the address" : ""),
      },
      geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
    })),
  };
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
