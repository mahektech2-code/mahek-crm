import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { all, getKv, run, setKv } from '../db';
import { getConfig } from '../data/config';
import { getFix, fixOf, rememberFix } from '../native/location';
import { shouldKeepFix } from '../engines/cadence';
import { trailVerdict } from '../engines/trail-watchdog';
import { mayRetryBackground, type Demotion } from '../engines/trail-retry';
import { decideFlush } from '../engines/flush-answer';
import { isoDate } from '../lib/format';
import { chooseCapture, trackingDeadlineSeconds } from '../engines/capture';
import {
  available as serviceAvailable,
  drainFixes,
  forgetFixes,
  serviceState,
  setServiceCredentials,
  startService,
  stopService,
  touchService,
  type ServiceState,
} from '../native/location-service';
import { chooseSender } from '../engines/upload';
import {
  BASE,
  accessToken,
  deviceId,
  postPositions,
  refreshToken,
  reportLocationPermission,
} from './api';

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
let mode: 'service' | 'background' | 'foreground' | null = null;

/**
 * The watchdog period this process last asked WorkManager for.
 *
 * `UPDATE` resets a periodic job's period, so passing it on every start would
 * push the next run out for ever on a handset whose app is opened every ten
 * minutes — a `setInterval` cleared on every resume, arriving inside the one
 * scheduler that was supposed to be immune to that. So the period is only ever
 * replaced on the ONE call where the office's number differs from the last one
 * we used, which is what this remembers.
 *
 * In memory rather than in the kv store, deliberately: a fresh process has not
 * enqueued anything, and `KEEP` on a job that is already scheduled at the right
 * period is exactly the right answer for it.
 */
let watchdogMinutesInForce = 0;

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
/**
 * The last demotion this process made, or null.
 *
 * IT WAS A BOOLEAN AND IT WAS NEVER CLEARED, which is the second bug this
 * watchdog has produced rather than caught. Once set, `start()`'s first act was
 * to skip background registration — for the check-in, for the afternoon
 * session, for every foreground resume, for the rest of the process. And the
 * thing it fell back to is a `setInterval`, which only advances while the app
 * is the thing on screen: a handset demoted at nine and put in a pocket
 * recorded NOTHING for the rest of the day, and `flush()` is not called on that
 * path either, so the office saw a man standing where he had last opened the
 * app. The demotion was meant to salvage part of a day; on the phone it was
 * built for it salvaged none.
 *
 * It carries its calendar day as well as its instant because the rule that
 * spends it wants both, and `isoDate` is the local date — never `toISOString`,
 * which answers in UTC and would roll the day over at half past five in the
 * morning here. `engines/trail-retry.ts` is the rule.
 */
let demotion: Demotion = null;
/**
 * What the OS last said when we asked it to register, where that was not yes.
 *
 * A REGISTRATION FAILURE AND AN OEM KILL USED TO BE THE SAME ANSWER —
 * `startBackground` returned `false` for both, and for a refused permission,
 * and for a platform with no background location at all. So "the tracker is not
 * running" was the whole of what anybody could be told, on a screen whose
 * entire job is telling somebody which of four different things to go and do.
 */
let startFailure: BackgroundStartFailure | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The last permission answer this process actually reported.
 *
 * Kept so that a later report can RESTATE it rather than re-assert something
 * nobody re-checked — see the note in `fallBackToFloor`, which used to send
 * `false` here and made two columns in the office contradict each other about
 * one phone.
 */
let lastReportedGrant: boolean | null = null;

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
    /*
     * AND THEN SENT, which the floor never did.
     *
     * The background task flushes inline for the reason given at its own call
     * site — it is the OS waking the app, so it is the one reliable moment to
     * empty the queue. The floor had no such line, so on the handsets that
     * most need it (a demoted phone, or one with no background permission at
     * all) fixes were taken and then sat waiting for the sync timer, which is
     * the very `setInterval` this file exists to distrust. The office saw
     * nothing until the salesman opened a screen that happened to sync.
     *
     * `flush()` is not re-entrant and returns immediately while a pass is
     * already running, so this costs nothing where the sync engine got there
     * first.
     */
    await flush();
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
 * So the cadence is enforced in ONE place and it is not either of these
 * arguments: `keep()`, in JavaScript, where no cast can lose it.
 * `deferredUpdatesInterval` is the one Android honours and it is now 0 — see
 * the note on it below for the eight and a half minutes of a pocketed handset
 * that bought. It never belonged to the cadence at all: it decides when we are
 * TOLD about a fix, not how often one is taken, and the two were conflated
 * because both are measured in milliseconds.
 */
