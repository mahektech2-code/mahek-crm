package expo.modules.locationservice

import android.content.Context
import android.os.Build
import android.util.Log

/**
 * THE ONE PLACE A SERVICE IS STARTED, and the one place Android 12's
 * restriction is reasoned about.
 *
 * Four callers want the service up — the bridge on check-in, the periodic
 * worker, the boot receiver and the app coming forward — and they are in four
 * completely different execution states as far as the platform is concerned.
 * A second `startForegroundService` call site is how the exception below comes
 * to be caught in three places and swallowed in the fourth.
 *
 * **WHAT THE RESTRICTION ACTUALLY IS.** From API 31, an app in the background
 * may not start a foreground service at all: `startForegroundService` throws
 * `ForegroundServiceStartNotAllowedException`. There is a list of exempt
 * moments, and three of them are the three restart layers this module has:
 *
 *  - the app has a visible Activity (the bridge, every time a salesman is
 *    looking at the phone);
 *  - the app is handling `BOOT_COMPLETED` or `MY_PACKAGE_REPLACED` (the
 *    receiver — the broadcast itself is the exemption);
 *  - the app is on the power allowlist, which is what
 *    `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` buys and what `phone-setup` already
 *    offers the salesman in one tap.
 *
 * **AND THE ONE THAT IS NOT EXEMPT IS THE ORDINARY PERIODIC WORKER**, which is
 * the layer that has to work on a phone nobody has configured. A plain
 * `Worker` runs with the app in a background process state and gets no
 * exemption. An EXPEDITED one does: WorkManager puts expedited work on the
 * temporary power allowlist, and being on that allowlist is an exemption. A
 * `PeriodicWorkRequest` cannot be expedited — the API refuses it — so the
 * periodic worker tries a plain start, and where the platform refuses it
 * enqueues a one-off expedited request that tries again from a state the
 * platform allows. That is why `LocationServiceWorker` exists twice over.
 *
 * **IT IS NOT GUESSWORK ABOUT WHICH CASE WE ARE IN.** Deciding in advance
 * whether this particular moment is exempt would mean modelling a policy that
 * differs by OEM and by OS version. Starting it and catching the refusal asks
 * the only question that matters and cannot be lied to — the same argument
 * `phone-setup` makes about `resolveActivity` and the autostart screens.
 *
 * **A REFUSAL IS RECORDED, NEVER SWALLOWED.** It is a completely different
 * support call from a battery manager killing a running service: nothing is
 * being killed, the platform is working as designed on a phone that has not
 * been given the exemption. The office can only tell those apart if the phone
 * says which happened.
 */
internal object ServiceLauncher {

  /** Whether the service is now believed to be starting. */
  fun launch(context: Context, reason: String): Boolean {
    val app = context.applicationContext
    val store = FixStore.of(app)
    val now = System.currentTimeMillis()

    if (!store.wanted(now)) return false

    /* Already up. `startForegroundService` on a running service is a fresh
       `onStartCommand`, which is harmless and re-asks the provider — worth
       doing from the watchdog, which is checking for exactly the case where
       the provider has gone quiet, and pointless from four callers a minute. */
    if (MbosLocationService.isRunning() && reason == REASON_APP) return true

    return try {
      val intent = MbosLocationService.intent(app)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        app.startForegroundService(intent)
      } else {
        app.startService(intent)
      }
      true
    } catch (e: Throwable) {
      /*
       * `ForegroundServiceStartNotAllowedException` is API 31 and is a
       * subclass of IllegalStateException, so it is caught here by its
       * behaviour rather than by its name — referring to the class directly
       * would need an API guard around a catch block, which Kotlin cannot
       * express cleanly, and the handling is identical for every failure:
       * write down that it happened and let the next layer try.
       *
       * The class name IS recorded, because "not allowed from background" and
       * "the service class is missing" are different faults and the office
       * should not have to guess which.
       */
      store.recordRefusal(now, "${reason}:${e.javaClass.simpleName}")
      Log.w(TAG, "could not start the location service ($reason): ${e.javaClass.simpleName}")
      false
    }
  }

  fun stop(context: Context) {
    try {
      context.applicationContext.stopService(MbosLocationService.intent(context))
    } catch (e: Throwable) {
      /* It was not running. Nothing to do and nothing to say. */
    }
  }

  const val REASON_APP = "app"
  const val REASON_BOOT = "boot"
  const val REASON_WATCHDOG = "watchdog"
  const val REASON_EXPEDITED = "expedited"

  private const val TAG = "MbosLocationService"
}
