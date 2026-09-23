"use client";

/* ---------------------------------------------------------------------------
 * A MODAL THE SIZE OF THE WORK.
 *
 * The house `Modal` caps its body at 62% of the screen, which is right for a
 * form of six fields and wrong for a grid of forty products by eight pack
 * sizes, or for ten PDFs being read side by side. Those are still one task
 * the person should finish without losing their place on the page behind, so
 * they are still a modal — just one that takes the room the task needs.
 *
 * Escape and the backdrop go through `onRequestClose`, never straight to a
 * close: a workspace holds unsaved work, and the caller decides whether that
 * needs a question first.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { cx } from "@/components/ui/primitives";

export function WorkspaceModal({
  title,
  subtitle,
  badge,
  actions,
  tabs,
  footer,
  onRequestClose,
  children,
  maxWidth = 1360,
  bodyClassName,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  /** Right-hand side of the header, before the close button. */
  actions?: React.ReactNode;
  /** A strip under the header — tabs or steps. */
  tabs?: React.ReactNode;
  footer?: React.ReactNode;
  onRequestClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
  bodyClassName?: string;
}) {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog opened on top of this one owns the Escape key; closing the
      // workspace underneath it would throw away the work to dismiss a picker.
      if (document.querySelectorAll('[role="dialog"]').length > 1) return;
      onRequestClose();
    };
    window.addEventListener("keydown", handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = previous;
    };
  }, [onRequestClose]);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(22,22,22,0.42)] p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onRequestClose();
      }}
    >
      <div
        style={{ maxWidth }}
        className="flex h-[94vh] w-full flex-col overflow-hidden rounded-[8px] bg-surface whitespace-normal shadow-[0_16px_48px_rgba(22,22,22,0.22)]"
      >
        <div className="flex flex-none items-start justify-between gap-4 border-b border-divider px-5 pt-4 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="truncate text-lg font-semibold text-ink">{title}</h2>
              {badge}
            </div>
            {subtitle ? <div className="mt-0.5 text-[13px] text-muted">{subtitle}</div> : null}
          </div>
          <div className="flex flex-none items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onRequestClose}
              aria-label="Close"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        {tabs ? <div className="flex-none px-5">{tabs}</div> : null}
        <div className={cx("min-h-0 flex-1 overflow-auto", bodyClassName ?? "px-5 py-4")}>{children}</div>
        {footer ? (
          <div className="flex flex-none flex-wrap items-center justify-between gap-2.5 border-t border-divider bg-canvas/60 px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Numbered steps across the top of a workspace — "1 Details · 2 Rates · 3 Terms". */
export function StepTabs<T extends string>({
  steps,
  value,
  onChange,
}: {
  steps: Array<{ key: T; label: string; hint?: string; tone?: "ok" | "warn" | "block" | null }>;
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="-mb-px flex items-center gap-1 overflow-x-auto" role="tablist">
      {steps.map((s, i) => {
        const active = s.key === value;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s.key)}
            title={s.hint}
            className={cx(
              "flex cursor-pointer items-center gap-2 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap",
              active ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-body",
            )}
          >
            <span
              className={cx(
                "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                active ? "bg-brand text-white" : "bg-divider text-body",
              )}
            >
              {i + 1}
            </span>
            {s.label}
            {s.tone ? (
              <span
                className={cx(
                  "h-1.5 w-1.5 rounded-full",
                  s.tone === "ok" ? "bg-success" : s.tone === "warn" ? "bg-warn" : "bg-danger",
                )}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
