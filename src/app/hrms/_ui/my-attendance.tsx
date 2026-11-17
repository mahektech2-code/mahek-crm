import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { nowMs } from "@/lib/format";
import type { HrmsContext } from "@/lib/hrms/access";
import { today } from "@/lib/hrms/server";
import { approvedLeave, attendanceCfg, attendanceRows, holidays } from "@/lib/hrms/services/attendance";
import { timingMap } from "@/lib/hrms/services/people";
import { approvedSpans, sessionsOf } from "@/lib/hrms/services/workday";
import { breaksOf, phaseOf, workedMs } from "@/lib/hrms/engines/workday";
import { holidayApplies } from "@/lib/hrms/engines/leave";
import { calendarCells, monthDays, monthFigures, shiftMonth, type MonthDay } from "@/lib/hrms/engines/attendance-month";
import { addDaysISO, fdShort, nowHM, weekdayOf } from "@/lib/hrms/time";
import { hrmsLink } from "@/lib/hrms/registry";
import { HELP } from "@/lib/hrms/values";

/* ---------------------------------------------------------------------------
 * MY ATTENDANCE, the Workday Clock design's board 12: the month's figures, a
 * calendar with a tile per day, and the chosen day drawn as its stretches.
 * Read-only — a day that is wrong is corrected by asking, from its panel.
 * ------------------------------------------------------------------------- */

