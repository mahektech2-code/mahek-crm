"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import {
  currentYear,
  yearKindOf,
  yearLabel,
  yearSpanLabel,
  type YearKind,
} from "@/lib/year-period";

/* ---------------------------------------------------------------------------
 * The one year picker, for every yearly screen in MahekOne.
 *
 * Two questions, asked in order: count by FINANCIAL year or by CALENDAR year,
 * then WHICH year. Switching the kind lands on the newest year of that kind
 * rather than guessing a "matching" one — April to March and January to
 * December do not line up, and pretending one maps onto the other would show a
 * year nobody picked. The dates the year covers are printed beside it, because
 * "FY 2026-27" is a label and "1 Apr 2026 – 31 Mar 2027" is the answer.
 *
 * A screen may also offer "All time" and "Custom dates"; those are not years,
 * so they keep whichever kind the toggle last showed.
 * ------------------------------------------------------------------------- */

export const ALL_TIME = "all";
export const CUSTOM_DATES = "custom";

export function YearFilter({
  value,
  options,
  today,
  onChange,
  allowAll = false,
  allowCustom = false,
  className,
}: {
  /** A year ("26-27" or "2026"), or ALL_TIME / CUSTOM_DATES where offered. */
  value: string;
  /** The years this screen has data for, newest first, by kind. */
  options: { fy: string[]; cy: string[] };
  /** The business date, so a kind with no data still offers this year. */
  today: string;
  onChange: (value: string) => void;
  allowAll?: boolean;
  allowCustom?: boolean;
  className?: string;
}) {
  const valueKind = yearKindOf(value);
  // Remember the kind while "All time" or "Custom dates" is chosen, so the
  // toggle does not jump back to financial on its own.
  const [lastKind, setLastKind] = React.useState<YearKind>(valueKind ?? "fy");
  const kind = valueKind ?? lastKind;
  const years = options[kind].length ? options[kind] : [currentYear(today, kind)];

  const pickKind = (next: YearKind) => {
    if (next === kind) return;
    setLastKind(next);
    // Stay on "All time" / "Custom dates" if that is where the person is.
    if (!valueKind) return;
    onChange(options[next][0] ?? currentYear(today, next));
  };

  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      <div
        role="group"
        aria-label="Count years by"
        className="inline-flex rounded-[6px] border border-line bg-surface p-0.5"
      >
        {(
          [
            ["fy", "Financial year"],
            ["cy", "Calendar year"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => pickKind(k)}
            title={k === "fy" ? "1 April to 31 March" : "1 January to 31 December"}
            className={cx(
              "h-8 cursor-pointer rounded-[4px] border-none px-3 text-[13px] font-medium",
              kind === k
                ? "bg-canvas text-ink shadow-[inset_0_0_0_1px_var(--color-line)]"
                : "bg-transparent text-muted hover:text-body",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <select
        aria-label={kind === "fy" ? "Financial year" : "Calendar year"}
        value={valueKind ? value : value === ALL_TIME || value === CUSTOM_DATES ? value : years[0]}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 text-sm text-body focus:border-brand focus:outline-none"
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {yearLabel(y)}
          </option>
        ))}
        {allowAll ? <option value={ALL_TIME}>All time</option> : null}
        {allowCustom ? <option value={CUSTOM_DATES}>Custom dates…</option> : null}
      </select>

      {valueKind ? (
        <span className="text-[13px] whitespace-nowrap text-muted">{yearSpanLabel(value)}</span>
      ) : null}
    </div>
  );
}
