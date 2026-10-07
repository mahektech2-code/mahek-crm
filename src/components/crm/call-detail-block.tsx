import * as React from "react";
import type { CallDetailView } from "@/lib/call-detail";

/**
 * WHAT A CALL RECORDED, drawn under the call — one line always, the rest on
 * demand.
 *
 * A native `<details>`: nothing to keep in state, nothing for a re-render to
 * lose, and it works inside the timeline's fixed-height scrolling panel without
 * growing the page. The summary line is the part somebody scanning a week reads
 * ("Price / Quotation · Purchase Person (Ramesh)"); the lines are for the one
 * call they stop on.
 *
 * Draws NOTHING for a call with no detail, which is every call logged before
 * the columns existed — those rows look exactly as they always did.
 */
export function CallDetailBlock({
  detail,
  className,
}: {
  detail: CallDetailView | null | undefined;
  className?: string;
}) {
  if (!detail) return null;
  return (
    <details className={className ?? "mt-1 text-[13px]"}>
      <summary className="cursor-pointer text-body marker:text-muted">
        {detail.summary ?? "Call details"}
      </summary>
      <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 border-l border-divider pl-3">
        {detail.lines.map((l, i) => (
          <React.Fragment key={`${l.label}-${i}`}>
            <dt className="text-muted">{l.label}</dt>
            <dd className="text-ink">{l.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </details>
  );
}