/**
 * WHY IT DID NOT START, which used to be one word for four situations.
 *
 * `unavailable` is a build or a platform with no background location in it at
 * all. The two permission answers are a salesman to talk to. `registration_failed`
 * is the OS itself refusing, which is nobody's settings screen and is the one
 * that has to reach somebody who can read a log — and it was indistinguishable
 * from a battery manager killing an accepted task, which is the opposite
 * diagnosis with the opposite cure.
 */
export type BackgroundStartFailure = {
  why: 'unavailable' | 'no_foreground_permission' | 'no_background_permission' | 'registration_failed';
  at: number;
  /** The thrown message, where there was one. Never shown to a salesman. */
  detail?: string;
};

type BackgroundStart = { ok: true } | ({ ok: false } & BackgroundStartFailure);

async function startBackground(everyMs: number): Promise<BackgroundStart> {
  const failed = (
    why: BackgroundStartFailure['why'],
    detail?: string,
  ): BackgroundStart => ({ ok: false, why, at: Date.now(), detail });

  try {
    if (!(await Location.isBackgroundLocationAvailableAsync())) return failed('unavailable');

    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted') return failed('no_foreground_permission');

    const bg = await Location.getBackgroundPermissionsAsync();
    const granted =
      bg.status === 'granted' ? true : (await Location.requestBackgroundPermissionsAsync()).status === 'granted';
    if (!granted) return failed('no_background_permission');

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
      /*
       * ZERO — NO DEFERRAL — AND IT USED TO BE THE CADENCE.
       *
       * `deferredUpdatesInterval` is the one of these Android actually honours
       * (it is read with a coercing `getLong`, so it survives the JSON round
       * trip `timeInterval` does not), and it was set to the sampling interval
       * on the reasoning that batching in the background is "the battery half
       * of the cadence". Expo bypasses it in the FOREGROUND through its own
       * `shouldReportDeferredLocations`, and that asymmetry is the whole bug:
       * batched in the background, immediate in the foreground.
       *
       * WHAT THAT MEANT IN THE FIELD. A salesman pocketed a working handset at
       * 16:37 and opened the app again at 16:46. Android had collected 123
       * fixes at three-second spacing across those eight and a half minutes —
       * and handed MBOS not one of them until the app came forward, when the
       * entire batch arrived in a single delivery. So `store()` never ran,
       * `flush()` never ran, and the office saw nothing at all: not a stale
       * position, NOTHING, for as long as the phone stayed in a pocket. The
       * data was not lost — Android was holding it — but "the console is blind
       * until he opens the app" is not background tracking, and it is exactly
       * what a manager watching the Live map is relying on it not to be.
       *
       * It also made the watchdog next door right about the wrong thing: the
       * task genuinely was delivering nothing, so the only argument was over
       * how long to wait before saying so.
       *
       * The battery this bought is real and is not worth it. A trail that only
       * exists once somebody opens the app is a trail whose whole purpose has
       * been traded away — and the dial for cost is `trackEverySeconds`, which
       * decides how often the radio is asked in the first place. Deferral only
       * decides whether we are TOLD, and being told late is being told nothing
       * on the one screen that reads this live.
       *
       * `deferredUpdatesDistance` stays 0 for the reason it always was: a
       * salesman standing still in a shop is a fact the trail wants, and
       * distance-gating would drop the dwell that proves he was there.
       */
      deferredUpdatesInterval: 0,
      deferredUpdatesDistance: 0,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: 'MahekOne is following your route',
        notificationBody: 'Recording where the day takes you. Stops the moment you punch out.',
        killServiceOnDestroy: false,
      },
    });
    return { ok: true };
  } catch (e) {
    /*
     * THE THROW USED TO BE INDISTINGUISHABLE FROM A KILLED SERVICE.
     *
     * `catch { return false }` made "the OS refused to register the task" read
     * exactly like "the salesman has not granted the permission" and exactly
     * like "Funtouch accepted it and then killed it" — three problems, three
     * different things to do about them, one answer. It is kept as a reason
     * with its message, which is what makes it reportable at all; nothing is
     * rethrown, because a failure here must never cost the check-in that is
     * waiting on it.
     */
    return failed('registration_failed', e instanceof Error ? e.message : String(e));
  }
}

/* -------------------------------------------------------- our own service */

