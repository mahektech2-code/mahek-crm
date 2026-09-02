import { longDate, money, shortDate } from "./format";

/* ---------------------------------------------------------------------------
 * WhatsApp template merge. Fields are {{name}}-style so a manager can write
 * them without knowing anything about the codebase.
 *
 * This is the CLIENT half of the merge, and it is not a preview — the body it
 * renders is what gets copied to the clipboard and sent, unless the telecaller
 * edits it first. `lib/services/whatsapp-service.ts` is the server half, used
 * when the row is actually written and whenever nothing here was edited; the
 * two must produce the same fields or a template using one the client does
 * not know about would send a customer a message still carrying `{{that}}`.
 * ------------------------------------------------------------------------- */

export type MergeSource = {
  name: string;
  contactPerson: string | null;
  city: string;
  phone: string;
  outstanding: number;
  lastOrderDate: string | null;
  lastOrderValue: number;
  oldestBillNo?: string | null;
  oldestBillDue?: string | null;
  /** Every stated, unpaid bill, oldest first — what {{bills_list}} renders. */
  openBills?: Array<{ billDate: string; billNo: string; balance: number }>;
  /** Today, formatted. Passed in rather than read here — see AGENTS.md on
   * reading the clock during render. */
  asOf?: string;
  promisedAmount?: number | null;
  promisedDate?: string | null;
  ownerName?: string | null;
};

export const MERGE_FIELDS = [
  "customer",
  "contact",
  "city",
  "phone",
  "outstanding",
  "last_order_date",
  "last_order_value",
  "bill_no",
  "bill_due",
  "bills_list",
  "as_of",
  "promised_amount",
  "promised_date",
  "owner",
] as const;

export type MergeField = (typeof MERGE_FIELDS)[number];

export function mergeValues(source: MergeSource): Record<string, string> {
  return {
    customer: source.name,
    contact: source.contactPerson ?? "",
    city: source.city,
    phone: source.phone,
    outstanding: money(source.outstanding),
    last_order_date: source.lastOrderDate ? shortDate(source.lastOrderDate) : "",
    last_order_value: source.lastOrderValue ? money(source.lastOrderValue) : "",
    bill_no: source.oldestBillNo ?? "",
    bill_due: source.oldestBillDue ? longDate(source.oldestBillDue) : "",
    bills_list: (source.openBills ?? [])
      .map((b) => `${longDate(b.billDate)} - ${b.billNo} - ${money(b.balance)}`)
      .join("\n"),
    as_of: source.asOf ?? "",
    promised_amount: source.promisedAmount ? money(source.promisedAmount) : "",
    promised_date: source.promisedDate ? longDate(source.promisedDate) : "",
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
