/* ---------------------------------------------------------------------------
 * WHICH PARTS OF THE ORDER WORKBOOK ARE STILL READ — PURE.
 *
 * The workbook is two sources with two different ends. The ORDER tabs (Order
 * Details, Payment Status, Taken Order) stop meaning anything the day
 * `erp.orders.live` is turned on: from then the ERP writes the order book, the
 * projection writes no order and no bill, and the Call Log's hold is read off
 * the ERP's own lines. The SALES PARTY tab is the party master — seats,
 * deactivations, the phone and GST nobody typed into MahekOne — and it can
 * outlive the order tabs for as long as the office keeps it, so it has its
 * own switch, `erp.orders.partySheet`.
 *
 * Everything that has to agree about it asks here: the job runner (so the
 * cron, the console and a terminal all stop reading a retired tab at once), the
 * console's and Accounts' import buttons (drawn disabled, with the reason, not
 * hidden), and the freshness monitor (which must not call a tab "Stale" for
 * not being read when nobody is meant to read it). Three copies of "is this
 * tab retired" would be three answers inside a release.
 *
 * Retiring a tab never deletes its staging rows. Bill detail, delivery-party
 * linking and the price-list variance report still read them for the months
 * the sheet was the source, and two nightly steps read them every night.
 * ------------------------------------------------------------------------- */

export type SheetSwitches = {
  /** `erp.orders.live` — the ERP writes the order book. */
  ordersLive: boolean;
  /** `erp.orders.partySheet` — the Sales Party tab is still the party master. */
  partySheetLive: boolean;
};

export function sheetSwitches(config: { "erp.orders.live": boolean; "erp.orders.partySheet": boolean }): SheetSwitches {
  return { ordersLive: config["erp.orders.live"] === true, partySheetLive: config["erp.orders.partySheet"] !== false };
}

export const ORDER_TABS_RETIRED =
  "The ERP takes the orders now (erp.orders.live is on), so the Order Details, Payment Status and Taken Order tabs are no longer read.";

export const PARTY_TAB_RETIRED =
  "The Sales Party tab is retired (erp.orders.partySheet is off): parties, their salesperson and back-office seats and deactivations are kept in MahekOne.";

export const WHOLE_SHEET_RETIRED =
  "The order workbook is retired: the ERP takes the orders and the Sales Party tab is no longer the party master, so nothing is published from it.";

/** The tabs each sheet job reads — `project` publishes both halves. */
const READS: Record<string, "orders" | "party" | "both"> = {
  "sheet-append": "orders",
  "sheet-reconcile": "orders",
  "sheet-payments": "orders",
  "taken-order-sync": "orders",
  "party-sync": "party",
  "project-sheet": "both",
};

/**
 * Why this job no longer runs, or null where it still does. A job that is not
 * a read of the order workbook is never retired here — a reparse re-reads what
 * is already stored and touches Google not at all.
 */
export function retiredReason(job: string, s: SheetSwitches): string | null {
  const reads = READS[job];
  if (!reads) return null;
  if (reads === "orders") return s.ordersLive ? ORDER_TABS_RETIRED : null;
  if (reads === "party") return s.partySheetLive ? null : PARTY_TAB_RETIRED;
  return s.ordersLive && !s.partySheetLive ? WHOLE_SHEET_RETIRED : null;
}

/** For a freshness row: is the source behind this sheet key expected to move? */
export function sourceRetired(key: "order_details" | "payment_status" | "taken_order" | "sales_party" | "publish", s: SheetSwitches): string | null {
  if (key === "sales_party") return retiredReason("party-sync", s);
  if (key === "publish") return retiredReason("project-sheet", s);
  return retiredReason("sheet-append", s);
}
