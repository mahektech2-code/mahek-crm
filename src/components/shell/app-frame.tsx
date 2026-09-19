import * as React from "react";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * ONE FRAME, for every app in MahekOne.
 *
 * Not the header — each app's header carries genuinely different things, and
 * flattening a scope switch, a team line and a module tab strip into one
 * component would be a component with four modes. This is the part underneath
 * all of them: the full-height column, where the page scrolls, what happens
 * beside a sidebar, and the width at which the whole thing gives up and
 * scrolls sideways.
 *
 * WHY IT HAD TO BECOME ONE THING. Eight app roots each stated that for
 * themselves, and they did not agree. The CRM, Accounts and the Admin Console
 * floored at `min-w-[1000px]`; the Sales Dashboard at `[1100px]`; HRMS,
 * Enquiries, Reports and Founder floored at nothing at all, so their screens
 * simply crushed. Three of them scrolled the main element and three scrolled
 * the body. None of that was a decision anybody took — it is what happens when
 * the same idea is typed out eight times, and it is why "make the product
 * behave across desktop sizes" was not a CSS problem: there was nowhere to put
 * the answer.
 *
 * There is now, and it is what makes this automatic for the next app: a new
 * MahekOne app renders `AppFrame` and is correct across the desktop range
 * without knowing the range exists. See AGENTS.md, "Adding the next MahekOne
 * app".
 *
 * THE FLOOR IS A TOKEN, `--container-shell-floor`, and it is deliberately
 * BELOW the `desk` breakpoint the layouts are designed for: a browser windowed
 * to half a 1440 screen is a thing people do all day, and cramped is better
 * than cut off. Anything narrower scrolls sideways rather than reflowing —
 * this is a desk product, the dense tables are the point of it, and the field
 * team has MBOS on a handset rather than a browser.
 *
 * THE SCROLL MODEL IS THE MAIN ELEMENT, NEVER THE BODY. The header and the
 * sidebar are fixed furniture and only the content moves, which is what keeps
 * a heading in view while somebody works down a table. The four apps that
 * scrolled the body did it by omission rather than by choosing to.
 * ------------------------------------------------------------------------- */

export function AppFrame({
  header,
  sidebar,
  children,
  /**
   * `fade` is the arrival animation three of these apps drew and five did not.
   * It belongs to the frame now so the suite does not open two different ways
   * depending on which app you land in.
   */
  fade = true,
  /** Escape hatch for a screen that manages its own scrolling. */
  scroll = true,
}: {
  header: React.ReactNode;
  /** Omitted by the apps whose navigation is in the header. */
  sidebar?: React.ReactNode;
  children: React.ReactNode;
  fade?: boolean;
  scroll?: boolean;
}) {
  return (
    <div className="flex h-screen min-w-shell-floor flex-col overflow-hidden bg-canvas">
      {header}
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <main
          className={cx(
            "relative min-w-0 flex-1",
            scroll && "overflow-y-auto",
            fade && "animate-fade-in",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
