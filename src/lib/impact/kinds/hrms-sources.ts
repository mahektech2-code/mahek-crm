import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for HRMS and Hire. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const HRMS_SOURCES: Record<string, () => Promise<ImpactSource>> = {};
