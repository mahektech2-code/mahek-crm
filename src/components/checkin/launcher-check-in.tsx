"use client";

import * as React from "react";
import { useWorkday } from "@/components/workday/workday-context";
import { VerdictPill, withLocation } from "@/components/workday/workday-shared";
import { BreakDialog, PunchOutDialog } from "@/components/workday/day-parts";
import { cx } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { at, hmOf, OFF_DAY_WORDS, VERDICT_WORDS } from "@/components/workday/format";
import type { OpResult } from "@/components/workday/workday-context";

/* ---------------------------------------------------------------------------
 * THE DAY CARD on the launcher and on HRMS Home, drawn as the Workday Clock
 * design's "Launcher with the day card": the state and where, the three
 * figures (worked, breaks, present at), the buttons, and the day as a bar.
 * Starting a break and punching out open the same dialogs the header's timer
 * opens, so the card, the timer and the lock cannot disagree. On a day off it
 * is the design's "3b" card instead: MahekOne is open, and punching in records
 * extra work.
 *
 * And it says WHY the lock does not apply, wherever it does not: a person
 * with the HRMS who is not linked to an employee record, or a platform
 * administrator who is exempt, used to see either nothing or an ordinary card
 * and conclude the lock was broken.
 * ------------------------------------------------------------------------- */

const EXEMPT_WORDS: Record<string, string> = {
  "not-linked":
    "Your account is not linked to an employee record in HRMS, so the workday clock does not run for you and MahekOne is not locked. Ask HR to link it.",
  inactive: "Your employee record in HRMS is not active, so the workday clock does not run for you.",
  "platform-admin":
    "You are a platform administrator, so MahekOne is never locked for you (HRMS settings → Workday clock).",
};

