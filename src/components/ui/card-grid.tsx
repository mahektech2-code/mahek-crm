import * as React from "react";
import { cx } from "./primitives";

/* ---------------------------------------------------------------------------
 * A GRID THAT ANSWERS THE SCREEN, not a column count somebody typed.
 *
 * This suite carries 155 hand-written `grid-cols-N` and eighteen hand-written
 * `grid-cols-[repeat(auto-fit,minmax(Npx,1fr))]` — the same idea, in two
 * spellings, with nine different minima and no two screens agreeing about
 * which. A fixed count is the one that goes wrong at both ends of the desktop
 * range: four cards typed as `grid-cols-4` are four cramped cards at 1280 and
 * four stretched ones at 1920, and the count is right at exactly one width.
 *
 * `auto-fit` with a floor says the thing that is actually true — a card of
 * this kind stops being readable below N pixels — and lets the width decide
 * how many fit. That is why the codebase kept reaching for it; what it lacked
 * was a name, so every reach re-typed the template and picked its own N.
 *
 * WHAT IS NOT HERE is a set of three tidy sizes. The minima in this product
 * are genuinely different — a row of 96px unit chips, 216px figure cards,
 * 420px target panels — and rounding them to a scale would move layouts that
 * are correct today for no gain anybody could see. `min` is the number, named
 * where a name is real (`card`, `panel`, `broad`) and free where it is not.
 * ------------------------------------------------------------------------- */

/** The three minima this product uses more than once. */
const NAMED = { card: 216, panel: 260, broad: 380 } as const;

export function CardGrid({
  min = "card",
  gap = "gap-4",
  className,
  children,
}: {
  /** The width below which one of these stops being readable. */
  min?: keyof typeof NAMED | number;
  /**
   * The gap, as the Tailwind class rather than a size of this component's
   * own invention. There are seven different gaps on the grids in this suite —
   * `gap-px` on a divider grid, `gap-2.5` inside a drawer, `gap-x-8 gap-y-3`
   * on a definition list — and a two-value scale here would mean either
   * changing six layouts that are correct or leaving six grids outside this
   * component, which is how the second spelling comes back.
   */
  gap?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const floor = typeof min === "number" ? min : NAMED[min];
  return (
    <div
      className={cx("grid", gap, className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${floor}px, 1fr))` }}
    >
      {children}
    </div>
  );
}
