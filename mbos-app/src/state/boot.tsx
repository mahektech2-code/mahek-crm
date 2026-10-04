import React from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { getKv, openDb, resetHandle, setKv } from '../db';
import { recoverInterrupted } from '../sync/queue';
import { startBackgroundSync, stopBackgroundSync } from '../sync/engine';
import { registerBackgroundSync, unregisterBackgroundSync } from '../sync/background-sync-task';
import * as trail from '../sync/trail';
import { currentSession, sessionOpen, setSessionOpen, type Session } from '../data/session';
import { loadFeedbackPrefs } from '../data/feedback-prefs';
import { primeSounds } from '../components/ui/feedback';
import { autoCloseMissedCheckouts, dayState } from '../data/attendance';
import { syncPunchOutReminders } from '../native/punch-out-reminder';
import { closeOpenVisits } from '../data/visits';
import { closeStaleLegs, closeStaleSessions } from '../data/travel';
import { escalateOverdue } from '../data/tasks';
import { getConfig } from '../data/config';
import { registerForPush } from '../native/push';
import { fetchUpdateQuietly } from '../native/refresh';
import { restoreArrival, restoreOffPlanReason } from './store';
import { color as C } from '../theme/tokens';

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
  /*
   * A STORE THAT WILL NOT OPEN IS SAID, not shown as a white screen.
   *
   * The start-up ran as an async block with no catch: a migration that threw
   * after an update, or a recovery step that failed, left `ready` false for
   * ever. The splash had already been hidden by the fonts and the sign-in
   * screen draws nothing until `ready`, so the salesman saw a blank white
   * phone with nothing on it to tell him to restart, or anybody why.
   */
  const [failure, setFailure] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      await openDb();
      await recoverInterrupted();
      /* The vibration and sound switches, read before the first screen so the
         first tap of the day is felt the way he set it. Never blocks boot. */
      await loadFeedbackPrefs().then(primeSounds).catch(() => {});

      const existing = await currentSession();
      if (cancelled) return;
      setSession(existing);
      setFailure(null);
      setReady(true);

      if (existing) {
        await rememberWhoThisIs(existing);
        onSessionStarted(existing);
      }
    })().catch((e: unknown) => {
      if (cancelled) return;
      setFailure(e instanceof Error && e.message ? e.message : 'The phone storage did not open.');
    });

    return () => {
      cancelled = true;
      stopBackgroundSync();
    };
  }, [attempt]);

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
    /* Android rarely cold-starts an app somebody uses all day — it resumes it.
       So a resume after a long absence asks for an update too; what it finds
       is applied on the next cold start, never under his thumb. */
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundedAt = Date.now();
      if (state === 'active') {
        /* Never for nobody: a resume after sign-out must not reopen tracking. */
        if (!sessionOpen()) return;
        void resumeTrailIfDayOpen(userId);
        if (backgroundedAt != null && Date.now() - backgroundedAt >= 30 * 60_000) {
          void fetchUpdateQuietly();
        }
        backgroundedAt = null;
      }
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
          onSessionStarted(s);
        } else {
          setSessionOpen(false);
          stopBackgroundSync();
          void unregisterBackgroundSync();
        }
      },
    }),
    [ready, session],
  );

  if (failure) {
    return (
      <View style={{ flex: 1, backgroundColor: C.surface, justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 20, fontWeight: '600', color: C.ink }}>Mahek MBOS could not open</Text>
        <Text style={{ fontSize: 15, lineHeight: 22, color: C.body, marginTop: 10 }}>
          The storage on this phone did not open: {failure}
        </Text>
        <Text style={{ fontSize: 15, lineHeight: 22, color: C.body, marginTop: 10 }}>
          Nothing you saved has been deleted. Try again. If this keeps happening, restart the phone and tell your
          manager.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            resetHandle();
            setFailure(null);
            setAttempt((n) => n + 1);
          }}
          style={{ marginTop: 20, minHeight: 52, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: C.surface }}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
}

/**
 * EVERYTHING A SESSION STARTS, in one place for both ways one begins.
 *
 * A cold start with a stored session ran the full list; a fresh sign-in ran
 * three of the eight. So a salesman who reinstalled mid-day was signed in on a
 * running day with no trail until he backgrounded and reopened the app, and
 * the overnight housekeeping never ran for a same-day sign-in at all.
 */
function onSessionStarted(s: Session): void {
  setSessionOpen(true);
  startBackgroundSync();
  void registerBackgroundSync();
  void runDayBoundaryWork(s.user.id).then(() => resumeTrailIfDayOpen(s.user.id));
  /* Half-finished work put back on the screen that took it. An off-plan
     reason is typed on the route screen and spent by a visit two screens
     later, and this app is reaped between the two routinely — restoring it
     here is what stops the sentence being lost in silence. It expires itself
     at the day boundary; see `restoreOffPlanReason`. */
  void restoreOffPlanReason();
  /* The shop he arrived at and did not go into. Same shape, same reason. */
  void restoreArrival();
  void registerForPush();
  /* Behind the app, never in front of it: the salesman is already looking at
     his day while this downloads. See `fetchUpdateQuietly`. */
  void fetchUpdateQuietly();
}

/**
 * A phone signed in before the last-user record existed has no record of who
 * it belongs to, so the first sign-in after the update could not tell a
 * colleague from its owner. The session it already holds answers that.
 */
async function rememberWhoThisIs(s: Session): Promise<void> {
  try {
    if (await getKv('mbos.lastUser')) return;
    await setKv('mbos.lastUser', JSON.stringify({ userId: s.user.id, mobile: s.user.phone ?? '', name: s.user.name }));
  } catch {
    /* The next sign-in writes it anyway. */
  }
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
    /* A journey nobody arrived at, closed for the same reason a visit nobody
       checked out of is. Nothing else ever ends a leg, so one left open
       overnight was read as this morning's — see `openLegOf`. */
    await closeStaleLegs(userId, startOfToday.getTime());
    /* And the session he punched in on and never out of. Nothing closes one
       but a punch-out, so a phone switched off on Friday evening would greet
       its owner on Monday still on Friday's meter reading. */
    await closeStaleSessions(userId, startOfToday.getTime());
    await autoCloseMissedCheckouts(userId);
    /* On every open, because Android may drop a scheduled alarm across a
       reboot or an app update, and because a day closed overnight above must
       not leave last night's reminders standing. */
    await syncPunchOutReminders(userId);
    /* `mbos.tasks.escalationHours`, which is the PUBLISHED key. This read
       `mbos.tasks.escalateAfterHours` — the same question, one word apart, and
       a spelling no office could ever set — so the handset marked a task
       escalated on a compiled 24 while the server's own hourly pass ran on
       whatever the registry said. Two clocks on one rule, and the phone's was
       the one the salesman saw. */
    await escalateOverdue(await getConfig<number>('mbos.tasks.escalationHours', 24));
  } catch {
    /* Housekeeping must never stop the app opening. Whatever failed here will
       be retried on the next launch, and none of it is the salesman's problem. */
  }
}
