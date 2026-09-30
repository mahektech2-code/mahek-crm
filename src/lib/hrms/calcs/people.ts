import { registerCalc } from "@/lib/erp/calc";

/* ---------------------------------------------------------------------------
 * The People group's form calculators (offices, staff timings, asset
 * assignments): what a record WILL show, drawn while it is typed. The server
 * computes the same figures on save. PURE and client-safe.
 * ------------------------------------------------------------------------- */

const mins = (t: string | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 510 → "8h 30m". */
export function hmText(min: number): string {
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Closing − opening, or "24 h" for a round-the-clock office (spec §5.1). */
export function officeDuration(open: string | undefined, close: string | undefined, timing: string | undefined): string {
  if (timing === "24*7") return "24 h";
  const a = mins(open);
  const b = mins(close);
  if (a == null || b == null) return "";
  return b > a ? hmText(b - a) : "Closing must be after opening";
}

/** Out − in (spec §5.2, A38). */
export function dutyDuration(inT: string | undefined, outT: string | undefined): string {
  const a = mins(inT);
  const b = mins(outT);
  if (a == null || b == null) return "";
  return b > a ? hmText(b - a) : "Out time must be after in time";
}

/**
 * What is left, by lot and by asset name (spec §15.1, A36): stock-in plus
 * what came back, less what went out. Every assignment counts as handed out;
 * a restore gives its restored quantity back.
 */
export function availability(
  stock: { id: string; name: string; qty: number }[],
  assigned: { stockId: string; qty: number; restoredQty: number | null }[],
) {
  const lot = new Map<string, number>(stock.map((s) => [s.id, s.qty]));
  const nameOf = new Map(stock.map((s) => [s.id, s.name]));
  const byName = new Map<string, number>();
  for (const s of stock) byName.set(s.name, (byName.get(s.name) ?? 0) + s.qty);
  const inUseByName = new Map<string, number>();
  for (const a of assigned) {
    const out = a.qty - (a.restoredQty ?? 0);
    lot.set(a.stockId, (lot.get(a.stockId) ?? 0) - out);
    const n = nameOf.get(a.stockId);
    if (n) {
      byName.set(n, (byName.get(n) ?? 0) - out);
      inUseByName.set(n, (inUseByName.get(n) ?? 0) + out);
    }
  }
  return { lot, byName, inUseByName };
}

registerCalc("hrms.office.duration", ({ h }) => officeDuration(h.open, h.close, h.timing));
registerCalc("hrms.timing.duty", ({ h }) => dutyDuration(h.in, h.out));

/**
 * What is left of the chosen lot and of that asset overall, and the warning
 * when this assignment would take it below zero — allowed, as in the source,
 * but never silently (A60).
 */
registerCalc("hrms.asset.available", ({ h, data }) => {
  const m = (data.available ?? {}) as Record<string, { lot: number; name: number; asset: string }>;
  const a = m[h.stock ?? ""];
  if (!a) return "";
  const qty = Number(h.qty) || 0;
  const base = `${a.lot} in this lot · ${a.name} ${a.asset} in stock overall`;
  return qty > a.lot ? `${base} · assigning ${qty} takes it below zero — check the count first` : base;
});
