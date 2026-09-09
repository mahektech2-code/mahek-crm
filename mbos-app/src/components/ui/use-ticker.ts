import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * A clock that moves, for the screens that show one.
 *
 * Reading `Date.now()` during render is impure and the React Compiler rules in
 * this app forbid it, so anything that has to keep counting needs the clock as
 * STATE and something to move it. This is that something, in one place rather
 * than as a fifth hand-rolled `setInterval` — there were four, at four
 * different intervals, and each one had to remember the same two things.
 *
 * IT STOPS WHEN THERE IS NOTHING TO COUNT. Pass `null` and no timer is
 * created at all: a closed day is a finished number, and re-rendering the
 * screen every second to redraw the same string is battery spent on nothing.
 * This app already counts that cost carefully everywhere else — see
 * `trail.ts`, where a cadence nobody meant to be load-bearing cost a hundred
 * times the fixes and a queue that could never drain.
 *
 * AND IT STOPS WHEN THE APP IS NOT IN FRONT. A one-second interval behind a
 * locked screen is the same waste with nobody even able to see it. Coming
 * back re-reads the clock IMMEDIATELY rather than waiting for the next tick,
 * because the phone may have been in a pocket for an hour and the first thing
 * the salesman does is look at the number.
 */
export function useTicker(intervalMs: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (intervalMs == null) return;

    /* Whatever the app was doing while it was away, the number on screen is
       wrong the moment it comes back. Correct it before starting to tick. */
    setNow(Date.now());

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer != null) return;
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    };

    /* `inactive` is not away. iOS raises it for the app switcher and for a
       notification shade pulled halfway down, and a counter that froze every
       time somebody glanced at their notifications would look broken. */
    const onState = (state: AppStateStatus) => {
      if (state === 'active') {
        setNow(Date.now());
        start();
      } else if (state === 'background') {
        stop();
      }
    };

    if (AppState.currentState !== 'background') start();
    const sub = AppState.addEventListener('change', onState);

    return () => {
      stop();
      sub.remove();
    };
  }, [intervalMs]);

  return now;
}
