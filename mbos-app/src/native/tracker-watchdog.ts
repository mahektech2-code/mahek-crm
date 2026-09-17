import { TrackerWatchdog } from '../../modules/tracker-watchdog';

/**
 * THE WATCHDOG THAT OUTLIVES THE APP, as the rest of this codebase sees it.
 *
 * `sync/trail.ts` has a watchdog already and it is a `setInterval`. That is the
 * right instrument for the one job it does — noticing, while the app is open,
 * that a task the OS accepted is delivering nothing — and it is no instrument
 * at all for the failure the field actually shows: an OEM battery manager
 * reaping the whole process. There is no timer in a process that does not
 * exist. Production handsets record fifty-one separate silences inside one
 * working day, 523 minutes lost between them, in the unmistakable shape of many
 * short gaps and then a burst — the burst being the moment somebody opened the
 * app.
 *
 * `modules/tracker-watchdog` is the native half: a WorkManager periodic job,
 * which is the only scheduler Android guarantees across process death. This
 * file is the contract, and it exists so three rules hold in one place rather
 * than at four call sites.
 *
 * **NOTHING HERE EVER THROWS.** Not on iOS, not on web, not on an APK that
 * predates the module, not on a ROM that refuses to schedule anything. Every
 * caller is on a path that has real work to do — the boot sequence, a check-in,
 * a position flush — and none of them may be lost to a watchdog.
 *
 * **ABSENT IS NOT ZERO.** `state()` answers `null` where it cannot say, and
 * `0` where it can: a handset that has never run the watchdog and one that has
 * revived nothing today are completely different facts, and the second is the
 * healthy one. The server keeps the same distinction — an omitted field leaves
 * a column alone and an explicit null clears it — and it is worth exactly as
 * much here, because the panel it feeds is built on a healthy phone saying
 * nothing.
 *
 * **IT SCHEDULES; IT DOES NOT GATE.** Nothing in MBOS may refuse a check-in, a
 * visit or an order because this could not be scheduled. The same rule
 * `native/phone-setup.ts` states next door and `engines/geo.ts` states for a
 * GPS reading.
 */

export type WatchdogState = {
  /**
   * How long ago the native watchdog last ran, in seconds. `null` is "never",
   * which is a fresh install, an iOS build, an APK from before this module —
   * or an OEM that refused to schedule it, which is the one worth reading.
   */
  lastRunAgoSeconds: number | null;
  /**
   * How many times it has had to revive the tracker today. `null` is a build
   * that cannot say; `0` is a phone that has needed none, and those two must
   * never be drawn alike.
   */
  revivalsToday: number | null;
};

const ABSENT: WatchdogState = { lastRunAgoSeconds: null, revivalsToday: null };

/**
 * Schedule the periodic check.
 *
 * `periodChanged` is passed true on the one call where the office's own number
 * has moved since the last one; see the Kotlin for why a watchdog that is
 * re-enqueued on every app open never fires. Working that out is the caller's
 * job because the caller is the only one that reads configuration.
 */
export async function startWatchdog(everyMinutes: number, periodChanged: boolean): Promise<void> {
  try {
    await TrackerWatchdog?.start(Math.max(15, Math.round(everyMinutes)), periodChanged);
  } catch {
    /* No module, or the OS refused. The office finds out from the silence:
       `lastRunAgoSeconds` simply never moves, which the team panel reads. */
  }
}

/** Unschedule it. Sign-out only — a check-out sets the flag instead. */
export async function stopWatchdog(): Promise<void> {
  try {
    await TrackerWatchdog?.stop();
  } catch {
    /* Never scheduled, or already gone. Either way there is nothing to stop. */
  }
}

/**
 * Tell the native side whether a day is open, and what it may do about it.
 *
 * THE ONE FACT THIS APP KEEPS IN TWO PLACES, and it is one-directional:
 * JavaScript writes it and the worker reads it, never the other way. It has to
 * be duplicated because everything else the app remembers is in SQLite, which a
 * worker with no JavaScript runtime cannot open — and it is the fact that keeps
 * "not one second either side" true when the thing enforcing it is no longer
 * running.
 */
export async function setTrackingWanted(
  wanted: boolean,
  nudge: boolean,
  nudgeQuietSeconds: number,
): Promise<void> {
  try {
    await TrackerWatchdog?.setTrackingWanted(
      wanted,
      nudge,
      Math.max(0, Math.round(nudgeQuietSeconds)),
    );
  } catch {
    /* A day still opens and still records. The worst case is a watchdog that
       goes on believing yesterday's answer, which costs one wasted wake-up
       every fifteen minutes and never a fix. */
  }
}

/** What happened while JavaScript was not running. Never throws. */
export async function watchdogState(): Promise<WatchdogState> {
  try {
    const raw = await TrackerWatchdog?.state();
    if (!raw) return ABSENT;
    return {
      /* The native side says -1 for "never", which is the same word a negative
         duration would be — and the server refuses a negative rather than
         clamping it, correctly. It is turned into null HERE, at the boundary,
         so nothing downstream has to know that -1 ever meant anything. */
      lastRunAgoSeconds: cannotSay(raw.lastRunAgoSeconds) ? null : raw.lastRunAgoSeconds,
      revivalsToday: cannotSay(raw.revivalsToday) ? null : raw.revivalsToday,
    };
  } catch {
    return ABSENT;
  }
}

function cannotSay(value: unknown): boolean {
  return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
}
