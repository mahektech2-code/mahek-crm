"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button, cx } from "@/components/ui/primitives";
import { useKit } from "./kit";

/* ---------------------------------------------------------------------------
 * A map pin, "lat, lng". Three ways in, one value: type it, find it on the
 * map, or take it from where this device is — the person setting a place's
 * pin is often standing in it. "Find in map" opens the map in a pop-up; a
 * click (or a drag of the pin) writes the latitude and longitude into the
 * field at once, and Done closes it. The map is loaded only when asked for, so
 * a form that never opens it never downloads a map library.
 * ------------------------------------------------------------------------- */

const PinMap = dynamic(() => import("./pin-map").then((m) => m.PinMap), {
  ssr: false,
  loading: () => <div className="flex h-[280px] items-center justify-center rounded-control border border-line bg-canvas text-meta text-muted">Loading the map…</div>,
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
        className={cx("h-8.5 w-full rounded-control border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand", error ? "border-danger" : "border-line")}
      />
      <div className="flex flex-wrap gap-2">
        {kit.mapKeyUrl ? (
          <button type="button" onClick={() => void openMap()} className="h-8 cursor-pointer rounded-control border border-line bg-surface px-3 text-meta font-medium text-body hover:bg-canvas">
            Find in map
          </button>
        ) : null}
        <button type="button" onClick={here} className="h-8 cursor-pointer rounded-control border border-line bg-surface px-3 text-meta font-medium text-body hover:bg-canvas">
          Use my location
        </button>
      </div>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Find in map"
        width={860}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-meta text-muted">{pin ? <>Pinned at <span className="font-mono text-body">{fmt(pin.lat, pin.lng)}</span></> : "Nothing pinned yet — click the map."}</span>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        }
      >
        {key === undefined ? (
          <div className="flex h-[480px] items-center justify-center rounded-control border border-line bg-canvas text-meta text-muted">Loading the map…</div>
        ) : key ? (
          <PinMap apiKey={key} pin={pin} height={480} onPick={(lat, lng) => onChange(fmt(lat, lng))} />
        ) : (
          <div className="rounded-control border border-line bg-canvas px-3 py-2.5 text-meta text-muted">
            No map key is set, so there is no map to pick on. An administrator adds it in Admin Console → Integrations; until then type the pin or use your location.
          </div>
        )}
      </Modal>
    </div>
  );
}
