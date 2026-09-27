import { fmt, n, registerCalc } from "../calc";
import { fillFigures, sfgTotalUse, sfgYield } from "../engines/production";

/* ---------------------------------------------------------------------------
 * The production and transfer forms' derived fields. The server recomputes
 * each on save, from the same engine and inside the lot's lock; these show
 * the figure first.
 * ------------------------------------------------------------------------- */

const map = <T>(data: Record<string, unknown>, k: string) => (data[k] ?? {}) as Record<string, T>;
const key = (...p: (string | undefined)[]) => p.map((x) => x ?? "").join("|");

/* ---- SFG ---- */

registerCalc("sfg.no", ({ h }) => (h.sfgFixed ? h.sfgFixed : "Next SFG number, on save"));

/** A-09: the lot's stock, less what the lines above this one already take from it. */
registerCalc("sfg.avail", ({ h, l, lines, i, data }) => {
  if (!l.lot) return "";
  const stock = map<number>(data, "avail")[key(h.godown, l.lot)];
  if (stock == null) return "";
  const batches = n(h.batches) ?? 0;
  const before = lines.slice(0, i).filter((x) => x.lot === l.lot).reduce((a, x) => a + sfgTotalUse(batches, n(x.qty) ?? 0), 0);
  return fmt(stock - before);
});

registerCalc("sfg.total", ({ h, l }) => {
  const b = n(h.batches);
  const q = n(l.qty);
  return b && q ? fmt(sfgTotalUse(b, q)) : "";
});

registerCalc("sfg.yield", ({ h, l }) => {
  const b = n(h.batches);
  const q = n(l.qty);
  return b && q ? fmt(sfgYield(sfgTotalUse(b, q), n(l.adjusted) ?? 0)) : "";
});

registerCalc("sfg.rate", ({ l, data }) => {
  const r = map<number | null>(data, "rate")[l.lot ?? ""];
  return r == null ? (l.lot ? "No rate on this lot" : "") : `₹${fmt(r / 100)} / Ltr`;
});

registerCalc("sfg.editTotal", ({ h, data }) => {
  const b = n(h.batches);
  const q = n(h.qty);
  if (!b || !q) return "";
  const t = sfgTotalUse(b, q);
  const own = data.availOwn as number | undefined;
  return own != null && t > own ? `${fmt(t)} — Low Stock! (${fmt(own)} available)` : fmt(t);
});

registerCalc("sfgBatches.summary", ({ h, lines, data }) => {
  const b = n(h.batches);
  if (!b || !lines.length) return "";
  const avail = map<number>(data, "avail");
  const taking = new Map<string, number>();
  let made = 0;
  for (const x of lines) {
    const t = sfgTotalUse(b, n(x.qty) ?? 0);
    taking.set(x.lot ?? "", (taking.get(x.lot ?? "") ?? 0) + t);
    made += sfgYield(t, n(x.adjusted) ?? 0);
  }
  for (const [lot, t] of taking) {
    const s = avail[key(h.godown, lot)];
    if (lot && s != null && t > s + 1e-9) return `warn:Low Stock! Lot ${lot} has ${fmt(s)} Ltr and this batch takes ${fmt(t)}.`;
  }
  return made > 0 ? `ok:Makes ${fmt(made)} Ltr of ${h.product || "SFG"}.` : "";
});

/* ---- FG filling ---- */

registerCalc("fg.num", ({ h }) => (h.fgFixed ? h.fgFixed : "Next FG number, on save"));

registerCalc("fg.sfgAvail", ({ h, data }) => {
  const s = map<number>(data, "avail")[key(h.godown, h.sfgLot)];
  return s == null ? "" : fmt(s);
});

registerCalc("fg.packAvail", ({ h, data }) => {
  if (!h.size) return "";
  if (!h.canUse) return "Naket · no packing taken";
  const s = map<number>(data, "packAvail")[key(h.godown, h.canUse)];
  return s == null ? "" : fmt(s, 0);
});

registerCalc("fg.litres", ({ h }) => {
  const s = n(h.size);
  const c = n(h.cans);
  return s && c ? fmt(s * c) : "";
});

