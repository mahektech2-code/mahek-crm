import "server-only";
import { cache } from "react";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  erpDesignationModules,
  erpDesignationPowers,
  erpDesignations,
  erpGodownStaff,
  erpGodowns,
  erpUserDesignations,
  erpUserPowers,
  erpUserSettings,
  users,
  type User,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { levelInApp } from "@/lib/access-control";
import { listUserApps, listUserModules } from "@/lib/access";
import { ERP_ALWAYS_OPEN, ERP_SCREENS, erpKeysOf } from "./registry";
import { ERP_POWERS, type ErpPower } from "./powers";
import { isDepartmentSeat, type ErpDepartmentSeat } from "./departments";

/* ---------------------------------------------------------------------------
 * Who this person is INSIDE the ERP: their level, their powers, the screens
 * they hold and the godown they are working at. Resolved once per request —
 * the layout, the page and every action ask the same question.
 * ------------------------------------------------------------------------- */

export type ErpGodownRef = { id: string; name: string; reserved: boolean };

/** Who the ERP is being previewed as, where an administrator has asked. */
export type ErpViewingAs = { kind: "designation" | "user"; id: string; label: string };

export type ErpContext = {
  /**
   * Whose ERP this is. Ordinarily the person signed in; while an
   * administrator previews the ERP AS somebody, that person — so "my
   * customers", "my expenses" and every scoped list answer as they would for
   * them. Never the author of a write: nothing is written while previewing.
   */
  user: User;
  /** The person actually signed in. Equal to `user` unless previewing. */
  actor: User;
  /** Set while previewing. Every write refuses while it is. */
  viewingAs: ErpViewingAs | null;
  /** The level on the `erp` grant; null means not granted (the layout redirects). */
  level: "associate" | "manager" | "admin" | null;
  /** True for an ERP administrator — holds every power without a row. */
  administrator: boolean;
  powers: ReadonlySet<ErpPower>;
  /** Screen keys (not module keys) this person may open, and the keys of those screens' tabs. */
  screens: ReadonlySet<string>;
  /** Godowns the person is assigned to and may work at. */
  assignedGodowns: ErpGodownRef[];
  /** The working location, or the first assigned godown, or null. */
  workingGodown: ErpGodownRef | null;
  /** The ERP designation they hold, by name, for the header. Null where none. */
  designation: string | null;
  /**
   * The production department their designation works in — one of the three,
   * or `head` for all of them (`lib/erp/departments.ts`). Null for anybody
   * not in one, and always for an administrator: neither is narrowed.
   */
  department: ErpDepartmentSeat | null;
};

type Resolved = Omit<ErpContext, "actor" | "viewingAs">;

/** A screen's tabs come with the screen: see the comment in `resolveFor`. */
function screensFrom(held: Set<string>): Set<string> {
  const screens = new Set<string>();
  for (const sc of ERP_SCREENS) if (held.has(sc.key)) erpKeysOf(sc).forEach((k) => screens.add(k));
  return screens;
}

async function allActiveGodowns(): Promise<ErpGodownRef[]> {
  return db
    .select({ id: erpGodowns.id, name: erpGodowns.name, reserved: erpGodowns.reserved })
    .from(erpGodowns)
    .where(and(eq(erpGodowns.status, "active"), eq(erpGodowns.reserved, false)));
}

