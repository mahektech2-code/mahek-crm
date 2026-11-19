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
 * Segment, counter type, area and state were reference lists
 * nobody had filled, so the customer form offered "Nothing available" while
 * two thousand customers already carried a segment from the Sales Party
 * sheet. A list is the values somebody wrote on ERP → Settings PLUS the values
 * already in use, so a dropdown is never emptier than the data it describes.
 * Read only to OFFER choices: `refValues` stays the configured list wherever a
 * rule checks a value against it.
 * (`union all`, not `union`: the retire modal counts the records that carry a
 * value through these same queries, and the offer reads them `distinct`.)
 */
const IN_USE: Record<string, ReturnType<typeof sql>> = {
  area: sql`select area as v from customers where deleted_at is null
            union all select area from sheet_party_rows where status = 'present'`,
  state: sql`select state as v from erp_customer_profiles
             union all select state from sheet_party_rows where status = 'present'
             union all select state from erp_godowns`,
  segment: sql`select segment as v from erp_customer_profiles
               union all select segment from sheet_party_rows where status = 'present'`,
  counterType: sql`select unnest(counter_types) as v from erp_customer_profiles
                   union all select counter_type from sheet_party_rows where status = 'present'`,
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

/* ------------------------------------------------- renaming a list value */

/**
 * Values a RULE reads by their exact spelling: renaming one would leave the
 * code comparing against a word no record carries any more ("Chemical" is
 * what gives a material its density and tests; "Chemical Scrap" is where QC
 * posts a customer return's scrap).
 */
export const REF_RULE_SPELLINGS: Record<string, readonly string[]> = {
  materialType: ["Chemical", "Can", "Box", "Drum"],
  scrapCategory: ["Chemical Scrap", "Empty Metal Drum"],
  expenseCategory: ["Bank charges"],
};

/**
 * WHERE A LIST'S VALUE IS COPIED ONTO RECORDS — every column that stores it as
 * text, as `v` (a scalar) or `arr` (a text[] column) or `key` (a jsonb
 * object's keys). A list with an empty entry is read live and copied nowhere
 * (`shortLabel` pairs are the mapping itself). A list missing from here is
 * one nobody has mapped, so renaming in it is refused rather than guessed.
 */
const STORED_IN: Record<string, ReturnType<typeof sql>[]> = {
  materialType: [
    sql`select material_type as v from erp_material_groups`,
    sql`select material_type from erp_raw_materials`,
    sql`select material_type from erp_requisitions`,
    sql`select material_type from erp_inward`,
    sql`select material_type from erp_rm_levels`,
  ],
  testingList: [
    sql`select unnest(testing_list) as v from erp_raw_materials`,
    sql`select unnest(tests) from erp_tests`,
    sql`select jsonb_object_keys(tests) from erp_sfg_qc`,
  ],
  area: [IN_USE.area, sql`select area from erp_suppliers`],
  state: [IN_USE.state, sql`select state from erp_suppliers`],
  segment: [IN_USE.segment],
  counterType: [IN_USE.counterType],
  godownCity: [IN_USE.godownCity],
  complaintType: [sql`select complaint_type as v from erp_requests`],
  expenseCategory: [sql`select category as v from erp_expenses`, sql`select category from erp_money_txns`],
  expenseParticular: [sql`select particular as v from erp_expenses`],
  videoTag: [sql`select unnest(tags) as v from erp_videos`],
  paymentTerms: [sql`select payment_terms as v from erp_quotations`, sql`select payment_terms from erp_purchase_orders`],
  scrapCategory: [sql`select category as v from erp_scrap_sales`, sql`select category from erp_scrap_entries`],
  consignmentLabel: [sql`select consignment_label as v from erp_transporters`],
  shortLabel: [],
  creditNote: [],
  zone: [],
};

/**
 * What each `STORED_IN` query reads, in words, entry for entry — so the
 * retire modal can say WHICH records carry a value rather than one number.
 * The customer lists' first entry reads the CRM and the Sales Party sheet
 * together, which is how it is named.
 */
const STORED_WHAT: Record<string, { app: string; what: string }[]> = {
  materialType: [
    { app: "ERP", what: "can and material groups" },
    { app: "ERP", what: "raw materials" },
    { app: "ERP", what: "requirements" },
    { app: "ERP", what: "goods inward lines" },
    { app: "ERP", what: "re-order levels" },
  ],
  testingList: [
    { app: "ERP", what: "raw materials that test for it" },
    { app: "ERP", what: "lot tests" },
    { app: "ERP", what: "SFG QC decisions" },
  ],
  area: [{ app: "CRM", what: "customers and Sales Party rows" }, { app: "ERP", what: "suppliers" }],
  state: [{ app: "ERP", what: "parties, Sales Party rows and godowns" }, { app: "ERP", what: "suppliers" }],
  segment: [{ app: "ERP", what: "parties and Sales Party rows" }],
  counterType: [{ app: "ERP", what: "parties and Sales Party rows" }],
  godownCity: [{ app: "ERP", what: "godowns" }],
  complaintType: [{ app: "ERP", what: "customer requests and complaints" }],
  expenseCategory: [{ app: "ERP", what: "extra expenses" }, { app: "ERP", what: "petty cash entries" }],
  expenseParticular: [{ app: "ERP", what: "extra expenses" }],
  videoTag: [{ app: "ERP", what: "videos" }],
  paymentTerms: [{ app: "ERP", what: "quotations" }, { app: "ERP", what: "purchase orders" }],
  scrapCategory: [{ app: "ERP", what: "scrap sales" }, { app: "ERP", what: "scrap entries" }],
  consignmentLabel: [{ app: "ERP", what: "transporters" }],
};

/**
 * Where a list value is carried, source by source, for the retire modal. A
 * list nobody has mapped answers null — the modal then says records may carry
 * it, rather than claiming none do.
 */
export async function refValueUses(listKey: string, value: string): Promise<{ app: string; what: string; n: number }[] | null> {
  const uses = STORED_IN[listKey];
  if (!uses) return null;
  const words = STORED_WHAT[listKey] ?? [];
  const out: { app: string; what: string; n: number }[] = [];
  for (let i = 0; i < uses.length; i++) {
    const [row] = (await db.execute(sql`select count(*)::int as n from (${uses[i]}) s(v) where lower(trim(s.v)) = lower(trim(${value}))`)) as unknown as { n: number }[];
    out.push({ ...(words[i] ?? { app: "ERP", what: "records" }), n: Number(row?.n ?? 0) });
  }
  return out;
}

/**
 * Why a list value cannot be renamed, or "" when it can. A value is stored as
 * TEXT on the records that picked it, so a rename either rewrites every one of
 * those columns or leaves them carrying a spelling the list no longer has.
 * Rewriting reaches into synced sheet rows (which the next sync puts back) and
 * jsonb test results, so it is not done: a value is renamed only while no
 * record carries it — retire it and add the new spelling otherwise.
 */
export async function refRenameRefusal(listKey: string, value: string, ex: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> } = db): Promise<string> {
  if ((REF_RULE_SPELLINGS[listKey] ?? []).some((v) => v.toLowerCase() === value.trim().toLowerCase()))
    return `The ERP's rules read “${value}” by its exact spelling, so it cannot be renamed.`;
  const uses = STORED_IN[listKey];
  if (!uses) return "Records may carry this list's values, so they cannot be renamed. Retire the value and add the new spelling instead.";
  if (!uses.length) return "";
  const union = sql.join(uses, sql` union all `);
  const [row] = (await ex.execute(sql`select count(*)::int as n from (${union}) s where lower(trim(s.v)) = lower(trim(${value}))`)) as unknown as { n: number }[];
  const n = Number(row?.n ?? 0);
  return n > 0 ? `${n} record${n === 1 ? " carries" : "s carry"} “${value}”, so renaming it would leave them on a spelling the list no longer has. Retire it and add the new spelling instead.` : "";
}
