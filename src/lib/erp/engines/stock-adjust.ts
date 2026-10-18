/* ---------------------------------------------------------------------------
 * ADJUSTING STOCK BY HAND, FROM ANY ROW OF STOCK ON HAND. PURE and client-safe.
 *
 * Add or Remove, a quantity, and one reason from a short list; "Other" asks
 * for the reason in words. It takes effect on save — nobody approves it — and
 * every adjustment is a row with its reason and its author, shown in the stock
 * inquiry beside the movement it made.
 * ------------------------------------------------------------------------- */

export const ADJUST_STAGES = ["rm", "sfg", "fg", "pack"] as const;
export type AdjustStage = (typeof ADJUST_STAGES)[number];

export const STAGE_LABEL: Record<AdjustStage, string> = {
  rm: "Raw material",
  sfg: "Semi-finished",
  fg: "Finished goods",
  pack: "Packed",
};

export const ADJUST_REASONS: { v: string; label: string }[] = [
  { v: "damaged", label: "Damaged" },
  { v: "leakage", label: "Leakage" },
  { v: "lost", label: "Lost or missing" },
  { v: "count", label: "Counting mistake" },
  { v: "missed", label: "Entry missed" },
  { v: "other", label: "Other" },
];

export const ADJUST_DIRECTIONS = ["Add", "Remove"] as const;

export function adjustReasonLabel(code: string | null | undefined): string {
  return ADJUST_REASONS.find((r) => r.v === code)?.label ?? (code ?? "—");
}

export type AdjustInput = { dir: "add" | "remove"; qty: number; reasonCode: string; note: string | null };
export type AdjustRead = { ok: true; value: AdjustInput } | { ok: false; field: string; error: string };

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Reads the prompt's values against the lot's stock now. A removal may take
 * the lot to zero and never below it; an addition has no ceiling.
 */
export function readAdjust(values: Record<string, string | undefined>, stock: number): AdjustRead {
  const dirWord = (values.dir ?? "").trim();
  const dir = dirWord === "Add" ? "add" : dirWord === "Remove" ? "remove" : null;
  if (!dir) return { ok: false, field: "dir", error: "Choose Add or Remove" };
  const raw = (values.qty ?? "").replace(/,/g, "").trim();
  const qty = raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, field: "qty", error: "Type a quantity above zero" };
  if (dir === "remove" && r3(qty) > r3(stock) + 1e-9)
    return { ok: false, field: "qty", error: `Only ${r3(Math.max(0, stock))} is in this lot — stock is never taken below zero` };
  const reason = ADJUST_REASONS.find((r) => r.label === (values.reason ?? "").trim() || r.v === (values.reason ?? "").trim());
  if (!reason) return { ok: false, field: "reason", error: "Choose a reason" };
  const note = (values.note ?? "").trim() || null;
  if (reason.v === "other" && (!note || note.length < 3)) return { ok: false, field: "note", error: "Write the reason" };
  return { ok: true, value: { dir, qty: r3(qty), reasonCode: reason.v, note: reason.v === "other" ? note : note } };
}

/** "Damaged", or "Other: extra half drum with the last GRN". */
export function adjustReasonText(code: string, note: string | null): string {
  const label = adjustReasonLabel(code);
  return note ? `${label}: ${note}` : label;
}

/** The stock after an adjustment, for the sentence the save answers with. */
export function stockAfter(stock: number, a: Pick<AdjustInput, "dir" | "qty">): number {
  return r3(a.dir === "add" ? stock + a.qty : stock - a.qty);
}
