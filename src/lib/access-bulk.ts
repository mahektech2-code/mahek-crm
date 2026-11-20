import type { AppId } from "./apps";
import { ERP_POWERS, ERP_POWER_LABEL, type ErpPower } from "./erp/powers";
import { HRMS_POWERS, HRMS_POWER_LABEL } from "./hrms/powers";
import { TASK_POWERS, TASK_POWER_LABEL } from "./tasks/permissions";
import { moduleKeysForApp } from "./modules";

/* ---------------------------------------------------------------------------
 * ACCESS IN BULK — the arithmetic, PURE and client-safe.
 *
 * The Access dialog decides one person's whole picture at a time, which is
 * the right tool for a new joiner and the wrong one for "the Production Head
 * check shipped yesterday, who holds it?". On 2026-11-17 nobody did: the
 * Order Hub sat with two TOs nobody could check, the back office could not
 * open the new screen, and the fix was SQL because the console had no way to
 * see a power from the power's side or to change it for several people.
 *
 * Everything here works on the SAME input the dialog sends — `setAccess`'s
 * whole desired state — so a bulk change goes through every rule a single
 * save does (the last platform admin, the HRMS block, designation links,
 * the audit row). This file only works out what that state should become:
 *
 *   - `inputFromRow` rebuilds what somebody holds today as a save of it;
 *   - `applyChange` adds or takes away ONE power, screen or template on it,
 *     and says in words why a person was skipped rather than guessing.
 *
 * A power is useless without the screen it is used on — a holder of the
 * Production Head check who cannot open the Order Hub is told about TOs they
 * cannot reach — so granting a power also ticks its screens (`POWER_SCREENS`)
 * where the person's ERP is narrowed. Taking a power away leaves screens
 * alone: a screen has readers who never held the power.
 * ------------------------------------------------------------------------- */

export type PowerApp = "erp" | "hrms" | "tasks";

export type PowerDef = {
  app: PowerApp;
  key: string;
  /** `<app>.<key>` — one id across apps, the URL's and the bulk action's. */
  id: string;
  label: string;
  source: string;
  /** Module keys the power is used on. Granting the power ticks them. */
  screens: string[];
};

/**
 * Where each ERP power is USED — the screen a holder has to be able to open
 * for the power to mean anything. Read off where `powers.has(...)` is checked
 * in `lib/erp/screens`. Empty for the "see" powers, which reveal a column on
 * every screen rather than acting on one.
 */
export const ERP_POWER_SCREENS: Record<ErpPower, string[]> = {
  viewPurchaseMoney: [],
  viewCost: [],
  viewSalesRate: [],
  viewSalesAmounts: [],
  verifyTest: ["erp.register", "erp.testing"],
  verifyPurchase: ["erp.register"],
  reopenPurchase: ["erp.register"],
  purchaseBuyer: ["erp.requisitions", "erp.purchaseOrders"],
  approvePurchaseOrder: ["erp.purchaseOrders"],
  lostStock: ["erp.stock"],
  customerStatus: ["erp.customers"],
  approveParty: ["erp.orders"],
  verifyOrders: ["erp.orderHub", "erp.orders", "erp.toHold"],
  productionCheck: ["erp.orderHub", "erp.mrpCheck", "erp.toHold"],
  editOrders: ["erp.orders"],
  checkInvoices: ["erp.orders"],
  decideRequests: ["erp.requests"],
  employeeAdmin: ["erp.godowns"],
  approveSfgQc: ["erp.sfgBatches"],
  dispatchOverride: ["erp.dispatch"],
  stockControl: ["erp.stockCheck"],
  scrapSale: ["erp.scrapSales"],
  scrapAccounts: ["erp.scrapSales"],
  scrapApprove: ["erp.emptyDrums"],
  returnApprove: ["erp.vendorReturns"],
  returnQc: ["erp.customerReturns"],
  approveMoney: ["erp.expenses"],
};

export const ALL_POWERS: PowerDef[] = [
  ...ERP_POWERS.map((k) => ({ app: "erp" as const, key: k, id: `erp.${k}`, ...ERP_POWER_LABEL[k], screens: ERP_POWER_SCREENS[k] ?? [] })),
  ...HRMS_POWERS.map((k) => ({ app: "hrms" as const, key: k, id: `hrms.${k}`, ...HRMS_POWER_LABEL[k], screens: [] })),
  ...TASK_POWERS.map((k) => ({ app: "tasks" as const, key: k, id: `tasks.${k}`, ...TASK_POWER_LABEL[k], screens: [] })),
];

