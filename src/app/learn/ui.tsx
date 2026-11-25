import type { ReactNode } from "react";
import { cx } from "@/components/ui/primitives";
import { MODULE_STATE_LABEL, type ModuleState } from "@/lib/training/types";

/* ---------------------------------------------------------------------------
 * The Training app's small parts — pure, usable from server and client
 * components alike. The palette is MahekOne's tokens; the sizes are a
 * phone's: every tap target is at least 44px.
 * ------------------------------------------------------------------------- */

export type LearnTone = "success" | "danger" | "warn" | "info" | "brand" | "muted";

const TONE: Record<LearnTone, string> = {
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warn: "bg-warn-soft text-warn-ink",
  info: "bg-info-soft text-info",
  brand: "bg-brand-soft text-brand-hover",
  muted: "bg-divider text-body",
};

export function LPill({ tone = "muted", children, className }: { tone?: LearnTone; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex h-5 items-center rounded-[10px] px-2 text-[11px] font-medium whitespace-nowrap", TONE[tone], className)}>{children}</span>;
}

export const STATE_TONE: Record<ModuleState, LearnTone> = {
  locked: "muted",
  available: "info",
  in_progress: "info",
  assessment_pending: "warn",
  passed: "success",
  retraining_required: "danger",
  retake_open: "warn",
};

export function StatePill({ state, score }: { state: ModuleState; score?: number | null }) {
  const label = state === "passed" && score != null ? `Passed ${score}%` : state === "retake_open" ? "Retake open" : MODULE_STATE_LABEL[state];
  return <LPill tone={STATE_TONE[state]}>{label}</LPill>;
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-xs font-medium tracking-label text-muted uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Bar({ percent }: { percent: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-divider" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[8px] border border-dashed border-line bg-surface px-5 py-10 text-center">
      <div className="text-[15px] font-semibold text-heading">{title}</div>
      {children ? <div className="mt-1.5 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export const learnBtn = (kind: "primary" | "secondary" = "primary", disabled = false) =>
  cx(
    "inline-flex min-h-12 items-center justify-center gap-2 rounded-[6px] border px-4 text-[15px] font-medium no-underline hover:no-underline",
    disabled ? "cursor-not-allowed border-divider bg-canvas text-muted" : kind === "primary" ? "cursor-pointer border-transparent bg-brand text-white hover:bg-brand-hover" : "cursor-pointer border-line-strong bg-surface text-body hover:bg-canvas",
  );
