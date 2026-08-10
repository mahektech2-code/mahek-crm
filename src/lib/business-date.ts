/* ---------------------------------------------------------------------------
 * Business dates.
 *
 * Every "is this due today" decision in the product goes through here, in the
 * configured timezone and against the configured day boundary. Nothing else
 * computes these independently — that is how two screens end up disagreeing
 * about what day it is.
 *
 * Pure: the clock is always passed in.
 * ------------------------------------------------------------------------- */

/** An ISO calendar date, YYYY-MM-DD. The product's unit of "a day". */
/**
 * The two kinds of day, and they are NOT interchangeable.
 *
 * Both are `YYYY-MM-DD` and both are strings, which is how they came to be
 * subtracted from each other: `calendarDate()` used to return something the
 * compiler called a `BusinessDate`, so every function expecting one took it
 * without complaint. They agree for twenty-three hours a day and differ for
 * the five before the day boundary, so the mistake was invisible except
 * overnight — which is when nobody is looking.
 *
 * The brands are OPTIONAL properties on purpose. That is what lets a literal
 * like `"2026-08-10"` still be either kind: it carries no brand, so it is
 * assignable to both, and a thousand date literals across the tests keep
 * working. What cannot happen is passing a value that has been branded one
 * way into something expecting the other, because `"calendar"` is not
 * assignable to `"business"`. Making the brands required instead produced
 * 1096 errors and would have meant a constructor call around every literal
 * in the codebase, for no extra safety over this.
 *
 * Both are still strings at runtime. Rendering, storing and putting them in
 * props all work unchanged.
 */
export type BusinessDate = string & { readonly __day?: "business" };
export type CalendarDate = string & { readonly __day?: "calendar" };

export type WorkingDayConfig = {
  timezone: string;
  dayBoundaryHour: number;
  /** ISO weekday numbers: Monday 1 … Sunday 7. */
  workingDays: number[];
};

/**
 * The business date for an instant.
 *
 * The day boundary matters: with a 5 am boundary, a report finalised at 1 am
 * still belongs to the previous working day, which is what a telecaller who
 * stayed late would expect.
 */
export function businessDate(now: Date, config: WorkingDayConfig): BusinessDate {
  const parts = zonedParts(now, config.timezone);
  let { year, month, day } = parts;
  if (parts.hour < config.dayBoundaryHour) {
    ({ year, month, day } = shiftDays({ year, month, day }, -1));
  }
  return iso(year, month, day);
}

/** The window of instants belonging to a business date, as [start, end). */
export function dayBoundaryWindow(
  date: BusinessDate,
  config: WorkingDayConfig,
): { start: string; end: string } {
  const h = String(config.dayBoundaryHour).padStart(2, "0");
  const offset = zoneOffset(config.timezone);
  return {
    start: `${date}T${h}:00:00${offset}`,
    end: `${addDays(date, 1)}T${h}:00:00${offset}`,
  };
}

export function isWorkingDay(
  date: BusinessDate,
  config: WorkingDayConfig,
): boolean {
  return config.workingDays.includes(isoWeekday(date));
}

/**
 * The last working day strictly before `date`. Monday compares against
 * Saturday, not Sunday — comparing a working day to a day nobody worked would
 * make every Monday look like a collapse.
 */
export function previousWorkingDay(
  date: BusinessDate,
  config: WorkingDayConfig,
): BusinessDate {
  let cursor = addDays(date, -1);
  // A fortnight is far more than any configured working week can skip.
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(cursor, config)) return cursor;
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

