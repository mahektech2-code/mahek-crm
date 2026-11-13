import "server-only";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, employeeReporting, employees, hrmsUserPowers, users } from "@/db/schema";
import { notifyUsers, type NotifyEntry, type NotifyMessage } from "@/lib/notify";
import type { HrmsPower } from "../powers";

/* ---------------------------------------------------------------------------
 * Who the HRMS tells, and the telling. Five screen files each carried their
 * own copy of "the accounts for these employees" and "who holds this power",
 * and they disagreed: leave approvers left out platform admins while help
 * resolvers counted them, and one copy forgot to ask whether the account was
 * still active. One definition now, so a person who may decide something is
 * the person told about it.
 * ------------------------------------------------------------------------- */

/** MahekOne accounts for employees — the bell is a user's, the HRMS row an employee's. Active accounts only. */
export async function usersOfEmployees(employeeIds: (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.employeeId, ids), eq(users.active, true)));
  return rows.map((r) => r.id);
}

/**
 * Everybody who holds an HRMS power: granted it on the Access screen, or an
 * HRMS administrator (the admin level on the grant, or a platform admin), who
 * holds every power — the same answer `hrmsContext` gives about one person.
 */
export async function powerHolderUserIds(power: HrmsPower): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "hrms")))
    .leftJoin(hrmsUserPowers, and(eq(hrmsUserPowers.userId, users.id), eq(hrmsUserPowers.power, power)))
    .where(and(eq(users.active, true), or(isNotNull(hrmsUserPowers.userId), eq(appAccess.role, "admin"), eq(users.role, "admin"))));
  return rows.map((r) => r.id);
}

/**
 * The MANAGERS of one employee who hold HRMS as a manager — the people who
 * decide that person's leave by role. The org chart names them; for somebody
 * the chart has not placed, the people whose job title is their Report To —
 * the same two answers `hrmsContext`'s team gives from the other end.
 */
export async function managerUserIdsOf(employeeId: string): Promise<string[]> {
  const chart = await db.select({ id: employeeReporting.managerId }).from(employeeReporting).where(eq(employeeReporting.employeeId, employeeId));
  let managerIds = chart.map((r) => r.id).filter((x): x is string => !!x);
  if (!managerIds.length) {
    const [me] = await db.select({ reportsTo: employees.reportsTo }).from(employees).where(eq(employees.id, employeeId)).limit(1);
    const title = me?.reportsTo?.trim().toLowerCase();
    if (title) managerIds = (await db.select({ id: employees.id }).from(employees).where(sql`lower(trim(${employees.position})) = ${title}`)).map((r) => r.id);
  }
  if (!managerIds.length) return [];
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "hrms"), eq(appAccess.role, "manager")))
    .where(and(inArray(users.employeeId, managerIds), eq(users.active, true)));
  return rows.map((r) => r.id);
}

/** Every active account holding HRMS — "All employees" on an announcement. */
export async function hrmsUserIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "hrms")))
    .where(eq(users.active, true));
  return rows.map((r) => r.id);
}

/** A bell must never fail the write it announces: the record is saved, the bell is a courtesy. */
export async function tell(entries: NotifyEntry[]): Promise<void> {
  if (!entries.length) return;
  try {
    await notifyUsers(entries);
  } catch (e) {
    console.error("hrms: notification failed", e);
  }
}

/** Tell the accounts of some employees, never the person who did it. */
export async function tellEmployees(actorUserId: string, employeeIds: (string | null | undefined)[], entry: NotifyMessage): Promise<void> {
  const to = (await usersOfEmployees(employeeIds)).filter((u) => u !== actorUserId);
  await tell(to.map((userId) => ({ ...entry, userId })));
}

/** Tell everybody who holds a power, never the person who did it. */
export async function tellPowerHolders(actorUserId: string, power: HrmsPower, entry: NotifyMessage): Promise<void> {
  const to = (await powerHolderUserIds(power)).filter((u) => u !== actorUserId);
  await tell(to.map((userId) => ({ ...entry, userId })));
}
