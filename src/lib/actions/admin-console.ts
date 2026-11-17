"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { ADMIN } from "@/lib/admin-routes";
import {
  recomputeAllBuyingCycles,
  recomputeAllFollowUpStates,
  recomputeAllOutstanding,
  recomputeOrderSystemHolds,
  recomputeSlowPayers,
} from "@/lib/recompute";
import { fromThrown, ok, type Result } from "@/lib/result";
import { DERIVED_FIGURES, type DerivedFigure } from "@/lib/admin-derived";

/* ---------------------------------------------------------------------------
 * Data health's rebuild buttons. Each is the matching function in
 * `lib/recompute.ts` — the one documented way to correct a derived figure —
 * run on demand rather than waiting for the nightly pass. Platform
 * administrators only, and every run is audited.
 * ------------------------------------------------------------------------- */

const RUN: Record<DerivedFigure, () => Promise<unknown>> = {
  outstanding: recomputeAllOutstanding,
  cycles: recomputeAllBuyingCycles,
  followUps: recomputeAllFollowUpStates,
  slowPayers: recomputeSlowPayers,
  orderHolds: recomputeOrderSystemHolds,
};

export async function rebuildDerived(which: DerivedFigure): Promise<Result<{ seconds: number }>> {
  try {
    const user = await requirePlatformAdminUser();
    if (!(which in RUN)) throw new Error("Not a derived figure");
    const started = Date.now();
    await RUN[which]();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    await db.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: user.id,
      action: "job.rebuild",
      entityType: "derived_figure",
      entityId: which,
      afterState: { seconds } as never,
    });
    try {
      revalidatePath(ADMIN.home, "layout");
    } catch {
      /* no request context */
    }
    const label = DERIVED_FIGURES.find((d) => d.id === which)?.label ?? which;
    return ok({ seconds }, `${label} rebuilt in ${seconds}s.`);
  } catch (e) {
    return fromThrown(e);
  }
}
