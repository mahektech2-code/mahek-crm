import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { INDIA_STATES } from "@/lib/india-states";
import { db } from "@/db";
import { erpRefValues } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * The editable value lists (spec §3). Open lists live here so a manager can
 * reword or add a value without a deploy; fixed lists are constants below
 * because a rule depends on their exact spelling.
 * ------------------------------------------------------------------------- */

export const REF_LISTS: { key: string; label: string }[] = [
  { key: "materialType", label: "Material type" },
  { key: "testingList", label: "Testing list" },
  { key: "area", label: "Area" },
  { key: "state", label: "State" },
  { key: "transporter", label: "Transporter" },
  { key: "segment", label: "Segment" },
  { key: "counterType", label: "Counter type" },
  { key: "complaintType", label: "Complaint type" },
  { key: "expenseCategory", label: "Expense category" },
  { key: "expenseParticular", label: "Expense particular" },
  { key: "creditNote", label: "Credit note (fund reference)" },
  { key: "zone", label: "Zone" },
  { key: "godownCity", label: "Godown city" },
  { key: "videoTag", label: "Video search tag" },
  { key: "shortLabel", label: "Short label name (Item=Label)" },
  { key: "paymentTerms", label: "Payment terms (quotations and POs)" },
  { key: "scrapCategory", label: "Scrap category" },
  { key: "consignmentLabel", label: "Consignment number name (LR, GR, CN…)" },
];

export async function refValues(listKey: string): Promise<string[]> {
  const rows = await db
    .select({ value: erpRefValues.value })
    .from(erpRefValues)
    .where(and(eq(erpRefValues.listKey, listKey), eq(erpRefValues.active, true)))
    .orderBy(asc(erpRefValues.sortOrder), asc(erpRefValues.value));
  return rows.map((r) => r.value);
}

/* ------------------------------------------------------------ fixed lists */

export const RM_UNITS = ["Kg", "Litre", "Unit"];
export const BOX_TYPES = ["Empty Box 1 Liter", "Empty Box 5 Liter", "Empty Box 10 Liter", "Empty Box 20 Liter", "Empty Drum"];
export const PAYMENT_TYPES = ["Paid", "To Pay"];
export const DELIVERY_TYPES = ["Door Delivery", "Godown Delivery"];
export const WEIGHT_TYPES = ["No Weight", "With Weight"];
export const GRADES = ["A+", "A", "B+", "B", "C"];
export const REGIONS = ["West", "North", "South", "East", "Central"];

/* ------------------------------------------------- what a dropdown offers */

/**
 * WHERE A LIST'S VALUES ALREADY LIVE, for the lists a person fills in by hand.
 *
 * Segment, counter type, area, state and transporter were reference lists
 * nobody had filled, so the customer form offered "Nothing available" while
 * two thousand customers already carried a segment from the Sales Party
 * sheet. A list is the values somebody wrote on ERP → Settings PLUS the values
 * already in use, so a dropdown is never emptier than the data it describes.
 * Read only to OFFER choices: `refValues` stays the configured list wherever a
 * rule checks a value against it.
 */
const IN_USE: Record<string, ReturnType<typeof sql>> = {
  area: sql`select area as v from customers where deleted_at is null
            union select area from sheet_party_rows where status = 'present'`,
  state: sql`select state as v from erp_customer_profiles
             union select state from sheet_party_rows where status = 'present'
             union select state from erp_godowns`,
  transporter: sql`select name as v from erp_transporters where active
                   union select transporter from erp_customer_profiles
                   union select transport_detail from sheet_party_rows where status = 'present'`,
  segment: sql`select segment as v from erp_customer_profiles
               union select segment from sheet_party_rows where status = 'present'`,
  counterType: sql`select unnest(counter_types) as v from erp_customer_profiles
                   union select counter_type from sheet_party_rows where status = 'present'`,
  godownCity: sql`select city as v from erp_godowns`,
};

/** Lists whose every value is known without anybody typing it. */
const BASE: Record<string, readonly string[]> = { state: INDIA_STATES };

/** The configured list, then what is already in use, one spelling each. */
export async function refOptions(listKey: string): Promise<string[]> {
  const configured = await refValues(listKey);
  const out = [...configured];
  const seen = new Set(out.map((v) => v.trim().toLowerCase()));
  const add = (v: string | null | undefined) => {
    const t = v?.trim().replace(/\s+/g, " ");
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  const extra: string[] = [...(BASE[listKey] ?? [])];
  const q = IN_USE[listKey];
  if (q) {
    const rows = (await db.execute(sql`select distinct v from (${q}) s where v is not null`)) as unknown as { v: string }[];
    extra.push(...rows.map((r) => r.v));
  }
  extra.sort((a, b) => a.localeCompare(b)).forEach(add);
  return out;
}
