/**
 * How many punch-out reminders somebody still punched in should have had by
 * now, today.
 *
 * The first at `mbos.attendance.punchOutPromptHour` — the moment the handset's
 * Home and its bar change, so the notification and the screen say the same
 * thing at the same time — and a second `punchOutSecondReminderMinutes` later.
 * Two and no more: a reminder repeated until midnight gets its notifications
 * switched off, and then it reminds nobody of anything. Zero minutes turns the
 * second off.
 *
 * Pure, like every engine: the caller passes the clock. Read in Asia/Kolkata
 * by name, because the droplet runs in UTC.
 *
 * The pass that reads this runs every half hour and may miss one, so it sends
 * the reminder for the LATEST step due rather than catching up on each: a
 * missed six o'clock pass followed by one at half past seven sends one message
 * that says the later thing, never two in the same minute.
 */

const PARTS = new Intl.DateTimeFormat("en-GB", {
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
  timeZone: "Asia/Kolkata",
});

/** Minutes since midnight, Asia/Kolkata. */
export function minuteOfDay(nowMs: number): number {
  const parts = PARTS.formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function remindersDue(args: {
  nowMs: number;
  promptHour: number;
  secondAfterMinutes: number;
}): 0 | 1 | 2 {
  const first = Math.min(23, Math.max(0, Math.floor(args.promptHour))) * 60;
  const gap = Math.floor(args.secondAfterMinutes);
  const now = minuteOfDay(args.nowMs);
  if (now < first) return 0;
  /* Never past the end of the day: a "second" reminder computed for 00:30
     would be about yesterday, landing on a day nobody has started. */
  if (gap > 0 && first + gap < 24 * 60 && now >= first + gap) return 2;
  return 1;
}
