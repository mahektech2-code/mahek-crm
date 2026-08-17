"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, employeeReporting, employees } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { err, fromThrown, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * WHO REPORTS TO WHOM.
 *
 * The first employee data MahekOne owns rather than mirrors. `employees` is a
 * reflection of the workbook and nothing on an HRMS screen may edit it, because
 * the next sync would silently undo the change. This lives in its own table for
 * exactly that reason, and so these are the only two writes in the app that
 * touch an employee's org position at all.
 *
 * Gated on HRMS ACCESS rather than on a role. Salaries and home addresses are
 * already behind that grant, so anybody holding it is trusted with far more
 * than the reporting line — and the people who maintain the org chart are the
 * people who maintain the employee master.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

function refresh() {
  revalidatePath("/hrms/org");
  revalidatePath("/hrms/employees");
}

async function requireHrms() {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("hrms")) {
    return {
      user: null,
      error: err("Only somebody with HRMS access can change the org chart.", "not_permitted"),
    };
  }
  return { user, error: null };
}

/**
 * WOULD THIS MAKE A LOOP?
 *
 * Walking up from the proposed manager: if we meet the employee on the way,
 * the link would close a circle. A → B → A is not merely wrong data — every
 * tree walk over it runs for ever, so the org chart stops rendering and takes
 * the HRMS page with it. This is the one check that cannot be left to the
 * screen.
 *
 * The depth stop is a second belt. If a cycle somehow already exists — written
 * before this guard, or by hand in SQL — this must still terminate rather than
 * hang the request that was trying to fix it.
 */
async function wouldLoop(employeeId: string, managerId: string): Promise<boolean> {
  if (employeeId === managerId) return true;

  let current: string | null = managerId;
  for (let hops = 0; hops < 200 && current; hops++) {
    const [row]: Array<{ managerId: string } | undefined> = await db
      .select({ managerId: employeeReporting.managerId })
      .from(employeeReporting)
      .where(eq(employeeReporting.employeeId, current));
    if (!row) return false;
    if (row.managerId === employeeId) return true;
    current = row.managerId;
  }
  // Ran out of hops: something is already circular up there. Refuse rather
  // than add another edge to it.
  return true;
}

/** Set or move who an employee reports to. */
export async function setManager(
  employeeId: string,
  managerId: string,
): Promise<Result> {
  try {
    const { user, error } = await requireHrms();
    if (error) return error;

    if (!employeeId || !managerId) {
      return err("Pick a person and the manager they report to.", "validation");
    }

    const rows = await db
      .select({ id: employees.id, name: employees.name, status: employees.status })
      .from(employees)
      .where(sql`${employees.id} in (${employeeId}, ${managerId})`);

    const person = rows.find((r) => r.id === employeeId);
    const manager = rows.find((r) => r.id === managerId);
    if (!person) return err("That employee no longer exists.", "not_found");
    if (!manager) return err("That manager no longer exists.", "not_found");

    if (await wouldLoop(employeeId, managerId)) {
      return err(
        employeeId === managerId
          ? `${person.name} cannot report to themselves.`
          : `${manager.name} already reports to ${person.name}, directly or through somebody else. That would make a circle.`,
        "rule_violation",
      );
    }

    const [existing] = await db
      .select({ id: employeeReporting.id, managerId: employeeReporting.managerId })
      .from(employeeReporting)
      .where(eq(employeeReporting.employeeId, employeeId));

    if (existing?.managerId === managerId) {
      return okVoid(`${person.name} already reports to ${manager.name}.`);
    }

    await db
      .insert(employeeReporting)
      .values({
        id: id("rep"),
        employeeId,
        managerId,
        createdById: user.id,
        updatedById: user.id,
      })
      // One manager per person, so a move is an update rather than a second row.
      .onConflictDoUpdate({
        target: employeeReporting.employeeId,
        set: { managerId, updatedById: user.id, updatedAt: new Date() },
      });

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: user.id,
      action: existing ? "employee.reporting_moved" : "employee.reporting_set",
      entityType: "employee",
      entityId: employeeId,
      beforeState: { managerId: existing?.managerId ?? null } as never,
      afterState: { managerId } as never,
    });

    refresh();
    return okVoid(`${person.name} now reports to ${manager.name}.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Remove the link. The person becomes a root of the chart rather than
 * disappearing from it — somebody with no manager recorded is a fact worth
 * seeing, and is how every employee starts out.
 */
export async function clearManager(employeeId: string): Promise<Result> {
  try {
    const { user, error } = await requireHrms();
    if (error) return error;

    const [existing] = await db
      .select({ managerId: employeeReporting.managerId })
      .from(employeeReporting)
      .where(eq(employeeReporting.employeeId, employeeId));
    if (!existing) return okVoid("They had no manager recorded.");

    await db.delete(employeeReporting).where(eq(employeeReporting.employeeId, employeeId));

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: user.id,
      action: "employee.reporting_cleared",
      entityType: "employee",
      entityId: employeeId,
      beforeState: { managerId: existing.managerId } as never,
      afterState: { managerId: null } as never,
    });

    refresh();
    return okVoid("Reporting line removed.");
  } catch (e) {
    return fromThrown(e);
  }
}
