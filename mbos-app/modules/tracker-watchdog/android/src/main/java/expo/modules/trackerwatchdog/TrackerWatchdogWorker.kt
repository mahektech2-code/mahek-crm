package expo.modules.trackerwatchdog

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.atomic.AtomicBoolean

/**
 * THE ONE PIECE OF THIS APP THAT STILL RUNS AFTER THE APP HAS BEEN KILLED.
 *
 * Everything else that watches the trail is a JavaScript timer.
 * `sync/trail.ts`'s watchdog is a `setInterval`; so is the sync engine's retry;
 * so is the foreground floor those two fall back to. A JavaScript timer stops
 * the instant the app leaves the screen, which is exactly the instant the
 * tracker needs watching — and when an OEM battery manager reaps the process
 * there is no timer, no bundle and no runtime left at all. Nothing in this app
 * could notice that, because noticing it required being alive.
 *
 * WorkManager is the only scheduler Android guarantees across process death, so
 * this is a `Worker` and not a task, a timer or a service. It is deliberately
 * NOT the `expo-background-task` job beside it: that one exists to drain the
 * sync queue, it runs by booting the whole JavaScript bundle, and every
 * mechanism that has failed in the field so far has failed by being JavaScript
 * that was not running. This one touches no bundle.
 *
 * WHAT IT DOES IS SMALL, AND THE SMALLNESS IS THE POINT — three cheap things,
 * each of which either works or is caught:
 *
 *   1. It writes down that it ran. That alone answers a question nothing could
 *      answer before: whether this handset is still being woken at all. A phone
 *      whose watchdog has itself gone quiet for hours is a phone whose
 *      manufacturer has stopped honouring WorkManager, which is a different
 *      support call from every other one on the panel.
 *
 *   2. If a day is open and this is the first run in a fresh process, it asks
 *      `expo-task-manager` to restore its persisted tasks — see `TaskRestore`.
 *
 *   3. It tells the salesman, once per quiet window, that his route stopped and
 *      the app needs opening. Opening it is the only thing that puts the dense
 *      trail back, and it was already what happened by accident.
 *
 * **A COLD PROCESS WITH A DAY OPEN IS THE EVIDENCE THE TRACKER DIED**, and it
 * is worth being explicit about why that inference is sound rather than
 * convenient. While the real tracker is running, expo-location holds a
 * foreground service, and a foreground service is precisely what stops Android
 * reaping a process. So if this worker finds itself the first thing to run in a
 * process while the office wanted tracking, that service was not holding
 * anything up: either it was killed, or the app was never started today. Both
 * are cases where the restore is the right move and the salesman wants telling.
 *
 * The flag is an `AtomicBoolean` in a companion object, which is per-CLASS and
 * therefore per-PROCESS: it is created when the class is first loaded and dies
 * with the process, which is exactly the lifetime of the question being asked.
 *
 * **IT ALWAYS ANSWERS `Result.success()`.** A retry would re-enqueue a one-off
 * copy of periodic work and buy nothing — the next period is fifteen minutes
 * away whatever happens here — and a failure would leave the periodic chain
 * marked failed on some WorkManager versions, which is the one outcome that
 * would stop the watchdog for good.
 */
class TrackerWatchdogWorker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {

  override fun doWork(): Result {
    val store = WatchdogStore(applicationContext)
    val now = System.currentTimeMillis()

    /* FIRST, before anything that might throw. See `recordRun`: the point of
       this mark is that the OS woke us, which is true the moment we execute. */
    store.recordRun(now)

    val firstInThisProcess = COLD.compareAndSet(true, false)

    try {
      /* The day is closed, or nobody has ever checked in on this handset.
         Nothing here may start tracking on an evening nobody agreed to be
         followed on — "not one second either side" is the rule the trail is
         built on, and a watchdog is exactly where such a rule gets lost. */
      if (!store.trackingWanted()) return Result.success()

      /* ASKED UNCONDITIONALLY, because in a warm process it costs nothing.
         `TaskService`'s constructor restores only where the process has no task
         map yet, so on a live app this is an allocation and a return — while on
         a process the OS has just rebuilt it is the whole restart. Gating it on
         the flag below would mean reasoning correctly about which kind of
         process this is in order to skip a call that is free in one of them,
         and getting that reasoning wrong is how the tracker stays dead. */
      TaskRestore.ensure(applicationContext)

      /* The process was already up, so this is not evidence of anything: the
         app is alive, its own watchdog is the better-placed of the two — it can
         read the trail's marks and, while an Activity is in front, it is the
         only one that can put the DENSE tracker back at all — and counting a
         revival here would report a phone as having been revived every fifteen
         minutes of a day it spent working perfectly. */
      if (!firstInThisProcess) return Result.success()

      store.recordRevival(now)

      if (store.nudgeEnabled() && now - store.lastNudgeAt() >= store.nudgeQuietMs()) {
        Nudge.post(applicationContext)
        store.recordNudge(now)
      }
    } catch (e: Throwable) {
      /* Caught and dropped, deliberately. The liveness mark is already written,
         which is the half of this run the office reads; whatever could not be
         done here is tried again in fifteen minutes. A watchdog is not allowed
         to cost a day. */
    }

    return Result.success()
  }

  private companion object {
    /**
     * True until the first run of this worker in this process.
     *
     * A clock in JavaScript could not answer this and neither could a stored
     * timestamp: what is being asked is not "how long since something
     * happened" but "was this process already up", and only something that
     * dies with the process can say.
     */
    private val COLD = AtomicBoolean(true)
  }
}
