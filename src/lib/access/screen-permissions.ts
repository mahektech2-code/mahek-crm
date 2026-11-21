import type { AppId } from "../apps";
import { CAPABILITIES, can, type Capability } from "../capability-matrix";
import { moduleGroupsForApp, writeLevelsForApp } from "../modules";
import type { Role } from "../role-levels";
import { ACTION_OWNERS, EVERYONE, type Owner } from "./action-owners";
import type { AppGrantDraft, ModuleShape, Position, ScreenTicks } from "./permission-rules";

/* ---------------------------------------------------------------------------
 * READING A SCREEN GRANT AS CAPABILITIES, AND WRITING TODAY'S LEVELS AS ONE.
 *
 * `holdsWithScreens` is what `can()` becomes once the screen model is
 * switched on: a capability is held in an app when a screen that owns it is
 * held at the owning tick (and, for the few that are about whose records one
 * sees, at the Manager position).
 *
 * `draftFromLevel` is the migration's reading of a grant made under levels:
 * the screens somebody holds, each ticked as far as their level went. It
 * keeps everything — a screen gets Edit if the level held ANY action that
 * screen owns at Edit — so nobody loses on the day; what that widens is the
 * list `permissions.test.ts` prints for sign-off.
 * ------------------------------------------------------------------------- */

/** The app's sidebar as modules and screens — write levels are ticks, not screens. */
export function moduleShape(app: AppId): ModuleShape[] {
  const writes = new Set(writeLevelsForApp(app).values());
  return moduleGroupsForApp(app)
    .map((g) => ({ module: g.group, screens: g.modules.map((m) => m.key).filter((k) => !writes.has(k)) }))
    .filter((m) => m.screens.length > 0);
}

export function ownersIn(app: AppId, capability: Capability): readonly Owner[] {
  return ACTION_OWNERS[capability][app] ?? [];
}

function meets(t: ScreenTicks | undefined, o: Owner, position: Position): boolean {
  if (!t) return false;
  if (o.position === "manager" && position !== "manager") return false;
  if (o.tick === "access") return true;
  if (o.tick === "edit") return t.edit;
  return t.delete;
}

export function holdsWithScreens(app: AppId, grant: AppGrantDraft, capability: Capability): boolean {
  if (EVERYONE.has(capability)) return true;
  return ownersIn(app, capability).some((o) => meets(grant.screens.get(o.screen), o, grant.position));
}

/**
 * Today's grant — an app, a level, and the screens held (every screen when
 * the grant was never narrowed) — as the screen model will store it.
 */
export function draftFromLevel(app: AppId, role: Role, heldScreens?: readonly string[]): AppGrantDraft {
  const shape = moduleShape(app);
  const all = shape.flatMap((m) => m.screens);
  const held = new Set(heldScreens ?? all);
  const position: Position = role === "associate" ? "associate" : "manager";
  const screens = new Map<string, ScreenTicks>();
  for (const s of all) {
    if (!held.has(s)) continue;
    let edit = false;
    let del = false;
    for (const c of CAPABILITIES) {
      if (!can({ app, role }, c)) continue;
      for (const o of ownersIn(app, c)) {
        if (o.screen !== s) continue;
        if (o.tick === "edit") edit = true;
        if (o.tick === "delete") del = true;
      }
    }
    screens.set(s, { edit: edit || del, delete: del, autoEdit: del && !edit });
  }
  const modules = new Set(shape.filter((m) => m.screens.some((s) => screens.has(s))).map((m) => m.module));
  return { position, modules, screens };
}

export type LevelDifference = { app: AppId; role: Role; gained: Capability[]; lost: Capability[] };

/**
 * For a whole-app grant at a level: what the screen model gives that the
 * level did not, and what it takes away. The sign-off list.
 */
export function differenceForLevel(app: AppId, role: Role): LevelDifference {
  const draft = draftFromLevel(app, role);
  const gained: Capability[] = [];
  const lost: Capability[] = [];
  for (const c of CAPABILITIES) {
    const before = can({ app, role }, c);
    const after = holdsWithScreens(app, draft, c);
    if (after && !before) gained.push(c);
    if (before && !after) lost.push(c);
  }
  return { app, role, gained, lost };
}