/** The next working day strictly after `date`. */
export function nextWorkingDay(
  date: BusinessDate,
  config: WorkingDayConfig,
): BusinessDate {
  if (!config.workingDays.length) return addDays(date, 1);
  let candidate = addDays(date, 1);
  // At most a week of skipping is ever needed.
  for (let i = 0; i < 7; i++) {
    if (isWorkingDay(candidate, config)) return candidate;
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

/** `date` if it is a working day, otherwise the next one. */
export function onOrAfterWorkingDay(
  date: BusinessDate,
  config: WorkingDayConfig,
): BusinessDate {
  return isWorkingDay(date, config) ? date : nextWorkingDay(date, config);
}

/** Working days between two dates, counting `to` but not `from`. */
export function workingDaysBetween(
  from: BusinessDate,
  to: BusinessDate,
  config: WorkingDayConfig,
): number {
  if (to <= from) return 0;
  let count = 0;
  let cursor = addDays(from, 1);
  while (cursor <= to) {
    if (isWorkingDay(cursor, config)) count++;
    cursor = addDays(cursor, 1);
  }
  return count;
}

/* ------------------------------------------------------- plain date maths */

export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [y, m, d] = split(date);
  const next = shiftDays({ year: y, month: m, day: d }, days);
  return iso(next.year, next.month, next.day);
}

/**
 * Whole days from `from` to `to`. Negative when `to` is earlier.
 *
 * BOTH SIDES MUST BE THE SAME KIND OF DATE. Subtracting a calendar date from
 * a business one is how the Information tab came to report a call in the
 * future: a 1am call is calendar-today and business-yesterday, so the
 * difference came out at minus one and was clamped to zero, leaving a date on
 * screen that the rest of the CRM disagreed with. Passing a `CalendarDate`
 * here is now a compile error rather than a test that fails only between
 * midnight and 5am.
 */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * Whole days between two CALENDAR dates.
 *
 * A separate function rather than a looser `daysBetween`, because the two
 * uses are different questions. Comparing a stored date against today is
 * where the day boundary matters and where mixing the kinds goes wrong.
 * Measuring the SPAN between two dates of the same kind — the gaps between a
 * customer's orders, which is what their buying cycle is the median of — does
 * not involve today at all, and calendar dates are the right input: an order
 * placed at 2am belongs to that date, and reading it as the previous day
 * would shorten one gap and lengthen its neighbour.
 *
 * Loosening `daysBetween` to accept either kind would have accepted one of
 * each too, which is the bug this whole distinction exists to stop.
 */
export function calendarDaysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export function isoWeekday(date: BusinessDate): number {
  const [y, m, d] = split(date);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return wd === 0 ? 7 : wd;
}

/** "2026-08" — the period key used by monthly targets. */
export function monthKey(date: BusinessDate): string {
  return date.slice(0, 7);
}

export function startOfMonth(date: BusinessDate): BusinessDate {
  return `${monthKey(date)}-01`;
}

export function daysInMonth(date: BusinessDate): number {
  const [y, m] = split(date);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Shift a month key by `months`, e.g. addMonths("2026-08", -3) -> "2026-05". */
export function addMonths(key: string, months: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/* ----------------------------------------------------------------- internals */

function split(date: BusinessDate): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Not a business date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/* Plain string: this is digit arithmetic, and which KIND of day it is
 * matters to the callers, not to Date.UTC. */
function utc(date: string): number {
  const [y, m, d] = split(date);
  return Date.UTC(y, m - 1, d);
}

function iso(year: number, month: number, day: number): BusinessDate {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shiftDays(
  p: { year: number; month: number; day: number },
  days: number,
) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function zonedParts(now: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as "24" in some locales.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/**
 * The zone the business runs in, in one place.
 *
 * `workingDay.timezone` is the configurable setting and remains the authority
 * for anything that reads configuration. This constant is for the two places
 * that CANNOT: client components, which have no async config, and SQL, which
 * needs the zone as a literal. Its default and this value are the same string
 * by construction, so they cannot drift.
 *
 * It matters more than it looks. Postgres casts a timestamptz to a date in the
 * SESSION timezone, and the client's database runs in GMT — so a bare
 * `ordered_at::date` puts a 1am IST call on the previous day. Local Postgres
 * runs in Asia/Kolkata, which hides it perfectly.
 */
export const APP_TIMEZONE = "Asia/Kolkata";

/**
 * The calendar day a stored instant fell on, in the business's own zone.
 *
 * The day BOUNDARY is deliberately not applied: an order placed at 2am was
 * placed on that date, whatever shift the telecaller was working. Reach for
 * `businessDate()` when the question is which shift something belongs to.
 */
export function calendarDate(at: Date, timezone: string = APP_TIMEZONE): CalendarDate {
  const { year, month, day } = zonedParts(at, timezone);
  return iso(year, month, day) as CalendarDate;
}

/**
 * A timestamptz rendered as a business date, in SQL. Every place that turns a
 * stored timestamp into a day must use this rather than a bare `::date`.
 */
export function businessDateSql(expr: string): string {
  return `((${expr}) at time zone '${APP_TIMEZONE}')::date`;
}

/** Fixed offsets for the zones this product runs in. */
const ZONE_OFFSETS: Record<string, string> = {
  "Asia/Kolkata": "+05:30",
  UTC: "+00:00",
};

function zoneOffset(timezone: string): string {
  const offset = ZONE_OFFSETS[timezone];
  if (!offset) {
    throw new Error(
      `No fixed offset known for ${timezone}. Add it to ZONE_OFFSETS, or switch to a zone-aware library if a DST zone is ever needed.`,
    );
  }
  return offset;
}
