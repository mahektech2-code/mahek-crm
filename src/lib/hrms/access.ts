import "server-only";
import { cache } from "react";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { employeeReporting, employees, hrmsUserPowers, type User } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { isPlatformAdmin, levelInApp } from "@/lib/access-control";
import { listUserApps, listUserModules } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { HRMS_ALWAYS_OPEN, HRMS_SCREENS, gateOpen, hrmsListKeys, type HrmsScreen } from "./registry";
import { HRMS_POWERS, HRMS_POWER_LABEL, type HrmsPower } from "./powers";

/* ---------------------------------------------------------------------------
 * Who this person is INSIDE HRMS: their level, their powers, the screens they
 * hold, the employee record their account is, and so what they may see.
 * Resolved once per request — the layout, the page and every action ask the
 * same question.
 * ------------------------------------------------------------------------- */

export type HrmsEmployeeRef = {
  id: string;
  code: string;
  name: string;
  office: string | null;
  position: string | null;
  /** The sheet's "Position Type": Sales / OfficeStaff / Other. */
  positionType: string | null;
  reportsTo: string | null;
  status: string;
};

export type Scope = "mine" | "team" | "all";

export type HrmsContext = {
  user: User;
  level: "associate" | "manager" | "admin" | null;
  administrator: boolean;
  powers: ReadonlySet<HrmsPower>;
  /**
   * The powers somebody GRANTED this person, without the two a department
   * head holds by position. Only these widen a list to everybody: a head
   * checks out and marks the staff of their own office, and holding the power
   * that way must not show them the whole company's attendance.
   */
  granted: ReadonlySet<HrmsPower>;
  /** Screen keys this person may open. */
  screens: ReadonlySet<string>;
  /** The employee record this account is, when HR has linked one. */
  employee: HrmsEmployeeRef | null;
  /** A department head: Position ending in "Head" (spec §1.2). */
  isHead: boolean;
  /**
   * WHO REPORTS TO THIS PERSON — "my team". The org chart answers it
   * (`employee_reporting`, a person named as their manager), and the sheet's
   * Report To job title answers it only for people the chart has not placed
   * at all. Two models of one question used to give two answers: the CRM read
   * the chart for sales-manager seats while HRMS read the job title for team
   * scope, so moving somebody on the chart moved their accounts and not their
   * attendance. One answer now, with the job title as the fallback rather
   * than a rival.
   */
  team: ReadonlySet<string>;
  /** Holds the Admin Console's Access screen, where grants and powers are changed. */
  platformAdmin: boolean;
  /** Overtime / QR check-in switched on. */
  flags: { ot: boolean; qr: boolean };
};

export const isHeadPosition = (position: string | null | undefined) => /head\s*$/i.test(String(position ?? "").trim());

export const hrmsContext = cache(async function hrmsContext(): Promise<HrmsContext> {
  const user = await requireUser();
  const level = (await levelInApp(user, "hrms")) as HrmsContext["level"];
  const administrator = level === "admin" || user.role === "admin";

  const [powerRows, modules, config, platformAdmin] = await Promise.all([
    db.select({ power: hrmsUserPowers.power }).from(hrmsUserPowers).where(eq(hrmsUserPowers.userId, user.id)),
    level ? listUserModules(user.id, "hrms") : Promise.resolve([]),
    getConfig(),
    isPlatformAdmin(user),
  ]);

  let employee: HrmsEmployeeRef | null = null;
  const pick = {
    id: employees.id,
    code: employees.employeeCode,
    name: employees.name,
    office: employees.officeName,
    position: employees.position,
    positionType: employees.department,
    reportsTo: employees.reportsTo,
    status: employees.status,
  };
  if (user.employeeId) {
    const [e] = await db.select(pick).from(employees).where(eq(employees.id, user.employeeId)).limit(1);
    employee = e ?? null;
  }
  if (!employee && user.email) {
    /* The account was never linked. An exact, unique email match is safe to
       read as the person; anything looser is not (see users.employeeId). */
    const rows = await db.select(pick).from(employees).where(sql`lower(${employees.email}) = ${user.email.toLowerCase()}`).limit(2);
    if (rows.length === 1) employee = rows[0];
  }

  const isHead = isHeadPosition(employee?.position);
  const team = employee ? await teamOf(employee) : new Set<string>();
  const powers = new Set<HrmsPower>(
    administrator ? HRMS_POWERS : powerRows.map((r) => r.power).filter((p): p is HrmsPower => (HRMS_POWERS as readonly string[]).includes(p)),
  );
  /* A head marks and checks out the field and other staff of their office by
     position, as every head could in the source. */
  const granted = new Set(powers);
  if (isHead) {
    powers.add("markStaff");
    powers.add("checkoutStaff");
  }

  const flags = { ot: config["hrms.ot.enabled"], qr: config["hrms.attendance.qrEnabled"] };
  const held = new Set<string>(modules.map((m) => m.key.replace(/^hrms\./, "")));
  if (level) HRMS_ALWAYS_OPEN.forEach((k) => held.add(k));
  /* Holding a screen opens every tab of it that is for this person's role —
     or that a power they were GRANTED opens — so every check that names a
     tab's key (an action's screen, a badge, a home-page item) keeps working.
     A tab behind a setting that is off is not opened by anything. Only the
     lists are opened: a screen's own key is opened as a list only when it is
     one, so a grant naming a screen whose first list was removed (`kpi`)
     opens what is left of it and nothing else. */
  const role = administrator ? "admin" : level;
  const screens = new Set<string>();
  for (const sc of HRMS_SCREENS) {
    if (!held.has(sc.key) || !gateOpen(sc, role, granted)) continue;
    if (!sc.views) screens.add(sc.key);
    for (const tab of sc.views ?? []) if ((!tab.flag || flags[tab.flag]) && gateOpen(tab, role, granted)) screens.add(tab.key);
  }
  /* A MANAGER decides their team's leave by role, the way a head marks and
     checks out their office by position: in `powers`, never `granted`, so it
     widens no list, and every decision is checked against the team on the
     server (`decidesFor`). */
  if (level === "manager" && !administrator) {
    powers.add("markStaff");
    powers.add("checkoutStaff");
  }

  return { user, level, administrator, powers, granted, screens, employee, isHead, team, platformAdmin, flags };
});

