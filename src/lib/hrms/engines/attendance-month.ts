/* ---------------------------------------------------------------------------
 * ONE PERSON'S MONTH, as the Workday Clock design's "My attendance" draws it:
 * a tile per day and the figures above the calendar. Pure — the screen hands
 * it the days worked, the holidays, the leave and which weekdays are working
 * days, and it says what each date was. A day off is never Absent, and hours
 * worked on one are extra work, exactly as `dayVerdict` rules.
 * ------------------------------------------------------------------------- */

export type MonthDayKind = "full" | "half" | "absent" | "off" | "leave" | "holiday" | "extra" | "today" | "future";

export type MonthDay = {
  date: string;
  kind: MonthDayKind;
  /** Minutes worked, where anything was. */
  workedMin: number | null;
  /** The holiday's name, on a holiday. */
  label: string | null;
  lateBeyondGrace: boolean;
};

export type MonthInput = {
  dates: string[];
  today: string;
  /** Worked days: the verdict the register reached and the minutes behind it. */
  worked: Map<string, { workDay: string; workedMin: number | null; open: boolean; lateBeyondGrace: boolean }>;
  holidays: Map<string, string>;
  /** Dates of approved full-day leave. */
  leave: Set<string>;
  /** Is this date a working day for the person (their timings, else every day). */
  workingDay: (date: string) => boolean;
};

export function monthDays(x: MonthInput): MonthDay[] {
  return x.dates.map((date) => {
    const w = x.worked.get(date);
    const base = { date, workedMin: w?.workedMin ?? null, label: null as string | null, lateBeyondGrace: !!w?.lateBeyondGrace };
    const off = x.holidays.has(date) ? "holiday" : x.leave.has(date) ? "leave" : !x.workingDay(date) ? "off" : null;
    if (w && off) return { ...base, kind: date === x.today && w.open ? "today" : "extra", label: x.holidays.get(date) ?? null };
    if (date === x.today && (!w || w.open)) return { ...base, kind: w ? "today" : off ?? "today", label: x.holidays.get(date) ?? null };
    if (off) return { ...base, kind: off, label: x.holidays.get(date) ?? null };
    if (date > x.today) return { ...base, kind: "future" };
    if (!w) return { ...base, kind: "absent" };
    return { ...base, kind: w.workDay === "Full Day" ? "full" : w.workDay === "Half Day" ? "half" : w.workDay === "Extra" ? "extra" : "absent" };
  });
}

export type MonthFigures = {
  present: number;
  workingDaysSoFar: number;
  half: string[];
  absent: string[];
  notCounted: { off: number; holiday: number; leave: number };
  averageWorkedMin: number | null;
  extraMin: number;
  extraDates: string[];
  late: number;
};

export function monthFigures(days: MonthDay[], today: string): MonthFigures {
  const counted = days.filter((d) => d.date <= today && (d.kind === "full" || d.kind === "half" || d.kind === "absent"));
  const workedDays = days.filter((d) => (d.kind === "full" || d.kind === "half") && d.workedMin != null);
  const extra = days.filter((d) => d.kind === "extra");
  return {
    present: days.filter((d) => d.kind === "full").length,
    workingDaysSoFar: counted.length,
    half: days.filter((d) => d.kind === "half").map((d) => d.date),
    absent: days.filter((d) => d.kind === "absent").map((d) => d.date),
    notCounted: {
      off: days.filter((d) => d.kind === "off" && d.date <= today).length,
      holiday: days.filter((d) => d.kind === "holiday" && d.date <= today).length,
      leave: days.filter((d) => d.kind === "leave" && d.date <= today).length,
    },
    averageWorkedMin: workedDays.length ? Math.round(workedDays.reduce((n, d) => n + (d.workedMin ?? 0), 0) / workedDays.length) : null,
    extraMin: extra.reduce((n, d) => n + (d.workedMin ?? 0), 0),
    extraDates: extra.map((d) => d.date),
    late: days.filter((d) => d.lateBeyondGrace).length,
  };
}

/** The month's dates padded to whole Monday-first weeks: nulls before the 1st. */
export function calendarCells(month: string): (string | null)[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  return cells;
}

/** "2026-11" ± n months. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
