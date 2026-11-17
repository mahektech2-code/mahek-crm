"use client";

import * as React from "react";
import { signOut } from "@/lib/actions/auth";
import { cx } from "@/components/ui/primitives";
import { useWorkday, type OpResult } from "./workday-context";
import { at, dayDate, greeting, hmOf, msOf, VERDICT_WORDS } from "./format";
import { ampm, DayTimeline } from "./day-parts";
import { VerdictPill, withLocation } from "./workday-shared";

export { VerdictPill, withLocation };

/* ---------------------------------------------------------------------------
 * WHAT IS DRAWN OVER EVERY APP: the lock screen while somebody is locked out
 * (before punching in, on a break, after punching out), and the "are you
 * still working?" warning while they are working and idle. The lock covers the
 * whole window, header and sidebar included — only its own buttons and Sign
 * out work — and the server refuses saves while it is up, so it is not a
 * curtain somebody can open with a URL.
 * ------------------------------------------------------------------------- */

export function WorkdayOverlays() {
  const w = useWorkday();
  if (!w) return null;
  const { state, now, lastActivity } = w;
  if (state.locked) return <LockScreen />;
  if (state.phase === "working" && !state.offDay) {
    const idle = now - lastActivity;
    if (idle >= state.cfg.warnMinutes * 60_000) return <IdleWarning />;
  }
  return null;
}

/* ---------------------------------------------------------------- lock */

const STRIPE: Record<string, string> = {
  none: "bg-brand",
  break: "bg-warn",
  auto_break: "bg-warn",
  auto_out: "bg-danger",
  done: "bg-success",
};

function LockScreen() {
  const w = useWorkday()!;
  const { state, now } = w;
  const phase = state.phase;
  const pill =
    phase === "none"
      ? { text: "Locked", cls: "border-brand-softer bg-surface text-brand-deep" }
      : phase === "break" || phase === "auto_break"
        ? { text: "On a break", cls: "border-warn-line bg-warn-soft text-warn-ink" }
        : phase === "auto_out"
          ? { text: "Punched out automatically", cls: "border-danger/30 bg-danger-soft text-danger" }
          : { text: "Punched out", cls: "border-success/30 bg-success-soft text-success" };
  const last = state.sessions[state.sessions.length - 1];
  const breakMs = last?.out != null ? now - last.out : 0;
  const bigClock = phase === "break" || phase === "auto_break" ? msOf(breakMs) : at(now).replace(/ (am|pm)$/i, "");
  const suffix = phase === "break" || phase === "auto_break" ? null : at(now).slice(-2).toUpperCase();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="MahekOne is locked"
      className="fixed inset-0 z-[95] flex flex-col overflow-y-auto bg-canvas text-ink"
      style={{ backgroundImage: "radial-gradient(rgba(15,27,51,0.07) 1px, transparent 1px)", backgroundSize: "24px 24px" }}
    >
      <header className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-b border-brand-softer bg-brand-soft px-7 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-brand text-[16px] font-extrabold text-brand-lime">M</span>
          <span className="text-[15px] font-bold">MahekOne</span>
          <span className={cx("ml-2 inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold", pill.cls)}>
            <LockGlyph />
            {pill.text}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-brand-deep text-[12px] font-extrabold text-white">
            {initials(state.name)}
          </span>
          <div className="leading-tight">
            <div className="text-[13.5px] font-semibold">{state.name}</div>
            {state.role || state.office ? <div className="text-[12px] text-muted">{state.role ?? state.office}</div> : null}
          </div>
          <form action={signOut}>
            <button type="submit" className="ml-1.5 h-[34px] rounded-[9px] border border-brand-softer bg-surface px-3.5 text-[13px] font-semibold text-ink hover:bg-canvas">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-8">
        <div className="text-center">
          {phase === "break" || phase === "auto_break" ? (
            <div className="text-[13px] font-semibold uppercase tracking-[0.06em] text-warn-ink">
              {phase === "auto_break" ? "No activity since" : last?.reason ? `${last.reason} · since` : "On a break since"} {at(last?.out)}
            </div>
          ) : null}
          <div className="mt-2 text-[88px] leading-none font-light tracking-[-0.04em] tabular-nums">
            {bigClock}
            {suffix ? <span className="ml-2 text-[32px] font-normal tracking-normal text-muted">{suffix}</span> : null}
          </div>
          <div className="mt-2 text-[16px] text-muted">{phase === "break" || phase === "auto_break" ? "break time · your work timer is paused" : dayDate(state.date)}</div>
        </div>

        <section className="w-full max-w-[460px] overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_16px_40px_rgba(15,27,51,0.12)]">
          <div className={cx("h-1", STRIPE[phase] ?? "bg-brand")} />
          <div className="grid gap-4 p-6">
            {phase === "none" ? <PunchInCard /> : null}
            {phase === "break" ? <OnBreakCard /> : null}
            {phase === "auto_break" ? <BackFromBreakCard /> : null}
            {phase === "auto_out" ? <AutoOutCard /> : null}
            {phase === "done" ? <DayDoneCard /> : null}
          </div>
        </section>
      </main>

      <footer className="px-7 pt-[18px] pb-6 text-center text-[13px] text-muted">{footerFor(state)}</footer>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join("");
}

