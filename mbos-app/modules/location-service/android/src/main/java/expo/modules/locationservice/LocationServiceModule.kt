package expo.modules.locationservice

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * THE BRIDGE, AND NOTHING ELSE.
 *
 * Six calls. Between them they carry the only facts the native side cannot
 * work out for itself — whether a day is open and what the office configured —
 * and the one fact JavaScript cannot work out for itself, which is what
 * happened while it was not running.
 *
 * **NOTHING HERE EVER REJECTS**, the rule `phone-setup` states and the reason
 * is the same: this runs on handsets whose manufacturers have been most
 * creative with background execution, so "the platform threw something we have
 * not seen" is an ordinary Tuesday. A screen that crashes while a salesman is
 * trying to find out why his route has holes in it is worse than one that
 * admits it cannot tell. Every function answers a value; none of them signals
 * by throwing.
 *
 * **IT ANSWERS IN DURATIONS AND NEVER IN INSTANTS**, for `lastFixAt` and
 * `lastRefusalAt`. The office stamps everything on its own clock because a
 * phone's clock is its owner's to set, and these are facts only this handset
 * holds — so seconds-ago is what crosses, exactly as
 * `backgroundSyncLastRunAgoSeconds` already does, and `lib/mbos/device-state.ts`
 * turns them back into instants and refuses a negative rather than clamping it.
 *
 * **THE DRAIN IS TWO-PHASE**, and `FixStore` carries the argument for why.
 * Reading does not delete; JavaScript deletes once the rows are in `positions`.
 */
class LocationServiceModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("MbosLocationService")

    /**
     * Start following, and say for how long.
     *
     * Every parameter is written into preferences before the service is
     * touched, because the service may be started next by a boot receiver that
     * has no idea any of these numbers exist. `start` is the only thing that
     * ever writes them.
     *
     * `wantedForSeconds` IS THE PRIVACY DEADLINE and not a convenience. See
     * `FixStore.setWanted`: a boolean alone cannot end a day that had no
     * check-out, and a phone switched off at four and turned on at eleven
     * would otherwise follow its owner home. JavaScript pushes it forward
     * whenever it is alive and the day is open.
     *
     * It is safe to call repeatedly — on check-in, on resume, on a cold start
     * with the day already open — and it is meant to be, because a repeat is
     * also how the configured numbers reach a handset that pulled new ones
     * this morning.
     */
    AsyncFunction("start") {
      askEverySeconds: Int,
      keepEverySeconds: Int,
      bufferCap: Int,
      wantedForSeconds: Int,
      watchdogMinutes: Int,
      periodChanged: Boolean,
      ->
      try {
        val store = FixStore.of(context())
        store.setCapture(
          askEveryMs = seconds(askEverySeconds, FLOOR_SECONDS),
          keepEveryMs = seconds(keepEverySeconds, FLOOR_SECONDS),
          bufferCap = if (bufferCap < 1) 1 else bufferCap,
        )
        store.setWanted(
          wanted = true,
          untilMs = System.currentTimeMillis() + seconds(wantedForSeconds, 1),
        )
        LocationServiceWorker.schedule(context(), watchdogMinutes, periodChanged)
        ServiceLauncher.launch(context(), ServiceLauncher.REASON_APP)
      } catch (e: Throwable) {
        false
      }
    }

    /**
     * The day is still open — push the deadline out.
     *
     * Cheap on purpose: one preferences write and no service call, so it can
     * ride every sync pass and every app resume without anybody having to
     * think about what it costs. It does NOT start the service, because the
     * question "should this be running" is answered by the watchdog and by
     * `start`, and a third answer would be a third thing to keep in step.
     */
    AsyncFunction("touch") { wantedForSeconds: Int ->
      try {
        FixStore.of(context()).setWanted(
          wanted = true,
          untilMs = System.currentTimeMillis() + seconds(wantedForSeconds, 1),
        )
        true
      } catch (e: Throwable) {
        false
      }
    }

    /**
     * The check-out. The one honest end of a day.
     *
     * The deadline is cleared FIRST and the service stopped second, so that a
     * stop the platform refuses still leaves a service which will stop itself
     * on its next fix — `record` reads `wanted` on every one. Stopping first
     * and clearing second would leave exactly the opposite: a cleared flag and
     * a service nobody told.
     *
     * THE WATCHDOG IS LEFT SCHEDULED. It reads the same flag and becomes a
     * no-op; cancelling it around every day would make the one mechanism that
     * survives process death depend on a clean check-out having happened.
     */
    AsyncFunction("stop") {
      try {
        FixStore.of(context()).setWanted(wanted = false, untilMs = 0L)
        ServiceLauncher.stop(context())
        true
      } catch (e: Throwable) {
        false
      }
    }

    /**
     * Sign-out: stop, and stop waking up as well.
     *
     * A released handset must not go on reviving a tracker for somebody who
     * has left the company, and the periodic work would otherwise outlive the
     * account by as long as the app stays installed.
     */
    AsyncFunction("release") {
      try {
        FixStore.of(context()).setWanted(wanted = false, untilMs = 0L)
        ServiceLauncher.stop(context())
        LocationServiceWorker.cancel(context())
        true
      } catch (e: Throwable) {
        false
      }
    }

    /**
     * WHAT HAPPENED WHILE JAVASCRIPT WAS NOT RUNNING.
     *
     * `-1` means "this handset has nothing to say", which is a real and
     * different answer from a large number: a fresh install, or a phone on
     * which the service has never once started. The wrapper one file over
     * turns it into `null`, because a negative duration is a thing the server
     * explicitly refuses and should never be asked to see.
     */
    AsyncFunction("state") {
      try {
        val store = FixStore.of(context())
        val now = System.currentTimeMillis()
        val lastFix = store.lastFixAt()
        val lastRefusal = store.lastRefusalAt()
        mapOf(
          "running" to store.running(),
          "wanted" to store.wanted(now),
          "lastFixAgoSeconds" to ago(lastFix, now),
          "buffered" to store.buffered(),
          "startsToday" to store.startsToday(now),
          "lastRefusalAgoSeconds" to ago(lastRefusal, now),
          "lastRefusal" to store.lastRefusal(),
        )
      } catch (e: Throwable) {
        /* The same shape with nothing in it. A caller reading a missing key as
           "cannot say" is right; a caller handed a rejection has to invent
           what to draw. */
        mapOf(
          "running" to false,
          "wanted" to false,
          "lastFixAgoSeconds" to -1,
          "buffered" to -1,
          "startsToday" to -1,
          "lastRefusalAgoSeconds" to -1,
          "lastRefusal" to null,
        )
      }
    }

    /** Rows for `positions`, oldest first. Reading deletes nothing. */
    AsyncFunction("drain") { limit: Int ->
      try {
        FixStore.of(context()).drain(if (limit < 1) 1 else limit)
      } catch (e: Throwable) {
        emptyList<Map<String, Any?>>()
      }
    }

    /** These reached `positions`; they may go. The second half of the drain. */
    AsyncFunction("forget") { ids: List<String> ->
      try {
        FixStore.of(context()).forget(ids)
        true
      } catch (e: Throwable) {
        false
      }
    }
  }

  private fun context(): Context =
    requireNotNull(appContext.reactContext) { "no application context" }.applicationContext

  /**
   * Seconds to milliseconds, with a floor.
   *
   * The floor is here and in `registry.ts` and in `data/config.ts`, and that
   * is not belt and braces — it is the lesson of `timeInterval`. A number that
   * arrives across a bridge is a number somebody could have got wrong, and a
   * zero interval handed to `LocationRequest` is a request for every fix the
   * chip can produce, which on a field day is a flat battery by eleven.
   */
  private fun seconds(value: Int, floor: Int): Long =
    (if (value < floor) floor else value).toLong() * 1_000L

  private fun ago(atMs: Long, nowMs: Long): Int =
    if (atMs > 0L && atMs <= nowMs) ((nowMs - atMs) / 1000L).toInt() else -1

  private companion object {
    /** The same floor `mbos.location.trackEverySeconds` states. */
    const val FLOOR_SECONDS = 3
  }
}
