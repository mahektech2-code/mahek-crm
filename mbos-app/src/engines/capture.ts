/**
 * WHICH THING IS ACTUALLY RECORDING THE ROUTE, decided once and purely.
 *
 * There are now three mechanisms and they are not interchangeable:
 *
 *  - `service` — MBOS's own Android foreground service. It starts without an
 *    Activity, holds `startForeground` from its first instant, owns its own
 *    fused-provider callback and writes to a buffer no dead bundle can lose.
 *    It is the only one of the three that keeps recording after the OS has
 *    reaped the JavaScript.
 *  - `task` — `expo-location`'s background task, which is what shipped. It
 *    works perfectly while an Activity has been in front at some point in the
 *    process's life and stops dead otherwise:
 *    `LocationTaskConsumer.maybeStartForegroundService` returns early on
 *    `!AppForegroundedSingleton.isForegrounded`, so a task restored into a
 *    headless process runs with NO foreground service and Android 10+ throttles
 *    it to a few fixes an hour.
 *  - `floor` — a `setInterval` taking one fix at a time. It only advances while
 *    the app is the thing on screen, which for a field job is a few minutes a
 *    day. It is worse than a trail and better than nothing, and it is exactly
 *    what this app shipped with before either of the other two.
 *
 * **IT IS AN ENGINE BECAUSE `sync/trail.ts` CANNOT BE TESTED.** That file
 * imports expo-location and expo-task-manager at module scope, so nothing in
 * it can be exercised without a device — which is precisely how the
 * `timeInterval` bug survived three days and how the trail ran at a hundred
 * times its configured cadence with every screen reporting health. A rule
 * small enough to be obvious still has to be somewhere it can be run.
 *
 * PURE: it takes what is known and returns a word. No I/O, no clock beyond
 * what is handed in.
 */

export type Capture = 'service' | 'task' | 'floor' | 'off';

export type CaptureInputs = {
  /** The office's own switch. Off means no handset reporting at all. */
  trackingOn: boolean;
  /**
   * Is our native module in THIS binary? An APK cannot be recalled, so a
   * handset in somebody's pocket runs the build it has until a person
   * installs the next one, and the old path has to go on working underneath.
   */
  serviceAvailable: boolean;
  /**
   * Did the service actually START? `startForegroundService` throws
   * `ForegroundServiceStartNotAllowedException` on API 31+ when the app is in
   * the background and holds none of the exemptions, and it throws
   * SecurityException on API 34 where the manifest type and the granted
   * permissions disagree. A refusal is not a reason to record nothing.
   */
  serviceStarted: boolean;
  /** The ordinary location permission. Nothing records without it. */
  foregroundGranted: boolean;
  /** "Allow all the time". Without it neither background path is offered. */
  backgroundGranted: boolean;
  /** Did `startLocationUpdatesAsync` accept the expo task? */
  taskStarted: boolean;
};

/**
 * THE ORDER IS THE ARGUMENT, and every step down is a real loss.
 *
 * Nothing at all without the office's switch or the ordinary permission — the
 * first is policy and the second is the platform, and neither is ours to work
 * around.
 *
 * The service is preferred wherever it started, including over an expo task
 * that also started, because "it started" is the one claim the expo task makes
 * that the field has proved worthless: every stalled handset in production had
 * `startLocationUpdatesAsync` return cleanly and `background_location_granted`
 * reading true.
 *
 * The task is the fallback rather than the floor, because a throttled trail of
 * a few fixes an hour with the screen off still beats a dense one that only
 * exists while somebody is looking at the phone. That is a genuinely close
 * call and it is settled by what the handset can be asked for: a salesman who
 * has granted "always" has already paid for the background path, and refusing
 * to use it because a better one was refused would be spending his permission
 * on nothing.
 *
 * `floor` is what is left, and it is offered even with no background
 * permission at all, because the alternative is a day with no trail whatsoever
 * — and `engines/geo.ts` states the principle the whole field product rests
 * on: a reading is evidence, never a gate. A worse reading is still evidence.
 */
export function chooseCapture(input: CaptureInputs): Capture {
  if (!input.trackingOn) return 'off';
  if (!input.foregroundGranted) return 'off';
  if (input.serviceAvailable && input.serviceStarted) return 'service';
  if (input.backgroundGranted && input.taskStarted) return 'task';
  return 'floor';
}

/**
 * HOW LONG THE HANDSET MAY GO ON RECORDING WITHOUT BEING TOLD AGAIN.
 *
 * "Not one second either side" is the rule the whole trail rests on, and a
 * check-out is what normally ends a day. What this answers is the day with no
 * check-out: a phone switched off at four and turned on at eleven, where the
 * native side would otherwise find "the office wants tracking" in a
 * preferences file nobody had been able to clear and would follow its owner
 * home. There is no JavaScript coming to clear it — that is what "switched off
 * at four" means — so nothing but a deadline can end it.
 *
 * It is pushed forward by every touch, so a working day extends it and a dead
 * one expires. Hours in, seconds out, because the native side counts in
 * seconds and a unit conversion at the boundary is where
 * `trailKeepEverySeconds` was lost for the life of a module.
 *
 * A NON-POSITIVE NUMBER IS NOT AN INSTRUCTION TO TRACK FOR EVER. Configuration
 * arrives across a wire and a zero here would read to the native side as an
 * already-expired deadline, which would stop the tracker on every start — so
 * it is floored at one hour, which is short enough to be visibly wrong and
 * long enough that a salesman is not silently untracked by a typo.
 */
export function trackingDeadlineSeconds(hours: number): number {
  const safe = Number.isFinite(hours) && hours > 0 ? hours : 1;
  return Math.round(safe * 3600);
}

/**
 * A duration the native side reported, turned into "nothing to say" where that
 * is what it means.
 *
 * The native side answers `-1` for a mark it has never written — the service
 * has never started, the OS has never refused one — and that is a REAL and
 * different answer from a large number. `null` is how it crosses into the
 * report, because `lib/mbos/device-state.ts` refuses a negative duration
 * outright rather than clamping it, and a clamped `-1` would be stamped as
 * `now` and drawn on a screen as fresh.
 */
export function agoOrNull(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}

/**
 * A count the native side could not produce is not zero.
 *
 * The same distinction the wire already keeps for `queuedPositions`: a phone
 * holding nothing and a phone that cannot tell us are different facts, and
 * drawing the second as "clear" is the reassuring answer on the row that has
 * earned it least.
 */
export function countOrNull(n: number): number | null {
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
