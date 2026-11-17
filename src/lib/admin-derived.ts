/**
 * The derived figures Data health can rebuild on demand, in the order the
 * nightly pass rebuilds them. Pure and client-safe: the screen draws a row per
 * entry and the action runs the function behind the same id.
 */
export const DERIVED_FIGURES = [
  { id: "outstanding", label: "Outstanding" },
  { id: "cycles", label: "Buying cycles" },
  { id: "followUps", label: "Follow-up stages" },
  { id: "slowPayers", label: "Slow payers" },
  { id: "orderHolds", label: "Order holds" },
] as const;

export type DerivedFigure = (typeof DERIVED_FIGURES)[number]["id"];