/** Direct reports on the org chart, and — for people the chart has not placed — those whose Report To is my job title. */
async function teamOf(me: HrmsEmployeeRef): Promise<Set<string>> {
  const [chart, placed] = await Promise.all([
    db.select({ id: employeeReporting.employeeId }).from(employeeReporting).where(eq(employeeReporting.managerId, me.id)),
    db.select({ id: employeeReporting.employeeId }).from(employeeReporting),
  ]);
  const ids = new Set(chart.map((r) => r.id));
  if (me.position) {
    const onChart = new Set(placed.map((r) => r.id));
    const byTitle = await db
      .select({ id: employees.id })
      .from(employees)
      .where(sql`lower(trim(${employees.reportsTo})) = ${me.position.trim().toLowerCase()}`);
    for (const r of byTitle) if (!onChart.has(r.id)) ids.add(r.id);
  }
  ids.delete(me.id);
  return ids;
}

/** Whether this person holds a power. */
export const has = (ctx: HrmsContext, p: HrmsPower) => ctx.powers.has(p);

/**
 * How far a list reaches for this person — the three roles: everything for
 * the HR team (an HRMS administrator) or a holder of one of the widening
 * powers; the team on the org chart for a manager or a head; else their own.
 */
export function scopeOf(ctx: HrmsContext, ...widening: HrmsPower[]): Scope {
  if (ctx.administrator) return "all";
  if (widening.some((p) => ctx.granted.has(p))) return "all";
  if (ctx.level === "manager" || ctx.isHead || ctx.team.size > 0) return "team";
  return "mine";
}

/** Whether this person holds a screen: any of its lists is open to them. */
export const holdsScreen = (ctx: HrmsContext, sc: HrmsScreen) => hrmsListKeys(sc).some((k) => ctx.screens.has(k));

/**
 * WHO A LEAVE DECISION MAY BE MADE FOR. Somebody granted the power (or HR, or
 * an HRMS administrator) decides anybody's; a MANAGER decides their team's —
 * the org chart's — and never their own.
 */
export function decidesLeaveFor(ctx: HrmsContext, employeeId: string): boolean {
  if (ctx.administrator || ctx.granted.has("approveLeave")) return true;
  return ctx.level === "manager" && employeeId !== ctx.employee?.id && ctx.team.has(employeeId);
}

/**
 * A MANAGER ACTS ON THEIR TEAM'S REQUESTS, never their own (Nov 2026) — the
 * leave rule above, said once for the other things a manager answers: help
 * requests and expense claims. It sits in no power and widens no list; the
 * handler asks it of the one row it is about.
 */
export function managesFor(ctx: HrmsContext, employeeId: string): boolean {
  return ctx.level === "manager" && !ctx.administrator && employeeId !== ctx.employee?.id && ctx.team.has(employeeId);
}

/** Approving a help request: the resolve power for anybody's, a manager for their team's. */
export const resolvesHelpFor = (ctx: HrmsContext, employeeId: string) => has(ctx, "resolve") || managesFor(ctx, employeeId);

/** Verifying an expense: the verify power for anybody's, a manager for their team's. */
export const verifiesExpenseFor = (ctx: HrmsContext, employeeId: string) => has(ctx, "verifyExp") || managesFor(ctx, employeeId);

/** Whether this person decides any leave at all: the approver's buttons and badge. */
export const decidesLeave = (ctx: HrmsContext) => ctx.administrator || ctx.granted.has("approveLeave") || ctx.level === "manager";

/** The layout's gate: the app granted, or the launcher. */
export async function requireHrmsApp(): Promise<HrmsContext> {
  const ctx = await hrmsContext();
  const apps = await listUserApps(ctx.user.id);
  if (!apps.includes("hrms") || !ctx.level) {
    const { redirect } = await import("next/navigation");
    redirect("/apps");
  }
  return ctx;
}

export class HrmsNotPermitted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrmsNotPermitted";
  }
}

/**
 * A server action's gate. Both halves, because a server action is a URL: the
 * screen the write belongs to and, where the act needs one, the power.
 */
export async function requireHrmsWrite(screen: string, power?: HrmsPower): Promise<HrmsContext> {
  const ctx = await hrmsContext();
  const apps = await listUserApps(ctx.user.id);
  if (!apps.includes("hrms") || !ctx.level) throw new HrmsNotPermitted("HRMS is not on your account.");
  if (!ctx.screens.has(screen)) throw new HrmsNotPermitted("That HRMS screen is not on your account.");
  if (power && !ctx.powers.has(power)) throw new HrmsNotPermitted(powerRefusal(power));
  return ctx;
}

export function powerRefusal(power: HrmsPower): string {
  return `This needs the “${HRMS_POWER_LABEL[power].label}” power, which is not on your account. An HRMS administrator can grant it on the Access screen.`;
}

/** The signed-in person's employee record, or a refusal that says what to do. */
export function requireEmployee(ctx: HrmsContext): HrmsEmployeeRef {
  if (!ctx.employee) throw new HrmsNotPermitted("Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.");
  return ctx.employee;
}
