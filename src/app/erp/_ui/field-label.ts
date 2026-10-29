/* ---------------------------------------------------------------------------
 * A field's label, split into the words and the unit.
 *
 * Labels were written with the unit in brackets — "Use quantity (litres)",
 * "Rate (₹)" — and with "(optional)" typed in by hand. The unit belongs inside
 * the box, beside the figure it describes, and "optional" is said once by the
 * field itself. So the label loses both, and the box carries the unit.
 *
 * Only a box that holds a figure can carry a unit: a select keeps its label
 * whole, because the unit has nowhere else to go. Pure, so it is tested.
 * ------------------------------------------------------------------------- */

const UNITS: Record<string, { text: string; before?: boolean }> = {
  "₹": { text: "₹", before: true },
  rupees: { text: "₹", before: true },
  litres: { text: "L" },
  litre: { text: "L" },
  ltr: { text: "L" },
  l: { text: "L" },
  kg: { text: "kg" },
  cans: { text: "cans" },
  boxes: { text: "boxes" },
  days: { text: "days" },
  km: { text: "km" },
  "%": { text: "%" },
};

/** Kinds of field whose box shows a figure, so a unit can sit inside it. */
const FIGURE_KINDS = new Set(["num", "derived", "text"]);

/** `optional` is true where the label itself said "(optional)". */
export type LabelParts = { label: string; unit?: string; unitBefore?: boolean; optional?: boolean };

export function splitLabel(label: string, kind: string): LabelParts {
  const said = /\(optional\)\s*$/i.test(label);
  const l = label.replace(/\s*\(optional\)\s*$/i, "").trim() || label;
  const opt = said ? { optional: true } : {};
  const m = /^(.*\S)\s*\(([^()]{1,8})\)$/.exec(l);
  if (m && FIGURE_KINDS.has(kind)) {
    const unit = UNITS[m[2].trim().toLowerCase()] ?? UNITS[m[2].trim()];
    if (unit) return { label: m[1], unit: unit.text, ...(unit.before ? { unitBefore: true } : {}), ...opt };
  }
  return { label: l, ...opt };
}
