import React from 'react';
import { AppState } from 'react-native';
import { openDb } from '../db';
import { recoverInterrupted } from '../sync/queue';
import { startBackgroundSync, stopBackgroundSync } from '../sync/engine';
import { registerBackgroundSync, unregisterBackgroundSync } from '../sync/background-sync-task';
import * as trail from '../sync/trail';
import { currentSession, type Session } from '../data/session';
import { autoCloseMissedCheckouts, dayState } from '../data/attendance';
import { closeOpenVisits } from '../data/visits';
import { escalateOverdue } from '../data/tasks';
import { getConfig } from '../data/config';
import { registerForPush } from '../native/push';
import { fetchUpdateInBackground } from '../native/updates';

/**
 * Starting up.
 *
 * The order matters. The database opens and migrates first, then anything left
 * `syncing` when the app was last killed is put back in the queue, and only
 * then does the background loop start. Skipping the recovery step is how an
 * item gets stranded in flight forever after one force-quit.
 */

type Boot = {
  ready: boolean;
  session: Session | null;
  setSession: (s: Session | null) => void;
};

const BootContext = React.createContext<Boot>({ ready: false, session: null, setSession: () => {} });

export function useBoot() {
  return React.useContext(BootContext);
}

export function BootProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = React.useState(false);
  const [session, setSession] = React.useState<Session | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      await openDb();
      await recoverInterrupted();

      const existing = await currentSession();
      if (cancelled) return;
      setSession(existing);
      setReady(true);

      if (existing) {
        startBackgroundSync();
        void registerBackgroundSync();
        void runDayBoundaryWork(existing.user.id).then(() => resumeTrailIfDayOpen(existing.user.id));
        void registerForPush();
        /* Behind the app, never in front of it: `setReady(true)` has already
           run, so the salesman is looking at his day while this downloads. It
           applies on the NEXT launch — see `fetchUpdateInBackground`. */
        void fetchUpdateInBackground();
      }
    })();

    return () => {
      cancelled = true;
      stopBackgroundSync();
    };
  }, []);

  /*
   * The other half of noticing a permission granted mid-session: this is a
   * COLD start, when the process was never killed and `trail.start()`'s own
   * retry-on-every-call never got a second call to make. The OS routinely
   * kills a backgrounded app to reclaim memory, and a salesman who grants
   * "Allow all the time" from Settings and switches back is, from the app's
   * side, exactly that — a fresh process, with no memory of this morning's
   * check-in, arriving at a foreground resume rather than a launch icon.
   * `trail.start()` is cheap to call and answers "is there more to do" for
   * itself, so this fires on every resume rather than trying to guess which
   * ones matter.
   */
  React.useEffect(() => {
    if (!session) return;
    const userId = session.user.id;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void resumeTrailIfDayOpen(userId);
    });
    return () => sub.remove();
  }, [session]);

  const value = React.useMemo<Boot>(
    () => ({
      ready,
      session,
      setSession: (s) => {
        setSession(s);
        if (s) {
          startBackgroundSync();
          void registerBackgroundSync();
          void registerForPush();
        } else {
          stopBackgroundSync();
          void unregisterBackgroundSync();
        }
      },
    }),
    [ready, session],
  );

  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
}

/**
 * Start the trail if today's attendance is still open, and leave it alone
 * otherwise. `trail.start()` already refuses to run outside a check-in
 * implicitly — nothing calls it from here unless `dayState` says the day is
 * running — because a resume or a cold start happening after check-out must
 * not be the thing that reopens tracking.
 */
async function resumeTrailIfDayOpen(userId: string): Promise<void> {
  try {
    const state = await dayState(userId);
    if (state.running) void trail.start();
  } catch {
    /* Nothing to resume if the day's own state cannot be read; the next
       resume tries again. */
  }
}

/**
 * The tidying the brief schedules nightly, run when the app opens instead.
 *
 * There is no reliable background execution on a handset that spends the night
 * switched off in somebody's bag, so these run on the next launch. Every one of
 * them is idempotent, which is what makes running them at an unpredictable
 * moment safe: closing an already-closed visit changes nothing.
 */
async function runDayBoundaryWork(userId: string): Promise<void> {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    await closeOpenVisits(startOfToday.getTime());
    await autoCloseMissedCheckouts(userId);
    await escalateOverdue(await getConfig<number>('mbos.tasks.escalateAfterHours', 24));
  } catch {
    /* Housekeeping must never stop the app opening. Whatever failed here will
       be retried on the next launch, and none of it is the salesman's problem. */
  }
}
