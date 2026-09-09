import { addDays, isoWeekday, type BusinessDate } from "@/lib/business-date";

/**
 * What a leave request costs, and what somebody has left to spend.
 *
 * Pure, like every other engine here: the working week, the holiday list and
 * the entitlement all arrive as arguments and nothing does any I/O.
 *
 * **A day nobody works is not a day of leave.** The column comment on
 * `mbos_leave_requests.days` has said "derived from the dates and the working
 * calendar" since the table was written, and nothing consulted a calendar —
 * both ends counted plain calendar days, so a Friday-to-Monday request spent
 * four days of somebody's balance to be absent for two. The salary forecast
 * next door already knows better ("Working days, never dates"); this is the
 * same rule arriving at the table that debits people for it.
 *
 * **A half day costs half a day.** The handset says so on the form before the
 * request is sent, which was the promise; the balance is what has to keep it.
 * `days` stays a whole number of working days SPANNED, because that is what the
 * office screen prints and what the integer column can hold, and the half is
 * carried by `halfDay` — one day away, half a day spent. Storing 0.5 in `days`
 * would need the column to be fractional and would make "how long were they
 * off" and "what did it cost" the same number, which they are not.
 */

export type LeaveCalendar = {
  /** ISO weekday numbers that are worked, Monday 1 … Sunday 7. */
  workingDays: readonly number[];
  /** `YYYY-MM-DD` days nobody works, whatever the weekday says. */
  holidays: ReadonlySet<string>;
};

/** Is this a day somebody would otherwise have been at work? */
export function isWorkedDay(day: BusinessDate, calendar: LeaveCalendar): boolean {
  if (calendar.holidays.has(day)) return false;
  return calendar.workingDays.includes(isoWeekday(day));
}

/**
 * Working days covered by a request, both ends counted.
 *
 * A request made ENTIRELY of days nobody works comes back as zero, and the
 * caller refuses it rather than storing it: asking for the Sunday off is not a
 * request, and recording it as one debits nothing while reading on every screen
 * as a day of leave taken.
 *
 * The loop is bounded because an unbounded one over two dates from a handset is
 * a way to hang the sync endpoint with two characters. A request longer than
 * this is refused by the caller on its length rather than silently truncated.
 */
export const MAX_LEAVE_SPAN_DAYS = 400;

export function leaveWorkingDays(
  from: BusinessDate,
  to: BusinessDate,
  calendar: LeaveCalendar,
): number {
  if (to < from) return 0;
  let count = 0;
  let cursor = from;
  for (let i = 0; i < MAX_LEAVE_SPAN_DAYS && cursor <= to; i++) {
    if (isWorkedDay(cursor, calendar)) count++;
    cursor = addDays(cursor, 1);
  }
  return count;
}

/**
 * What the balance is actually debited.
 *
 * `days` is working days spanned; a half day is one of those spent by halves.
 * A half only means anything on a single day — the middle days of a range are
 * whole days whatever the marker says, which is the reading the handset's own
 * engine takes and the reason `handleLeave` only honours the flag where the two
 * dates are equal.
 */
export function leaveDebitDays(days: number, halfDay: boolean): number {
  if (days <= 0) return 0;
  return halfDay && days === 1 ? 0.5 : days;
}

export type LeaveBalance = {
  kind: string;
  entitled: number;
  used: number;
  available: number;
};

/**
 * Entitlement, what has gone, and what is left — for every kind somebody could
 * ask for rather than only the kinds they have already spent.
 *
 * That distinction is the whole bug this was written for. Nothing in MahekOne
 * ever set an entitlement: the only code that created a balance row was the
 * approval path, at zero days entitled, so a person had a row for a kind of
 * leave only AFTER taking some of it, and it read "-2 of 0 left". The handset
 * builds its list of leave kinds from these rows, so before anybody had taken
 * any leave the list was empty and the only thing the form could offer was Loss
 * of pay — every request a salesman could make was unpaid, and nobody typing
 * one in would have known why.
 *
 * So the entitlement is CONFIGURATION with a per-person override, and this
 * returns a row per configured kind whether or not one has been stored.
 * `loss_of_pay` is deliberately not a kind here: it is what leave becomes when
 * the balance runs out, and a balance of unpaid days is not a thing to have.
 */
export function leaveBalances(
  entitlement: Readonly<Record<string, number>>,
  used: Readonly<Record<string, number>>,
  overrides: Readonly<Record<string, number>> = {},
): LeaveBalance[] {
  return Object.keys(entitlement)
    .sort()
    .map((kind) => {
      const entitled = overrides[kind] ?? entitlement[kind] ?? 0;
      const spent = used[kind] ?? 0;
      return {
        kind,
        entitled,
        used: spent,
        /* Never clamped at zero. Somebody who was granted more than they had
           left is genuinely overdrawn, and the screen showing it is how that
           gets noticed — hiding it behind a floor of zero would make the
           overdraft visible only on the payslip. */
        available: entitled - spent,
      };
    });
}
