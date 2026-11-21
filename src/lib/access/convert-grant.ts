import type { AppId } from "../apps";
import { CAPABILITIES, can } from "../capability-matrix";
import { ALWAYS_OPEN_MODULES, writeLevelsForApp } from "../modules";
import { ERP_POWERS } from "../erp/powers";
import { HRMS_POWERS } from "../hrms/powers";
import { TASK_POWERS } from "../tasks/permissions";
import type { Role } from "../role-levels";
import type { Owner } from "./action-owners";
import { POSITION_RANK, normaliseGrant, type AppGrantDraft, type ScreenTicks } from "./permission-rules";
import { ERP_POWER_OWNERS, HRMS_POWER_OWNERS, TASK_POWER_OWNERS } from "./power-owners";
import { draftFromLevel, holdsAny, holdsWithScreens, moduleShape } from "./screen-permissions";

/* ---------------------------------------------------------------------------
 * ONE GRANT MADE UNDER LEVELS, AS THE SCREEN MODEL WILL STORE IT — AND THE
 * PROOF OF WHAT THAT MOVES.
 *
 * `convertGrant` reads what somebody holds in an app today: the level on the
 * grant, the screens it was narrowed to (none stored means every screen), the
 * app's own powers (ERP, HRMS, Tasks), and whether they are the platform
 * administrator. It writes Position and ticks.
 *
 * `compareConversion` answers, for that one person and app, what they could
 * do before and cannot after, and the reverse. The backfill refuses to write a
 * grant that loses anything on a screen the person still holds. A capability
 * held today only through a screen the grant was NARROWED away from is
 * reported apart — under the screen model a permission belongs to a screen,
 * so it goes with the screen; that list is read before anything is switched.
 *
 * Pure: no database, so every case is pinned in `convert-grant.test.ts`.
 * ------------------------------------------------------------------------- */

export type GrantToday = {
  app: AppId;
  /** The level on the grant. NULL is an associate's (`A GRANT WITH NO LEVEL IS AN ASSOCIATE'S`). */
  role: Role | null;
  /** The module keys stored for the app; null when none are, which is every screen. */
  modules: readonly string[] | null;
  /** The app's own power rows — ERP, HRMS or Tasks; ignored elsewhere. */
  powers: readonly string[];
  platformAdmin: boolean;
};

const POWER_TABLES: Partial<Record<AppId, { all: readonly string[]; owners: Record<string, Owner[]> }>> = {
  erp: { all: ERP_POWERS, owners: ERP_POWER_OWNERS },
  hrms: { all: HRMS_POWERS, owners: HRMS_POWER_OWNERS },
  tasks: { all: TASK_POWERS, owners: TASK_POWER_OWNERS },
};

/** An app's administrator, or the platform administrator: every screen, every tick, everybody's records. */
function isAdministrator(g: GrantToday): boolean {
  return g.role === "admin" || g.platformAdmin;
}

/** The powers held today: every one for an administrator, the rows otherwise, and HRMS's by-role two for a manager. */
export function powersToday(g: GrantToday): string[] {
  const table = POWER_TABLES[g.app];
  if (!table) return [];
  if (isAdministrator(g)) return [...table.all];
  const held = new Set(g.powers.filter((p) => table.all.includes(p)));
  /* An HRMS manager marks and checks out their own team by role (`lib/hrms/access.ts`). */
  if (g.app === "hrms" && g.role === "manager") ["markStaff", "checkoutStaff"].forEach((p) => held.add(p));
  return [...held];
}

/** The screens held today, in screen-model keys. */
export function screensToday(g: GrantToday): string[] {
  const all = moduleShape(g.app).flatMap((m) => m.screens);
  /* The handset is one module on the web; any grant of it is the whole handset. */
  if (g.app === "field" || g.modules === null || isAdministrator(g)) return all;
  const held = new Set(g.modules);
  return all.filter((s) => held.has(s) || ALWAYS_OPEN_MODULES.has(s));
}

