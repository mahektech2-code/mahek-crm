"use client";

import type { ReactNode } from "react";
import { cx } from "@/components/ui/primitives";
import { Btn, Label, Pill } from "../../_ui/kit";

/* Small controls the studio's sections share. Disabled when read-only. */

export const inputCls =
  "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand disabled:border-line disabled:bg-canvas disabled:text-body";

export function Txt({ value, onChange, ro, placeholder, className }: { value: string; onChange: (v: string) => void; ro?: boolean; placeholder?: string; className?: string }) {
  return <input value={value} disabled={ro} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cx(inputCls, className)} />;
}

export function Num({
  value,
  onChange,
  ro,
  step = 1,
  className,
  allowNull,
  invalid,
  title,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  ro?: boolean;
  step?: number;
  className?: string;
  allowNull?: boolean;
  invalid?: boolean;
  title?: string;
}) {
  return (
    <input
      type="number"
      step={step}
      title={title}
      value={value == null ? "" : value}
      disabled={ro}
      placeholder={allowNull ? "no score" : undefined}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") onChange(allowNull ? null : 0);
        else onChange(Number(v));
      }}
      className={cx(inputCls, "tabular-nums", invalid && "border-danger bg-danger-soft", className)}
    />
  );
}

export function Area({ value, onChange, ro, rows = 2, placeholder }: { value: string; onChange: (v: string) => void; ro?: boolean; rows?: number; placeholder?: string }) {
  return (
    <textarea
      value={value}
      rows={rows}
      disabled={ro}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-[4px] border border-line-strong bg-surface px-2.5 py-2 text-sm leading-5 text-heading outline-none focus:border-brand disabled:border-line disabled:bg-canvas"
    />
  );
}

export function Sel<T extends string>({ value, onChange, ro, options, className }: { value: T; onChange: (v: T) => void; ro?: boolean; options: readonly (readonly [T, string])[]; className?: string }) {
  return (
    <select value={value} disabled={ro} onChange={(e) => onChange(e.target.value as T)} className={cx(inputCls, className)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function Check({ checked, onChange, ro, label }: { checked: boolean; onChange: (v: boolean) => void; ro?: boolean; label: ReactNode }) {
  return (
    <label className={cx("inline-flex items-center gap-2 text-sm text-body", ro ? "cursor-default" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={ro} onChange={(e) => onChange(e.target.checked)} className="h-[15px] w-[15px] accent-[#6835FB]" />
      {label}
    </label>
  );
}

export function F({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <Label className="mb-1">{label}</Label>
      {children}
    </label>
  );
}

/**
 * The head of one approvable element: the AI marker where AI drafted it, its
 * approval state, and the explicit Approve action. Indigo appears ONLY on the
 * marker — never on the button.
 */
export function ElementHead({ title, ai, approved, ro, onApprove, actions }: { title: ReactNode; ai: boolean; approved: boolean; ro: boolean; onApprove: () => void; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 text-sm font-medium text-heading">{title}</div>
      {ai ? <Pill tone="ai">◈ AI-drafted</Pill> : null}
      {approved ? <Pill tone="success">Approved</Pill> : <Pill tone="warn">Not approved</Pill>}
      {actions}
      {!approved && !ro ? (
        <Btn size="sm" kind="primary" onClick={onApprove}>
          Approve
        </Btn>
      ) : null}
    </div>
  );
}

export function Remove({ onClick, ro, label = "Remove" }: { onClick: () => void; ro: boolean; label?: string }) {
  if (ro) return null;
  return (
    <button onClick={onClick} title={label} className="h-[30px] cursor-pointer rounded-[4px] border border-line bg-surface px-2 text-[13px] text-muted hover:text-danger">
      ✕
    </button>
  );
}

export function Add({ onClick, ro, children }: { onClick: () => void; ro: boolean; children: ReactNode }) {
  if (ro) return null;
  return (
    <button onClick={onClick} className="h-[30px] cursor-pointer self-start rounded-[4px] border border-dashed border-line-strong bg-surface px-3 text-[13px] text-body hover:bg-canvas">
      + {children}
    </button>
  );
}

export function Card({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return <div className={cx("rounded-[6px] border bg-surface p-4", tone === "warn" ? "border-warn-line" : "border-line")}>{children}</div>;
}
