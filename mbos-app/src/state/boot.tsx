import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { openDb } from '../db';
import { recoverInterrupted } from '../sync/queue';
import { startBackgroundSync, stopBackgroundSync } from '../sync/engine';
import { currentSession, type Session } from '../data/session';
import { autoCloseMissedCheckouts, openSession, sessionsOf, todayRow } from '../data/attendance';
import * as trail from '../sync/trail';
import { closeOpenVisits } from '../data/visits';
import { escalateOverdue } from '../data/tasks';
import { getConfig } from '../data/config';
import { registerForPush } from '../native/push';

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
        void resumeTrail(existing.user.id);
        void runDayBoundaryWork(existing.user.id);
        void registerForPush();
      }
    })();

    /*
     * Coming back to the foreground restarts the trail if the day is still
     * open.
     *
     * `trail.start()` was called from exactly two places, both a check-in —
     * so once Android tore the location service down, nothing ever put it
     * back. The battery managers on the handsets this team actually carries
     * do that routinely, and the failure is silent on both ends: the salesman
     * sees a normal app, the office sees a Live map that simply stops. One
     * salesman checked in at ten past midnight and produced no fixes at all
     * until he happened to open the app at a quarter to eight that evening.
     *
     * `start()` is idempotent and asks the OS whether it is already following
     * before starting anything, so a resume that changed nothing costs one
     * question and no restart — which matters, because restarting the service
     * is itself what replays a batch of deferred fixes.
     */
    const onState = (state: AppStateStatus) => {
      if (state !== 'active') return;
      void (async () => {
        const s = await currentSession();
        if (s) await resumeTrail(s.user.id);
      })();
    };
    const subscription = AppState.addEventListener('change', onState);

    return () => {
      cancelled = true;
      subscription.remove();
      stopBackgroundSync();
    };
  }, []);

  const value = React.useMemo<Boot>(
    () => ({
      ready,
      session,
      setSession: (s) => {
        setSession(s);
        if (s) {
          startBackgroundSync();
          void registerForPush();
        } else {
          stopBackgroundSync();
        }
      },
    }),
    [ready, session],
  );

  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
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


/**
 * Follow the route again, if there is a day open to follow it for.
 *
 * The check is on the LOCAL attendance row rather than on anything the server
 * holds: this runs at boot and on every resume, including with no signal, and
 * a trail that only restarted where there was a connection would be off for
 * exactly the part of the beat worth recording.
 */
async function resumeTrail(userId: string): Promise<void> {
  try {
    const row = await todayRow(userId);
    if (!row) return;
    if (!openSession(sessionsOf(row))) return;
    await trail.start();
  } catch {
    /* No row, no database yet, nothing open. The next resume asks again. */
  }
}