export function powerById(id: string): PowerDef | undefined {
  return ALL_POWERS.find((p) => p.id === id);
}

export const POWER_APP_FIELD = { erp: "erpPowers", hrms: "hrmsPowers", tasks: "taskPowers" } as const;

/* ------------------------------------------------------------ the shapes */

export type Level = "associate" | "manager" | "admin";
const RANK: Record<Level, number> = { associate: 0, manager: 1, admin: 2 };
export const widerLevel = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

/** What one person holds, in the terms the bulk arithmetic needs — a slice of `AccessRow`. */
export type HeldAccess = {
  userId: string;
  name: string;
  /** The account's own role; `admin` is a platform administrator. */
  role: Level;
  active: boolean;
  grants: { app: AppId; role: Level; modules: { key: string; granted: boolean }[] }[];
  erpPowers: string[];
  hrmsPowers: string[];
  taskPowers: string[];
  /** Their job inside Hire, and the name on their ERP access — read by a template that carries them. */
  hireRole?: string | null;
  erpDesignation?: { id: string } | null;
};

/** `setAccess`'s input, the parts a bulk change touches. Everything else is left absent, which means "as it is". */
export type BulkSave = {
  userId: string;
  grants: { app: string; modules: string[]; role: Level }[];
  erpPowers: string[];
  hrmsPowers: string[];
  taskPowers: string[];
  /** Absent means "as it is" — only a template that names one sets it. */
  hireRole?: string | null;
  erpDesignationId?: string | null;
};

/** What somebody holds today, as a save of exactly that. Saving it changes nothing. */
export function inputFromRow(row: HeldAccess): BulkSave {
  return {
    userId: row.userId,
    grants: row.grants.map((g) => ({ app: g.app, role: g.role, modules: g.modules.filter((m) => m.granted).map((m) => m.key) })),
    erpPowers: [...row.erpPowers],
    hrmsPowers: [...row.hrmsPowers],
    taskPowers: [...row.taskPowers],
  };
}

/** Does this person hold the power, by row or because they administer its app? */
export function holdsPower(row: HeldAccess, p: Pick<PowerDef, "app" | "key">): "row" | "admin" | null {
  const g = row.grants.find((x) => x.app === p.app);
  if (!g) return null;
  if (row[POWER_APP_FIELD[p.app]].includes(p.key)) return "row";
  if (g.role === "admin" || row.role === "admin") return "admin";
  return null;
}

/** Can this person open the screen? A whole-app grant opens every screen, including ones built later. */
export function holdsScreen(row: HeldAccess, module: string): boolean {
  const app = module.split(".")[0];
  const g = row.grants.find((x) => x.app === app);
  if (!g) return false;
  return g.modules.some((m) => m.key === module && m.granted);
}

/* ------------------------------------------------------------ templates */

/** A job template's content: apps, each at a level with screens (null = the whole app), plus powers. */
export type AccessTemplateShape = {
  apps: { app: AppId; role: Level; modules: string[] | null }[];
  erpPowers: string[];
  hrmsPowers: string[];
  taskPowers: string[];
  /**
   * The job inside Hire and the ERP designation, where the template names them.
   * They used to be left out, so a template stamped "Sales coordinator" onto
   * somebody with every screen and none of the name — outside every later edit
   * to the designation. Applied only to somebody the template gives that app.
   */
  hireRole?: string | null;
  erpDesignationId?: string | null;
};

/** A person's access as a template — "make a template from Puja". Whole-app grants stay whole. */
export function shapeFromRow(row: HeldAccess): AccessTemplateShape {
  return {
    apps: row.grants.map((g) => {
      const granted = g.modules.filter((m) => m.granted).map((m) => m.key);
      const whole = g.modules.every((m) => m.granted);
      return { app: g.app, role: g.role, modules: whole ? null : granted };
    }),
    erpPowers: [...row.erpPowers],
    hrmsPowers: [...row.hrmsPowers],
    taskPowers: [...row.taskPowers],
    hireRole: row.grants.some((g) => g.app === "hire") ? (row.hireRole ?? null) : null,
    erpDesignationId: row.grants.some((g) => g.app === "erp") ? (row.erpDesignation?.id ?? null) : null,
  };
}