registerCalc("fg.net", ({ h }) => {
  const c = n(h.cans);
  return c ? fmt(c - (n(h.adjusted) ?? 0), 0) : "";
});

registerCalc("fg.lotCode", ({ h }) => {
  const g = (h.godown ?? "").slice(0, 2).toUpperCase();
  return h.fgFixed ? `FG${h.fgFixed}${g}` : g ? `FG + next number + ${g}` : "";
});

registerCalc("fg.costing", ({ h, data }) => {
  const size = n(h.size);
  const cans = n(h.cans);
  if (!size || !cans) return "";
  const type = h.canUse ? (map<string>(data, "typeOf")[h.canUse] ?? "Naket") : "Naket";
  const f = fillFigures({
    canSize: size,
    cans,
    canAdjusted: n(h.adjusted) ?? 0,
    packingType: type,
    sfgRatePaise: map<number | null>(data, "sfgRate")[h.sfgLot ?? ""] ?? null,
    packingRatePaise: h.canUse ? (map<number | null>(data, "packRate")[h.canUse] ?? null) : 0,
  });
  return f.costingPaise == null ? "A rate is missing upstream" : `₹${fmt(f.costingPaise / 100)}`;
});

registerCalc("fgFill.summary", ({ h, data }) => {
  const size = n(h.size);
  const cans = n(h.cans);
  if (!size || !cans) return "";
  const s = map<number>(data, "avail")[key(h.godown, h.sfgLot)];
  if (s != null && size * cans > s + 1e-9) return `warn:Low SFG Stock — ${fmt(size * cans)} Ltr needed, ${fmt(s)} Ltr in the lot.`;
  if (h.canUse) {
    const p = map<number>(data, "packAvail")[key(h.godown, h.canUse)];
    if (p != null && p <= 0) return "warn:Low Packing Quantity — no packing of this kind is available here.";
  }
  return `ok:Puts ${fmt(cans - (n(h.adjusted) ?? 0), 0)} cans into FG stock.`;
});

/* ---- packing ---- */

registerCalc("pack.batchNo", ({ h }) => {
  const g = (h.godown ?? "").slice(0, 2).toUpperCase();
  return h.serialFixed ? `FP${h.serialFixed}${g}` : g ? `FP + next number + ${g}` : "";
});

registerCalc("pack.totalCans", ({ h, data }) => {
  const b = n(h.boxes);
  const c = map<number>(data, "cpb")[h.sku ?? ""];
  return b && c ? fmt(b * c, 0) : "";
});

registerCalc("pack.lotAvail", ({ h, data }) => {
  const s = map<number>(data, "avail")[key(h.godown, h.fg, h.lot)];
  return s == null ? "" : fmt(s, 0);
});

registerCalc("packBatches.summary", ({ h, data }) => {
  const b = n(h.boxes);
  const cpb = map<number>(data, "cpb")[h.sku ?? ""];
  if (!b || !cpb) return "";
  const need = h.remaining ? Number(h.remaining) : b * cpb;
  const cans = n(h.cans) ?? need;
  const avail = map<number>(data, "avail")[key(h.godown, h.fg, h.lot)];
  if (cans > need) return `warn:You Cant Select More Than ${need} Can`;
  if (avail != null && cans > avail) return `warn:Low Stock — this lot has ${fmt(avail, 0)} cans. Take ${fmt(avail, 0)} here and the rest from another lot.`;
  return cans === need ? "ok:Completes the batch · its boxes reach packing stock." : `ok:${fmt(need - cans, 0)} cans still to draw from another lot.`;
});

/* ---- transfers ---- */

registerCalc("transfer.avail", ({ h, data }) => {
  const s = map<number>(data, "avail")[key(h.type, h.from, h.lot)];
  return s == null ? "" : fmt(s);
});

registerCalc("transfers.summary", ({ h, data }) => {
  const q = n(h.qty);
  const s = map<number>(data, "avail")[key(h.type, h.from, h.lot)];
  if (!q || s == null) return "";
  if (q > s + 1e-9) return `warn:Select Correct Quantity! ${fmt(s)} available.`;
  if (h.to === "Item Lost Record") return "warn:This writes the stock off.";
  return "";
});
