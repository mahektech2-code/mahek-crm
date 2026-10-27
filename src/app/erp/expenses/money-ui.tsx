"use client";

import * as React from "react";
import { Button, checkboxClass, controlClass, cx, PaiseInput, Td, Th, Tr } from "@/components/ui/primitives";
import { fd, fdLong, inr } from "@/lib/erp/ui";
import { ErpDialog, DialogHeader, DialogTitle } from "../_ui/dialog";
import { eyebrowClass, labelClass, linkClass } from "../_ui/look";
import { shrinkImage } from "@/lib/shrink-image";

/* ---------------------------------------------------------------------------
 * PETTY CASH'S OWN PIECES, drawn as the mockups draw them
 * (docs/erp/money-flow). An account carries a coloured letter; a Paid-from
 * choice is a card that says what the account holds now and what it will hold
 * after; a dialog's steps are three bars across the top. Pure presentation —
 * every rule is the server's (`lib/erp/money.ts`).
 * ------------------------------------------------------------------------- */

export type KitAccount = { id: string; name: string; kind: "bank" | "cash" | "petty"; last4: string | null; balance: number };
export type CashSource = { id: string; label: string; left: number };
export type MoneyKit = {
  today: string;
  me: string;
  approver: boolean;
  nextTxn: string;
  nextAdv: string;
  approvalAbove: number;
  billsDays: number;
  accounts: KitAccount[];
  categories: string[];
  employees: { name: string; dept: string | null; open: boolean }[];
  customers: { id: string; label: string }[];
  customerCash: CashSource[];
  withdrawals: CashSource[];
};

export const FROM_CUSTOMER_CASH = "Cash from a customer";
export const FROM_WITHDRAWAL = "Cash withdrawn from a bank";

/** The account's letter, in the account's colour: a bank its initial, cash a rupee, petty cash a P. */
export function AccountMark({ kind, name, size = "md", index = 0 }: { kind: KitAccount["kind"] | "customer"; name: string; size?: "sm" | "md"; index?: number }) {
  const letter = kind === "cash" || kind === "customer" ? "₹" : kind === "petty" ? "P" : (name.trim()[0] ?? "B").toUpperCase();
  const tone = kind === "cash" || kind === "customer" ? "bg-success" : kind === "petty" ? "bg-warn" : index % 2 ? "bg-danger/85" : "bg-danger";
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-[5px] font-bold text-white",
        size === "sm" ? "h-5 w-5 text-2xs" : "h-6 w-6 text-xs",
        tone,
      )}
    >
      {letter}
    </span>
  );
}

/** The index a bank takes among banks, so two banks never share a shade. */
export function bankIndex(accounts: KitAccount[], id: string): number {
  return accounts.filter((a) => a.kind === "bank").findIndex((a) => a.id === id);
}

/** A labelled field, its required star, and an error or a hint under it. */
export function MField({ label, req, error, hint, children, className }: { label: string; req?: boolean; error?: string | null; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="mb-1.5 text-meta font-semibold text-body">
        {label}
        {req ? <span className="text-danger"> *</span> : null}
      </div>
      {children}
      {error ? <div className="mt-1 text-meta text-danger">{error}</div> : hint ? <div className="mt-1 text-meta text-muted">{hint}</div> : null}
    </div>
  );
}

export const boxClass = (invalid?: boolean, extra?: string) => controlClass({ invalid, className: cx("h-9 text-sm", extra) });

export function MInput({ invalid, className, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...p} className={boxClass(invalid, className)} />;
}

export function MSelect({ invalid, className, value, onChange, options, placeholder }: { invalid?: boolean; className?: string; value: string; onChange: (v: string) => void; options: (string | { v: string; l: string })[]; placeholder?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={boxClass(invalid, cx("cursor-pointer", className))}>
      {placeholder != null ? <option value="">{placeholder}</option> : null}
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.v;
        return (
          <option key={v} value={v}>
            {typeof o === "string" ? o : o.l}
          </option>
        );
      })}
    </select>
  );
}

