/* ---------------------------------------------------------------------------
 * THE OLD ORDER SHEET'S COST, MATCHED BACK ONTO THE ERP'S LINES — pure.
 *
 * Until 26 Oct 2026 nobody allocated lots to a line in the ERP, so a line that
 * left before then carries no lot and its margin is unknown. The order sheet
 * the business ran on before costed every one of those lines itself, in its
 * "Lotcode Costing" column, and its "Margine" is the line's amount less
 * exactly that figure. This is the arithmetic that finds each ERP line's sheet
 * row; `lib/erp/sheet-costing.ts` wires it to the tables.
 *
 * A line is matched on ITS ORDER NUMBER, ITS PRODUCT AND ITS CANS, and only
 * where that names one cost. Two sheet rows that agree are the same line typed
 * twice and are taken; two that disagree are AMBIGUOUS and left alone — a
 * guessed cost is a margin nobody can stand behind, which is worse than the
 * honest "unknown" the desk already shows. A line whose cans changed after the
 * sheet was written matches nothing, for the same reason.
 * ------------------------------------------------------------------------- */

export type SheetCostRow = {
  orderNo: number | null;
  /** The catalogue product the row's description resolves to; null when it resolves to none. */
  productId: string | null;
  cans: number | null;
  /** The sheet's "Lotcode Costing" cell, as typed. */
  cost: string | null;
};

export type CostLine = { id: string; orderNo: number; productId: string; cans: number };

export type SheetCostMatch = {
  /** Line id → the sheet's cost, in paise. */
  costs: Map<string, number>;
  /** Lines whose sheet rows name more than one cost. */
  ambiguous: string[];
  /** Lines no sheet row costs. */
  unmatched: string[];
};

/** "8,986.50" → 898650. Blank, zero, negative or not a number → null: none of those is a cost. */
export function sheetRupeesToPaise(raw: string | null | undefined): number | null {
  const s = String(raw ?? "").replace(/[,₹\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const paise = Math.round(Number(s) * 100);
  return paise > 0 ? paise : null;
}

const keyOf = (orderNo: number, productId: string, cans: number) => `${orderNo}|${productId}|${cans}`;

export function matchSheetCosting(lines: readonly CostLine[], rows: readonly SheetCostRow[]): SheetCostMatch {
  const byKey = new Map<string, Set<number>>();
  for (const r of rows) {
    if (r.orderNo == null || !r.productId || r.cans == null) continue;
    const paise = sheetRupeesToPaise(r.cost);
    if (paise == null) continue;
    const k = keyOf(r.orderNo, r.productId, r.cans);
    const set = byKey.get(k) ?? new Set<number>();
    set.add(paise);
    byKey.set(k, set);
  }
  const out: SheetCostMatch = { costs: new Map(), ambiguous: [], unmatched: [] };
  for (const l of lines) {
    const found = byKey.get(keyOf(l.orderNo, l.productId, l.cans));
    if (!found) out.unmatched.push(l.id);
    else if (found.size > 1) out.ambiguous.push(l.id);
    else out.costs.set(l.id, [...found][0]!);
  }
  return out;
}
