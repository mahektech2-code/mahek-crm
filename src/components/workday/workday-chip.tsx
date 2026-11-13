"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { useWorkday, type OpResult } from "./workday-context";
import { withLocation, VerdictPill } from "./workday-overlays";
import { at, hmOf, hmsOf, msOf, OFF_DAY_WORDS, VERDICT_WORDS } from "./format";

/* ---------------------------------------------------------------------------
 * THE TIMER IN EVERY HEADER. It rides with the notification bell, so every
 * app's header has it from one place, and the launcher draws it beside the
 * account menu. Green while working, amber on a break, red when idle long
 * enough to be warned, grey once the day is done. Clicking it opens the day
 * with the two things you can do: start a break, or punch out.
 * ------------------------------------------------------------------------- */

export function WorkdayChip() {
  const w = useWorkday();
  const [open, setOpen] = React.useState(false);
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

  let chip: { cls: string; dot: string; text: React.ReactNode; label: string };
  if (state.phase === "none")
    chip = { cls: "bg-brand text-white border-brand", dot: "bg-white", text: state.offDay ? "Punch in for extra work" : "Punch in", label: "Not punched in. Open your day" };
  else if (state.phase === "working" && idleMin >= state.cfg.warnMinutes)
    chip = { cls: "bg-danger-soft text-danger border-danger/30", dot: "bg-danger", text: `Idle ${idleMin} min`, label: `Idle ${idleMin} minutes. Open your day` };
  else if (state.phase === "working")
    chip = {
      cls: state.offDay ? "bg-brand-soft text-brand-deep border-brand-softer" : "bg-success-soft text-success border-success/30",
      dot: state.offDay ? "bg-brand" : "bg-success",
      text: (
        <>
          {state.offDay ? "Extra " : null}
          <span className="tabular-nums">{hmsOf(w.workedMs)}</span>
        </>
      ),
      label: `Worked ${hmOf(w.workedMs)} today. Open your day`,
    };
  else if (state.phase === "break" || state.phase === "auto_break")
    chip = {
      cls: "bg-warn-soft text-warn-ink border-warn-line",
      dot: "bg-warn",
      text: (
        <>
          {state.phase === "auto_break" ? "Auto-break" : (last?.reason ?? "Break")} <span className="tabular-nums">{msOf(now - (last?.out ?? now))}</span>
        </>
      ),
      label: "On a break. Open your day",
    };
  else
    chip = {
      cls: "bg-surface text-muted border-line-strong",
      dot: "bg-faint",
      text: (
        <>
          {state.phase === "auto_out" ? "Punched out · auto" : "Day done"} · <span className="tabular-nums">{hmOf(w.workedMs)}</span>
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
        className={cx("inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12.5px] font-semibold whitespace-nowrap", chip.cls)}
      >
        <span className={cx("size-2 rounded-full", chip.dot)} />
        {chip.text}
      </button>
      {open ? <DayMenu onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function DayMenu({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Your day" className="absolute top-10 right-0 z-[80] w-[340px] overflow-hidden rounded-[14px] border border-line bg-surface text-ink shadow-[0_18px_44px_rgba(15,27,51,0.22)]">
      <DayPanel onDone={onClose} />
      <Link href="/hrms/attendance" onClick={onClose} className="block border-t border-divider px-[18px] py-3 text-[13px] font-semibold text-brand hover:underline">
        See my attendance →
      </Link>
    </div>
  );
}

/** The day and what can be done with it — in the header's menu and on the launcher's card. */
export function DayPanel({ onDone }: { onDone?: () => void }) {
  const w = useWorkday()!;
  const { state } = w;
  const [step, setStep] = React.useState<"day" | "break" | "out">("day");
  const [reason, setReason] = React.useState<string | null>(null);
  const [res, setRes] = React.useState<OpResult | null>(null);
  const v = state.verdict ? VERDICT_WORDS[state.verdict] : null;
  const breaks = state.breaks.reduce((n, b) => n + ((b.to ?? w.now) - b.from), 0);
  const toGo = Math.max(0, state.presentMin * 60_000 - w.workedMs);
  const pct = Math.min(100, Math.round((w.workedMs / (state.presentMin * 60_000)) * 100));

  const done = (r: OpResult) => {
    setRes(r);
    if (r.ok) {
      setStep("day");
      onDone?.();
    }
  };

  return (
      <div className="grid gap-3.5 p-[18px]">
        {step === "day" ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-bold">Today</span>
              {v ? <VerdictPill v={v} /> : null}
            </div>
            {state.offDay ? (
              <div className="rounded-[10px] bg-brand-soft px-3 py-2 text-[12.5px] text-brand-deep">
                Today is {state.holidayName ?? OFF_DAY_WORDS[state.offDay]}. Hours you work are recorded as extra work.
              </div>
            ) : null}
            <div className="flex items-baseline gap-2">
              <span className="text-[38px] font-semibold tracking-[-0.02em] tabular-nums">{hmOf(w.workedMs)}</span>
              <span className="text-[13px] text-muted">{state.offDay ? "worked today" : `worked · present at ${hmOf(state.presentMin * 60_000)}`}</span>
            </div>
            {!state.offDay ? (
              <div className="h-2 overflow-hidden rounded bg-divider">
                <div className={cx("h-full", pct >= 100 ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted">Punched in</dt>
              <dd className="font-medium">{state.sessions[0] ? at(state.sessions[0].in) : "Not yet"}</dd>
              <dt className="text-muted">Breaks</dt>
              <dd className="font-medium">{state.breaks.length ? `${hmOf(breaks)} · ${state.breaks.length}` : "None"}</dd>
              {!state.offDay && state.phase !== "done" && state.phase !== "auto_out" ? (
                <>
                  <dt className="text-muted">To be present</dt>
                  <dd className="font-medium">{toGo ? `${hmOf(toGo)} more` : "Done"}{state.official ? ` · office hours ${state.official}` : ""}</dd>
                </>
              ) : null}
            </dl>
            {res && !res.ok ? <div className="rounded-[8px] bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{res.error}{res.detail ? ` — ${res.detail}` : ""}</div> : null}
            {state.phase === "working" ? (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setStep("break")} className="h-11 rounded-[10px] border border-warn-line bg-warn-soft text-[14px] font-bold text-warn-ink">
                  Start a break
                </button>
                <button type="button" onClick={() => setStep("out")} className="h-11 rounded-[10px] border border-danger/40 bg-surface text-[14px] font-bold text-danger">
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
          </>
        ) : null}

        {step === "break" ? (
          <>
            <div>
              <div className="text-[16px] font-bold">Start a break</div>
              <p className="mt-1 text-[12.5px] text-muted">Your work timer pauses and a break timer starts. It runs until you resume.</p>
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-[13px] font-semibold">
                What for? <span className="text-[12px] font-normal text-muted">optional</span>
              </legend>
              <div className="flex flex-wrap gap-2">
                {state.breakReasons.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={reason === r}
                    onClick={() => setReason(reason === r ? null : r)}
                    className={cx("h-9 rounded-full border px-3.5 text-[13px]", reason === r ? "border-brand bg-brand-soft font-bold text-brand-deep" : "border-line-strong bg-surface")}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep("day")} className="h-10 rounded-[10px] border border-line-strong px-4 text-[13.5px] font-semibold">
                Cancel
              </button>
              <button type="button" disabled={w.busy} onClick={async () => done(await w.act({ op: "break", reason }))} className="h-10 rounded-[10px] bg-brand px-4 text-[13.5px] font-bold text-white">
                Start break
              </button>
            </div>
          </>
        ) : null}

        {step === "out" ? (
          <>
            <div className="text-[16px] font-bold">Punch out for today?</div>
            <div className="flex items-baseline gap-2">
              <span className="text-[34px] font-semibold tabular-nums">{hmOf(w.workedMs)}</span>
              <span className="text-[13px] text-muted">worked{state.offDay ? " · extra work" : ""}</span>
            </div>
            {!state.offDay ? (
              <div className="text-[13px]">
                Counts as{" "}
                <b>{w.workedMs >= state.presentMin * 60_000 ? "Present" : w.workedMs >= state.halfMin * 60_000 ? "Half day" : "Absent"}</b>
                {w.workedMs < state.presentMin * 60_000 ? ` · ${hmOf(state.presentMin * 60_000 - w.workedMs)} short of present` : ""}
              </div>
            ) : null}
            {res && !res.ok ? <div className="rounded-[8px] bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{res.error}{res.detail ? ` — ${res.detail}` : ""}</div> : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep("day")} className="h-10 rounded-[10px] border border-line-strong px-4 text-[13.5px] font-semibold">
                Keep working
              </button>
              <button
                type="button"
                disabled={w.busy}
                onClick={async () => done(await withLocation((fix) => w.act({ op: "punchOut", ...fix })))}
                className="h-10 rounded-[10px] bg-danger px-4 text-[13.5px] font-bold text-white"
              >
                Punch out now
              </button>
            </div>
          </>
        ) : null}
      </div>
  );
}