function footerFor(state: NonNullable<ReturnType<typeof useWorkday>>["state"]): string {
  const firstIn = state.sessions[0]?.in;
  if (state.phase === "none")
    return `${state.officialIn && state.officialOut ? `Office hours today ${ampm(state.officialIn)} – ${ampm(state.officialOut)} · ` : ""}breaks and time away are not counted as work`;
  if (state.phase === "break" || state.phase === "auto_break") return `${dayDate(state.date)} · punched in at ${at(firstIn)}`;
  if (state.phase === "auto_out") return "Punching in again checks your office location, like the morning punch-in";
  return "Punching in again adds to today · the time in between is recorded as away";
}

function LockGlyph() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function Fact({ l, v, tone }: { l: string; v: string; tone?: "danger" }) {
  return (
    <div className={cx("rounded-[12px] px-3 py-2.5", tone === "danger" ? "bg-danger-soft" : "bg-canvas")}>
      <div className={cx("text-[12px]", tone === "danger" ? "text-danger" : "text-muted")}>{l}</div>
      <div className={cx("text-[15px] font-bold tabular-nums", tone === "danger" && "text-danger")}>{v}</div>
    </div>
  );
}

function Primary({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-[52px] items-center justify-center gap-2 rounded-[14px] bg-brand text-[16px] font-bold text-white hover:bg-brand-hover disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function Refusal({ r, onClose }: { r: OpResult; onClose: () => void }) {
  return (
    <div className="rounded-[10px] border border-danger/40 bg-danger-soft px-3.5 py-3">
      <div className="text-[14px] font-semibold text-danger">{r.error}</div>
      {r.detail ? <div className="mt-1 text-[13px] text-body">{r.detail}</div> : null}
      <button type="button" onClick={onClose} className="mt-2 text-[13px] font-semibold text-brand hover:underline">
        Close
      </button>
    </div>
  );
}


function PunchInCard() {
  const w = useWorkday()!;
  const [res, setRes] = React.useState<OpResult | null>(null);
  const [ask, setAsk] = React.useState<null | "late" | "away">(null);
  const [text, setText] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const go = async () => {
    const r = await withLocation((fix) => w.act({ op: "punchIn", ...fix }));
    setRes(r);
    if (!r.ok && r.refusal === "late" && w.state.canLateHelp) setAsk("late");
  };
  const send = async () => {
    const r = await w.act({ op: "lateHelp", text, kind: ask === "away" ? "away" : "late" });
    if (r.ok) setSent(r.message ?? "Sent to your manager.");
    else setRes(r);
  };
  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold">{greeting(w.now, w.state.name)}</h1>
        <p className="mt-1 text-[14px] text-muted">Punch in to open your apps.</p>
      </div>
      {res && !res.ok && !ask ? <Refusal r={res} onClose={() => setRes(null)} /> : null}
      <Primary onClick={go} disabled={w.busy}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <path d="m10 17 5-5-5-5M15 12H3" />
        </svg>
        {w.busy ? "Punching in…" : "Punch in"}
      </Primary>
      {sent ? (
        <div className="rounded-[10px] bg-success-soft px-3.5 py-3 text-[13px] font-medium text-success">{sent}</div>
      ) : ask ? (
        <div className="grid gap-2 rounded-[12px] border border-line bg-canvas px-3.5 py-3">
          {res && !res.ok ? (
            <div>
              <div className="text-[14px] font-semibold text-danger">{res.error}</div>
              {res.detail ? <div className="mt-0.5 text-[13px] text-body">{res.detail}</div> : null}
            </div>
          ) : null}
          <label className="text-[13px] font-semibold" htmlFor="wd-ask">
            {ask === "away" ? "Where are you working from, and why?" : "What happened?"} <span className="text-danger">*</span>
          </label>
          <textarea
            id="wd-ask"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={ask === "away" ? "e.g. At the Thane customer meeting first, coming to office by 12" : ""}
            className="w-full rounded-[8px] border border-line bg-surface px-2.5 py-2 text-[13px]"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] text-muted">Your manager decides and sets your punch-in time.</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setAsk(null)} className="h-9 rounded-[9px] border border-line-strong bg-surface px-3 text-[13px] font-semibold">
                Cancel
              </button>
              <button type="button" disabled={!text.trim() || w.busy} onClick={send} className="h-9 rounded-[9px] bg-brand px-3.5 text-[13px] font-semibold text-white disabled:opacity-50">
                Send to my manager
              </button>
            </div>
          </div>
        </div>
      ) : w.state.canLateHelp ? (
        <div className="flex justify-center text-[13.5px] font-semibold">
          <button type="button" onClick={() => setAsk("away")} className="text-brand hover:underline">
            I’m not at the office
          </button>
        </div>
      ) : null}
    </>
  );
}

