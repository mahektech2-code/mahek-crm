import "server-only";
import { cache } from "react";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsUserPowers, type User } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { levelInApp } from "@/lib/access-control";
import { listUserApps, listUserModules } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { HRMS_ALWAYS_OPEN, HRMS_SCREENS } from "./registry";
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
  /** Screen keys this person may open. */
  screens: ReadonlySet<string>;
  /** The employee record this account is, when HR has linked one. */
  employee: HrmsEmployeeRef | null;
  /** A department head: Position ending in "Head" (spec §1.2). */
  isHead: boolean;
  /** Overtime / QR check-in switched on. */
  flags: { ot: boolean; qr: boolean };
};

export const isHeadPosition = (position: string | null | undefined) => /head\s*$/i.test(String(position ?? "").trim());

export const hrmsContext = cache(async function hrmsContext(): Promise<HrmsContext> {
  const user = await requireUser();
  const level = (await levelInApp(user, "hrms")) as HrmsContext["level"];
  const administrator = level === "admin" || user.role === "admin";

  const [powerRows, modules, config] = await Promise.all([
    db.select({ power: hrmsUserPowers.power }).from(hrmsUserPowers).where(eq(hrmsUserPowers.userId, user.id)),
    level ? listUserModules(user.id, "hrms") : Promise.resolve([]),
    getConfig(),
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
  const powers = new Set<HrmsPower>(
    administrator ? HRMS_POWERS : powerRows.map((r) => r.power).filter((p): p is HrmsPower => (HRMS_POWERS as readonly string[]).includes(p)),
  );
  /* A head marks and checks out the field and other staff of their office by
     position, as every head could in the source. */
  if (isHead) {
    powers.add("markStaff");
    powers.add("checkoutStaff");
  }

  const flags = { ot: config["hrms.ot.enabled"], qr: config["hrms.attendance.qrEnabled"] };
  const held = new Set<string>(modules.map((m) => m.key.replace(/^hrms\./, "")));
  if (level) HRMS_ALWAYS_OPEN.forEach((k) => held.add(k));
  /* Holding a screen opens every tab of it, so every check that names a tab's
     key — an action's screen, a badge, a home-page item — keeps working. A
     tab behind a setting that is off is not opened by anything. */
  const screens = new Set<string>();
  for (const sc of HRMS_SCREENS) {
    if (!held.has(sc.key)) continue;
    screens.add(sc.key);
    for (const tab of sc.views ?? []) if (!tab.flag || flags[tab.flag]) screens.add(tab.key);
  }

  return { user, level, administrator, powers, screens, employee, isHead, flags };
});

/** Whether this person holds a power. */
export const has = (ctx: HrmsContext, p: HrmsPower) => ctx.powers.has(p);

/**
 * How far a list reaches for this person (spec §2.2): everything for a
 * manager-level grant or a holder of one of the widening powers, the team
 * (employees whose Report To is my position) for a head, else their own.
 */
export function scopeOf(ctx: HrmsContext, ...widening: HrmsPower[]): Scope {
  if (ctx.administrator || ctx.level === "manager") return "all";
  if (widening.some((p) => ctx.powers.has(p))) return "all";
  if (ctx.isHead) return "team";
  return "mine";
}

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
  if (!ctx.screens.has(screen)) throw new HrmsNotPermitted("That screen is not on your account.");
  if (power && !ctx.powers.has(power)) throw new HrmsNotPermitted(powerRefusal(power));
  return ctx;
}

export function powerRefusal(power: HrmsPower): string {
  return `Not on your account: ${HRMS_POWER_LABEL[power].label.toLowerCase()}.`;
}

/** The signed-in person's employee record, or a refusal that says what to do. */
export function requireEmployee(ctx: HrmsContext): HrmsEmployeeRef {
  if (!ctx.employee) throw new HrmsNotPermitted("Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.");
  return ctx.employee;
}
