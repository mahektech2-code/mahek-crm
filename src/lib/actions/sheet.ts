"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, sheetSyncRuns, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCapability } from "@/lib/access-control";
import {
  projectSheet,
  type ProjectionReport,
} from "@/lib/services/sheet-projection-service";
import { err as fail, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Promoting the imported sheet into the CRM.
 *
 * The sync and the projection are two different acts and this is the second
 * one. Syncing lands the spreadsheet in `sheet_order_rows` and changes nothing
 * a telecaller sees — deliberately, because a document nobody has corrected
 * yet must be visible without being believed. This turns those rows into
 * customers, orders and bills, and rebuilds every derived value that hangs off
 * them.
 *
 * It is a button rather than a job for one reason: the sheet does not say who
 * works these accounts. Somebody has to answer that, and until they do the
 * import writes rows that appear on nobody's screen.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const schema = z.object({
  dryRun: z.boolean(),
  includeBills: z.boolean(),
  /**
   * Required, and required even for a dry run — the count of records that
   * would land in nobody's book is the single most useful thing a dry run can
   * tell you, and it cannot be computed without knowing the answer.
   */
  assignToUserId: z.string().min(1, "Choose who these customers answer to."),
});

export async function runSheetProjection(
  input: unknown,
): Promise<Result<ProjectionReport>> {
  try {
    await requireCapability("config.write");
    const user = await requireUser();

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(issue.message, "validation", [
        { field: issue.path.join("."), message: issue.message },
      ]);
    }
    const { dryRun, includeBills, assignToUserId } = parsed.data;

    const [assignee] = await db
      .select({ id: users.id, name: users.name, active: users.active })
      .from(users)
      .where(eq(users.id, assignToUserId));
    if (!assignee) return fail("No such person.", "not_found");
    if (!assignee.active) {
      // An inactive account still resolves, and a book assigned to one is a
      // book nobody opens.
      return fail(`${assignee.name} is no longer active.`, "validation");
    }

    const report = await projectSheet({ dryRun, includeBills, assignToUserId });

    if (!dryRun) {
      // The batch now drives derived state, and the section says so rather
      // than continuing to warn that these rows feed nothing.
      await db
        .update(sheetSyncRuns)
        .set({ feedsCrm: true })
        .where(eq(sheetSyncRuns.source, "order_details"));
      if (includeBills) {
        await db
          .update(sheetSyncRuns)
          .set({ feedsCrm: true })
          .where(eq(sheetSyncRuns.source, "payment_status"));
      }

      await db.insert(auditLog).values({
        id: newId("aud"),
        actorId: user.id,
        action: "sheet.project",
        entityType: "customer",
        entityId: null,
        beforeState: null as never,
        afterState: {
          assignedTo: assignee.id,
          includeBills,
          customers: report.customers,
          orders: report.orders,
          bills: report.bills,
        } as never,
      });

      refresh();
    }

    const summary =
      `${report.customers.created} customers created, ${report.customers.updated} updated · ` +
      `${report.orders.created} orders created, ${report.orders.lines} lines` +
      (report.bills.skipped ? "" : ` · ${report.bills.created} bills created`);

    return ok(report, dryRun ? `Dry run: ${summary}. Nothing was written.` : summary);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The projection did not run.");
  }
}

/**
 * Cache hints, unable to fail the write they follow — the projection has
 * already committed by the time this runs, and outside a request scope
 * revalidatePath throws.
 */
function refresh() {
  try {
    revalidatePath("/admin");
    revalidatePath("/crm");
  } catch {
    // No request scope, so nothing is cached to drop.
  }
}
