/**
 * WHAT A NAVIGATION LOOKS LIKE WHILE IT IS HAPPENING.
 *
 * Every screen in this console is a server component doing real work — the
 * roll-call runs three queries, the Live map reads a day of positions, Invoices
 * now counts the whole bill book. Without a boundary, Next holds the OLD screen
 * on the display until the new one is ready: the sidebar highlight does not
 * move, nothing changes, and a manager on a slow connection presses the link
 * again. Two requests, and the second one is why it feels slower still.
 *
 * It is deliberately a skeleton of the SHAPE every screen here shares — a
 * heading, a row of figures, a table — rather than a spinner. The layout does
 * not jump when the real thing lands, and the page reads as loading rather than
 * as empty.
 */
export default function Loading() {
  return (
    <div className="p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <div className="mb-4">
        <Bar className="h-[30px] w-[220px]" />
        <Bar className="mt-2 h-[13px] w-[460px]" />
      </div>

      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-3.5 rounded-[6px] border border-line bg-surface px-5 py-3.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="block">
            <Bar className="h-[11px] w-[90px]" />
            <Bar className="mt-1.5 h-[22px] w-[70px]" />
          </span>
        ))}
      </div>

      <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
        <div className="h-8.5 border-b border-line bg-canvas" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div
            key={i}
            className={
              "flex items-center gap-6 border-b border-divider px-4 py-2.5 last:border-b-0 " +
              (i % 2 === 1 ? "bg-canvas" : "bg-surface")
            }
          >
            <Bar className="h-[13px] w-[160px]" />
            <Bar className="h-[13px] w-[120px]" />
            <Bar className="h-[13px] w-[200px]" />
            <Bar className="h-[13px] w-[90px]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One grey block. `animate-pulse` is Tailwind's own, so no keyframe is added. */
function Bar({ className }: { className: string }) {
  return <span className={`block animate-pulse rounded-[3px] bg-divider ${className}`} />;
}
