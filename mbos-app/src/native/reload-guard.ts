/**
 * WHETHER RELOADING THE APP RIGHT NOW WOULD COST SOMEBODY SOMETHING.
 *
 * `fetchUpdateInBackground` may apply a downloaded update on the spot inside
 * the first seconds of a cold start, on the reasoning that he is still looking
 * at the screen the app has just drawn. That reasoning was a timer and not an
 * observation: a salesman who opens the app and taps Punch in at once has the
 * selfie camera up by second four, and a reload at second nine closed it under
 * him. A push tapped from the lock screen cold-starts straight onto a deep
 * screen, where the same is true of whatever he opened it to do.
 *
 * So anything that is in the middle of something holds the reload off — every
 * sheet, both cameras — and the screen he is on has to be one where nothing
 * can be half done. Held, the update is simply left downloaded, and the next
 * launch runs it, which is what every update outside the window already does.
 */
let holds = 0;
let screen: string | null = null;

/** Hold the reload off until the returned function is called. */
export function holdReload(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
  };
}

/** The screen on top, as `AppFrame` last drew it. */
export function noteScreen(pathname: string | null): void {
  screen = pathname;
}

/** Where a reload loses nothing: the sign-in, and Home before anything is open. */
const SAFE_SCREENS = new Set(['/', '/home']);

export function reloadIsSafe(): boolean {
  if (holds > 0) return false;
  /* Nothing drawn yet is the boot itself — the safest moment there is. */
  return screen == null || SAFE_SCREENS.has(screen);
}
