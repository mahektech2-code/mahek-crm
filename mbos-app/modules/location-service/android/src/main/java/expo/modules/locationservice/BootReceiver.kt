package expo.modules.locationservice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * RESTART LAYER THREE: the phone was switched off, or the app was replaced.
 *
 * A reboot kills every process and cancels every sticky service promise. Left
 * alone, a salesman who restarts his phone at lunchtime records nothing for the
 * rest of the day, and there is no cue anywhere that anything happened — the
 * day is still open, the app still says he is checked in, and the trail simply
 * stops. `MY_PACKAGE_REPLACED` is the same fact after an update rather than a
 * reboot, and this app is sideloaded over the top of a running one on working
 * phones, so that is not the rare half.
 *
 * **THE BROADCAST IS ITSELF THE EXEMPTION**, which is why this layer works
 * where the periodic worker sometimes cannot. Handling `BOOT_COMPLETED` is one
 * of the moments Android 12 allows a foreground service to be started from the
 * background — so this is not merely permitted to run, it is one of the few
 * states a cold process is allowed to put the service back from.
 *
 * **IT STARTS NOTHING ON A CLOSED DAY.** `ServiceLauncher` reads the deadline
 * first, so a phone rebooted at eleven at night starts no tracker: "not one
 * second either side" is the rule the whole trail rests on, and a boot receiver
 * is precisely where such a rule gets lost.
 *
 * **NO PERMISSION IS DECLARED FOR THIS**, and that is verified rather than
 * assumed: `androidx.work:work-runtime` declares `RECEIVE_BOOT_COMPLETED` in
 * its own manifest and has been merged into this app since `expo-background-
 * task` was added. See this module's AndroidManifest for the whole of it.
 *
 * It does the smallest possible amount of work, synchronously, and returns.
 * A receiver gets about ten seconds before the system considers it hung, and
 * everything this needs — a preferences read and an intent — is measured in
 * microseconds. There is deliberately no `goAsync`: an asynchronous receiver
 * that outlives its broadcast is a second lifetime to get wrong.
 */
class BootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent?) {
    try {
      when (intent?.action) {
        Intent.ACTION_BOOT_COMPLETED,
        Intent.ACTION_MY_PACKAGE_REPLACED,
        QUICKBOOT,
        -> ServiceLauncher.launch(context, ServiceLauncher.REASON_BOOT)
        else -> {
          /* Something else was delivered to us. Doing nothing is the answer:
             this receiver has exactly three reasons to exist and a fourth
             action is a manifest change nobody made. */
        }
      }
    } catch (e: Throwable) {
      /* A receiver that throws on boot is a crash dialog on a salesman's phone
         the moment he turns it on, which is the worst possible first thing to
         see and buys nothing — the watchdog will start the service within the
         quarter hour either way. */
    }
  }

  private companion object {
    /** HTC's and several Chinese ROMs' own spelling of a boot broadcast. */
    const val QUICKBOOT = "android.intent.action.QUICKBOOT_POWERON"
  }
}
