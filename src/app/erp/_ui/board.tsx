"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { RowMenu, type MenuItem } from "@/components/ui/overlays";
import { CardGrid } from "@/components/ui/card-grid";
import type { ActionSpec } from "@/lib/erp/ui";
import { useErpUi } from "./erp-ui";

/* ---------------------------------------------------------------------------
 * THE ORDER HUB'S PAGES (Order Hub, MRP check, To Hold) are drawn from the
 * same few pieces, in the mockups' shape: a row of figure cards, a strip of
 * underlined tabs with their counts, a table in a card, a ⋯ menu per row, the
 * check marks and the "how long it has waited" words. One home, so the three
 * pages cannot drift into three spellings of one card.
 * ------------------------------------------------------------------------- */

export type Figure = { label: string; value: number | string; tone?: "danger" | "ink"; onClick?: () => void; on?: boolean };

/** The figure cards across the top: the number large, what it counts beneath. */
export function FigureCards({ figures }: { figures: Figure[] }) {
  return (
    <CardGrid min={180} gap="gap-3" className="mb-6">
      {figures.map((f) => {
        const body = (
          <>
            <span className={cx("block text-3xl leading-9 font-semibold tabular-nums", f.tone === "danger" ? "text-danger" : "text-ink")}>{f.value}</span>
            <span className="mt-1 block text-sm text-body">{f.label}</span>
          </>
        );
        const cls = cx("rounded-card border bg-surface px-4 py-3.5 text-left", f.on ? "border-brand" : "border-line");
        return f.onClick ? (
          <button key={f.label} type="button" onClick={f.onClick} className={cx(cls, "cursor-pointer hover:border-line-strong")}>
            {body}
          </button>
        ) : (
          <div key={f.label} className={cls}>
            {body}
          </div>
        );
      })}
    </CardGrid>
  );
}

export type BoardTab<K extends string> = { key: K; label: string; count?: number };

/** Underlined tabs: "Need my check · 6". */
export function BoardTabs<K extends string>({ tabs, value, onChange }: { tabs: BoardTab<K>[]; value: K; onChange: (k: K) => void }) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-6 border-b border-line">
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={cx("-mb-px cursor-pointer border-b-2 pb-2.5 text-sm whitespace-nowrap", on ? "border-brand font-medium text-brand" : "border-transparent text-body hover:text-ink")}
          >
            {t.label}
            {t.count != null ? ` · ${t.count}` : ""}
          </button>
        );
      })}
    </div>
  );
}

/** The table's card: a border, rounded, nothing scrolling sideways. */
export function BoardTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <table className="w-full table-fixed border-collapse">{children}</table>
    </div>
  );
}

/** The ⋯ menu of a row, from the server's actions; the ones drawn as buttons beside it are left out. */
export function ActionMenu({ screen, recordId, actions, skip = [], extra = [], after }: { screen: string; recordId: string; actions: ActionSpec[]; skip?: string[]; extra?: MenuItem[]; after?: () => void }) {
  const ui = useErpUi();
  const items: MenuItem[] = [
    ...actions
      .filter((a) => !skip.includes(a.id))
      .map((a) => ({
        label: a.l,
        destructive: /hold|cancel|decline/i.test(a.l),
        disabled: !!a.why,
        title: a.why || undefined,
        onSelect: () => ui.act(screen, a, recordId, after),
      })),
    ...extra,
  ];
  if (!items.length) return null;
  return <RowMenu items={items} />;
}

/** "38 min", "1 h 50 m", "2 d 3 h" — how long something has waited, from `now`. */
export function waitWords(fromIso: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Waited past this many minutes reads red. */
export function waitLate(fromIso: string, now: number, minutes = 90): boolean {
  return now - new Date(fromIso).getTime() > minutes * 60000;
}

/** "✓ Back office · Neha" / "○ Production Head". */
export function CheckMark({ done, label, by }: { done: boolean; label: string; by?: string | null }) {
  return (
    <span className={cx("flex items-center gap-1.5 text-meta", done ? "text-ink" : "text-muted")}>
      {done ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="flex-none text-success" aria-hidden="true">
          <path d="m5 12 5 5 9-10" />
        </svg>
      ) : (
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 flex-none rounded-full border border-line-strong" />
      )}
      <span className="truncate">
        {label}
        {done && by ? ` · ${by}` : ""}
      </span>
    </span>
  );
}

/** A small rounded pill under a value: "Possible duplicate of TO-1039". */
export function Pill({ tone, children }: { tone: "warn" | "info" | "danger" | "success" | "brand" | "muted"; children: React.ReactNode }) {
  const t = {
    warn: "bg-warn-soft text-warn-ink",
    info: "bg-info-soft text-info",
    danger: "bg-danger-soft text-danger",
    success: "bg-success-soft text-success",
    brand: "bg-brand-soft text-brand",
    muted: "bg-canvas text-muted",
  }[tone];
  return <span className={cx("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", t)}>{children}</span>;
}

/** The line of small print under a board. */
export function BoardFoot({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-meta text-muted">{children}</p>;
}

/** The page's heading: the title, what it is beside it, the buttons on the right. */
export function BoardHeader({ title, sub, danger, actions }: { title: string; sub?: string; danger?: boolean; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div role="heading" aria-level={1} className={cx("text-2xl leading-8 font-semibold tracking-tight", danger ? "text-danger" : "text-ink")}>
        {title}
      </div>
      {sub ? <span className="text-sm text-body">{sub}</span> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
