import type { FieldSpec } from "@/lib/erp/ui";

/* What every ERP form dialog checks in the browser before it asks the server,
   and a field's options for the values around it — one copy for the generic
   form and the goods receipt's own. The server checks again. */

export function checkField(f: FieldSpec, v: string): string {
  if (f.t === "derived" || f.t === "suggest") return "";
  if (f.req && (v == null || v === "")) return `${f.l} is required`;
  if (v !== "" && f.t === "num") {
    const n = Number(v);
    if (!Number.isFinite(n)) return "Enter a number.";
    if (n < 0 && (f.min == null || f.min >= 0)) return "This cannot be below 0.";
    if (f.min != null && n < f.min) return `This cannot be below ${f.min}.`;
    if (f.max != null && n > f.max) return `This cannot be above ${f.max}.`;
  }
  return "";
}

export function optsFor(f: FieldSpec, values: Record<string, string>): string[] | undefined {
  if (f.optsBy) {
    const by = Array.isArray(f.optsBy.by) ? f.optsBy.by : [f.optsBy.by];
    return f.optsBy.map[by.map((k) => values[k] ?? "").join("|")] ?? [];
  }
  return f.opts;
}
