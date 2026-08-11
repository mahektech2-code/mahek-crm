import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * Pinning the two cells that must not scroll away.
 *
 * Tables here hold one line per cell and scroll sideways rather than
 * reflowing — a phone number folded down three lines is unreadable in a way a
 * sideways scroll is not. That trade only works if two cells stay put: the one
 * saying WHICH ROW this is, and the one carrying its ACTIONS. Scroll the name
 * off the left and every remaining cell is an orphaned value; scroll the
 * actions off the right and the way to act on a row depends on where the
 * table happens to be scrolled to.
 *
 * A pinned cell paints its own background, otherwise the rest of the row
 * scrolls visibly underneath it — which is also why it takes the row index:
 * zebra striping has to be continued by hand once a cell is lifted out of the
 * normal flow.
 *
 * This began in the Admin console, which had the widest tables and hit the
 * problem first. It lives here now because it was never about the console.
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
