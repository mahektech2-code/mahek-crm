import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { syncNow } from './engine';
import { getKv, setKv } from '../db';

/**
 * WHETHER THIS EVER RAN, written down.
 *
 * `registerTaskAsync` is wrapped in a `catch` that swallows the failure, and
 * nothing recorded whether the task the OS accepted had ever actually fired.
 * So a handset where registration threw on first launch looked exactly like
 * one syncing perfectly — from this phone and from the office both, which is
 * why "it is switched on and nothing reaches the database" had no answer.
 *
 * Two marks and they say different things. REGISTERED is what the OS told us
 * when we asked; LAST RUN is the only evidence it meant it. An OEM battery
 * manager will happily leave the first true while never delivering the
 * second, which is the whole failure this subsystem keeps meeting.
 */
const REGISTERED = 'backgroundSync.registered';
const LAST_RUN = 'backgroundSync.lastRunAt';

/**
 * The sync loop's OWN background upgrade — the same one `trail.ts` already
 * got, for the same reason.
 *
 * `engine.ts`'s periodic retry is a plain `setInterval`, which is a JS timer:
 * it freezes the instant the app is backgrounded and does not resume until
 * something brings the app back to the foreground. That is fine for the
 * location task, which has its own inline flush after every fix — but it is
 * the ONLY backstop for everything else the sync loop carries (orders,
 * visits, payments, the whole queue), and a salesman who locks his phone
 * after check-in has nothing retrying any of it until he next opens the app.
 * A day's worth of real work sitting queued until evening is not a rounding
 * error.
 *
 * `expo-background-task` is Android's WorkManager (and iOS's BGTaskScheduler)
 * under the handset — an OS-scheduled wake-up rather than a JS timer, so it
 * runs whether or not the app is in front. The floor is real and not tuneable:
 * about fifteen minutes is as tight as either OS will schedule a periodic
 * background task, so this is a backstop for "reaches the office within
 * fifteen minutes" — not a live feed. `trail.ts`'s own inline flush after
 * every fix is what still carries anything more urgent than that.
 *
 * Defined at MODULE SCOPE, exactly like the location task in `trail.ts`, for
 * the same reason: the OS can invoke a registered background task with no
 * screen ever mounted, so the executor has to exist the moment the bundle
 * loads.
 */
const TASK_NAME = 'mbos-background-sync';

TaskManager.defineTask(TASK_NAME, async () => {
  try {
    /* Stamped BEFORE the work, not after. The point of this mark is "the OS
       woke us", which is true the moment we are executing — and a sync that
       fails on a dead tower must not read as a task that never ran, because
       those two send somebody to look in completely different places. */
    await setKv(LAST_RUN, String(Date.now()));
    await syncNow();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    /* The next scheduled run tries again; nothing here is the salesman's to
       fix or even see, same as every other silent failure in this sync
       loop. */
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Register the periodic wake-up. Idempotent — safe to call on every sign-in
 * and app open, the same as `startBackgroundSync()` beside it.
 */
export async function registerBackgroundSync(): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: 15 });
    await setKv(REGISTERED, '1');
  } catch {
    /* No background task support, or the OS refused it — the foreground
       `setInterval` in `engine.ts` still covers a salesman with the app
       open, which is most of a working day.
    
       RECORDED rather than only survived. Carrying on quietly is right; doing
       it silently is what made a handset that can never sync in the
       background indistinguishable from one that does. */
    await setKv(REGISTERED, '0');
  }
}

/** What this handset can say about its own background sync. */
export async function backgroundSyncState(): Promise<{
  registered: boolean | null;
  lastRunAt: number | null;
}> {
  const [reg, run] = await Promise.all([getKv(REGISTERED), getKv(LAST_RUN)]);
  const at = run ? Number(run) : NaN;
  return {
    /* Null is "this build never said", which is every handset in the field
       until the next APK — never to be read as a no. */
    registered: reg === null || reg === undefined ? null : reg === '1',
    lastRunAt: Number.isFinite(at) ? at : null,
  };
}

/** Called on sign-out, so a released handset stops waking up for nobody. */
export async function unregisterBackgroundSync(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(TASK_NAME);
  } catch {
    /* Never registered, or already gone — either way there is nothing to
       unregister. */
  }
}
