/* ---------------------------------------------------------------------------
 * Performance rules (spec §12), PURE: the daily sales score (§12.2), the
 * monthly staff performance (§12.3), performance points for any period
 * (§12.4) and the Employee of the Month mark (§12.5). Configuration comes in
 * as an argument; the screens gather the counts.
 *
 * Where the source's arithmetic contradicts itself the spec's §19 reading is
 * used and named beside the line (A17–A25). Where the source would divide by
 * nothing the answer is chosen here and said once, beside the guard.
 * ------------------------------------------------------------------------- */

export const W9_KEYS = ["visits", "timeCust", "noteLen", "hours", "km", "amount", "litres", "outstanding", "tasks"] as const;
export type W9Key = (typeof W9_KEYS)[number];
export type PerfWeights = Record<W9Key, number>;

export const W9_LABEL: Record<W9Key, string> = {
  visits: "Visits",
  timeCust: "Time with customer",
  noteLen: "Note length",
  hours: "Working hours",
  km: "Km",
  amount: "Sales",
  litres: "Litres",
  outstanding: "Outstanding",
  tasks: "Tasks",
};

export type DailyCfg = {
  weights: PerfWeights;
  /** Monthly targets ÷ this = a day's target (25). */
  dailyDivisor: number;
  /** Minutes per visit that earn the full time component (5). */
  timeGivenBase: number;
  /** Note characters per visit that earn the full description component (25). */
  descriptionBase: number;
  /** Average payment days under each band (15 / 30 / 45). */
  outstandingBands: [number, number, number];
  /** GST added to the KPI sales amount for "total sale" (18, A24). */
  gstPercent: number;
};

export const DEFAULT_DAILY: Omit<DailyCfg, "weights" | "dailyDivisor" | "gstPercent"> = {
  timeGivenBase: 5,
  descriptionBase: 25,
  outstandingBands: [15, 30, 45],
};

/** Characters of a meeting note, not counting spaces and commas (A19: the source counts characters, not words). */
export function noteLength(text: string | null | undefined): number {
  return String(text ?? "").replace(/[ ,]/g, "").length;
}

/** Monthly targets, as `employees` holds them. Null is "never set". */
export type MonthlyTargets = {
  visits: number | null;
  km: number | null;
  litres: number | null;
  /** Working hours a month. */
  hours: number | null;
  amountPaise: number | null;
};

export type DailyInput = {
  targets: MonthlyTargets;
  visits: number;
  /** Activity "time given" that date, minutes. */
  timeGivenMin: number;
  /** Characters of that date's meeting notes (see `noteLength`). */
  noteChars: number;
  /** KPI on-field time that date, minutes. */
  onFieldMin: number;
  km: number;
  amountPaise: number;
  litres: number;
  /** That date's KPI outstanding. */
  outstandingPaise: number;
  /** The salesman's KPI amount of sales from the financial-year start to the date. */
  fySalesPaise: number;
  /** Days from the financial-year start to the date. */
  daysSinceFy: number;
  /** To-dos assigned to the salesman dated that date, and how many are verified. */
  todos: { total: number; verified: number };
};

export type ScorePart = { k: W9Key; l: string; got: number; max: number };

