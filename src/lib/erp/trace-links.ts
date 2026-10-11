/* Where the trace and the label sheets live. PURE and client-safe: rows on every screen link to them. */

export function erpTraceHref(code: string): string {
  return `/erp/trace?q=${encodeURIComponent(code)}`;
}

/**
 * One label sheet: box labels for a packing `batch`, an FG `lot` or chosen
 * `ids`; the label of an `sfg` lot (at a `godown`) or of a `purchase`; or the
 * dispatch labels of an `order`.
 */
export function erpLabelsHref(q: { batch?: string; lot?: string; ids?: string[]; order?: number | string; sfg?: string; godown?: string; purchase?: string }): string {
  const p = new URLSearchParams();
  if (q.batch) p.set("batch", q.batch);
  if (q.lot) p.set("lot", q.lot);
  if (q.ids?.length) p.set("ids", q.ids.join(","));
  if (q.order != null) p.set("order", String(q.order));
  if (q.sfg) p.set("sfg", q.sfg);
  if (q.sfg && q.godown) p.set("godown", q.godown);
  if (q.purchase) p.set("purchase", q.purchase);
  return `/erp/print-labels?${p.toString()}`;
}