/** Everything the ERP needs to know about one person, read from their own grants. */
async function resolveFor(user: User): Promise<Resolved> {
  const level = (await levelInApp(user, "erp")) as ErpContext["level"];
  const administrator = level === "admin" || user.role === "admin";

  const [powerRows, modules, staffRows, setting, designationRow] = await Promise.all([
    db.select({ power: erpUserPowers.power }).from(erpUserPowers).where(eq(erpUserPowers.userId, user.id)),
    level ? listUserModules(user.id, "erp") : Promise.resolve([]),
    db
      .select({ id: erpGodowns.id, name: erpGodowns.name, reserved: erpGodowns.reserved, status: erpGodowns.status })
      .from(erpGodownStaff)
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpGodownStaff.godownId))
      .where(eq(erpGodownStaff.userId, user.id)),
    db.select().from(erpUserSettings).where(eq(erpUserSettings.userId, user.id)).limit(1),
    db
      .select({ name: erpDesignations.name, department: erpDesignations.department })
      .from(erpUserDesignations)
      .innerJoin(erpDesignations, eq(erpDesignations.id, erpUserDesignations.designationId))
      .where(eq(erpUserDesignations.userId, user.id))
      .limit(1),
  ]);

  const powers = new Set<ErpPower>(
    administrator ? ERP_POWERS : powerRows.map((r) => r.power).filter((p): p is ErpPower => (ERP_POWERS as readonly string[]).includes(p)),
  );

  const held = new Set<string>(modules.map((m) => m.key.replace(/^erp\./, "")));
  if (level) ERP_ALWAYS_OPEN.forEach((k) => held.add(k));
  /* A screen's tabs come with the screen: they are not modules, so nothing
     could grant them on their own, and every check below that names a tab's
     key (a dashboard tile, a sidebar count, an action) answers as the screen. */
  const screens = screensFrom(held);

  /*
   * AN ADMINISTRATOR IS ASSIGNED EVERYWHERE. The source's CEO picks any godown;
   * making the owner list themselves against forty godowns before the working
   * location works would be a chore that exists only to be skipped.
   */
  let assigned: ErpGodownRef[] = staffRows
    .filter((g) => g.status === "active" && !g.reserved)
    .map((g) => ({ id: g.id, name: g.name, reserved: g.reserved }));
  if (administrator) assigned = await allActiveGodowns();
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
    designation: designationRow[0]?.name ?? null,
    department: !administrator && isDepartmentSeat(designationRow[0]?.department) ? designationRow[0].department : null,
  };
}

/* ---------------------------------------------------------------------------
 * PREVIEWING THE ERP AS SOMEBODY ELSE.
 *
 * An ERP administrator can see the ERP exactly as a designation, or as one
 * person, would: the same sidebar, the same columns hidden, the same lists
 * narrowed. It is READ-ONLY — `requireErpWrite` refuses every write while it
 * is on, whoever's powers are in force — because acting with somebody else's
 * access is a different thing to look at with it, and needs a different
 * record. It lives in a cookie the server re-checks on every request: a
 * cookie naming a preview is honoured only while the person holding it is
 * still an ERP administrator, so taking that away ends the preview too.
 * ------------------------------------------------------------------------- */

export const VIEW_AS_COOKIE = "mahekone_erp_view_as";

let testViewAs: string | null = null;
/** The test seam, beside `setTestUser`: there is no cookie jar under `NODE_ENV=test`. */
export function setTestViewAs(value: string | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setTestViewAs is a test seam");
  testViewAs = value;
}

async function readViewAs(): Promise<{ kind: "designation" | "user"; id: string } | null> {
  let raw: string | null;
  if (process.env.NODE_ENV === "test") raw = testViewAs;
  else {
    const { cookies } = await import("next/headers");
    raw = (await cookies()).get(VIEW_AS_COOKIE)?.value ?? null;
  }
  const m = /^(designation|user):(.+)$/.exec(raw ?? "");
  return m ? { kind: m[1] as "designation" | "user", id: m[2] } : null;
}

