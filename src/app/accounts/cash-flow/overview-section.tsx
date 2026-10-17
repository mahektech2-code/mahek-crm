"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { dailyFlow, type DayFlow, type ExpectedIn } from "@/lib/engines/cash-flow";
import { addDays, WEEKDAY_SHORT, weekdayOf } from "@/lib/engines/vendor-payouts";
import { longDate, money, moneyShort, shortDate, signedMoney } from "@/lib/format";
import type { PayoutView } from "@/lib/services/vendor-payout-service";
import { MetricRow, plural } from "../parts";
import { InfoTip } from "./info-tip";
import { Segmented } from "./payouts-section";

/* ---------------------------------------------------------------------------
 * THE FLOW — money in against money out, day by day from today.
 *
 * In is the prediction (each customer's own paying habit); out is the plan
 * (vendor payouts on their payment days). The running line is the net from
 * today and NOT a bank balance: MahekOne does not hold one, and drawing a
 * balance from a guessed opening figure would be a number nobody can check.
 * What is already late on either side — a customer past their habit, a
 * payout past its day — is its own figure and never folded into today.
 * ------------------------------------------------------------------------- */

type Span = 7 | 14 | 30;

export function OverviewSection({
  ins,
  outs,
  today,
  onGo,
}: {
  ins: ExpectedIn[];
  outs: PayoutView[];
  today: string;
  onGo: (view: "in" | "out") => void;
}) {
  const [span, setSpan] = React.useState<Span>(14);
  const [picked, setPicked] = React.useState<string | null>(null);

  const open = outs.filter((p) => p.status === "open" || p.status === "on_hold");
  const rows = dailyFlow(
    ins.map((i) => ({ on: i.expectedOn, amountPaise: i.amountPaise })),
    open.filter((p) => p.status === "open").map((p) => ({ on: p.payOn, amountPaise: p.amountPaise })),
    today,
    span,
  );
  const totIn = rows.reduce((a, r) => a + r.inPaise, 0);
  const totOut = rows.reduce((a, r) => a + r.outPaise, 0);
  const net = totIn - totOut;
  const lateIn = ins.filter((i) => i.expectedOn < today);
  const overdueOut = open.filter((p) => p.status === "open" && p.payOn < today);
  const lowest = rows.reduce((m, r) => (r.runningPaise < m.runningPaise ? r : m), rows[0]);
  const sum = (xs: { amountPaise: number }[]) => xs.reduce((a, x) => a + x.amountPaise, 0);

  const day = picked && rows.some((r) => r.date === picked) ? picked : null;

  // Two or three facts worth acting on, each a few words; the figures behind
  // them are the metric row and the chart.
  const peak = rows.reduce((m, r) => (r.outPaise > m.outPaise ? r : m), rows[0]);
  const label = (d: string) => `${WEEKDAY_SHORT[weekdayOf(d) - 1]} ${shortDate(d)}`;
  const insights: { text: string; tone: "brand" | "warn" | "danger" }[] = [];
  if (peak && peak.outPaise > 0) insights.push({ text: `Peak outflow ${label(peak.date)}`, tone: "brand" });
  if (lowest && lowest.runningPaise < 0) insights.push({ text: `Shortfall on ${label(lowest.date)}`, tone: "danger" });
  if (lateIn.length) insights.push({ text: `${plural(lateIn.length, "invoice")} overdue`, tone: "warn" });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented
          value={String(span) as "7" | "14" | "30"}
          options={[
            { value: "7", label: "7 days" },
            { value: "14", label: "14 days" },
            { value: "30", label: "30 days" },
          ]}
          onChange={(v) => setSpan(Number(v) as Span)}
        />
        <span className="text-[13px] text-muted tabular-nums">
          {shortDate(today)} – {shortDate(addDays(today, span - 1))}
        </span>
        <InfoTip>
          Inflows are projected from each customer&apos;s average days to pay; outflows are payables on their scheduled
          payment date. Overdue items on either side are excluded from the daily figures and shown separately.
        </InfoTip>
        {insights.length ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {insights.map((x) => (
              <span
                key={x.text}
                className={cx(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium",
                  x.tone === "danger" ? "border-danger-soft bg-danger-soft text-danger" : x.tone === "warn" ? "border-warn-line bg-warn-soft text-warn-ink" : "border-brand-softer bg-brand-soft text-[#5223E0]",
                )}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z" />
                </svg>
                {x.text}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <MetricRow
        metrics={[
          { label: "Projected inflows", value: money(totIn), sub: plural(rows.reduce((a, r) => a + r.ins, 0), "receipt"), tone: "success" },
          { label: "Scheduled outflows", value: money(totOut), sub: plural(rows.reduce((a, r) => a + r.outs, 0), "payment"), tone: totOut ? "danger" : undefined },
          {
            label: "Net cash flow",
            value: signedMoney(net),
            tone: net >= 0 ? "success" : "danger",
          },
          {
            label: "Lowest position",
            value: lowest && lowest.runningPaise < 0 ? signedMoney(lowest.runningPaise) : "—",
            sub: lowest && lowest.runningPaise < 0 ? `${WEEKDAY_SHORT[weekdayOf(lowest.date) - 1]} ${shortDate(lowest.date)}` : undefined,
            tone: lowest && lowest.runningPaise < 0 ? "danger" : undefined,
          },
          {
            label: "Overdue receivables",
            value: money(sum(lateIn)),
            sub: overdueOut.length ? `${money(sum(overdueOut))} payables overdue` : undefined,
            tone: lateIn.length || overdueOut.length ? "warn" : undefined,
          },
        ]}
      />

      <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 pt-4 pb-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-ink">Daily cash flow</div>
          <div className="flex items-center gap-4 text-[12px] text-muted">
            <Legend swatch="bg-success" label="Inflows" />
            <Legend swatch="bg-danger" label="Outflows" />
            <span className="flex items-center gap-1.5">
              <span className="block h-0.5 w-4 bg-ink" />
              Cumulative net
            </span>
          </div>
        </div>
        <FlowChart rows={rows} today={today} picked={day} onPick={setPicked} />
      </div>

      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-4">
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-[11px] tracking-[0.04em] text-muted uppercase">
                <th className="h-8.5 px-4 text-left font-medium">Date</th>
                <th className="px-3 text-right font-medium">Inflows</th>
                <th className="px-3 text-right font-medium">Outflows</th>
                <th className="px-3 text-right font-medium">Net</th>
                <th className="px-4 text-right font-medium">Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.date}
                  onClick={() => setPicked(r.date === day ? null : r.date)}
                  className={cx(
                    "cursor-pointer border-t border-divider hover:bg-canvas",
                    r.date === day && "bg-brand-soft hover:bg-brand-soft",
                    !r.ins && !r.outs && "text-muted",
                  )}
                >
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className={cx(r.date === today && "font-semibold text-[#5223E0]")}>
                      {WEEKDAY_SHORT[weekdayOf(r.date) - 1]} {shortDate(r.date)}
                    </span>
                  </td>
                  <td className={cx("px-3 text-right tabular-nums", r.inPaise ? "text-success" : "text-muted")}>{r.inPaise ? money(r.inPaise) : "—"}</td>
                  <td className={cx("px-3 text-right tabular-nums", r.outPaise ? "text-danger" : "text-muted")}>{r.outPaise ? money(r.outPaise) : "—"}</td>
                  <td className={cx("px-3 text-right tabular-nums", r.netPaise < 0 ? "text-danger" : "text-body")}>
                    {r.netPaise ? signedMoney(r.netPaise) : "—"}
                  </td>
                  <td className={cx("px-4 text-right font-medium tabular-nums", r.runningPaise < 0 ? "text-danger" : "text-ink")}>
                    {signedMoney(r.runningPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <DayPanel day={day} ins={ins} outs={open} today={today} lateIn={lateIn} overdueOut={overdueOut} onGo={onGo} />
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("block h-2.5 w-2.5 rounded-[2px]", swatch)} />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ chart */

const H = 220;
const PAD_L = 64;
const PAD_B = 26;
const PAD_T = 10;

/**
 * Bars up for money in, down for money out, on ONE axis with the net line —
 * all three are rupees on the same day, so a second scale would only make the
 * line look larger or smaller than it is.
 */
function FlowChart({
  rows,
  today,
  picked,
  onPick,
}: {
  rows: DayFlow[];
  today: string;
  picked: string | null;
  onPick: (d: string) => void;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  // The chart takes the width it is given rather than a width per day, so 7
  // days and 30 both fill the card.
  const box = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(900);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const colW = Math.max(18, (width - PAD_L - 8) / rows.length);
  const W = PAD_L + rows.length * colW + 8;
  const top = Math.max(1, ...rows.map((r) => Math.max(r.inPaise, r.runningPaise)));
  const bottom = Math.min(0, ...rows.map((r) => Math.min(-r.outPaise, r.runningPaise)));
  const plotH = H - PAD_T - PAD_B;
  const y = (v: number) => PAD_T + ((top - v) / (top - bottom || 1)) * plotH;
  const zero = y(0);
  const ticks = niceTicks(bottom, top);
  const barW = Math.max(6, Math.min(22, colW * 0.42));
  const x = (i: number) => PAD_L + i * colW + colW / 2;
  const line = rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.runningPaise).toFixed(1)}`).join(" ");
  const showLabel = (i: number) => colW >= 44 || i % 2 === 0;

  return (
    <div ref={box} className="relative overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block" role="img" aria-label="Daily inflows and outflows">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 8} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-line-strong" : "stroke-divider"} strokeWidth={1} />
            <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px]">
              {t === 0 ? "0" : moneyShort(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx0 = x(i) - barW / 2;
          const sel = r.date === picked || hover === i;
          return (
            <g key={r.date}>
              {r.date === today ? (
                <rect x={PAD_L + i * colW + 1} y={PAD_T} width={colW - 2} height={plotH} className="fill-brand-soft" opacity={0.6} />
              ) : null}
              {r.inPaise > 0 ? (
                <rect x={cx0} y={y(r.inPaise)} width={barW} height={Math.max(1, zero - y(r.inPaise) - 1)} rx={2} className="fill-success" opacity={sel || hover == null ? 1 : 0.55} />
              ) : null}
              {r.outPaise > 0 ? (
                <rect x={cx0} y={zero + 1} width={barW} height={Math.max(1, y(-r.outPaise) - zero - 1)} rx={2} className="fill-danger" opacity={sel || hover == null ? 1 : 0.55} />
              ) : null}
              {showLabel(i) ? (
                <text x={x(i)} y={H - 8} textAnchor="middle" className={cx("text-[10px]", r.date === today ? "fill-brand" : "fill-muted")}>
                  {colW < 44 ? Number(r.date.slice(8)) : `${WEEKDAY_SHORT[weekdayOf(r.date) - 1]} ${Number(r.date.slice(8))}`}
                </text>
              ) : null}
            </g>
          );
        })}
        <path d={line} fill="none" className="stroke-ink" strokeWidth={2} strokeLinejoin="round" />
        {rows.map((r, i) => (
          <circle key={r.date} cx={x(i)} cy={y(r.runningPaise)} r={hover === i || r.date === picked ? 4.5 : 0} className="fill-ink stroke-surface" strokeWidth={2} />
        ))}
        {rows.map((r, i) => (
          <rect
            key={r.date}
            x={PAD_L + i * colW}
            y={PAD_T}
            width={colW}
            height={plotH}
            fill="transparent"
            className="cursor-pointer"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onPick(r.date)}
          />
        ))}
      </svg>
      {hover != null ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[180px] rounded-[6px] border border-line bg-surface px-3 py-2 text-[12px] shadow-[0_4px_12px_rgba(22,22,22,0.12)]"
          style={{ left: Math.min(x(hover) + 12, W - 200) }}
        >
          <div className="mb-1 font-semibold text-ink">{longDate(rows[hover].date)}</div>
          <Line label="Inflows" value={money(rows[hover].inPaise)} cls="text-success" />
          <Line label="Outflows" value={money(rows[hover].outPaise)} cls="text-danger" />
          <Line label="Net cash flow" value={signedMoney(rows[hover].netPaise)} cls="text-body" />
          <Line label="Cumulative" value={signedMoney(rows[hover].runningPaise)} cls="font-semibold text-ink" />
        </div>
      ) : null}
    </div>
  );
}

function Line({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className={cx("tabular-nums", cls)}>{value}</span>
    </div>
  );
}

function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-6; t += step) out.push(Math.round(t));
  if (!out.includes(0)) out.push(0);
  return out;
}

/* ------------------------------------------------------------- day panel */

function DayPanel({
  day,
  ins,
  outs,
  today,
  lateIn,
  overdueOut,
  onGo,
}: {
  day: string | null;
  ins: ExpectedIn[];
  outs: PayoutView[];
  today: string;
  lateIn: ExpectedIn[];
  overdueOut: PayoutView[];
  onGo: (v: "in" | "out") => void;
}) {
  const dayIns = day ? ins.filter((i) => i.expectedOn === day) : lateIn;
  const dayOuts = day ? outs.filter((p) => p.payOn === day && p.status === "open") : overdueOut;
  const title = day ? `${WEEKDAY_SHORT[weekdayOf(day) - 1]} ${longDate(day)}` : "Overdue";
  const sub = day
    ? day === today
      ? "today"
      : undefined
    : undefined;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="border-b border-divider px-4 py-3">
        <div className="text-sm font-semibold text-ink">{title}</div>
        {sub ? <div className="text-[12px] text-muted">{sub}</div> : null}
        {!day ? <div className="text-[12px] text-muted">Select a date for its breakdown</div> : null}
      </div>
      <div className="max-h-[460px] min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Group
          title="Inflows"
          tone="text-success"
          total={dayIns.reduce((a, i) => a + i.amountPaise, 0)}
          empty="None projected"
          action={<button type="button" className="cursor-pointer text-[12px] text-brand hover:underline" onClick={() => onGo("in")}>Receivables →</button>}
        >
          {dayIns.slice(0, 40).map((i) => (
            <Item
              key={i.key}
              name={i.customerName}
              meta={`${i.label}${i.lateDays ? ` · ${i.lateDays}d overdue` : ""}`}
              amount={i.amountPaise}
            />
          ))}
          {dayIns.length > 40 ? <div className="py-1 text-[12px] text-muted">and {dayIns.length - 40} more</div> : null}
        </Group>
        <Group
          title="Outflows"
          tone="text-danger"
          total={dayOuts.reduce((a, p) => a + p.amountPaise, 0)}
          empty="None scheduled"
          action={<button type="button" className="cursor-pointer text-[12px] text-brand hover:underline" onClick={() => onGo("out")}>Payables →</button>}
        >
          {dayOuts.map((p) => (
            <Item
              key={p.id}
              name={p.payeeName}
              meta={[p.source === "purchase" ? `PR ${p.prNumber}` : p.description, p.poNumber != null ? `PO ${p.poNumber}` : null, p.reference]
                .filter(Boolean)
                .join(" · ")}
              amount={p.amountPaise}
            />
          ))}
        </Group>
      </div>
    </div>
  );
}

function Group({
  title,
  tone,
  total,
  empty,
  action,
  children,
}: {
  title: string;
  tone: string;
  total: number;
  empty: string;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  const has = React.Children.count(children) > 0 && total > 0;
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
          {title} · <span className={cx("tabular-nums", tone)}>{money(total)}</span>
        </span>
        {action}
      </div>
      {has ? <ul className="space-y-1">{children}</ul> : <div className="text-[13px] text-muted">{empty}</div>}
    </div>
  );
}

function Item({ name, meta, amount }: { name: string; meta: string; amount: number }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-[4px] border border-divider px-2.5 py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
        <span className="block truncate text-[11px] text-muted">{meta}</span>
      </span>
      <span className="flex-none text-[13px] font-semibold text-ink tabular-nums">{money(amount)}</span>
    </li>
  );
}