/**
 * WHAT THE NATIVE SERVICE IS TOLD, AND WHY EACH NUMBER HAS TO CROSS.
 *
 * The service can be started next by a boot receiver or a WorkManager worker,
 * in a process with no JavaScript runtime and therefore no `getConfig`, no
 * SQLite and no pull. So every number it runs on is written into its own
 * preferences file on the way past, by this function, and it reads them from
 * there. That is a MIRROR and not a second source of truth: JavaScript writes,
 * native reads, nothing native ever writes back.
 *
 * `wantedForSeconds` is the one that is not a tuning knob. It is the deadline
 * that ends a day which had no check-out — a phone switched off at four and
 * turned on at eleven would otherwise find "the office wants tracking" in a
 * file nobody had been able to clear, and would follow its owner home. "Not one
 * second either side" is the rule the whole trail rests on and a preferences
 * file is exactly where such a rule gets lost. It is pushed forward on every
 * flush, so a working day extends it and a dead one expires.
 */
async function startOurService(everyMs: number): Promise<boolean> {
  if (!serviceAvailable()) return false;

  try {
    const keepSeconds = Math.round((await minGapMs()) / 1000);
    const cap = await getConfig<number>('mbos.location.serviceBufferCap', 50_000);
    const hours = await getConfig<number>('mbos.location.serviceMaxDayHours', 16);
    const watchdogMinutes = await getConfig<number>('mbos.location.serviceWatchdogMinutes', 15);

    const uploadSeconds = await getConfig<number>(
      'mbos.location.serviceUploadEverySeconds',
      6,
    );
    const retentionDays = await getConfig<number>('mbos.location.queueRetentionDays', 7);

    const periodChanged =
      watchdogMinutesInForce !== 0 && watchdogMinutesInForce !== watchdogMinutes;
    watchdogMinutesInForce = watchdogMinutes;

    /*
     * THE CREDENTIAL GOES FIRST, BEFORE THE SERVICE IS ASKED TO START.
     *
     * The service posts for itself, and a service started without one would
     * spend its first cadence discovering it has nothing to sign with, mark
     * itself blocked, and sit at the backoff ceiling for five minutes on the
     * one morning the salesman is watching. Written first, its very first tick
     * can send.
     *
     * It is also written from `setTokens` in `sync/api.ts`, which is the one
     * place the app ever mints a token, so the mirror follows a refresh
     * without waiting for the next `start()`.
     */
    await setServiceCredentials({
      baseUrl: BASE,
      deviceId: await deviceId(),
      accessToken: (await accessToken()) ?? '',
      refreshToken: (await refreshToken()) ?? '',
    });

    return await startService({
      askEverySeconds: Math.max(3, Math.round(everyMs / 1000)),
      keepEverySeconds: Math.max(3, keepSeconds),
      bufferCap: Math.max(1, cap),
      wantedForSeconds: trackingDeadlineSeconds(hours),
      watchdogMinutes: Math.max(15, watchdogMinutes),
      periodChanged,
      /* NOT FLOORED, unlike everything beside it. Zero is a decision — the
         recorder does not send and this app does, which is what it did before
         the uploader existed — and flooring it would take that answer away. */
      uploadEverySeconds: Math.max(0, Math.round(uploadSeconds)),
      retentionDays: Math.max(1, Math.round(retentionDays)),
    });
  } catch {
    /* Configuration could not be read, which on a handset that has never
       pulled is ordinary. The service is not started on a guess — the next
       call to `start()`, on the next resume, will have the numbers. */
    return false;
  }
}

/**
 * MOVE WHAT THE SERVICE RECORDED INTO THE TRAIL.
 *
 * The service writes to its own SQLite file and not to `mbos.db`, for the three
 * reasons `FixStore` sets out — chiefly that two different SQLite libraries on
 * one file, on handsets the OS reaps mid-write, risks the database holding
 * every unsent visit, order and payment on the phone. So there is a drain, and
 * this is it.
 *
 * IT IS TWO-PHASE AND THE ORDER IS THE POINT. The rows are read, inserted, and
 * only then forgotten. A kill between the read and the insert costs a repeat;
 * a repeat costs nothing, because `fixId` is derived from the reading and the
 * insert is `INSERT OR IGNORE`. Forgetting on read would save one bridge call
 * and cost a morning of somebody's route to the same kill.
 *
 * It runs at the top of `flush()` rather than on a timer of its own, because
 * flush is already every moment this app has a reason to touch the queue — the
 * sync pass, the check-out, and the position task's own inline call.
 */
