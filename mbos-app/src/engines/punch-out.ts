/**
 * When punching out becomes the thing the app asks for.
 *
 * The button was on Home from the day the day could be closed, and salesmen
 * walked past it every evening. It sat under "Today's route" as a grey outline,
 * the quietest control on the screen, and it was there ALL DAY — so by six
 * o'clock it had become furniture, seen a dozen times while it was the wrong
 * thing to press. A forgotten punch-out costs the office a regularisation and
 * costs the record its closing photograph.
 *
 * So the button changes weight with the clock: secondary while the day is
 * young, the primary action from `mbos.attendance.punchOutPromptHour` on. A
 * control that is loud only when it is the right thing to press is one that
 * stays readable; one loud all day is furniture again by Thursday.
 *
 * The hour is read in Asia/Kolkata by name, like every other wall clock this
 * app turns a stored instant into — a phone set to another zone must not move
 * the evening.
 */

const HOUR = new Intl.DateTimeFormat('en-GB', {
  hour: 'numeric',
  hourCycle: 'h23',
  timeZone: 'Asia/Kolkata',
});

/** The hour of the working day, 0–23, in the working-day timezone. */
export function workingHour(nowMs: number): number {
  const h = Number(HOUR.format(new Date(nowMs)));
  /* `h23` should never answer 24, but some ICU builds have; midnight is 0. */
  return Number.isFinite(h) ? h % 24 : 0;
}

/**
 * Should punching out be the loudest thing on the screen right now?
 *
 * Only while a session is open — a closed day has nothing to punch out of, and
 * nagging somebody who already has is how the nag stops being read.
 */
export function punchOutDue(args: { running: boolean; nowMs: number; promptHour: number }): boolean {
  if (!args.running) return false;
  const hour = Math.min(23, Math.max(0, Math.floor(args.promptHour)));
  return workingHour(args.nowMs) >= hour;
}

const DATE = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/** IST is a fixed UTC+05:30 with no daylight saving, so this is exact. */
const IST_OFFSET_MS = 330 * 60_000;

/** The instant of `hour:minute` IST on the IST day containing `nowMs`. */
function istInstant(nowMs: number, hour: number, minute: number): number {
  const [y, m, d] = DATE.format(new Date(nowMs)).split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour, minute) - IST_OFFSET_MS;
}

/**
 * When to buzz somebody who is still punched in, today.
 *
 * The first at the prompt hour — the same moment Home and the bar change, so
 * the notification and the screen say the same thing at the same time — and a
 * second `secondAfterMinutes` later for whoever was on a bike for the first.
 * Two and no more: a reminder that repeats every half hour until midnight is
 * one that gets its channel switched off, and then it reminds nobody of
 * anything. Zero turns the second off.
 *
 * Only instants still ahead of `nowMs`, and never past the end of the IST day:
 * a reminder scheduled for "tomorrow 00:30" is a reminder about yesterday,
 * landing on a day nobody has punched in to yet.
 */
export function punchOutReminderTimes(args: {
  nowMs: number;
  promptHour: number;
  secondAfterMinutes: number;
}): { at: number; nth: 1 | 2 }[] {
  const hour = Math.min(23, Math.max(0, Math.floor(args.promptHour)));
  const first = istInstant(args.nowMs, hour, 0);
  const endOfDay = istInstant(args.nowMs, 23, 59);
  /* `nth` travels with the instant, so the second nudge keeps its own words
     when the first has already gone off and is not rescheduled. */
  const times: { at: number; nth: 1 | 2 }[] = [{ at: first, nth: 1 }];
  const gap = Math.floor(args.secondAfterMinutes);
  if (gap > 0) times.push({ at: first + gap * 60_000, nth: 2 });
  return times.filter((t) => t.at > args.nowMs && t.at <= endOfDay);
}

/** `iso` minus `n` calendar days, on date strings alone — no zone involved. */
function isoMinusDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/**
 * Of the days he punched in over the window before today, how many he never
 * punched out of.
 *
 * TODAY IS LEFT OUT: it is still being worked, and an open session this
 * afternoon is not a missed punch-out — counting it would mark everybody down
 * every day until they went home. The window and the rule are the ones the
 * office's attendance screen uses, over `mbos.attendance.missedPunchOutWindowDays`,
 * so a salesman and his manager read the same figure about the same month —
 * as far as this phone remembers, which the screen says.
 */
export function missedPunchOuts(
  days: { day: string; checkInAt: number | null; checkOutAt: number | null }[],
  today: string,
  windowDays: number,
): { missed: number; punched: number } {
  const from = isoMinusDays(today, Math.max(1, Math.floor(windowDays)));
  let missed = 0;
  let punched = 0;
  for (const d of days) {
    if (d.checkInAt == null || d.day >= today || d.day < from) continue;
    punched += 1;
    if (d.checkOutAt == null) missed += 1;
  }
  return { missed, punched };
}
