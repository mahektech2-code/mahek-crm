"use client";

import { useRouter } from "next/navigation";
import type { CatalogueData } from "../../catalogue-data";
import { CatalogueSection } from "../../catalogue-section";

/**
 * The catalogue reads the database, so a write is followed by re-reading it
 * rather than by patching a copy in memory. A soft refresh, not a reload:
 * `router.refresh()` re-runs the server page and leaves this screen's own
 * state alone, so an import's report survives the numbers above it changing.
 */
export function CatalogueBody({ data, canWrite, tab }: { data: CatalogueData; canWrite: boolean; tab: number }) {
  const router = useRouter();
  return <CatalogueSection tab={tab} data={data} canWrite={canWrite} refresh={() => router.refresh()} />;
}
