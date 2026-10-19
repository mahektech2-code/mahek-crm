"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { Pill } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { shortDate } from "@/lib/format";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import type { AttentionList, AttentionRow } from "@/lib/services/lead-dashboard-service";

/* ---------------------------------------------------------------------------
 * §8.2 — My queue: what is owed on a lead, overdue first, then due today.
 *
 * The rows come from the Overdue and Due tabs' own functions (see the
 * service); the TOTALS come from SQL over the whole scoped book, so "All N"
 * says what the list is a slice of. The chips only filter the rows loaded —
 * a view of this list, never a second query.
 *
 * **A chip is the KIND of work, read off the rung.** The funnel's early rungs
 * are worked by phone (the Calling desk's three calls, the verification call);
 * the review rungs are a trial or an appointment somebody has to judge;
 * everything else is a promise to follow up. The rung is the one fact every
 * row carries that says which, so no row needs a second reading.
 * ------------------------------------------------------------------------- */

type Kind = "calls" | "followUps" | "reviews";

const CALL_RUNGS: ReadonlySet<LeadStage> = new Set<LeadStage>([
  "new",
  "contacted",
  "suspect",
  "prospect",
]);
const REVIEW_RUNGS: ReadonlySet<LeadStage> = new Set<LeadStage>([
  "sample_received",
  "sample_review",
  "management_review",
  "distributor_approval",
]);

function kindOf(stage: LeadStage): Kind {
  if (CALL_RUNGS.has(stage)) return "calls";
  if (REVIEW_RUNGS.has(stage)) return "reviews";
  return "followUps";
}

const CHIPS: { key: Kind | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "calls", label: "Calls" },
  { key: "followUps", label: "Follow-ups" },
  { key: "reviews", label: "Reviews" },
];

/**
 * A fortnight is where a promise stops being late and starts being abandoned.
 * A READING AID, not a threshold: nothing is chased or scored on it.
 */
const LONG_OVERDUE_DAYS = 14;

function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const two = (words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "");
  return two.toUpperCase() || "?";
}

function Due({ row }: { row: AttentionRow }) {
  if (row.overdue) {
    return (
      <Pill tone={row.overdueDays >= LONG_OVERDUE_DAYS ? "danger" : "warn"}>
        {row.overdueDays === 0 ? "Late" : `${plural(row.overdueDays, "day")} late`}
      </Pill>
    );
  }
  return <Pill tone="brand">{row.parkedBack ? "Back today" : "Today"}</Pill>;
}

const ROW_BTN =
  "inline-flex h-7 items-center rounded-[6px] border border-line bg-surface px-2.5 text-[12px] font-medium text-body no-underline hover:bg-canvas hover:text-ink hover:no-underline";

export function AttentionCard({
  workspace,
  list,
}: {
  workspace: LeadWorkspace;
  list: AttentionList;
}) {
  const { rows, overdueTotal, dueTodayTotal } = list;
  const [chip, setChip] = React.useState<Kind | "all">("all");

  const counts = React.useMemo(() => {
    const c: Record<Kind | "all", number> = { all: rows.length, calls: 0, followUps: 0, reviews: 0 };
    for (const r of rows) c[kindOf(r.stage)] += 1;
    return c;
  }, [rows]);
  const shown = chip === "all" ? rows : rows.filter((r) => kindOf(r.stage) === chip);
  const total = overdueTotal + dueTodayTotal;

  return (
    <section aria-label="My queue" className="rounded-[10px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-[18px] py-3.5">
        <h2 className="m-0 mr-2.5 text-base font-semibold text-ink">My queue</h2>
        {rows.length > 0
          ? CHIPS.map((c) => {
              const on = chip === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setChip(c.key)}
                  className={cx(
                    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium",
                    on
                      ? "border-brand bg-brand-soft text-brand-deep"
                      : "border-line bg-surface text-body hover:text-ink",
                  )}
                >
                  {c.label}
                  <span
                    className={cx(
                      "rounded-[9px] px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums",
                      on ? "bg-surface text-brand-deep" : "bg-divider text-body",
                    )}
                  >
                    {counts[c.key]}
                  </span>
                </button>
              );
            })
          : null}
      </div>

      {shown.length === 0 ? (
        <div className="px-5 py-8 text-center text-[13px] text-muted">
          {rows.length === 0 ? "Nothing due today and nothing overdue." : "Nothing of this kind."}
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {shown.map((r) => {
            const href = leadHref(workspace, `leads/${r.customerId}`);
            return (
              <li
                key={r.customerId}
                className="grid grid-cols-[34px_minmax(0,1.7fr)_auto_minmax(0,1.3fr)_auto_auto] items-center gap-3 border-b border-divider px-[18px] py-3 hover:bg-canvas"
              >
                <span
                  aria-hidden="true"
                  className="flex size-[34px] items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand-deep"
                >
                  {initials(r.name)}
                </span>
                <Link href={href} className="min-w-0 text-ink no-underline hover:text-ink hover:no-underline">
                  <span className="block truncate font-semibold">{r.name}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {[r.city, r.ownerName ?? "Nobody named"].filter(Boolean).join(" · ")}
                  </span>
                </Link>
                <span className="min-w-0">
                  <Pill tone="brand">{r.parkedBack ? "On hold" : stageLabel(r.stage)}</Pill>
                </span>
                <span className="min-w-0 truncate text-[13px] text-body" title={r.action ?? undefined}>
                  {r.action ?? "No action written down"}
                  {r.overdue && r.actionDate ? (
                    <span className="text-muted"> · {shortDate(r.actionDate)}</span>
                  ) : null}
                </span>
                <span>
                  <Due row={r} />
                </span>
                <span className="flex justify-end gap-1.5">
                  {/* Call opens the record with the call dialog up; the record decides
                      whether a call can be logged there. */}
                  <Link href={`${href}?call=1`} className={ROW_BTN}>
                    Call
                  </Link>
                  <Link href={href} className={ROW_BTN}>
                    Open
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {total > 0 ? (
        <div className="px-[18px] py-3 text-[13px]">
          {/* The list's own overdue / due view — All Leads is what this screen is gated on. */}
          <Link href={`${leadHref(workspace, "leads")}?view=${overdueTotal > 0 ? "overdue" : "today"}`}>
            All {total}
          </Link>
        </div>
      ) : null}
    </section>
  );
}