export function MMoney({ paise, onPaise, invalid, autoFocus }: { paise: number | null; onPaise: (p: number | null) => void; invalid?: boolean; autoFocus?: boolean }) {
  return (
    <span className={cx("flex h-9 items-center rounded-control border bg-surface px-3 focus-within:border-brand", invalid ? "border-danger" : "border-line")}>
      <span className="mr-1.5 text-sm text-body">₹</span>
      <PaiseInput autoFocus={autoFocus} paise={paise} onPaise={onPaise} className="min-w-0 flex-1 border-none bg-transparent text-sm text-ink outline-none" />
    </span>
  );
}

/** The dialog's heading: its name and the transaction number it is about to take. */
export function MoneyHead({ title, code, onClose }: { title: string; code?: React.ReactNode; onClose: () => void }) {
  return (
    <DialogHeader onClose={onClose}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <DialogTitle>{title}</DialogTitle>
        {code ? <span className="font-mono text-meta text-brand">{code}</span> : null}
      </div>
    </DialogHeader>
  );
}

/** Three bars across the top: done is green, the page you are on is the brand colour, ahead is grey. */
export function MoneySteps({ steps, at, done }: { steps: string[]; at: number; done: boolean[] }) {
  return (
    <div className="flex flex-none gap-2 border-b border-divider bg-canvas/50 px-6 pt-3 pb-2.5">
      {steps.map((s, i) => {
        const tone = i === at ? "brand" : done[i] ? "success" : "muted";
        return (
          <div key={s} className="min-w-0 flex-1">
            <div className={cx("h-1 rounded-full", tone === "brand" ? "bg-brand" : tone === "success" ? "bg-success" : "bg-line")} />
            <div className={cx("mt-1.5 text-meta font-semibold", tone === "brand" ? "text-brand" : tone === "success" ? "text-success" : "text-muted")}>
              {i + 1} · {s}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type CardChoice = { key: string; name: string; kind: KitAccount["kind"] | "customer"; mark?: number; sub: string; after?: string; disabled?: string };

/** "Paid from": one card per way the money could have left, the chosen one saying its balance before → after. */
export function PaidFromCards({ choices, value, onChange, error }: { choices: CardChoice[]; value: string; onChange: (k: string) => void; error?: string | null }) {
  return (
    <div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, choices.length))}, minmax(0, 1fr))` }}>
        {choices.map((c) => {
          const on = c.key === value;
          return (
            <button
              key={c.key}
              type="button"
              disabled={!!c.disabled}
              title={c.disabled}
              onClick={() => onChange(c.key)}
              className={cx(
                "min-h-17 rounded-card border bg-surface px-3.5 py-3 text-left transition-colors",
                on ? "border-2 border-success ring-2 ring-success-soft" : "border-line hover:border-muted",
                c.disabled && "cursor-not-allowed opacity-50",
                !c.disabled && "cursor-pointer",
              )}
            >
              <span className="flex items-start gap-2">
                <AccountMark kind={c.kind} name={c.name} index={c.mark} />
                <span className="text-sm leading-6 font-semibold text-ink">{c.name}</span>
              </span>
              <span className="mt-1 block text-sm text-muted tabular-nums">{on && c.after ? c.after : c.sub}</span>
            </button>
          );
        })}
      </div>
      {error ? <div className="mt-1 text-meta text-danger">{error}</div> : null}
    </div>
  );
}

/** The cards an account list offers: what each holds now, and — for the chosen one — after this amount leaves. */
export function accountChoices(accounts: KitAccount[], amount: number, dir: "out" | "in", only?: KitAccount["kind"][]): CardChoice[] {
  return accounts
    .filter((a) => !only || only.includes(a.kind))
    .map((a) => {
      const after = dir === "out" ? a.balance - amount : a.balance + amount;
      return {
        key: a.name,
        name: a.name,
        kind: a.kind,
        mark: bankIndex(accounts, a.id),
        sub: inr(a.balance),
        after: amount > 0 ? `${inr(a.balance)} → ${inr(after)}` : inr(a.balance),
      };
    });
}

/** A coloured note across the dialog: a warning, a caution, or information. */
export function Note({ tone, icon, children }: { tone: "danger" | "warn" | "info"; icon?: string; children: React.ReactNode }) {
  return (
    <div
      className={cx(
        "flex gap-3 rounded-card border px-4 py-3 text-sm leading-6",
        tone === "danger" ? "border-danger/30 bg-danger-soft text-danger" : tone === "warn" ? "border-warn-line bg-warn-soft text-warn-ink" : "border-info/20 bg-info-soft text-info",
      )}
    >
      <span className="flex-none font-bold">{icon ?? (tone === "danger" ? "▲" : tone === "warn" ? "!" : "i")}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A file box: pick one, it uploads as it is chosen, and the box then names it with its size. */
export function FileBox({ value, onChange, empty = "Drop a photo or PDF", dashed }: { value: { id: string; name: string; size: number } | null; onChange: (f: { id: string; name: string; size: number } | null) => void; empty?: string; dashed?: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const [why, setWhy] = React.useState("");
  const ref = React.useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setWhy("");
    try {
      const body = new FormData();
      body.set("file", await shrinkImage(file));
      body.set("kind", "photo");
      const res = await fetch("/api/erp/attachments", { method: "POST", body });
      const j = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !j.id) throw new Error(j.error || "Upload failed");
      onChange({ id: j.id, name: file.name, size: file.size });
    } catch (e) {
      setWhy(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };
  const ext = value ? (value.name.split(".").pop() ?? "").toUpperCase().slice(0, 4) : "";
  const size = value ? (value.size >= 1024 * 1024 ? `${(value.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value.size / 1024))} KB`) : "";
  return (
    <div>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className={cx(
          "flex h-11 w-full cursor-pointer items-center gap-3 rounded-control border bg-surface px-3.5 text-left",
          dashed && !value ? "border-dashed border-line text-muted" : "border-line",
        )}
      >
        {value ? (
          <>
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[5px] bg-danger-soft text-2xs font-bold text-danger">{ext === "JPEG" ? "JPG" : ext}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{value.name}</span>
            <span className="flex-none text-meta text-muted">{size}</span>
          </>
        ) : (
          <span className="flex items-center gap-2 text-sm text-muted">{busy ? "Uploading…" : `⬆ ${empty}`}</span>
        )}
      </button>
      <input ref={ref} type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      {why ? <div className="mt-1 text-meta text-danger">{why}</div> : null}
    </div>
  );
}

export type Upload = { id: string; name: string; size: number } | null;

/** The dialog's foot: a sentence on the left, its buttons on the right. */
export function MoneyFoot({ left, children }: { left?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-4 border-t border-divider bg-canvas/60 px-6 py-4">
      <div className="min-w-0 flex-1 truncate text-sm text-muted">{left}</div>
      <div className="flex flex-none gap-2.5">{children}</div>
    </div>
  );
}

export function MoneyShell({ onClose, label, width, children }: { onClose: () => void; label: string; width: number; children: React.ReactNode }) {
  return (
    <ErpDialog onClose={onClose} label={label} width={width} tall={false}>
      {children}
    </ErpDialog>
  );
}

/** A strip of figures in boxes, joined by operators: "Opening + In − Out = Closing". */
export function SumStrip({ items }: { items: ({ l: string; v: string; tone?: "success" | "danger" | "ink"; sub?: string } | string)[] }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-card border border-line bg-surface">
      {items.map((it, i) =>
        typeof it === "string" ? (
          <div key={i} className="flex flex-none items-center border-r border-divider px-3 text-lg text-muted">
            {it}
          </div>
        ) : (
          <div key={i} className={cx("min-w-0 flex-1 px-5 py-3.5", i < items.length - 1 && "border-r border-divider")}>
            <div className="text-sm text-muted">{it.l}</div>
            <div className={cx("mt-0.5 text-xl font-bold tabular-nums", it.tone === "success" ? "text-success" : it.tone === "danger" ? "text-danger" : "text-ink")}>{it.v}</div>
            {it.sub ? <div className="text-meta text-muted">{it.sub}</div> : null}
          </div>
        ),
      )}
    </div>
  );
}

/** Three figures side by side in their own boxes. */
export function FigureBoxes({ items }: { items: { l: string; v: string; tone?: "success" | "danger"; sub?: React.ReactNode; subTone?: "success" | "danger" | "muted" }[] }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((it) => (
        <div key={it.l} className="rounded-card border border-line bg-surface px-4 py-3">
          <div className="text-sm font-medium text-muted">{it.l}</div>
          <div className={cx("mt-0.5 text-lg font-bold tabular-nums", it.tone === "success" ? "text-success" : it.tone === "danger" ? "text-danger" : "text-ink")}>{it.v}</div>
          {it.sub ? <div className={cx("text-sm font-semibold", it.subTone === "success" ? "text-success" : it.subTone === "danger" ? "text-danger" : "text-muted")}>{it.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** A segmented choice: one of a few, drawn as joined buttons. */
export function Segments({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex h-9 overflow-hidden rounded-control border border-line">
      {options.map((o, i) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cx(
            "min-w-0 flex-1 cursor-pointer px-2 text-sm",
            i > 0 && "border-l border-line",
            o === value ? "bg-brand-soft font-semibold text-brand-hover" : "bg-surface text-muted hover:text-body",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** A small round status pill with a dot: "● Matched". */
export function Pill({ tone, children }: { tone: "success" | "danger" | "warn" | "info" | "brand" | "muted"; children: React.ReactNode }) {
  const cls = {
    success: "bg-success-soft text-success",
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn-ink",
    info: "bg-info-soft text-info",
    brand: "bg-brand-soft text-brand-hover",
    muted: "bg-divider text-muted",
  }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-meta font-semibold whitespace-nowrap", cls)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** A timeline of what happened, a ring per step. */
export function Timeline({ items }: { items: { title: React.ReactNode; sub?: React.ReactNode; tone: "success" | "brand" | "warn" }[] }) {
  return (
    <ol className="relative grid gap-4 pl-7 before:absolute before:top-2 before:bottom-2 before:left-[7px] before:w-px before:bg-line">
      {items.map((it, i) => (
        <li key={i} className="relative">
          <span
            className={cx(
              "absolute top-1 -left-7 h-4 w-4 rounded-full border-2 bg-surface",
              it.tone === "success" ? "border-success" : it.tone === "warn" ? "border-warn" : "border-brand",
            )}
          />
          <div className="text-sm font-semibold text-ink">{it.title}</div>
          {it.sub ? <div className="mt-0.5 text-sm text-muted">{it.sub}</div> : null}
        </li>
      ))}
    </ol>
  );
}

/** A table of a dialog's lines, header in the label style. */
export function LineTable({ head, children, foot, fixed }: { head: { l: string; align?: "right"; w?: string }[]; children: React.ReactNode; foot?: React.ReactNode; fixed?: boolean }) {
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <table className={cx("w-full", fixed && "table-fixed")}>
        <thead className="bg-canvas">
          <Tr>
            {head.map((h, i) => (
              <Th key={`${h.l}${i}`} align={h.align} className={h.w}>
                {h.l}
              </Th>
            ))}
          </Tr>
        </thead>
        <tbody>{children}</tbody>
        {foot ? <tfoot>{foot}</tfoot> : null}
      </table>
    </div>
  );
}

export { Td, Tr, Button, checkboxClass, fd, fdLong, inr, eyebrowClass, labelClass, linkClass };
