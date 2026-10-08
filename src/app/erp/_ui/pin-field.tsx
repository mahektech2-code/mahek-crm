"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { cx } from "@/components/ui/primitives";
import { useKit } from "./kit";

/* ---------------------------------------------------------------------------
 * A map pin, "lat, lng". Three ways in, one value: type it, pick it on a map,
 * or take it from where this device is — the person setting an office's pin
 * is often standing in it. The map is loaded only when asked for, so a form
 * that never opens it never downloads a map library.
 * ------------------------------------------------------------------------- */

const PinMap = dynamic(() => import("./pin-map").then((m) => m.PinMap), {
  ssr: false,
  loading: () => <div className="flex h-[280px] items-center justify-center rounded-[4px] border border-line bg-canvas text-[13px] text-muted">Loading the map…</div>,
});

export function parsePin(v: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const fmt = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

export function PinField({ value, error, onChange }: { value: string; error: boolean; onChange: (v: string) => void }) {
  const kit = useKit();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [note, setNote] = useState("");

  const openMap = async () => {
    setOpen(true);
    if (key !== undefined || !kit.mapKeyUrl) return;
    try {
      const r = await fetch(kit.mapKeyUrl);
      const j = (await r.json()) as { key?: string | null };
      setKey(j.key ?? null);
    } catch {
      setKey(null);
    }
  };

  const here = () => {
    if (!navigator.geolocation) return setNote("This browser cannot read a location.");
    setNote("Reading your location…");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        onChange(fmt(p.coords.latitude, p.coords.longitude));
        setNote(`Taken from this device, good to about ${Math.round(p.coords.accuracy)} m.`);
      },
      () => setNote("Location is blocked for this site — allow it, or pick on the map."),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  };

  const pin = parsePin(value);
  return (
    <div className="grid gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="19.209400, 73.093900"
        className={cx("h-8.5 w-full rounded-[4px] border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand", error ? "border-danger" : "border-line")}
      />
      <div className="flex flex-wrap gap-2">
        {kit.mapKeyUrl ? (
          <button type="button" onClick={() => (open ? setOpen(false) : void openMap())} className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas">
            {open ? "Hide the map" : "Pick on map"}
          </button>
        ) : null}
        <button type="button" onClick={here} className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas">
          Use my location
        </button>
      </div>
      {note ? <span className="text-[12px] text-muted">{note}</span> : null}
      {open ? (
        key === undefined ? (
          <div className="flex h-[280px] items-center justify-center rounded-[4px] border border-line bg-canvas text-[13px] text-muted">Loading the map…</div>
        ) : key ? (
          <PinMap apiKey={key} pin={pin} onPick={(lat, lng) => onChange(fmt(lat, lng))} />
        ) : (
          <div className="rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-[13px] text-muted">
            No map key is set, so there is no map to pick on. An administrator adds it in Admin Console → Integrations; until then type the pin or use your location.
          </div>
        )
      ) : null}
    </div>
  );
}
