"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * The pieces every Sales Dashboard screen is built from.
 *
 * Deliberately the Accounts app's visual language rather than a second one:
 * both are office screens read at a desk by somebody scanning a list, and two
 * different tables in one product is how a company ends up with two products.
 * They are a separate file because they are a separate app — Accounts' own
 * parts carry an aging strip and a pager that mean nothing here.
 * ------------------------------------------------------------------------- */

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
        {/*
          24/30, which is what the design uses on 23 of its 24 screens. It was
          28/34 here — a size the design uses nowhere. Today's greeting is the
          one exception at 26/32, and it sets its own; the console has one
          heading size and this is it.
        */}
        <h1 className="text-2xl leading-[30px] font-semibold text-ink">{title}</h1>
        {subtitle ? (
          <p className="mt-1 max-w-[760px] text-[13px] leading-[18px] text-pretty text-muted">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-none gap-2">{actions}</div> : null}
    </div>
  );
}

export type Metric = {
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "warn" | "success";
};

/**
 * A row of figures, not cards. They mean something side by side — visits
 * against orders against money — and a grid of boxes puts a border between
 * numbers that only read together.
 */
export function MetricRow({ metrics }: { metrics: Metric[] }) {
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

export function Banner({
  tone,
  title,
  body,
  action,
}: {
  tone: "warn" | "danger" | "info";
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const skin = {
    warn: "border-warn bg-warn-soft",
    danger: "border-danger bg-danger-soft",
    info: "border-line bg-surface",
  }[tone];

  return (
    <div
      className={cx(
        "mb-4 flex items-start justify-between gap-4 rounded-[6px] border-l-[3px] px-4 py-3",
        skin,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-ink">{title}</div>
        {body ? <div className="mt-0.5 text-[13px] text-pretty text-body">{body}</div> : null}
      </div>
      {action ? <div className="flex-none">{action}</div> : null}
    </div>
  );
}

/**
 * The design's filter row: chips, one of them on.
 *
 * They are links rather than buttons because each is a different view of the
 * same screen and deserves its own URL — a manager who has filtered to what is
 * overdue should be able to send that to somebody.
 */
export function FilterChips({
  options,
  current,
}: {
  /*
   * Each option carries its own href rather than the row taking a function to
   * build one. A function cannot be passed from a server component to a client
   * one — and a link is data, not behaviour.
   */
  options: Array<{ key: string; label: string; href: string; count?: number }>;
  current: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      {options.map((o) => {
        const on = o.key === current;
        return (
          <a
            key={o.key}
            href={o.href}
            className={cx(
              "inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[13px] whitespace-nowrap no-underline hover:no-underline",
              on
                ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            {o.label}
            {o.count != null ? (
              <span className={cx("tabular-nums", on ? "" : "text-muted")}>{o.count}</span>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- table */

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
    <div className="min-w-0 overflow-auto rounded-[6px] border border-line bg-surface">
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
  title,
  children,
}: {
  align?: "left" | "right";
  className?: string;
  colSpan?: number;
  truncate?: number;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <td
      colSpan={colSpan}
      title={title ?? (truncate && typeof children === "string" ? children : undefined)}
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
        "border-b border-divider border-l-[3px] last:border-b-0",
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

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
      <div className="text-lg font-semibold text-ink">{title}</div>
      <p className="mx-auto mt-1.5 max-w-[480px] text-[15px] text-pretty text-muted">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ buttons */

export function Button({
  tone = "default",
  size = "md",
  type = "button",
  disabled,
  title,
  onClick,
  children,
}: {
  /**
   * The four the design actually draws, plus `strong`.
   *
   * `default` and `strong` are both white buttons and differ only in border —
   * #DDE1E8 for the ordinary one that sits beside a table, #C2C8D2 for the one
   * that sits in a page header next to a primary and has to hold its own
   * against it. The design uses each ten and four times respectively; reading
   * them as one control lost the distinction on every header.
   */
  tone?: "default" | "strong" | "primary" | "danger" | "quiet";
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  /** Always present on a disabled control — a dead button has to say why. */
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const skin = {
    default: "border border-line bg-surface text-body hover:bg-canvas",
    strong: "border border-line-strong bg-surface text-body hover:bg-canvas",
    /*
     * A border of its OWN colour, not a transparent one — the design draws
     * `1px solid #6835FB` on the fill, so a primary and the secondary beside it
     * are the same height to the pixel. A transparent border is the same box
     * model, so this is about the hover: fading the whole control to 90% takes
     * the white label with it. The design darkens the fill and leaves the text
     * alone.
     */
    primary: "border border-brand bg-brand text-white hover:bg-brand-hover",
    danger: "border border-danger bg-surface text-danger hover:bg-danger-soft",
    quiet: "border border-transparent bg-transparent text-muted hover:bg-canvas hover:text-body",
  }[tone];

  /*
   * A primary is wider than a secondary at the same height — 16px against 14px
   * — because a filled button needs more room around its label to read as
   * deliberate. Both were 12px here, which is the design's SMALL padding.
   */
  const pad = size === "sm" ? "px-3" : tone === "primary" ? "px-4" : "px-3.5";

  return (
    <button
      type={type}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cx(
        "inline-flex flex-none cursor-pointer items-center justify-center gap-1.5 rounded-[4px] font-medium whitespace-nowrap transition-colors duration-100",
        // 36px and 30px, the design's two heights. They were 34 and 28.
        size === "sm" ? "h-[30px] text-[13px]" : "h-9 text-sm",
        pad,
        skin,
        disabled ? "cursor-not-allowed opacity-50" : "",
      )}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- wording */

/*
 * Re-exported from `words.ts`, which is NOT a client module.
 *
 * They used to be defined here, and a server component calling one got
 * "Attempted to call plural() from the server" — a 500 at request time that no
 * type check sees. Server screens should import from `../words` directly;
 * these keep the client screens that already import them working.
 */
export {
  plural,
  waitingWords,
  label,
  APPROVAL_LABEL,
  VISIT_OUTCOME_LABEL,
  LEAVE_LABEL,
} from "./words";
