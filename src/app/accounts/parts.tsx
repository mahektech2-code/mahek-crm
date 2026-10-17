"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { money } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * The pieces every Accounts screen is built from.
 *
 * Four screens carry a metric row, five carry a paged table, two carry the
 * aging strip. They were the same three components drawn slightly differently
 * each time in the design; here they are the same three components.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------ header */

export function ScreenHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-[34px] font-semibold text-ink">{title}</h1>
        {subtitle ? (
          <p className="mt-1 max-w-[720px] text-[13px] leading-[18px] text-pretty text-muted">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-none gap-2 print:hidden">{actions}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- metrics */

export type AccountsMetric = {
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "warn" | "success";
};

/**
 * A row of figures, not cards. Accounts read these together — waiting against
 * value against how stale — and a grid of boxes puts a border between numbers
 * that only mean something side by side.
 */
export function MetricRow({ metrics }: { metrics: AccountsMetric[] }) {
  return (
    <div className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 rounded-[6px] border border-line bg-surface px-5 py-3.5">
      {metrics.map((m) => (
        <span key={m.label} className="block">
          <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            {m.label}
          </span>
          <span
            className={cx(
              "block text-[22px] leading-7 font-semibold whitespace-nowrap tabular-nums",
              m.tone === "danger"
                ? "text-danger"
                : m.tone === "warn"
                  ? "text-warn-ink"
                  : m.tone === "success"
                    ? "text-success"
                    : "text-ink",
            )}
          >
            {m.value}
          </span>
          {m.sub ? (
            <span className="block text-xs whitespace-nowrap text-muted">{m.sub}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ banners */

export function Banner({
  tone,
  title,
  children,
  action,
}: {
  tone: "danger" | "warn" | "success" | "neutral";
  title?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const skin =
    tone === "danger"
      ? "border-danger-soft bg-danger-soft border-l-danger"
      : tone === "warn"
        ? "border-warn-line bg-warn-soft border-l-warn"
        : tone === "success"
          ? "border-success-soft bg-success-soft border-l-success"
          : "border-line bg-surface border-l-line-strong";

  return (
    <div
      className={cx(
        "mb-4 flex items-center gap-3 rounded-[4px] border border-l-[3px] px-4 py-3",
        skin,
      )}
    >
      <div className="min-w-0 flex-1">
        {title ? (
          <div
            className={cx(
              "text-sm font-medium",
              tone === "danger"
                ? "text-danger"
                : tone === "warn"
                  ? "text-warn-ink"
                  : tone === "success"
                    ? "text-success"
                    : "text-ink",
            )}
          >
            {title}
          </div>
        ) : null}
        <div
          className={cx(
            "text-sm text-pretty",
            tone === "warn" ? "text-body" : "text-ink",
            title ? "mt-0.5" : "",
          )}
        >
          {children}
        </div>
      </div>
      {action ? <div className="flex-none">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------- aging strip */

export type Bucket = { label: string; amount: number; from: number };

/** Oldest debt is darkest. Five steps, and the last one is nearly black-red. */
const BUCKET_COLOUR = ["#C2C8D2", "#DDE1E8", "#B77B08", "#B3261E", "#8A1C16"];

export function AgingStrip({ buckets }: { buckets: Bucket[] }) {
  const total = buckets.reduce((a, b) => a + b.amount, 0);

  if (total <= 0) {
    return (
      <p className="text-[13px] text-muted">
        Nothing is open. Every bill raised has been settled.
      </p>
    );
  }

  return (
    <>
      <div className="flex h-2.5 w-full overflow-hidden rounded-[2px] bg-divider">
        {buckets.map((b, i) => (
          <span
            key={b.label}
            title={`${b.label} — ${money(b.amount)}`}
            style={{
              width: `${(b.amount / total) * 100}%`,
              background: BUCKET_COLOUR[Math.min(i, BUCKET_COLOUR.length - 1)],
            }}
            className="block"
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {buckets.map((b, i) => (
          <span
            key={b.label}
            className="flex items-center text-[13px] whitespace-nowrap text-body"
          >
            <span
              style={{ background: BUCKET_COLOUR[Math.min(i, BUCKET_COLOUR.length - 1)] }}
              className="mr-1.5 block h-2 w-2 flex-none rounded-full"
            />
            {b.label}
            <span className="ml-1.5 font-medium tabular-nums text-ink">
              {money(b.amount)}
            </span>
          </span>
        ))}
      </div>
    </>
  );
}

/* `Pager` lives in `@/components/ui/pager` now — the Sales Dashboard pages
   its own tables with the same control, and two copies of a pager is two
   places for "Showing 1-25 of 300" to start disagreeing with the rows
   underneath it. */
export { Pager } from "@/components/ui/pager";

/* -------------------------------------------------------------- table skin */

/**
 * The Accounts table.
 *
 * Zebra striping and a sticky head, because these are read across — a bill
 * number on the left has to stay attached to a balance on the right through
 * forty rows — which is exactly where the CRM's airier table stops working.
 */
export function Table({
  minWidth,
  head,
  children,
}: {
  minWidth: number;
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-auto">
      <table style={{ minWidth }} className="w-full border-collapse">
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function HeadCell({
  align = "left",
  width,
  children,
}: {
  align?: "left" | "right";
  width?: number;
  children?: React.ReactNode;
}) {
  return (
    <th
      style={width ? { width, minWidth: width } : undefined}
      className={cx(
        "sticky top-0 z-2 h-8.5 border-b border-line bg-canvas px-4 text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Cell({
  align = "left",
  className,
  colSpan,
  truncate,
  children,
}: {
  align?: "left" | "right";
  className?: string;
  colSpan?: number;
  /**
   * Pixels. A customer name runs to forty characters here — long enough to
   * push the columns that carry the money off the right-hand edge, which is
   * how a ledger ends up with its status hidden behind a scrollbar. Capped and
   * ellipsised, with the full name on the title.
   */
  truncate?: number;
  children?: React.ReactNode;
}) {
  return (
    <td
      colSpan={colSpan}
      title={truncate && typeof children === "string" ? children : undefined}
      style={truncate ? { maxWidth: truncate, width: truncate } : undefined}
      className={cx(
        "px-4 py-2.5 align-middle text-sm whitespace-nowrap text-body",
        align === "right" ? "text-right tabular-nums" : "text-left",
        truncate ? "overflow-hidden text-ellipsis" : "",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Row({
  striped,
  selected,
  onClick,
  children,
}: {
  striped: boolean;
  selected?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <tr
      onClick={onClick}
      className={cx(
        "border-b border-divider border-l-[3px]",
        selected
          ? "border-l-brand bg-brand-soft"
          : cx("border-l-transparent", striped ? "bg-canvas" : "bg-surface"),
        onClick ? "cursor-pointer" : "",
      )}
    >
      {children}
    </tr>
  );
}

/* ------------------------------------------------------------------ badges */

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "danger" | "warn" | "success" | "brand" | "neutral";
  children: React.ReactNode;
}) {
  const skin = {
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn-ink",
    success: "bg-success-soft text-success",
    brand: "bg-brand-soft text-[#5223E0]",
    neutral: "bg-divider text-body",
  }[tone];

  return (
    <span
      className={cx(
        "inline-flex items-center rounded-[9px] px-2 py-[3px] text-[11px] leading-[14px] font-medium tracking-[0.03em] whitespace-nowrap uppercase",
        skin,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ empty states */

export function Empty({
  icon,
  title,
  body,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
      {icon ? <div className="mb-3 flex justify-center">{icon}</div> : null}
      <div className="text-lg font-semibold text-ink">{title}</div>
      <p className="mx-auto mt-1.5 max-w-[460px] text-[15px] text-pretty text-muted">
        {body}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- wording */

/** Count, noun and verb agree at every value. Thresholds are configuration. */
export function plural(n: number, noun: string, pl?: string): string {
  return `${n} ${n === 1 ? noun : (pl ?? `${noun}s`)}`;
}

/** Waiting a day is worth saying out loud; waiting an hour is not. */
export function waitingWords(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h waiting`;
  const days = Math.floor(hours / 24);
  return `${plural(days, "day")} waiting`;
}

/** "Over 24 hours old" reads wrong past a day, and the threshold is settable. */
export function staleLabel(hours: number): string {
  return hours < 24
    ? `Over ${plural(hours, "hour")} old`
    : `Over ${plural(Math.round(hours / 24), "day")} old`;
}