const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hmm = (min: number | null | undefined) => (min == null ? "—" : `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, "0")}`);
const ampm = (t: string | null | undefined) => {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
const wd = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(new Date(`${d}T00:00:00Z`));
const longDay = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" }).format(new Date(`${d}T00:00:00Z`));

const TILE: Record<MonthDay["kind"], string> = {
  full: "border-success/25 bg-success-soft",
  half: "border-warn-line bg-warn-soft",
  absent: "border-danger/25 bg-danger-soft",
  off: "border-line bg-canvas",
  leave: "border-line bg-canvas",
  holiday: "border-line bg-canvas",
  extra: "border-brand-softer bg-brand-soft",
  today: "border-brand bg-surface",
  future: "border-line bg-surface",
};

const VERDICT: Partial<Record<MonthDay["kind"], { l: string; cls: string }>> = {
  full: { l: "Present", cls: "bg-success-soft text-success" },
  half: { l: "Half day", cls: "bg-warn-soft text-warn-ink" },
  absent: { l: "Absent", cls: "bg-danger-soft text-danger" },
  extra: { l: "Extra work", cls: "bg-brand-soft text-brand-deep" },
  today: { l: "Working", cls: "bg-canvas text-muted" },
  off: { l: "Week off", cls: "bg-canvas text-muted" },
  leave: { l: "Leave", cls: "bg-canvas text-muted" },
  holiday: { l: "Holiday", cls: "bg-canvas text-muted" },
};

export async function MyAttendanceView({ ctx, sp }: { ctx: HrmsContext; sp: Record<string, string | undefined> }) {
  const me = ctx.employee;
  if (!me)
    return <Note>Your account is not linked to an employee record in HRMS, so there is no attendance to show. Ask HR to link it.</Note>;
  const t = today();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : t.slice(0, 7);
  const cells = calendarCells(month);
  const dates = cells.filter((c): c is string => !!c);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const now = nowMs();

  const [rows, hols, leave, timings, acfg] = await Promise.all([attendanceRows({ employeeIds: [me.id], from, to }), holidays(from, to), approvedLeave([me.id]), timingMap(), attendanceCfg()]);
  const hasTimings = [...timings.keys()].some((k) => k.startsWith(`${me.id}|`));
  const worked = new Map<string, { workDay: string; workedMin: number | null; open: boolean; lateBeyondGrace: boolean }>();
  const byDate = new Map(rows.map((r) => [r.date, r]));
  for (const r of rows) {
    const s = sessionsOf(r as never);
    const open = r.date === t && s.length > 0 && (phaseOf(s) === "working" || phaseOf(s) === "break" || phaseOf(s) === "auto_break");
    const live = r.date === t && s.length ? Math.floor(workedMs(s, now, await approvedSpans(r.id)) / 60_000) : null;
    worked.set(r.date, { workDay: r.fig.workDay, workedMin: live ?? r.fig.workedMin, open: open || (r.date === t && !r.checkOut), lateBeyondGrace: r.fig.lateBeyondGrace });
  }
  const holidayMap = new Map(hols.filter((h) => holidayApplies(h, me.id, me.office)).map((h) => [h.date, h.name]));
  const leaveSet = new Set<string>();
  for (const l of leave) if (l.type !== "Half Day") for (let d = l.startDate; d <= l.endDate; d = addDaysISO(d, 1)) leaveSet.add(d);
  const days = monthDays({ dates, today: t, worked, holidays: holidayMap, leave: leaveSet, workingDay: (d) => !hasTimings || timings.has(`${me.id}|${weekdayOf(d)}`) });
  const fig = monthFigures(days, t);
  const dayMap = new Map(days.map((d) => [d.date, d]));

  const chosen =
    sp.day && dayMap.has(sp.day)
      ? sp.day
      : [...days].reverse().find((d) => d.date <= t && (d.kind === "full" || d.kind === "half" || d.kind === "extra" || d.kind === "today"))?.date ?? null;
  const sel = chosen ? dayMap.get(chosen)! : null;
  const row = chosen ? byDate.get(chosen) : undefined;
  const sessions = row ? sessionsOf(row as never) : [];
  const segs = [
    ...sessions.map((s) => ({ kind: "work" as const, from: s.in, to: s.out ?? now, what: "Work" })),
    ...breaksOf(sessions, now).map((b) => ({ kind: b.kind, from: b.from, to: b.to ?? now, what: b.kind === "auto_break" ? "Auto-break · no activity" : b.kind === "away" ? "Away" : (b.reason ?? "Break") })),
  ].sort((a, b) => a.from - b.from);
  const breaksMin = segs.filter((s) => s.kind !== "work").reduce((n, s) => n + (s.to - s.from), 0) / 60_000;
  const span0 = segs[0]?.from;
  const span1 = segs.reduce((m, s) => Math.max(m, s.to), span0 ?? 0);
  const clock = (ms: number) => nowHM(new Date(ms));

  const [y, m] = month.split("-").map(Number);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const base = hrmsLink("myAttendance");
  const href = (q: Record<string, string>) => `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(q).toString()}`;
  const names = (ds: string[]) => ds.slice(0, 3).map((d) => `${wd(d)} ${Number(d.slice(8))}`).join(" · ") + (ds.length > 3 ? ` +${ds.length - 3}` : "");
  const nc = [fig.notCounted.off && `${fig.notCounted.off} week off`, fig.notCounted.holiday && `${fig.notCounted.holiday} holiday`, fig.notCounted.leave && `${fig.notCounted.leave} day leave`].filter(Boolean).join(" · ");

  const cards = [
    { k: "Present", v: String(fig.present), s: `of ${fig.workingDaysSoFar} working days` },
    { k: "Half day", v: String(fig.half.length), s: fig.half.length ? names(fig.half) : "None" },
    { k: "Absent", v: String(fig.absent.length), s: fig.absent.length ? `${names(fig.absent)} · not in` : "None" },
    { k: "Not counted", v: String(fig.notCounted.off + fig.notCounted.holiday + fig.notCounted.leave), s: nc || "None so far" },
    { k: "Average worked", v: hmm(fig.averageWorkedMin), s: `present at ${hmm(acfg.presentMin)}` },
    { k: "Extra work", v: hmm(fig.extraMin), s: fig.extraDates.length ? `${names(fig.extraDates)} · day off` : "None" },
  ];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={href({ month: prev })} className="flex h-9 items-center rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-canvas">
          ‹ {SHORT[Number(prev.slice(5)) - 1]}
        </Link>
        <span className="min-w-[130px] text-center text-[15px] font-bold text-ink">
          {MON[m - 1]} {y}
        </span>
        <Link href={href({ month: next })} className="flex h-9 items-center rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-canvas">
          {SHORT[Number(next.slice(5)) - 1]} ›
        </Link>
      </div>

      <CardGrid min={150} gap="gap-3">
        {cards.map((c) => (
          <div key={c.k} className="rounded-[12px] border border-line bg-surface px-4 py-3">
            <div className="text-[12px] text-muted">{c.k}</div>
            <div className="font-mono text-[24px] font-semibold text-ink tabular-nums">{c.v}</div>
            <div className="truncate text-[12px] text-muted">{c.s}</div>
          </div>
        ))}
      </CardGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-label="Calendar" className="rounded-[14px] border border-line bg-surface p-4">
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-muted">
            <Legend cls="bg-success" l={`Present · ${hmm(acfg.presentMin)} hours or more`} />
            <Legend cls="bg-warn" l={`Half day · ${hmm(acfg.halfMin)} to ${hmm(acfg.presentMin)} hours`} />
            <Legend cls="bg-danger" l={`Absent · under ${hmm(acfg.halfMin)} hours or not in`} />
            <Legend cls="bg-line-strong" l="Not counted · week off, holiday, leave" />
            <Legend cls="bg-brand" l="Extra work on a day off" />
          </div>
          <div className="grid grid-cols-7 gap-1.5 text-center text-[11.5px] font-semibold text-muted">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="mt-1.5 grid grid-cols-7 gap-1.5">
            {cells.map((c, i) => {
              if (!c) return <div key={`b${i}`} />;
              const d = dayMap.get(c)!;
              const selected = c === chosen;
              return (
                <Link
                  key={c}
                  href={href({ month, day: c })}
                  aria-current={selected ? "date" : undefined}
                  className={cx(
                    "flex min-h-[64px] flex-col justify-between rounded-[10px] border p-2 text-left",
                    TILE[d.kind],
                    selected && "ring-2 ring-brand ring-offset-1",
                  )}
                >
                  <span className="text-[12.5px] font-semibold text-ink">
                    {Number(c.slice(8))}
                    {d.kind === "today" ? <span className="ml-1 rounded bg-brand px-1 text-[9.5px] font-bold text-white">TODAY</span> : null}
                  </span>
                  <span className="truncate text-[11.5px] text-body">{tileText(d)}</span>
                </Link>
              );
            })}
          </div>
        </section>

        <section aria-label={chosen ? longDay(chosen) : "A day"} className="grid content-start gap-3 rounded-[14px] border border-line bg-surface p-4">
          {sel ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[16px] font-bold text-ink">{longDay(sel.date)}</h2>
                {VERDICT[sel.kind] ? <span className={cx("rounded-full px-2.5 py-0.5 text-[12px] font-bold", VERDICT[sel.kind]!.cls)}>{VERDICT[sel.kind]!.l}</span> : null}
              </div>
              <div className="grid grid-cols-[1fr_1fr_1.6fr] gap-2">
                <Fact l="Worked" v={hmm(sel.workedMin)} />
                <Fact l="Breaks" v={segs.length ? hmm(breaksMin) : row ? hmm(row.stoppageMin) : "—"} />
                <Fact l="In · out" v={row ? `${ampm(row.checkIn)} · ${row.checkOut ? ampm(row.checkOut) : "—"}` : "—"} />
              </div>
              {span0 != null ? (
                <>
                  <div className="relative h-3 overflow-hidden rounded-[5px] bg-divider">
                    {segs.map((s) => (
                      <span
                        key={`${s.kind}${s.from}`}
                        className={cx("absolute inset-y-0", s.kind === "work" ? "bg-success" : s.kind === "break" ? "bg-warn" : s.kind === "auto_break" ? "bg-warn/60" : "bg-faint")}
                        style={{ left: `${((s.from - span0) / Math.max(1, span1 - span0)) * 100}%`, width: `${Math.max(0.5, ((s.to - s.from) / Math.max(1, span1 - span0)) * 100)}%` }}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
                    <Legend cls="bg-success" l="Work" />
                    <Legend cls="bg-warn" l="Break" />
                    <Legend cls="bg-warn/60" l="Auto-break" />
                    <Legend cls="bg-faint" l="Away" />
                  </div>
                  <div className="grid gap-1.5">
                    {segs.map((s) => (
                      <div key={`l${s.kind}${s.from}`} className="grid grid-cols-[1fr_auto_auto] gap-3 text-[13px]">
                        <span className={s.kind === "work" ? "font-medium text-ink" : "text-body"}>{s.what}</span>
                        <span className="font-mono text-[12px] text-muted">
                          {clock(s.from)} – {clock(s.to)}
                        </span>
                        <span className="w-12 text-right font-mono text-[12.5px] font-semibold text-ink">{hmm((s.to - s.from) / 60_000)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : row ? (
                <p className="text-[13px] text-muted">This day was recorded {row.id.startsWith("mbos:") ? "on the field app" : "before the workday clock"}, so only the punch-in and punch-out are known.</p>
              ) : null}
              {sel.date <= t && sel.kind !== "today" ? (
                <Link
                  href={`${hrmsLink("help")}${hrmsLink("help").includes("?") ? "&" : "?"}${new URLSearchParams({ new: "1", type: HELP.forgotCheckOut, text: `About ${fdShort(sel.date)}: ` }).toString()}`}
                  className="flex h-10 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-[13.5px] font-semibold text-ink hover:bg-canvas"
                >
                  Ask to correct this day
                </Link>
              ) : null}
            </>
          ) : (
            <p className="text-[13px] text-muted">Pick a day on the calendar to see it.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function tileText(d: MonthDay): string {
  switch (d.kind) {
    case "full":
      return hmm(d.workedMin);
    case "half":
      return `${hmm(d.workedMin)} · half day`;
    case "absent":
      return d.workedMin ? `${hmm(d.workedMin)} · absent` : "Absent";
    case "off":
      return "Week off";
    case "leave":
      return "Leave";
    case "holiday":
      return d.label ?? "Holiday";
    case "extra":
      return `+${hmm(d.workedMin)} extra`;
    case "today":
      return d.workedMin != null ? `${hmm(d.workedMin)} ▸` : "";
    default:
      return "";
  }
}

function Legend({ cls, l }: { cls: string; l: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx("size-2.5 rounded-[3px]", cls)} />
      {l}
    </span>
  );
}

function Fact({ l, v }: { l: string; v: string }) {
  return (
    <div className="rounded-[10px] bg-canvas px-3 py-2">
      <div className="text-[11.5px] text-muted">{l}</div>
      <div className="font-mono text-[14px] font-semibold text-ink">{v}</div>
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[10px] border border-line bg-surface px-4 py-3 text-[13px] text-body">{children}</div>;
}
