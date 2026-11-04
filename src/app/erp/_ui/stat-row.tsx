"use client";

import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { moneyShort } from "@/lib/format";
import { roundedTotal } from "@/lib/bill-round";
import { inr, nf, type Tone } from "@/lib/erp/ui";
import type { StatPick, StatValue } from "@/lib/erp/list-query";

/* ---------------------------------------------------------------------------
 * THE FIGURE CARDS OVER A LIST.
 *
 * Every figure is the server's, worked out over every row the filters reach
 * (`statsOf` in list-query.ts), so a card and the table under it cannot
 * disagree. Unfiltered a card says what it covers; filtered it says what it
 * is a part of, and its bar shows the share. A card is a button only where it
 * IS a filter — tapping "Late" shows the late rows and tapping again lets them
 * go. The list's status values, where it has a handful, are one Breakdown
 * card beside them rather than a card each.
 * ------------------------------------------------------------------------- */

/** The dot and the bar, by the tone a card or a status is drawn in. */
const FILL: Record<Tone, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
  brand: "bg-brand",
  neutral: "bg-faint",
  muted: "bg-faint",
};

/** A card's figure as it is read at a glance, and in full on hover. */
function figureText(s: StatValue, v: number): { short: string; full: string } {
  if (s.fmt === "m") {
    const m = s.whole ? roundedTotal(v) : v;
    return { short: moneyShort(m), full: inr(m) };
  }
  const n = nf(Math.round(v * 100) / 100);
  const u = s.u?.trim();
  return { short: u ? `${n} ${u}` : n, full: u ? `${n} ${u}` : n };
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export type Breakdown = {
  total: number;
  chips: { v: string; n: number }[];
  value: string;
  tones: Record<string, Tone>;
  onPick: (v: string) => void;
};

/** The most status values named in the Breakdown card; the rest are counted as "more". */
const BREAKDOWN_NAMED = 6;

export function StatRow({ stats, filtered, breakdown, onPick }: { stats: StatValue[]; filtered: boolean; breakdown: Breakdown | null; onPick: (p: StatPick) => void }) {
  return (
    <CardGrid min={168} gap="gap-3" className="mb-3">
      {stats.map((s) => (
        <StatCard key={s.l} s={s} filtered={filtered} onPick={onPick} />
      ))}
      {breakdown ? <BreakdownCard b={breakdown} /> : null}
    </CardGrid>
  );
}

function StatCard({ s, filtered, onPick }: { s: StatValue; filtered: boolean; onPick: (p: StatPick) => void }) {
  const f = figureText(s, s.v);
  const danger = s.tone === "danger" && s.v > 0;
  /* The bar: a narrowed count's share of the rows shown, else the part of the whole. */
  const bar = s.share != null ? Math.round(s.share * 100) : filtered ? pct(s.v, s.base) : 100;
  const sub =
    s.missing > 0
      ? `${nf(s.missing)} ${s.missingLabel ?? "with no value"}`
      : s.share != null
        ? s.v === 0
          ? "None right now"
          : `${Math.round(s.share * 100)}% of these`
        : filtered
          ? `of ${figureText(s, s.base).short} in all`
          : "All records";
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2 text-meta font-semibold text-muted">
        <span className={cx("h-1.75 w-1.75 flex-none rounded-full", s.tone ? FILL[s.tone] : "bg-ink")} />
        <span className="truncate">{s.l}</span>
      </span>
      <span title={f.full} className={cx("truncate text-2xl leading-7.5 font-bold tracking-tight tabular-nums", danger ? "text-danger" : "text-ink")}>
        {f.short}
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-divider">
        <span className={cx("block h-full rounded-full", s.tone ? FILL[s.tone] : "bg-ink")} style={{ width: `${Math.max(bar > 0 ? 2 : 0, Math.min(100, bar))}%` }} />
      </span>
      <span className={cx("truncate text-xs tabular-nums", s.missing > 0 ? "text-warn-ink" : "text-muted")}>{sub}</span>
    </>
  );
  const box = "flex min-w-0 flex-col gap-1.5 rounded-[10px] border bg-surface px-4 pt-3.5 pb-3 text-left";
  if (!s.pick) return <div className={cx(box, "border-line")}>{body}</div>;
  const pick = s.pick;
  return (
    <button
      type="button"
      aria-pressed={s.on}
      title={s.on ? `Showing only ${s.l.toLowerCase()} — tap to show everything` : `Show only ${s.l.toLowerCase()}`}
      onClick={() => onPick(pick)}
      className={cx(box, "cursor-pointer", s.on ? "border-brand ring-3 ring-brand-soft" : "border-line hover:border-line-strong")}
    >
      {body}
    </button>
  );
}

function BreakdownCard({ b }: { b: Breakdown }) {
  const sorted = [...b.chips].sort((x, y) => y.n - x.n);
  const named = sorted.slice(0, BREAKDOWN_NAMED);
  const rest = sorted.slice(BREAKDOWN_NAMED);
  return (
    <div className="col-span-2 flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-line bg-surface px-4 pt-3.5 pb-3">
      <span className="flex min-w-0 items-center gap-2 text-meta font-semibold text-muted">
        <span className="h-1.75 w-1.75 flex-none rounded-full bg-ink" />
        By status
        {b.value ? (
          <button type="button" onClick={() => b.onPick("")} className="ml-auto cursor-pointer text-xs font-semibold text-brand-hover hover:underline">
            Show every status
          </button>
        ) : null}
      </span>
      <span className="flex h-2 overflow-hidden rounded-full bg-divider">
        {sorted.map((c) => (
          <span key={c.v} title={`${c.v} · ${nf(c.n)}`} className={cx("block h-full", FILL[b.tones[c.v] ?? "neutral"], b.value && b.value !== c.v && "opacity-30")} style={{ width: `${pct(c.n, b.total)}%` }} />
        ))}
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {named.map((c) => {
          const on = b.value === c.v;
          return (
            <button
              key={c.v}
              type="button"
              aria-pressed={on}
              onClick={() => b.onPick(on ? "" : c.v)}
              className={cx("inline-flex cursor-pointer items-center gap-1.5 rounded-control px-1 text-xs whitespace-nowrap", on ? "bg-brand-soft font-semibold text-brand-hover" : "text-body hover:text-ink")}
            >
              <span className={cx("h-1.75 w-1.75 rounded-full", FILL[b.tones[c.v] ?? "neutral"])} />
              {c.v}
              <span className="text-muted tabular-nums">{nf(c.n)}</span>
            </button>
          );
        })}
        {rest.length ? <span className="text-xs text-muted">+{nf(rest.length)} more</span> : null}
      </span>
    </div>
  );
}
