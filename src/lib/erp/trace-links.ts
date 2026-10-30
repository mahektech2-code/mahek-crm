/* Where the trace and the label sheets live. PURE and client-safe: rows on every screen link to them. */

/** The code an order is traced (and printed) by: ORDER-1256. */
export function orderTraceCode(orderNo: number | string): string {
  return `ORDER-${orderNo}`;
}

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

/** The dispatch desk, opened on one order when one is named. */
export function erpDispatchHref(order?: number | string): string {
  return order == null ? "/erp/dispatch" : `/erp/dispatch?order=${encodeURIComponent(String(order))}`;
}

/** A purchase order written out for printing or sending. */
export function erpPoHref(id: string): string {
  return `/erp/po/${encodeURIComponent(id)}`;
}

/** One bill's road on the Logistics desk: its stages, its LR, its messages. */
export function erpBillRoadHref(transportId: string): string {
  return `/erp/transport/${encodeURIComponent(transportId)}`;
}

/** Under Process: the list, or one plan open. */
export function erpPlanHref(planId?: string): string {
  return planId ? `/erp/under-process?plan=${encodeURIComponent(planId)}` : "/erp/under-process";
}

/** The A5 sheet of one print of a plan. */
export function erpPlanPrintHref(planId: string, printNo: number): string {
  return `/erp/under-process/${encodeURIComponent(planId)}/print?n=${printNo}`;
}
