import React from 'react';
import { openDb } from '../db';
import { recoverInterrupted } from '../sync/queue';
import { startBackgroundSync, stopBackgroundSync } from '../sync/engine';
import { currentSession, type Session } from '../data/session';
import { autoCloseMissedCheckouts } from '../data/attendance';
import { closeOpenVisits } from '../data/visits';
import { escalateOverdue } from '../data/tasks';
import { getConfig } from '../data/config';

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
        void runDayBoundaryWork(existing.user.id);
      }
    })();

    return () => {
      cancelled = true;
      stopBackgroundSync();
    };
  }, []);

  const value = React.useMemo<Boot>(
    () => ({
      ready,
      session,
      setSession: (s) => {
        setSession(s);
        if (s) startBackgroundSync();
        else stopBackgroundSync();
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
