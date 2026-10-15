import type { ExpenseLineRow } from "@/lib/services/expense-claims-service";
import { eligibilityOf } from "@/lib/engines/expense-ledger";
import { ledgerLineOf } from "@/lib/services/expense-ledger-service";
import { expenseKindLabel } from "./labels";

/* ---------------------------------------------------------------------------
 * The filters a table of expense lines offers, and the one place they are
 * applied — the Claims list and a salesman's statement read the same rows and
 * must narrow them the same way. Pure; the URL carries the answers.
 * ------------------------------------------------------------------------- */

export type LineFilters = {
  who?: string;
  kind?: string;
  bill?: string;
  policy?: string;
  q?: string;
};

/** A line's type as one value: an allowance and a bill of the same kind differ. */
export function kindKey(r: Pick<ExpenseLineRow, "allowance" | "kind">): string {
  return r.allowance ? `allowance:${r.kind}` : r.kind;
}

export const BILL_OPTIONS = [
  { value: "with", label: "Bill attached" },
  { value: "without", label: "No bill attached" },
];

export const POLICY_OPTIONS = [
  { value: "within", label: "Within policy" },
  { value: "over", label: "Over policy" },
  { value: "not_eligible", label: "Not eligible" },
  { value: "unpriced", label: "Not checked yet" },
  { value: "flagged", label: "Something to check" },
];

/** The types present in `rows`, so the box never offers a type with nothing behind it. */
export function kindOptions(
  rows: ExpenseLineRow[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows)
    seen.set(kindKey(r), expenseKindLabel(r.kind, r.allowance));
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function matchesLine(r: ExpenseLineRow, f: LineFilters): boolean {
  if (f.who && r.userId !== f.who) return false;
  if (f.kind && kindKey(r) !== f.kind) return false;
  if (f.bill) {
    if (r.allowance) return false;
    const has = r.files.some((x) => !x.gone);
    if (f.bill === "with" ? !has : has) return false;
  }
  if (f.policy) {
    if (r.allowance) return false;
    if (f.policy === "flagged") {
      if (r.openFlags === 0) return false;
    } else {
      const e = eligibilityOf(ledgerLineOf(r));
      const want = f.policy === "over" ? "over_policy" : f.policy;
      if (e !== want) return false;
    }
  }
  if (f.q) {
    const hay = [
      r.userName,
      r.vendorName,
      r.billNumber,
      r.remarks,
      r.decisionNote,
      expenseKindLabel(r.kind, r.allowance),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}
