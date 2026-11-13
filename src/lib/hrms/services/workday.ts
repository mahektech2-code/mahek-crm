import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAttendance, hrmsWorkdayClaims, type HrmsAttendance, type WorkdaySessionJson } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { listUserApps } from "@/lib/access";
import type { User } from "@/db/schema";
import type { HrmsContext } from "../access";
import { approvedLeave, attendanceCfg, fieldDayOn, holidays } from "./attendance";
import { timingMap } from "./people";
import { holidayApplies } from "../engines/leave";
import {
  breaksOf,
  dayVerdict,
  idleState,
  isLocked,
  mirrors,
  phaseOf,
  settle,
  workedMs,
  type DayVerdict,
  type Span,
  type WorkdayCfg,
  type WorkdayPhase,
  type WorkdaySession,
} from "../engines/workday";
import { nowHM, weekdayOf } from "../time";
import { today } from "../server";

/* ---------------------------------------------------------------------------
 * THE WORKDAY CLOCK, wired to data. The rules are `engines/workday.ts`; this
 * file reads the day, settles it against the idle clock, writes it back with
 * its mirrors, and answers "is this person locked out" for the screens and
 * for the server. See AGENTS.md, "The workday clock".
 * ------------------------------------------------------------------------- */

export async function workdayCfg(): Promise<WorkdayCfg & { lockEnabled: boolean; exemptPlatformAdmins: boolean; breakReasons: string[] }> {
  const c = await getConfig();
  return {
    warnMinutes: c["hrms.workday.idleWarnMinutes"],
    breakMinutes: c["hrms.workday.idleBreakMinutes"],
    outMinutes: c["hrms.workday.idleOutMinutes"],
    breakOutMinutes: c["hrms.workday.breakOutMinutes"],
    lockEnabled: c["hrms.workday.lockEnabled"],
    exemptPlatformAdmins: c["hrms.workday.exemptPlatformAdmins"],
    breakReasons: c["hrms.workday.breakReasons"]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

/** An instant from a business date and an HH:MM, in India's zone. */
export function instantOf(date: string, hm: string): number {
  return Date.parse(`${date}T${hm.length === 5 ? hm : hm.padStart(5, "0")}:00+05:30`);
}

/**
 * The day's stretches. A row written before the clock carries none, and is
 * read as one stretch from its check-in to its check-out — so every day
 * already recorded keeps meaning exactly what it meant.
 */
export function sessionsOf(row: Pick<HrmsAttendance, "sessions" | "date" | "checkIn" | "checkOut">): WorkdaySession[] {
  const list = (row.sessions ?? []) as WorkdaySessionJson[];
  if (list.length) return list.map((s) => ({ ...s }));
  if (!row.checkIn) return [];
  return [
    {
      in: instantOf(row.date, row.checkIn),
      out: row.checkOut ? instantOf(row.date, row.checkOut) : null,
      end: row.checkOut ? "punch_out" : null,
      reason: null,
    },
  ];
}

/** The approved claims of a day, as spans counted as work. */
export async function approvedSpans(attendanceId: string): Promise<Span[]> {
  const rows = await db
    .select({ from: hrmsWorkdayClaims.fromAt, to: hrmsWorkdayClaims.toAt })
    .from(hrmsWorkdayClaims)
    .where(and(eq(hrmsWorkdayClaims.attendanceId, attendanceId), eq(hrmsWorkdayClaims.status, "approved")));
  return rows.map((r) => ({ from: r.from.getTime(), to: r.to.getTime() }));
}

/**
 * The patch that writes a list of stretches back, with the three mirrors every
 * older report reads. `checkIn` is left as it was stamped — it is the first
 * punch-in and the lateness is measured from it.
 */
export function mirrorPatch(sessions: WorkdaySession[], now: number, approved: Span[]): Partial<HrmsAttendance> {
  const m = mirrors(sessions, now, approved);
  return {
    sessions: sessions as WorkdaySessionJson[],
    checkOut: m.lastOut != null ? nowHM(new Date(m.lastOut)) : null,
    stoppageMin: m.stoppageMin,
    updatedAt: new Date(),
  };
}

/**
 * Is today a day off for this person — and which. A week off is a weekday
 * their working hours do not cover (when they have any working hours at all);
 * a holiday is one in the HRMS calendar that applies to them; leave is a full
 * day of approved leave. A half day of leave is not a day off: it lowers the
 * hours needed to be present instead, the MBOS rule.
 */
export async function offDayFor(employeeId: string, office: string | null, date: string): Promise<{ offDay: "week_off" | "holiday" | "leave" | null; halfLeave: boolean; holidayName: string | null }> {
  const [timings, hols, leave] = await Promise.all([timingMap(), holidays(date, date), approvedLeave([employeeId])]);
  const covering = leave.filter((l) => l.startDate <= date && l.endDate >= date);
  const holiday = hols.find((h) => holidayApplies(h, employeeId, office));
  if (holiday) return { offDay: "holiday", halfLeave: false, holidayName: holiday.name };
  if (covering.some((l) => l.type !== "Half Day")) return { offDay: "leave", halfLeave: false, holidayName: null };
  const hasAny = [...timings.keys()].some((k) => k.startsWith(`${employeeId}|`));
  if (hasAny && !timings.get(`${employeeId}|${weekdayOf(date)}`)) return { offDay: "week_off", halfLeave: false, holidayName: null };
  return { offDay: null, halfLeave: covering.length > 0, holidayName: null };
}

/** Minutes to be Present and to be a Half day on a date, from the weekday's timing or the settings. */
export async function thresholdsFor(employeeId: string, date: string, halfLeave: boolean): Promise<{ presentMin: number; halfMin: number }> {
  const [timings, cfg] = await Promise.all([timingMap(), attendanceCfg()]);
  const t = timings.get(`${employeeId}|${weekdayOf(date)}`);
  const present = t?.presentMin ?? cfg.presentMin ?? 480;
  const half = t?.halfMin ?? cfg.halfMin ?? 240;
  /* Half a day's leave leaves half a day to be worked. */
  return halfLeave ? { presentMin: half, halfMin: Math.min(half, Math.round(half / 2)) } : { presentMin: present, halfMin: half };
}

/** Read today's row and settle it against the idle clock, writing back what moved. */
export async function settledToday(employeeId: string, now = Date.now()): Promise<HrmsAttendance | null> {
  const [row] = await db
    .select()
    .from(hrmsAttendance)
    .where(and(eq(hrmsAttendance.employeeId, employeeId), eq(hrmsAttendance.date, today())));
  if (!row) return null;
  const cfg = await workdayCfg();
  const s = sessionsOf(row);
  const r = settle(s, row.lastActivityAt?.getTime() ?? null, now, cfg);
  if (!r.changed) return row;
  const patch = mirrorPatch(r.sessions, now, await approvedSpans(row.id));
  await db.update(hrmsAttendance).set(patch).where(eq(hrmsAttendance.id, row.id));
  return { ...row, ...patch } as HrmsAttendance;
}

/** Who the clock applies to, and who it never locks. */
export async function subjectOf(ctx: HrmsContext): Promise<{ subject: boolean; exempt: string | null }> {
  if (!ctx.level) return { subject: false, exempt: "no-hrms" };
  if (!ctx.employee) return { subject: false, exempt: "not-linked" };
  if (ctx.employee.status !== "active") return { subject: false, exempt: "inactive" };
  const [apps, cfg] = await Promise.all([listUserApps(ctx.user.id), workdayCfg()]);
  /* A field salesman's day is the MBOS handset's. */
  if (apps.includes("field")) return { subject: false, exempt: "field" };
  if (cfg.exemptPlatformAdmins && ctx.platformAdmin) return { subject: true, exempt: "platform-admin" };
  return { subject: true, exempt: null };
}

export type WorkdayState = {
  subject: boolean;
  /** Why the lock never applies to this person, when it does not. */
  exempt: string | null;
  lockEnabled: boolean;
  locked: boolean;
  phase: WorkdayPhase;
  now: number;
  date: string;
  name: string;
  office: string | null;
  official: string | null;
  sessions: WorkdaySession[];
  lastActivity: number | null;
  workedMs: number;
  breaks: { from: number; to: number | null; kind: "break" | "auto_break" | "away"; reason: string | null }[];
  presentMin: number;
  halfMin: number;
  offDay: "week_off" | "holiday" | "leave" | null;
  holidayName: string | null;
  verdict: DayVerdict | null;
  cfg: WorkdayCfg;
  breakReasons: string[];
  idleWarn: boolean;
  /** The field app holds today. */
  onHandset: boolean;
  canLateHelp: boolean;
  pendingClaims: number;
  firstIn: string | null;
};

/** Everything a screen needs to draw the clock, settled as of now. */
export async function workdayState(ctx: HrmsContext): Promise<WorkdayState> {
  const now = Date.now();
  const date = today();
  const [cfg, who] = await Promise.all([workdayCfg(), subjectOf(ctx)]);
  const me = ctx.employee;
  const timings = me ? await timingMap() : new Map();
  const tm = me ? timings.get(`${me.id}|${weekdayOf(date)}`) : undefined;
  const base: WorkdayState = {
    subject: who.subject,
    exempt: who.exempt,
    lockEnabled: cfg.lockEnabled,
    locked: false,
    phase: "none",
    now,
    date,
    name: me?.name ?? ctx.user.name,
    office: me?.office ?? null,
    official: tm ? `${tm.inTime} – ${tm.outTime}` : null,
    sessions: [],
    lastActivity: null,
    workedMs: 0,
    breaks: [],
    presentMin: 480,
    halfMin: 240,
    offDay: null,
    holidayName: null,
    verdict: null,
    cfg,
    breakReasons: cfg.breakReasons,
    idleWarn: false,
    onHandset: false,
    canLateHelp: ctx.screens.has("help"),
    pendingClaims: 0,
    firstIn: null,
  };
  if (!me || !who.subject) return base;
  const [row, off, handset] = await Promise.all([settledToday(me.id, now), offDayFor(me.id, me.office, date), fieldDayOn(me.id, date)]);
  const th = row?.presentMin != null && row?.halfMin != null ? { presentMin: row.presentMin, halfMin: row.halfMin } : await thresholdsFor(me.id, date, off.halfLeave);
  const sessions = row ? sessionsOf(row) : [];
  const phase = phaseOf(sessions);
  const approved = row ? await approvedSpans(row.id) : [];
  const worked = workedMs(sessions, now, approved);
  const offDay = (row?.offDay as WorkdayState["offDay"]) ?? off.offDay;
  const pending = row
    ? (await db.select({ id: hrmsWorkdayClaims.id }).from(hrmsWorkdayClaims).where(and(eq(hrmsWorkdayClaims.attendanceId, row.id), eq(hrmsWorkdayClaims.status, "pending")))).length
    : 0;
  const lastActivity = row?.lastActivityAt?.getTime() ?? null;
  return {
    ...base,
    phase,
    sessions,
    lastActivity,
    workedMs: worked,
    breaks: breaksOf(sessions, now),
    presentMin: th.presentMin,
    halfMin: th.halfMin,
    offDay,
    holidayName: off.holidayName,
    verdict: sessions.length
      ? dayVerdict({ workedMin: Math.floor(worked / 60_000), presentMin: th.presentMin, halfMin: th.halfMin, offDay, running: phase === "working" || phase === "break" || phase === "auto_break" })
      : null,
    idleWarn: idleState(sessions, lastActivity, now, cfg).warn,
    onHandset: !!handset && !row,
    pendingClaims: pending,
    firstIn: row?.checkIn ?? null,
    locked: lockApplies({ lockEnabled: cfg.lockEnabled, subject: who.subject, exempt: who.exempt, offDay, onHandset: !!handset && !row, phase }),
  };
}

/** The lock, as one rule the screen and the server both ask. */
export function lockApplies(x: { lockEnabled: boolean; subject: boolean; exempt: string | null; offDay: string | null; onHandset: boolean; phase: WorkdayPhase }): boolean {
  if (!x.lockEnabled || !x.subject || x.exempt) return false;
  /* A day off is never locked: whoever works it does so by choice. */
  if (x.offDay) return false;
  if (x.onHandset) return false;
  return isLocked(x.phase);
}

/* ---------------------------------------------------------------- server lock */

const lockCache = new Map<string, { at: number; locked: boolean }>();
const LOCK_CACHE_MS = 10_000;

/** Forget a person's cached answer, after anything that changes their day. */
export function forgetLock(userId: string) {
  lockCache.delete(userId);
}

/**
 * Is this signed-in account locked out of saving anything? Asked by
 * `requireUser` for every server action. Cheap when the lock is off (one
 * cached settings read) and cached for a few seconds per person when it is on.
 */
const checking = new AsyncLocalStorage<boolean>();

export async function serverLocked(user: User): Promise<boolean> {
  /* Working the answer out signs in again (`hrmsContext` calls
     `requireUser`), which would ask this again: the inner ask is answered
     "not locked" so the outer one can finish. */
  if (checking.getStore()) return false;
  const c = await getConfig();
  if (!c["hrms.workday.lockEnabled"]) return false;
  if (!user.employeeId) return false;
  const hit = lockCache.get(user.id);
  if (hit && Date.now() - hit.at < LOCK_CACHE_MS) return hit.locked;
  return checking.run(true, async () => {
    const { hrmsContext } = await import("../access");
    const ctx = await hrmsContext();
    const s = await workdayState(ctx);
    lockCache.set(user.id, { at: Date.now(), locked: s.locked });
    return s.locked;
  });
}
