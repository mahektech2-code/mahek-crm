package expo.modules.trackerwatchdog

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.TimeUnit

/**
 * THE BRIDGE BETWEEN THE DAY AND THE WATCHDOG.
 *
 * Four calls, and between them they carry the only two facts the native side
 * cannot work out for itself — whether a day is open, and what the office
 * configured — plus the one fact JavaScript cannot work out for itself, which
 * is what happened while it was not running.
 *
 * **NOTHING HERE EVER REJECTS**, the same rule `phone-setup` states and for the
 * same reason: this runs on handsets whose manufacturers have been most
 * creative with background execution, so "WorkManager threw something we have
 * not seen" is an ordinary Tuesday. A screen that crashes while a salesman is
 * trying to find out why his route has holes in it is worse than one that
 * admits it cannot tell.
 *
 * **IT ANSWERS IN DURATIONS AND NEVER IN INSTANTS.** The office stamps
 * everything on its own clock because a phone's clock is its owner's to set,
 * and the two facts here are ones only this handset holds — so seconds-ago is
 * what crosses, exactly as `backgroundSyncLastRunAgoSeconds` already does. See
 * `lib/mbos/device-state.ts` on the server, which turns them back into instants
 * and refuses a negative rather than clamping it.
 */
class TrackerWatchdogModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("MbosTrackerWatchdog")

    /**
     * Schedule the watchdog. Idempotent — safe on every sign-in, every
     * check-in and every app open, which is how it is called.
     *
     * `KEEP` IS THE ORDINARY ANSWER AND IT IS THE LOAD-BEARING ONE. Replacing
     * periodic work resets its period, so a handset whose app is opened every
     * ten minutes would have the next run pushed out for ever and the watchdog
     * would never once fire — the same shape as a `setInterval` cleared on
     * every resume, arriving in a scheduler that was supposed to be immune to
     * that. The period is only ever allowed to change when the OFFICE changes
     * it, which is what `periodChanged` is for: the caller remembers the number
     * it last used and passes true on the one call that differs. Nothing is
     * inferred here from the value itself, because the enqueued work's period
     * cannot be read back without an async query and the answer would arrive
     * after the decision.
     *
     * FIFTEEN MINUTES IS ANDROID'S FLOOR and is enforced here as well as in the
     * registry. A shorter period is silently rounded up by the OS, so accepting
     * one would leave a number on a settings screen meaning something else on
     * the phone — and this app has already lost three days to a location
     * parameter that was accepted and ignored.
     */
    AsyncFunction("start") { everyMinutes: Int, periodChanged: Boolean ->
      try {
        val minutes = if (everyMinutes < MIN_PERIOD_MINUTES) MIN_PERIOD_MINUTES else everyMinutes.toLong()
        val request = PeriodicWorkRequest.Builder(
          TrackerWatchdogWorker::class.java,
          minutes,
          TimeUnit.MINUTES,
        ).build()

        WorkManager.getInstance(context()).enqueueUniquePeriodicWork(
          WORK_NAME,
          if (periodChanged) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
          request,
        )
        true
      } catch (e: Throwable) {
        /* No WorkManager, or an OEM that refuses to schedule for us. The JS
           watchdog still covers a salesman with the app open, which is most of
           a working day — and the office finds out from the silence, because
           `lastRunAgoSeconds` below simply never moves. */
        false
      }
    }

    /**
     * Stop waking up. Called on sign-out, so a released handset does not go on
     * reviving a tracker for somebody who has left.
     *
     * A CHECK-OUT DOES NOT CALL THIS, and the difference is deliberate: the
     * work stays scheduled and `setTrackingWanted(false)` is what makes each
     * run a no-op. Cancelling and re-enqueueing around every day would mean the
     * one mechanism that survives process death depended on a clean check-out
     * having happened — and a phone that was switched off mid-afternoon is
     * exactly the case it exists for.
     */
    AsyncFunction("stop") {
      try {
        WorkManager.getInstance(context()).cancelUniqueWork(WORK_NAME)
        true
      } catch (e: Throwable) {
        false
      }
    }

    /**
     * Whether a day is open, mirrored into a file a dead process can read.
     *
     * SQLite is where everything else this app remembers lives, and none of it
     * is reachable from a worker with no JavaScript runtime. This is the one
     * duplicated fact, and it is duplicated in one direction only: JavaScript
     * writes, the worker reads, nothing here writes back.
     */
    AsyncFunction("setTrackingWanted") { wanted: Boolean, nudge: Boolean, nudgeQuietSeconds: Int ->
      try {
        val store = WatchdogStore(context())
        store.setTrackingWanted(wanted)
        store.setNudgeEnabled(nudge)
        store.setNudgeQuietMs(nudgeQuietSeconds.toLong() * 1000L)
        true
      } catch (e: Throwable) {
        false
      }
    }

    /**
     * What happened while JavaScript was not running.
     *
     * `lastRunAgoSeconds` is -1 for "this handset has never run the watchdog",
     * which is a real and different answer from "it ran a long time ago" — a
     * fresh install, or an OEM that refused to schedule it at all. The bridge
     * one file over turns that into `null`, because a negative duration is a
     * thing the server explicitly refuses and should never be asked to see.
     */
    AsyncFunction("state") {
      try {
        val store = WatchdogStore(context())
        val now = System.currentTimeMillis()
        val last = store.lastRunAt()
        mapOf(
          "lastRunAgoSeconds" to if (last > 0 && last <= now) ((now - last) / 1000L).toInt() else -1,
          "revivalsToday" to store.revivalsToday(now),
        )
      } catch (e: Throwable) {
        mapOf("lastRunAgoSeconds" to -1, "revivalsToday" to -1)
      }
    }
  }

  private fun context(): Context =
    requireNotNull(appContext.reactContext) { "no application context" }.applicationContext

  private companion object {
    /**
     * ONE named piece of work, so re-enqueueing cannot leave two watchdogs
     * running beside each other — which on this OS would mean two revivals
     * counted for one death and two notifications for one fault.
     */
    private const val WORK_NAME = "mbos-tracker-watchdog"

    private const val MIN_PERIOD_MINUTES = 15L
  }
}
