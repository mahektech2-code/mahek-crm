package expo.modules.trackerwatchdog

import android.content.Context
import android.content.SharedPreferences
import java.util.Calendar

/**
 * WHAT THE WATCHDOG KNOWS, KEPT WHERE A DEAD PROCESS CAN STILL READ IT.
 *
 * Everything else this app remembers is in SQLite, and none of it is reachable
 * from here: the worker runs with no JavaScript runtime — that is the whole
 * point of it — and expo-sqlite's database is opened by the bundle. So the two
 * facts the worker needs, and the four it produces, live in SharedPreferences,
 * which is a file the OS hands back the moment the process exists.
 *
 * IT IS NOT A SECOND COPY OF ANYTHING. The JS side owns "is a day open" and
 * mirrors it here in one call at each end of the day; the worker owns "when did
 * I last run" and "how many times have I had to revive this", which nothing in
 * JavaScript can observe, because the observation is that the JavaScript was
 * not running.
 *
 * THE DAY IS A LOCAL CALENDAR DATE, computed with `Calendar` rather than
 * `java.time`. minSdk here is 24 and `LocalDate` needs core library desugaring,
 * which is an app-level build setting this module must not quietly depend on —
 * and the failure mode of getting that wrong is a `NoClassDefFoundError` inside
 * a background worker, which is precisely the kind of silence this module
 * exists to end.
 */
internal class WatchdogStore(context: Context) {

  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

  /**
   * Does the office want this handset tracking right now?
   *
   * Written by `trail.ts` at both ends of a day and read here on every run.
   * DEFAULTS TO FALSE, and that direction is deliberate: the cost of being
   * wrong one way is a watchdog that does nothing on a phone which has never
   * checked in, and the cost the other way is a handset that revives its
   * tracker on an evening nobody agreed to be followed on. "Not one second
   * either side" is the rule the whole trail is built on, and a default is
   * exactly where a rule like that gets lost.
   */
  fun trackingWanted(): Boolean = prefs.getBoolean(TRACKING_WANTED, false)

  fun setTrackingWanted(wanted: Boolean) {
    prefs.edit().putBoolean(TRACKING_WANTED, wanted).apply()
  }

  /** Whether the salesman should be told when his tracker has had to be revived. */
  fun nudgeEnabled(): Boolean = prefs.getBoolean(NUDGE_ENABLED, true)

  fun setNudgeEnabled(enabled: Boolean) {
    prefs.edit().putBoolean(NUDGE_ENABLED, enabled).apply()
  }

  /**
   * The worker ran. Recorded FIRST, before anything it might do.
   *
   * The same discipline `background-sync-task.ts` keeps for its own mark: the
   * point of this one is "the OS woke us", which is true the moment we are
   * executing. Stamping it afterwards would make a run that threw read as a run
   * that never happened, and those two send somebody to look in completely
   * different places.
   */
  fun recordRun(nowMs: Long) {
    prefs.edit().putLong(LAST_RUN_AT, nowMs).apply()
  }

  fun lastRunAt(): Long = prefs.getLong(LAST_RUN_AT, 0L)

  /**
   * The tracker was found dead and put back. Counted per LOCAL calendar day.
   *
   * Overnight is when a phone is charged and when an OEM battery manager's own
   * bookkeeping resets, so yesterday's six revivals say nothing about this
   * morning — the same reasoning `engines/tracker-restart.ts` gives for rolling
   * its own count over, and the two counts are added together on the way to the
   * office because a manager is asking one question: how much reviving has this
   * phone needed today.
   */
  fun recordRevival(nowMs: Long) {
    val today = localDay(nowMs)
    val count = if (prefs.getString(REVIVALS_DAY, null) == today) prefs.getInt(REVIVALS, 0) else 0
    prefs.edit()
      .putString(REVIVALS_DAY, today)
      .putInt(REVIVALS, count + 1)
      .apply()
  }

  /** Revivals on the day `nowMs` falls in; a stored count from another day is 0. */
  fun revivalsToday(nowMs: Long): Int {
    if (prefs.getString(REVIVALS_DAY, null) != localDay(nowMs)) return 0
    return prefs.getInt(REVIVALS, 0)
  }

  /**
   * When the salesman was last told to open the app, so he is not told again
   * inside the same stretch of trouble.
   *
   * A notification that repeats every fifteen minutes is one somebody turns
   * off, and an app whose notifications are off is an app that cannot tell him
   * the thing that matters next week.
   */
  fun lastNudgeAt(): Long = prefs.getLong(LAST_NUDGE_AT, 0L)

  fun recordNudge(nowMs: Long) {
    prefs.edit().putLong(LAST_NUDGE_AT, nowMs).apply()
  }

  /** How long a revival stands before the salesman is told again. */
  fun nudgeQuietMs(): Long = prefs.getLong(NUDGE_QUIET_MS, DEFAULT_NUDGE_QUIET_MS)

  fun setNudgeQuietMs(ms: Long) {
    prefs.edit().putLong(NUDGE_QUIET_MS, ms).apply()
  }

  private fun localDay(atMs: Long): String {
    val c = Calendar.getInstance()
    c.timeInMillis = atMs
    // yyyy-MM-dd by hand rather than through SimpleDateFormat, which is not
    // thread safe and would be a shared instance on a worker thread.
    return String.format(
      "%04d-%02d-%02d",
      c.get(Calendar.YEAR),
      c.get(Calendar.MONTH) + 1,
      c.get(Calendar.DAY_OF_MONTH),
    )
  }

  companion object {
    private const val NAME = "MbosTrackerWatchdog"

    private const val TRACKING_WANTED = "trackingWanted"
    private const val NUDGE_ENABLED = "nudgeEnabled"
    private const val NUDGE_QUIET_MS = "nudgeQuietMs"
    private const val LAST_RUN_AT = "lastRunAt"
    private const val LAST_NUDGE_AT = "lastNudgeAt"
    private const val REVIVALS = "revivals"
    private const val REVIVALS_DAY = "revivalsDay"

    /**
     * Thirty minutes, and it is the ONE number in this module that is not
     * configuration.
     *
     * Everything a manager might tune reaches here from `app_settings` through
     * the JS bridge, and this is what stands in the window between a fresh
     * install and its first pull — the same job `data/config.ts`'s own
     * `DEFAULTS` do on the other side of the bridge, and stated for the same
     * reason: a salesman whose phone has never synced still has to be told when
     * his route has stopped recording.
     */
    private const val DEFAULT_NUDGE_QUIET_MS = 30L * 60L * 1000L
  }
}
