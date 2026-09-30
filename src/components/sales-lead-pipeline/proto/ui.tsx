import * as React from "react";
import Link from "next/link";

import { cx } from "@/components/ui/primitives";
import { STAGE_LABEL } from "@/lib/sales-lead-pipeline/reference";
import type { Priority, SalesType, Stage } from "@/lib/sales-lead-pipeline/types";

/* ---------------------------------------------------------------------------
 * THE SALES MANAGER PROTOTYPE'S OWN LOOK, for the CRM workspace only.
 *
 * The screens in `components/sales-lead-pipeline` draw with the CRM's shared
 * primitives, which are right for the CRM and are not the prototype: its cards
 * are 8px with a shadow, its metric strip is a row of connected cells with a
 * monospace figure, its badges are 20px and 4px-radius. These are the
 * prototype's numbers, kept in ONE file so the four screens that use them
 * cannot each round them differently.
 *
 * They are used ONLY by the CRM's mounting (`workspace="crm"`). The Sales
 * Dashboard's `/sales-lead-pipeline` goes on drawing with the shared
 * primitives, untouched.
 *
 * Pure markup, no hooks: everything here renders on the server.
 * ------------------------------------------------------------------------- */

/** The prototype's font stack — the CRM's own is Google Sans Flex. */
export const PROTO_FONT = '-apple-system, "Segoe UI", system-ui, sans-serif';

const SHADOW = "shadow-[0_1px_2px_rgba(22,22,22,0.06)]";

export function PCard({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx("rounded-lg border border-line bg-surface", SHADOW, className)}>
      {children}
    </div>
  );
}

