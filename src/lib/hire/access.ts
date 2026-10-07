import "server-only";
import { cache } from "react";
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { hireUserRoles, type User } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { levelInApp } from "@/lib/access-control";
import { listUserApps } from "@/lib/access";
import { can, holdsScreen, lockedWhy, ROLE_LABEL, type HireCap, type HireNavKey, type HireRole } from "./roles";
import { GATE_POINT } from "./roles";

/* ---------------------------------------------------------------------------
 * Who this person is INSIDE Hire, resolved once per request.
 *
 * SCOPE IS ENFORCED HERE, in the query, not in a handler (spec §8): every list
 * of applications is built on `scopeWhere(ctx)`, so an interviewer's page and
 * an interviewer's server action read the same narrowed set — and a URL with
 * somebody else's id answers "not found", never "forbidden", because the row
 * is simply not in the set they can see.
 * ------------------------------------------------------------------------- */

export type HireContext = {
  user: User;
  role: HireRole;
  roleLabel: string;
  can: (cap: HireCap) => boolean;
};

export const hireContext = cache(async function hireContext(): Promise<HireContext | null> {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("hire")) return null;
  const level = await levelInApp(user, "hire");
  const [row] = await db.select({ role: hireUserRoles.role }).from(hireUserRoles).where(eq(hireUserRoles.userId, user.id)).limit(1);
  let role: HireRole;
  if (row && (ROLE_LABEL as Record<string, string>)[row.role]) role = row.role as HireRole;
  else if (level === "admin" || user.role === "admin") role = "admin";
  else if (level === "manager") role = "hiring_manager";
  else role = "interviewer";
  return { user, role, roleLabel: ROLE_LABEL[role], can: (cap) => can(role, cap) };
});

/** The layout's gate: Hire granted, or the launcher. */
export async function requireHire(): Promise<HireContext> {
  const ctx = await hireContext();
  if (!ctx) {
    /* Imported lazily: next/navigation pulls the client router into anything
       that imports this module, which a test runner cannot load. */
    const { redirect } = await import("next/navigation");
    redirect("/apps");
    throw new Error("unreachable");
  }
  return ctx;
}

/** A page's gate: the screen is in this person's navigation, or the board. */
export async function requireHireScreen(key: HireNavKey): Promise<HireContext> {
  const ctx = await requireHire();
  if (!holdsScreen(ctx.role, key)) {
    const { redirect } = await import("next/navigation");
    redirect("/hire");
  }
  return ctx;
}

export class HireNotPermitted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HireNotPermitted";
  }
}

/** A server action's gate — a server action is a URL, so it checks for itself. */
export async function requireHireCap(cap?: HireCap): Promise<HireContext> {
  const ctx = await hireContext();
  if (!ctx) throw new HireNotPermitted("Hire is not on your account.");
  if (cap && !ctx.can(cap)) throw new HireNotPermitted(`${lockedWhy(cap)} You are signed in as ${ctx.roleLabel}.`);
  return ctx;
}

/**
 * The applications this person may see, as a WHERE clause over
 * `hire_applications` (aliased `a`). Raw SQL qualifies every column, because
 * this clause is dropped into correlated subqueries too.
 */
export function scopeWhere(ctx: HireContext, alias = "a"): SQL {
  const a = sql.raw(alias);
  const me = ctx.user.id;
  switch (ctx.role) {
    case "hr_head":
    case "admin":
      return sql`true`;
    case "recruiter":
      return sql`(${a}.recruiter_id = ${me} or ${a}.recruiter_id is null)`;
    case "hiring_manager":
      return sql`(${a}.hiring_manager_id = ${me} or ${a}.hiring_manager_id is null)`;
    case "interviewer":
      /* Assigned, still running, and nothing else — an interviewer never sees
         the rest of the pipeline, or anybody's earlier scores. */
      return sql`(${a}.status = 'in_progress' and (${a}.interviewer_id = ${me} or exists (
        select 1 from hire_stage_executions x
        where x.application_id = ${a}.id and x.conducted_by_id = ${me} and x.superseded_by_id is null
          and x.status in ('scheduled','in_progress'))))`;
    case "onboarding":
      return sql`(${a}.status = 'hired' or exists (
        select 1 from hire_decisions d
        where d.application_id = ${a}.id and d.decision_point = ${GATE_POINT} and d.decision = 'advance' and d.superseded_by_id is null))`;
  }
}

/** Interviewers must not see prior-stage scores (spec §8, design §7.3). */
export const seesScores = (ctx: HireContext) => ctx.role !== "interviewer";
