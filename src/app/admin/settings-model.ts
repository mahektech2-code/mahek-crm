/* ---------------------------------------------------------------------------
 * The value plumbing behind a rendered schema — pure, so the rules can be read
 * without a screen in front of you.
 *
 * A field has a declared default, a saved value and, until Save is pressed, a
 * draft. Nothing is written until the whole section is saved, because half the
 * relationships below only hold across several fields at once.
 * ------------------------------------------------------------------------- */

import { T, type SchemaField, type SchemaTab } from "./data";

export type Values = Record<string, unknown>;

export function declaredDefault(f: SchemaField): unknown {
  if (f.type === T.threshold && f.parts) {
    return Object.fromEntries(f.parts.map((p) => [p.k, p.v]));
  }
  if (f.type === T.keyvalue && f.pairs) {
    return Object.fromEntries(f.pairs.map((p) => [p.k, p.v]));
  }
  return f.def;
}

export function savedValue(values: Values, f: SchemaField): unknown {
  const v = values[f.key];
  return v === undefined ? declaredDefault(f) : v;
}

export function currentValue(values: Values, drafts: Values, f: SchemaField): unknown {
  const d = drafts[f.key];
  return d === undefined ? savedValue(values, f) : d;
}

export function isDirty(values: Values, drafts: Values, f: SchemaField): boolean {
  return drafts[f.key] !== undefined && !same(drafts[f.key], savedValue(values, f));
}

export function isAtDefault(values: Values, drafts: Values, f: SchemaField): boolean {
  return !isDirty(values, drafts, f) && same(savedValue(values, f), declaredDefault(f));
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
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).join(" / ");
  return String(v);
}

/* ------------------------------------------------- cross-setting validation */

export type CrossError = { key: string; text: string };

/**
 * Relationships the schema declares, checked across the whole section. Two
 * statements of the same fact are not allowed to drift: aging buckets and stage
 * thresholds describe how overdue an account is, and the Sales Bill Report and
 * Payment Follow-up must not disagree about it.
 */
export function crossCheck(tab: SchemaTab | null, values: Values, drafts: Values): CrossError[] {
  const errs: CrossError[] = [];
  const fields = tabFields(tab);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const cur = (k: string) => (byKey[k] ? currentValue(values, drafts, byKey[k]) : null);

  for (const f of fields) {
    if (f.type !== T.threshold || !f.ascending || !f.parts) continue;
    const v = currentValue(values, drafts, f) as Record<string, string | number>;
    const seq = f.parts.map((p) => parseFloat(String(v[p.k])));
    for (let i = 1; i < seq.length; i++) {
      if (!(seq[i] > seq[i - 1])) {
        errs.push({
          key: f.key,
          text: `${f.label}: ${f.parts[i].l} (${seq[i]}) must be greater than ${f.parts[i - 1].l} (${seq[i - 1]}).`,
        });
        break;
      }
    }
  }

  if (byKey.stageThresholds && byKey.agingBuckets) {
    const st = cur("stageThresholds") as Record<string, number>;
    const ab = cur("agingBuckets") as Record<string, number>;
    const stages = [st.s1, st.s2, st.s3].map(Number);
    const buckets = [ab.b2, ab.b3, ab.b4].map(Number);
    const aligned = stages.every((s) => buckets.includes(s));
    if (!aligned) {
      errs.push({
        key: "agingBuckets",
        text:
          `Aging buckets (${[ab.b1, ab.b2, ab.b3, ab.b4].join(" / ")}) do not align with the stage thresholds ` +
          `(${stages.join(" / ")}). The Sales Bill Report and Payment Follow-up would disagree about how overdue an account is.`,
      });
    }
  }

  if (byKey.shiftStart && byKey.shiftEnd) {
    const a = cur("shiftStart") as string;
    const b = cur("shiftEnd") as string;
    if (a && b && a >= b) {
      errs.push({ key: "shiftEnd", text: `Shift start (${a}) must be before shift end (${b}).` });
    }
    const boundary = cur("dayBoundary") as string;
    if (boundary && a && b && boundary > a && boundary < b) {
      errs.push({
        key: "dayBoundary",
        text: `Day boundary (${boundary}) falls inside the shift. It must sit outside ${a}–${b}, or a call logged mid-shift lands on the wrong day.`,
      });
    }
  }

  return errs;
}

/* ----------------------------------------------------------- impact preview */

export type ImpactRow = {
  setting: string;
  change: string;
  effect: string;
  tone: "warn" | "ok" | "neutral";
};

/**
 * Settings the schema marks as worklist-affecting get a plain sentence about
 * what tomorrow looks like. A threshold changed without that sentence is a
 * telecaller finding forty extra customers in their list and nobody knowing why.
 */
export function impactRows(tab: SchemaTab | null, values: Values, drafts: Values): ImpactRow[] {
  return dirtyFields(tab, values, drafts)
    .filter((f) => f.impact)
    .map((f) => {
      const from = savedValue(values, f);
      const to = currentValue(values, drafts, f);
      let effect = "";
      let tone: ImpactRow["tone"] = "neutral";

      if (f.impact === "queue" && f.key === "checkinInterval") {
        const delta = Math.round((Number(from) - Number(to)) * 2.4);
        effect =
          delta > 0
            ? `Roughly ${delta} more customers enter call queues tomorrow.`
            : delta < 0
              ? `Roughly ${Math.abs(delta)} fewer customers enter call queues tomorrow.`
              : "No change to queue size.";
        tone = delta > 0 ? "warn" : "ok";
      } else if (f.impact === "inactive") {
        const delta = Math.round((Number(from) - Number(to)) * 11);
        effect =
          delta > 0
            ? `Roughly ${delta} more customers would newly flag as inactive.`
            : delta < 0
              ? `Roughly ${Math.abs(delta)} fewer customers would flag as inactive.`
              : "No change to the inactive watch.";
        tone = delta > 0 ? "warn" : "ok";
      } else if (f.impact === "collections") {
        effect = "Accounts move between stages, changing which prescribed action each one shows.";
        tone = "warn";
      } else if (f.key === "maxQueue") {
        effect = "Caps each telecaller's daily list. Anything beyond the cap rolls to the next day.";
        tone = "warn";
      }

      return { setting: f.label, change: `${readable(from)} → ${readable(to)}`, effect, tone };
    });
}
