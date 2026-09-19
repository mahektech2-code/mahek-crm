package expo.modules.locationservice

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * RESTART LAYER TWO: the OS wakes us up to check.
 *
 * `START_STICKY` covers the service being killed for memory. It does not cover
 * a battery manager force-stopping the package, which takes the sticky promise
 * with it — and on the handsets in this field force that is the ordinary case
 * rather than the exotic one. WorkManager is the only scheduler Android
 * guarantees across process death, so this is a `Worker`.
 *
 * **IT IS NOT ENOUGH ON ITS OWN, AND SAYING SO IS THE POINT.** The same OEMs
 * suppress WorkManager: measured on these phones, `expo-background-task` is
 * registered on all three modern handsets and has gone as long as **15.8
 * hours** between runs. A watchdog whose own cadence an OEM can stretch to
 * most of a working day cannot be the mechanism the day depends on. It is a
 * SAFETY NET under `START_STICKY`, and the thing it is a net for — a service
 * that holds itself up once started — is the layer that actually carries the
 * weight.
 *
 * **IT DOES ONE THING.** It starts the service if the office wants tracking.
 * It does not read the trail, does not judge whether the phone is behaving,
 * does not notify. The judging is the office's, off
 * `location_service_last_fix_at`, which is a better instrument than a verdict
 * computed on a phone whose whole problem is that it cannot run code.
 *
 * **IT ALWAYS ANSWERS `Result.success()`**, for the reason the watchdog next
 * door gives: a retry would re-enqueue a one-off copy of periodic work and buy
 * nothing, and a failure leaves the periodic chain marked failed on some
 * WorkManager versions, which is the one outcome that would stop the net for
 * good.
 */
class LocationServiceWorker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {

  override fun doWork(): Result {
    try {
      val store = FixStore.of(applicationContext)
      val now = System.currentTimeMillis()
      if (!store.wanted(now)) return Result.success()

      /* ASKED EVEN WHEN IT LOOKS UP. `isRunning` is per-process and this
         worker may be running in a process the service is not in — and where
         it IS up, a fresh `onStartCommand` re-asks the provider, which is
         exactly the repair for the other failure mode: a live service whose
         fused callback has gone quiet. */
      val started = ServiceLauncher.launch(applicationContext, ServiceLauncher.REASON_WATCHDOG)

      /*
       * THE REFUSAL IS THE INTERESTING CASE, AND IT HAS ITS OWN WAY OUT.
       *
       * A plain periodic worker is not one of Android 12's exempt moments, so
       * on a phone with no battery exemption this start is refused with
       * `ForegroundServiceStartNotAllowedException`. Expedited work IS exempt:
       * WorkManager puts it on the temporary power allowlist. Periodic work
       * cannot be expedited — `PeriodicWorkRequest.Builder` has no
       * `setExpedited` — so the refusal is answered by enqueueing a ONE-OFF
       * expedited request, which is the only shape that gets the exemption.
       *
       * `RUN_AS_NON_EXPEDITED_WORK_REQUEST` rather than `DROP_WORK_REQUEST`
       * when the app's expedited quota is spent: a non-expedited retry will
       * probably be refused too, and it costs nothing, where dropping means
       * this quarter-hour buys nothing at all.
       */
      if (!started) enqueueRetry(applicationContext)
    } catch (e: Throwable) {
      /* Caught and dropped. A watchdog is not allowed to cost a day, and
         whatever could not be done here is tried again on the next period. */
    }
    return Result.success()
  }

  companion object {
    /**
     * ONE named piece of periodic work, so re-enqueueing cannot leave two
     * watchdogs beside each other — which would be two services started for
     * one death and twice the count on the office's screen.
     *
     * The name is this module's own and deliberately not `tracker-watchdog`'s:
     * the two are different jobs and one must not silently replace the other
     * on a build that carries both.
     */
    private const val WORK_NAME = "mbos-location-service-watchdog"
    private const val RETRY_NAME = "mbos-location-service-retry"

    /**
     * FIFTEEN MINUTES IS ANDROID'S FLOOR and is enforced here as well as in
     * the registry. A shorter period is silently rounded up by the OS, so
     * accepting one would leave a number on a settings screen meaning
     * something else on the phone — and this app has already lost three days
     * to a location parameter that was accepted and ignored.
     */
    private const val MIN_PERIOD_MINUTES = 15L

    /**
     * Schedule it. Idempotent, and safe on every sign-in, check-in and app
     * open, which is how it is called.
     *
     * `KEEP` IS THE LOAD-BEARING ARGUMENT. Replacing periodic work resets its
     * period, so a handset whose app is opened every ten minutes would have
     * the next run pushed out for ever and the watchdog would never once fire
     * — a `setInterval` cleared on every resume, arriving inside the one
     * scheduler that was supposed to be immune to that. The period changes
     * only when the OFFICE changes it, which is what `periodChanged` is for:
     * the caller remembers the number it last used and passes true on the one
     * call that differs. Nothing is inferred from the value here, because the
     * enqueued period cannot be read back without an async query whose answer
     * would arrive after the decision.
     */
    fun schedule(context: Context, everyMinutes: Int, periodChanged: Boolean): Boolean =
      try {
        val minutes =
          if (everyMinutes < MIN_PERIOD_MINUTES) MIN_PERIOD_MINUTES else everyMinutes.toLong()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
          WORK_NAME,
          if (periodChanged) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
          PeriodicWorkRequest.Builder(
            LocationServiceWorker::class.java,
            minutes,
            TimeUnit.MINUTES,
          ).build(),
        )
        true
      } catch (e: Throwable) {
        /* No WorkManager, or an OEM refusing to schedule for us. The service's
           own `START_STICKY` still covers a memory kill and the boot receiver
           still covers a reboot; the office finds out from the silence,
           because nothing here will ever move the marks it reads. */
        false
      }

    /**
     * Stop waking up. Called on SIGN-OUT and never on a check-out.
     *
     * The difference is deliberate and is the same one `tracker-watchdog`
     * records: the work stays scheduled all night and `setWanted(false)` is
     * what makes each run a no-op. Cancelling around every day would make the
     * one mechanism that survives process death depend on a clean check-out
     * having happened — and a phone switched off mid-afternoon is exactly the
     * case it exists for.
     */
    fun cancel(context: Context): Boolean =
      try {
        WorkManager.getInstance(context.applicationContext).cancelUniqueWork(WORK_NAME)
        true
      } catch (e: Throwable) {
        false
      }

    private fun enqueueRetry(context: Context) {
      try {
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
          RETRY_NAME,
          ExistingWorkPolicy.REPLACE,
          OneTimeWorkRequest.Builder(ExpeditedStartWorker::class.java)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build(),
        )
      } catch (e: Throwable) {
        /* Nothing more to try this period. */
      }
    }
  }
}

/**
 * The same start, from the one state WorkManager can put us in that the
 * platform accepts.
 *
 * It is a separate class rather than a flag on the worker above because
 * `setExpedited` belongs to `OneTimeWorkRequest` and nothing else, and because
 * the two answer different questions: that one is "is the service up", this
 * one is "the platform refused us, try from the allowlist". Keeping them apart
 * is also what keeps the refusal count honest — a retry that failed is one
 * refusal with two attempts behind it, not two faults.
 */
class ExpeditedStartWorker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {

  override fun doWork(): Result {
    try {
      ServiceLauncher.launch(applicationContext, ServiceLauncher.REASON_EXPEDITED)
    } catch (e: Throwable) {
      /* As above: never allowed to cost anything. */
    }
    return Result.success()
  }
}
