import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for price lists, ERP designations and expense policies.
   Each entry is loaded lazily by `registry.ts`. */
export const PRICING_AND_PEOPLE_SOURCES: Record<string, () => Promise<ImpactSource>> = {};
