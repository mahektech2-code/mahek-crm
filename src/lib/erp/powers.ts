/* ---------------------------------------------------------------------------
 * The ERP's special powers (PRD §5.4), as data.
 *
 * The source hard-codes these against the AppSheet admin role and three email
 * addresses. Here each is a named power granted to a person
 * (`erp_user_powers`). An ERP ADMINISTRATOR — the admin level on the `erp`
 * grant, or a platform admin — holds every power without a row, the same way
 * an administrator holds every capability in `access-control.ts`.
 *
 * PURE and client-safe: the Settings screen lists what the account can do,
 * and every screen hides the columns a power reveals, so the browser needs
 * the names. Enforcement is `lib/erp/access.ts`, on the server.
 * ------------------------------------------------------------------------- */

export const ERP_POWERS = [
  "viewPurchaseMoney",
  "viewCost",
  "viewSalesRate",
  "viewSalesAmounts",
  "verifyTest",
  "verifyPurchase",
  "reopenPurchase",
  "purchaseBuyer",
  "approvePurchaseOrder",
  "lostStock",
  "customerStatus",
  "approveParty",
  "decideRequests",
  "employeeAdmin",
  "approveSfgQc",
  "dispatchOverride",
  "pettyAccounts",
  "pettyApprove",
  "pettyOwner",
] as const;

export type ErpPower = (typeof ERP_POWERS)[number];

export const ERP_POWER_LABEL: Record<ErpPower, { label: string; source: string }> = {
  viewPurchaseMoney: {
    label: "See purchase money",
    source: "Rates, GST, amounts and bill status on purchases (admin and the office in the source).",
  },
  viewCost: {
    label: "See cost and margin",
    source: "Costing on batches, fills, packing and stock, and margin on order lines (admin in the source).",
  },
  viewSalesRate: {
    label: "See sales rate",
    source: "The rate on taken orders (admin and two office accounts in the source).",
  },
  viewSalesAmounts: {
    label: "See sales amounts",
    source: "Discount, amount and final amount on orders and order details (admin and the office in the source).",
  },
  verifyTest: {
    label: "Verify quality tests",
    source: "Do Verify / Do Not Verified on a purchase test, which creates the register row (the CEO in the source).",
  },
  verifyPurchase: {
    label: "Set a purchase to Purchase Verified",
    source: "The only status the verifier sets on the purchase register (the CEO in the source).",
  },
  reopenPurchase: {
    label: "Set a verified purchase back to Pending",
    source: "“Do Pending” on the purchase register (admin in the source).",
  },
  purchaseBuyer: {
    label: "Decide how a requirement is bought (the buyer)",
    source: "Buyer decision: for an item whose purchase rule is “Buyer decides”, chooses direct purchase or quotations, per requirement.",
  },
  approvePurchaseOrder: {
    label: "Approve purchase orders",
    source: "Approves or sends back a purchase order before it can go to the vendor. Nobody approves a PO they raised themselves, unless they are an ERP administrator.",
  },
  lostStock: {
    label: "Write off to Item Lost Record",
    source: "Pick the reserved Item Lost Record godown on any form (the CEO in the source).",
  },
  customerStatus: {
    label: "Activate or deactivate customers",
    source: "Do Active, Do Deactive and Do Pending Party (admin and the office in the source).",
  },
  approveParty: {
    label: "Approve orders from pending customers",
    source: "“Approved By Admin” on a taken order (admin in the source).",
  },
  decideRequests: {
    label: "Decide customer requests",
    source: "Accept or reject complaints and credit-note requests (admin and the CEO in the source).",
  },
  employeeAdmin: {
    label: "Administer the ERP: godowns and ERP powers",
    source: "Registering godowns and their staff, and giving ERP powers on the Access dialog (admin in the source, who also kept the employee directory).",
  },
  approveSfgQc: {
    label: "Approve or reject SFG QC",
    source: "Decides an SFG lot's quality check. Only an Approved lot can be filled into cans or drums (new in MahekOne: Mahek Plus filled any lot).",
  },
  dispatchOverride: {
    label: "Approve dispatch overrides; reject or return boxes",
    source: "Lets a box whose product or pack size does not match the order go anyway, with a reason, and marks boxes rejected or returned. Nobody approves their own override request unless they are an ERP administrator.",
  },
  pettyAccounts: {
    label: "Petty cash: accounts team",
    source:
      "Imports and reconciles the bank statement, confirms withdrawals and payment requests, verifies bills, payments and customer receipts, and keeps the Tally queue (new in MahekOne).",
  },
  pettyApprove: {
    label: "Approve petty-cash expenses",
    source:
      "Approves, rejects or returns expenses up to the approver's limit, approves missing-document and over-budget exceptions, adjustments, cash variances and daily closings. Never their own: nobody approves what they raised, submitted or spent.",
  },
  pettyOwner: {
    label: "Owner-level petty-cash approvals",
    source:
      "Approves expenses above the approver's limit or in owner-only categories, verifies opening balances, and approves reversals, budgets and fund-account changes.",
  },
};

export function isErpPower(v: string): v is ErpPower {
  return (ERP_POWERS as readonly string[]).includes(v);
}
