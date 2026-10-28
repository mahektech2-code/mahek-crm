import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for the CRM, Accounts, leads and the Sales Dashboard. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const CRM_ACCOUNTS_SOURCES: Record<string, () => Promise<ImpactSource>> = {
  /* ---- CRM: the customer record ---- */

  /** `removeCustomerContact` — one number off a customer. */
  "crm-customer-contact": () => import("./crm-customers").then((m) => m.customerContactImpact),
  /** `removeDistributor` — one arrangement, by its link id. */
  "crm-distributor-link": () => import("./crm-customers").then((m) => m.distributorLinkImpact),
  /** `decideDeactivation` approving — asking for one changes nothing a modal need say. */
  "crm-customer-deactivate": () => import("./crm-customers").then((m) => m.customerDeactivateImpact),
  /** `removeFocusCustomer` — by the focus entry's id. */
  "crm-focus-customer": () => import("./crm-customers").then((m) => m.focusCustomerImpact),
  /** `cancelReminder` — a reminder dismissed. */
  "crm-reminder-dismiss": () => import("./crm-customers").then((m) => m.reminderDismissImpact),
  /** `unlinkOrderAction` — the id is `impactPair(enquiryId, orderId)`. */
  "crm-enquiry-order": () => import("./crm-customers").then((m) => m.enquiryOrderImpact),
  /** `clearManager` — an employee's reporting line, which the CRM reads for the sales manager seat. */
  "crm-reporting-line": () => import("./crm-customers").then((m) => m.reportingLineImpact),

  /* ---- CRM: WhatsApp ---- */

  /** `cancelMessage` — a prepared or copied message discarded. */
  "crm-wa-message": () => import("./crm-whatsapp").then((m) => m.waMessageImpact),
  /** `archiveTemplate` archiving (restoring asks nothing). */
  "crm-wa-template-archive": () => import("./crm-whatsapp").then((m) => m.waTemplateArchiveImpact),
  /** `clearRun` while customers are still waiting in it. */
  "crm-wa-run-end": () => import("./crm-whatsapp").then((m) => m.waRunEndImpact),

  /* ---- Accounts ---- */

  /** `reverseReceiptAction` — a confirmed payment taken back. */
  "accounts-receipt-reverse": () => import("./accounts").then((m) => m.receiptReverseImpact),
  /** `bankReverseForReturn` — the id is `impactPair(lineId, receiptId)`. */
  "accounts-bank-return": () => import("./accounts").then((m) => m.bankReturnImpact),
  /** `bankUndo` — a bank line's match undone. */
  "accounts-bank-unmatch": () => import("./accounts").then((m) => m.bankUnmatchImpact),
  /** `bankDiscardUpload` — an upload thrown away before import. */
  "accounts-bank-upload-discard": () => import("./accounts").then((m) => m.bankUploadDiscardImpact),
  /** `cancelPayoutAction`, `reopenPayoutAction`, `removePayoutInvoiceAction`. */
  "accounts-payout-cancel": () => import("./accounts").then((m) => m.payoutCancelImpact),
  "accounts-payout-reopen": () => import("./accounts").then((m) => m.payoutReopenImpact),
  "accounts-payout-invoice": () => import("./accounts").then((m) => m.payoutInvoiceImpact),

  /* ---- Leads ---- */

  /** `cancelSample`. */
  "lead-sample-cancel": () => import("./leads-more").then((m) => m.sampleCancelImpact),
  /** `archiveLead` and `bulkArchiveLeads` — the id is `impactBatch(ids)`. */
  "lead-archive": () => import("./leads-more").then((m) => m.leadArchiveImpact),

  /* ---- Sales Dashboard ---- */

  /** `setDocumentPublished` and `setCoursePublished` withdrawing. */
  "sales-document-withdraw": () => import("./sales-dashboard").then((m) => m.documentWithdrawImpact),
  "sales-course-withdraw": () => import("./sales-dashboard").then((m) => m.courseWithdrawImpact),
  /** `closeTaskCampaign` — an assignment's open tasks withdrawn. */
  "sales-task-campaign-withdraw": () => import("./sales-dashboard").then((m) => m.taskCampaignWithdrawImpact),
  /** `voidExpensePayout`. */
  "sales-expense-payout-void": () => import("./sales-dashboard").then((m) => m.expensePayoutVoidImpact),
  /** `undoActivityShopDecision` — by one activity row of the name decided. */
  "sales-activity-shop-undo": () => import("./sales-dashboard").then((m) => m.activityShopUndoImpact),
};
