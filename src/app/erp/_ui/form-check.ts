import type { FieldSpec } from "@/lib/erp/ui";

/* What every ERP form drawer checks in the browser before it asks the server,
   and a field's options for the values around it — one copy for the generic
   drawer and the goods receipt's own. The server checks again. */

export function checkField(f: FieldSpec, v: string): string {
  if (f.t === "derived" || f.t === "suggest") return "";
  if (f.req && (v == null || v === "")) return `${f.l} is required`;
  if (v !== "" && f.t === "num") {
    const n = Number(v);
    if (!Number.isFinite(n)) return "INVALID";
    if (n < 0 && (f.min == null || f.min >= 0)) return "Minus Quantity Not Allowed";
    if (f.min != null && n < f.min) return "INVALID";
    if (f.max != null && n > f.max) return "INVALID";
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
