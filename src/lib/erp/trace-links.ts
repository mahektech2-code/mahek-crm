/* Where the trace and the label sheets live. PURE and client-safe: rows on every screen link to them. */

export function erpTraceHref(code: string): string {
  return `/erp/trace?q=${encodeURIComponent(code)}`;
}

export function erpLabelsHref(q: { batch?: string; lot?: string; ids?: string[]; order?: number | string }): string {
  const p = new URLSearchParams();
  if (q.batch) p.set("batch", q.batch);
  if (q.lot) p.set("lot", q.lot);
  if (q.ids?.length) p.set("ids", q.ids.join(","));
  if (q.order != null) p.set("order", String(q.order));
  return `/erp/print-labels?${p.toString()}`;
}
