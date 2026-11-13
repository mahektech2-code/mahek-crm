/* ---------------------------------------------------------------------------
 * THE WORKDAY CLOCK, PURE. An office day is a list of working stretches —
 * the MBOS handset's own shape — and everything here reads or rewrites that
 * list. No I/O: configuration, the clock and the last activity come in as
 * arguments, so every rule is tested without a database or a browser.
 *
 * THE ONE IDEA THAT MAKES IT CORRECT: every automatic boundary is dated from
 * the LAST ACTIVITY, never from the moment somebody noticed. A browser can be
 * closed, a laptop asleep, a tab hidden; the server may only notice idleness
 * forty minutes late. Backdating means it does not matter when it notices —
 * the record comes out the same, and an idle hour is never counted as work.
 * ------------------------------------------------------------------------- */

export type SessionEnd = "break" | "idle" | "auto_out" | "punch_out";

export type WorkdaySession = {
  /** Epoch ms. */
  in: number;
  out: number | null;
  end?: SessionEnd | null;
  reason?: string | null;
};

export type WorkdayCfg = {
  /** Ask "are you still working?" after this many idle minutes. */
  warnMinutes: number;
  /** Idle this long becomes a break, dated from the last activity. */
  breakMinutes: number;
  /** Idle this long closes the day at the last activity. */
  outMinutes: number;
  /** A manual break longer than this closes the day at the break's start. */
  breakOutMinutes: number;
};

export type WorkdayPhase =
  /** Nothing recorded today. */
  | "none"
  | "working"
  /** On a break somebody started. */
  | "break"
  /** On a break the clock started, because nothing happened. */
  | "auto_break"
  /** The clock closed the day. */
  | "auto_out"
  /** The person punched out. */
  | "done";

const MIN = 60_000;

/** The stretch still running, if any. */
export function openSession(s: WorkdaySession[]): WorkdaySession | null {
  const last = s[s.length - 1];
  return last && last.out == null ? last : null;
}

export function phaseOf(s: WorkdaySession[]): WorkdayPhase {
  const last = s[s.length - 1];
  if (!last) return "none";
  if (last.out == null) return "working";
  switch (last.end) {
    case "break":
      return "break";
    case "idle":
      return "auto_break";
    case "auto_out":
      return "auto_out";
    default:
      return "done";
  }
}

/** Is MahekOne locked for somebody in this phase. Working is the only open one. */
export function isLocked(phase: WorkdayPhase): boolean {
  return phase !== "working";
}

/**
 * Apply the idle rules to a day, as of `now`. Returns the list it should be
 * and whether anything moved. Pure and idempotent: settling twice gives the
 * same answer, which is what lets the chip, a heartbeat and a cron all call it.
 */
export function settle(
  sessions: WorkdaySession[],
  lastActivity: number | null,
  now: number,
  cfg: WorkdayCfg,
): { sessions: WorkdaySession[]; changed: boolean } {
  const s = sessions.map((x) => ({ ...x }));
  const phase = phaseOf(s);
  const last = s[s.length - 1];
  if (!last) return { sessions: s, changed: false };

  if (phase === "working") {
    /* Never before the stretch began: an activity from before a break is not
       evidence about the stretch that followed it. */
    const act = Math.max(lastActivity ?? last.in, last.in);
    const idle = now - act;
    if (idle >= cfg.outMinutes * MIN) {
      last.out = act;
      last.end = "auto_out";
      return { sessions: s, changed: true };
    }
    if (idle >= cfg.breakMinutes * MIN) {
      last.out = act;
      last.end = "idle";
      return { sessions: s, changed: true };
    }
    return { sessions: s, changed: false };
  }

  if (phase === "auto_break" && last.out != null && now - last.out >= cfg.outMinutes * MIN) {
    last.end = "auto_out";
    return { sessions: s, changed: true };
  }

  if (phase === "break" && last.out != null && now - last.out >= cfg.breakOutMinutes * MIN) {
    last.end = "auto_out";
    return { sessions: s, changed: true };
  }

  return { sessions: s, changed: false };
}

/** Start a stretch. Refused only when one is already running. */
export function startSession(s: WorkdaySession[], at: number): WorkdaySession[] | null {
  if (openSession(s)) return null;
  return [...s.map((x) => ({ ...x })), { in: at, out: null, end: null, reason: null }];
}

/** End the running stretch, as a break or a punch-out. */
export function endSession(s: WorkdaySession[], at: number, end: SessionEnd, reason: string | null = null): WorkdaySession[] | null {
  const copy = s.map((x) => ({ ...x }));
  const open = openSession(copy);
  if (!open) return null;
  open.out = Math.max(at, open.in);
  open.end = end;
  open.reason = reason;
  return copy;
}

