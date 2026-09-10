import type { SheetRowIssue } from "@/db/schema";
import { parseIndianMobile, partyNameKey } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * Reading the `Customer Details` tab of a defunct prior system ("Mahek EMP
 * 2.0") — the shop master behind the Activity log that migration 0072 already
 * imported, and the only place a phone number for those shops exists.
 *
 * PURE — no I/O, no clock, no database. Same contract as every other sheet
 * parser here: this never fails and never guesses. A cell it cannot read
 * becomes null plus an issue naming the column and quoting what was there, and
 * the row still imports.
 * ------------------------------------------------------------------------- */

/** The sheet's own human header row, verbatim. */
export const CUSTOMER_MASTER_COL = {
  name: "Customer Name",
  address: "Address",
  mobile: "Mobile Number",
  altMobile: "Alternate Number",
  rating: "Rating",
  segmentation: "Segmentation",
  location: "Location",
  state: "State",
  salesPerson: "Sales Person",
  tagEmployee: "Tag Employee",
  specialInstructions: "Special Instructions",
  backOffice: "Back Office Employee",
  status: "Status",
  deactivationRequest: "Deactivation Request",
  deactivationRemark: "Deactivation Remark",
} as const;

/**
 * A number the old app wrote onto shops it had no number for.
 *
 * It is a syntactically perfect Indian mobile and it sits on 952 of the 5,292
 * rows, which is what makes it dangerous: every validity check passes, and
 * importing it as written would give 952 unrelated shops one phone number.
 * The first telecaller to work that list rings one shopkeeper 952 times.
 *
 * It is detected by REPETITION at import time rather than hard-coded here —
 * see `flagSharedMobiles` — because the next export will have a different
 * placeholder and a literal in the code would not catch it. This constant
 * exists only to document what was found.
 */
export const KNOWN_PLACEHOLDER_NOTE =
  "one mobile number appeared on 952 of 5,292 rows in the first export";

/** How many shops must share a number before it is treated as a placeholder. */
export const SHARED_MOBILE_LIMIT = 3;

export type ParsedCustomerMasterRow = {
  customerName: string;
  nameKey: string;
  mobileRaw: string | null;
  mobile: string | null;
  altMobile: string | null;
  address: string | null;
  locationText: string | null;
  state: string | null;
  rating: string | null;
  segmentation: string | null;
  specialInstructions: string | null;
  salesPersonName: string | null;
  tagEmployeeName: string | null;
  backOfficeName: string | null;
  sheetStatus: string | null;
  deactivationRequest: string | null;
  deactivationRemark: string | null;
  issues: SheetRowIssue[];
};

const text = (cells: Record<string, string>, col: string): string | null => {
  const v = (cells[col] ?? "").trim();
  return v === "" ? null : v;
};

/**
 * The sheet's Active/Deactive, folded.
 *
 * Its casing is inconsistent in the source — 2,090 `active` against 2,664
 * `Active` and 537 `Deactive` — which is exactly the kind of difference that
 * turns into two behaviours if it is compared anywhere but here.
 */
export function readSheetStatus(raw: string | null): "active" | "deactive" | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v.startsWith("deactive")) return "deactive";
  if (v.startsWith("active")) return "active";
  return null;
}

/**
 * Whether the Address cell holds an address or somebody's meeting note.
 *
 * 33 of them hold a sentence of Hindi about a thinner sample. A note in the
 * address field is not a parse failure — the cell is readable, it is just not
 * an address — so this raises an `ambiguous` issue and keeps the text, rather
 * than nulling a field somebody may still want to read.
 */
export function looksLikeNote(address: string): boolean {
  if (address.length <= 120) return false;
  // A real address of this length is mostly commas and short tokens; a
  // sentence is mostly spaces and long words.
  const commas = (address.match(/,/g) ?? []).length;
  return commas <= 2;
}

