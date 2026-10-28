import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for the ERP's cancels, reversals and the deletes #904 did not reach. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const ERP_MORE_SOURCES: Record<string, () => Promise<ImpactSource>> = {
  /* ---- stock, money, returns, scrap, sales, purchase, masters ---- */

  /* ERP → Empty drums & scrap: a drum's entry, a return to a supplier, a sale, a scrap entry, a buyer, a receipt. */
  "erp-drum-entry": () => import("./erp-scrap").then((m) => m.drumEntryImpact),
  "erp-drum-return": () => import("./erp-scrap").then((m) => m.drumReturnImpact),
  "erp-scrap-sale": () => import("./erp-scrap").then((m) => m.scrapSaleImpact),
  "erp-scrap-entry": () => import("./erp-scrap").then((m) => m.scrapEntryImpact),
  "erp-scrap-buyer": () => import("./erp-scrap").then((m) => m.scrapBuyerImpact),
  "erp-scrap-receipt": () => import("./erp-scrap").then((m) => m.scrapReceiptImpact),
  /** The id is `impactPart(receiptId, match line)` — the prompt picks which match. */
  "erp-scrap-match": () => import("./erp-scrap").then((m) => m.scrapMatchImpact),

  /* ERP → Petty Cash: a transaction, an advance cancelled or reopened, a bank line's match undone. */
  "erp-money-txn": () => import("./erp-money").then((m) => m.moneyTxnImpact),
  "erp-money-advance": () => import("./erp-money").then((m) => m.advanceCancelImpact),
  "erp-money-advance-reopen": () => import("./erp-money").then((m) => m.advanceReopenImpact),
  "erp-bank-match": () => import("./erp-money").then((m) => m.bankMatchImpact),

  /* ERP → Returns: a vendor return, its outward cancelled or reversed; a customer return; one QC decision reversed. */
  "erp-return-outward-cancel": () => import("./erp-returns").then((m) => m.returnOutwardCancelImpact),
  "erp-return-outward-reverse": () => import("./erp-returns").then((m) => m.returnOutwardReverseImpact),
  "erp-vendor-return": () => import("./erp-returns").then((m) => m.vendorReturnImpact),
  "erp-customer-return": () => import("./erp-returns").then((m) => m.customerReturnImpact),
  /** The id is `impactPart(returnId, decision line)` — the prompt picks which decision. */
  "erp-qc-decision": () => import("./erp-returns").then((m) => m.qcDecisionImpact),

  /* ERP → Sales: lines cancelled (one, or a selection's ids joined by commas), billing undone, a lot allocation released, a dispatch unverified. */
  "erp-order-cancel": () => import("./erp-sales").then((m) => m.orderCancelImpact),
  "erp-order-unbill": () => import("./erp-sales").then((m) => m.orderUnbillImpact),
  "erp-batch-release": () => import("./erp-sales").then((m) => m.batchReleaseImpact),
  "erp-dispatch-unverify": () => import("./erp-sales").then((m) => m.dispatchUnverifyImpact),

  /* ERP → Stock accuracy and box ids: a count, a red-flag check, boxes back into stock (one, or ids joined by commas). */
  "erp-stock-count": () => import("./erp-stock").then((m) => m.stockCountImpact),
  "erp-stock-check": () => import("./erp-stock").then((m) => m.stockCheckImpact),
  "erp-unit-release": () => import("./erp-stock").then((m) => m.unitReleaseImpact),

  /* ERP → Masters: a raw material or supplier retired, a party deactivated. */
  "erp-raw-material-retire": () => import("./erp-retire").then((m) => m.rawMaterialRetireImpact),
  "erp-supplier-retire": () => import("./erp-retire").then((m) => m.supplierRetireImpact),
  "erp-party-deactivate": () => import("./erp-retire").then((m) => m.partyDeactivateImpact),

  /* ---- transport, trips, LRs and the quotation manager ---- */

  /* ERP → Logistics: an LR voided, a bill off its trip, a transport payment reversed, a delivery reopened. */
  "erp-lr-void": () => import("./erp-transport").then((m) => m.lrVoidImpact),
  "erp-trip-bill": () => import("./erp-transport").then((m) => m.tripBillImpact),
  "erp-transport-payment": () => import("./erp-transport").then((m) => m.transportPaymentImpact),
  "erp-delivery-reopen": () => import("./erp-transport").then((m) => m.deliveryReopenImpact),
  /* ERP → Logistics → Transporters: a name changed everywhere it is carried, or two rows folded into one. */
  "erp-transporter-rename": () => import("./erp-transport").then((m) => m.transporterRenameImpact),
  "erp-transporter-merge": () => import("./erp-transport").then((m) => m.transporterMergeImpact),

  /* ERP → Quotation manager: a row deleted, a purchase undone (its ERP PO line with it). */
  "erp-quote-row": () => import("./erp-quotes").then((m) => m.quoteRowImpact),
  "erp-quote-purchase": () => import("./erp-quotes").then((m) => m.quotePurchaseImpact),

  /* ERP → Purchase: a requirement cancelled or its PO unlinked, a PO cancelled or closed short. */
  "erp-requirement-cancel": () => import("./erp-purchase").then((m) => m.requirementCancelImpact),
  "erp-requirement-unlink": () => import("./erp-purchase").then((m) => m.requirementUnlinkImpact),
  "erp-po-cancel": () => import("./erp-purchase").then((m) => m.poCancelImpact),
  "erp-po-close": () => import("./erp-purchase").then((m) => m.poCloseImpact),
};
