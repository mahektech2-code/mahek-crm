import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { all, run } from '../db';
import { getConfig } from '../data/config';
import { getFix, fixOf, rememberFix } from '../native/location';
import { postPositions } from './api';

/**
 * The trail.
 *
 * Where the salesman actually went, taken every few seconds while the day is
 * open — dense enough that the line connecting the fixes hugs the actual road
 * on its own, with no map-matching service needed to snap it there. Two fixes
 * a day — the check-in and each visit — is not a track, and a map drawn from
 * them looks like tracking without being it.
 *
 * **It runs between the check-in and the check-out and not one second either
 * side.** A track that carried on after the day was closed would be following
 * somebody home, which is not what anybody agreed to. `stop()` is called by the
 * check-out for exactly that reason, and the task is never started without an
 * open session.
 *
 * **It is not in the outbox, deliberately.** The outbox is dependency-ordered
 * and retries for ever, because a visit that never arrives is a call nobody has
 * a record of. A position is the opposite kind of thing: one of a hundred,
 * worth nothing alone, and one lost is a slightly coarser line. So positions
 * queue in their own table, go up in batches, and are deleted once the server
 * has them — sent-but-unacknowledged is the only state worth keeping.
 *
 * **A failure is silent.** The salesman is not doing this; there is nothing for
 * him to fix and nothing to tell him about. The rows stay and the next batch
 * takes them.
 *
 * **It used to be a `setInterval`, and that was the whole bug.** A JS timer
 * only ticks while the app is the thing on screen — the OS suspends it the
 * moment the phone is locked or the salesman switches to a call, which for a
 * field job is almost immediately after check-in. The result was six months
 * of trails that were really just a check-in point and a check-out point, a
 * few minutes apart, with nothing in between however long the day actually
 * ran. `expo-task-manager`'s background task is the OS itself waking the app
 * to deliver a fix, which is the only thing that survives a locked screen.
 * Where the salesman has refused the extra "always" permission that needs,
 * the old timer is still here as the floor — worse than a real trail, better
 * than none, and exactly what was shipped before.
 */

const TASK_NAME = 'mbos-trail';

type Row = { id: string; at: number; lat: number; lng: number; accuracyM: number | null };

async function store(lat: number, lng: number, accuracyM: number | null, at: number): Promise<void> {
  await run(
    'INSERT OR IGNORE INTO positions (id, at, lat, lng, accuracyM) VALUES (?, ?, ?, ?, ?)',
    [`mbos_pos_${Crypto.randomUUID()}`, at, lat, lng, accuracyM],
  );
}

/*
 * Defined at MODULE SCOPE, which TaskManager requires and `app/_layout.tsx`
 * exists to guarantee: the OS can relaunch the app headless, with no screen
 * ever mounted, purely to deliver a location and run this — so the task has
 * to exist the moment the bundle loads, not the moment somebody checks in.
 *
 * A coarse fix is kept rather than discarded, same as the old foreground
 * take() did: a five-hundred-metre reading is poor evidence of a doorway and
 * perfectly good evidence of which part of the city somebody was in, which is
 * all a trail claims to be.
 */
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK_NAME, async ({ data, error }) => {
  if (error || !data) return;
  for (const loc of data.locations) {
    const accuracyM = loc.coords.accuracy != null ? Math.round(loc.coords.accuracy) : null;
    await store(loc.coords.latitude, loc.coords.longitude, accuracyM, loc.timestamp);
    rememberFix({ lat: loc.coords.latitude, lng: loc.coords.longitude, accuracyM: accuracyM ?? 9999, at: loc.timestamp });
  }
  /*
   * Pushed here rather than left for the sync engine's own timer, which is a
   * `setInterval` too and shares the exact limitation this file exists to
   * fix — it only ticks with the app open. This task is already the OS
   * waking the handset to hand over a fix, so it is also the one reliable
   * moment to empty the queue: a manager watching "Where they are now"
   * mid-afternoon sees a point from minutes ago rather than nothing until
   * the salesman next opens the app or checks out.
   */
  await flush();
});

/* The floor, for a handset with no "always" permission. Every few seconds
   while the app happens to be open — the whole of what shipped before. */
let foregroundTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function takeForeground(): Promise<void> {
  try {
    const result = await getFix({ accuracyThresholdM: 50, timeoutMs: 15_000 });
    const fix = fixOf(result);
    if (!fix) return;
    await store(fix.lat, fix.lng, fix.accuracyM, fix.at);
  } catch {
    /* No fix, no permission, no radio. Nothing to say and nothing to do. */
  }
}

/**
 * The real thing: an OS-level background task, which keeps ticking with the
 * screen off. Asks for nothing the salesman has not already been asked —
 * foreground permission is settled by the check-in's own fix before this
 * ever runs — and never blocks the day opening on the answer. Returns
 * whether it actually started, so `start()` knows whether it needs the
 * foreground floor instead.
 */
async function startBackground(everyMs: number): Promise<boolean> {
  try {
    if (!(await Location.isBackgroundLocationAvailableAsync())) return false;

    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted') return false;

    const bg = await Location.getBackgroundPermissionsAsync();
    const granted =
      bg.status === 'granted' ? true : (await Location.requestBackgroundPermissionsAsync()).status === 'granted';
    if (!granted) return false;

    await Location.startLocationUpdatesAsync(TASK_NAME, {
      accuracy: Location.Accuracy.High,
      timeInterval: everyMs,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: 'MahekOne is following your route',
        notificationBody: 'Recording where the day takes you. Stops the moment you check out.',
        killServiceOnDestroy: false,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Is the trail running right now, one way or the other? */
export function isTracking(): boolean {
  return running;
}

/**
 * Start following, if the office has asked for it.
 *
 * Idempotent: called on check-in, on app resume and after a sign-in, and only
 * one of the two mechanisms below ever runs at a time. A handset whose
 * permission was refused takes no fixes and says nothing — the visit path has
 * already asked once and been told no, and asking again on every fix is
 * how somebody turns the app off.
 */
export async function start(): Promise<void> {
  if (running) return;

  const on = await getConfig<boolean>('mbos.location.trackWhileWorking', true);
  if (!on) return;

  const seconds = await getConfig<number>('mbos.location.trackEverySeconds', 15);
  const every = Math.max(5, seconds) * 1_000;

  const backgroundStarted = await startBackground(every);
  if (!backgroundStarted) {
    /* One straight away, so a check-in puts a point on the map rather than a
       gap at the start of every day. */
    void takeForeground();
    foregroundTimer = setInterval(() => void takeForeground(), every);
  }
  running = true;
}

/**
 * Stop whichever mechanism is running, without sending anything — the piece
 * `stop()` and the "office turned it off" branch of `flush()` both need,
 * pulled out so the second of those is not `flush()` calling itself.
 */
async function stopTicking(): Promise<void> {
  running = false;
  if (foregroundTimer) {
    clearInterval(foregroundTimer);
    foregroundTimer = null;
  }
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TASK_NAME)) {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
    }
  } catch {
    /* Nothing was running, or the OS had already torn it down. */
  }
}

/** Stop, and send what is left. Called by the check-out. */
export async function stop(): Promise<void> {
  await stopTicking();
  await flush();
}

/** How many positions are waiting to go up. */
export async function pending(): Promise<number> {
  const rows = await all<{ n: number }>('SELECT COUNT(*) AS n FROM positions');
  return rows[0]?.n ?? 0;
}

/** One batch, oldest first. See the server route for why it is capped. */
const BATCH = 500;

/**
 * Send what is queued.
 *
 * Called after every sync pass as well as on check-out, so a handset that
 * found signal between two shops uses it. Rows are deleted only on a clean
 * answer; anything else leaves them for the next attempt.
 */
export async function flush(): Promise<number> {
  const rows = await all<Row>(
    'SELECT id, at, lat, lng, accuracyM FROM positions ORDER BY at ASC LIMIT ?',
    [BATCH],
  );
  if (!rows.length) return 0;

  try {
    const answer = await postPositions(rows);
    if (!answer?.ok) return 0;

    const marks = rows.map(() => '?').join(',');
    await run(`DELETE FROM positions WHERE id IN (${marks})`, rows.map((r) => r.id));

    /* The office turned it off. Stop taking fixes and drop what is held —
       keeping them would be storing something nobody asked for. */
    if (answer.tracking === 'off') {
      await stopTicking();
      await run('DELETE FROM positions');
    }

    return rows.length;
  } catch {
    return 0;
  }
}
