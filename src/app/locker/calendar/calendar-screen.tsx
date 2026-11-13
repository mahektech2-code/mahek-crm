"use client";

import Link from "next/link";
import { useState } from "react";
import { addDays, daysBetween } from "@/lib/format";
import { CATEGORIES } from "@/lib/locker/catalogue";
import { CRIT, addMonthsIso } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { Card, cx } from "@/components/ui/primitives";
import { Chip, PageHead, Segmented, fd, nf } from "../_ui/kit";

/* ---------------------------------------------------------------------------
 * THE END DATE CALENDAR. Days carry importance-coloured marks on the day
 * somebody must ACT (a contract's notice deadline, not its end); a business-
 * critical date makes its day heavier. The timeline shows clustering — four
 * licences in one month is a resourcing problem.
 * ------------------------------------------------------------------------- */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function CalendarScreen({ rows, today, cats }: { rows: AssetLite[]; today: string; cats: string[] }) {
  const [mode, setMode] = useState<"month" | "line">("month");
  const [cf, setCf] = useState(0);
  const [mo, setMo] = useState(0);
  const L = rows.filter((a) => !cf || a.crit >= cf);
  const first = addMonthsIso(`${today.slice(0, 7)}-01`, mo);
  const [y, m] = first.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const byDay = new Map<string, AssetLite[]>();
  for (const a of L) if (a.actionDate) byDay.set(a.actionDate, [...(byDay.get(a.actionDate) ?? []), a]);
  const W = 365;

  return (
    <>
      <PageHead
        crumb="Locker · Overview"
        title="End date calendar"
        sub="Days carry importance-coloured marks; a business-critical end date makes its day heavier. The timeline shows clustering — four licences in one month is a resourcing problem."
      />
      <div className="flex flex-col gap-4 px-6 pb-12">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented opts={[{ key: "month", label: "Month" }, { key: "line", label: "12-month timeline" }]} value={mode} onPick={setMode} />
          {mode === "month" ? (
            <span className="ml-2 flex items-center gap-1.5">
              <button type="button" aria-label="Previous month" onClick={() => setMo(mo - 1)} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-control border border-line bg-surface text-body hover:bg-canvas">
                ‹
              </button>
              <span className="min-w-[130px] text-center text-[15px] font-semibold text-ink">
                {MON[m - 1]} {y}
              </span>
              <button type="button" aria-label="Next month" onClick={() => setMo(mo + 1)} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-control border border-line bg-surface text-body hover:bg-canvas">
                ›
              </button>
            </span>
          ) : null}
          <span className="flex-1" />
          {([
            [0, "All"],
            [3, "High and above"],
            [4, "Business critical"],
          ] as [number, string][]).map(([k, l]) => (
            <Chip key={k} label={l} on={cf === k} onFlip={() => setCf(k)} />
          ))}
        </div>

        {mode === "month" ? (
          <Card className="overflow-hidden">
            <div className="grid grid-cols-7 border-b border-line bg-page">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
                <span key={w} className="px-2.5 py-2 text-xs font-medium tracking-label text-muted uppercase">
                  {w}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => {
                const dn = i - lead + 1;
                if (dn < 1 || dn > days) return <div key={i} className="min-h-[104px] border-t border-l border-divider bg-page" />;
                const iso = `${y}-${String(m).padStart(2, "0")}-${String(dn).padStart(2, "0")}`;
                const off = daysBetween(today, iso);
                const its = (byDay.get(iso) ?? []).slice().sort((a, b) => b.crit - a.crit);
                const heavy = its.some((a) => a.crit === 4);
                return (
                  <div key={i} className={cx("min-h-[104px] border-t border-l border-divider p-1.5", heavy ? "bg-danger-soft/40 shadow-[inset_0_3px_0_var(--color-danger)]" : "bg-surface")}>
                    <span className={cx("text-xs", off === 0 ? "rounded-full bg-brand px-1.5 py-px font-bold text-white" : off < 0 ? "font-medium text-faint" : "font-medium text-ink")}>{dn}</span>
                    <div className="mt-1 flex flex-col gap-[3px]">
                      {its.slice(0, 3).map((a) => (
                        <Link
                          key={a.id}
                          href={`/locker/assets/${a.id}`}
                          title={`${a.title} · ${CRIT[a.crit].label}`}
                          className={cx("flex w-full items-center gap-1.5 rounded-[3px] px-1 py-0.5 text-left text-2xs no-underline hover:underline", a.crit === 4 ? "bg-danger-soft font-semibold text-danger" : "text-body")}
                        >
                          <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: CRIT[a.crit].edge }} />
                          <span className="min-w-0 flex-1 truncate">{a.title}</span>
                        </Link>
                      ))}
                      {its.length > 3 ? <span className="pl-1 text-2xs text-muted">+{its.length - 3} more</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="grid grid-cols-[200px_minmax(0,1fr)] border-b border-line bg-page">
              <span />
              <div className="relative h-[30px]">
                {Array.from({ length: 12 }, (_, i) => {
                  const ms = addMonthsIso(`${today.slice(0, 7)}-01`, i + 1);
                  const d0 = daysBetween(today, ms);
                  return (
                    <span key={i} className="absolute top-2 h-[22px] border-l border-line pl-1 text-2xs text-muted" style={{ left: `${Math.max(0, (d0 / W) * 100)}%` }}>
                      {MON[Number(ms.slice(5, 7)) - 1]}
                      {ms.slice(5, 7) === "01" ? ` ${ms.slice(2, 4)}` : ""}
                    </span>
                  );
                })}
              </div>
            </div>
            {CATEGORIES.filter((c) => cats.includes(c.slug)).map((c) => {
              const its = L.filter((a) => a.category === c.slug && a.actionIn != null && a.actionIn >= 0 && a.actionIn <= W);
              const mc = new Map<number, number>();
              its.filter((a) => a.crit >= 3).forEach((a) => {
                const k = Math.floor((a.actionIn ?? 0) / 30.4);
                mc.set(k, (mc.get(k) ?? 0) + 1);
              });
              return (
                <div key={c.slug} className="grid grid-cols-[200px_minmax(0,1fr)] border-t border-divider">
                  <span className="px-3.5 py-2.5 text-[13px] font-medium text-ink">
                    {c.name}
                    <span className="block text-2xs font-normal text-muted">{nf(its.length)} in 12 months</span>
                  </span>
                  <div className="relative h-11 border-l border-divider">
                    {its.map((a) => {
                      const sz = ({ 4: 12, 3: 9, 2: 7, 1: 6 } as Record<number, number>)[a.crit];
                      return (
                        <Link
                          key={a.id}
                          href={`/locker/assets/${a.id}`}
                          title={`${a.title} · ${fd(a.actionDate)}`}
                          aria-label={`${a.title} · ${fd(a.actionDate)}`}
                          className={cx("absolute border-[1.5px] border-surface p-0", a.crit === 4 ? "rounded-[2px]" : "rounded-full")}
                          style={{ left: `calc(${((a.actionIn ?? 0) / W) * 100}% - ${sz / 2}px)`, top: 22 - sz / 2, width: sz, height: sz, background: CRIT[a.crit].edge }}
                        />
                      );
                    })}
                    {[...mc.entries()]
                      .filter(([, n]) => n >= 3)
                      .map(([k, n]) => (
                        <span key={k} className="absolute top-0.5 rounded-[3px] bg-danger-soft px-1 text-[10px] font-semibold text-danger" style={{ left: `${((k * 30.4) / W) * 100}%` }}>
                          {n} in {MON[Number(addDays(today, Math.round(k * 30.4)).slice(5, 7)) - 1]}
                        </span>
                      ))}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>
    </>
  );
}
