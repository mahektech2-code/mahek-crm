/* ---------------------------------------------------------------------------
 * The monthly attendance report (spec §9), PURE.
 * ------------------------------------------------------------------------- */

import { tmin } from "../time";
import type { DayFigures } from "./attendance";

export type MonthlyDay = { date: string; checkIn: string; officialIn: string | null; targetMin: number | null; fig: DayFigures };

export type MonthlyFigures = {
  attended: number;
  openDays: number;
  late: number;
  lateOver: number;
  onTime: number;
  checkInPct: number | null;
  overallPct: number | null;
  lateOverPct: number | null;
  targetMin: number;
  achievedMin: number;
  lateDurationMin: number;
  halfDays: number;
  fullDays: number;
  pendingCheckouts: number;
  missing: string[];
};

export function monthlyFigures(x: {
  days: MonthlyDay[];
  /** Dates on which anybody attended (the office was open). */
  openDates: string[];
  holidayDates: string[];
  leaveDates: string[];
  lateOverMinutes: number;
}): MonthlyFigures {
  const dates = new Set(x.days.map((d) => d.date));
  let late = 0;
  let lateOver = 0;
  let onTime = 0;
  let targetMin = 0;
  let achievedMin = 0;
  let lateDurationMin = 0;
  let halfDays = 0;
  let fullDays = 0;
  let pending = 0;
  for (const d of x.days) {
    const inM = tmin(d.checkIn);
    const off = tmin(d.officialIn);
    if (inM != null && off != null) {
      if (inM > off) late++;
      else onTime++;
      if (inM - x.lateOverMinutes > off) lateOver++;
    }
    targetMin += d.targetMin ?? 0;
    achievedMin += d.fig.workedMin ?? 0;
    if (d.fig.workDay === "Full Day") {
      fullDays++;
      if (d.fig.lateBeyondGrace && d.fig.lateOrEarlyMin != null) lateDurationMin += -d.fig.lateOrEarlyMin;
    }
    if (d.fig.workDay === "Half Day") halfDays++;
    if (d.fig.workDay === "") pending++;
  }
  const attended = dates.size;
  const excused = new Set([...x.holidayDates, ...x.leaveDates]);
  const missing = x.openDates.filter((d) => !dates.has(d) && !excused.has(d)).sort();
  return {
    attended,
    openDays: new Set(x.openDates).size,
    late,
    lateOver,
    onTime,
    checkInPct: attended ? Math.round((onTime * 100) / attended) : null,
    overallPct: targetMin ? Math.round((achievedMin * 100) / targetMin) : null,
    lateOverPct: attended ? Math.round((lateOver * 100) / attended) : null,
    targetMin,
    achievedMin,
    lateDurationMin,
    halfDays,
    fullDays,
    pendingCheckouts: pending,
    missing,
  };
}