/** `quiet`: the launcher draws the card only, never the notes about why the clock does not apply. */
export function LauncherCheckIn({ quiet = false }: { quiet?: boolean } = {}) {
  const w = useWorkday();
  const [sheet, setSheet] = React.useState<null | "break" | "out">(null);
  const [res, setRes] = React.useState<OpResult | null>(null);
  if (!w) return null;
  const { state } = w;

  if (!state.subject) {
    const why = state.exempt ? EXEMPT_WORDS[state.exempt] : null;
    if (!why || quiet) return null;
    return <Note>{why}</Note>;
  }
  if (state.onHandset) {
    if (quiet) return null;
    return <Note>You punched in on the field app today, so you punch out there too.</Note>;
  }

  const breaksMs = state.breaks.reduce((n, b) => n + ((b.to ?? w.now) - b.from), 0);
  const v = state.verdict ? VERDICT_WORDS[state.verdict] : null;
  const first = state.sessions[0]?.in ?? null;
  const tone =
    state.phase === "working" ? "success" : state.phase === "break" || state.phase === "auto_break" ? "warn" : state.phase === "none" ? "brand" : "muted";
  const title =
    state.phase === "none"
      ? state.offDay
        ? `Today is ${state.holidayName ?? OFF_DAY_WORDS[state.offDay]}`
        : "Not punched in yet"
      : state.phase === "working"
        ? `Punched in at ${at(first)}`
        : state.phase === "break" || state.phase === "auto_break"
          ? "On a break"
          : "Punched out for today";
  const where = [
    state.office,
    state.official ? `hours ${state.official}` : null,
    state.offDay ? "hours you work are extra work" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const exemptLine = state.exempt ? EXEMPT_WORDS[state.exempt] : !state.lockEnabled ? "The lock is switched off, so MahekOne opens without punching in." : null;

  const punchIn = async () => {
    const r = await withLocation((fix) => w.act({ op: "punchIn", ...fix }));
    setRes(r);
  };

  if (state.offDay && state.phase === "none") {
    const what = state.holidayName ? `Today is ${state.holidayName}` : state.offDay === "leave" ? "You are on leave today" : state.offDay === "holiday" ? "Today is a holiday" : "Today is your week off";
    return (
      <section aria-labelledby="wd-off-t" className="overflow-hidden rounded-[14px] border border-line bg-surface">
        <div className="h-1 bg-brand" />
        <div className="flex flex-wrap items-center gap-5 px-[22px] py-5">
          <div className="flex flex-[1_1_360px] items-center gap-3.5">
            <span className="flex size-12 flex-none items-center justify-center rounded-[12px] bg-brand-soft text-brand-deep">
              <Icon name="calendar" size={22} />
            </span>
            <div>
              <h2 id="wd-off-t" className="text-[16px] font-bold text-ink">
                {what}
              </h2>
              <div className="text-[13.5px] text-muted">MahekOne is open. Punch in only if you are working today, and it is recorded as extra work.</div>
            </div>
          </div>
          <button
            type="button"
            disabled={w.busy}
            onClick={punchIn}
            className="flex h-[42px] items-center gap-2 rounded-[10px] border border-brand-softer bg-brand-soft px-[18px] text-[14px] font-bold text-brand-deep disabled:opacity-60"
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Punch in for extra work
          </button>
        </div>
        {res && !res.ok ? (
          <div className="border-t border-divider bg-danger-soft px-[22px] py-2.5 text-[13px] text-danger">
            {res.error}
            {res.detail ? ` — ${res.detail}` : ""}
          </div>
        ) : null}
        <div className="border-t border-divider bg-canvas px-[22px] py-3 text-[12.5px] text-muted">
          The same goes for holidays and days you are on approved leave. Extra work never changes the day to Present or Absent.
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Your day" className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-[22px] py-5">
        <div className="flex min-w-[260px] flex-[1_1_260px] items-center gap-3.5">
          <span
            className={cx(
              "flex size-12 flex-none items-center justify-center rounded-[12px]",
              tone === "success" && "bg-success-soft text-success",
              tone === "warn" && "bg-warn-soft text-warn",
              tone === "brand" && "bg-brand-soft text-brand",
              tone === "muted" && "bg-divider text-muted",
            )}
          >
            <Icon name="clock" size={22} />
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-ink">
              {title}
              {v ? <VerdictPill v={v} /> : null}
            </span>
            {where ? <span className="block truncate text-[13px] text-muted">{where}</span> : null}
          </span>
        </div>

        <dl className="flex flex-wrap gap-7">
          <Figure label="Worked" value={hmOf(w.workedMs)} />
          <Figure label="Breaks" value={hmOf(breaksMs)} />
          {!state.offDay ? <Figure label="Present at" value={hmOf(state.presentMin * 60_000)} /> : null}
        </dl>

        <div className="flex flex-wrap gap-2">
          {state.phase === "working" ? (
            <>
              <button type="button" onClick={() => setSheet("break")} className="h-10 rounded-[9px] border border-warn-line bg-warn-soft px-4 text-[13.5px] font-semibold text-warn-ink">
                Start a break
              </button>
              <button type="button" onClick={() => setSheet("out")} className="h-10 rounded-[9px] border border-line-strong bg-surface px-4 text-[13.5px] font-semibold text-ink">
                Punch out
              </button>
            </>
          ) : state.phase === "break" || state.phase === "auto_break" ? (
            <button type="button" disabled={w.busy} onClick={async () => setRes(await w.act({ op: "resume" }))} className="h-10 rounded-[9px] bg-brand px-4 text-[13.5px] font-semibold text-white">
              Resume work
            </button>
          ) : (
            <button type="button" disabled={w.busy} onClick={punchIn} className="h-10 rounded-[9px] bg-brand px-4 text-[13.5px] font-semibold text-white">
              {state.phase === "none" ? (state.offDay ? "Punch in for extra work" : "Punch in") : "Punch in again"}
            </button>
          )}
        </div>

        <DayBar />
      </div>

      {res && !res.ok ? (
        <div className="border-t border-divider bg-danger-soft px-[22px] py-2.5 text-[13px] text-danger">
          {res.error}
          {res.detail ? ` — ${res.detail}` : ""}
        </div>
      ) : null}
      {exemptLine && !quiet ? <div className="border-t border-divider bg-canvas px-[22px] py-2.5 text-[12.5px] text-muted">{exemptLine}</div> : null}

      {sheet === "break" ? <BreakDialog onClose={() => setSheet(null)} /> : null}
      {sheet === "out" ? <PunchOutDialog withLocation={withLocation} onClose={() => setSheet(null)} /> : null}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="font-mono text-[22px] font-semibold text-ink tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The day drawn as a bar: worked stretches green, breaks amber, from the first
 * punch-in to whichever is later of now and the moment the day would reach
 * the present hours. Before punching in, an empty bar.
 */
function DayBar() {
  const w = useWorkday()!;
  const { state } = w;
  const first = state.sessions[0]?.in ?? null;
  if (!first) {
    return (
      <div className="flex flex-[1_1_100%] flex-col gap-1.5">
        <div className="h-2.5 rounded-[5px] bg-divider" />
      </div>
    );
  }
  const presentAt = first + state.presentMin * 60_000 + state.breaks.reduce((n, b) => n + ((b.to ?? w.now) - b.from), 0);
  const lastEnd = state.sessions.reduce((m, s) => Math.max(m, s.out ?? w.now), first);
  const end = Math.max(presentAt, lastEnd, w.now);
  const span = Math.max(1, end - first);
  const pct = (ms: number) => `${((ms - first) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, b - a) / span) * 100}%`;
  return (
    <div className="flex flex-[1_1_100%] flex-col gap-1.5">
      <div className="relative h-2.5 overflow-hidden rounded-[5px] bg-divider">
        {state.sessions.map((s) => (
          <span key={`s${s.in}`} className="absolute inset-y-0 bg-success" style={{ left: pct(s.in), width: width(s.in, s.out ?? w.now) }} />
        ))}
        {state.breaks.map((b) => (
          <span key={`b${b.from}`} className="absolute inset-y-0 bg-warn" style={{ left: pct(b.from), width: width(b.from, b.to ?? w.now) }} />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted">
        <span>{at(first)}</span>
        {!state.offDay ? <span>present at {at(presentAt)}</span> : null}
        <span>{at(end)}</span>
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[14px] border border-line bg-surface px-5 py-3.5 text-[13px] text-body">{children}</div>;
}
