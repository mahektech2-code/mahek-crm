import * as Crypto from 'expo-crypto';
import { all, run } from '../db';
import { getConfig } from '../data/config';
import { getFix, fixOf } from '../native/location';
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
 * check-out for exactly that reason, and the timer is never started without an
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
 */

type Row = { id: string; at: number; lat: number; lng: number; accuracyM: number | null };

let timer: ReturnType<typeof setInterval> | null = null;

/** Is the trail running right now? Used by the day screen to say so. */
export function isTracking(): boolean {
  return timer !== null;
}

/**
 * Start following, if the office has asked for it.
 *
 * Idempotent: called on check-in, on app resume and after a sign-in, and only
 * one timer ever exists. A handset whose permission was refused takes no fixes
 * and says nothing — the visit path has already asked once and been told no,
 * and asking again every five minutes is how somebody turns the app off.
 */
export async function start(): Promise<void> {
  if (timer) return;

  const on = await getConfig<boolean>('mbos.location.trackWhileWorking', true);
  if (!on) return;

  const minutes = await getConfig<number>('mbos.location.trackEveryMinutes', 5);
  const every = Math.max(1, minutes) * 60_000;

  /* One straight away, so a check-in puts a point on the map rather than a
     five-minute gap at the start of every day. */
  void take();
  timer = setInterval(() => void take(), every);
}

/** Stop, and send what is left. Called by the check-out. */
export async function stop(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await flush();
}

/**
 * One fix, stored locally.
 *
 * A coarse fix is kept rather than discarded. A five-hundred-metre reading is
 * poor evidence of a doorway and perfectly good evidence of which part of the
 * city somebody was in, which is all a trail claims to be — and the accuracy
 * travels with it, so nothing downstream has to guess.
 */
async function take(): Promise<void> {
  try {
    const result = await getFix({ accuracyThresholdM: 100, timeoutMs: 15_000 });
    const fix = fixOf(result);
    if (!fix) return;

    await run(
      'INSERT OR IGNORE INTO positions (id, at, lat, lng, accuracyM) VALUES (?, ?, ?, ?, ?)',
      [`mbos_pos_${Crypto.randomUUID()}`, fix.at, fix.lat, fix.lng, fix.accuracyM],
    );
  } catch {
    /* No fix, no permission, no radio. Nothing to say and nothing to do. */
  }
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
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await run('DELETE FROM positions');
    }

    return rows.length;
  } catch {
    return 0;
  }
}
