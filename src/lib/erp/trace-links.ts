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

/** The most copies of one invoice a print asks for at once. */
export const INVOICE_COPIES_MAX = 10;

/** One number of copies, held to 1..INVOICE_COPIES_MAX; anything unreadable is 1, the default. */
export function invoiceCopies(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, INVOICE_COPIES_MAX) : 1;
}

/** The orders' Tally invoices as one PDF — what the view and print buttons open. */
export function erpInvoicesPdfHref(orderNos: (number | string)[], opts: { copies?: number; download?: boolean } = {}): string {
  const p = new URLSearchParams({ orders: orderNos.join(",") });
  if (opts.copies && opts.copies > 1) p.set("copies", String(invoiceCopies(opts.copies)));
  if (opts.download) p.set("download", "1");
  return `/api/erp/invoices?${p.toString()}`;
}

/** The print sheet for the orders' invoices, copies changeable there. */
export function erpInvoicePrintHref(orderNos: (number | string)[]): string {
  return `/erp/print-invoices?orders=${encodeURIComponent(orderNos.join(","))}`;
}