/** The ERP as a designation describes it — what somebody holding exactly it would see. */
async function resolveForDesignation(real: Resolved, id: string): Promise<Resolved | null> {
  const [d] = await db.select().from(erpDesignations).where(eq(erpDesignations.id, id)).limit(1);
  if (!d) return null;
  const [mods, pows] = await Promise.all([
    db.select({ module: erpDesignationModules.module }).from(erpDesignationModules).where(eq(erpDesignationModules.designationId, id)),
    db.select({ power: erpDesignationPowers.power }).from(erpDesignationPowers).where(eq(erpDesignationPowers.designationId, id)),
  ]);
  const level = (d.level === "admin" || d.level === "manager" ? d.level : "associate") as ErpContext["level"];
  const administrator = level === "admin";
  const held = new Set<string>(
    d.allScreens ? ERP_SCREENS.filter((sc) => sc.built).map((sc) => sc.key) : mods.map((m) => m.module.replace(/^erp\./, "")),
  );
  ERP_ALWAYS_OPEN.forEach((k) => held.add(k));
  return {
    /* Nobody in particular holds a designation, so "my" lists answer for the
       administrator previewing — the one honest choice, and it is said on
       the banner. The godowns are theirs for the same reason. */
    user: real.user,
    level,
    administrator,
    powers: new Set<ErpPower>(administrator ? ERP_POWERS : pows.map((p) => p.power).filter((p): p is ErpPower => (ERP_POWERS as readonly string[]).includes(p))),
    screens: screensFrom(held),
    assignedGodowns: real.assignedGodowns,
    workingGodown: real.workingGodown,
    designation: d.name,
    department: !administrator && isDepartmentSeat(d.department) ? d.department : null,
  };
}

/**
 * Whether this person may preview the ERP as somebody else: an ERP
 * administrator who can open the ERP. Asked of the person SIGNED IN, never of
 * whoever a preview is showing.
 */
export async function isErpAdministrator(user: User): Promise<boolean> {
  const real = await resolveFor(user);
  if (!real.administrator || !real.level) return false;
  return (await listUserApps(user.id)).includes("erp");
}

export const erpContext = cache(async function erpContext(): Promise<ErpContext> {
  const actor = await requireUser();
  const real = await resolveFor(actor);
  const asked = real.administrator && real.level ? await readViewAs() : null;
  if (asked?.kind === "designation") {
    const as = await resolveForDesignation(real, asked.id);
    if (as) return { ...as, actor, viewingAs: { kind: "designation", id: asked.id, label: as.designation ?? "a designation" } };
  }
  if (asked?.kind === "user" && asked.id !== actor.id) {
    const [target] = await db.select().from(users).where(eq(users.id, asked.id)).limit(1);
    if (target?.active) {
      const as = await resolveFor(target);
      if (as.level) return { ...as, actor, viewingAs: { kind: "user", id: target.id, label: target.name } };
    }
  }
  return { ...real, actor, viewingAs: null };
});

/** The layout's gate: the app granted, or the launcher. */
export async function requireErpApp(): Promise<ErpContext> {
  const ctx = await erpContext();
  const apps = await listUserApps(ctx.actor.id);
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
  if (ctx.viewingAs) throw new ErpNotPermitted(previewRefusal(ctx.viewingAs));
  return requireErpScreen(ctx, screen, power);
}

/** The refusal every write gives while the ERP is being previewed as somebody. */
export function previewRefusal(as: ErpViewingAs): string {
  return `You are previewing the ERP as ${as.label}, so nothing can be saved. Leave the preview to work as yourself.`;
}

/**
 * Opening a form, which writes nothing — so a preview may open one and see
 * exactly the fields that person is offered. Its submit still goes through
 * `requireErpWrite`.
 */
export async function requireErpForm(screen: string): Promise<ErpContext> {
  return requireErpScreen(await erpContext(), screen);
}

async function requireErpScreen(ctx: ErpContext, screen: string, power?: ErpPower): Promise<ErpContext> {
  const apps = await listUserApps(ctx.actor.id);
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
    purchaseBuyer: "Only the buyer decides how a requirement is bought.",
    approvePurchaseOrder: "Only the PO approver approves a purchase order.",
    lostStock: "Only somebody who can write off stock may use Item Lost Record.",
    customerStatus: "Only an admin or the office changes a customer's status.",
    approveParty: "Only an admin approves orders from a pending customer.",
    decideRequests: "Only the CEO or an admin decides a customer request.",
    employeeAdmin: "Only an ERP administrator manages godowns and ERP powers.",
    approveSfgQc: "Only the SFG QC approver decides an SFG lot's quality check.",
    dispatchOverride: "Only a dispatch-override approver lets a mismatched box go, or rejects or returns a box.",
      pettyAccounts: "The petty-cash accounts team does this.",
    pettyApprove: "Only a petty-cash approver does this.",
    pettyOwner: "Only the owner does this.",
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
