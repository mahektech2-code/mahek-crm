"use client";

import Link from "next/link";
import { useState } from "react";
import { addDays, daysBetween } from "@/lib/format";
import { CATEGORIES } from "@/lib/locker/catalogue";
import { CRIT, addMonthsIso } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { C, Chip, PageHead, Segmented, fd, nf } from "../_ui/kit";

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
      <div style={{ padding: "0 24px 48px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Segmented opts={[{ key: "month", label: "Month" }, { key: "line", label: "12-month timeline" }]} value={mode} onPick={setMode} />
          {mode === "month" ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
              <button type="button" onClick={() => setMo(mo - 1)} style={{ width: 30, height: 30, border: `1px solid ${C.line}`, background: "#FFFFFF", borderRadius: 4, cursor: "pointer" }}>
                ‹
              </button>
              <span style={{ fontSize: 15, fontWeight: 600, color: C.ink, minWidth: 130, textAlign: "center" }}>
                {MON[m - 1]} {y}
              </span>
              <button type="button" onClick={() => setMo(mo + 1)} style={{ width: 30, height: 30, border: `1px solid ${C.line}`, background: "#FFFFFF", borderRadius: 4, cursor: "pointer" }}>
                ›
              </button>
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {([
            [0, "All"],
            [3, "High and above"],
            [4, "Business critical"],
          ] as [number, string][]).map(([k, l]) => (
            <Chip key={k} label={l} on={cf === k} onFlip={() => setCf(k)} />
          ))}
        </div>

        {mode === "month" ? (
          <div style={{ background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", background: C.canvas, borderBottom: `1px solid ${C.line}` }}>
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
                <span key={w} style={{ padding: "8px 10px", fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted }}>
                  {w}
                </span>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))" }}>
              {Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => {
                const dn = i - lead + 1;
                if (dn < 1 || dn > days) return <div key={i} style={{ minHeight: 104, borderTop: `1px solid ${C.line3}`, borderLeft: `1px solid ${C.line3}`, background: C.canvas }} />;
                const iso = `${y}-${String(m).padStart(2, "0")}-${String(dn).padStart(2, "0")}`;
                const off = daysBetween(today, iso);
                const its = (byDay.get(iso) ?? []).slice().sort((a, b) => b.crit - a.crit);
                const heavy = its.some((a) => a.crit === 4);
                return (
                  <div key={i} style={{ minHeight: 104, padding: 6, borderTop: `1px solid ${C.line3}`, borderLeft: `1px solid ${C.line3}`, background: heavy ? "#FFF8F8" : "#FFFFFF", boxShadow: heavy ? `inset 0 3px 0 ${C.red}` : "none" }}>
                    <span style={{ fontSize: 12, fontWeight: off === 0 ? 700 : 500, color: off === 0 ? "#FFFFFF" : off < 0 ? C.faint : C.ink, background: off === 0 ? C.brand : "transparent", borderRadius: 10, padding: off === 0 ? "1px 6px" : 0 }}>{dn}</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                      {its.slice(0, 3).map((a) => (
                        <Link
                          key={a.id}
                          href={`/locker/assets/${a.id}`}
                          title={`${a.title} · ${CRIT[a.crit].label}`}
                          style={{ display: "flex", alignItems: "center", gap: 5, width: "100%", padding: "2px 4px", borderRadius: 3, background: a.crit === 4 ? "#FBEAEA" : "transparent", fontSize: 11, fontWeight: a.crit === 4 ? 600 : 400, color: a.crit === 4 ? C.redInk : C.body, textAlign: "left", textDecoration: "none" }}
                        >
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: CRIT[a.crit].edge, flex: "none" }} />
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</span>
                        </Link>
                      ))}
                      {its.length > 3 ? <span style={{ fontSize: 11, color: C.muted, paddingLeft: 4 }}>+{its.length - 3} more</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", borderBottom: `1px solid ${C.line}`, background: C.canvas }}>
              <span />
              <div style={{ position: "relative", height: 30 }}>
                {Array.from({ length: 12 }, (_, i) => {
                  const ms = addMonthsIso(`${today.slice(0, 7)}-01`, i + 1);
                  const d0 = daysBetween(today, ms);
                  return (
                    <span key={i} style={{ position: "absolute", left: `${Math.max(0, (d0 / W) * 100)}%`, top: 8, fontSize: 11, color: C.muted, paddingLeft: 4, borderLeft: `1px solid ${C.line}`, height: 22 }}>
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
                <div key={c.slug} style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", borderTop: `1px solid ${C.line3}` }}>
                  <span style={{ padding: "10px 14px", fontSize: 13, fontWeight: 500, color: C.ink }}>
                    {c.name}
                    <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: C.muted }}>{nf(its.length)} in 12 months</span>
                  </span>
                  <div style={{ position: "relative", height: 44, borderLeft: `1px solid ${C.line3}` }}>
                    {its.map((a) => {
                      const sz = ({ 4: 12, 3: 9, 2: 7, 1: 6 } as Record<number, number>)[a.crit];
                      return (
                        <Link
                          key={a.id}
                          href={`/locker/assets/${a.id}`}
                          title={`${a.title} · ${fd(a.actionDate)}`}
                          aria-label={`${a.title} · ${fd(a.actionDate)}`}
                          style={{ position: "absolute", left: `calc(${((a.actionIn ?? 0) / W) * 100}% - ${sz / 2}px)`, top: 22 - sz / 2, width: sz, height: sz, borderRadius: a.crit === 4 ? 2 : "50%", border: "1.5px solid #FFFFFF", background: CRIT[a.crit].edge, padding: 0 }}
                        />
                      );
                    })}
                    {[...mc.entries()]
                      .filter(([, n]) => n >= 3)
                      .map(([k, n]) => (
                        <span key={k} style={{ position: "absolute", left: `${((k * 30.4) / W) * 100}%`, top: 2, fontSize: 10, fontWeight: 600, color: C.redInk, background: "#FBEAEA", padding: "0 4px", borderRadius: 3 }}>
                          {n} in {MON[Number(addDays(today, Math.round(k * 30.4)).slice(5, 7)) - 1]}
                        </span>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
