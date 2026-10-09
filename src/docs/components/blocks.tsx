import * as React from "react";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * The prose blocks every docs page is made of. Server components, no state.
 *
 * Each kind of callout means ONE thing, so a reader learns to scan for it:
 *
 *   note   — worth knowing, changes nothing
 *   rule   — a rule the system enforces; the text says what it refuses
 *   why    — the reason behind a rule (the owner's tab is mostly these)
 *   warn   — a mistake people actually make
 *   money  — touches what is owed, paid or credited; read twice
 *   live   — the value shown is read from this deployment's database
 * ------------------------------------------------------------------------- */

const CALLOUT = {
  note: { label: "Note", box: "border-info/25 bg-info-soft", mark: "bg-info", ink: "text-info" },
  rule: { label: "Rule", box: "border-brand-softer bg-brand-soft", mark: "bg-brand", ink: "text-brand-hover" },
  why: { label: "Why", box: "border-line bg-canvas", mark: "bg-ink", ink: "text-ink" },
  warn: { label: "Watch out", box: "border-warn-line bg-warn-soft", mark: "bg-warn", ink: "text-warn-ink" },
  money: { label: "Money", box: "border-success/25 bg-success-soft", mark: "bg-success", ink: "text-success" },
  live: { label: "Live", box: "border-ai-line bg-ai-soft", mark: "bg-ai-mid", ink: "text-ai" },
} as const;

export function Callout({
  kind = "note",
  title,
  children,
}: {
  kind?: keyof typeof CALLOUT;
  title?: string;
  children: React.ReactNode;
}) {
  const c = CALLOUT[kind];
  return (
    <aside className={cx("my-5 flex gap-3 rounded-[6px] border px-4 py-3", c.box)}>
      <span className={cx("mt-1 w-[3px] flex-none self-stretch rounded-full", c.mark)} />
      <div className="min-w-0 flex-1 text-[14px] leading-[22px] text-body [&>p]:my-1.5 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&_ul]:my-1.5">
        <div className={cx("mb-1 text-[11px] font-semibold tracking-[0.06em] uppercase", c.ink)}>
          {title ?? c.label}
        </div>
        {children}
      </div>
    </aside>
  );
}

/** A numbered procedure. Each <Step> is one thing a person does. */
export function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="docs-steps my-6 list-none pl-0 [counter-reset:step]">{children}</ol>;
}

export function Step({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <li className="relative mb-5 pl-11 [counter-increment:step] before:absolute before:top-0 before:left-0 before:flex before:h-7 before:w-7 before:items-center before:justify-center before:rounded-full before:bg-brand before:text-[13px] before:font-semibold before:text-white before:content-[counter(step)] after:absolute after:top-8 after:bottom-[-14px] after:left-[13px] after:w-px after:bg-line after:content-[''] last:after:hidden">
      <div className="pt-0.5 text-[15px] leading-[22px] font-semibold text-ink">{title}</div>
      {children ? (
        <div className="mt-1 text-[14px] leading-[22px] text-body [&>p]:my-1.5 [&_ul]:my-1.5">{children}</div>
      ) : null}
    </li>
  );
}

/** A keyboard key. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[4px] border border-line-strong border-b-2 bg-surface px-1.5 font-mono text-[12px] leading-none text-ink">
      {children}
    </kbd>
  );
}

/** A question somebody actually asks, and its answer. Closed until opened. */
export function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group my-2 rounded-[6px] border border-line bg-surface open:shadow-[0_1px_0_rgba(0,0,0,0.02)]">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-[14px] font-medium text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand-hover transition-transform group-open:rotate-45">
          +
        </span>
        {q}
      </summary>
      <div className="border-t border-divider px-4 py-3 pl-12 text-[14px] leading-[22px] text-body [&>p]:my-1.5 [&>p:first-child]:mt-0 [&_ul]:my-1.5">
        {children}
      </div>
    </details>
  );
}

/** Two or more cards side by side: options, readers, outcomes. */
export function Cards({ children, cols = 2 }: { children: React.ReactNode; cols?: 2 | 3 }) {
  return (
    <div className={cx("my-5 grid gap-3", cols === 3 ? "desk:grid-cols-3 grid-cols-1" : "desk:grid-cols-2 grid-cols-1")}>
      {children}
    </div>
  );
}

export function Card({
  title,
  tone = "neutral",
  children,
}: {
  title: string;
  tone?: "neutral" | "brand" | "success" | "warn" | "danger";
  children: React.ReactNode;
}) {
  const top = {
    neutral: "border-t-line-strong",
    brand: "border-t-brand",
    success: "border-t-success",
    warn: "border-t-warn",
    danger: "border-t-danger",
  }[tone];
  return (
    <div className={cx("rounded-[6px] border border-t-[3px] border-line bg-surface px-4 py-3", top)}>
      <div className="mb-1 text-[14px] font-semibold text-ink">{title}</div>
      <div className="text-[13px] leading-[20px] text-body [&>p]:my-1 [&_ul]:my-1 [&_ul]:pl-4">{children}</div>
    </div>
  );
}

/**
 * A rule as the system holds it: the condition, what happens, and — the part
 * that makes it a rule rather than a fact — what it refuses or outranks.
 */
export function Rule({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="my-4 scroll-mt-20 rounded-[6px] border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-divider px-4 py-2">
        <span className="rounded-[3px] bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em] text-brand-hover uppercase">
          Rule
        </span>
        <span className="text-[14px] font-semibold text-ink">{title}</span>
      </div>
      <div className="px-4 py-3 text-[14px] leading-[22px] text-body [&>p]:my-1.5 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&_ul]:my-1.5">
        {children}
      </div>
    </section>
  );
}

/** A small coloured word, the same tones the CRM itself draws. */
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "brand" | "success" | "warn" | "danger" | "info";
  children: React.ReactNode;
}) {
  const t = {
    neutral: "bg-canvas text-body border-line",
    brand: "bg-brand-soft text-brand-hover border-brand-softer",
    success: "bg-success-soft text-success border-success/20",
    warn: "bg-warn-soft text-warn-ink border-warn-line",
    danger: "bg-danger-soft text-danger border-danger/20",
    info: "bg-info-soft text-info border-info/20",
  }[tone];
  return (
    <span className={cx("inline-flex h-5 items-center rounded-[3px] border px-1.5 align-[1px] text-[11px] font-medium whitespace-nowrap", t)}>
      {children}
    </span>
  );
}
