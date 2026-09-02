"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * The month header — arrows, a name, and now a picker to jump to one that
 * isn't a step away.
 *
 * `shiftMonth`/`monthName` and the arrow-pair markup were identical, by-hand
 * copies in five files (Sales Targets, Sales Performance, Founder Team, Sales
 * Salary, CRM Performance). One component, not five, so a fix here reaches
 * every screen at once instead of four of them.
 * ------------------------------------------------------------------------- */

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  // Day 15, not day 1 — the middle of the month formatted in APP_TIMEZONE
  // cannot fall into a neighbouring month no matter which zone the process
  // itself is running in.
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: APP_TIMEZONE,
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}

export function MonthNav({
  month,
  hrefFor,
}: {
  month: string;
  /** Builds the URL for an arbitrary `YYYY-MM` — the caller owns its own param name. */
  hrefFor: (month: string) => string;
}) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-1 text-[13px]">
      <Link
        href={hrefFor(shiftMonth(month, -1))}
        className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
      >
        ←
      </Link>
      <span className="px-2 text-muted">{monthName(month)}</span>
      <input
        type="month"
        value={month}
        onChange={(e) => {
          if (e.target.value) router.push(hrefFor(e.target.value));
        }}
        aria-label="Jump to a month"
        title="Jump to a month"
        className="rounded-[4px] border border-line bg-surface px-1.5 py-[3px] text-[12px] text-body"
      />
      <Link
        href={hrefFor(shiftMonth(month, 1))}
        className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
      >
        →
      </Link>
    </div>
  );
}