function OnBreakCard() {
  const w = useWorkday()!;
  const [res, setRes] = React.useState<OpResult | null>(null);
  const breaks = w.state.breaks.reduce((n, b) => n + ((b.to ?? w.now) - b.from), 0);
  return (
    <>
      <h1 className="text-[20px] font-bold">Back to work?</h1>
      <div className="grid grid-cols-3 gap-2">
        <Fact l="Worked" v={hmOf(w.workedMs)} />
        <Fact l="Breaks" v={hmOf(breaks)} />
        <Fact l="Present at" v={hmOf(w.state.presentMin * 60_000)} />
      </div>
      {res && !res.ok ? <Refusal r={res} onClose={() => setRes(null)} /> : null}
      <Primary onClick={async () => setRes(await w.act({ op: "resume" }))} disabled={w.busy}>
        Resume work
      </Primary>
      <div className="flex flex-wrap justify-between gap-2 text-[13.5px]">
        <span className="text-muted">Your screens stay as you left them.</span>
        <button type="button" onClick={async () => setRes(await w.act({ op: "punchOut" }))} className="font-semibold text-brand hover:underline">
          Punch out instead
        </button>
      </div>
    </>
  );
}

const CLAIM_CATEGORIES = ["On a call", "In a meeting", "On the floor or godown", "Other"];

function ClaimForm({ onSend, sending, label }: { onSend: (c: { category: string; note: string }) => void; sending: boolean; label: string }) {
  const [category, setCategory] = React.useState(CLAIM_CATEGORIES[0]);
  const [note, setNote] = React.useState("");
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {CLAIM_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
            className={cx(
              "h-9 rounded-full border px-3.5 text-[13px]",
              category === c ? "border-brand bg-brand-soft font-semibold text-brand-deep" : "border-line-strong bg-surface text-ink",
            )}
          >
            {c}
          </button>
        ))}
      </div>
      <label className="grid gap-1.5 text-[13px] font-semibold" htmlFor="wd-claim">
        <span>
          What were you doing? <span className="text-danger">*</span>
        </span>
        <textarea id="wd-claim" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-[9px] border border-line-strong px-3 py-2 text-[13.5px] font-normal" />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-muted">Your manager decides whether it counts as work.</span>
        <button
          type="button"
          disabled={!note.trim() || sending}
          onClick={() => onSend({ category, note })}
          className="h-10 rounded-[10px] border border-line-strong bg-surface px-4 text-[13.5px] font-bold text-ink disabled:opacity-50"
        >
          {label}
        </button>
      </div>
    </div>
  );
}