/** Drop anything that no longer exists — a screen removed, a power renamed — so an old template still applies. */
export function cleanShape(raw: unknown): AccessTemplateShape {
  const s = (raw ?? {}) as Partial<AccessTemplateShape>;
  const levels: Level[] = ["associate", "manager", "admin"];
  const apps = (Array.isArray(s.apps) ? s.apps : [])
    .filter((a) => a && typeof a.app === "string" && moduleKeysForApp(a.app as AppId).length > 0)
    .map((a) => {
      const known = new Set(moduleKeysForApp(a.app));
      return {
        app: a.app,
        role: levels.includes(a.role) ? a.role : "associate",
        modules: a.modules == null ? null : [...new Set(a.modules.filter((m) => known.has(m)))],
      };
    });
  const pick = (list: unknown, allowed: readonly string[]) => (Array.isArray(list) ? [...new Set(list.filter((p): p is string => typeof p === "string" && allowed.includes(p)))] : []);
  /* Kept as written: `setAccess` refuses a designation that no longer exists or a role that is not Hire's. */
  const word = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    apps,
    erpPowers: pick(s.erpPowers, ERP_POWERS),
    hrmsPowers: pick(s.hrmsPowers, HRMS_POWERS),
    taskPowers: pick(s.taskPowers, TASK_POWERS),
    hireRole: word(s.hireRole),
    erpDesignationId: word(s.erpDesignationId),
  };
}

/**
 * Whether a template would make somebody a PLATFORM ADMINISTRATOR — Admin on
 * the Admin Console, the one hat that changes everybody else's access. A
 * template stamps onto many people at once, so it never carries that: it is
 * given one person at a time, on their own Manage page, where the review
 * names it.
 */
export function grantsPlatformAdmin(shape: AccessTemplateShape): boolean {
  return shape.apps.some((a) => a.app === "admin" && a.role === "admin");
}

export const PLATFORM_ADMIN_IN_TEMPLATE =
  "A template cannot make somebody a platform administrator. Give that one person at a time, on their own Manage page — and take Admin Console at admin out of this template.";

/* ------------------------------------------------------------ the change */

export type BulkChange =
  | { kind: "power"; power: string; on: boolean; /** Give the app too, as an associate with the power's screens, where they lack it. */ grantApp?: boolean }
  | { kind: "screen"; module: string; on: boolean; grantApp?: boolean }
  | { kind: "template"; shape: AccessTemplateShape };

export type Applied = { save: BulkSave; changed: true; words: string } | { changed: false; why: string };

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function grantOf(save: BulkSave, app: string) {
  return save.grants.find((g) => g.app === app);
}

/** Add screens to an app's grant; a whole-app grant already holds them. */
function addScreens(save: BulkSave, app: string, modules: string[]): boolean {
  const g = grantOf(save, app);
  if (!g) return false;
  const all = moduleKeysForApp(app as AppId);
  const before = g.modules.length;
  for (const m of modules) if (all.includes(m) && !g.modules.includes(m)) g.modules.push(m);
  return g.modules.length !== before;
}

/**
 * One change, on one person. Pure: returns the save to make, or why nothing
 * should be. It never narrows anything a change did not name.
 */
