import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments, employees, hrmsAssetAssignments, hrmsAttendance } from "@/db/schema";
import { has, hrmsContext, scopeOf } from "./access";

/* ---------------------------------------------------------------------------
 * HRMS attachments: who may open which file, and binding uploads to the
 * record they were taken for. A file is read under the HRMS screen its record
 * lives on — never under a customer's scope, because none of these has a
 * customer behind it.
 * ------------------------------------------------------------------------- */

export type HrmsParent = "hrms_attendance" | "hrms_employee" | "hrms_office" | "hrms_asset" | "hrms_document" | "hrms_journey";

export async function canReadHrmsAttachment(parentType: string, parentId: string): Promise<boolean> {
  const ctx = await hrmsContext();
  if (!ctx.level) return false;
  const holds = (...keys: string[]) => keys.some((k) => ctx.screens.has(k));
  switch (parentType as HrmsParent) {
    case "hrms_attendance": {
      if (!holds("attendance", "home", "pendingOut")) return false;
      const [row] = await db
        .select({ employeeId: hrmsAttendance.employeeId, reportsTo: employees.reportsTo })
        .from(hrmsAttendance)
        .innerJoin(employees, eq(employees.id, hrmsAttendance.employeeId))
        .where(eq(hrmsAttendance.id, parentId))
        .limit(1);
      if (!row) return false;
      if (row.employeeId === ctx.employee?.id) return true;
      const scope = scopeOf(ctx, "hr", "editAtt", "markStaff");
      if (scope === "all") return true;
      return scope === "team" && !!ctx.employee?.position && (row.reportsTo ?? "").trim().toLowerCase() === ctx.employee.position.trim().toLowerCase();
    }
    case "hrms_employee":
      return parentId === ctx.employee?.id || holds("employees", "idCards");
    case "hrms_office":
      return true;
    case "hrms_asset": {
      if (!holds("assetStock", "assignments")) return false;
      if (has(ctx, "hr") || ctx.administrator) return true;
      /* A hand-over photo belongs to one person's assignment: anybody else
         holding the screen would otherwise open it by id. A stock lot's
         invoice is the store's, read by whoever holds the stock screen. */
      const [a] = await db
        .select({ employeeId: hrmsAssetAssignments.employeeId })
        .from(hrmsAssetAssignments)
        .where(eq(hrmsAssetAssignments.id, parentId))
        .limit(1);
      return a ? a.employeeId === ctx.employee?.id : holds("assetStock");
    }
    case "hrms_document":
      return holds("documents");
    case "hrms_journey":
      return holds("journey");
    default:
      return false;
  }
}

/**
 * Binds uploaded files to the record they were taken for, inside the record's
 * own transaction. Only files still unparented and uploaded by this person
 * are bound — an id typed into a request cannot claim somebody else's file.
 */
export async function bindHrmsFiles(
  tx: Pick<typeof db, "update">,
  ids: (string | null | undefined)[],
  parentType: HrmsParent,
  parentId: string,
  userId: string,
): Promise<void> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  await tx
    .update(attachments)
    .set({ parentType, parentId, updatedAt: new Date() })
    .where(and(inArray(attachments.id, list), isNull(attachments.parentId), eq(attachments.uploadedById, userId)));
}
