import "server-only";
import { and, asc, eq } from "drizzle-orm";
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
