package expo.modules.locationservice

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.util.concurrent.atomic.AtomicBoolean

/**
 * MBOS'S OWN TRACKER, AND THE REASON IT HAD TO BE OURS.
 *
 * The app has followed a salesman's route through `expo-location`'s background
 * task since the trail shipped, and in production it stops. Fifty-one separate
 * silences inside one working day, 523 minutes lost between them; single gaps
 * of 999, 498, 456 and 437 minutes; every live handset self-reporting
 * `tracker_stalled_at`; a vivo on `location_permission = 'always'` with
 * background granted and services on, stalled five minutes after check-in. The
 * shape in the data is always the same — silence, then a burst — and the burst
 * always begins when somebody opens the app.
 *
 * **THE CAUSE IS ONE LINE IN A LIBRARY WE DO NOT OWN.**
 * `LocationTaskConsumer.maybeStartForegroundService()` returns early on
 * `if (!AppForegroundedSingleton.isForegrounded)`, and that singleton is set
 * only from `OnActivityEntersForeground`. A task restored into a headless
 * process has no Activity, so the flag is false, so NO FOREGROUND SERVICE IS
 * STARTED — and from Android 10 the OS then throttles a background app's
 * location to a few fixes an hour. The task is running. The permission is
 * granted. The office sees a salesman standing still.
 *
 * Every mechanism this app has tried against that failed for the same reason
 * the bug does: it was JavaScript, and the JavaScript was not running. The JS
 * watchdog is a `setInterval` that only advances with the app on screen. The
 * foreground floor it falls back to only records with the app on screen. The
 * WorkManager nudge next door works by asking the salesman to open the app,
 * which is a real fix and is also an admission that nothing else could put the
 * dense tracker back.
 *
 * **SO THE SERVICE IS OURS, AND THE ONE THING IT DOES DIFFERENTLY IS START
 * WITHOUT AN ACTIVITY.** It is startable from a `BroadcastReceiver` and from a
 * `Worker`; it calls `startForeground` before it does anything else, so the
 * foreground-service exemption is held from the first instant; it owns its own
 * `FusedLocationProviderClient` callback, so no JavaScript is in the loop
 * between the radio and the disk; and it writes to a buffer a dead bundle
 * cannot lose. That is the entire difference, and it is the whole fix.
 *
 * **IT IS NOT A REPLACEMENT FOR expo-location.** `getFix`, the check-in radius
 * and every one-off reading still go through it, and must: this service is the
 * BACKGROUND path only. Two things asking the same provider for updates is
 * ordinary and costs nothing — the OS multiplexes one radio across every
 * request on the device.
 *
 * **NOTHING HERE MAY THROW.** It runs on handsets whose manufacturers have
 * been most creative with background execution, and a tracker that crashes on
 * the way to recording a fix has done worse than not running: it has recorded
 * a day that looks like a salesman who stayed at home.
 */
class MbosLocationService : Service() {

