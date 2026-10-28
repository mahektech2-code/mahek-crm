import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsSalaries, users } from "@/db/schema";
import { HrmsNotPermitted, requireHrmsWrite, type HrmsContext } from "@/lib/hrms/access";
import { monLabel } from "@/lib/hrms/time";

/* ---------------------------------------------------------------------------
 * WHO MAY READ AN HRMS DELETE'S IMPACT: whoever holds the screen the delete
 * sits on AND would be allowed to press it — the act's own check, in the act's
 * own words. The modal names people, days and money; somebody who could not
 * open the screen must not be able to read those by asking what a delete
 * would touch.
 * ------------------------------------------------------------------------- */

/**
 * Throws unless the signed-in person holds one of `screens` and `allowed`
 * answers no refusal for them. `allowed` reads the record itself where the act
 * does (your own request, the sender of a message); where the record is gone
 * it should answer null, and the report then says so.
 */
export async function hrmsMayAct(
  screens: string[],
  allowed?: (ctx: HrmsContext) => string | null | Promise<string | null>,
): Promise<HrmsContext> {
  let last: unknown = new HrmsNotPermitted("That HRMS screen is not on your account.");
  for (const screen of screens) {
    let ctx: HrmsContext;
    try {
      ctx = await requireHrmsWrite(screen);
    } catch (e) {
      last = e;
      continue;
    }
    const refusal = await allowed?.(ctx);
    if (refusal) throw new HrmsNotPermitted(refusal);
    return ctx;
  }
  throw last;
}

/** The record's own name where it is short enough to type, else the verb in capitals. */
export function typeable(name: string | null | undefined, fallback: string): string {
  const n = (name ?? "").trim().replace(/\s+/g, " ");
  return n && n.length <= 40 ? n : fallback;
}

/** "Asha Patil", or a plain word where the person has gone. */
export async function employeeName(id: string): Promise<string> {
  const [e] = await db.select({ name: employees.name }).from(employees).where(eq(employees.id, id)).limit(1);
  return e?.name ?? "this employee";
}

/** The MahekOne accounts linked to these employee records. */
export async function linkedUsers(employeeIds: string[]) {
  if (!employeeIds.length) return [];
  return db
    .select({ id: users.id, name: users.name, active: users.active, employeeId: users.employeeId })
    .from(users)
    .where(inArray(users.employeeId, employeeIds))
    .orderBy(asc(users.name));
}

/**
 * Salaries already made for the months a change reaches. Payroll freezes a
 * salary's figures when it is made, so a correction to attendance or leave
 * afterwards does not reach them — a prepared one is refused at approval until
 * it is worked out again, an approved or paid one keeps its figures and says
 * attendance changed. Worth saying, because people assume the money follows.
 */
export async function salariesFor(employeeId: string, months: string[]) {
  if (!months.length) return [];
  return db
    .select({ month: hrmsSalaries.month, status: hrmsSalaries.status, no: hrmsSalaries.salaryNo })
    .from(hrmsSalaries)
    .where(and(eq(hrmsSalaries.employeeId, employeeId), inArray(hrmsSalaries.month, months)))
    .orderBy(asc(hrmsSalaries.month));
}

export const SALARY_KEPT_NOTE =
  "Payroll froze their figures when they were made: a prepared one must be worked out again before it can be approved, and an approved or paid one keeps its figures and says attendance changed.";

export function salaryExamples(rows: { month: string; status: string; no: string }[]): string[] {
  return rows.slice(0, 5).map((s) => `${monLabel(s.month)} · ${s.status} · ${s.no}`);
}

/** Every "YYYY-MM" from one date to another, both ends counted. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    out.push(k);
    if (k >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** A count off a raw query, whose numbers come back as strings. */
export async function countOf(q: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(q)) as unknown as { n: number | string }[];
  return Number(rows[0]?.n ?? 0);
}
