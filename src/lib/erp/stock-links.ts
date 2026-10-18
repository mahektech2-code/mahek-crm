/* Where the stock inquiry lives. PURE and client-safe: every stock row links to it. */

export type InquiryStage = "rm" | "sfg" | "fg" | "pack";

/** One item's stock in detail: `stage` and `item` (its id), optionally one `godown` and a period `pd`. */
export function erpStockInquiryHref(q: { stage: InquiryStage; item?: string; godown?: string; pd?: string }): string {
  const p = new URLSearchParams({ stage: q.stage });
  if (q.item) p.set("item", q.item);
  if (q.godown) p.set("godown", q.godown);
  if (q.pd) p.set("pd", q.pd);
  return `/erp/stock-inquiry?${p.toString()}`;
}
