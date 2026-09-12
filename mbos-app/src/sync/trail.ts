import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { all, getKv, run, setKv } from '../db';
import { getConfig } from '../data/config';
import { getFix, fixOf, rememberFix } from '../native/location';
import { shouldKeepFix } from '../engines/cadence';
import { trailVerdict } from '../engines/trail-watchdog';
import { postPositions, reportLocationPermission } from './api';

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

/*
 * Granting the "always" permission later has to be noticed, not just
 * allowed. Settings and the app are two separate processes, and the OS never
 * reaches into a running one to say a permission changed — the only way this
 * side finds out is by asking again. `start()` used to ask once and remember
 * the answer for the rest of the process's life (a plain `running` boolean),
 * which meant a salesman who checked in before granting "Allow all the time"
 * stayed on the foreground floor for the rest of the day even after granting
 * it: the app was still running, the flag was still set, and nothing ever
 * called `start()` a second time to notice anything had changed. It tracks
 * WHICH mechanism is running instead, so a call to `start()` while still on
 * the floor always retries the real thing, and only a call while the real
 * thing is already running is a true no-op.
 */
const TASK_NAME = 'mbos-trail';

type Row = { id: string; at: number; lat: number; lng: number; accuracyM: number | null };

/**
 * The id IS the reading.
 *
 * It was `randomUUID()`, which meant `INSERT OR IGNORE` had nothing to ignore
 * ON — the id was unique by construction, so the only thing it could collide
 * with was itself, and the same fix stored twice became two rows. The server's
 * `onConflictDoNothing` was defeated for exactly the same reason.
 *
 * That matters because Android REDELIVERS. `data.locations` is a batch of
 * deferred fixes, and the OS hands the batch over again whenever the task did
 * not complete — which is every time the process is reaped mid-flush, and on
 * these handsets that is often. Production reached 33,000 rows for 4,000 real
 * fixes; one fix was stored ninety-three times, across ninety-two separate
 * uploads.
 *
 * Same instant, same place, same id, so a redelivery collides with the row
 * already held and costs nothing. Six decimal places is about a tenth of a
 * metre — far finer than any fix this app will ever see, so nothing genuinely
 * distinct is folded together by the rounding.
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
/* ------------------------------------------------------------- the cadence */

const LAST_KEPT = 'trailLastKeptAt';

/**
 * When the watchdog last caught the background task accepted and silent.
 *
 * Persisted rather than held in memory, unlike `backgroundStartedAt` beside
 * it: that describes a registration THIS process made, and a fresh process
 * must not inherit a verdict about it. This describes the HANDSET, and it is
 * still true after the OS reaps the app — which is exactly when it happens.
 */
const STALLED_AT = 'keepalive.stalledAt';

/**
 * Milliseconds between kept fixes, from configuration.
 *
 * SECONDS, because the thing this is measured against is. It was minutes, and
 * the two units could not meet: the ask beside it runs at three seconds and
 * the finest this could express was sixty, so every spacing in between — which
 * is the whole of the useful range — was unreachable, and the densest trail
 * the office could ask for still cut corners through buildings. Five minutes
 * was the default nobody had ever changed, and it drew a working day as a
 * handful of points joined by straight lines across the map.
 *
 * The floor is `3` rather than `1` to match `trackEverySeconds`'s own floor:
 * a keep interval under the ask interval cannot be honoured by anything, since
 * there is no fix to keep, and a number that silently means something else is
 * worse than one that is refused. `checkConsistency` refuses the pair the
 * other way round — a keep floor shorter than the ask — on the server.
 */
async function minGapMs(): Promise<number> {
  const seconds = await getConfig<number>('mbos.location.trailKeepEverySeconds', 3);
  return Math.max(3, seconds) * 1_000;
}

/**
 * Is this fix far enough from the last one we kept to be worth keeping?
 *
 * THE CADENCE IS ENFORCED HERE BECAUSE NOTHING ELSE CAN BE TRUSTED TO. See the
 * note on `start()` — `timeInterval` never reaches Android, and
 * `deferredUpdatesInterval` does but is bypassed outright while the app is in
 * the foreground. This is the one place a cast cannot lose it.
 *
 * The mark is in the kv store rather than read back off `positions`, because
 * the queue is emptied as it uploads — asking the table would say "nothing
 * kept recently" the moment a flush succeeded, and the cadence would collapse
 * to whatever the OS felt like delivering.
 *
 * A clock that has gone BACKWARDS resets rather than stalls. Otherwise a phone
 * whose time was corrected an hour earlier would take no fixes at all until it
 * caught up with a mark from a future it no longer believes in.
 */
