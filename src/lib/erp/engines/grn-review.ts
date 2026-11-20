import { runCalc } from "../calc";
import { fdLong, resolveField, whenHolds, type FieldSpec } from "../ui";

/* ---------------------------------------------------------------------------
 * WHAT THE GOODS RECEIPT SAYS BACK BEFORE IT IS SAVED. One reading, for all
 * three ways in — the item-first record, "Receive goods" on a PO, and "Add
 * another" on a PR — so the three cannot say different things about one
 * delivery.
 *
 * It reads only what the form already holds: the header and line values, and
 * the data the server sent with the form. It re-asks the form's own rules for
 * what is visible and its own calculators for what is derived, so a field the
 * boxes hide is never listed and a figure never differs from the one beside
 * the box. It does NOT say what the save will do (testing or register, a PO
 * correction): the server decides that on save, and a copy of that rule here
 * would drift. PURE and client-safe.
 * ------------------------------------------------------------------------- */

export type ReviewRow = { label: string; value: string };
export type ReviewBlock = { title: string; rows: ReviewRow[] };

export type GrnReviewModel = {
  /** Section 1: the items received, one block each. */
  items: ReviewBlock[];
  /** Section 2: the PO each item is received against — number, supplier, PO item, pending. */
  orders: ReviewBlock[];
  /** Section 3: every visible receipt field, one block per item. */
  lines: ReviewBlock[];
  /** Section 3: the delivery — date, godown, transport, other cost, landing cost. */
  delivery: ReviewRow[];
};

export type GrnReviewInput = {
  header: FieldSpec[];
  line: FieldSpec[];
  h: Record<string, string>;
  lines: Record<string, string>[];
  data: Record<string, unknown>;
};

/** What a blank answer is drawn as. */
export const NONE = "—";

/** Line fields the first two sections already say (item, type, the PO item and what is pending on it). */
const SAID_ABOVE = new Set(["poLine", "type", "item", "pending"]);
/** Header fields the sections above say (the PO and its vendor), or that are only a placeholder until the save (the PR number). */
const HEADER_SAID = new Set(["po", "supplier", "pr"]);

/** "PO-33 · Mono Industries" → "PO-33". */
export function poNumberOf(label: string): string {
  return label.split(" · ")[0].trim();
}

function plainValue(f: FieldSpec, v: string): string {
  if (!v) return "";
  if (f.t === "date") return fdLong(v);
  if (f.t === "multi") return v.split("|").filter(Boolean).join(", ");
  return f.optLabels?.[v] ?? v;
}

/**
 * One field's value as the review says it: a derived field through its
 * calculator, a date long, a quantity with the unit it was measured in where
 * its label does not already say so. Empty answers are the dash, never blank.
 */
function valueOf(f: FieldSpec, h: Record<string, string>, l: Record<string, string>, lines: Record<string, string>[], i: number, data: Record<string, unknown>): string {
  if (f.t === "derived" || f.t === "suggest") return runCalc(f.calc, { h, l, lines, i, data }) || NONE;
  const v = plainValue(f, l[f.k] ?? "");
  if (!v) return NONE;
  return f.ub && !/\(/.test(f.l) ? `${v} ${f.ub}` : v;
}

export function grnReview(x: GrnReviewInput): GrnReviewModel {
  const { header, line, h, lines, data } = x;
  const supplierOf = (data.supplierOf ?? {}) as Record<string, string>;

  const items: ReviewBlock[] = [];
  const orders: ReviewBlock[] = [];
  const blocks: ReviewBlock[] = [];

  lines.forEach((l, i) => {
    const n = i + 1;
    const run = (calc: string) => runCalc(calc, { h, l, lines, i, data });
    const label = l.item || NONE;

    items.push({
      title: `${n}. ${label}`,
      rows: [
        { label: "Item", value: label },
        { label: "Material type", value: l.type || NONE },
      ],
    });

    /* A receipt started from the item names its PO on each line; "Receive goods" on a PO and "Add another" name it once in the header. */
    const po = l.po || h.po || "";
    const supplier = (po && supplierOf[po]) || (po.includes(" · ") ? po.split(" · ").slice(1).join(" · ") : "");
    orders.push({
      title: `${n}. ${label}`,
      rows: [
        { label: "PO number", value: po ? poNumberOf(po) : NONE },
        { label: "Supplier", value: supplier || NONE },
        { label: "PO item", value: l.poLine || NONE },
        { label: "Pending on the PO", value: run("inward.pending") || NONE },
      ],
    });

    const values = { ...h, ...l };
    const rows: ReviewRow[] = [];
    for (const f of line) {
      if (SAID_ABOVE.has(f.k) || !whenHolds(f.when, values, data)) continue;
      const r = resolveField(f, values, data);
      rows.push({ label: f.l, value: valueOf(r, h, l, lines, i, data) });
    }
    blocks.push({ title: `${n}. ${label}`, rows });
  });

  const delivery: ReviewRow[] = [];
  /* "Add another" says which PR the line is going on; a new receipt has no number until it is saved. */
  if (h.prFixed) delivery.push({ label: "Added to PR", value: h.prFixed });
  for (const f of header) {
    if (HEADER_SAID.has(f.k) || !whenHolds(f.when, h, data)) continue;
    const r = resolveField(f, h, data);
    delivery.push({ label: f.l, value: valueOf(r, h, h, lines, -1, data) });
  }

  return { items, orders, lines: blocks, delivery };
}
