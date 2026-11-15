"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { useWorkday, type OpResult } from "./workday-context";
import { at, dayDate, hmOf } from "./format";

/* ---------------------------------------------------------------------------
 * The pieces the Workday Clock design draws in more than one place: the day
 * as a coloured bar, the day as a list of stretches, the Start a break dialog
 * and the Punch out dialog. The header's timer, the launcher's day card and
 * the lock screens all open the same two dialogs, so a break started from any
 * of them asks the same questions.
 * ------------------------------------------------------------------------- */

type WorkdayView = NonNullable<ReturnType<typeof useWorkday>>;

export type DaySegment = { kind: "work" | "break" | "auto_break" | "away"; from: number; to: number; what: string };

/** The day as stretches of work and the gaps between them, in order. */
export function daySegments(w: WorkdayView): DaySegment[] {
  const { state, now } = w;
  const out: DaySegment[] = [];
  for (const s of state.sessions) out.push({ kind: "work", from: s.in, to: s.out ?? now, what: "Work" });
  for (const b of state.breaks)
    out.push({
      kind: b.kind,
      from: b.from,
      to: b.to ?? now,
      what: b.kind === "auto_break" ? "Auto-break · no activity" : b.kind === "away" ? "Away" : (b.reason ?? "Break"),
    });
  return out.sort((a, b) => a.from - b.from);
}

const SEG_BG: Record<DaySegment["kind"], string> = {
  work: "bg-success",
  break: "bg-warn",
  auto_break: "bg-warn/60",
  away: "bg-faint",
};

