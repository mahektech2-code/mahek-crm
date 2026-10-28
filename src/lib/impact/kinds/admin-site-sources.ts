import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for the Admin Console, the Founder desks, the website and the price desk. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const ADMIN_SITE_SOURCES: Record<string, () => Promise<ImpactSource>> = {};
