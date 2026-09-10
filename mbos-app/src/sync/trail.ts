import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { all, getKv, run, setKv } from '../db';
import { getConfig } from '../data/config';
import { getFix, fixOf, rememberFix } from '../native/location';
import { postPositions } from './api';

/**
 * The trail.
 *
 * Where the salesman actually went, taken every few minutes while the day is
 * open. Two fixes a day — the check-in and each visit — is not a track, and a
 * map drawn from them looks like tracking without being it.
 *
 * **It runs between the check-in and the check-out and not one second either
 * side.** A track that carried on after the day was closed would be following
 * somebody home, which is not what anybody agreed to. `stop()` is called by the
 * check-out for exactly that reason, and the server checks each fix against the
 * sessions it holds rather than taking the handset's word for it.
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
 * **It used to be a `setInterval`, and that was the first bug.** A JS timer
 * only ticks while the app is the thing on screen — the OS suspends it the
 * moment the phone is locked or the salesman switches to a call, which for a
 * field job is almost immediately after check-in. `expo-task-manager`'s
 * background task is the OS itself waking the app to deliver a fix, which is
 * the only thing that survives a locked screen. Where the salesman has refused
 * the extra "always" permission that needs, the old timer is still here as the
 * floor — worse than a real trail, better than none.
 *
 * **`timeInterval` DOES NOT REACH ANDROID, and that was the second.** It is
 * declared `Long?` in expo-location and read out of the task's persisted
 * options with `map["timeInterval"] as? Long` — but task options are stored as
 * JSON, so `org.json` hands back a boxed `Integer` and a strict `as?` yields
 * null. The override is skipped in silence and `Accuracy.Balanced`'s fallback
 * of **3000 ms** stands. `distanceInterval` is declared `Int?` and survives the
 * same round trip, which is why the one we did not mean to be load-bearing was
 * the only one arriving. Production ran at a median gap of exactly 3.0 seconds
 * for three days on a setting that asked for five minutes.
 *
 * So the cadence is enforced HERE, where no cast can lose it — `keep()` is the
 * authority and `deferredUpdatesInterval` (read with a coercing `getLong`, so
 * it does arrive) is the battery half of it. A fix the OS hands us inside the
 * window is still REMEMBERED, because `whereNow()` wants the freshest reading
 * for an order or a payment; it is simply not written to the trail.
 *
 * **A fix's id is the fix, and that was the third.** Every id was a fresh
 * `randomUUID()`, so `INSERT OR IGNORE` had nothing to ignore ON and neither
 * did the server's `onConflictDoNothing` — Android redelivers a batch of
 * deferred locations whenever the task does not complete, and every redelivery
 * became new rows. One fix reached production ninety-three times, in
 * ninety-two separate uploads. The id is derived from the reading now, so a
 * redelivery is free on the handset and free again on the server.
 */

const TASK_NAME = 'mbos-trail';

type Row = { id: string; at: number; lat: number; lng: number; accuracyM: number | null };

/**
 * The id IS the reading.
 *
 * Same instant, same place, same id — so a redelivered fix collides with the
 * one already stored instead of becoming a second row, on the handset and
 * again on the server. Six decimal places is about a tenth of a metre, far
 * finer than any fix this app will ever see, so nothing real is folded
 * together by the rounding.
 */
function fixId(at: number, lat: number, lng: number): string {
  return `mbos_pos_${at}_${Math.round(lat * 1e6)}_${Math.round(lng * 1e6)}`;
}

async function store(lat: number, lng: number, accuracyM: number | null, at: number): Promise<void> {
  await run(
    'INSERT OR IGNORE INTO positions (id, at, lat, lng, accuracyM) VALUES (?, ?, ?, ?, ?)',
    [fixId(at, lat, lng), at, lat, lng, accuracyM],
  );
}

/* ------------------------------------------------------------- the cadence */

const LAST_KEPT = 'trailLastKeptAt';

/** Milliseconds between kept fixes, from configuration. */
async function minGapMs(): Promise<number> {
  const minutes = await getConfig<number>('mbos.location.trackEveryMinutes', 5);
  return Math.max(1, minutes) * 60_000;
}

/**
 * Is this fix far enough from the last one we kept to be worth keeping?
 *
 * The mark is in the kv store rather than read back off `positions`, because
 * the queue is emptied as it uploads — asking the table would say "nothing
 * kept recently" the moment a flush succeeded, and the cadence would collapse
 * to whatever the OS felt like delivering.
 *
 * A clock that has gone BACKWARDS resets rather than stalls. Otherwise a phone
 * whose time was corrected an hour earlier would take no fixes until it caught
 * up with a mark from a future it no longer believes in.
 */