async function keep(at: number, gap: number): Promise<boolean> {
  const raw = await getKv(LAST_KEPT);
  const lastKeptAt = raw ? Number(raw) : 0;
  /* The DECISION is pure and lives in `engines/cadence.ts`, so it can be
     tested without a device — see the note there. This function is only the
     reading and writing of the mark. */
  if (!shouldKeepFix({ at, lastKeptAt, gapMs: gap })) return false;
  await setKv(LAST_KEPT, String(at));
  return true;
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK_NAME, async ({ data, error }) => {
  if (error || !data) return;

  const gap = await minGapMs();
  for (const loc of data.locations) {
    const accuracyM = loc.coords.accuracy != null ? Math.round(loc.coords.accuracy) : null;
    /* REMEMBERED whether or not it is kept. The trail is a shape and wants one
       point every few minutes; `whereNow()` wants the freshest reading there
       is, and throttling that would age the position on every order and
       payment by the whole cadence. */
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

/* The floor, for a handset with no "always" permission. Every few seconds
   while the app happens to be open — the whole of what shipped before. */
let foregroundTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Which mechanism is actually running, or neither. `'background'` is the
 * best available and never needs retrying; `'foreground'` is the floor and
 * every call to `start()` tries to upgrade past it, because the only thing
 * that changed between one call and the next might be a permission grant.
 */
let mode: 'background' | 'foreground' | null = null;

/**
 * When the OS last said yes to the background task, and whether it has since
 * been caught delivering nothing.
 *
 * In memory rather than in the kv store, deliberately: both describe THIS
 * process's belief about a task this process started, and a fresh process —
 * which is what the OS hands back after it reaps a backgrounded app — has to
 * start the whole judgement again rather than inherit a verdict about a
 * registration it no longer knows the fate of.
 */
let backgroundStartedAt = 0;
let backgroundProvedSilent = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * `precise` FOR THE SAME REASON THE BACKGROUND TASK ASKS FOR `High`.
 *
 * This is the floor, and a floor that records nothing usable is not a floor.
 * It already passed `accuracyThresholdM: 50` — the same number the map filters
 * on — and then stored the answer regardless, because `fixOf` deliberately
 * accepts a `coarse` result as well as an `ok` one. That is right for a visit,
 * where a poor reading is still evidence of which part of town somebody was
 * in and the record stands without it. It is wrong here: the trail is the one
 * consumer whose fixes are silently DISCARDED when they are coarse, so asking
 * for Balanced and keeping whatever came back meant the floor's fixes reached
 * the database and never reached the screen.
 *
 * The threshold stays 50 and is deliberately NOT raised to let coarse fixes
 * through. A 100 m reading cannot say which road, and a trail drawn from
 * readings that cannot name a road is a prediction wearing the same colour as
 * a measurement — which is the objection `road-snap-service.ts` already
 * carries about `enhancePath`, arriving from underneath.
 */
async function takeForeground(): Promise<void> {
  try {
    const result = await getFix({ accuracyThresholdM: 50, timeoutMs: 15_000, precise: true });
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
 *
 * **`timeInterval` NEVER REACHES ANDROID, AND NO ERROR SAYS SO.**
 * expo-location declares it `Long?` and reads it out of the task's persisted
 * options with `map["timeInterval"] as? Long` — but task options are stored as
 * JSON, so `org.json` hands back a boxed `Integer` and a strict `as?` yields
 * null. The override is skipped in silence and `Accuracy`'s own fallback of
 * **3000 ms** stands. `distanceInterval` is declared `Int?` and survives the
 * same round trip, which is why the parameter nobody meant to be load-bearing
 * was the only one arriving.
 *
 * Production ran at a median gap of 3.0 seconds for three days on a setting
 * that asked for five minutes: a hundred times the fixes, a hundred times the
 * battery, and an upload queue that could never drain. Nothing looked broken —
 * the uploads succeeded, the connection was fine, and the Live map simply
 * showed where somebody had been the night before.
 *
 * So the cadence is enforced in TWO places and neither is this argument.
 * `deferredUpdatesInterval` below is read with a coercing `getLong` and does
 * arrive, but it is the battery half only — expo bypasses it outright while
 * the app is in the foreground. `keep()` is the authority on what is actually
 * written, because it is JavaScript and no cast can lose it.
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
      /*
       * HIGH, AND IT USED TO BE BALANCED — REVERSED BECAUSE THE MAP THROWS A
       * BALANCED FIX AWAY.
       *
       * The old argument is quoted here because every word of it was true of
       * the trail it was written for: "Balanced is happy with the network
       * fixes a trail is made of — this records which part of a city somebody
       * was in, not which doorway, and the difference is roughly the whole of
       * the battery cost."
       *
       * What it did not account for is `dropInaccurateFixes`, which the Live
       * map runs over every trail before drawing it and which discards any fix
       * worse than `mbos.location.gpsAccuracyThresholdM` — 50 m. Balanced on
       * Android is roughly a city block: it returns 100 m indoors, and
       * `native/location.ts` says so in as many words. So the two settings
       * contradicted each other, and the trail was asking the radio for a
       * precision the screen had already decided it would refuse.
       *
       * The cost was not a coarse line. It was NO line: a fix was woken for,
       * taken, kept, queued, uploaded, stored and indexed, and then dropped
       * on the way to the map. On this handset 14 of 96 fixes in half an hour
       * went that way, and in the last two minutes of it, 3 of 3 — the trail
       * simply stopped growing while the phone reported perfect health. That
       * is the same shape as the five-minute cadence bug one rule along:
       * paying for data and discarding it, with nothing anywhere looking
       * wrong.
       *
       * IT DOES COST MORE BATTERY, and saying otherwise would be the same
       * kind of wrong the old comment was. The WAKE rate is unchanged — that
       * is `trackEverySeconds`, and it was already 3 — but High engages the
       * GPS chip where Balanced was content with wifi and cell triangulation,
       * and that is a real draw, over a full field day a large one. What is
       * not true is the old framing of it as a trade of battery for detail:
       * at Balanced the battery bought fixes that were discarded, so the
       * previous setting was not the cheap option, it was the one that paid
       * and got nothing. The dial for the cost is `trackEverySeconds`, which
       * decides how often the radio is asked at all; this decides whether
       * what comes back can be used.
       *
       * A trail whose whole stated purpose is the road ridden cannot be built
       * out of readings that cannot name a road.
       */
      accuracy: Location.Accuracy.High,
      /* Kept for iOS, which reads it, and for the day expo-location fixes the
         cast that loses it on Android. Nothing depends on it arriving. */
      timeInterval: everyMs,
      distanceInterval: 0,
      /* THE ONE ANDROID HONOURS. `deferredUpdatesInterval` is read with a
         coercing `getLong`, so the number survives the JSON round trip that
         `timeInterval` does not — see the note above this function. It batches
         fixes while the app is in the BACKGROUND instead of waking us every
         three seconds, which is the battery half of the cadence. Expo bypasses
         it in the foreground through its own `shouldReportDeferredLocations`,
         which is exactly why `keep()` and not this is the authority on what
         gets written. */
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

/* ----------------------------------------------------------- the watchdog */

/**
 * NOTICING THAT THE OS LIED.
 *
 * `startLocationUpdatesAsync` succeeding is not the same fact as fixes
 * arriving, and on these handsets it is routinely not even close. A salesman on
 * a vivo V2403 checked in at 04:16 and had posted no position at all by half
 * past twelve — none ever, since the day the phone was bound. The check-in
 * landed, its selfie landed, the device heartbeat was ninety minutes old, and
 * `background_location_granted` read TRUE, which is written from one place only:
 * the end of `start()`, with the answer this function's subject gave. The task
 * was registered and Funtouch's battery manager killed the service behind it.
 * Oppo and Xiaomi do the same thing, and between the three of them that is most
 * of the handsets in this field force.
 *
 * So the app has to be able to disbelieve the OS, and silence is the only
 * evidence there is. The rule itself is pure and lives in
 * `engines/trail-watchdog.ts` — not here, because nothing in this file can be
 * exercised without a device, which is the whole reason the `timeInterval` bug
 * above ran for three days.
 *
 * IT IS A TIMER, AND A TIMER IS THE RIGHT INSTRUMENT FOR EXACTLY THIS ONE JOB.
 * A `setInterval` only advances while the app is open, which is the limitation
 * this whole file exists to work around — but what it falls back TO is the
 * foreground floor, which only records while the app is open either. There is
 * nothing to notice in the background that could be acted on there, and the
 * handset in the incident had its app open at 11:04 with seven hours of
 * silence behind it and no mechanism anywhere to re-evaluate.
 *
 * It asks the OS for NOTHING — no permission call, no restart of the task. The
 * note above `start()` says why: a handset that keeps being asked is a handset
 * somebody turns off. This reads two numbers out of the local database and
 * compares them.
 */
async function watch(): Promise<void> {
  if (mode !== 'background') return;

  try {
    const gap = await minGapMs();
    const misses = await getConfig<number>('mbos.location.trailStalledAfterMisses', 4);
    const raw = await getKv(LAST_KEPT);

    const verdict = trailVerdict({
      now: Date.now(),
      startedAt: backgroundStartedAt,
      lastKeptAt: raw ? Number(raw) : 0,
      gapMs: gap,
      silentCadences: misses,
    });

    /* The clock went backwards under us. The window starts again from here
       rather than being read as either "just started" or "silent for ever". */
    if (verdict === 'restart-the-clock') {
      backgroundStartedAt = Date.now();
      return;
    }
    if (verdict === 'stalled') {
      /* MARKED, not just worked around.
      
         Falling back to the foreground floor keeps SOME of the day and hides
         the cause: the phone is killing the tracker, and the only cure is two
         switches nobody has been asked to touch. The mark is what lets the
         Sync screen say so and what rides up to the office on the device
         report, so a handset going quiet is a support call somebody can
         answer rather than a fortnight of silence. */
      await setKv(STALLED_AT, String(Date.now()));
      await fallBackToFloor();
    }
  } catch {
    /* A watchdog is not allowed to cost a fix or break a day. Whatever could
       not be read here is read again on the next tick. */
  }
}

/**
 * The task was accepted and is delivering nothing. Take what we can while the
 * app is open, and tell the office what is really happening.
 *
 * THE BACKGROUND TASK IS LEFT REGISTERED, which looks like the wrong half of
 * the decision and is not. Stopping it would buy nothing — it is already
 * delivering nothing — and would throw away the one good outcome still
 * available: a battery manager that relents, or a salesman who plugs the phone
 * in, and fixes start arriving again. `keep()` gates whatever does arrive at
 * the same cadence the floor is keeping, and the id of a position is its own
 * reading, so the two mechanisms cannot double anything between them.
 *
 * It does not try the upgrade again either, for the rest of this process.
 * `start()` retrying on every resume would clear the floor's timer each time,
 * hand the dead task another whole window to prove itself, and leave the day
 * full of holes exactly the size of the window — the retry is right where the
 * answer might have changed (a permission granted in Settings) and wrong where
 * the OS has already said yes and meant nothing by it. A fresh process starts
 * the judgement over, which is what a phone reaped and reopened is.
 *
 * `false` is the honest thing to report. The column means "is a real background
 * trail running", and it is not — while `locationPermission`, riding the same
 * request, still reads `always`, so the office can tell this apart from a
 * salesman who refused the prompt. Those are two different conversations to
 * have with him, and only one of them is about the phone.
 */
async function fallBackToFloor(): Promise<void> {
  backgroundProvedSilent = true;
  stopWatching();
  mode = 'foreground';

  /* One fix straight away, for the same reason the first start takes one: the
     alternative is a gap that starts the moment we noticed. */
  void takeForeground();
  if (!foregroundTimer) {
    const seconds = await getConfig<number>('mbos.location.trackEverySeconds', 3);
    foregroundTimer = setInterval(() => void takeForeground(), Math.max(3, seconds) * 1_000);
  }

  void reportLocationPermission(false).catch(() => {});
}

function startWatching(everyMs: number): void {
  stopWatching();
  watchdogTimer = setInterval(() => void watch(), everyMs);
}

function stopWatching(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/** Is the trail running right now, one way or the other? */
export function isTracking(): boolean {
  return mode !== null;
}

/**
 * Start following, if the office has asked for it.
 *
 * Safe to call repeatedly — on check-in, on app resume, on a cold start
 * while the day is already open, and after a sign-in — and it is meant to
 * be, because it is the mechanism that notices a permission granted
 * mid-session. Already on the real background task, it does nothing; still
 * on the foreground floor, it retries the upgrade every time, which costs
 * nothing when the answer is still no and is the only way it ever becomes
 * yes without a check-out. A handset whose permission keeps being refused
 * takes no fixes beyond the floor and says nothing more than the one report
 * below — asking the OS again on every fix is how somebody turns the app off.
 *
 * WHAT IT DOES NOT DO IS RETRY A TASK THE OS HAS ALREADY ACCEPTED, and this
 * comment used to claim otherwise. "It retries the upgrade every time" is true
 * of the foreground floor and was never true of a background task that has
 * silently died: the first line of this function returned, so once the OS had
 * said yes, this process believed it was tracking for the rest of the day
 * whatever arrived. That is exactly the state a vivo handset spent eight hours
 * in with nothing on any screen and nothing in the office saying so. Noticing
 * is the watchdog's job, above; the early return is honest again because
 * something else is now doing the re-evaluating.
 */
export async function start(): Promise<void> {
  if (mode === 'background') return;

  const on = await getConfig<boolean>('mbos.location.trackWhileWorking', true);
  if (!on) return;

  const seconds = await getConfig<number>('mbos.location.trackEverySeconds', 3);
  const every = Math.max(3, seconds) * 1_000;

  /* Caught delivering nothing once already in this process. See
     `fallBackToFloor` for why that answer stands until the process does not. */
  const backgroundStarted = backgroundProvedSilent ? false : await startBackground(every);
  if (backgroundStarted) {
    /* Upgrading off the floor — its timer is now redundant, and running
       both would double the very sampling this exists to fix. */
    if (foregroundTimer) {
      clearInterval(foregroundTimer);
      foregroundTimer = null;
    }
    mode = 'background';
    /* From here the OS's word is on probation. The window is measured from
       this moment, and it is ticked at the cadence because a watchdog that
       looked less often than the thing it is watching would be reporting on a
       silence it had not actually waited through. */
    backgroundStartedAt = Date.now();
    startWatching(await minGapMs());
  } else if (mode !== 'foreground') {
    /* First start, floor only: one fix straight away, so a check-in puts a
       point on the map rather than a gap at the start of every day. A retry
       that is STILL not upgradeable leaves the existing timer running
       rather than starting a second one beside it. */
    void takeForeground();
    foregroundTimer = setInterval(() => void takeForeground(), every);
    mode = 'foreground';
  }

  /* Told to the office, not kept to the handset: a manager watching the Live
     map has no other way to learn a trail's real gaps are a permission, not
     a bug. Fire-and-forget, the same as a position that fails to send — this
     is not on the critical path of the day opening, and every retry above
     reports again, which is how a permission granted mid-session is ever
     seen without waiting for a check-out. */
  void reportLocationPermission(backgroundStarted).catch(() => {});
}

/**
 * Stop whichever mechanism is running, without sending anything — the piece
 * `stop()` and the "office turned it off" branch of `flush()` both need,
 * pulled out so the second of those is not `flush()` calling itself.
 */
async function stopTicking(): Promise<void> {
  mode = null;
  /* The day is over, so there is nothing left to watch — and `backgroundStartedAt`
     goes with it, because a mark left standing would have the next check-in's
     task judged on the silence of the one before it. */
  stopWatching();
  backgroundStartedAt = 0;
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
 * It used to send exactly ONE, and that is a drain with a fixed rate in front
 * of a queue with none. At a fix every three seconds the handset produces
 * twenty rows a minute before any redelivery; `flush()` ran once per sync tick,
 * and the sync tick is a `setInterval` that only advances while the app is
 * open. So the queue is emptied oldest-first at five hundred rows per minute of
 * SCREEN TIME and filled all day — and the newest fix, which is the only one
 * the Live map wants, sits at the back of it.
 *
 * What that looked like in production: a phone uploaded three thousand rows
 * across six successful posts in one day and moved its trail forward by three
 * minutes of the PREVIOUS evening, while its owner walked a full beat. Nothing
 * errored. The posts returned 200, the data connection was fine, and the office
 * simply saw a salesman standing where he had been the night before.
 *
 * The cap is here so a wedged queue cannot spin for ever, not because stopping
 * early is ever wanted.
 */
const MAX_PASSES = 50;

/**
 * How long a position the server cannot yet file is kept.
 *
 * Only reached on `no-session-yet` — the check-in is still in the outbox, or
 * never made it. Days of that is worth surviving; a fortnight of it is a queue
 * nobody will ever drain.
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
 * Not re-entrant. The background task and the sync timer both call it, and two
 * passes reading the same five hundred rows would post them twice — harmless
 * now that the id is the reading, and pointless bandwidth on a 2G connection
 * either way.
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
         the handset deletes on any `ok` and throwing a morning away to win a
         race by thirty seconds is the worse trade. Anything old enough that no
         check-in is ever coming goes, so this cannot become a queue that only
         grows. */
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


/**
 * When this handset was last caught with its tracker silenced, or null.
 *
 * Read by the Sync screen and by the device report. Never cleared by a
 * successful fix on purpose: one fix arriving does not mean the battery
 * manager has changed its mind, and a mark that clears itself on the first
 * good reading would flicker off every time the salesman opened the app —
 * which is the one moment tracking always works.
 */
export async function stalledAt(): Promise<number | null> {
  const raw = await getKv(STALLED_AT);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}
