/* ---------------------------------------------------------------------------
 * Attendance rules (spec §6), PURE: the figures a day carries and the check-in
 * decision. Configuration and the clock come in as arguments.
 * ------------------------------------------------------------------------- */

import { hhmm, tmin } from "../time";

export type AttendanceCfg = {
  graceMinutes: number;
  fullDayPercent: number;
  qrGraceMinutes: number;
  qrFullDayPercent: number;
};

export type AttendanceDay = {
  date: string;
  checkIn: string;
  checkOut: string | null;
  stoppageMin: number;
  officialIn: string | null;
  officialOut: string | null;
  targetMin: number | null;
  method: string;
};

export type DayFigures = {
  /** Check-out − check-in, or null until checked out. */
  durationMin: number | null;
  /** Duration − unplanned stoppage (the source's Total Today Working Hour). */
  workedMin: number | null;
  /** Minutes after the official in-time (negative = early); null without a timing. */
  lateMin: number | null;
  /** (official in + grace) − check in: negative means late beyond the grace. */
  lateOrEarlyMin: number | null;
  lateBeyondGrace: boolean;
  lateTxt: string;
  /** Worked ÷ target, a whole percent. */
  pct: number | null;
  /** Full Day / Half Day once checked out; "" before. */
  workDay: "" | "Full Day" | "Half Day";
  /** On Working / Present / No check-out. */
  current: "On Working" | "Present" | "No check-out";
  /** Target − duration. */
  differenceMin: number | null;
};

/** "0:12:00", the source's duration spelling. */
export function hms(min: number): string {
  const a = Math.abs(Math.round(min));
  return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}:00`;
}

export function dayFigures(r: AttendanceDay, cfg: AttendanceCfg, today: string): DayFigures {
  const qr = r.method === "qr";
  const grace = qr ? cfg.qrGraceMinutes : cfg.graceMinutes;
  const inM = tmin(r.checkIn);
  const outM = tmin(r.checkOut);
  const offIn = tmin(r.officialIn);
  const durationMin = inM != null && outM != null ? outM - inM : null;
  const workedMin = durationMin == null ? null : durationMin - (r.stoppageMin || 0);
  const lateMin = inM != null && offIn != null ? inM - offIn : null;
  const lateOrEarlyMin = inM != null && offIn != null ? offIn + grace - inM : null;
  const lateBeyondGrace = lateOrEarlyMin != null && lateOrEarlyMin < 0;
  const target = r.targetMin ?? null;
  const pct = workedMin != null && target ? Math.round((workedMin * 100) / target) : null;
  let workDay: DayFigures["workDay"] = "";
  if (workedMin != null) {
    const full = qr ? (pct ?? 0) > cfg.qrFullDayPercent : (pct ?? 0) >= cfg.fullDayPercent;
    workDay = target ? (full ? "Full Day" : "Half Day") : "Full Day";
  }
  const current = r.checkOut ? "Present" : r.date === today ? "On Working" : "No check-out";
  return {
    durationMin,
    workedMin,
    lateMin,
    lateOrEarlyMin,
    lateBeyondGrace,
    lateTxt: lateMin == null ? "No timing set" : lateMin > 0 ? `Late ${lateMin} min` : lateMin < 0 ? `Early ${-lateMin} min` : "On time",
    pct,
    workDay,
    current,
    differenceMin: target != null && durationMin != null ? target - durationMin : null,
  };
}

/** The late / early sentence the source put on every day (spec §6.1), in its words. */
export function timeRemark(f: DayFigures, name: string, method = "geo"): string {
  if (f.lateOrEarlyMin == null) return "";
  const d = hms(f.lateOrEarlyMin);
  if (method === "qr")
    return f.lateBeyondGrace ? `You are late ${d} This is not good ${name}` : `You are early ${d} You are Great ${name}`;
  return f.lateBeyondGrace
    ? `You Are late. ${d} Time Is The Currency Of Productivity. Punctuality Is The Key To Success. Let's Make Every Minute Count. ${name}`
    : `You Are Early. ${d} That’s Superb 👌 And We Value Your Dedication ! ${name}`;
}

