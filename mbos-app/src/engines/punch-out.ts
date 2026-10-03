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
