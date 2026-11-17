"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { useWorkday, type OpResult } from "./workday-context";
import { withLocation } from "./workday-shared";
import { BreakDialog, DayTimeline, PunchOutDialog, ampm } from "./day-parts";
import { at, hmOf, hmsOf, longDur, msOf, OFF_DAY_WORDS } from "./format";

/* ---------------------------------------------------------------------------
 * THE TIMER IN EVERY HEADER. It rides with the notification bell, so every
 * app's header has it from one place, and the launcher draws it beside the
 * account menu. Green while working, amber on a break, red when idle long
 * enough to be warned, grey once the day is done, "Day off" on a day nobody
 * has to work. Clicking it opens the day — the Workday Clock design's "4 ·
 * Clicking the timer" — and its two buttons open the same Start a break and
 * Punch out dialogs the launcher's day card opens.
 * ------------------------------------------------------------------------- */

export function WorkdayChip() {
  const w = useWorkday();
  const [open, setOpen] = React.useState(false);
  const [sheet, setSheet] = React.useState<null | "break" | "out">(null);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  if (!w || !w.state.subject || w.state.onHandset) return null;
  const { state, now, lastActivity } = w;
  const last = state.sessions[state.sessions.length - 1];
  const idleMin = Math.floor((now - lastActivity) / 60_000);

  let chip: { cls: string; dot: React.ReactNode; text: React.ReactNode; label: string };
  const dot = (c: string) => <span className={cx("size-2 rounded-full", c)} />;
  if (state.phase === "none" && state.offDay)
    chip = {
      cls: "bg-surface text-brand-deep border-brand-softer",
      dot: <CalendarGlyph />,
      text: "Day off",
      label: `Today is ${state.holidayName ?? OFF_DAY_WORDS[state.offDay]}. Open your day`,
    };
  else if (state.phase === "none") chip = { cls: "bg-brand text-white border-brand", dot: dot("bg-white"), text: "Punch in", label: "Not punched in. Open your day" };
  else if (state.phase === "working" && idleMin >= state.cfg.warnMinutes)
    chip = { cls: "bg-danger-soft text-danger border-danger/30", dot: dot("bg-danger"), text: `Idle ${idleMin} min`, label: `Idle ${idleMin} minutes. Open your day` };
  else if (state.phase === "working")
    chip = {
      cls: state.offDay ? "bg-brand-soft text-brand-deep border-brand-softer" : "bg-success-soft text-success border-success/30",
      dot: <span className={cx("size-2 rounded-full", state.offDay ? "bg-brand" : "bg-success shadow-[0_0_0_3px_rgba(29,122,69,0.2)]")} />,
      text: (
        <>
          {state.offDay ? "Extra " : null}
          <span className="font-mono tabular-nums">{hmsOf(w.workedMs)}</span>
        </>
      ),
      label: `Worked ${hmOf(w.workedMs)} today. Open your day`,
    };
  else if (state.phase === "break" || state.phase === "auto_break")
    chip = {
      cls: "bg-warn-soft text-warn-ink border-warn-line",
      dot: dot("bg-warn"),
      text: (
        <>
          {state.phase === "auto_break" ? "Auto-break" : (last?.reason?.split(" · ")[0] ?? "Break")} <span className="font-mono tabular-nums">{msOf(now - (last?.out ?? now))}</span>
        </>
      ),
      label: "On a break. Open your day",
    };
  else
    chip = {
      cls: "bg-surface text-muted border-line-strong",
      dot: dot("bg-faint"),
      text: (
        <>
          {state.phase === "auto_out" ? "Punched out · auto" : "Day done"} · <span className="font-mono tabular-nums">{hmOf(w.workedMs)}</span>
        </>
      ),
      label: "Punched out. Open your day",
    };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={chip.label}
        title={chip.label}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "inline-flex h-[34px] items-center gap-2 rounded-full border px-[13px] text-[13px] font-semibold whitespace-nowrap",
          chip.cls,
          open && "shadow-[0_0_0_3px_rgba(29,122,69,0.18)]",
        )}
      >
        {chip.dot}
        {chip.text}
      </button>
      {open ? (
        <div role="dialog" aria-label="Your day" className="absolute top-11 right-0 z-[80] w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] border border-line bg-surface text-ink shadow-[0_18px_44px_rgba(15,27,51,0.22)]">
          <DayPanel
            onBreak={() => {
              setOpen(false);
              setSheet("break");
            }}
            onOut={() => {
              setOpen(false);
              setSheet("out");
            }}
            onDone={() => setOpen(false)}
          />
          <Link href="/hrms/attendance" onClick={() => setOpen(false)} className="block border-t border-divider px-[18px] py-3 text-[13px] font-semibold text-brand hover:underline">
            See my attendance →
          </Link>
        </div>
      ) : null}
      {sheet === "break" ? <BreakDialog onClose={() => setSheet(null)} /> : null}
      {sheet === "out" ? <PunchOutDialog withLocation={withLocation} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

function CalendarGlyph() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

const PHASE_PILL: Record<string, { text: string; cls: string }> = {
  none: { text: "Not punched in", cls: "bg-brand-soft text-brand-deep" },
  working: { text: "Working", cls: "bg-success-soft text-success" },
  break: { text: "On a break", cls: "bg-warn-soft text-warn-ink" },
  auto_break: { text: "Auto-break", cls: "bg-warn-soft text-warn-ink" },
  auto_out: { text: "Punched out · auto", cls: "bg-danger-soft text-danger" },
  done: { text: "Punched out", cls: "bg-canvas text-muted" },
};

/** The day and what can be done with it — the header timer's menu. */
export function DayPanel({ onBreak, onOut, onDone }: { onBreak: () => void; onOut: () => void; onDone?: () => void }) {
  const w = useWorkday()!;
  const { state } = w;
  const [res, setRes] = React.useState<OpResult | null>(null);
  const breaksMs = state.breaks.reduce((n, b) => n + ((b.to ?? w.now) - b.from), 0);
  const reasons = [...new Set(state.breaks.map((b) => (b.kind === "auto_break" ? "Auto-break" : b.kind === "away" ? "Away" : (b.reason?.split(" · ")[0] ?? "Break"))))];
  const toGo = Math.max(0, state.presentMin * 60_000 - w.workedMs);
  const first = state.sessions[0]?.in ?? null;
  const pill = state.phase === "working" && state.offDay ? { text: "Extra work", cls: "bg-brand-soft text-brand-deep" } : PHASE_PILL[state.phase];
  const ended = state.phase === "done" || state.phase === "auto_out";

  const done = (r: OpResult) => {
    setRes(r);
    if (r.ok) onDone?.();
  };

  return (
    <div className="grid gap-3.5 px-[18px] pt-[18px] pb-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-bold">Today</span>
        <span className={cx("rounded-full px-2.5 py-[3px] text-[12px] font-semibold", pill.cls)}>{pill.text}</span>
      </div>
      {state.offDay ? (
        <div className="rounded-[10px] bg-brand-soft px-3 py-2 text-[12.5px] text-brand-deep">
          Today is {state.holidayName ?? OFF_DAY_WORDS[state.offDay]}. Hours you work are recorded as extra work.
        </div>
      ) : null}
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[40px] font-semibold tracking-[-0.02em] tabular-nums">{hmOf(w.workedMs)}</span>
        <span className="text-[13px] text-muted">{state.offDay ? "worked today" : `worked · present at ${hmOf(state.presentMin * 60_000)}`}</span>
      </div>
      {first ? <DayTimeline /> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">Punched in</dt>
        <dd className="font-medium">{first ? at(first) : "Not yet"}</dd>
        <dt className="text-muted">Breaks</dt>
        <dd className="font-medium">{state.breaks.length ? `${longDur(breaksMs)} · ${reasons.join(", ")}` : "None"}</dd>
        {!state.offDay && !ended ? (
          <>
            <dt className="text-muted">To be present</dt>
            <dd className="font-medium">
              {toGo ? `${longDur(toGo)} more` : "Done ✓"}
              {state.officialOut ? ` · office closes ${ampm(state.officialOut)}` : ""}
            </dd>
          </>
        ) : null}
      </dl>
      {res && !res.ok ? (
        <div className="rounded-[8px] bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
          {res.error}
          {res.detail ? ` — ${res.detail}` : ""}
        </div>
      ) : null}
      {state.phase === "working" ? (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onBreak} className="flex h-11 items-center justify-center gap-[7px] rounded-[10px] border border-warn-line bg-warn-soft text-[14px] font-bold text-warn-ink">
            <CupGlyph />
            Start a break
          </button>
          <button type="button" onClick={onOut} className="flex h-11 items-center justify-center gap-[7px] rounded-[10px] border border-danger/40 bg-surface text-[14px] font-bold text-danger">
            <OutGlyph />
            Punch out
          </button>
        </div>
      ) : state.phase === "break" || state.phase === "auto_break" ? (
        <button type="button" disabled={w.busy} onClick={async () => done(await w.act({ op: "resume" }))} className="h-11 rounded-[10px] bg-brand text-[14px] font-bold text-white">
          Resume work
        </button>
      ) : (
        <button type="button" disabled={w.busy} onClick={async () => done(await withLocation((fix) => w.act({ op: "punchIn", ...fix })))} className="h-11 rounded-[10px] bg-brand text-[14px] font-bold text-white">
          {state.phase === "none" ? (state.offDay ? "Punch in for extra work" : "Punch in") : "Punch in again"}
        </button>
      )}
    </div>
  );
}

export function CupGlyph() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 8h1a4 4 0 0 1 0 8h-1" />
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z" />
      <path d="M6 2v3M10 2v3M14 2v3" />
    </svg>
  );
}

export function OutGlyph() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </svg>
  );
}