async function drainService(): Promise<number> {
  if (!serviceAvailable()) return 0;

  /*
   * ONE OWNER, AND IT IS THE SERVICE WHENEVER THE SERVICE CAN SEND.
   *
   * The recorder posts for itself now — that is what made this module a whole
   * fix rather than half of one — so moving its rows into `positions` here
   * while it is also sending them would have two queues draining the same
   * fixes. Nothing is lost by that (the id of a position is its own reading,
   * and both the local insert and the server's are conflict-ignore) and it is
   * still two phones' worth of data spent to deliver one.
   *
   * `uploads` is the service's own answer about five things it knows and this
   * side does not — the office's cadence, whether it holds a usable
   * credential, whether the server has refused that credential, whether the
   * day is still open and whether the service is even running. Every one of
   * those going false hands the queue back here, which is what makes the
   * handover unambiguous in BOTH directions: the check-out clears the deadline
   * and the flush that follows it picks up the last few minutes of the day.
   *
   * AND THE TWO READINGS BESIDE IT ARE WHAT CATCH AN UPLOADER THAT BELIEVES
   * ALL FIVE AND IS STILL SENDING NOTHING — see `chooseSender`, which is
   * where that whole argument lives. They are already on the state this call
   * returns; nothing extra is asked of the handset to answer it.
   */
  const state = await serviceState();
  if (
    chooseSender({
      serviceAvailable: true,
      nativeUploads: state.uploads,
      lastUploadAgoSeconds: state.lastUploadAgoSeconds,
      buffered: state.buffered,
    }) === 'native'
  ) {
    return 0;
  }

  let moved = 0;
  /* Bounded, so a buffer that somehow grew past every cap cannot spin here for
     ever. The cap is generous: at the three-second cadence this is several
     hours of somebody's route, and a short read ends the loop anyway. */
  for (let pass = 0; pass < DRAIN_PASSES; pass++) {
    const rows = await drainFixes(DRAIN_BATCH);
    if (!rows.length) return moved;

    const kept: string[] = [];
    for (const row of rows) {
      try {
        await store(row.lat, row.lng, row.accuracyM, row.at);
        kept.push(row.id);
      } catch {
        /* One row that would not insert must not strand the page behind it.
           It is left in the buffer and tried again on the next drain; if it is
           genuinely unstorable the cap eventually retires it, which is the
           right end for one fix and the wrong end for a morning. */
      }
    }
    await forgetFixes(kept);
    moved += kept.length;

    if (rows.length < DRAIN_BATCH) return moved;
  }
  return moved;
}

/** One page of the native buffer, and how many pages one drain may take. */
const DRAIN_BATCH = 500;
const DRAIN_PASSES = 50;

/**
 * WHAT THE SERVICE HAS BEEN DOING, for the office.
 *
 * The office could see that a handset had gone quiet and never why. These four
 * facts answer it: whether the service is up at all, when it last took a fix,
 * how many it is still holding, and how many times today it has had to be
 * started — which is the number that names an OEM battery manager rather than
 * describing its effects.
 *
 * It rides the position batch, which is already authenticated, already names
 * the device and already runs every few minutes while a day is open. A channel
 * of its own would spend the battery in order to report on it.
 */
