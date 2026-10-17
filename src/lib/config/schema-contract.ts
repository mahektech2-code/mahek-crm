/* ---------------------------------------------------------------------------
 * Every settings page's published schema.
 *
 * This is the contract the Admin Console renders — one schema per settings
 * page, the pages listed in `settings-pages.ts` and each setting placed on one
 * by `settings-placement.ts`. It is derived from the
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
  type Control,
} from "./presentation";
import { PAGE_TABS, placeSetting } from "./settings-placement";

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

/** HRMS publishes its own schema below, so no other page carries its keys. */
const isHrmsKey = (key: string) => key.startsWith("hrms.");

/** One setting, in the shape the console renders. */
function fieldOf(raw: SettingDefinition): SchemaField {
  const p = PRESENTATION[raw.key];
  const control = p?.control ?? fallbackControl(raw);
  return {
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
}

/**
 * One settings page's schema: every setting `placeSetting` puts on it, in its
 * tabs and groups, plus — on the CRM's page — the collections it lists.
 */
export function pageSchema(page: string): AppSchema {
  if (page === "hrms") return hrmsSchema();
  const declared = PAGE_TABS[page] ?? [];
  const byTab = new Map<string, Map<string, { rank: number; note?: string; fields: SchemaField[] }>>();
  const groupOf = (tab: string, label: string, rank: number, note?: string) => {
    if (!byTab.has(tab)) byTab.set(tab, new Map());
    const groups = byTab.get(tab)!;
    const g = groups.get(label) ?? { rank, note, fields: [] };
    g.rank = Math.min(g.rank, rank);
    g.note ??= note;
    groups.set(label, g);
    return g;
  };

  for (const raw of SETTINGS as readonly SettingDefinition[]) {
    if (isHrmsKey(raw.key)) continue;
    const at = placeSetting(raw.key);
    if (!at || at.page !== page) continue;
    const presented = PRESENTATION[raw.key]?.tab;
    groupOf(at.tab, at.group, at.rank, presented ? GROUP_NOTES[`${presented} · ${at.group}`] : undefined).fields.push(
      fieldOf(raw),
    );
  }

  // Entity collections sit in the same tabs and groups as the settings, because
  // to an admin "the products" and "how products are offered" are one screen.
  if (page === "crm") {
    for (const c of ENTITY_COLLECTIONS) {
      const slug = TABS.find((t) => t.label === c.tab)?.slug ?? slugify(c.tab);
      const rank = (GROUP_ORDER[c.tab] ?? []).indexOf(c.group);
      groupOf(slug, c.group, rank >= 0 ? rank : 999, GROUP_NOTES[`${c.tab} · ${c.group}`]).fields.unshift({
        key: c.key,
        label: c.label,
        control: "entity",
        help: c.help,
        def: null,
        entity: { noun: c.noun, cta: c.cta, built: c.built, editable: c.editable, href: c.href },
      });
    }
  }

  const tabs: SchemaTab[] = declared
    .filter((t) => byTab.has(t.slug))
    .map((t) => ({
      key: t.slug,
      label: t.label,
      groups: [...byTab.get(t.slug)!.entries()]
        .sort((a, b) => a[1].rank - b[1].rank)
        .map(([label, g]) => ({ label, note: g.note, fields: g.fields })),
    }));
  return { tabs };
}

/** The Telecaller CRM's own settings. */
export function crmSchema(): AppSchema {
  return pageSchema("crm");
}

/* ---------------------------------------------------------------------------
 * HRMS's schema. Its settings are placed by the second segment of the key —
 * `hrms.payroll.pfRatePercent` sits under Payroll — so a setting added to the
 * registry appears in the right tab with no presentation entry to remember.
 * ------------------------------------------------------------------------- */

const HRMS_TABS: Array<{ slug: string; label: string; groups: Record<string, string> }> = [
  {
    slug: "attendance",
    label: "Attendance",
    groups: { attendance: "Check-in and the working day", office: "Offices", ot: "Overtime", reports: "Monthly reports", holidays: "Holidays" },
  },
  { slug: "payroll", label: "Payroll", groups: { payroll: "Salary, PF, ESIC and PT" } },
  {
    slug: "performance",
    label: "Performance & sales",
    groups: { performance: "Performance points", sales: "Sales activity", calling: "Calling", tasks: "Tasks" },
  },
];

export function hrmsSchema(): AppSchema {
  const tabs: SchemaTab[] = HRMS_TABS.map((t) => ({ key: t.slug, label: t.label, groups: [] }));
  for (const raw of SETTINGS as readonly SettingDefinition[]) {
    if (!isHrmsKey(raw.key)) continue;
    const seg = raw.key.split(".")[1] ?? "";
    const ti = Math.max(0, HRMS_TABS.findIndex((t) => seg in t.groups));
    const label = HRMS_TABS[ti].groups[seg] ?? "Other";
    const p = PRESENTATION[raw.key];
    const control = p?.control ?? fallbackControl(raw);
    let group = tabs[ti].groups.find((g) => g.label === label);
    if (!group) tabs[ti].groups.push((group = { label, fields: [] }));
    group.fields.push({
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
      def: toConsole(raw.default, control, p?.parts),
    });
  }
  for (const t of tabs) {
    const seq = Object.values(HRMS_TABS.find((x) => x.slug === t.key)!.groups);
    t.groups.sort((a, b) => seq.indexOf(a.label) - seq.indexOf(b.label));
  }
  return { tabs: tabs.filter((t) => t.groups.length) };
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
