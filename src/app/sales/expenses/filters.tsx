"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import {
  PERIOD_KINDS,
  periodQuery,
  readPeriod,
  stepPeriod,
  type ExpensePeriod,
  type PeriodKind,
} from "@/lib/expense-period";
import { hrefWith, type Query } from "./query";

/* ---------------------------------------------------------------------------
 * The Expenses screens' controls: the PERIOD in the header, and the FILTERS
 * above the table. Both are the URL — a narrowing somebody can send — and both
 * keep every other parameter on the address when they change one, so picking
 * a week does not drop the salesman somebody had chosen, and vice versa.
 * ------------------------------------------------------------------------- */

/** The period keys, cleared, so a new period never inherits the old one's. */
const NO_PERIOD: Query = {
  period: undefined,
  on: undefined,
  from: undefined,
  to: undefined,
  month: undefined,
};

const box =
  "h-[30px] rounded-[4px] border border-line bg-surface px-2 text-[13px] text-body outline-none focus:border-brand";

/**
 * Day · Week · Month · Range · All time, with arrows to step and a box to
 * jump. `query` is the page's other parameters (filters, tab, sort), kept.
 */
export function PeriodPicker({
  period,
  today,
  basePath,
  query,
}: {
  period: ExpensePeriod;
  today: string;
  basePath: string;
  query: Query;
}) {
  const router = useRouter();
  const [from, setFrom] = React.useState(period.from ?? today);
  const [to, setTo] = React.useState(period.to ?? today);
  const go = (p: ExpensePeriod) =>
    router.push(hrefWith(basePath, query, { ...NO_PERIOD, ...periodQuery(p) }));
  /* Switching kind keeps the reader where they were looking: today if today is
     inside the current period, else the period's first day. */
  const anchor =
    period.from && period.to && today >= period.from && today <= period.to
      ? today
      : (period.from ?? today);
  const pick = (kind: PeriodKind) => {
    if (kind === "range") {
      go(
        readPeriod(
          {
            period: "range",
            from: period.from ?? today,
            to: period.to ?? today,
          },
          today,
        ),
      );
    } else {
      go(readPeriod({ period: kind, on: anchor }, today));
    }
  };
  const prev = stepPeriod(period, -1);
  const next = stepPeriod(period, 1);
  const arrow =
    "inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div
        className="flex rounded-[4px] border border-line bg-surface p-0.5"
        role="tablist"
        aria-label="Period"
      >
        {PERIOD_KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            role="tab"
            aria-selected={period.kind === k.key}
            onClick={() => pick(k.key)}
            className={cx(
              "h-[26px] cursor-pointer rounded-[3px] px-2.5 text-[12px] whitespace-nowrap",
              period.kind === k.key
                ? "bg-brand-soft font-medium text-brand"
                : "text-muted hover:text-body",
            )}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {prev ? (
          <Link
            href={hrefWith(basePath, query, {
              ...NO_PERIOD,
              ...periodQuery(prev),
            })}
            className={arrow}
            title="Earlier"
          >
            ←
          </Link>
        ) : null}
        {period.kind === "day" || period.kind === "week" ? (
          <input
            type="date"
            value={period.on}
            onChange={(e) =>
              e.target.value &&
              go(readPeriod({ period: period.kind, on: e.target.value }, today))
            }
            aria-label={period.kind === "week" ? "Any day in the week" : "Day"}
            title={
              period.kind === "week" ? "Pick any day in the week" : "Pick a day"
            }
            className={box}
          />
        ) : null}
        {period.kind === "month" ? (
          <input
            type="month"
            value={period.on.slice(0, 7)}
            onChange={(e) =>
              e.target.value &&
              go(
                readPeriod(
                  { period: "month", on: `${e.target.value}-01` },
                  today,
                ),
              )
            }
            aria-label="Month"
            className={box}
          />
        ) : null}
        {period.kind === "range" ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              go(readPeriod({ period: "range", from, to }, today));
            }}
          >
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="From"
              className={box}
            />
            <span className="text-[12px] text-muted">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="To"
              className={box}
            />
            <button
              type="submit"
              className="h-[30px] cursor-pointer rounded-[4px] border border-brand bg-brand px-3 text-[12px] font-medium text-white hover:bg-brand-hover"
            >
              Apply
            </button>
          </form>
        ) : null}
        {next ? (
          <Link
            href={hrefWith(basePath, query, {
              ...NO_PERIOD,
              ...periodQuery(next),
            })}
            className={arrow}
            title="Later"
          >
            →
          </Link>
        ) : null}
      </div>
      <span className="text-[12px] text-muted">{period.label}</span>
    </div>
  );
}

export type FilterSpec = {
  /** The URL parameter. */
  param: string;
  /** What the select says when nothing is picked. */
  all: string;
  /** Accessible name. */
  label: string;
  value: string;
  options: { value: string; label: string }[];
};

/**
 * The filter row above a table: one select per filter and a way to clear them.
 * Changing a filter resets `page` and keeps everything else.
 */
export function FilterRow({
  basePath,
  query,
  filters,
  search,
  children,
}: {
  basePath: string;
  query: Query;
  filters: FilterSpec[];
  /** A free-text search on `q`, where the screen offers one. */
  search?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(query.q ?? "");
  const on = filters.filter((f) => f.value);
  const clear = [...on.map((f) => f.param), ...(query.q ? ["q"] : [])];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {search ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            router.push(
              hrefWith(basePath, query, { q: q.trim(), page: undefined }),
            );
          }}
        >
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={search}
            aria-label={search}
            className={cx(box, "w-[220px]")}
          />
        </form>
      ) : null}
      {filters.map((f) => (
        <select
          key={f.param}
          value={f.value}
          aria-label={f.label}
          title={f.label}
          onChange={(e) =>
            router.push(
              hrefWith(basePath, query, {
                [f.param]: e.target.value,
                page: undefined,
              }),
            )
          }
          className={cx(
            box,
            "max-w-[220px] cursor-pointer pr-6",
            f.value ? "border-brand text-ink" : "",
          )}
        >
          <option value="">{f.all}</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ))}
      {children}
      {clear.length ? (
        <Link
          href={hrefWith(
            basePath,
            query,
            Object.fromEntries(clear.map((k) => [k, undefined])),
          )}
          className="text-[13px] font-medium"
        >
          Clear {clear.length === 1 ? "filter" : `${clear.length} filters`}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Jump to another salesman's statement, keeping the period. Offers only the
 * people with an expense on the book — the same list the salesman filter does.
 */
export function PersonSwitch({
  people,
  current,
  query,
}: {
  people: { id: string; name: string }[];
  current: string;
  query: Query;
}) {
  const router = useRouter();
  return (
    <select
      value={current}
      aria-label="Salesman"
      title="Switch salesman"
      onChange={(e) =>
        router.push(hrefWith(`/sales/expenses/ledger/${e.target.value}`, query))
      }
      className={cx(
        box,
        "max-w-[220px] cursor-pointer pr-6 font-medium text-ink",
      )}
    >
      {people.some((p) => p.id === current) ? null : (
        <option value={current}>—</option>
      )}
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
