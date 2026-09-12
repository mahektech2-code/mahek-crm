/**
 * Whether the background task the OS accepted is actually delivering.
 *
 * THE OS SAYS YES AND THEN DOES NOTHING, and there is no second call to tell
 * us. A salesman on a vivo V2403 checked in at 04:16 and by half past twelve
 * his handset had posted not one position — not that day, not ever since it was
 * bound. Everything else from that phone worked: the check-in, its selfie, the
 * device's own heartbeat, and the check-in's own GPS fix, which was good.
 * `mbos_devices.background_location_granted` read TRUE, and that column is
 * written from exactly one place — the end of `start()`, with the return of
 * `startLocationUpdatesAsync` — so the task really was registered. Funtouch's
 * battery manager then killed the foreground service behind it. The app is told
 * "started" and is never told otherwise; the same is true of Oppo and Xiaomi,
 * which between them are most of the handsets this product runs on.
 *
 * So the only evidence available is SILENCE, and this is the rule for reading
 * it: a task that was accepted and has kept nothing for several multiples of
 * its own cadence is not tracking, whatever it once answered.
 *
 * PURE, and in `engines/` rather than inside `sync/trail.ts`, for the reason
 * `cadence.ts` next door spells out and this incident proves again: that file
 * imports expo-location and TaskManager at module scope, so nothing in it can
 * be exercised without a device. The `timeInterval` bug lived three days in the
 * field for exactly that reason, and a watchdog nobody can test is a watchdog
 * nobody can be sure of — which would be the worst of both, since a wrong one
 * would take a working handset OFF the real background task.
 */

export type TrailVerdict =
  /**
   * No reason to doubt it: either a fix was kept inside the window, or the
   * task has not yet been running long enough for silence to mean anything.
   * The caller does nothing in both cases, which is why they are one answer.
   */
  | 'believable'
  /** Accepted, and silent for the whole window. Fall back to the floor. */
  | 'stalled'
  /**
   * The start mark sits in a future this phone no longer believes in — its
   * clock was corrected backwards. The caller re-stamps it to now and the
   * window starts again from here.
   */
  | 'restart-the-clock';

/**
 * `now` is the clock, `startedAt` the moment `startLocationUpdatesAsync`
 * answered yes, `lastKeptAt` the mark `keep()` leaves in the kv store, `gapMs`
 * the configured spacing between KEPT fixes, and `silentCadences` how many of
 * those may pass in silence before the task is disbelieved.
 *
 * The window is measured from the LATER of the two marks. `lastKeptAt` outlives
 * the day — it is a persisted mark and yesterday's is still there this morning
 * — so measuring from it alone would declare a task stalled the second it
 * started. Measuring from the start alone would forget every fix that has
 * arrived since.
 *
 * A mark in the FUTURE is discarded as evidence rather than trusted, and the
 * two marks are discarded differently because only one of them is the caller's
 * to correct. A future `lastKeptAt` is simply not read: treating it as recent
 * delivery would wedge the watchdog shut for as long as the correction was
 * large, which on a phone an hour fast is an hour of a dead trail nothing would
 * ever notice — and the cost of the other direction is one unnecessary fall
 * back to the floor, which costs a little battery and loses nothing. That is
 * the same reasoning `shouldKeepFix` gives for resetting rather than stalling,
 * pointed at the failure this rule exists to catch.
 */
export function trailVerdict(args: {
  now: number;
  startedAt: number;
  lastKeptAt: number;
  gapMs: number;
  silentCadences: number;
  minSilenceMs: number;
}): TrailVerdict {
  const { now, startedAt, lastKeptAt, gapMs, silentCadences, minSilenceMs } = args;

  /* Never started, or started by a process that is gone. There is no task to
     disbelieve, and `start()` is what answers that question. */
  if (!Number.isFinite(startedAt) || startedAt <= 0) return 'believable';
  if (startedAt > now) return 'restart-the-clock';

  const kept =
    Number.isFinite(lastKeptAt) && lastKeptAt > 0 && lastKeptAt <= now ? lastKeptAt : 0;

  /*
   * THE WINDOW HAS A FLOOR, AND WITHOUT ONE THIS RULE ATE THE FIX THAT MADE IT
   * NECESSARY.
   *
   * It used to be `gapMs * silentCadences` and nothing else. That was correct
   * for accidental reasons: the keep cadence was five minutes, so four misses
   * came to twenty, and twenty minutes of silence really does mean a battery
   * manager has killed the service. When the cadence was corrected to three
   * seconds — the whole point of which was to make the trail road-by-road —
   * the same multiplication produced a window of TWELVE SECONDS. Any ordinary
   * hiccup clears that: a walk indoors, a bus shelter, one batch the OS chose
   * to defer. A 24-second gap was measured on a handset whose trail was
   * otherwise perfect.
   *
   * The cost was not a spurious note on a screen. `fallBackToFloor()` abandons
   * the real background task for the rest of the process, so the watchdog was
   * switching off background tracking on healthy phones within a minute of
   * check-in, and the office then read "his phone stopped the tracker" — which
   * was true, and it was this function that stopped it. This file's own header
   * warned that "a wrong one would take a working handset OFF the real
   * background task", and that is exactly what it did.
   *
   * So the multiplier is kept and no longer alone. What this window measures is
   * HOW LONG SILENCE MUST LAST before the OS is disbelieved, and that is a fact
   * about battery managers rather than about our sampling rate — the two were
   * only ever the same number by coincidence. The floor is what carries the
   * meaning at a dense cadence; the multiplier still carries it for a team that
   * deliberately samples every few minutes.
   */
  const window = Math.max(
    Math.max(1, gapMs) * Math.max(1, silentCadences),
    Math.max(1, minSilenceMs),
  );
  return now - Math.max(startedAt, kept) >= window ? 'stalled' : 'believable';
}
