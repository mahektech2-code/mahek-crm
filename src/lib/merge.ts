import { money, shortDate } from "./format";

/* ---------------------------------------------------------------------------
 * WhatsApp template merge. Fields are {{name}}-style so a manager can write
 * them without knowing anything about the codebase.
 * ------------------------------------------------------------------------- */

export type MergeSource = {
  name: string;
  contactPerson: string;
  city: string;
  phone: string;
  outstanding: number;
  lastOrderDate: string | null;
  lastOrderValue: number;
  oldestBillNo?: string | null;
  oldestBillDue?: string | null;
  ownerName?: string | null;
};

export const MERGE_FIELDS = [
  "customer",
  "contact",
  "city",
  "outstanding",
  "last_order_date",
  "last_order_value",
  "bill_no",
  "bill_due",
  "owner",
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number];

export function mergeValues(source: MergeSource): Record<string, string> {
  return {
    customer: source.name,
    contact: source.contactPerson,
    city: source.city,
    outstanding: money(source.outstanding),
    last_order_date: source.lastOrderDate ? shortDate(source.lastOrderDate) : "",
    last_order_value: source.lastOrderValue ? money(source.lastOrderValue) : "",
    bill_no: source.oldestBillNo ?? "",
    bill_due: source.oldestBillDue ? shortDate(source.oldestBillDue) : "",
    owner: source.ownerName ?? "",
  };
}

/** Fields the template asks for that this customer cannot fill. */
export function missingFields(body: string, values: Record<string, string>) {
  return usedFields(body).filter((f) => !values[f]);
}

export function usedFields(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}

export function applyMerge(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) =>
    values[key] !== undefined && values[key] !== "" ? values[key] : `{{${key}}}`,
  );
}

export function fieldLabel(field: string): string {
  return field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