export type DailyScore = {
  parts: ScorePart[];
  /** Per-day performance: the sum of the nine components. Can exceed 100 (A18). */
  total: number;
  dailyTargets: { visits: number; hours: number; km: number; amountPaise: number; litres: number };
  /** Minutes with a customer per visit. */
  timePerVisit: number;
  /** Note characters per visit. */
  notePerVisit: number;
  /** Total sale with GST since the financial-year start. */
  totalSalePaise: number;
  /** Average payment days, or null when nothing was sold since the FY start. */
  paymentDays: number | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
/** a ÷ b, or 0 where there is nothing to divide by (the source shows an error there, which scores nothing). */
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

/** The outstanding band a number of payment days falls in: 1, ½, ¼ or 0 of the full mark. */
export function outstandingShare(days: number, bands: [number, number, number]): number {
  if (days < bands[0]) return 1;
  if (days < bands[1]) return 0.5;
  if (days < bands[2]) return 0.25;
  return 0;
}

/**
 * §12.2 — one salesman's score for one date. "× 100 × w%" in the spec is
 * "× w" here: the same arithmetic with the weight as configuration.
 */
export function dailyScore(x: DailyInput, cfg: DailyCfg): DailyScore {
  const w = cfg.weights;
  const d = cfg.dailyDivisor || 25;
  const t = {
    visits: Math.round((x.targets.visits ?? 0) / d),
    hours: (x.targets.hours ?? 0) / d,
    km: Math.round((x.targets.km ?? 0) / d),
    /* The source rounds rupees, so the day's target is whole rupees. */
    amountPaise: Math.round((x.targets.amountPaise ?? 0) / 100 / d) * 100,
    litres: Math.round((x.targets.litres ?? 0) / d),
  };
  const timePerVisit = ratio(x.timeGivenMin, x.visits);
  const notePerVisit = ratio(x.noteChars, x.visits);
  const hours = x.onFieldMin / 60;
  const totalSalePaise = Math.round(x.fySalesPaise * (1 + cfg.gstPercent / 100));
  /* Nothing sold since the FY start: no days can be worked out. Nothing owed
     then is the best position there is; anything owed is the worst. */
  const paymentDays = totalSalePaise > 0 ? (x.outstandingPaise / totalSalePaise) * x.daysSinceFy : null;
  const outShare = paymentDays == null ? (x.outstandingPaise > 0 ? 0 : 1) : outstandingShare(paymentDays, cfg.outstandingBands);

  const got: Record<W9Key, number> = {
    visits: Math.min(ratio(x.visits, t.visits) * w.visits, w.visits),
    timeCust: Math.min(ratio(timePerVisit, cfg.timeGivenBase) * w.timeCust, w.timeCust),
    noteLen: Math.min(ratio(notePerVisit, cfg.descriptionBase) * w.noteLen, w.noteLen),
    hours: Math.min(ratio(hours, t.hours) * w.hours, w.hours),
    km: Math.min(ratio(x.km, t.km) * w.km, w.km),
    /* A18: sales and litres are not capped — a day can score above 100. */
    amount: ratio(x.amountPaise, t.amountPaise) * w.amount,
    litres: ratio(x.litres, t.litres) * w.litres,
    outstanding: outShare * w.outstanding,
    /* No to-dos that date: nothing was left undone, the full mark. */
    tasks: x.todos.total ? (x.todos.verified / x.todos.total) * w.tasks : w.tasks,
  };
  const parts = W9_KEYS.map((k) => ({ k, l: W9_LABEL[k], got: r2(got[k]), max: w[k] }));
  return {
    parts,
    total: r2(W9_KEYS.reduce((a, k) => a + got[k], 0)),
    dailyTargets: t,
    timePerVisit: r2(timePerVisit),
    notePerVisit: r2(notePerVisit),
    totalSalePaise,
    paymentDays: paymentDays == null ? null : r2(paymentDays),
  };
}

/* ------------------------------------------------------ staff performance */

export type StaffMonthInput = {
  /** Sales position types score daily work from the KPI instead of the checklist. */
  sales: boolean;
  /** Attendance rows in the month: duration (minutes, null while open) and whether the remark is "early". */
  days: { durationMin: number | null; early: boolean }[];
  /** Target minutes of every working date of the month (days less tagged holidays), each from that weekday's timing. */
  targetMinutes: number[];
  checklist: { status: string }[];
  /** Sales only: the month's daily scores' visit, time, description and km components. */
  kpiParts: { visits: number; timeCust: number; noteLen: number; km: number }[];
  /** To-dos given in the month: days given (till − for) and, when done, days taken (done − for). */
  todos: { done: boolean; daysGiven: number | null; daysTaken: number | null }[];
  buddy: { done: boolean }[];
};

export type StaffMonth = {
  workingHoursPct: number;
  punctualityPct: number;
  notDoneChecklist: number;
  /** "KPI performance" for sales, daily done tasks otherwise. */
  dailyTaskPct: number;
  avgDaysToComplete: number | null;
  notDoneTodos: number;
  speed: string;
  todoPct: number;
  notDoneBuddy: number;
  buddyPct: number | null;
  overallPct: number;
};

const pct = (n: number) => Math.round(n * 1000) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** §12.3 — one employee's month. */
export function staffMonth(x: StaffMonthInput): StaffMonth {
  /* A22: the source formula is truncated; this is the spec's reading. */
  const worked = x.days.reduce((a, d) => a + (d.durationMin ?? 0), 0);
  const target = x.targetMinutes.reduce((a, b) => a + b, 0);
  const workingHoursPct = pct(ratio(worked, target));
  const punctualityPct = pct(ratio(x.days.filter((d) => d.early).length, x.days.length));
  const cleared = x.checklist.filter((c) => c.status === "Done" || c.status === "N/A").length;
  const notDoneChecklist = x.checklist.length - cleared;
  let dailyTaskPct: number;
  if (x.sales) {
    const four = avg(x.kpiParts.map((p) => p.visits)) + avg(x.kpiParts.map((p) => p.timeCust)) + avg(x.kpiParts.map((p) => p.noteLen)) + avg(x.kpiParts.map((p) => p.km));
    dailyTaskPct = pct(four / 25);
  } else dailyTaskPct = x.checklist.length ? pct(cleared / x.checklist.length) : 100;

  const done = x.todos.filter((t) => t.done && t.daysTaken != null);
  const avgTaken = done.length ? avg(done.map((t) => t.daysTaken!)) : null;
  const given = x.todos.filter((t) => t.daysGiven != null);
  const avgGiven = given.length ? avg(given.map((t) => t.daysGiven!)) : null;
  const notDoneTodos = x.todos.filter((t) => !t.done).length;
  /* No to-dos finished: nothing was slow. A same-day deadline divides by
     nothing, so on-time is full and late is none. The figure is held to
     0–100%: "1 − taken ÷ given" goes negative past twice the time given. */
  let todo = 1;
  if (avgTaken != null) {
    if (avgGiven && avgGiven > 0) todo = 1 - avgTaken / avgGiven;
    else todo = avgTaken > 0 ? 0 : 1;
  }
  const todoPct = pct(Math.max(0, Math.min(1, todo)));
  const speed = `Working Speed :- ${avgTaken == null ? 0 : Math.round(avgTaken * 10) / 10} Days Average And ${notDoneTodos} Task Not Done`;

  const buddyDone = x.buddy.filter((b) => b.done).length;
  /* A21: done ÷ all, not done ÷ not-done. */
  const buddyPct = x.buddy.length ? pct(buddyDone / x.buddy.length) : null;

  return {
    workingHoursPct,
    punctualityPct,
    notDoneChecklist,
    dailyTaskPct,
    avgDaysToComplete: avgTaken == null ? null : Math.round(avgTaken * 10) / 10,
    notDoneTodos,
    speed,
    todoPct,
    notDoneBuddy: x.buddy.length - buddyDone,
    buddyPct,
    overallPct: Math.round(((workingHoursPct + todoPct + dailyTaskPct + punctualityPct) / 4) * 10) / 10,
  };
}

/** §12.5 — at or above the mark. */
export const isEmployeeOfMonth = (overallPct: number, markPercent: number) => overallPct >= markPercent;

/** The month a staff performance row made on `date` scores: the month of (date − 28 days). */
export function scoredMonth(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 28));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ----------------------------------------------------- performance points */

