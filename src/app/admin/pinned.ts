import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * Console tables hold one line per cell and scroll sideways rather than
 * reflowing, which leaves two cells that must not scroll away with the rest:
 * the one saying which row this is, and the one carrying its actions.
 *
 * A pinned cell paints its own background, otherwise the rest of the row
 * scrolls visibly underneath it.
 * ------------------------------------------------------------------------- */

export function pinnedCell(
  side: "left" | "right",
  index: number,
  selected = false,
): string {
  return cx(
    "sticky z-10",
    side === "left" ? "left-0 border-r border-line" : "right-0 border-l border-line",
    selected ? "bg-brand-soft" : index % 2 ? "bg-canvas" : "bg-surface",
  );
}

/** The header of a pinned column: sticky in both directions at once. */
export function pinnedHead(side: "left" | "right"): string {
  return cx(
    "z-20",
    side === "left" ? "left-0 border-r border-line" : "right-0 border-l border-line",
  );
}
