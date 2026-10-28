import "server-only";
import type { ImpactSource } from "../registry";
import { ACCESS_REVOKE_KIND } from "./access-revoke-key";

/* Impact sources for the Admin Console, the Founder desks, the website and the price desk. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const ADMIN_SITE_SOURCES: Record<string, () => Promise<ImpactSource>> = {
  /* Admin Console: a catalogue alias removed, a SKU retired from the order
     form, a sign-in disabled, a saved credential cleared (the id is its name). */
  "admin-catalogue-alias": () => import("./admin").then((m) => m.aliasImpact),
  "admin-sku-retire": () => import("./admin").then((m) => m.skuRetireImpact),
  "admin-user-disable": () => import("./admin").then((m) => m.userDisableImpact),
  "admin-secret": () => import("./admin").then((m) => m.secretImpact),
  /** `setAccess` taking apps away — the id is `accessRevokeKey(user, apps)`. */
  [ACCESS_REVOKE_KIND]: () => import("./admin").then((m) => m.accessRevokeImpact),

  /* Founder → WhatsApp: an automation rule deleted. */
  "founder-wa-rule": () => import("./founder").then((m) => m.waRuleImpact),

  /* The price desk's remaining removals: a rate, a discount term, an imported
     document, a special-price request withdrawn by whoever asked. */
  "price-rate": () => import("./pricing-more").then((m) => m.priceRateImpact),
  "price-discount-term": () => import("./pricing-more").then((m) => m.priceDiscountTermImpact),
  "price-document": () => import("./pricing-more").then((m) => m.priceDocumentImpact),
  "price-request-withdraw": () => import("./pricing-more").then((m) => m.priceRequestWithdrawImpact),

  /* Website CMS: a draft deleted, changes discarded, an item taken off the
     live site (unpublished or archived — the id is the ids joined by commas),
     an image deleted, an assignment taken away, an approval revoked, a request
     withdrawn. */
  "site-content-delete": () => import("./website-cms").then((m) => m.contentDeleteImpact),
  "site-content-discard": () => import("./website-cms").then((m) => m.contentDiscardImpact),
  "site-content-unpublish": () => import("./website-cms").then((m) => m.contentUnpublishImpact),
  "site-content-archive": () => import("./website-cms").then((m) => m.contentArchiveImpact),
  "site-media": () => import("./website-cms").then((m) => m.mediaImpact),
  "site-assignment": () => import("./website-cms").then((m) => m.assignmentImpact),
  "site-approval-revoke": () => import("./website-cms").then((m) => m.approvalRevokeImpact),
  "site-request-withdraw": () => import("./website-cms").then((m) => m.requestWithdrawImpact),
};