/**
 * Close a day that is on a break (manual or automatic) as punched out, at the
 * moment the break began — the break is not work, and nothing after it was.
 */
export function closeFromBreak(s: WorkdaySession[]): WorkdaySession[] | null {
  const copy = s.map((x) => ({ ...x }));
  const last = copy[copy.length - 1];
  if (!last || last.out == null || (last.end !== "break" && last.end !== "idle")) return null;
  last.end = "punch_out";
  return copy;
}

export type Span = { from: number; to: number };

/** Milliseconds worked: every stretch (a running one up to now) plus approved claims. */
export function workedMs(s: WorkdaySession[], now: number, approved: Span[] = []): number {
  let total = 0;
  for (const x of s) total += Math.max(0, (x.out ?? now) - x.in);
  for (const a of approved) total += Math.max(0, a.to - a.from);
  return total;
}

/** Milliseconds between stretches — breaks and time away — less approved claims. */
export function gapMs(s: WorkdaySession[], now: number, approved: Span[] = []): number {
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const out = s[i].out;
    if (out == null) continue;
    const next = s[i + 1]?.in ?? (phaseOf(s) === "break" || phaseOf(s) === "auto_break" ? now : null);
    if (next != null) total += Math.max(0, next - out);
  }
  for (const a of approved) total -= Math.max(0, a.to - a.from);
  return Math.max(0, total);
}

/** The breaks of a day, for the summary: when, how long, and why. */
export function breaksOf(s: WorkdaySession[], now: number): { from: number; to: number | null; kind: "break" | "auto_break" | "away"; reason: string | null }[] {
  const out: { from: number; to: number | null; kind: "break" | "auto_break" | "away"; reason: string | null }[] = [];
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    if (x.out == null) continue;
    const next = s[i + 1];
    if (!next && (x.end === "punch_out" || x.end === "auto_out")) continue;
    const kind = x.end === "break" ? "break" : x.end === "idle" ? "auto_break" : "away";
    out.push({ from: x.out, to: next ? next.in : x.end === "break" || x.end === "idle" ? null : now, kind, reason: x.reason ?? null });
  }
  return out;
}

/**
 * Where idleness stands, for the screen: how many minutes idle, and whether
 * the warning is showing. Only a running stretch is ever warned about.
 */
export function idleState(s: WorkdaySession[], lastActivity: number | null, now: number, cfg: WorkdayCfg): { idleMinutes: number; warn: boolean; breakAt: number | null } {
  const open = openSession(s);
  if (!open) return { idleMinutes: 0, warn: false, breakAt: null };
  const act = Math.max(lastActivity ?? open.in, open.in);
  const idleMinutes = Math.floor((now - act) / MIN);
  return { idleMinutes, warn: idleMinutes >= cfg.warnMinutes, breakAt: act + cfg.breakMinutes * MIN };
}

export type DayVerdict = "present" | "half_day" | "absent" | "extra" | "working";

/**
 * Present, half day or absent, on hours worked with breaks left out. The same
 * rule as the MBOS handset. A day off (week off, holiday, leave) that somebody
 * worked anyway is EXTRA — never Present, never Absent. A day still running is
 * WORKING: judging it before it ends would call every morning absent.
 */
export function dayVerdict(x: { workedMin: number; presentMin: number; halfMin: number; offDay: string | null; running: boolean }): DayVerdict {
  if (x.offDay) return "extra";
  if (x.running) return "working";
  if (x.workedMin >= x.presentMin) return "present";
  if (x.workedMin >= x.halfMin) return "half_day";
  return "absent";
}

/**
 * The three columns every older report reads, from the list: the first in,
 * the last out (only once the day is closed), and the minutes between
 * stretches. `out − in − stoppage` then equals the worked total exactly.
 */
export function mirrors(s: WorkdaySession[], now: number, approved: Span[] = []): { firstIn: number | null; lastOut: number | null; stoppageMin: number } {
  const phase = phaseOf(s);
  const closed = phase === "done" || phase === "auto_out";
  const last = s[s.length - 1];
  return {
    firstIn: s[0]?.in ?? null,
    lastOut: closed && last?.out != null ? last.out : null,
    stoppageMin: Math.round(gapMs(s, closed && last?.out != null ? last.out : now, approved) / MIN),
  };
}

/** Is this setting set sensible: warn before break before punch-out. */
export function cfgProblem(cfg: WorkdayCfg): string | null {
  if (!(cfg.warnMinutes < cfg.breakMinutes)) return "The idle warning has to come before the automatic break.";
  if (!(cfg.breakMinutes < cfg.outMinutes)) return "The automatic break has to come before the automatic punch-out.";
  if (cfg.breakOutMinutes < 1) return "A break has to be allowed at least a minute.";
  return null;
}