async function keep(at: number, gap: number): Promise<boolean> {
  const raw = await getKv(LAST_KEPT);
  const last = raw ? Number(raw) : 0;
  const since = at - last;
  if (Number.isFinite(last) && since >= 0 && since < gap) return false;
  await setKv(LAST_KEPT, String(at));
  return true;
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

  const gap = await minGapMs();
  for (const loc of data.locations) {
    const accuracyM = loc.coords.accuracy != null ? Math.round(loc.coords.accuracy) : null;
    /* Remembered whether or not it is kept. The trail is a shape and wants one
       point every few minutes; `whereNow()` wants the freshest reading there
       is, and throttling it would age every order and payment by the cadence. */
    rememberFix({ lat: loc.coords.latitude, lng: loc.coords.longitude, accuracyM: accuracyM ?? 9999, at: loc.timestamp });
    if (!(await keep(loc.timestamp, gap))) continue;
    await store(loc.coords.latitude, loc.coords.longitude, accuracyM, loc.timestamp);
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

/* The floor, for a handset with no "always" permission. Every few minutes
   while the app happens to be open — the whole of what shipped before. */
let foregroundTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function takeForeground(): Promise<void> {
  try {
    const result = await getFix({ accuracyThresholdM: 100, timeoutMs: 15_000 });
    const fix = fixOf(result);
    if (!fix) return;
    if (!(await keep(fix.at, await minGapMs()))) return;
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

    /* Already following. Calling `startLocationUpdatesAsync` again RESTARTS
       the service, and a restart replays the deferred batch — which is how a
       handset that was merely resumed produced another copy of every fix it
       already held. Registration outlives the JS runtime; `running` does not,
       so the OS is the only honest thing to ask. */
    if (await Location.hasStartedLocationUpdatesAsync(TASK_NAME)) return true;

    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted') return false;

    const bg = await Location.getBackgroundPermissionsAsync();
    const granted =
      bg.status === 'granted' ? true : (await Location.requestBackgroundPermissionsAsync()).status === 'granted';
    if (!granted) return false;

    await Location.startLocationUpdatesAsync(TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      /* Kept for iOS, which reads it, and for the day expo-location fixes the
         cast that loses it on Android. Nothing depends on it arriving. */
      timeInterval: everyMs,
      distanceInterval: 0,
      /* THIS is the one Android honours: `deferredUpdatesInterval` is read
         with a coercing `getLong`, so the number survives the JSON round trip
         that `timeInterval` does not. It batches fixes while the app is in the
         background instead of waking us every three seconds — the battery half
         of the cadence. It is bypassed in the FOREGROUND by expo's own
         `shouldReportDeferredLocations`, which is why `keep()` and not this is
         the authority on what gets written. */
      deferredUpdatesInterval: everyMs,
      deferredUpdatesDistance: 0,
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
 * Idempotent: called on check-in, on app resume, on boot with a day already
 * open, and after a sign-in. Only one of the two mechanisms below ever runs at
 * a time. A handset whose permission was refused takes no fixes and says
 * nothing — the visit path has already asked once and been told no, and asking
 * again every five minutes is how somebody turns the app off.
 *
 * **`running` is set FIRST**, not after the awaits. It is the re-entrancy
 * guard, and a guard that is only written once several `await`s have settled
 * guards nothing: two callers arriving in the same tick both read `false`, and
 * a resume that raced a check-in put up two foreground timers.
 */
export async function start(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const on = await getConfig<boolean>('mbos.location.trackWhileWorking', true);
    if (!on) {
      running = false;
      return;
    }

    const minutes = await getConfig<number>('mbos.location.trackEveryMinutes', 5);
    const every = Math.max(1, minutes) * 60_000;

    const backgroundStarted = await startBackground(every);
    if (!backgroundStarted) {
      /* One straight away, so a check-in puts a point on the map rather than a
         five-minute gap at the start of every day. */
      void takeForeground();
      foregroundTimer = setInterval(() => void takeForeground(), every);
    }
  } catch {
    running = false;
  }
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
 * How many batches one call may send.
 *
 * `flush()` used to send exactly ONE, which is fine at a fix every fifteen
 * minutes and was catastrophic at a fix every three seconds: the queue is
 * drained oldest-first and filled faster than one batch a minute could empty
 * it, so the newest fix sat permanently behind the backlog. A phone uploaded
 * three thousand rows in a day and moved the trail forward by three minutes of
 * the PREVIOUS evening, while its owner walked a full beat and the Live map
 * showed him where he had been the night before. The cap is here so a wedged
 * queue cannot spin for ever, not because stopping early is ever wanted.
 */
const MAX_PASSES = 50;

/**
 * How long an unsendable position is kept.
 *
 * Only reached when the server says it has no session to file the fix against
 * — the check-in is still in the outbox, or never made it. Days of that is a
 * bug worth surviving; a fortnight of it is a queue nobody will ever drain.
 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let flushing = false;

/**
 * Send what is queued.
 *
 * Called after every sync pass as well as on check-out, so a handset that
 * found signal between two shops uses it. Rows are deleted only on a clean
 * answer; anything else leaves them for the next attempt.
 *
 * Not re-entrant: the background task and the sync timer both call it, and two
 * passes reading the same five hundred rows would post them twice.
 */
export async function flush(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  try {
    let sent = 0;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const rows = await all<Row>(
        'SELECT id, at, lat, lng, accuracyM FROM positions ORDER BY at ASC LIMIT ?',
        [BATCH],
      );
      if (!rows.length) return sent;

      let answer: Awaited<ReturnType<typeof postPositions>> | null = null;
      try {
        answer = await postPositions(rows);
      } catch {
        return sent;
      }
      if (!answer?.ok) return sent;

      /* The office turned it off. Stop taking fixes and drop what is held —
         keeping them would be storing something nobody asked for. */
      if (answer.tracking === 'off') {
        await stopTicking();
        await run('DELETE FROM positions');
        return sent;
      }

      /* The server has no working session these fixes could belong to — almost
         always a check-in still sitting in the outbox. They are KEPT, because
         deleting them would throw away a morning to a sync that was thirty
         seconds behind. Anything old enough that no check-in is ever coming
         goes, so this cannot become a queue that only grows. */
      if (answer.tracking === 'no-session-yet') {
        await run('DELETE FROM positions WHERE at < ?', [Date.now() - RETENTION_MS]);
        return sent;
      }

      const marks = rows.map(() => '?').join(',');
      await run(`DELETE FROM positions WHERE id IN (${marks})`, rows.map((r) => r.id));
      sent += rows.length;

      /* A short read is the last of them. Asking again would cost a round trip
         to be told the same thing. */
      if (rows.length < BATCH) return sent;
    }

    return sent;
  } finally {
    flushing = false;
  }
}
