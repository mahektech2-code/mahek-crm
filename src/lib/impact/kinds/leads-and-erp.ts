import "server-only";
import type { ImpactSource } from "../registry";
import { LEAD_TRASH_KIND } from "./lead-key";

/* Impact sources for leads moved to trash and the ERP's deletes. Each entry
   is loaded lazily by `registry.ts`; the key is the `impact.kind` a screen
   names and the act passes to `confirmImpact`. */
export const LEADS_AND_ERP_SOURCES: Record<string, () => Promise<ImpactSource>> = {
  /* Moving leads to the trash — from a lead's record, or a batch from the list. */
  [LEAD_TRASH_KIND]: () => import("./lead").then((m) => m.leadTrashImpact),

  /* ERP → Production: an SFG batch line, a filling, a packing line. */
  "erp-sfg-line": () => import("./erp-production").then((m) => m.sfgLineImpact),
  "erp-fg-fill": () => import("./erp-production").then((m) => m.fgFillImpact),
  "erp-pack-line": () => import("./erp-production").then((m) => m.packLineImpact),

  /* ERP → re-order levels, can groups, recipes, help videos. */
  "erp-rm-level": () => import("./erp-masters").then((m) => m.rmLevelImpact),
  "erp-fg-level": () => import("./erp-masters").then((m) => m.fgLevelImpact),
  "erp-can-group": () => import("./erp-masters").then((m) => m.canGroupImpact),
  "erp-recipe-line": () => import("./erp-masters").then((m) => m.recipeLineImpact),
  "erp-video": () => import("./erp-masters").then((m) => m.videoImpact),

  /* ERP → Sales: an order line. */
  "erp-order-line": () => import("./erp-order-line").then((m) => m.orderLineImpact),
};