/** 9:30 → "9:30 AM"; "18:30" → "6:30 PM". */
export function ampm(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return hhmm;
  return `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** "1:15 pm" → "1:15" — a time inside a range, where the suffix would be noise. */
const bare = (ms: number) => at(ms).replace(/ (am|pm)$/i, "");

/**
 * The day as one bar from the first punch-in to the later of now and when the
 * day reaches the present hours (or the office closing). `labels` decides what
 * is printed under it: the two ends and the middle, or every few hours.
 */
export function DayTimeline({ labels = "ends", tall }: { labels?: "ends" | "hours" | "gap"; tall?: boolean }) {
  const w = useWorkday()!;
  const { state, now } = w;
  const segs = daySegments(w);
  const first = segs[0]?.from;
  if (first == null) return <div className={cx("rounded-[5px] bg-divider", tall ? "h-3" : "h-2.5")} />;
  const breaksMs = state.breaks.reduce((n, b) => n + ((b.to ?? now) - b.from), 0);
  const presentAt = first + state.presentMin * 60_000 + breaksMs;
  const lastEnd = segs.reduce((m, s) => Math.max(m, s.to), first);
  const end = Math.max(presentAt, lastEnd, now);
  const span = Math.max(1, end - first);
  const pos = (ms: number) => ((ms - first) / span) * 100;

  let ticks: { at: number; text: string }[] = [];
  if (labels === "hours") {
    const hours = Math.max(1, Math.round(span / 3_600_000));
    const step = Math.max(1, Math.ceil(hours / 4));
    for (let t = first; t <= end; t += step * 3_600_000) ticks.push({ at: t, text: at(t).replace(":00", "") });
  } else if (labels === "gap") {
    const gap = [...segs].reverse().find((s) => s.kind !== "work");
    ticks = [{ at: first, text: bare(first) }];
    if (gap) ticks.push({ at: gap.from, text: `${bare(gap.from)} – ${bare(gap.to)}` });
    ticks.push({ at: end, text: "now" });
  } else {
    ticks = [{ at: first, text: bare(first) }];
    const mid = segs.find((s) => s.kind !== "work");
    if (mid) ticks.push({ at: mid.from, text: at(mid.from).replace(":00", "") });
    ticks.push({ at: end, text: bare(end) });
  }

  return (
    <div className="grid gap-1.5">
      <div className={cx("relative overflow-hidden rounded-[5px] bg-divider", tall ? "h-3" : "h-2.5")}>
        {segs.map((s) => (
          <span key={`${s.kind}${s.from}`} className={cx("absolute inset-y-0", SEG_BG[s.kind])} style={{ left: `${pos(s.from)}%`, width: `${Math.max(0.5, pos(s.to) - pos(s.from))}%` }} />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted">
        {ticks.map((t) => (
          <span key={`${t.at}${t.text}`}>{t.text}</span>
        ))}
      </div>
    </div>
  );
}

/** Each stretch of the day with its colour, its span and how long it lasted. */
export function SegmentList() {
  const w = useWorkday()!;
  const segs = daySegments(w);
  if (!segs.length) return null;
  return (
    <div className="grid gap-1.5">
      {segs.map((s) => (
        <div key={`${s.kind}${s.from}`} className="grid grid-cols-[10px_1fr_auto_auto] items-center gap-3 text-[13px]">
          <span className={cx("size-2.5 rounded-full", SEG_BG[s.kind])} />
          <span className={s.kind === "work" ? "font-medium" : "text-body"}>{s.what}</span>
          <span className="font-mono text-[12px] text-muted">
            {bare(s.from)} – {bare(s.to)}
          </span>
          <span className="w-12 text-right font-mono text-[12.5px] font-semibold tabular-nums">{hmOf(s.to - s.from)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- dialogs */

/** A centred dialog over a dimmed screen, the shape every dialog in the design takes. */
export function CentreDialog({ labelledBy, onClose, children, width = 460 }: { labelledBy: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  React.useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(15,27,51,0.45)] p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="grid w-full gap-[18px] rounded-[16px] bg-surface p-6 text-ink shadow-[0_24px_60px_rgba(15,27,51,0.28)]" style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  );
}

function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" aria-label="Close" onClick={onClose} className="flex size-8 flex-none items-center justify-center rounded-[8px] text-[20px] text-muted hover:bg-canvas">
      ×
    </button>
  );
}

function Problem({ r }: { r: OpResult | null }) {
  if (!r || r.ok) return null;
  return (
    <div className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {r.error}
      {r.detail ? ` — ${r.detail}` : ""}
    </div>
  );
}

/** "Start a break": what for (optional), a note (optional), and the button. */
export function BreakDialog({ onClose }: { onClose: () => void }) {
  const w = useWorkday()!;
  const [reason, setReason] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [res, setRes] = React.useState<OpResult | null>(null);
  const go = async () => {
    const r = await w.act({ op: "break", reason, note: note.trim() || null });
    setRes(r);
    if (r.ok) onClose();
  };
  return (
    <CentreDialog labelledBy="wd-break-t" onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="wd-break-t" className="text-[20px] font-bold">
            Start a break
          </h2>
          <p className="mt-1 text-[13px] text-muted">Your work timer pauses and a break timer starts. It runs until you press Resume.</p>
        </div>
        <CloseX onClose={onClose} />
      </div>
      <fieldset className="grid gap-2.5">
        <legend className="mb-2.5 text-[13px] font-semibold">
          What for? <span className="text-[12px] font-normal text-muted">optional</span>
        </legend>
        <div className="flex flex-wrap gap-2">
          {w.state.breakReasons.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reason === r}
              onClick={() => setReason(reason === r ? null : r)}
              className={cx(
                "h-10 rounded-full px-4 text-[14px]",
                reason === r ? "border-[1.5px] border-brand bg-brand-soft font-bold text-brand-deep" : "border border-line-strong bg-surface font-medium text-ink",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="grid gap-1.5 text-[13px] font-semibold" htmlFor="wd-break-note">
        <span>
          Note <span className="text-[12px] font-normal text-muted">optional</span>
        </span>
        <input
          id="wd-break-note"
          type="text"
          value={note}
          maxLength={60}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void go()}
          placeholder="e.g. Bank visit for the cheque"
          className="h-10 rounded-[9px] border border-line-strong px-3 text-[13.5px] font-normal"
        />
      </label>
      <Problem r={res} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-[42px] rounded-[10px] border border-line-strong bg-surface px-[18px] text-[14px] font-semibold text-ink">
          Cancel
        </button>
        <button type="button" disabled={w.busy} onClick={go} className="flex h-[42px] items-center gap-2 rounded-[10px] bg-brand px-5 text-[14px] font-bold text-white hover:bg-brand-hover disabled:opacity-60">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2 2M9 2h6" />
          </svg>
          Start break
        </button>
      </div>
    </CentreDialog>
  );
}

/** "Punch out for today?": the day in full before it is closed. */
export function PunchOutDialog({ onClose, withLocation }: { onClose: () => void; withLocation: (run: (fix: { lat: number | null; lng: number | null; accuracy: number | null }) => Promise<OpResult>) => Promise<OpResult> }) {
  const w = useWorkday()!;
  const { state } = w;
  const [res, setRes] = React.useState<OpResult | null>(null);
  const present = state.presentMin * 60_000;
  const verdict = state.offDay ? "Extra work" : w.workedMs >= present ? "Present" : w.workedMs >= state.halfMin * 60_000 ? "Half day" : "Absent";
  const tone = verdict === "Present" ? "bg-success-soft text-success" : verdict === "Half day" ? "bg-warn-soft text-warn-ink" : verdict === "Absent" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand-deep";
  const go = async () => {
    const r = await withLocation((fix) => w.act({ op: "punchOut", ...fix }));
    setRes(r);
    if (r.ok) onClose();
  };
  return (
    <CentreDialog labelledBy="wd-out-t" onClose={onClose} width={520}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="wd-out-t" className="text-[20px] font-bold">
            Punch out for today?
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            {dayDate(state.date)}
            {state.office ? ` · ${state.office}` : ""}
          </p>
        </div>
        <span className={cx("rounded-full px-3 py-1 text-[12px] font-bold whitespace-nowrap", tone)}>{verdict}</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[40px] font-semibold tracking-[-0.02em] tabular-nums">{hmOf(w.workedMs)}</span>
        <span className="text-[13px] text-muted">
          {state.offDay
            ? "worked · recorded as extra work"
            : w.workedMs >= present
              ? `worked · ${hmOf(present)} needed to be present ✓`
              : `worked · ${hmOf(present - w.workedMs)} short of present`}
        </span>
      </div>
      <DayTimeline labels="hours" tall />
      <SegmentList />
      <Problem r={res} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-[42px] rounded-[10px] border border-line-strong bg-surface px-[18px] text-[14px] font-semibold text-ink">
          Keep working
        </button>
        <button type="button" disabled={w.busy} onClick={go} className="h-[42px] rounded-[10px] bg-danger px-5 text-[14px] font-bold text-white disabled:opacity-60">
          Punch out at {at(w.now)}
        </button>
      </div>
    </CentreDialog>
  );
}