function tick(screens: Map<string, ScreenTicks>, o: Owner): void {
  const cur = screens.get(o.screen) ?? { edit: false, delete: false, autoEdit: false };
  if (o.tick === "edit") screens.set(o.screen, { ...cur, edit: true, autoEdit: false });
  else if (o.tick === "delete") screens.set(o.screen, { edit: true, delete: true, autoEdit: cur.edit ? cur.autoEdit : true });
  else screens.set(o.screen, cur);
}

export function convertGrant(g: GrantToday): AppGrantDraft {
  const shape = moduleShape(g.app);

  if (isAdministrator(g)) {
    const screens = new Map<string, ScreenTicks>();
    for (const s of shape.flatMap((m) => m.screens)) screens.set(s, { edit: true, delete: true, autoEdit: false });
    return normaliseGrant({ position: "everyone", modules: new Set(shape.map((m) => m.module)), screens }, shape);
  }

  const held = screensToday(g);
  const base = draftFromLevel(g.app, g.role ?? "associate", held);
  const screens = new Map(base.screens);
  let position = base.position;

  /* A screen's old Write level is its Edit: WhatsApp's "reply and send". A whole grant held it. */
  const heldModules = g.modules === null ? null : new Set(g.modules);
  for (const [screen, write] of writeLevelsForApp(g.app)) {
    const t = screens.get(screen);
    if (t && (heldModules === null || heldModules.has(write))) screens.set(screen, { ...t, edit: true });
  }

  /* Each power held is its owning screen at its tick — added if the grant did not reach that screen. */
  const table = POWER_TABLES[g.app];
  if (table) {
    for (const p of powersToday(g)) {
      for (const o of table.owners[p] ?? []) {
        tick(screens, o);
        if (o.position && POSITION_RANK[o.position] > POSITION_RANK[position]) position = o.position;
      }
    }
  }

  const modules = new Set(shape.filter((m) => m.screens.some((s) => screens.has(s))).map((m) => m.module));
  return normaliseGrant({ position, modules, screens }, shape);
}

export type ConversionDifference = {
  /** Lost on a screen still held — the backfill refuses these. */
  lost: string[];
  /** Held today only through a screen the grant was narrowed away from. */
  lostWithScreen: string[];
  gained: string[];
  screensAdded: string[];
};

export function compareConversion(g: GrantToday, after: AppGrantDraft): ConversionDifference {
  const out: ConversionDifference = { lost: [], lostWithScreen: [], gained: [], screensAdded: [] };
  const role = g.role ?? "associate";
  const admin = isAdministrator(g);
  const heldBefore = new Set(screensToday(g));

  /* The platform administrator holds every capability everywhere through the
     Admin Console grant, before and after; there is nothing per app to compare. */
  const platform = g.platformAdmin || (g.app === "admin" && g.role === "admin");
  for (const c of platform ? [] : CAPABILITIES) {
    const before = can({ app: g.app, role }, c);
    const now = holdsWithScreens(g.app, after, c);
    if (before && !now) {
      /* Lost only because the person does not hold any screen that owns it. */
      const fullScreens = draftFromLevel(g.app, role);
      if (holdsWithScreens(g.app, { ...fullScreens, position: after.position }, c) && !admin) out.lostWithScreen.push(c);
      else out.lost.push(c);
    }
    if (now && !before) out.gained.push(c);
  }

  const table = POWER_TABLES[g.app];
  if (table) {
    const before = new Set(powersToday(g));
    for (const p of table.all) {
      const now = holdsAny(after, table.owners[p] ?? []);
      if (before.has(p) && !now) out.lost.push(`${g.app}:${p}`);
      if (now && !before.has(p)) out.gained.push(`${g.app}:${p}`);
    }
  }

  for (const s of after.screens.keys()) if (!heldBefore.has(s)) out.screensAdded.push(s);
  for (const s of heldBefore) if (!after.screens.has(s)) out.lost.push(`screen:${s}`);
  return out;
}
