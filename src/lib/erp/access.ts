import "server-only";
import { cache } from "react";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  erpGodownStaff,
  erpGodowns,
  erpUserPowers,
  erpUserSettings,
  type User,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { levelInApp } from "@/lib/access-control";
import { listUserApps, listUserModules } from "@/lib/access";
import { ERP_ALWAYS_OPEN } from "./registry";
import { ERP_POWERS, type ErpPower } from "./powers";

/* ---------------------------------------------------------------------------
 * Who this person is INSIDE the ERP: their level, their powers, the screens
 * they hold and the godown they are working at. Resolved once per request —
 * the layout, the page and every action ask the same question.
 * ------------------------------------------------------------------------- */

export type ErpGodownRef = { id: string; name: string; reserved: boolean };

export type ErpContext = {
  user: User;
  /** The level on the `erp` grant; null means not granted (the layout redirects). */
  level: "associate" | "manager" | "admin" | null;
  /** True for an ERP administrator — holds every power without a row. */
  administrator: boolean;
  powers: ReadonlySet<ErpPower>;
  /** Screen keys (not module keys) this person may open. */
  screens: ReadonlySet<string>;
  /** Godowns the person is assigned to and may work at. */
  assignedGodowns: ErpGodownRef[];
  /** The working location, or the first assigned godown, or null. */
  workingGodown: ErpGodownRef | null;
};

export const erpContext = cache(async function erpContext(): Promise<ErpContext> {
  const user = await requireUser();
  const level = (await levelInApp(user, "erp")) as ErpContext["level"];
  const administrator = level === "admin" || user.role === "admin";

  const [powerRows, modules, staffRows, setting] = await Promise.all([
    db.select({ power: erpUserPowers.power }).from(erpUserPowers).where(eq(erpUserPowers.userId, user.id)),
    level ? listUserModules(user.id, "erp") : Promise.resolve([]),
    db
      .select({ id: erpGodowns.id, name: erpGodowns.name, reserved: erpGodowns.reserved, status: erpGodowns.status })
      .from(erpGodownStaff)
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpGodownStaff.godownId))
      .where(eq(erpGodownStaff.userId, user.id)),
    db.select().from(erpUserSettings).where(eq(erpUserSettings.userId, user.id)).limit(1),
  ]);

  const powers = new Set<ErpPower>(
    administrator ? ERP_POWERS : powerRows.map((r) => r.power).filter((p): p is ErpPower => (ERP_POWERS as readonly string[]).includes(p)),
  );

  const screens = new Set<string>(modules.map((m) => m.key.replace(/^erp\./, "")));
  if (level) ERP_ALWAYS_OPEN.forEach((k) => screens.add(k));

  /*
   * AN ADMINISTRATOR IS ASSIGNED EVERYWHERE. The source's CEO picks any godown;
   * making the owner list themselves against forty godowns before the working
   * location works would be a chore that exists only to be skipped.
   */
  let assigned: ErpGodownRef[] = staffRows
    .filter((g) => g.status === "active" && !g.reserved)
    .map((g) => ({ id: g.id, name: g.name, reserved: g.reserved }));
  if (administrator) {
    const all = await db
      .select({ id: erpGodowns.id, name: erpGodowns.name, reserved: erpGodowns.reserved })
      .from(erpGodowns)
      .where(and(eq(erpGodowns.status, "active"), eq(erpGodowns.reserved, false)));
    assigned = all;
  }
  assigned.sort((a, b) => a.name.localeCompare(b.name));

  const chosen = setting[0]?.workingGodownId;
  const workingGodown = assigned.find((g) => g.id === chosen) ?? assigned[0] ?? null;

  return {
    user,
    level,
    administrator,
    powers,
    screens,
    assignedGodowns: assigned,
    workingGodown,
  };
});

/** The layout's gate: the app granted, or the launcher. */
export async function requireErpApp(): Promise<ErpContext> {
  const ctx = await erpContext();
  const apps = await listUserApps(ctx.user.id);
  if (!apps.includes("erp") || !ctx.level) {
    const { redirect } = await import("next/navigation");
    redirect("/apps");
  }
  return ctx;
}

export class ErpNotPermitted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErpNotPermitted";
  }
}

/**
 * A server action's gate. Both halves, because a server action is a URL: the
 * screen the write belongs to (a storekeeper may not post an order because a
 * button is hidden) and, where the act needs one, the power.
 */
export async function requireErpWrite(screen: string, power?: ErpPower): Promise<ErpContext> {
  const ctx = await erpContext();
  const apps = await listUserApps(ctx.user.id);
  if (!apps.includes("erp") || !ctx.level) throw new ErpNotPermitted("The ERP is not on your account.");
  if (!ctx.screens.has(screen)) throw new ErpNotPermitted("That screen is not on your account.");
  if (power && !ctx.powers.has(power)) throw new ErpNotPermitted(powerRefusal(power));
  return ctx;
}

export function powerRefusal(power: ErpPower): string {
  const map: Record<ErpPower, string> = {
    viewPurchaseMoney: "Purchase money is not on your account.",
    viewCost: "Cost and margin are not on your account.",
    viewSalesRate: "The sales rate is not on your account.",
    viewSalesAmounts: "Sales amounts are not on your account.",
    verifyTest: "Only the verifier decides a purchase test.",
    verifyPurchase: "Only the verifier sets a purchase to Purchase Verified.",
    reopenPurchase: "Only an admin sets a verified purchase back to Pending.",
    lostStock: "Only somebody who can write off stock may use Item Lost Record.",
    customerStatus: "Only an admin or the office changes a customer's status.",
    approveParty: "Only an admin approves orders from a pending customer.",
    decideRequests: "Only the CEO or an admin decides a customer request.",
    employeeAdmin: "Only an ERP administrator manages the directory and ERP powers.",
  };
  return map[power];
}

/** Names of godowns a list of ids resolves to — for audit sentences and toasts. */
export async function godownNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: erpGodowns.id, name: erpGodowns.name })
    .from(erpGodowns)
    .where(inArray(erpGodowns.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
