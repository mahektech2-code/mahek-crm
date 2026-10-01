"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { OlaMapsStyleSwitcher, olaMapsStyleUrl, olaMapsTransformRequest, type OlaMapsStyleMode } from "@/app/sales/ola-maps";

/* ---------------------------------------------------------------------------
 * The picker behind a pin field: the same Ola Maps style and authentication
 * the Live map and Territory use. A click drops the pin, the pin drags, and
 * satellite is there because "which building" is the question a radius of a
 * hundred metres turns on.
 * ------------------------------------------------------------------------- */

/** Where the map opens with no pin yet: Mahek's own patch of Maharashtra. */
const HOME: [number, number] = [73.0, 19.2];

export function PinMap({ apiKey, pin, onPick }: { apiKey: string; pin: { lat: number; lng: number } | null; onPick: (lat: number, lng: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const pick = useRef(onPick);
  const [mode, setMode] = useState<OlaMapsStyleMode>("map");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({
      container: box.current,
      style: olaMapsStyleUrl("map"),
      transformRequest: olaMapsTransformRequest(apiKey),
      center: pin ? [pin.lng, pin.lat] : HOME,
      zoom: pin ? 17 : 9,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    /* A refused key leaves a blank grey box, which reads as a broken page. The
       style either loads or it does not: a style the supplier refused, or none
       inside fifteen seconds, says so in words. One bad layer among good ones
       is not a failure, which is why the error event alone is not trusted. */
    let loaded = false;
    m.on("style.load", () => (loaded = true));
    m.on("error", (e) => {
      const status = (e.error as { status?: number } | undefined)?.status;
      if (!loaded && (status === 401 || status === 403)) setFailed(true);
    });
    const watch = setTimeout(() => !loaded && setFailed(true), 15_000);
    const mk = new maplibregl.Marker({ color: "#6835FB", draggable: true });
    if (pin) mk.setLngLat([pin.lng, pin.lat]).addTo(m);
    mk.on("dragend", () => {
      const p = mk.getLngLat();
      pick.current(p.lat, p.lng);
    });
    m.on("click", (e) => {
      mk.setLngLat(e.lngLat).addTo(m);
      pick.current(e.lngLat.lat, e.lngLat.lng);
    });
    map.current = m;
    marker.current = mk;
    return () => {
      clearTimeout(watch);
      m.remove();
    };
    // The map is built once; a typed pin moves the marker below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  /* A pin typed into the box moves the marker too, so the two never disagree. */
  useEffect(() => {
    const m = map.current;
    const mk = marker.current;
    if (!m || !mk || !pin) return;
    const at = mk.getLngLat?.();
    if (at && Math.abs(at.lat - pin.lat) < 1e-7 && Math.abs(at.lng - pin.lng) < 1e-7) return;
    mk.setLngLat([pin.lng, pin.lat]).addTo(m);
  }, [pin]);

  const switchTo = (next: OlaMapsStyleMode) => {
    setMode(next);
    map.current?.setStyle(olaMapsStyleUrl(next));
  };

  return (
    <div className="grid gap-1">
      <div className="relative h-[280px] overflow-hidden rounded-[4px] border border-line">
        <div ref={box} className="h-full w-full" />
        <OlaMapsStyleSwitcher mode={mode} onChange={switchTo} />
        {failed ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-canvas/95 px-6 text-center text-[13px] text-body">
            The map could not load — the key in Admin Console → Maps may be wrong or expired. Type the pin or use your location instead.
          </div>
        ) : null}
      </div>
      <span className="text-[12px] text-muted">Click the office’s doorway, or drag the pin. Satellite shows the building.</span>
    </div>
  );
}