/** `.page` — 1360 wide, 22/26 padding. */
export function PPage({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  return (
    <div className={cx("mx-auto w-full px-[26px] pt-[22px] pb-[60px]", narrow ? "max-w-[1080px]" : "max-w-[1360px]")}>
      {children}
    </div>
  );
}

export function PEyebrow({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] font-semibold tracking-[0.06em] text-muted uppercase">{children}</div>;
}

/** `.page-head` — title 24/30/650, subtitle 13px, actions to the right. */
export function PPageHead({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-[18px] flex items-start justify-between gap-4">
      <div>
        {eyebrow ? <PEyebrow>{eyebrow}</PEyebrow> : null}
        <h1 className="m-0 text-[24px] leading-[30px] font-[650] text-ink">{title}</h1>
        {sub ? <p className="mt-[3px] mb-0 max-w-[640px] text-[13px] leading-5 text-muted">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PSectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("mb-[9px] text-[11px] font-[650] tracking-[0.05em] text-muted uppercase", className)}>{children}</div>
  );
}

/* ------------------------------------------------------------------ buttons */

const BTN =
  "inline-flex items-center justify-center gap-[7px] rounded-[4px] border text-[13.5px] font-[550] whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-55";
const BTN_VARIANT = {
  primary: "border-brand bg-brand text-white hover:border-brand-hover hover:bg-brand-hover",
  secondary: "border-line-strong bg-surface text-body hover:bg-canvas",
  ghost: "border-line bg-surface text-body hover:bg-canvas",
} as const;

export function pbtn(variant: keyof typeof BTN_VARIANT = "secondary", small = false) {
  return cx(BTN, BTN_VARIANT[variant], small ? "h-[29px] px-2.5 text-[12.5px]" : "h-[34px] px-3.5");
}

/* ------------------------------------------------------------------- badges */

export type PTone = "neutral" | "brand" | "success" | "warn" | "danger" | "muted";
const BADGE: Record<PTone, string> = {
  neutral: "bg-divider text-body",
  brand: "bg-brand-soft text-[#5223e0]",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn-ink",
  danger: "bg-danger-soft text-danger",
  muted: "border border-line bg-canvas text-muted",
};

export function PBadge({ tone = "neutral", children, className }: { tone?: PTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex h-5 items-center gap-1 rounded-[4px] px-[7px] text-[11px] font-semibold whitespace-nowrap", BADGE[tone], className)}>
      {children}
    </span>
  );
}

export function stageTone(stage: Stage | string): PTone {
  if (["customer", "second_order", "active_distributor", "won"].includes(stage)) return "success";
  if (["negotiation", "first_order", "distributor_agreement", "initial_stock_order"].includes(stage)) return "brand";
  if (
    ["qualification", "qualified", "sample_trial", "sample_received", "sample_review", "management_review", "commercial_discussion", "distributor_approval"].includes(stage)
  )
    return "warn";
  return "neutral";
}

export function PStageBadge({ stage }: { stage: Stage | null }) {
  if (!stage) return null;
  return <PBadge tone={stageTone(stage)}>{STAGE_LABEL[stage] ?? stage}</PBadge>;
}

export function PPriorityBadge({ priority }: { priority: Priority }) {
  if (!priority) return null;
  const tone: PTone = priority === "high" ? "danger" : priority === "medium" ? "warn" : "neutral";
  return <PBadge tone={tone}>{priority === "high" ? "High" : priority === "medium" ? "Medium" : "Low"}</PBadge>;
}

export function PSalesTypeBadge({ salesType }: { salesType: SalesType | null }) {
  const label = salesType === "distributor" ? "Distributor" : salesType === "third_party" ? "Third-Party" : salesType === "direct" ? "Direct" : "Not set";
  return <PBadge tone={salesType ? "neutral" : "muted"}>{label}</PBadge>;
}

/* ------------------------------------------------------------- metric strip */

export type PMetric = {
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "warn" | "success";
  href?: string;
};

const VALUE_TONE = { danger: "text-danger", warn: "text-warn-ink", success: "text-success" } as const;

/** `.metric-strip` — connected equal cells, dividers, hover, a 23px monospace figure. */
export function PMetricStrip({ metrics }: { metrics: PMetric[] }) {
  return (
    <div className={cx("mb-4 flex flex-wrap overflow-hidden rounded-lg border border-line bg-surface", SHADOW)}>
      {metrics.map((m) => {
        const inner = (
          <>
            <div className="text-[10.5px] font-[650] tracking-[0.05em] whitespace-nowrap text-muted uppercase">{m.label}</div>
            <div className={cx("mt-[3px] font-mono text-[23px] leading-7 font-[650]", m.tone ? VALUE_TONE[m.tone] : "text-ink")}>{m.value}</div>
            {m.sub ? <div className="mt-px text-[11.5px] whitespace-nowrap text-muted">{m.sub}</div> : null}
          </>
        );
        const cell = "min-w-[118px] flex-1 border-r border-divider px-[18px] py-3.5 text-left last:border-r-0";
        return m.href ? (
          <Link key={m.label} href={m.href} className={cx(cell, "cursor-pointer transition-colors hover:bg-canvas")}>
            {inner}
          </Link>
        ) : (
          <div key={m.label} className={cell}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- empty state */

export function PEmpty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-5 py-11 text-center">
      <div className="text-[15px] font-[650] text-ink">{title}</div>
      {body ? <div className="mx-auto mt-[5px] max-w-[360px] text-[13px] text-muted">{body}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------- stage funnel */

/** The prototype's `funnelColor`: green once won, purple in the deal, amber while qualifying, grey before. */
export function funnelColor(stage: string): string {
  if (["customer", "second_order"].includes(stage)) return "#1d7a45";
  if (["negotiation", "first_order"].includes(stage)) return "#6835fb";
  if (["qualification", "sample_trial", "sample_received", "sample_review"].includes(stage)) return "#b77b08";
  return "#8890a0";
}

export type FunnelBarData = { stage: string; label: string; count: number; href: string };

/**
 * `.funnel-wrap` — a bar per stage, its count in white INSIDE it, the stage
 * name beneath. `height` is the tallest a bar may be (44 on the dashboard, 64
 * on the pipeline); a bar is never shorter than 22 so an empty stage is still
 * a thing to point at.
 */
export function PFunnel({ bars, height }: { bars: FunnelBarData[]; height: number }) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <>
      <div className="flex items-stretch gap-[3px]">
        {bars.map((b) => {
          const h = Math.max(22, Math.round((b.count / max) * height) + 16);
          return (
            <Link
              key={b.stage}
              href={b.href}
              className="flex min-w-0 flex-1 flex-col justify-end rounded-t-[4px] transition hover:brightness-95"
              style={{ height: height + 18 }}
            >
              <div className="flex-1" />
              <div
                className="flex items-start justify-center rounded-t-[4px] pt-1.5"
                style={{ background: funnelColor(b.stage), height: h }}
              >
                <span className="font-mono text-[15px] leading-none font-bold text-white">{b.count}</span>
              </div>
            </Link>
          );
        })}
      </div>
      <div className="mt-2 flex gap-[3px]">
        {bars.map((b) => (
          <div
            key={b.stage}
            className="min-w-0 flex-1 overflow-hidden px-0.5 text-center text-[10.5px] font-semibold tracking-[0.02em] text-ellipsis whitespace-nowrap text-muted uppercase"
          >
            {b.label}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * A bar and the list it opens must agree, so the legacy rungs folded into a bar
 * ride the same `stage=` list — otherwise the bar says 40 and the list 12.
 */
export function stageFilter(stage: string): string {
  return stage === "suspect"
    ? "suspect,new"
    : stage === "prospect"
      ? "prospect,contacted"
      : stage === "qualification"
        ? "qualification,qualified"
        : stage === "customer"
          ? "customer,won"
          : stage;
}

/* --------------------------------------------------------------- small helpers */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-18` → `18 Sep`, the prototype's `fmtDate`. Anything else is returned as it came. */
export function fmtDay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "—";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
}

/**
 * The prototype's `roleAction(lead, "sales_manager")` — the short verb a
 * Sales Manager reads for a lead at a rung. Wording and tone are the
 * prototype's; the rung is the real one.
 */
export function managerAction(stage: Stage | null, hasCommitment?: boolean): { label: string; tone: PTone } {
  switch (stage) {
    case "prospect":
    case "contacted":
      return { label: "Verify prospect", tone: "warn" };
    case "qualification":
    case "qualified":
      return { label: "Review qualification", tone: "warn" };
    case "sample_received":
    case "sample_review":
      return { label: "Review sample / trial", tone: "warn" };
    case "negotiation":
      return hasCommitment ? { label: "Confirm actual order", tone: "danger" } : { label: "Support negotiation", tone: "brand" };
    case "first_order":
      return { label: "Monitor delivery", tone: "muted" };
    case "payment":
      return { label: "Monitor payment follow-up", tone: "muted" };
    case "second_order":
      return { label: "Repeat-order call", tone: "brand" };
    case "management_review":
      return { label: "Prepare for management review", tone: "warn" };
    default:
      return { label: "Monitor", tone: "muted" };
  }
}
