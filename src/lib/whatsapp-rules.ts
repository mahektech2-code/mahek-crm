/* ---------------------------------------------------------------------------
 * The founder's automation rules — pure, client-safe: validation, the
 * sentence a rule is read back as, and the sending window. The screen and the
 * runner both use these, so what the founder reads is what the runner does.
 * ------------------------------------------------------------------------- */

export type RuleStatus = "off" | "preview" | "live";

export type Rule = {
  kind: "payment" | "order";
  status: RuleStatus;
  fromDay: number;
  toDay: number | null;
  repeatEveryDays: number;
  maxSends: number | null;
  minAmountPaise: number | null;
  priority: number;
};

export type WindowSettings = {
  windowStartHour: number;
  windowEndHour: number;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  dailyCap: number;
};

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The minute past each hour the scheduled check runs (prod crontab: :22 UTC). */
export const CHECK_MINUTE_IST = 52;

/* ---------------------------------------------------------------- checks */

export function validateRule(r: Rule): string[] {
  const e: string[] = [];
  const int = (n: number | null) => n === null || Number.isInteger(n);
  if (!int(r.fromDay) || !int(r.toDay) || !int(r.repeatEveryDays) || !int(r.maxSends) || !int(r.priority)) {
    e.push("Days, counts and priority must be whole numbers.");
  }
  if (r.kind === "payment" && r.fromDay < 1) e.push("A payment rule starts at 1 day overdue or later.");
  if (r.fromDay < -60 || r.fromDay > 3650) e.push("The start day is out of range.");
  if (r.toDay !== null && r.toDay < r.fromDay) e.push("The end day must be on or after the start day.");
  if (r.repeatEveryDays < 1 || r.repeatEveryDays > 365) e.push("Repeat every 1 to 365 days.");
  if (r.maxSends !== null && (r.maxSends < 1 || r.maxSends > 100)) e.push("At most 1 to 100 times.");
  if (r.minAmountPaise !== null && r.minAmountPaise < 0) e.push("The minimum amount cannot be negative.");
  if (r.kind === "order" && r.minAmountPaise !== null) e.push("A minimum amount only applies to payment rules.");
  if (r.priority < 1 || r.priority > 999) e.push("Priority is 1 to 999.");
  return e;
}

export function validateWindow(w: WindowSettings): string[] {
  const e: string[] = [];
  if (!Number.isInteger(w.windowStartHour) || !Number.isInteger(w.windowEndHour)) e.push("Hours must be whole.");
  if (w.windowStartHour < 0 || w.windowEndHour > 24 || w.windowStartHour >= w.windowEndHour) {
    e.push("The window must start before it ends, within the day.");
  }
  if (!w.weekdays.length || w.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    e.push("Pick at least one day of the week.");
  }
  if (!Number.isInteger(w.dailyCap) || w.dailyCap < 1 || w.dailyCap > 5000) e.push("The daily limit is 1 to 5,000.");
  return e;
}

/* -------------------------------------------------------------- the words */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function money(paise: number): string {
  const r = Math.round(paise / 100);
  const s = String(r);
  return "₹" + (s.length <= 3 ? s : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3));
}

/** A rule read back as one sentence — the founder checks this, not the fields. */
export function describeRule(r: Rule): string {
  const clock = (d: number) =>
    r.kind === "payment"
      ? `${plural(d, "day")} overdue`
      : d === 0
        ? "on the expected order date"
        : d < 0
          ? `${plural(-d, "day")} before the expected order date`
          : `${plural(d, "day")} after the expected order date`;

  const when =
    r.toDay === null
      ? `from ${clock(r.fromDay)} onwards`
      : r.toDay === r.fromDay
        ? clock(r.fromDay)
        : `between ${clock(r.fromDay)} and ${clock(r.toDay)}`;

  const once = r.maxSends === 1;
  const repeat = once ? "once" : `every ${plural(r.repeatEveryDays, "day")}`;
  const cap = !once && r.maxSends ? `, at most ${plural(r.maxSends, "time")}` : "";
  const min = r.minAmountPaise ? `, only if at least ${money(r.minAmountPaise)} is overdue` : "";
  return `Sent ${when}, ${repeat}${cap}${min}.`;
}

/* ------------------------------------------------------------- the window */

/** The hour, minute and ISO weekday in India right now. */
export function istNow(at: Date): { hour: number; minute: number; weekday: number; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_NAMES.indexOf(parts.weekday) + 1,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Whether a message may go out at this instant. Checked before EVERY send. */
export function insideWindow(w: WindowSettings, at: Date): boolean {
  const n = istNow(at);
  return w.weekdays.includes(n.weekday) && n.hour >= w.windowStartHour && n.hour < w.windowEndHour;
}

/** The times the scheduled check actually runs inside the window, e.g. ["10:52", "11:52", "12:52"]. */
export function checkTimes(w: WindowSettings): string[] {
  const out: string[] = [];
  for (let h = w.windowStartHour; h < w.windowEndHour; h++) {
    out.push(`${String(h).padStart(2, "0")}:${CHECK_MINUTE_IST}`);
  }
  return out;
}

export function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "12:00 am";
  if (h === 12) return "12:00 pm";
  return h < 12 ? `${h}:00 am` : `${h - 12}:00 pm`;
}

export function describeWindow(w: WindowSettings): string {
  const days = [...w.weekdays].sort((a, b) => a - b);
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText =
    days.length === 7
      ? "every day"
      : contiguous && days.length > 2
        ? `${WEEKDAY_NAMES[days[0] - 1]}–${WEEKDAY_NAMES[days.at(-1)! - 1]}`
        : days.map((d) => WEEKDAY_NAMES[d - 1]).join(", ");
  return `${dayText}, between ${hourLabel(w.windowStartHour)} and ${hourLabel(w.windowEndHour)} IST`;
}
