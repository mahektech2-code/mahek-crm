import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for price lists, ERP designations and expense policies.
   Each entry is loaded lazily by `registry.ts`; the kind is the name the act
   passes to `confirmImpact` and the screen passes to the modal. */
export const PRICING_AND_PEOPLE_SOURCES: Record<string, () => Promise<ImpactSource>> = {
  /** `deleteDraftPriceList` — one draft. */
  "price-list-draft": () => import("./price-lists").then((m) => m.priceListDraftImpact),
  /** `deleteDraftPriceLists` — the id is the selection's ids joined by commas. */
  "price-list-drafts": () => import("./price-lists").then((m) => m.priceListDraftsImpact),
  /** `withdrawPriceList`. */
  "price-list-withdrawal": () => import("./price-lists").then((m) => m.priceListWithdrawalImpact),
  /** `removeScope` — one rule saying who a list is for. */
  "price-list-scope": () => import("./price-lists").then((m) => m.priceListScopeImpact),
  /** `deleteErpDesignation`. */
  "erp-designation": () => import("./erp-designation").then((m) => m.erpDesignationImpact),
  /** `deletePolicySet` — a named expense policy. */
  "expense-policy-set": () => import("./expense-policy").then((m) => m.expensePolicySetImpact),
  /** `deleteRule` — one rule of a dated expense policy version. */
  "expense-rule": () => import("./expense-policy").then((m) => m.expenseRuleImpact),
};