export function applyChange(row: HeldAccess, change: BulkChange): Applied {
  const save = inputFromRow(row);
  const before = JSON.stringify(save);

  if (change.kind === "power") {
    const p = powerById(change.power);
    if (!p) return { changed: false, why: "That power no longer exists." };
    const field = POWER_APP_FIELD[p.app];
    const has = grantOf(save, p.app);
    if (change.on) {
      if (!has) {
        if (!change.grantApp) return { changed: false, why: `does not hold ${p.app.toUpperCase()}` };
        save.grants.push({ app: p.app, role: "associate", modules: [] });
        const base = moduleKeysForApp(p.app).filter((k) => p.screens.includes(k));
        grantOf(save, p.app)!.modules.push(...base);
        if (!base.length) grantOf(save, p.app)!.modules.push(...moduleKeysForApp(p.app));
      }
      if (!save[field].includes(p.key)) save[field].push(p.key);
      addScreens(save, p.app, p.screens);
    } else {
      save[field] = save[field].filter((k) => k !== p.key);
      if (holdsPower(row, p) === "admin") return { changed: false, why: `administers ${p.app.toUpperCase()}, which holds every power without a grant` };
    }
  } else if (change.kind === "screen") {
    const app = change.module.split(".")[0];
    if (!moduleKeysForApp(app as AppId).includes(change.module)) return { changed: false, why: "That screen no longer exists." };
    const g = grantOf(save, app);
    if (change.on) {
      if (!g) {
        if (!change.grantApp) return { changed: false, why: `does not hold ${app.toUpperCase()}` };
        save.grants.push({ app, role: "associate", modules: [change.module] });
      } else addScreens(save, app, [change.module]);
    } else {
      if (!g) return { changed: false, why: "does not hold the app" };
      g.modules = g.modules.filter((m) => m !== change.module);
      /* An app with no screens left is an app taken away — that is a revocation, confirmed one person at a time on the dialog. */
      if (!g.modules.length) return { changed: false, why: "it is the only screen they hold — take the app away on their own Access page" };
    }
  } else {
    const t = cleanShape(change.shape);
    for (const a of t.apps) {
      const g = grantOf(save, a.app);
      const modules = a.modules ?? moduleKeysForApp(a.app);
      if (!g) save.grants.push({ app: a.app, role: a.role, modules: [...modules] });
      else {
        g.role = widerLevel(g.role, a.role);
        addScreens(save, a.app, modules);
      }
    }
    for (const field of ["erpPowers", "hrmsPowers", "taskPowers"] as const) {
      const app = field === "erpPowers" ? "erp" : field === "hrmsPowers" ? "hrms" : "tasks";
      if (!grantOf(save, app)) continue;
      for (const k of t[field]) if (!save[field].includes(k)) save[field].push(k);
      if (app === "erp") for (const k of t[field]) addScreens(save, "erp", ERP_POWER_SCREENS[k as ErpPower] ?? []);
    }
    if (t.hireRole && grantOf(save, "hire") && row.hireRole !== t.hireRole) save.hireRole = t.hireRole;
    if (t.erpDesignationId && grantOf(save, "erp") && row.erpDesignation?.id !== t.erpDesignationId) save.erpDesignationId = t.erpDesignationId;
  }

  if (JSON.stringify(save) === before) return { changed: false, why: "already holds it" };
  return { save, changed: true, words: describeSave(inputFromRow(row), save) };
}

const labelOfPower = (app: PowerApp, key: string) => powerById(`${app}.${key}`)?.label ?? key;

/** What a save changes, in words, for the result list. */
export function describeSave(from: BulkSave, to: BulkSave): string {
  const out: string[] = [];
  for (const g of to.grants) {
    const was = from.grants.find((x) => x.app === g.app);
    if (!was) out.push(`given ${g.app.toUpperCase()} (${g.role})`);
    else {
      if (was.role !== g.role) out.push(`${g.app.toUpperCase()} ${was.role} → ${g.role}`);
      const added = g.modules.filter((m) => !was.modules.includes(m));
      const gone = was.modules.filter((m) => !g.modules.includes(m));
      if (added.length) out.push(`+${added.length} ${g.app.toUpperCase()} screen${added.length === 1 ? "" : "s"}`);
      if (gone.length) out.push(`−${gone.length} ${g.app.toUpperCase()} screen${gone.length === 1 ? "" : "s"}`);
    }
  }
  for (const [field, app] of [["erpPowers", "erp"], ["hrmsPowers", "hrms"], ["taskPowers", "tasks"]] as const) {
    if (sameSet(from[field], to[field])) continue;
    const added = to[field].filter((k) => !from[field].includes(k));
    const gone = from[field].filter((k) => !to[field].includes(k));
    for (const k of added) out.push(`may ${labelOfPower(app, k).toLowerCase()}`);
    for (const k of gone) out.push(`no longer ${labelOfPower(app, k).toLowerCase()}`);
  }
  if (to.hireRole !== undefined && to.hireRole !== from.hireRole) out.push(`Hire role ${to.hireRole ?? "from the level"}`);
  if (to.erpDesignationId !== undefined && to.erpDesignationId !== from.erpDesignationId) out.push("given the template's ERP designation");
  return out.join(" · ");
}