function BackFromBreakCard() {
  const w = useWorkday()!;
  const last = w.state.sessions[w.state.sessions.length - 1];
  const [res, setRes] = React.useState<OpResult | null>(null);
  const from = last?.out ?? w.now;
  const mins = Math.max(0, Math.round((w.now - from) / 60_000));
  return (
    <>
      <div className="grid gap-3">
        <span className="justify-self-start rounded-full border border-warn-line bg-warn-soft px-2.5 py-0.5 text-[12px] font-bold text-warn-ink">Recorded as a break</span>
        <h1 className="text-[22px] font-bold">Welcome back, {w.state.name.split(" ")[0]}</h1>
        <p className="text-[14.5px] leading-relaxed text-body">
          There was no activity from <b>{at(from)} to {at(w.now)}</b>, so {mins === 1 ? "that minute is" : `those ${mins} minutes are`} recorded as a break and are not counted as work.
        </p>
        <DayTimeline labels="gap" />
        {res && !res.ok ? <Refusal r={res} onClose={() => setRes(null)} /> : null}
        <Primary onClick={async () => setRes(await w.act({ op: "resume" }))} disabled={w.busy}>
          Resume work
        </Primary>
      </div>
      <div className="-mx-6 -mb-6 border-t border-divider bg-canvas px-6 pt-4 pb-6">
        <div className="mb-3 text-[14px] font-bold">I was working away from the screen</div>
        <ClaimForm label="Send and resume" sending={w.busy} onSend={async (claim) => setRes(await w.act({ op: "resume", claim }))} />
      </div>
    </>
  );
}

function AutoOutCard() {
  const w = useWorkday()!;
  const last = w.state.sessions[w.state.sessions.length - 1];
  const [res, setRes] = React.useState<OpResult | null>(null);
  const [claiming, setClaiming] = React.useState(false);
  const [sent, setSent] = React.useState<string | null>(null);
  return (
    <>
      <h1 className="text-[22px] leading-tight font-bold">You were punched out at {at(last?.out)}</h1>
      <p className="text-[14px] leading-relaxed text-body">
        No activity for {w.state.cfg.outMinutes === 60 ? "an hour" : `${w.state.cfg.outMinutes} minutes`}, so your day was closed at your last activity. That {w.state.cfg.outMinutes === 60 ? "hour is" : "time is"} not counted.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Fact l="In" v={w.state.firstIn ? at(w.state.sessions[0]?.in) : "—"} />
        <Fact l="Out (auto)" v={at(last?.out)} tone="danger" />
        <Fact l="Worked" v={hmOf(w.workedMs)} />
      </div>
      {res && !res.ok ? <Refusal r={res} onClose={() => setRes(null)} /> : null}
      <Primary onClick={async () => setRes(await withLocation((fix) => w.act({ op: "punchIn", ...fix })))} disabled={w.busy}>
        Punch in again
      </Primary>
      {sent ? (
        <div className="text-[13px] font-medium text-success">{sent}</div>
      ) : claiming ? (
        <div className="border-t border-divider pt-4">
          <div className="mb-3 text-[14px] font-bold">I was working · ask to correct</div>
          <ClaimForm
            label="Send to my manager"
            sending={w.busy}
            onSend={async (c) => {
              const r = await w.act({ op: "claimOut", ...c });
              if (r.ok) {
                setSent(r.message ?? "Sent to your manager.");
                setClaiming(false);
              } else setRes(r);
            }}
          />
        </div>
      ) : (
        <div className="flex flex-wrap justify-between gap-2 text-[13.5px]">
          <span className="text-muted">
            {at(last?.out)} – {at(w.now)} will show as away.
          </span>
          <button type="button" onClick={() => setClaiming(true)} className="font-semibold text-brand hover:underline">
            I was working · ask to correct
          </button>
        </div>
      )}
    </>
  );
}