  private var client: FusedLocationProviderClient? = null
  private var callback: LocationCallback? = null
  private val beat = Handler(Looper.getMainLooper())
  private var beating = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    RUNNING.set(true)
  }

  /**
   * START_STICKY IS RESTART LAYER ONE, and the flags tell the two cases apart.
   *
   * Returning `START_STICKY` asks Android to recreate this service after it is
   * killed for memory, with a null intent. That is the cheapest of the three
   * layers and the only one with no latency at all — but it is also the one an
   * OEM battery manager most easily defeats, because a manager that
   * force-stops the whole package takes the sticky promise with it. Hence the
   * other two.
   *
   * A NULL INTENT IS THE OS PUTTING US BACK, which is worth counting
   * separately from a start somebody asked for — but it is counted the same
   * way, because from the office's point of view "this service had to be
   * started twenty times today" is one number and one conversation.
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val store = FixStore.of(this)
    val now = System.currentTimeMillis()

    /*
     * FOREGROUND FIRST, BEFORE ANY DECISION AT ALL.
     *
     * Android gives a service started with `startForegroundService` a few
     * seconds to call `startForeground` and kills the PROCESS with an ANR if
     * it does not — and that deadline runs from the start call, not from
     * whenever this method gets scheduled. So the notification goes up before
     * the permission check, before the wanted check, and before the provider
     * is touched. A service that decides to stop still has to have been
     * foreground first; `stopSelf` a line later is cheap and an ANR is not.
     */
    if (!goForeground()) {
      /* The one failure that cannot be worked around. On API 34 this is
         thrown where the manifest type and the granted permissions disagree,
         and on any version where the notification could not be built. Recorded
         so the office sees a reason rather than a silence, and then stopped —
         staying up without the foreground exemption is the throttled state
         this whole module exists to escape. */
      store.recordRefusal(now, "foreground_refused")
      stopSelf()
      return START_NOT_STICKY
    }

    /*
     * "NOT ONE SECOND EITHER SIDE" IS ENFORCED HERE AND NOT ONLY AT CHECK-OUT.
     *
     * The check-out calls `stop()`, which is the ordinary end of a day. What
     * this is for is the day that has no ordinary end: a phone switched off at
     * four and turned on at eleven, where `BootReceiver` would otherwise find
     * `wanted = true` in a preferences file nobody had been able to clear and
     * follow somebody home. The deadline is refreshed by JavaScript whenever
     * it is alive and the day is open, so a working day extends it and a dead
     * one expires.
     */
    if (!store.wanted(now)) {
      stopSelf()
      return START_NOT_STICKY
    }

    if (!hasLocationPermission()) {
      store.recordRefusal(now, "no_location_permission")
      stopSelf()
      return START_NOT_STICKY
    }

    store.recordStart(now)
    requestUpdates(store)
    startBeating()

    /*
     * START_STICKY and not START_REDELIVER_INTENT: there is nothing in the
     * intent worth redelivering. Every parameter this service runs on is in
     * the preferences file, deliberately, because the component that most
     * often starts it — `BootReceiver` — has no idea what the office
     * configured and no way to find out.
     */
    return START_STICKY
  }

  override fun onDestroy() {
    stopBeating()
    try {
      callback?.let { client?.removeLocationUpdates(it) }
    } catch (e: Throwable) {
      /* The provider was already gone, or Play services was updated under us.
         Nothing to release that the process dying will not release. */
    }
    callback = null
    client = null
    RUNNING.set(false)
    super.onDestroy()
  }

  /**
   * SWIPED OFF THE RECENTS LIST IS NOT A CHECK-OUT.
   *
   * `stopWithTask="false"` in the manifest is what keeps the service alive
   * through it; this override exists so the behaviour is stated in the code as
   * well, because a manifest attribute is the kind of thing a later edit
   * removes without knowing what it was for. Tidying the recents list is the
   * ordinary way an Android phone is used. The trail has exactly one honest
   * end and it is the button that says so.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    /* Deliberately NOT calling super's default teardown path and deliberately
       not stopping. The one thing worth doing is making sure we are put back
       if the OS decides otherwise, which `START_STICKY` and the watchdog
       already cover. */
  }

  /* ------------------------------------------------------------- capture */

  private fun goForeground(): Boolean =
    try {
      val notification = ServiceNotification.build(this)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        /*
         * THE TYPE IS DECLARED TWICE, IN THE MANIFEST AND HERE, AND BOTH ARE
         * READ. From API 29 this overload says what this particular start is;
         * from API 34 the platform checks it against the manifest declaration
         * AND against the permissions actually held, and throws
         * SecurityException where they disagree. Passing the type is what
         * makes a location foreground service legal on a modern phone at all.
         */
        startForeground(
          ServiceNotification.ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
        )
      } else {
        startForeground(ServiceNotification.ID, notification)
      }
      true
    } catch (e: Throwable) {
      Log.w(TAG, "could not go foreground: ${e.javaClass.simpleName}")
      false
    }

  private fun hasLocationPermission(): Boolean =
    checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED ||
      checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED

  /**
   * Ask the fused provider for a stream, and keep the callback ourselves.
   *
   * **HIGH ACCURACY, AND THE ARGUMENT FOR IT IS NOT DETAIL — IT IS WHETHER THE
   * FIX SURVIVES AT ALL.** `sync/trail.ts` records the whole of it: the Live
   * map runs `dropInaccurateFixes` over every trail before drawing it and
   * discards anything worse than `mbos.location.gpsAccuracyThresholdM`, which
   * is 50 m. Balanced on Android is roughly a city block and returns 100 m
   * indoors, so a Balanced trail is a fix woken for, taken, kept, queued,
   * uploaded, stored, indexed — and then dropped on the way to the screen. The
   * battery was spent and nothing was bought.
   *
   * **`setWaitForAccurateLocation(false)` is deliberate.** True makes the
   * provider hold the first fixes back until the reading settles, which is
   * right for a one-off "where am I" and wrong for a trail: the start of every
   * journey is exactly when the phone has just come out of a pocket, and those
   * are the minutes the office most often has nothing for.
   *
   * **`setMinUpdateDistanceMeters(0)` for the reason the old
   * `deferredUpdatesDistance` was 0:** a salesman standing still in a shop is
   * a fact the trail wants, and distance-gating would drop the dwell that
   * proves he was there.
   *
   * Idempotent. It is reached from `onStartCommand`, which the watchdog and
   * the OS both call repeatedly, so the previous callback is removed first —
   * two live callbacks would double the delivery rate and halve the battery
   * life to record the same trail twice.
   */
  private fun requestUpdates(store: FixStore) {
    try {
      val every = store.askEveryMs()
      val fused = client ?: LocationServices.getFusedLocationProviderClient(this).also {
        client = it
      }

      callback?.let {
        try {
          fused.removeLocationUpdates(it)
        } catch (e: Throwable) {
          /* Already gone. */
        }
      }

      val cb = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
          for (location in result.locations) record(location)
        }
      }
      callback = cb

      val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, every)
        .setMinUpdateIntervalMillis(every)
        .setMinUpdateDistanceMeters(0f)
        .setWaitForAccurateLocation(false)
        /*
         * NO BATCHING, AND THIS IS THE LINE THAT MAKES A POCKETED PHONE
         * REPORT AT ALL.
         *
         * `setMaxUpdateDelayMillis` is the fused provider's own deferral: it
         * lets the OS collect fixes and hand them over in one go, which saves
         * battery and means the office is told NOTHING in between. Zero is the
         * default and it is stated anyway, because the app has already lost a
         * release to exactly this parameter under its old name. A salesman
         * pocketed a working handset at 16:37 and opened the app at 16:46;
         * Android had collected 123 fixes at three-second spacing and handed
         * MBOS not one of them until the app came forward, when the whole
         * batch arrived at once. The data was never lost — it was held — and
         * "the console is blind until he opens the app" is precisely what
         * background tracking is relied upon not to be.
         *
         * The battery that buys is real and is not worth it. The dial for cost
         * is `mbos.location.trackEverySeconds`, which decides how often the
         * radio is asked at all; deferral only decides whether we are TOLD,
         * and being told late is being told nothing on the one screen that
         * reads this live.
         */
        .setMaxUpdateDelayMillis(0)
        .build()

      /* The main looper, not a worker thread. The callback does one small
         SQLite write, `SQLiteDatabase` does its own locking, and a thread of
         our own would be a thread to keep alive across a process the OS is
         trying to reap. Where this ever becomes a jank complaint the answer is
         a HandlerThread, not a coroutine scope: there is no lifecycle here to
         hang one off. */
      fused.requestLocationUpdates(request, cb, Looper.getMainLooper())
    } catch (e: SecurityException) {
      /* The permission was revoked between the check above and here, which is
         a real race on Android: a user can revoke from the shade. */
      FixStore.of(this).recordRefusal(System.currentTimeMillis(), "no_location_permission")
      stopSelf()
    } catch (e: Throwable) {
      /* No Play services, or a ROM whose fused provider is a stub. Recorded
         rather than crashed — and the service stays up, because the heartbeat
         below will try again and because a handset without Play services is
         one the office needs to be told about rather than one that should
         silently have no trail. */
      FixStore.of(this).recordRefusal(System.currentTimeMillis(), "provider_unavailable")
    }
  }

  private fun record(location: Location) {
    try {
      val store = FixStore.of(this)
      val now = System.currentTimeMillis()

      /* CHECKED ON EVERY FIX and not only at start. A day that ends while the
         phone is in a pocket — no check-out, no app, no watchdog tick — ends
         here, on the deadline, which is the only thing between a forgotten
         check-out and a handset that follows somebody through his evening. */
      if (!store.wanted(now)) {
        stopSelf()
        return
      }

      val accuracy =
        if (location.hasAccuracy()) Math.round(location.accuracy).toInt() else null

      /*
       * `location.time` and not `now`. The provider stamps a fix with when the
       * READING was taken, which on a batch the OS held back is minutes
       * earlier — and the trail is a shape in time, so stamping it on arrival
       * would draw a salesman standing still and then teleporting.
       *
       * A reading whose clock is nonsense is still stored. `at` is the phone's
       * own clock and the phone's clock is its owner's to set; the server
       * decides what to do with that, and it already refuses a fix it cannot
       * file against a session. Dropping it here would be this file inventing
       * a rule the wire already has.
       */
      store.keep(location.time, location.latitude, location.longitude, accuracy)
    } catch (e: Throwable) {
      Log.w(TAG, "could not record a fix: ${e.javaClass.simpleName}")
    }
  }

  /* ----------------------------------------------------------- the heartbeat */

  /**
   * THE FOURTH LAYER, AND IT IS INSIDE THE SERVICE RATHER THAN OUTSIDE IT.
   *
   * The three restart layers all answer "the service is not running". This
   * answers the other failure, which the field has seen more of: the service
   * is running, holding its notification, and the provider has quietly stopped
   * delivering. Play services is updated under a running app, a ROM's power
   * manager suspends the fused provider without touching the process, the
   * radio is turned off and on. Nothing about any of that destroys this
   * service, so nothing outside it would ever notice.
   *
   * It is a `Handler` on the main looper and NOT a `setInterval` in any sense
   * that matters: the objection to a JS timer is that the runtime stops with
   * the app, and this runs inside a foreground service whose whole purpose is
   * that the OS will not stop it. A service that could not run a timer could
   * not record a fix either.
   *
   * It only ever re-asks the provider. It does not stop, does not report a
   * stall and does not tell anybody: silence is measured by the office off
   * `location_service_last_fix_at`, which is a better instrument than a
   * verdict computed on a phone, and a service that concluded it was broken
   * and stopped would be doing the one thing that cannot be recovered from.
   */
  private fun startBeating() {
    if (beating) return
    beating = true
    beat.postDelayed(heartbeat, heartbeatEveryMs())
  }

  private fun stopBeating() {
    beating = false
    beat.removeCallbacks(heartbeat)
  }

  private val heartbeat = object : Runnable {
    override fun run() {
      if (!beating) return
      try {
        val store = FixStore.of(this@MbosLocationService)
        val now = System.currentTimeMillis()
        if (!store.wanted(now)) {
          stopSelf()
          return
        }
        val last = store.lastFixAt()
        /* A window of several cadences rather than one. One missed delivery is
           a walk through a lift shaft; several in a row with the service up is
           a provider that has gone away. Re-asking costs one call and cannot
           make anything worse — `requestUpdates` removes the old callback
           before it installs a new one. */
        if (last == 0L || now - last > silenceMs(store)) requestUpdates(store)
      } catch (e: Throwable) {
        /* Never allowed to kill the beat. */
      } finally {
        if (beating) beat.postDelayed(this, heartbeatEveryMs())
      }
    }
  }

  private fun heartbeatEveryMs(): Long = 60_000L

  private fun silenceMs(store: FixStore): Long {
    /* Six of the configured ask interval, floored at two minutes. The floor is
       the load-bearing half: at a three-second cadence six misses is eighteen
       seconds, which any indoor walk clears — and re-asking the provider every
       eighteen seconds all day is a second bug rather than a watchdog. It is
       the same lesson `mbos.location.trailStalledMinSilenceSeconds` was added
       for on the JS side, and the number is not shared with it because that one
       decides what the office is TOLD and this one decides whether we re-ask a
       provider, which is free. */
    return maxOf(2 * 60_000L, store.askEveryMs() * 6)
  }

  companion object {
    private const val TAG = "MbosLocationService"

    /**
     * IS IT UP, ASKED PER PROCESS.
     *
     * `ActivityManager.getRunningServices` was deprecated in API 26 and, for
     * anything outside your own package, returns nothing by design. A flag set
     * in `onCreate` and cleared in `onDestroy` is the honest instrument: it is
     * true exactly while this process holds a live instance, and every way it
     * can be wrong is wrong towards starting a service that is already up —
     * which `startForeground` and `START_STICKY` make a no-op.
     */
    private val RUNNING = AtomicBoolean(false)

    fun isRunning(): Boolean = RUNNING.get()

    /** The intent every starter uses, so there is one spelling of it. */
    fun intent(context: Context): Intent =
      Intent(context.applicationContext, MbosLocationService::class.java)
  }
}
