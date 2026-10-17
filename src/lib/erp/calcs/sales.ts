import { fmt, n, registerCalc } from "../calc";
import { boxQuantity } from "../engines/sales";

/* ---------------------------------------------------------------------------
 * The order and allocation forms' derived fields. The server recomputes each
 * on save; these show it first.
 * ------------------------------------------------------------------------- */

type Party = { a: string; si: string; t: string; g: string };
const map = <T>(data: Record<string, unknown>, k: string) => (data[k] ?? {}) as Record<string, T>;
const deliveryOf = (h: Record<string, string>, data: Record<string, unknown>) => map<Party>(data, "party")[h.delivery || h.billing || ""];

registerCalc("order.no", ({ h }) => (h.orderFixed ? h.orderFixed : "Next order number, on save"));
registerCalc("order.area", ({ h, data }) => deliveryOf(h, data)?.a ?? "");
registerCalc("order.si", ({ h, data }) => (deliveryOf(h, data)?.si ?? "").replace(/( - )+$/, ""));

registerCalc("order.boxes", ({ l, data }) => {
  const q = n(l.qty);
  const cpb = map<number>(data, "cpb")[l.sku ?? ""];
  if (!q || !cpb) return "";
  const loose = map<boolean>(data, "loose")[l.sku ?? ""];
  const b = boxQuantity(q, cpb, !!loose);
  if (loose) return "Loose";
  return b.valid ? fmt(b.boxes, 0) : `INVALID — ${cpb} cans a box`;
});

registerCalc("order.listRate", ({ h, l, data }) => {
  const tag = map<Party>(data, "party")[h.billing ?? ""]?.g;
  if (!h.billing || !l.sku) return "";
  if (!tag) return "The billing party has no price list";
  const r = map<number>(data, "rate")[`${tag}|${l.sku}`];
  const d = map<number>(data, "disc")[tag];
  return r == null ? `Not on "${tag}"` : `₹${fmt(r / 100)}${d != null ? ` · ${fmt(d / 100)}% off` : ""}`;
});

registerCalc("alloc.sku", ({ data }) => String(data.sku ?? ""));
registerCalc("alloc.from", ({ data }) => String(data.from ?? ""));
registerCalc("alloc.required", ({ data }) => (data.required == null ? "" : `${fmt(Number(data.required), 0)} ${data.unit ?? ""}`));
registerCalc("alloc.avail", ({ h, data }) => {
  if (!h.lot) return "";
  const s = map<number>(data, "avail")[h.lot];
  return s == null ? "Not a lot of this SKU with stock here" : `${fmt(s, 0)} ${data.unit ?? ""}`;
});

registerCalc("orders.summary", ({ h, data, lines }) => {
  if (data.required != null) {
    const q = n(h.qty);
    const req = Number(data.required);
    const s = map<number>(data, "avail")[h.lot ?? ""];
    if (!q || !h.lot) return "";
    if (q > req || (s != null && q > s)) return "warn:Invalid Quantity Or Wait For Synchronization";
    return q === req ? "ok:Completes the allocation." : `ok:${fmt(req - q, 0)} ${data.unit ?? ""} still to allocate after this.`;
  }
  if (!lines?.length) return "";
  const bad = lines.filter((x) => {
    const cpb = map<number>(data, "cpb")[x.sku ?? ""];
    const q = n(x.qty);
    return cpb && q && !map<boolean>(data, "loose")[x.sku ?? ""] && !boxQuantity(q, cpb, false).valid;
  });
  return bad.length ? `warn:${bad.length} line${bad.length === 1 ? "'s" : "s'"} quantity is not a whole number of boxes.` : "";
});
