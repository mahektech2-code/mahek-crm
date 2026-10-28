import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for the ERP's cancels, reversals and the deletes #904 did not reach. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const ERP_MORE_SOURCES: Record<string, () => Promise<ImpactSource>> = {};