function DayDoneCard() {
  const w = useWorkday()!;
  const last = w.state.sessions[w.state.sessions.length - 1];
  const [res, setRes] = React.useState<OpResult | null>(null);
  const v = w.state.verdict ? VERDICT_WORDS[w.state.verdict] : null;
  const breaks = w.state.breaks.reduce((n, b) => n + ((b.to ?? w.now) - b.from), 0);
  const pct = Math.min(100, Math.round((w.workedMs / (w.state.presentMin * 60_000)) * 100));
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold">Good work today, {w.state.name.split(" ")[0]}</h1>
          <p className="mt-1 text-[14px] text-muted">Punched out at {at(last?.out)}</p>
        </div>
        {v ? <VerdictPill v={v} /> : null}
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[34px] font-semibold tracking-[-0.02em] tabular-nums">{hmOf(w.workedMs)}</span>
          <span className="text-[13px] text-muted">
            worked · present at {hmOf(w.state.presentMin * 60_000)}
            {w.workedMs >= w.state.presentMin * 60_000 ? " ✓" : ""}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-divider">
          <div className={cx("h-full", pct >= 100 ? "bg-success" : "bg-warn")} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-[12.5px] text-muted">
          <span>In {at(w.state.sessions[0]?.in)}</span>
          <span>Breaks {hmOf(breaks)}</span>
          <span>Out {at(last?.out)}</span>
        </div>
      </div>
      {res && !res.ok ? <Refusal r={res} onClose={() => setRes(null)} /> : null}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={w.busy}
          onClick={async () => setRes(await withLocation((fix) => w.act({ op: "punchIn", ...fix })))}
          className="h-[52px] rounded-[14px] border border-line-strong bg-surface text-[15px] font-bold text-ink disabled:opacity-60"
        >
          Punch in again
        </button>
        <form action={signOut} className="contents">
          <button type="submit" className="h-[52px] rounded-[14px] bg-brand text-[15px] font-bold text-white hover:bg-brand-hover">
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}


/* ---------------------------------------------------------------- idle */

/** The idle warning reaches another window as a desktop notification, where allowed — and says so, or offers it. */
function DesktopNote() {
  const [perm, setPerm] = React.useState<NotificationPermission | "none">(() => (typeof Notification === "undefined" ? "none" : Notification.permission));
  if (perm === "none" || perm === "denied") return null;
  return (
    <div className="-mx-6 -mb-6 rounded-b-[16px] border-t border-divider bg-canvas px-6 py-3 text-[12.5px] text-muted">
      {perm === "granted" ? (
        "Also sent as a desktop notification, so you see it even with another window open."
      ) : (
        <button type="button" onClick={async () => setPerm(await Notification.requestPermission())} className="font-semibold text-brand hover:underline">
          Also tell me in a desktop notification when another window is open
        </button>
      )}
    </div>
  );
}

function IdleWarning() {
  const w = useWorkday()!;
  const breakAt = w.lastActivity + w.state.cfg.breakMinutes * 60_000;
  const left = Math.max(0, breakAt - w.now);
  const total = (w.state.cfg.breakMinutes - w.state.cfg.warnMinutes) * 60_000;
  const deg = total ? Math.round((left / total) * 360) : 0;
  /* Seen from another window too, where the browser allows it. */
  const told = React.useRef(false);
  React.useEffect(() => {
    if (told.current || typeof Notification === "undefined" || document.visibilityState === "visible") return;
    told.current = true;
    if (Notification.permission === "granted") new Notification("Are you still working?", { body: `MahekOne starts a break at ${at(breakAt)} unless you come back.` });
  }, [breakAt]);
  return (
    <div className="fixed inset-0 z-[94] flex items-center justify-center bg-[rgba(15,27,51,0.5)] p-4">
      <div role="alertdialog" aria-labelledby="wd-idle-t" aria-describedby="wd-idle-d" className="grid w-full max-w-[480px] gap-5 rounded-[16px] bg-surface p-6 shadow-[0_24px_60px_rgba(15,27,51,0.28)]">
        <div className="flex items-center gap-4">
          <div className="flex size-[84px] flex-none items-center justify-center rounded-full" style={{ background: `conic-gradient(var(--color-danger) ${deg}deg, var(--color-danger-soft) 0)` }}>
            <div className="flex size-[68px] items-center justify-center rounded-full bg-surface text-[18px] font-semibold text-danger tabular-nums">{msOf(left)}</div>
          </div>
          <div>
            <h2 id="wd-idle-t" className="text-[21px] font-bold">
              Are you still working?
            </h2>
            <p id="wd-idle-d" className="mt-1.5 text-[14px] leading-relaxed text-body">
              There has been no activity in MahekOne since <b>{at(w.lastActivity)}</b>. In {msOf(left)} this becomes a break, counted from {at(w.lastActivity)}.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => w.touch()} className="h-12 rounded-[11px] bg-brand text-[15px] font-bold text-white hover:bg-brand-hover">
            Yes, I’m here
          </button>
          <button type="button" onClick={() => void w.act({ op: "break" })} className="h-12 rounded-[11px] border border-warn-line bg-warn-soft text-[15px] font-bold text-warn-ink">
            Start a break
          </button>
        </div>
        <DesktopNote />
      </div>
    </div>
  );
}