export type PointKind = "Sales" | "OfficeStaff" | "Other";

/** The sheet's Position Type, read the way the total needs it (A20: OfficeStaff and Owner take the four-point average). */
export function pointKind(positionType: string | null | undefined): PointKind {
  const v = String(positionType ?? "").toLowerCase();
  if (/sales|field/.test(v)) return "Sales";
  if (/office|owner/.test(v)) return "OfficeStaff";
  return "Other";
}

export type PointBands = {
  outstanding: [number, number, number];
  /** Minutes a day with customers: above the first a full point, above the second half. */
  time: [number, number];
  /** Note characters per visit: above the first a full point, above the second half. */
  description: [number, number];
};

export const DEFAULT_POINT_BANDS: PointBands = { outstanding: [15, 30, 45], time: [180, 90], description: [25, 15] };

export type PointsCfg = { standardHours: number; periodDivisor: number; bands: PointBands };

export type PointsInput = {
  kind: PointKind;
  /** Days from `from` to `to`, both counted. */
  periodDays: number;
  attendanceRows: number;
  earlyRows: number;
  /** Holidays tagged to the employee inside the period (A23: they count as attended and on time). */
  taggedHolidays: number;
  /** Sum of durations of the period's rows, minutes. */
  durationMin: number;
  checklistTotal: number;
  checklistCleared: number;
  todosTotal: number;
  todosDone: number;
  naReasons: string[];
  targets: MonthlyTargets;
  salesPaise: number;
  litres: number;
  /** Outstanding on the latest KPI row up to the to-date. */
  latestOutstandingPaise: number;
  /** KPI sales from the financial date to the to-date. */
  salesSinceFinancialPaise: number;
  daysSinceFinancial: number;
  activityMinutes: number;
  activityDates: number;
  noteChars: number;
  kpiVisits: number;
};

