import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for leads moved to trash and the ERP's deletes. Each entry
   is loaded lazily by `registry.ts`. */
export const LEADS_AND_ERP_SOURCES: Record<string, () => Promise<ImpactSource>> = {};
