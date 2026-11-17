/* ---------------------------------------------------------------------------
 * The monthly attendance report (spec §9), PURE.
 * ------------------------------------------------------------------------- */

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
  /* No late, no on time (Nov 2026): people punch in when they choose, so
     these stay at zero for every reader that still asks. */
  const late = 0;
  const lateOver = 0;
  const onTime = 0;
  let targetMin = 0;
  let achievedMin = 0;
  const lateDurationMin = 0;
  let halfDays = 0;
  let fullDays = 0;
  let pending = 0;
  for (const d of x.days) {
    targetMin += d.targetMin ?? 0;
    achievedMin += d.fig.workedMin ?? 0;
    if (d.fig.workDay === "Full Day") fullDays++;
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
    checkInPct: null,
    overallPct: targetMin ? Math.round((achievedMin * 100) / targetMin) : null,
    lateOverPct: null,
    targetMin,
    achievedMin,
    lateDurationMin,
    halfDays,
    fullDays,
    pendingCheckouts: pending,
    missing,
  };
}