export type Points = {
  attendanceCount: number;
  attendancePoint: number;
  punctualityCount: number;
  punctualityPoint: number;
  avgHours: number;
  workingHourPoint: number;
  taskCount: number | null;
  naText: string | null;
  taskPoint: number | null;
  salesPaise: number | null;
  salesPoint: number | null;
  litres: number | null;
  litrePoint: number | null;
  outstandingCount: number | null;
  outstandingPoint: number | null;
  timeGiven: number | null;
  timePoint: number | null;
  noteLength: number | null;
  descriptionPoint: number | null;
  /** The average the position type takes, as a fraction (1 = 100%). */
  total: number;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** §12.4 — counts and points for one employee over a period. */
export function performancePoints(x: PointsInput, cfg: PointsCfg): Points {
  const days = Math.max(1, x.periodDays);
  const attendanceCount = x.attendanceRows + x.taggedHolidays;
  const punctualityCount = x.earlyRows + x.taggedHolidays;
  const avgHours = ratio(x.durationMin / 60, x.attendanceRows);
  const attendancePoint = attendanceCount / days;
  const punctualityPoint = punctualityCount / days;
  const workingHourPoint = ratio(avgHours, cfg.standardHours);

  const withTasks = x.kind !== "Other";
  const taskCount = x.checklistTotal + x.todosTotal;
  /* No checklist item and no to-do in the period is not a failure to do them; it scores nothing only because there is nothing to score. */
  const taskPoint = withTasks ? ratio(x.checklistCleared + x.todosDone, taskCount) : null;
  const naText = withTasks ? `Task: ${taskCount} Not Applicable Reason ${x.naReasons.filter(Boolean).join(", ")}` : null;

  const sales = x.kind === "Sales";
  const per = (target: number | null) => ((target ?? 0) / (cfg.periodDivisor || 30)) * days;
  const salesPoint = sales ? ratio(x.salesPaise, per(x.targets.amountPaise)) : null;
  const litrePoint = sales ? ratio(x.litres, per(x.targets.litres)) : null;
  /* Nothing sold since the financial date: nothing owed is the best band, anything owed the worst. */
  const outstandingCount = sales
    ? x.salesSinceFinancialPaise > 0
      ? (x.latestOutstandingPaise / x.salesSinceFinancialPaise) * x.daysSinceFinancial
      : x.latestOutstandingPaise > 0
        ? Infinity
        : 0
    : null;
  const outstandingPoint = outstandingCount == null ? null : outstandingShare(outstandingCount, cfg.bands.outstanding);
  const timeGiven = sales ? ratio(x.activityMinutes, x.activityDates) : null;
  const timePoint = timeGiven == null ? null : timeGiven > cfg.bands.time[0] ? 1 : timeGiven > cfg.bands.time[1] ? 0.5 : 0;
  const noteLen = sales ? ratio(x.noteChars, x.kpiVisits) : null;
  const descriptionPoint = noteLen == null ? null : noteLen > cfg.bands.description[0] ? 1 : noteLen > cfg.bands.description[1] ? 0.5 : 0;

  let parts: number[];
  if (x.kind === "Sales") parts = [attendancePoint, punctualityPoint, workingHourPoint, taskPoint!, salesPoint!, litrePoint!, outstandingPoint!, timePoint!, descriptionPoint!];
  else if (x.kind === "OfficeStaff") parts = [taskPoint!, attendancePoint, punctualityPoint, workingHourPoint];
  else parts = [attendancePoint, punctualityPoint, workingHourPoint];

  return {
    attendanceCount,
    attendancePoint: r3(attendancePoint),
    punctualityCount,
    punctualityPoint: r3(punctualityPoint),
    avgHours: r3(avgHours),
    workingHourPoint: r3(workingHourPoint),
    taskCount: withTasks ? taskCount : null,
    naText,
    taskPoint: taskPoint == null ? null : r3(taskPoint),
    salesPaise: sales ? x.salesPaise : null,
    salesPoint: salesPoint == null ? null : r3(salesPoint),
    litres: sales ? x.litres : null,
    litrePoint: litrePoint == null ? null : r3(litrePoint),
    /* Owed with nothing sold has no number of days to show. */
    outstandingCount: outstandingCount != null && Number.isFinite(outstandingCount) ? r2(outstandingCount) : null,
    outstandingPoint,
    timeGiven: timeGiven == null ? null : r2(timeGiven),
    timePoint,
    noteLength: noteLen == null ? null : r2(noteLen),
    descriptionPoint,
    total: r3(avg(parts)),
  };
}
