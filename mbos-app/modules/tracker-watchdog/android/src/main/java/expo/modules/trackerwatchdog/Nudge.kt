package expo.modules.trackerwatchdog

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Log

/**
 * TELLING THE SALESMAN THE ONE THING THAT ACTUALLY FIXES IT.
 *
 * The evidence from the field is that a stopped trail comes back when somebody
 * opens the app — many short silences and then a burst, over and over, all day.
 * That is not a coincidence and it is not luck: opening the app is what puts an
 * Activity in front, which is the only condition under which expo-location will
 * start its foreground service, which is the only thing that makes the trail
 * dense again. `TaskRestore` gets throttled background deliveries back without
 * anybody touching the phone; this is what gets the rest back.
 *
 * So the recovery that was already happening by accident is made deliberate.
 * The alternative on the table was to leave it to chance, which is the version
 * that lost 523 minutes of one salesman's route in a single day.
 *
 * **IT IS QUIET BY DESIGN.** One notification, replaced rather than stacked,
 * and not again inside the configured quiet window — a notification that
 * repeats every fifteen minutes is one somebody switches off, and an app whose
 * notifications are off is an app that cannot tell him the thing that matters
 * next week. Where the office has turned the nudge off entirely, nothing is
 * drawn at all; that is the same rule the microphone follows, and the reason is
 * the same: a control that fails when pressed is worse than one never offered.
 *
 * **NOTHING HERE MAY THROW.** It runs inside a background worker on handsets
 * whose manufacturers have been most creative with the notification stack, and
 * a watchdog that crashes on the way to reporting a fault is a watchdog that
 * reports nothing. A refused POST_NOTIFICATIONS is not even a failure — the
 * platform drops the post silently — which is the right outcome: the revival
 * still happened and is still counted, and the office still sees it.
 */
internal object Nudge {

  fun post(context: Context) {
    try {
      val app = context.applicationContext
      val manager =
        app.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        /* IMPORTANCE_DEFAULT rather than HIGH. This is worth a sound and a
           place in the shade; it is not worth a heads-up banner over whatever
           the salesman is doing, because the thing being asked for can wait the
           minute until he next looks at the phone. */
        val channel = NotificationChannel(
          CHANNEL_ID,
          "Route recording",
          NotificationManager.IMPORTANCE_DEFAULT,
        )
        channel.description =
          "Tells you when your phone has stopped recording your route and MahekOne needs opening."
        manager.createNotificationChannel(channel)
      }

      val launch = app.packageManager.getLaunchIntentForPackage(app.packageName) ?: return
      /* FLAG_IMMUTABLE is required from API 31 and is correct on every version:
         nothing downstream fills anything into this intent. */
      val flags =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
          PendingIntent.FLAG_UPDATE_CURRENT
        }
      val pending = PendingIntent.getActivity(app, 0, launch, flags)

      /* The app's own icon rather than a drawable of this module's, because a
         local expo module has no resource merging of its own worth setting up
         for one image — and an icon that fails to resolve is a crash inside
         NotificationManager, which is the one place this must not happen. */
      val icon = app.applicationInfo.icon

      val builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Notification.Builder(app, CHANNEL_ID)
        } else {
          @Suppress("DEPRECATION")
          Notification.Builder(app)
        }

      val notification = builder
        .setSmallIcon(icon)
        .setContentTitle("Your route stopped recording")
        .setContentText("Open MahekOne to start it again.")
        .setStyle(
          Notification.BigTextStyle().bigText(
            "Your phone stopped MahekOne recording your route. Open the app once and it " +
              "starts again — your day is safe on the phone either way.",
          ),
        )
        .setContentIntent(pending)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .build()

      /* ONE id, so a second nudge REPLACES the first rather than stacking
         beside it. A shade with four copies of the same sentence is a shade
         somebody clears without reading. */
      manager.notify(NOTIFICATION_ID, notification)
    } catch (e: Throwable) {
      Log.w(TAG, "could not post the tracker nudge: ${e.javaClass.simpleName}")
    }
  }

  private const val TAG = "MbosTrackerWatchdog"
  private const val CHANNEL_ID = "mbos-route-recording"

  /** Arbitrary and fixed. Fixed is the part that matters — see `notify` above. */
  private const val NOTIFICATION_ID = 8_241
}