export function parseCustomerMasterRow(
  cells: Record<string, string>,
): ParsedCustomerMasterRow | null {
  const C = CUSTOMER_MASTER_COL;
  const issues: SheetRowIssue[] = [];

  const customerName = (cells[C.name] ?? "").trim();
  // A row with no name is not a shop. It is the only thing that makes a row
  // unusable rather than merely incomplete, so it is the only thing dropped.
  if (!customerName) return null;

  const mobileRaw = text(cells, C.mobile);
  const mobile = mobileRaw ? parseIndianMobile(mobileRaw) : null;
  if (mobileRaw && !mobile) {
    issues.push({
      column: C.mobile,
      value: mobileRaw,
      problem: "not a 10-digit Indian mobile number",
      kind: "unreadable",
    });
  }
  if (!mobileRaw) {
    issues.push({
      column: C.mobile,
      value: "",
      problem: "no phone number — this shop cannot be called",
      kind: "unreadable",
    });
  }

  const altRaw = text(cells, C.altMobile);
  const altMobile = altRaw ? parseIndianMobile(altRaw) : null;
  if (altRaw && !altMobile) {
    issues.push({
      column: C.altMobile,
      value: altRaw,
      problem: "not a 10-digit Indian mobile number",
      kind: "unreadable",
    });
  }

  const address = text(cells, C.address);
  if (address && looksLikeNote(address)) {
    issues.push({
      column: C.address,
      value: address.slice(0, 120),
      problem: "reads as a meeting note rather than an address",
      kind: "ambiguous",
    });
  }

  const sheetStatusRaw = text(cells, C.status);
  if (sheetStatusRaw && readSheetStatus(sheetStatusRaw) === null) {
    issues.push({
      column: C.status,
      value: sheetStatusRaw,
      problem: "neither Active nor Deactive",
      kind: "ambiguous",
    });
  }

  // `customers.city` is NOT NULL, so a shop with no town has nowhere to go.
  // Said as an issue rather than a drop: the projection decides what to do
  // about it, and a row nobody can account for later is worse than one that
  // says why it was held.
  const locationText = text(cells, C.location);
  if (!locationText) {
    issues.push({
      column: C.location,
      value: "",
      problem: "no town — a customer record needs one",
      kind: "unreadable",
    });
  }

  return {
    customerName,
    nameKey: partyNameKey(customerName),
    mobileRaw,
    mobile,
    altMobile,
    address,
    locationText,
    state: text(cells, C.state),
    rating: text(cells, C.rating),
    segmentation: text(cells, C.segmentation),
    specialInstructions: text(cells, C.specialInstructions),
    salesPersonName: text(cells, C.salesPerson),
    tagEmployeeName: text(cells, C.tagEmployee),
    backOfficeName: text(cells, C.backOffice),
    sheetStatus: sheetStatusRaw,
    deactivationRequest: text(cells, C.deactivationRequest),
    deactivationRemark: text(cells, C.deactivationRemark),
    issues,
  };
}

/**
 * Which mobile numbers are shared by so many shops that they cannot be real.
 *
 * Detected rather than listed, because the placeholder is a property of this
 * export and not of the world — the next one will use a different number, and
 * a literal in the code would silently stop catching it. Two shops sharing a
 * number is ordinary (a proprietor with two counters); `SHARED_MOBILE_LIMIT`
 * is where it stops being a coincidence.
 *
 * PURE, and separate from the row parse because it is a fact about the whole
 * sheet that no single row can see.
 */
export function flagSharedMobiles(
  rows: { nameKey: string; mobile: string | null }[],
  limit = SHARED_MOBILE_LIMIT,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.mobile) continue;
    counts.set(r.mobile, (counts.get(r.mobile) ?? 0) + 1);
  }
  const shared = new Map<string, number>();
  for (const [mobile, count] of counts) {
    if (count >= limit) shared.set(mobile, count);
  }
  return shared;
}
