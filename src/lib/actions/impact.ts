"use server";

import { impactReport } from "@/lib/impact/registry";
import type { ImpactReport } from "@/lib/impact/types";
import type { Result } from "@/lib/result";

/**
 * What deleting or changing this record will touch, for the confirm modal.
 * Read-only: it writes nothing, and the act re-checks the same report before
 * it does.
 */
export async function previewImpact(kind: string, id: string): Promise<Result<ImpactReport>> {
  return impactReport(kind, id);
}
