import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for the CRM, Accounts, leads and the Sales Dashboard. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const CRM_ACCOUNTS_SOURCES: Record<string, () => Promise<ImpactSource>> = {};