export async function ourServiceState(): Promise<ServiceState | null> {
  if (!serviceAvailable()) return null;
  return serviceState();
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
    /* The floor on the window, and the reason it exists is in the engine: four
       misses of a three-second cadence is twelve seconds, which any walk
       indoors clears — and the penalty for clearing it is that background
       tracking is switched off for the rest of the process. */
    const minSilence = await getConfig<number>('mbos.location.trailStalledMinSilenceSeconds', 300);
    const raw = await getKv(LAST_KEPT);

    const verdict = trailVerdict({
      now: Date.now(),
      startedAt: backgroundStartedAt,
      lastKeptAt: raw ? Number(raw) : 0,
      gapMs: gap,
      silentCadences: misses,
      minSilenceMs: Math.max(1, minSilence) * 1_000,
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
 * IT DOES TRY THE UPGRADE AGAIN, AND IT USED NOT TO. The objection that stopped
 * it is real and is kept: retrying on every resume clears the floor's timer each
 * time, hands the dead task another whole window to prove itself, and leaves the
 * day full of holes exactly the size of that window. What was wrong was the
 * conclusion drawn from it — that the demotion should stand for the life of the
 * process. It stood on a `setInterval` that only advances while the app is on
 * screen, so a pocketed handset recorded nothing at all for the rest of the day
 * and `flush()` never ran either. `engines/trail-retry.ts` bounds the cost
 * instead: one window per configured interval, plus a free attempt on a new day
 * and on a check-in, which is the moment he has just been walked to the
 * autostart switch.
 *
 * WHAT IT NO LONGER DOES IS SAY THE PERMISSION WAS REFUSED. It reported
 * `backgroundGranted: false` here, reasoning that the column means "is a real
 * background trail running". The column does not mean that — the schema says
 * "whether this handset actually got the OS's background location permission" —
 * and the app did not re-check one. Production shows exactly the contradiction
 * that produces: `location_permission = 'always'` beside
 * `background_location_granted = false` on the same row, on two handsets. The
 * office reads the boolean, the office sends somebody to check a setting that
 * was already correct, and the real cause — a battery manager killing an
 * accepted service — is the one thing nobody goes and looks at.
 *
 * The honest field for "background is not working" already exists and is
 * `trackerStalledAt`, written from the mark this function's caller sets and
 * carried by `readDeviceState` on every report. So the report still goes, and
 * the permission answer it carries is RESTATED unchanged rather than asserted.
 */
async function fallBackToFloor(): Promise<void> {
  demotion = { at: Date.now(), day: isoDate(new Date()) };
  stopWatching();
  mode = 'foreground';

  /* One fix straight away, for the same reason the first start takes one: the
     alternative is a gap that starts the moment we noticed. */
  void takeForeground();
  if (!foregroundTimer) {
    const seconds = await getConfig<number>('mbos.location.trackEverySeconds', 3);
    foregroundTimer = setInterval(() => void takeForeground(), Math.max(3, seconds) * 1_000);
  }

  /*
   * The stall mark is already in the kv store by the time this runs — the
   * caller writes it before calling — so this report carries
   * `trackerStalledAgoSeconds` and the office learns the true thing. The
   * boolean is whatever this process last reported and is sent again unchanged;
   * `true` is the fallback for the case where nothing has reported yet, because
   * we only reach here from `mode === 'background'`, which means the permission
   * was granted. Inventing `false` is precisely the bug above.
   */
  void reportLocationPermission(lastReportedGrant ?? true).catch(() => {});
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
 *
 * `reason` SEPARATES A CHECK-IN FROM A RESUME, and the difference is the whole
 * of the recovery path. A resume is the app coming forward, which happens
 * dozens of times a day and says nothing new about the phone; a check-in is a
 * man who has just been through the start-of-day gate, which is the screen that
 * walks him to the autostart switch. A demotion made earlier today stands
 * against the first and never against the second — refusing to re-test what he
 * was just sent to fix would make that screen pointless. It defaults to
 * `'resume'`, so a caller that says nothing gets the cautious answer.
 */
export async function start(reason: 'check-in' | 'resume' = 'resume'): Promise<void> {
  if (mode === 'background') return;

  /*
   * `mode === 'service'` IS DELIBERATELY NOT AN EARLY RETURN, unlike the line
   * above it.
   *
   * That one exists because re-registering an expo task the OS has already
   * accepted buys nothing and hands a dead task another whole window to prove
   * itself. This is the opposite case on both counts: running `start` again
   * against a live service is cheap, it is how configuration pulled this
   * morning reaches the native side, and it is how the privacy deadline gets
   * pushed out on a handset whose flushes have all failed. The native side is
   * idempotent — a second `startForegroundService` on a running service is one
   * more `onStartCommand`, which removes its old provider callback before
   * installing a new one.
   */

  const on = await getConfig<boolean>('mbos.location.trackWhileWorking', true);
  if (!on) return;

  const seconds = await getConfig<number>('mbos.location.trackEverySeconds', 3);
  const every = Math.max(3, seconds) * 1_000;

  /*
   * OUR OWN SERVICE IS ASKED FIRST, AND THAT IS THE WHOLE POINT OF THIS
   * RELEASE.
   *
   * Everything below this block is the mechanism that has been failing in the
   * field: `expo-location`'s task, and the `setInterval` floor it falls back
   * to. The cause is one line in a library we do not own —
   * `LocationTaskConsumer.maybeStartForegroundService()` returns early on
   * `!AppForegroundedSingleton.isForegrounded`, and that flag is set only from
   * `OnActivityEntersForeground`, so a task restored into a headless process
   * gets NO foreground service and Android 10+ throttles it to a few fixes an
   * hour. Only a person opening the app puts the dense tracker back, which is
   * exactly the silence-then-burst shape in the production data: fifty-one
   * silences and 523 minutes lost in one day on a handset reporting perfect
   * health.
   *
   * `modules/location-service` is a foreground service of ours that can be
   * started from a receiver or a worker with no Activity anywhere, which is
   * the one thing expo-location cannot do.
   *
   * THE OLD PATH IS LEFT INTACT UNDERNEATH rather than deleted. An APK cannot
   * be recalled: a handset in somebody's pocket runs the build it has until
   * somebody installs the next one, and this file is compiled into both. It is
   * also the honest fallback for the case where the platform refuses our
   * service outright — see `chooseCapture`, which is where that choice lives
   * so it can be tested without a phone.
   */
  const serviceStarted = await startOurService(every);

  /*
   * THE DEMOTION GOVERNS THE BORROWED TRACKER AND NOTHING ELSE, which is what
   * keeps two mechanisms from fighting over one act.
   *
   * `engines/trail-retry.ts` exists because the old `backgroundProvedSilent`
   * was a one-way boolean: the first stall of a process was its last word, and
   * the floor it fell to is a `setInterval` that only advances while the app is
   * on screen, so a pocketed handset recorded nothing for the rest of the day.
   * That bug is entirely about `startLocationUpdatesAsync`, so the rule that
   * bounds it is asked ONLY where that call is about to be made. Where our own
   * service took capture the question is not asked, no demotion is written
   * (`fallBackToFloor` is reached only from the JS watchdog, which is stopped
   * below), and the service's own WorkManager watchdog, boot receiver and
   * heartbeat are the single mechanism holding capture up.
   */
  const retryMinutes = await getConfig<number>('mbos.location.trackerRetryAfterMinutes', 30);
  const mayTry =
    !serviceStarted &&
    mayRetryBackground({
      demotion,
      now: Date.now(),
      today: isoDate(new Date()),
      freshCheckIn: reason === 'check-in',
      retryAfterMs: Math.max(0, retryMinutes) * 60_000,
    });

  const attempt = mayTry ? await startBackground(every) : null;
  /* A refusal to attempt is not a failure to report: the last reason stands,
     because it is still the reason. */
  if (attempt) startFailure = attempt.ok ? null : attempt;
  const backgroundStarted = attempt?.ok === true;

  const capture = chooseCapture({
    trackingOn: true,
    serviceAvailable: serviceAvailable(),
    serviceStarted,
    /* Both are settled by the time we get here: the check-in's own fix has
       already established the foreground grant, and `startBackground` asks for
       the background one and reports what it got. Reading the permissions
       again here would be two more native round trips to learn what the two
       booleans beside them already say. */
    foregroundGranted: true,
    backgroundGranted: backgroundStarted,
    taskStarted: backgroundStarted,
  });

  if (capture === 'service') {
    /* The service owns capture from here. The floor's timer is redundant and
       running both would double the very sampling this exists to fix; the JS
       watchdog is redundant too, because the thing it watches for — a task
       accepted and silent — is now watched by the service's own heartbeat,
       inside a process the OS has agreed not to reap. */
    if (foregroundTimer) {
      clearInterval(foregroundTimer);
      foregroundTimer = null;
    }
    stopWatching();
    mode = 'service';
    backgroundStartedAt = 0;
    /* A stall mark belongs to the OLD mechanism. Leaving it standing would have
       the office reading "his phone stopped the tracker" off a verdict about a
       task this handset is no longer using — the same permanent false alarm the
       explicit null was added to `device-state.ts` to end. The in-memory
       demotion goes for the same reason, one scope down: it is a verdict about
       a registration this handset is no longer relying on, and leaving it would
       demote the first attempt made on a day the service could not start. */
    await setKv(STALLED_AT, '');
    demotion = null;
    /*
     * AND THE START FAILURE GOES WITH IT, which is the one thing that fell out
     * of putting the two branches together and is in neither of them.
     *
     * `startFailure` is read by the Sync screen through `backgroundStartFailure()`
     * and turned into a sentence by `engines/tracker-notice.ts`. A
     * `registration_failed` recorded at nine — when the borrowed tracker was
     * the only mechanism — would go on drawing "This phone would not start the
     * tracker. Ring the office" all day on a handset whose own service is
     * recording perfectly well. It is the false alarm on a healthy phone that
     * this whole release is about, arriving by a third door: the verdict is
     * about a registration nothing is relying on any more.
     */
    startFailure = null;
    /*
     * THE REPORT STILL GOES, AND THE BOOLEAN IS RESTATED RATHER THAN INVENTED.
     *
     * It said `true` here, flatly, and on this path nothing has asked the OS
     * about the background permission at all — `startBackground` is the only
     * thing that does and it was skipped. Asserting a grant nobody checked is
     * the mirror image of the bug this release exists to fix, where
     * `fallBackToFloor` asserted a REFUSAL nobody checked and put
     * `location_permission = 'always'` beside `background_location_granted =
     * false` on two production handsets.
     *
     * The report itself is not optional: `/api/mbos/location-permission`
     * refuses a body with no boolean in it, and this call is the carrier for
     * the whole device state — `locationServiceRunning`, the buffer depth, the
     * last accepted upload. On a handset whose recorder is posting for itself,
     * `flush()` hands the queue to the native uploader and this is the only
     * channel left that says anything about the phone.
     *
     * So the last answer this process gave is sent again, and `true` is the
     * fallback where there is none. It is the benign direction and the one
     * that invents least: `false` maps to `restricted` in
     * `lib/handset-health.ts` and would draw "Background location off — trail
     * has real gaps" on a phone whose trail is fine, which is a false alarm on
     * the one panel built on a healthy handset saying nothing. And the boolean
     * is very nearly vestigial for a build that has this service at all —
     * `locationState` prefers `locationPermission`, which rides in this same
     * payload read fresh from the OS, and `trailIsDead` catches a genuinely
     * dead trail whatever any permission says.
     */
    const report = lastReportedGrant ?? true;
    lastReportedGrant = report;
    void reportLocationPermission(report).catch(() => {});
    return;
  }

  if (backgroundStarted) {
    /* It works again. Whatever this process concluded earlier was about a phone
       in a state it is no longer in, and leaving the mark would demote the
       next attempt on the strength of it. */
    demotion = null;
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

  /*
   * Told to the office, not kept to the handset: a manager watching the Live
   * map has no other way to learn a trail's real gaps are a permission, not
   * a bug. Fire-and-forget, the same as a position that fails to send — this
   * is not on the critical path of the day opening, and every retry above
   * reports again, which is how a permission granted mid-session is ever
   * seen without waiting for a check-out.
   *
   * THE BOOLEAN IS ONLY SENT WHERE A PERMISSION WAS ACTUALLY ANSWERED. It was
   * `backgroundStarted`, which folds four different outcomes into one word:
   * "he refused the prompt", "this build has no background location in it",
   * "the OS threw on registration", and — once the demotion above stands —
   * "we did not ask". Three of those four say nothing whatever about a
   * permission, and the column means the permission. Sending `false` for them
   * is the same overload `fallBackToFloor` was corrected for, arriving one
   * function along; `locationPermission` in the device state beside it is read
   * fresh from the OS every time and carries the richer truth regardless.
   */
  const grant =
    attempt === null
      ? null
      : attempt.ok
        ? true
        : attempt.why === 'no_foreground_permission' || attempt.why === 'no_background_permission'
          ? false
          : null;

  /* Nothing new was learned about the permission, so the last answer is
     restated rather than a new one invented. With no previous answer at all
     there is nothing honest to say and the report is skipped — the position
     flush carries the device state anyway. */
  const report = grant ?? lastReportedGrant;
  if (report !== null) {
    lastReportedGrant = report;
    void reportLocationPermission(report).catch(() => {});
  }
}

/**
 * Stop whichever mechanism is running, without sending anything — the piece
 * `stop()` and the "office turned it off" branch of `flush()` both need,
 * pulled out so the second of those is not `flush()` calling itself.
 */
async function stopTicking(): Promise<void> {
  mode = null;
  /* THE DEADLINE IS CLEARED BEFORE ANYTHING ELSE. `stopService` clears it and
     then asks the platform to stop the service, in that order, so a stop the
     platform refuses still leaves a service that will stop itself on its next
     fix — it reads the same flag on every one. The opposite order would leave
     a cleared flag and a service nobody told. */
  await stopService();
  /* The day is over, so there is nothing left to watch — and `backgroundStartedAt`
     goes with it, because a mark left standing would have the next check-in's
     task judged on the silence of the one before it. */
  stopWatching();
  backgroundStartedAt = 0;
  /* The demotion goes with it. It was a verdict about a task registered for
     the day that has just ended, and holding it would have the next check-in
     judged on a silence belonging to the one before it — the same reasoning
     `backgroundStartedAt` is cleared for, one line up. The persisted
     `STALLED_AT` mark is deliberately NOT cleared: that one describes the
     handset rather than a registration, and `stalledAt()` says why. */
  demotion = null;
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
const RETENTION_DAYS_FALLBACK = 7;

/**
 * CONFIGURATION, because it decides how durable somebody's working day is.
 *
 * It was a constant for the life of the module, which put the one number
 * governing whether a day survives a bad week beyond the reach of anybody who
 * would ever need to change it — the same mistake `trailKeepEverySeconds` was
 * made of, one rule along, and the standing rule in AGENTS.md that a threshold
 * a manager might one day want to move belongs in the registry.
 *
 * The fallback is the number it always was, so a handset with no configuration
 * yet behaves exactly as it did.
 */
async function retentionMs(): Promise<number> {
  const days = await getConfig<number>(
    'mbos.location.queueRetentionDays',
    RETENTION_DAYS_FALLBACK,
  );
  return Math.max(1, days) * 24 * 60 * 60 * 1000;
}

/**
 * How many fixes are still waiting to be sent.
 *
 * The number the office could never see. A handset can answer every heartbeat,
 * report its battery, look perfectly healthy — and be holding hours of somebody's
 * route, because every fix waits here until the server confirms it. That is the
 * design working rather than a fault, and it is exactly why nothing is lost to a
 * bad connection; what was missing is any way to say how far behind a phone is.
 *
 * Counted rather than remembered: the queue is written by a background task and
 * emptied by `flush()`, so a cached figure would be wrong the moment either ran.
 */
export async function queueDepth(): Promise<number> {
  const rows = await all<{ n: number }>('SELECT COUNT(*) as n FROM positions');
  const n = rows[0]?.n;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * How many ids one `IN (…)` may carry.
 *
 * SQLite binds each one as its own variable and `SQLITE_MAX_VARIABLE_NUMBER`
 * is 999 on the older builds this app still runs on. A batch is five hundred,
 * so today's largest delete fits — but `filed` is a list the SERVER composes,
 * and a rule that happens to be safe because of a constant in a different file
 * is one deploy away from not being. Chunked at a number well under the floor,
 * which costs nothing and cannot be got wrong later.
 */
const DELETE_CHUNK = 400;

/**
 * Let go of exactly these rows, and nothing else.
 *
 * An empty list does NOT mean "everything" — it means the server named nothing
 * it was finished with, which is a real answer on a partial. A bare
 * `DELETE ... WHERE id IN ()` is a syntax error in SQLite anyway, and the
 * version of this bug where an empty list is read as "all" is the one that
 * would quietly empty somebody's queue.
 */
async function removeIds(ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const marks = chunk.map(() => '?').join(',');
    await run(`DELETE FROM positions WHERE id IN (${marks})`, [...chunk]);
  }
}

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
    /* THE NATIVE BUFFER IS EMPTIED FIRST, so the rows the service took while
       this bundle was dead are in `positions` before the page is selected.
       Draining afterwards would post the queue as it stood before the drain
       and leave the newest part of somebody's route — which is the only part
       the Live map wants — waiting for the next pass. */
    await drainService();

    /* THE DAY IS STILL OPEN, said to the native side on a channel that is
       already running. A flush happens on every sync pass, so this is the
       cheapest possible place to push the deadline out, and it means a phone
       that is syncing at all can never have its tracker expire underneath it. */
    if (mode !== null) {
      const hours = await getConfig<number>('mbos.location.serviceMaxDayHours', 16);
      void touchService(trackingDeadlineSeconds(hours));
    }

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

      /* WHAT THE ANSWER MEANS is decided in `engines/flush-answer.ts`, which
         is pure and tested — two production data-loss bugs have now been in
         this loop, and nothing in this file can be exercised without a device.
         What is left here is the doing. */
      const decision = decideFlush(answer, rows.map((r) => r.id));

      /* The office turned it off. Stop taking fixes and drop what is held —
         keeping them would be storing something nobody asked for. */
      if (decision.effect === 'stop-tracking') {
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
      if (decision.effect === 'age-out') {
        await run('DELETE FROM positions WHERE at < ?', [Date.now() - (await retentionMs())]);
        return sent;
      }

      await removeIds(decision.remove);
      sent += decision.sent;

      /*
       * A PARTIAL ANSWER LEAVES ROWS BEHIND AND STILL GOES ROUND, which is the
       * whole reason the word exists: the rows the server could not file are
       * kept, and the queue behind them is not held hostage to them. It is
       * `decision.carryOn` rather than the length test below, because on a
       * partial the batch was full and the loop must still be allowed to end
       * where nothing moved.
       */
      if (!decision.carryOn) return sent;

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

/**
 * Why the real tracker is not running in THIS process, where it is not.
 *
 * Null is either "it is running" or "nothing has tried yet", which are the two
 * cases with nothing to say. The four reasons are four different things to do,
 * and until this existed all four arrived at every screen as the same silence —
 * `startBackground` answered `false` to a refused permission, to a platform
 * that has no background location, to an OS that threw on registration, and to
 * a battery manager killing an accepted task.
 *
 * Deliberately in memory and deliberately not on the wire. It describes a
 * registration this process made, so a fresh process has nothing to inherit;
 * what the office needs about this handset is `trackerStalledAt`, which is
 * persisted and does ride up. Read by the Sync screen.
 */
export function backgroundStartFailure(): BackgroundStartFailure | null {
  return startFailure;
}
