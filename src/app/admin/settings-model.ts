/* ---------------------------------------------------------------------------
 * The value plumbing behind a rendered schema.
 *
 * A field has a declared default, a saved value from the database, and — until
 * Save — a draft. Nothing is written until the whole section is saved, because
 * half the relationships only hold across several fields at once.
 *
 * The rules themselves are NOT reimplemented here. `checkConsistency` in the
 * CRM's own registry is the one implementation, and the server runs the same
 * function on the same values before it commits.
 * ------------------------------------------------------------------------- */

import {
  checkConsistency,
  type Config,
} from "@/lib/config/registry";
import {
  toStored,
  type SchemaField,
  type SchemaTab,
} from "@/lib/config/schema-contract";

export type Values = Record<string, unknown>;

export function savedValue(values: Values, f: SchemaField): unknown {
  const v = values[f.key];
  return v === undefined ? f.def : v;
}

export function currentValue(values: Values, drafts: Values, f: SchemaField): unknown {
  const d = drafts[f.key];
  return d === undefined ? savedValue(values, f) : d;
}

export function isDirty(values: Values, drafts: Values, f: SchemaField): boolean {
  return drafts[f.key] !== undefined && !same(drafts[f.key], savedValue(values, f));
}

export function isAtDefault(values: Values, drafts: Values, f: SchemaField): boolean {
  return !isDirty(values, drafts, f) && same(savedValue(values, f), f.def);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function tabFields(tab: SchemaTab | null): SchemaField[] {
  if (!tab) return [];
  return tab.groups.flatMap((g) => g.fields);
}

export function dirtyFields(tab: SchemaTab | null, values: Values, drafts: Values): SchemaField[] {
  return tabFields(tab).filter((f) => isDirty(values, drafts, f));
}

/** Rendered flat, the way an audit line reads it. */
export function readable(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).join(" / ");
  return String(v);
}

/** The change set, in the shape the write action accepts. */
export function changeSet(
  tab: SchemaTab | null,
  values: Values,
  drafts: Values,
): Array<{ key: string; value: unknown }> {
  return dirtyFields(tab, values, drafts).map((f) => ({
    key: f.key,
    value: toStored(drafts[f.key], f.control, f.def),
  }));
}

/* ------------------------------------------------- cross-setting validation */

export type CrossError = { key: string; text: string };

/**
 * What this change set would break.
 *
 * A problem already present in the stored configuration is NOT counted: the
 * database may be inconsistent today, and refusing to save would trap whoever
 * is fixing one half of it. The server applies exactly this rule before it
 * commits, so the screen and the write path cannot disagree.
 */
export function introducedProblems(
  tab: SchemaTab | null,
  values: Values,
  drafts: Values,
  stored: Config | null,
): CrossError[] {
  if (!stored) return [];
  const dirty = dirtyFields(tab, values, drafts);
  if (!dirty.length) return [];

  const before = new Set(checkConsistency(stored));
  const after = { ...stored } as Record<string, unknown>;
  for (const f of dirty) {
    after[f.key] = toStored(drafts[f.key], f.control, f.def);
  }

  const fields = tabFields(tab);
  return checkConsistency(after as Config)
    .filter((text) => !before.has(text))
    .map((text) => ({
      // Attach the message to a field when it names one, so the row is flagged
      // as well as the section.
      key: fields.find((f) => text.toLowerCase().includes(f.label.toLowerCase()))?.key ?? "",
      text,
    }));
}

/* ----------------------------------------------------------- impact preview */

export type ImpactRow = {
  setting: string;
  change: string;
  effect: string;
  tone: "warn" | "ok" | "neutral";
};

/**
 * What tomorrow looks like, for settings the app marks as worklist-affecting.
 *
 * These say what moves, not how many — the console cannot count customers, and
 * a fabricated figure is worse than none. A real count belongs behind the
 * app's own summary endpoint.
 */
export function impactRows(tab: SchemaTab | null, values: Values, drafts: Values): ImpactRow[] {
  return dirtyFields(tab, values, drafts)
    .filter((f) => f.impact)
    .map((f) => {
      const from = savedValue(values, f);
      const to = currentValue(values, drafts, f);
      const looser = Number(to) < Number(from);

      const effect =
        f.impact === "queue"
          ? looser
            ? "More customers become due, so call queues grow tomorrow morning."
            : "Fewer customers become due, so call queues shrink tomorrow morning."
          : f.impact === "collections"
            ? "Accounts move between stages, changing which prescribed action each one shows."
            : looser
              ? "More customers cross the inactivity line and appear on the watch."
              : "Fewer customers cross the inactivity line.";

      return {
        setting: f.label,
        change: `${readable(from)} → ${readable(to)}`,
        effect,
        tone: looser ? "warn" : "ok",
      };
    });
}
