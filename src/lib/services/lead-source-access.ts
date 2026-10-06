import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appModuleAccess } from "@/db/schema";
import { canOpen } from "@/lib/access";

/**
 * WHO IS A SALES MANAGER, for the sources only that intake offers
 * (`lib/lead-source-scope.ts`).
 *
 * It asks for an EXPLICIT grant of `crm.sales-manager`, not `canOpenModule`.
 * "No module rows means every module" makes `canOpenModule` true for every
 * telecaller holding the whole CRM — safe for that workspace, whose scope is
 * the person's own seat, but not a statement that they ARE a Sales Manager, and
 * this one gates a choice rather than a screen. The module is `offByDefault`,
 * so it is only ever ticked for a person on the Access screen; a ticked row is
 * the decision this rule wants. An administrator is not a Sales Manager.
 */
export async function isSalesManagerSeat(userId: string): Promise<boolean> {
  if (!(await canOpen(userId, "crm"))) return false;
  const rows = await db
    .select({ id: appModuleAccess.id })
    .from(appModuleAccess)
    .where(
      and(
        eq(appModuleAccess.userId, userId),
        eq(appModuleAccess.app, "crm"),
        eq(appModuleAccess.module, "crm.sales-manager"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
