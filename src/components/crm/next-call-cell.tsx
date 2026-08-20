"use client";

import * as React from "react";
import { Badge } from "@/components/ui/primitives";
import { shortDate } from "@/lib/format";
import {
  NEXT_STEP_LABELS,
  hasNoDate,
  type NextStepKind,
} from "@/lib/next-step-labels";

export type StoredNextStep = {
  kind: NextStepKind;
  date: string | null;
  reason: string | null;
  headline: string | null;
  detail: string | null;
  toldOn: string;
};

/**
 * WHEN THIS CUSTOMER COMES BACK, in a table cell.
 *
 * The same value the dialog shows when a call is saved, read from the `calls`
 * row it was written to. One component for both tables, because the Call
 * history and the customers list are asking the same question of the same
 * columns, and two renderings would differ in exactly the way that makes
 * somebody check both and trust neither.
 *
 * THREE THINGS IT REFUSES TO DO.
 *
 * It does not invent a date where the kind carries none. `decide` and `none`
 * mean nobody can reach them and nothing is marked do-not-contact — the word
 * IS the answer, and a blank cell there reads as missing data rather than as
 * "nothing is coming".
 *
 * It does not show a stored date as though it were live. These columns say
 * what the screen told somebody on the day they logged the call; a customer
 * who has ordered since has a different next call now. So a date that has
 * already passed is drawn muted with the day it was said, rather than sitting
 * in a column of future dates looking like a commitment.
 *
 * It does not fill an empty cell with anything. A customer nobody has called
 * has no next call, and inventing "—" with a tooltip explaining the absence is
 * noise on the majority of a fresh book.
 */
export function NextCallCell({
  step,
  today,
}: {
  step: StoredNextStep | null;
  /**
   * The working day, from the server. Not read from the clock here: these are
   * client components and reading the clock during render is impure — the rule
   * this codebase enforces with the React Compiler lint, and the reason every
   * screen takes its `now` as a prop.
   */
  today: string;
}) {
  if (!step) return <span className="text-muted">-</span>;

  const label = NEXT_STEP_LABELS[step.kind];
  const explanation = [step.headline, step.detail, step.reason]
    .filter(Boolean)
    .join(" — ");
  const told = `Said when the call was logged on ${shortDate(step.toldOn)}`;

  if (hasNoDate(step.kind) || !step.date) {
    return (
      <span title={[explanation, told].filter(Boolean).join(" · ")}>
        <Badge tone={label.tone}>{label.short}</Badge>
      </span>
    );
  }

  // Past-dated: it was true when it was said, and it is not a promise now.
  const stale = step.date < today;

  return (
    <span
      className="whitespace-nowrap"
      title={[explanation, told].filter(Boolean).join(" · ")}
    >
      <span className={stale ? "text-muted" : "text-ink"}>
        {shortDate(step.date)}
      </span>
      <span className="ml-1.5 text-[11px] text-muted">{label.short}</span>
    </span>
  );
}
