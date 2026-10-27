"use client";

import * as React from "react";
import { BodyPortal } from "@/components/ui/body-portal";
import { useBackdropClose, useEscape } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * BANK STATEMENT MANAGEMENT — the pieces its three screens share, drawn as
 * the mockups (Accounts → Bank statement management): the bank's letter, the
 * state pills, the dialog frame with its three-bar steps, money with paise.
 * ------------------------------------------------------------------------- */

/** ₹18,42,360 — rupees, Indian grouping, paise only where there are some. */
export function inr(paise: number | null | undefined, opts: { paise?: boolean; sign?: boolean } = {}): string {
  if (paise == null) return "—";
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const s = String(whole);
  const head = s.slice(0, -3);
  const body = (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : "") + s.slice(-3);
  /* Paise always show where there are any; `paise: true` shows ".00" too. */
  const tail = opts.paise || frac ? `.${String(frac).padStart(2, "0")}` : "";
  return `${neg ? "−" : opts.sign ? "+" : ""}₹${body}${tail}`;
}

/** 1,24,500.00 — as a statement prints it, no symbol. */
export function figure(paise: number | null | undefined): string {
  if (paise == null) return "";
  return inr(paise, { paise: true }).replace("₹", "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-21" → "21 Oct". */
export function dayLabel(iso: string | null | undefined, year = false): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ""}`;
}

function istParts(at: string | Date) {
  const d = typeof at === "string" ? new Date(at) : at;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour") % 24, min: g("minute") };
}

/** "2:14 PM". */
export function timeLabel(at: string | null | undefined): string {
  if (!at) return "—";
  const p = istParts(at);
  return `${p.h % 12 || 12}:${String(p.min).padStart(2, "0")} ${p.h >= 12 ? "PM" : "AM"}`;
}

/** The IST calendar day of an instant, YYYY-MM-DD. */
export function istDay(at: string): string {
  const p = istParts(at);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "Today 2:14 PM", "Yesterday 6:40 PM", "18 Oct, 5:10 PM". */
export function whenLabel(at: string | null | undefined, today: string): string {
  if (!at) return "never";
  const day = istDay(at);
  const diff = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  if (diff === 0) return `Today ${timeLabel(at)}`;
  if (diff === 1) return `Yesterday ${timeLabel(at)}`;
  return `${dayLabel(day)}, ${timeLabel(at)}`;
}

/** "Kept until 28 Oct", "Deleted tomorrow", "Deleted 21 Oct". */
export function retention(u: { pdfKept: boolean; pdfExpiresAt: string; status: string }, today: string): { text: string; tone: "kept" | "soon" | "gone" } {
  const day = istDay(u.pdfExpiresAt);
  if (!u.pdfKept) return { text: u.status === "discarded" ? "Deleted · discarded" : `Deleted ${dayLabel(day)}`, tone: "gone" };
  const left = Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000);
  if (left <= 0) return { text: "Deleted today", tone: "soon" };
  if (left === 1) return { text: "Deleted tomorrow", tone: "soon" };
  return { text: `Kept until ${dayLabel(day)}`, tone: "kept" };
}

export function BankBadge({ mark, size = 18 }: { mark: { letters: string; color: string }; size?: number }) {
  return (
    <i
      className="inline-grid flex-none place-items-center font-extrabold text-white not-italic"
      style={{ width: size, height: size, borderRadius: size >= 28 ? 8 : 5, background: mark.color, fontSize: size >= 28 ? 12 : 9.5 }}
    >
      {mark.letters}
    </i>
  );
}

/** "K Kotak ··4471" — the account as every table names it. */
export function Acc({ mark, name, last4 }: { mark: { letters: string; color: string }; name: string; last4: string | null }) {
  const short = name.replace(/\s*(bank|mahindra)\s*$/i, "").trim() || name;
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
      <BankBadge mark={mark} />
      {short}
      {last4 ? ` ··${last4}` : ""}
    </span>
  );
}

export type PillTone = "ok" | "info" | "danger" | "flag" | "warn" | "muted" | "brand" | "ai";

const PILL: Record<PillTone, string> = {
  ok: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  danger: "bg-danger-soft text-danger",
  flag: "bg-[#fff0e3] text-[#a14b00]",
  warn: "bg-warn-soft text-warn-ink",
  muted: "bg-divider text-muted",
  brand: "bg-brand-soft text-brand-deep",
  ai: "bg-ai-soft text-ai",
};

export function Pill({ tone, children, className, title }: { tone: PillTone; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex max-w-full items-center gap-[5px] rounded-full px-[9px] py-[2px] text-[11.5px] font-[650] whitespace-nowrap", PILL[tone], className)}>
      <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function Ret({ tone, children }: { tone: "kept" | "soon" | "gone"; children: React.ReactNode }) {
  return (
    <span
      className={cx(
        "rounded-[6px] px-2 py-[2px] text-[11.5px] font-[650] whitespace-nowrap",
        tone === "kept" ? "bg-info-soft text-info" : tone === "soon" ? "bg-warn-soft text-warn-ink" : "bg-divider text-muted",
      )}
    >
      {children}
    </span>
  );
}

export const btn = {
  base: "inline-flex h-[34px] cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border px-3.5 text-[13px] font-[650] whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45",
  primary: "border-brand bg-brand text-white hover:bg-brand-hover",
  secondary: "border-line bg-surface text-ink hover:bg-canvas",
  ok: "border-success bg-success text-white hover:brightness-95",
  danger: "border-[#efc7c4] bg-surface text-danger hover:bg-danger-soft",
  sm: "h-7 rounded-[7px] px-2.5 text-[12px]",
};

export function Btn({
  tone = "secondary",
  small,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "secondary" | "ok" | "danger"; small?: boolean }) {
  return <button type="button" {...props} className={cx(btn.base, btn[tone], small && btn.sm, className)} />;
}

export function LinkBtn({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={cx("cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-semibold text-brand hover:underline disabled:cursor-not-allowed disabled:opacity-50", className)} />;
}

export function Note({ tone, icon, children, className }: { tone: "i" | "w" | "o" | "r"; icon?: string; children: React.ReactNode; className?: string }) {
  const t = {
    i: "border-[#d6e2f8] bg-info-soft text-[#244a99]",
    w: "border-warn-line bg-warn-soft text-warn-ink",
    o: "border-[#cfe8d9] bg-success-soft text-success",
    r: "border-[#f2cfcc] bg-danger-soft text-danger",
  }[tone];
  return (
    <div className={cx("flex items-start gap-[9px] rounded-[10px] border px-3 py-2.5 text-[12.3px] leading-[1.45]", t, className)}>
      <span className="flex-none font-bold">{icon ?? { i: "ⓘ", w: "!", o: "✓", r: "!" }[tone]}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export const labelCls = "text-[10.5px] font-bold tracking-[0.07em] text-faint uppercase";

/** The frame every dialog here is drawn in: a title, the three steps, a body and a foot. */
export function Dialog({
  open,
  onClose,
  title,
  aside,
  steps,
  step,
  width,
  top = 80,
  foot,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  aside?: React.ReactNode;
  steps?: string[];
  /** 0-based: earlier steps are done, this one is on. */
  step?: number;
  width: number;
  top?: number;
  foot?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEscape(onClose, open);
  const backdrop = useBackdropClose(onClose);
  if (!open) return null;
  return (
    <BodyPortal>
      <div {...backdrop} className="fixed inset-0 z-[70] overflow-y-auto bg-[rgba(22,24,32,0.38)] px-4 pb-10 whitespace-normal" style={{ paddingTop: top }} role="dialog" aria-modal="true">
        <div onClick={(e) => e.stopPropagation()} className="mx-auto overflow-hidden rounded-[16px] bg-surface shadow-[0_24px_60px_rgba(20,20,40,0.28)]" style={{ maxWidth: width }}>
          <div className="flex items-center gap-2.5 border-b border-divider px-5 py-4">
            <h3 className="text-[16px] font-bold text-heading">{title}</h3>
            {aside}
            <button type="button" onClick={onClose} aria-label="Close" className="ml-auto cursor-pointer border-none bg-transparent text-[18px] text-faint hover:text-ink">
              ✕
            </button>
          </div>
          {steps ? (
            <div className="flex gap-1.5 border-b border-divider bg-[#fafbfc] px-5 py-2.5">
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={cx(
                    "flex-1 border-t-[3px] pt-1.5 text-[11.5px] font-[650]",
                    i < (step ?? 0) ? "border-success text-success" : i === step ? "border-brand text-brand-deep" : "border-line text-faint",
                  )}
                >
                  {i + 1} · {s}
                </span>
              ))}
            </div>
          ) : null}
          {children}
          {foot ? <div className="flex items-center gap-2 border-t border-divider bg-[#fafbfc] px-5 py-3">{foot}</div> : null}
        </div>
      </div>
    </BodyPortal>
  );
}

/** A select drawn the way the mockups draw one. */
export function Sel({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx("h-8 cursor-pointer rounded-[8px] border border-line bg-surface px-2.5 text-[12.5px] text-body outline-none focus:border-brand", className)}
    />
  );
}

export const inputCls =
  "h-9 w-full rounded-[9px] border border-line-strong bg-surface px-[11px] text-[13px] text-ink outline-none placeholder:text-faint focus:border-brand focus:shadow-[0_0_0_3px_var(--color-brand-soft)]";

export function FieldLabel({ children, required, hint }: { children: React.ReactNode; required?: boolean; hint?: string }) {
  return (
    <label className="mb-1 block text-[11.5px] font-[650] text-body">
      {children}
      {required ? <em className="text-danger not-italic"> *</em> : null}
      {hint ? <span className="font-normal text-muted"> {hint}</span> : null}
    </label>
  );
}

/** The confidence bar beside a line the AI read. */
export function Conf({ value, low }: { value: number; low: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative inline-block h-[5px] w-[38px] rounded-[9px] bg-divider align-middle">
        <span className="absolute inset-y-0 left-0 rounded-[9px]" style={{ width: `${value}%`, background: low ? "#e08a2c" : "var(--color-success)" }} />
      </span>
      <span className="text-[11.5px] text-muted">{value}%</span>
    </span>
  );
}

export function tabCls(on: boolean) {
  return cx(
    "-mb-px flex cursor-pointer items-center border-b-2 bg-transparent px-3 py-[11px] text-[13px] font-semibold whitespace-nowrap",
    on ? "border-brand text-brand-deep" : "border-transparent text-muted hover:text-body",
  );
}

export function TabCount({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <span className={cx("ml-[5px] rounded-full px-1.5 text-[11px] tabular-nums", on ? "bg-brand-soft text-brand-deep" : "bg-divider")}>{children}</span>;
}
