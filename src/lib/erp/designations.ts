import { ERP_ALWAYS_OPEN } from "./registry";
import { ERP_POWERS, type ErpPower } from "./powers";

/* ---------------------------------------------------------------------------
 * ERP DESIGNATIONS — the arithmetic, PURE and client-safe.
 *
 * A designation is a level, a set of screens and a set of powers with a name
 * on it. The Access dialog, the Designations page and the action that applies
 * an edit all ask the same two questions of it — does this person still hold
 * exactly what their designation says, and if not, what differs — so the
 * answer lives once, here, where the browser and the server both read it.
 *
 * What is compared is EFFECTIVE access, not stored rows: no module rows means
 * the whole app, the always-open screens are held whatever is ticked, and an
 * administrator holds every power without a row. Comparing rows would call two
 * people who can open exactly the same screens "different" because one of
 * them was saved before a screen existed.
 * ------------------------------------------------------------------------- */

export type ErpLevel = "associate" | "manager" | "admin";

export type ErpDesignationDef = {
  id: string;
  name: string;
  description: string | null;
  level: ErpLevel;
  /** Every screen, including ones built later. `modules` is then ignored. */
  allScreens: boolean;
  /** `erp.<key>` module keys, always-open screens excluded. */
  modules: string[];
  powers: ErpPower[];
};

/** What one person holds in the ERP, as stored. */
export type ErpHeld = {
  level: ErpLevel;
  /** Their module rows for `erp`; empty means the whole app. */
  moduleRows: string[];
  powers: string[];
};

export type ErpAccessShape = {
  level: ErpLevel;
  /** Screens, always-open excluded; `null` means every screen. */
  screens: ReadonlySet<string> | null;
  /** Powers; `null` means every power (an administrator). */
  powers: ReadonlySet<string> | null;
};

const ALWAYS = new Set([...ERP_ALWAYS_OPEN].map((k) => `erp.${k}`));

/** Drop the always-open screens, which are nobody's to grant or withhold. */
export function grantableModules(keys: Iterable<string>): string[] {
  return [...new Set(keys)].filter((k) => k.startsWith("erp.") && !ALWAYS.has(k)).sort();
}

/**
 * Normalise a set of screens against everything grantable: holding all of them
 * IS holding the whole app, however it was stored.
 */
function covering(keys: string[], allModules: readonly string[]): ReadonlySet<string> | null {
  const grantable = grantableModules(allModules);
  const held = new Set(grantableModules(keys).filter((k) => grantable.includes(k)));
  return grantable.every((k) => held.has(k)) ? null : held;
}

export function heldShape(held: ErpHeld, allModules: readonly string[]): ErpAccessShape {
  return {
    level: held.level,
    /* No rows is the whole app — the rule `writeModules` stores it by. */
    screens: held.moduleRows.length ? covering(held.moduleRows, allModules) : null,
    powers: held.level === "admin" ? null : new Set(held.powers.filter((p) => (ERP_POWERS as readonly string[]).includes(p))),
  };
}

export function designationShape(d: Pick<ErpDesignationDef, "level" | "allScreens" | "modules" | "powers">, allModules: readonly string[]): ErpAccessShape {
  return {
    level: d.level,
    screens: d.allScreens ? null : covering(d.modules, allModules),
    powers: d.level === "admin" ? null : new Set(d.powers),
  };
}

export type DesignationDiff = {
  /** The level differs: `[held, designation]`. */
  level: [ErpLevel, ErpLevel] | null;
  /** Screens they hold that the designation does not give. */
  extraScreens: string[];
  /** Screens the designation gives that they do not hold. */
  missingScreens: string[];
  extraPowers: string[];
  missingPowers: string[];
};

function setDiff(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null, universe: readonly string[]): [string[], string[]] {
  const A = a ?? new Set(universe);
  const B = b ?? new Set(universe);
  return [[...A].filter((x) => !B.has(x)).sort(), [...B].filter((x) => !A.has(x)).sort()];
}

/** What separates somebody's access from their designation's. Empty everywhere means they match it. */
export function diffFromDesignation(held: ErpAccessShape, d: ErpAccessShape, allModules: readonly string[]): DesignationDiff {
  const [extraScreens, missingScreens] = setDiff(held.screens, d.screens, grantableModules(allModules));
  const [extraPowers, missingPowers] = setDiff(held.powers, d.powers, ERP_POWERS);
  return {
    level: held.level === d.level ? null : [held.level, d.level],
    extraScreens,
    missingScreens,
    extraPowers,
    missingPowers,
  };
}

export function isEmptyDiff(d: DesignationDiff): boolean {
  return !d.level && !d.extraScreens.length && !d.missingScreens.length && !d.extraPowers.length && !d.missingPowers.length;
}

export function matchesDesignation(held: ErpAccessShape, d: ErpAccessShape, allModules: readonly string[]): boolean {
  return isEmptyDiff(diffFromDesignation(held, d, allModules));
}

/**
 * What the Access dialog writes when a designation is picked: the level, the
 * screens (with the always-open ones, which every draft carries) and the
 * powers. An all-screens designation is every module of the app — the save
 * then stores no rows, which is the whole app.
 */
export function draftFor(
  d: Pick<ErpDesignationDef, "level" | "allScreens" | "modules" | "powers">,
  allModules: readonly string[],
): { level: ErpLevel; modules: string[]; powers: string[] } {
  const modules = d.allScreens ? [...allModules] : [...new Set([...ALWAYS, ...grantableModules(d.modules)])].filter((k) => allModules.includes(k));
  return { level: d.level, modules, powers: d.level === "admin" ? [] : [...d.powers] };
}

/** The diff, in words, for a line under a person's name. */
export function describeDiff(diff: DesignationDiff, label: (key: string) => string, powerLabel: (p: string) => string): string[] {
  const out: string[] = [];
  if (diff.level) out.push(`${diff.level[0]} rather than ${diff.level[1]}`);
  if (diff.extraScreens.length) out.push(`also ${diff.extraScreens.map(label).join(", ")}`);
  if (diff.missingScreens.length) out.push(`without ${diff.missingScreens.map(label).join(", ")}`);
  if (diff.extraPowers.length) out.push(`also may ${diff.extraPowers.map(powerLabel).join(", ").toLowerCase()}`);
  if (diff.missingPowers.length) out.push(`may not ${diff.missingPowers.map(powerLabel).join(", ").toLowerCase()}`);
  return out;
}
