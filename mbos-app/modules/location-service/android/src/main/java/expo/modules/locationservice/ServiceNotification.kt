package expo.modules.locationservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build

/**
 * THE NOTIFICATION IS NOT DECORATION; IT IS THE PRICE OF THE SERVICE.
 *
 * Android grants a foreground service its privileges — a process the OS will
 * not reap, location while the screen is off — strictly in exchange for a
 * notification the user can see and act on. `startForeground` must be called
 * within a few seconds of the service starting or the system kills the process
 * with an ANR, so this is built before anything else in `onStartCommand` and
 * it may not fail.
 *
 * **IT IS LOW IMPORTANCE AND SAYS SO IN WORDS.** `IMPORTANCE_LOW` is the
 * lowest an ongoing foreground-service notification may honestly be: it sits
 * in the shade with no sound and no heads-up banner, which is right for
 * something that will be there all day. `IMPORTANCE_MIN` is not offered for a
 * foreground service and asking for it would quietly be promoted anyway.
 *
 * **THE WORDS MATTER MORE THAN THE STYLING.** A salesman reading "MahekOne is
 * using your location" with no end in sight turns the app off. What this says
 * instead is the deal: it is his day, it is recording his route, and it stops
 * when he punches out. That is the same sentence `expo-location`'s own service
 * was configured with in `sync/trail.ts`, kept deliberately, so the change of
 * mechanism does not read to him as a change of behaviour.
 *
 * **NOTHING HERE MAY THROW.** It runs on ROMs whose manufacturers have been
 * most creative with the notification stack, and a service that crashes while
 * building the notification that legitimises it is a service that never
 * records a fix. The one thing that cannot be caught is the absence of a
 * notification at all, which is why the builder is written so there is nothing
 * in it to go wrong: no custom drawable, no remote views, no icon that could
 * fail to resolve.
 */
internal object ServiceNotification {

  const val ID = 8_242

  /**
   * Deliberately a DIFFERENT channel from `tracker-watchdog`'s nudge.
   *
   * Two notifications with two jobs: that one is an event the salesman should
   * act on, this one is a permanent fixture of a working day. On one channel a
   * salesman silencing the fixture would silence the alert as well, and the
   * alert is the half that tells him his route has stopped.
   */
  private const val CHANNEL_ID = "mbos-route-live"

  fun build(context: Context): Notification {
    val app = context.applicationContext
    ensureChannel(app)

    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(app, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(app)
      }

    /* The app's own icon rather than a drawable of this module's, for the
       reason `Nudge` gives next door: a local expo module has no resource
       merging worth setting up for one image, and an icon that fails to
       resolve is a crash inside NotificationManager. */
    builder.setSmallIcon(app.applicationInfo.icon)
      .setContentTitle("MahekOne is following your route")
      .setContentText("Recording where the day takes you. Stops the moment you punch out.")
      /* ONGOING, so it cannot be swiped away. That is not a courtesy to us: a
         dismissed foreground-service notification on some ROMs takes the
         service's exemption with it. */
      .setOngoing(true)
      /* The timestamp is hidden because it would say when the service last
         STARTED, and on a phone restarting it every few minutes that reads as
         the app relaunching itself all day. What a salesman needs from this
         row is one sentence, not a clock. */
      .setShowWhen(false)
      .setOnlyAlertOnce(true)

    launchIntent(app)?.let { builder.setContentIntent(it) }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      /* PUBLIC, so it is readable on a locked screen. The content names no
         customer, no location and no person — it says the app is recording a
         route — so there is nothing here to hide from somebody holding the
         phone, and hiding it would make the one row that explains the battery
         draw invisible exactly when somebody is wondering about it. */
      builder.setVisibility(Notification.VISIBILITY_PUBLIC)
    }

    return builder.build()
  }

  private fun ensureChannel(app: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      val manager =
        app.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Route recording",
        NotificationManager.IMPORTANCE_LOW,
      )
      channel.description =
        "Shows while MahekOne is recording your route, between your check-in and your check-out."
      /* No badge: a permanent notification that puts a dot on the launcher icon
         all day is a dot that stops meaning anything. */
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    } catch (e: Throwable) {
      /* A channel that could not be created means the notification posts
         without one, which on API 26+ means it does not post — and that is a
         failure `startForeground` will report in its own way. Throwing here
         would turn it into a crash instead. */
    }
  }

  private fun launchIntent(app: Context): PendingIntent? =
    try {
      val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
      if (launch == null) {
        null
      } else {
        /* FLAG_IMMUTABLE is required from API 31 and is correct on every
           version: nothing downstream fills anything into this intent. */
        val flags =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
          } else {
            PendingIntent.FLAG_UPDATE_CURRENT
          }
        PendingIntent.getActivity(app, 0, launch, flags)
      }
    } catch (e: Throwable) {
      null
    }
}
