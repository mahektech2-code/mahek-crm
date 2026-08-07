/* ---------------------------------------------------------------------------
 * The CRM's published configuration schema.
 *
 * This is the contract the Admin Console renders. It is derived from the
 * registry and the presentation declaration — never hand-maintained — so a
 * setting added to the registry appears in the console with no console change,
 * and a setting the console shows is always one the CRM actually reads.
 *
 * When the CRM becomes its own deployment, `GET /api/crm/config/schema` is a
 * five-line wrapper around `crmSchema()`. Nothing else moves.
 *
 * Pure. The only reason it is not in the console is that the console must not
 * own it.
 * ------------------------------------------------------------------------- */

import { SETTINGS, type SettingDefinition } from "./registry";
import { slugify } from "../slug";
import {
  ENTITY_COLLECTIONS,
  GROUP_NOTES,
  GROUP_ORDER,
  ISO_DAYS,
  PRESENTATION,
  TABS,
  TAB_ORDER,
  type Control,
} from "./presentation";

export type SchemaField = {
  key: string;
  label: string;
  /** Set on an entity collection: the plural noun, the CTA, and whether it exists. */
  entity?: { noun: string; cta: string; built: boolean; editable: boolean; href?: string };
  /** The console's control name. */
  control: Control;
  help: string;
  unit?: string;
  min?: number;
  max?: number;
  options?: string[];
  parts?: Array<{ k: string; l: string }>;
  adminOnly?: boolean;
  impact?: "queue" | "collections" | "inactive";
  /** The declared default, already in console shape. */
  def: unknown;
};

export type SchemaGroup = { label: string; note?: string; fields: SchemaField[] };
export type SchemaTab = { key: string; label: string; groups: SchemaGroup[] };
export type AppSchema = { tabs: SchemaTab[] };

/** Storage type → control, when the app declares no preference. */
function fallbackControl(def: SettingDefinition): Control {
  switch (def.type) {
    case "integer":
      return "int";
    case "decimal":
      return "decimal";
    case "boolean":
      return "bool";
    case "text":
      return def.options ? "choice" : "text";
    case "structured":
      // Without a declared control the console cannot know which of four
      // shapes this is, so it gets the one that can render any of them.
      return "longtext";
  }
}

export function crmSchema(): AppSchema {
  const byTab = new Map<string, Map<string, SchemaField[]>>();

  for (const raw of SETTINGS as readonly SettingDefinition[]) {
    const p = PRESENTATION[raw.key];
    const tab = p?.tab ?? "Other";
    const group = p?.group ?? "Not yet placed";
    const control = p?.control ?? fallbackControl(raw);

    const field: SchemaField = {
      key: raw.key,
      label: raw.label,
      control,
      help: raw.description,
      unit: p?.unit,
      min: raw.min,
      max: raw.max,
      options: p?.options ? [...p.options] : raw.options ? [...raw.options] : undefined,
      parts: p?.parts,
      adminOnly: p?.adminOnly,
      impact: p?.impact,
      def: toConsole(raw.default, control, p?.parts),
    };

    if (!byTab.has(tab)) byTab.set(tab, new Map());
    const groups = byTab.get(tab)!;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(field);
  }

  // Entity collections sit in the same tabs and groups as the settings, because
  // to an admin "the products" and "how products are offered" are one screen.
  for (const c of ENTITY_COLLECTIONS) {
    const field: SchemaField = {
      key: c.key,
      label: c.label,
      control: "entity",
      help: c.help,
      def: null,
      entity: { noun: c.noun, cta: c.cta, built: c.built, editable: c.editable, href: c.href },
    };
    if (!byTab.has(c.tab)) byTab.set(c.tab, new Map());
    const groups = byTab.get(c.tab)!;
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.unshift(field);
  }

  const tabs: SchemaTab[] = [...byTab.entries()]
    .sort((a, b) => order(TAB_ORDER as readonly string[], a[0]) - order(TAB_ORDER as readonly string[], b[0]))
    .map(([label, groups]) => ({
      // Declared where one exists, generated only for a tab nobody has placed
      // yet — so an unplaced tab is still addressable rather than unreachable.
      key: TABS.find((t) => t.label === label)?.slug ?? slugify(label),
      label,
      groups: [...groups.entries()]
        .sort((a, b) => order(GROUP_ORDER[label] ?? [], a[0]) - order(GROUP_ORDER[label] ?? [], b[0]))
        .map(([groupLabel, fields]) => ({
          label: groupLabel,
          note: GROUP_NOTES[`${label} · ${groupLabel}`],
          fields,
        })),
    }));

  return { tabs };
}

function order(list: readonly string[], value: string): number {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
}

/* ------------------------------------------------- value shape conversion */

/**
 * Stored shape → console shape.
 *
 * Four settings are stored as `structured` and each wants a different control,
 * so this is where an array of ascending boundaries becomes the object a
 * threshold control edits, and ISO weekday numbers become weekday names.
 */
export function toConsole(
  stored: unknown,
  control: Control,
  parts?: Array<{ k: string; l: string }>,
): unknown {
  switch (control) {
    case "threshold":
    case "keyvalue": {
      if (Array.isArray(stored)) {
        // Positional: the part key is the index.
        return Object.fromEntries(stored.map((v, i) => [String(i), v]));
      }
      if (stored && typeof stored === "object") return { ...(stored as object) };
      return Object.fromEntries((parts ?? []).map((p) => [p.k, 0]));
    }
    case "dayset":
      return Array.isArray(stored)
        ? stored.map((n) => ISO_DAYS[Number(n) - 1]).filter(Boolean)
        : [];
    case "ordered":
    case "multi":
      return Array.isArray(stored) ? stored.map(String) : [];
    case "time":
      return String(stored ?? "");
    default:
      return stored;
  }
}

/** Console shape → stored shape, ready for `validateSetting`. */
export function toStored(
  value: unknown,
  control: Control,
  original: unknown,
): unknown {
  switch (control) {
    case "threshold": {
      // Back to an array, in part order, numbers not strings.
      const obj = (value ?? {}) as Record<string, unknown>;
      if (Array.isArray(original)) {
        return Object.keys(obj)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => Number(obj[k]));
      }
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(v)]));
    }
    case "keyvalue": {
      const obj = (value ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(v)]));
    }
    case "dayset": {
      const names = Array.isArray(value) ? (value as string[]) : [];
      return names
        .map((d) => ISO_DAYS.indexOf(d as (typeof ISO_DAYS)[number]) + 1)
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
    }
    case "ordered": {
      const list = Array.isArray(value) ? (value as unknown[]) : [];
      // A list of numbers stays a list of numbers — payment terms are days.
      const wasNumeric = Array.isArray(original) && original.every((v) => typeof v === "number");
      return wasNumeric ? list.map(Number).filter((n) => Number.isFinite(n)) : list.map(String);
    }
    case "multi":
      return Array.isArray(value) ? [...value] : [];
    case "int":
    case "decimal":
      return value === "" || value === null || value === undefined ? value : Number(value);
    default:
      return value;
  }
}

/** Every field in the schema, flat — for lookups by key. */
export function schemaFields(schema: AppSchema): SchemaField[] {
  return schema.tabs.flatMap((t) => t.groups.flatMap((g) => g.fields));
}