/* ------------------------------------------------------------ check-in */

export type CheckInInput = {
  alreadyToday: boolean;
  /** Null when the browser gave no position. */
  distanceM: number | null;
  officeHasPin: boolean;
  officeName: string;
  radiusM: number;
  /** Holds the attendance-all power (HR, admin): 9 km instead of the office radius. */
  privileged: boolean;
  privilegedRangeM: number;
  officialIn: string | null;
  now: string;
  graceMinutes: number;
  name: string;
};

export type CheckInRefusal = "already" | "denied" | "noPin" | "outside" | "late";

export type CheckInDecision = { ok: true } | { ok: false; reason: CheckInRefusal; message: string; detail: string };

/**
 * Whether a check-in stands (spec §6.2). The order matters: a second check-in
 * is refused before anything is measured, and a late arrival only after the
 * person is shown to be at the office.
 */
export function decideCheckIn(x: CheckInInput): CheckInDecision {
  if (x.alreadyToday) return { ok: false, reason: "already", message: "You Today Already Checked In!", detail: "Check out at the end of the day." };
  if (x.distanceM == null)
    return {
      ok: false,
      reason: "denied",
      message: "Location is turned off for this site",
      detail: "HRMS needs your location to check you in. Allow location in your browser settings, then try again. If you cannot, ask your head to mark you.",
    };
  if (!x.officeHasPin)
    return {
      ok: false,
      reason: "noPin",
      message: `${x.officeName} has no map pin yet`,
      detail: "HR sets the office's location on the Offices screen. Until then, ask your head to mark you.",
    };
  const range = x.privileged ? x.privilegedRangeM : x.radiusM;
  if (x.distanceM > range)
    return {
      ok: false,
      reason: "outside",
      message: `You are out of office location ! Please Back To Office ${x.name} Then Try to Check in Again!`,
      detail: `You are ${x.distanceM >= 1000 ? (x.distanceM / 1000).toFixed(1) + " km" : x.distanceM + " m"} from ${x.officeName}. The office radius is ${range} m.`,
    };
  const offIn = tmin(x.officialIn);
  const nowM = tmin(x.now);
  if (!x.privileged && offIn != null && nowM != null && nowM > offIn + x.graceMinutes)
    return {
      ok: false,
      reason: "late",
      message: "Late Punch-in, Today Unpaid Leave. Contact Admin",
      detail: `It is more than ${x.graceMinutes} minutes past your ${hhmm(offIn)} start. Raise a help request so admin can decide.`,
    };
  return { ok: true };
}

/** Whether a check-out stands: the same geofence (spec §6.2). */
export function decideCheckOut(x: Omit<CheckInInput, "alreadyToday" | "officialIn" | "now" | "graceMinutes">): CheckInDecision {
  if (x.distanceM == null)
    return { ok: false, reason: "denied", message: "Location is turned off for this site", detail: "HRMS needs your location to check you out." };
  if (!x.officeHasPin) return { ok: true };
  const range = x.privileged ? x.privilegedRangeM : x.radiusM;
  if (x.distanceM > range)
    return {
      ok: false,
      reason: "outside",
      message: `You are out of office location ! Please Back To Office ${x.name} Then Try to Check Out Again!`,
      detail: `You are ${x.distanceM >= 1000 ? (x.distanceM / 1000).toFixed(1) + " km" : x.distanceM + " m"} from ${x.officeName}. The office radius is ${range} m.`,
    };
  return { ok: true };
}

/** A checked-out day's minutes from "HH:MM" pairs; null when either is missing or out is not after in. */
export function minutesBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = tmin(a);
  const y = tmin(b);
  return x == null || y == null || y <= x ? null : y - x;
}
