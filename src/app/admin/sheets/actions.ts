"use server";

import { randomUUID } from "node:crypto";
import { and, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { ADMIN } from "@/lib/admin-routes";
import { db } from "@/db";
import { auditLog, syncConflicts } from "@/db/schema";
import { canFor, isPlatformAdmin } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { retiredReason, sheetSwitches } from "@/lib/engines/sheet-retirement";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * The Sheets screen's own writes.
 *
 * A conflict is where the sheet disagrees with a decision a person made in
 * MahekOne. The app already KEPT its value — that is what a conflict is — so
 * resolving one records that somebody has looked and agreed, and changes no
 * order or customer. Changing the record is done where the record is decided.
 *
 * Reparse re-reads the order rows already stored, under today's reading,
 * without asking Google — the job to run when the rule changed and the sheet
 * did not (AGENTS.md, "A hash-driven sync needs a reparse").
 * ------------------------------------------------------------------------- */

async function mayRunSheets() {
  const user = await requireUser();
  const allowed = (await isPlatformAdmin(user)) || (await canFor(user, "sheet.import"));
  return { user, allowed };
}

const KEPT = "Seen on the Sheets screen — MahekOne's value kept";

export async function resolveConflicts(ids: string[] | "all"): Promise<Result<{ resolved: number }>> {
  try {
    const { user, allowed } = await mayRunSheets();
    if (!allowed) return err("Resolving sheet conflicts needs the sheet import permission.", "not_permitted");
    if (ids !== "all" && ids.length === 0) return ok({ resolved: 0 });
    const done = await db.transaction(async (tx) => {
      const rows = await tx
        .update(syncConflicts)
        .set({ resolvedAt: new Date(), resolvedById: user.id, resolution: KEPT })
        .where(ids === "all" ? isNull(syncConflicts.resolvedAt) : and(isNull(syncConflicts.resolvedAt), inArray(syncConflicts.id, ids)))
        .returning({ id: syncConflicts.id });
      if (rows.length) {
        await tx.insert(auditLog).values({
          id: `aud_${randomUUID().slice(0, 12)}`,
          actorId: user.id,
          action: "sync.conflict.resolve",
          entityType: "sync_conflict",
          entityId: rows.length === 1 ? rows[0].id : null,
          beforeState: null,
          afterState: { ids: rows.map((r) => r.id), resolution: KEPT } as never,
        });
      }
      return rows.length;
    });
    revalidatePath(ADMIN.sheets(), "layout");
    return ok({ resolved: done }, done === 1 ? "Marked as seen." : `${done} marked as seen.`);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function reparseOrderSheet(): Promise<Result<{ detail: string }>> {
  try {
    const { user, allowed } = await mayRunSheets();
    if (!allowed) return err("Reparsing the order sheet needs the sheet import permission.", "not_permitted");
    const retired = retiredReason("sheet-reparse", sheetSwitches(await getConfig()));
    if (retired) return err(retired, "rule_violation");
    const { runJob } = await import("@/lib/jobs");
    const results = await runJob("sheet-reparse", user.id);
    revalidatePath(ADMIN.sheets(), "layout");
    const detail = results.map((r) => r.detail).join(" · ");
    return ok({ detail }, `Reparse finished — ${results.reduce((a, r) => a + r.recordsAffected, 0)} records touched`);
  } catch (e) {
    return fromThrown(e);
  }
}
