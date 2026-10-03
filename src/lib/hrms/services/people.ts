import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsOffices, hrmsRefLists, hrmsStaffTimings } from "@/db/schema";
import type { HrmsContext, Scope } from "../access";
import { isHeadPosition } from "../access";

/* ---------------------------------------------------------------------------
 * The people every HRMS screen reads the same way: the employee directory,
 * who a head's team is, the offices, the weekly timings and the value lists.
 * ------------------------------------------------------------------------- */

export type Person = {
  id: string;
  code: string;
  name: string;
  office: string | null;
  position: string | null;
  positionType: string | null;
  reportsTo: string | null;
  status: string;
  dateOfLeaving: string | null;
  dateOfJoining: string | null;
  gender: string | null;
  email: string | null;
  area: string | null;
};

const PICK = {
  id: employees.id,
  code: employees.employeeCode,
  name: employees.name,
  office: employees.officeName,
  position: employees.position,
  positionType: employees.department,
  reportsTo: employees.reportsTo,
  status: employees.status,
  dateOfLeaving: employees.dateOfLeaving,
  dateOfJoining: employees.dateOfJoining,
  gender: employees.gender,
  email: employees.email,
  area: employees.areaAllocated,
};

/** Everybody, by name. Withdrawn sheet rows are kept: their history still needs a name. */
export async function allPeople(): Promise<Person[]> {
  return db.select(PICK).from(employees).orderBy(asc(employees.name));
}

export const isActive = (p: Person) => p.status === "active";
export const isSales = (p: Person) => /sales|field/i.test(p.positionType ?? "");
export const isFieldOrOther = (p: Person) => /sales|field|other/i.test(p.positionType ?? "");
export const isHead = (p: Person) => isHeadPosition(p.position);

/** A name → person map, for joining rows to names in memory. */
export function byId(people: Person[]): Map<string, Person> {
  return new Map(people.map((p) => [p.id, p]));
}

/**
 * Which employees a list shows for this person: the ids, or null for all.
 * `team` is the employees whose Report To is my position, plus me.
 */
export function visibleIds(ctx: HrmsContext, scope: Scope, people: Person[]): Set<string> | null {
  if (scope === "all") return null;
  const me = ctx.employee?.id;
  const ids = new Set<string>(me ? [me] : []);
  if (scope === "team" && ctx.employee?.position) {
    const pos = ctx.employee.position.trim().toLowerCase();
    for (const p of people) if ((p.reportsTo ?? "").trim().toLowerCase() === pos) ids.add(p.id);
  }
  return ids;
}

/** Active employees a head (or HR) may mark attendance for (spec §6.5). */
export function markableStaff(ctx: HrmsContext, people: Person[], wide: boolean): Person[] {
  const office = ctx.employee?.office ?? null;
  return people.filter(
    (p) => isActive(p) && !isHead(p) && (office == null || p.office === office) && (wide || isFieldOrOther(p)),
  );
}

/**
 * Whose day a head may act on — check out, remark on — when the power to do so
 * came with their position rather than a grant: their team and the staff of
 * their office they could mark. Null means anyone, for somebody granted the
 * power or HR's, or an HRMS administrator. The server checks this; a button
 * that is drawn only for the right rows is not a permission.
 */
export function staffInReach(ctx: HrmsContext, people: Person[], power: "checkoutStaff" | "markStaff"): Set<string> | null {
  if (ctx.administrator || ctx.granted.has(power) || ctx.granted.has("hr") || ctx.granted.has("editAtt")) return null;
  const ids = visibleIds(ctx, "team", people) ?? new Set<string>();
  for (const p of markableStaff(ctx, people, false)) ids.add(p.id);
  return ids;
}

export async function offices() {
  return db.select().from(hrmsOffices).orderBy(asc(hrmsOffices.name));
}

/** Every timing row, keyed "employeeId|Weekday". */
export async function timingMap(): Promise<Map<string, { inTime: string; outTime: string }>> {
  const rows = await db.select().from(hrmsStaffTimings);
  return new Map(rows.map((r) => [`${r.employeeId}|${r.weekday}`, { inTime: r.inTime, outTime: r.outTime }]));
}

/** One editable value list (spec §3), e.g. "Bank names". */
export async function refList(list: string): Promise<string[]> {
  const [r] = await db.select().from(hrmsRefLists).where(eq(hrmsRefLists.list, list)).limit(1);
  return r?.values ?? [];
}

export async function refLists(): Promise<Record<string, string[]>> {
  const rows = await db.select().from(hrmsRefLists);
  return Object.fromEntries(rows.map((r) => [r.list, r.values]));
}
