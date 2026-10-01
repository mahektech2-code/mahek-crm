"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ListRow } from "@/lib/erp/ui";
import { TONES } from "@/lib/erp/ui";
import type { HrmsExtras } from "@/lib/hrms/extras";
import { cx } from "@/components/ui/primitives";
import { daysIn, fdShort, monLabel, weekdayOf, WEEKDAYS } from "@/lib/hrms/time";

/* ---------------------------------------------------------------------------
 * What the design draws above an HRMS list: a notice, the mine / team / all
 * switch, the date or period a screen was read for, a month calendar of
 * requests or plans, and the chart with its trend. Every control is a URL
 * parameter, so a refresh after an action keeps the view.
 * ------------------------------------------------------------------------- */

const SCOPE_LABEL = { mine: "Mine", team: "My team", all: "Everyone" } as const;

export function Above({ extras, rows }: { extras: HrmsExtras; rows: ListRow[] }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const withParam = (k: string, v: string | null, also: Record<string, string | null> = {}) => {
    const q = new URLSearchParams(params.toString());
    if (v) q.set(k, v);
    else q.delete(k);
    for (const [ak, av] of Object.entries(also)) {
      if (av) q.set(ak, av);
      else q.delete(ak);
    }
    q.delete("open");
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  return (
    <div className="mb-4 grid gap-3">
      {extras.notice ? (
        extras.notice.href ? (
          <Link
            href={extras.notice.href}
            className="flex items-center gap-2 rounded-[6px] border border-warn-line bg-warn-soft px-3.5 py-2.5 text-[13px] font-medium text-warn-ink no-underline hover:no-underline"
          >
            {extras.notice.text} →
          </Link>
        ) : (
          <div className="rounded-[6px] border border-line bg-surface px-3.5 py-2.5 text-[13px] text-body">{extras.notice.text}</div>
        )
      ) : null}
      {extras.scope || extras.period ? (
        <div className="flex flex-wrap items-center gap-3">
          {extras.scope && extras.scope.options.length > 1 ? (
            <span className="inline-flex gap-0.5 rounded-[6px] border border-line bg-surface p-[3px]" role="group" aria-label="Whose rows">
              {extras.scope.options.map((o) => (
                <Link
                  key={o}
                  href={withParam("scope", o)}
                  className={cx(
                    "rounded-[4px] px-3 py-1 text-[13px] font-medium no-underline hover:no-underline",
                    o === extras.scope!.current ? "bg-brand text-white" : "text-body hover:bg-canvas",
                  )}
                >
                  {SCOPE_LABEL[o]}
                </Link>
              ))}
            </span>
          ) : null}
          {extras.period ? (
            <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
              {extras.period.label}
              {extras.period.params.map((p) => (
                <label key={p.k} className="flex items-center gap-1.5">
                  <span className="text-xs tracking-[0.04em] uppercase">{p.l}</span>
                  <input
                    type={p.type}
                    defaultValue={p.v}
                    onChange={(e) => router.push(withParam(p.k, e.target.value || null))}
                    className="h-8 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink"
                  />
                </label>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      {extras.paged ? <Paged p={extras.paged} withParam={withParam} /> : null}
      {extras.calendar ? <Calendar c={extras.calendar} rows={rows} withParam={withParam} /> : null}
      {extras.chart ? <Chart c={extras.chart} withParam={withParam} onPick={(k, v) => router.push(withParam(k, v || null))} /> : null}
    </div>
  );
}

/** Server-side search and paging for a list too long to send whole. */
function Paged({ p, withParam }: { p: NonNullable<HrmsExtras["paged"]>; withParam: (k: string, v: string | null, also?: Record<string, string | null>) => string }) {
  const router = useRouter();
  const go = (page: number) => withParam("page", page > 1 ? String(page) : null);
  return (
    <div className="flex flex-wrap items-center gap-3 text-[13px]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = String(new FormData(e.currentTarget).get("q") ?? "").trim();
          router.push(withParam("q", v || null, { page: null }));
        }}
        className="flex items-center gap-2"
      >
        <input
          name="q"
          defaultValue={p.q}
          placeholder={p.placeholder}
          className="h-8 w-[280px] rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink"
        />
        <button type="submit" className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas">
          Search all
        </button>
        {p.q ? (
          <Link href={withParam("q", null, { page: null })} className="text-[13px] text-muted">
            Clear
          </Link>
        ) : null}
      </form>
      <span className="text-muted">
        {p.total ? `${p.from.toLocaleString("en-IN")}–${p.to.toLocaleString("en-IN")} of ${p.total.toLocaleString("en-IN")}` : "None match"}
        {p.pages > 1 ? " · the list below filters this page only" : ""}
      </span>
      {p.pages > 1 ? (
        <span className="inline-flex gap-1">
          {p.page > 1 ? (
            <Link href={go(p.page - 1)} className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-body no-underline hover:no-underline">
              ← Previous
            </Link>
          ) : null}
          <span className="px-1.5 py-1 text-muted">
            Page {p.page} of {p.pages}
          </span>
          {p.page < p.pages ? (
            <Link href={go(p.page + 1)} className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-body no-underline hover:no-underline">
              Next →
            </Link>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function Calendar({ c, rows, withParam }: { c: NonNullable<HrmsExtras["calendar"]>; rows: ListRow[]; withParam: (k: string, v: string | null) => string }) {
  const m = c.month;
  const first = WEEKDAYS.indexOf(weekdayOf(`${m}-01`));
  const dim = daysIn(m);
  const [y, mo] = m.split("-").map(Number);
  const shift = (k: number) => {
    const t = new Date(Date.UTC(y, mo - 1 + k, 1));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const cells = Array.from({ length: 42 }, (_, i) => {
    const dn = i - first + 1;
    const inM = dn >= 1 && dn <= dim;
    const dt = inM ? `${m}-${String(dn).padStart(2, "0")}` : "";
    const bars = inM ? rows.filter((r) => String(r.v[c.from] ?? "") <= dt && String(r.v[c.to] || r.v[c.from] || "") >= dt) : [];
    const hol = inM ? c.holidays?.find((h) => h.date === dt) : undefined;
    return { dn: inM ? dn : null, bars, hol };
  });
  return (
    <div className="overflow-hidden rounded-[8px] border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-divider px-3 py-2">
        <Link href={withParam("month", shift(-1))} className="rounded-[4px] px-2 py-1 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline">
          ← {monLabel(shift(-1))}
        </Link>
        <span className="text-sm font-semibold text-ink">{monLabel(m)}</span>
        <Link href={withParam("month", shift(1))} className="rounded-[4px] px-2 py-1 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline">
          {monLabel(shift(1))} →
        </Link>
      </div>
      <div className="grid grid-cols-7 border-b border-divider bg-canvas">
        {WEEKDAYS.map((w) => (
          <span key={w} className="px-2 py-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            {w.slice(0, 3)}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell, i) => (
          <div key={i} className={cx("min-h-[84px] border-r border-b border-divider p-1", !cell.dn && "bg-canvas/60")}>
            {cell.dn ? <div className="text-[12px] text-muted">{cell.dn}</div> : null}
            {cell.hol ? <div className="truncate text-[11px] text-muted italic">{cell.hol.name}</div> : null}
            {cell.bars.slice(0, 3).map((r) => {
              const tone = TONES[(String(r.v[c.tone] ?? "neutral") as keyof typeof TONES)] ?? TONES.neutral;
              return (
                <Link
                  key={r.id}
                  href={withParam("open", r.id)}
                  style={{ background: tone[0], color: tone[1] }}
                  className="mt-0.5 block truncate rounded-[3px] px-1.5 text-[11px] leading-4 no-underline hover:no-underline"
                >
                  {String(r.v[c.label] ?? "")}
                </Link>
              );
            })}
            {cell.bars.length > 3 ? <div className="text-[11px] text-muted">+{cell.bars.length - 3} more</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function Chart({ c, onPick }: { c: NonNullable<HrmsExtras["chart"]>; withParam: (k: string, v: string | null) => string; onPick: (k: string, v: string) => void }) {
  const W = 640;
  const H = 180;
  const P = 28;
  const s = c.series;
  const mx = Math.max(1, ...s.map((x) => x.v));
  const X = (i: number) => P + i * ((W - P * 2) / Math.max(1, s.length - 1));
  const Y = (v: number) => H - P - (v / mx) * (H - P * 2);
  const path = s.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(x.v).toFixed(1)}`).join(" ");
  const n = s.length;
  const mxx = (n - 1) / 2;
  const my = s.reduce((a, x) => a + x.v, 0) / Math.max(1, n);
  let num = 0;
  let den = 0;
  s.forEach((x, i) => {
    num += (i - mxx) * (x.v - my);
    den += (i - mxx) * (i - mxx);
  });
  const b = den ? num / den : 0;
  const a0 = my - b * mxx;
  const word = b > 0.05 ? "Trending up" : b < -0.05 ? "Trending down" : "Flat";
  const ticks = s.filter((_, i) => i % Math.max(1, Math.ceil(n / 6)) === 0);
  return (
    <div className="rounded-[8px] border border-line bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-muted">{c.caption}</span>
        <span className={cx("text-xs font-semibold", b > 0.05 ? "text-success" : b < -0.05 ? "text-danger" : "text-muted")}>{word}</span>
        <span className="flex-1" />
        {c.pick && c.pick.options.length > 1 ? (
          <select
            value={c.pick.value}
            onChange={(e) => onPick(c.pick!.param, e.target.value)}
            className="h-8 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink"
          >
            {c.pick.options.map((o) => (
              <option key={o.v} value={o.v}>
                {o.l}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {n ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={c.caption}>
          <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="#DDE1E8" />
          <text x={4} y={Y(mx) + 4} fontSize="11" fill="#6B7385">
            {mx}
          </text>
          <path d={path} fill="none" stroke="#6835FB" strokeWidth={2} />
          {n > 1 ? <path d={`M${X(0).toFixed(1)} ${Y(a0).toFixed(1)} L${X(n - 1).toFixed(1)} ${Y(a0 + b * (n - 1)).toFixed(1)}`} stroke="#6B7385" strokeDasharray="4 4" /> : null}
          {s.map((x, i) => (
            <circle key={x.d} cx={X(i)} cy={Y(x.v)} r={3} fill="#6835FB">
              <title>{`${fdShort(x.d)}: ${x.v}`}</title>
            </circle>
          ))}
          {ticks.map((x) => (
            <text key={x.d} x={X(s.indexOf(x))} y={H - 8} fontSize="11" fill="#6B7385" textAnchor="middle">
              {fdShort(x.d)}
            </text>
          ))}
        </svg>
      ) : (
        <div className="py-8 text-center text-[13px] text-muted">Nothing to chart yet.</div>
      )}
      {c.parts ? (
        <div className="mt-3 grid gap-2 border-t border-divider pt-3 sm:grid-cols-3">
          <div className="text-[13px] font-semibold text-ink sm:col-span-3">{c.parts.title}</div>
          {c.parts.items.map((p) => (
            <div key={p.l}>
              <div className="flex justify-between text-[12px] text-body">
                <span>{p.l}</span>
                <span className="text-muted">
                  {Math.round(p.got * 10) / 10} / {p.max}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-[3px] bg-divider">
                <div className="h-1.5 rounded-[3px] bg-brand" style={{ width: `${Math.min(100, Math.round((p.got / Math.max(1, p.max)) * 100))}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
