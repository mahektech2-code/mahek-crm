package expo.modules.phonesetup

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * THE PHONE ITSELF IS A THING THAT CAN BE WRONG, and nothing in MBOS could
 * see it.
 *
 * A field salesman on a vivo checked in at 04:16 and posted not one GPS fix
 * all day. Every permission was granted — `getBackgroundPermissionsAsync`
 * said so, `startLocationUpdatesAsync` returned without complaint — and the
 * OEM battery manager killed the foreground service behind it anyway. From
 * JavaScript that is invisible: the app asked for everything it knew how to
 * ask for, got yes to all of it, and produced an empty day that reads on the
 * Live map exactly like a salesman who stayed at home.
 *
 * Android exposes the one fact that would have explained it —
 * `PowerManager.isIgnoringBatteryOptimizations` — and no module installed
 * here surfaces it. That is the whole reason this module exists.
 *
 * **NOTHING HERE EVER REJECTS.** Every function resolves, and where it cannot
 * find out it says `'unknown'` rather than throwing. A screen that crashes
 * while somebody is trying to repair his phone is worse than one that admits
 * it could not tell — and this code runs on precisely the handsets whose
 * manufacturers have been most creative, so "it threw something we have not
 * seen" is an ordinary Tuesday rather than an exceptional case.
 *
 * **IT DIAGNOSES AND OFFERS; IT NEVER GATES.** The same principle
 * `engines/geo.ts` states for a GPS reading — evidence, never a gate. A
 * salesman whose day is refused because his phone is configured badly stops
 * recording days, and the company loses the work as well as the diagnosis.
 */
class PhoneSetupModule : Module() {

  /**
   * The promise left hanging while the system exemption dialog is up.
   *
   * Written and read only from the main thread — `requestBatteryExemption`
   * runs on `Queues.MAIN` and `OnActivityEntersForeground` is delivered
   * there — so it needs no synchronisation. That is why the queue is pinned
   * rather than left at the default.
   */
  private var pendingExemption: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("MbosPhoneSetup")

    AsyncFunction<String>("batteryExemption") {
      batteryExemption()
    }

    /**
     * THE ONE TAP THAT ACTUALLY FIXES IT.
     *
     * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` puts up a system dialog
     * that exempts this app from Doze and app standby outright — no
     * hunting through three levels of an OEM settings tree, no screen whose
     * wording differs on every ROM. It is the difference between a support
     * call and a button.
     *
     * It needs `android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`,
     * declared in app.json. **Google Play restricts that permission** to a
     * short list of app categories and will reject a listing that holds it
     * without qualifying. MBOS IS SIDELOADED AND IS NEVER PUBLISHED TO PLAY
     * — DEPLOY.md's "Releasing the handset app" is the whole distribution
     * story, an APK built by a workflow and installed by hand — so the
     * policy does not reach us. Recorded here because the next person to
     * read this line will wonder, and the answer is a fact about how this
     * app ships rather than a judgement about the policy.
     */
    AsyncFunction("requestBatteryExemption") { promise: Promise ->
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:${packageName()}"))

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || !launch(intent)) {
        // Nothing was put in front of anybody, so there is nothing to wait
        // for. Answer with the state as it stands rather than hanging.
        promise.resolve(batteryExemption())
      } else {
        // A previous ask that never came back — the activity was destroyed
        // under it, say — is resolved with a fresh reading rather than left
        // for ever. One pending promise, and it is always this one.
        pendingExemption?.resolve(batteryExemption())
        pendingExemption = promise
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction<String>("openAutostartSettings") {
      openAutostartSettings()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction<Boolean>("openAppSettings") {
      launch(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.parse("package:${packageName()}"))
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction<Boolean>("openLocationSettings") {
      launch(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
    }.runOnQueue(Queues.MAIN)

    /**
     * READ THE ANSWER BACK; NEVER ASSUME THE USER SAID YES.
     *
     * The exemption dialog reports `RESULT_CANCELED` whichever button is
     * pressed, so its result code says nothing at all. What we need is not
     * WHAT it returned but THAT it returned — at which point the true state
     * is one cheap call away.
     *
     * `OnActivityEntersForeground` rather than `OnActivityResult` for two
     * reasons: the settings screens below are routinely launched into a new
     * task, where no result is ever delivered back to us, and coming back
     * to the foreground is the one event that happens on every path
     * including the user pressing Back or the system dismissing the dialog.
     * It can fire for unrelated reasons too — that resolves the promise
     * with a correct current reading, which is not a wrong answer.
     */
    OnActivityEntersForeground {
      val waiting = pendingExemption ?: return@OnActivityEntersForeground
      pendingExemption = null
      waiting.resolve(batteryExemption())
    }

    OnDestroy {
      // The module is going away. A promise nobody will ever resolve is a
      // screen stuck on a spinner, so answer it with what we know.
      pendingExemption?.resolve(batteryExemption())
      pendingExemption = null
    }
  }

  private fun packageName(): String = appContext.reactContext?.packageName ?: ""

  private fun batteryExemption(): String {
    // Below Android 6 (API 23) there are no battery optimisations to be
    // exempt FROM — Doze and app standby arrived with M — so every app is
    // effectively exempt and `'exempt'` is the true answer rather than a
    // convenient one. minSdk here is 24, so the branch cannot be reached
    // today; it stays so that lowering minSdk does not silently start
    // reporting `'unknown'` on devices where nothing is wrong.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return EXEMPT

    val context = appContext.reactContext ?: return UNKNOWN
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return UNKNOWN

    return try {
      if (power.isIgnoringBatteryOptimizations(context.packageName)) EXEMPT else OPTIMISED
    } catch (e: RuntimeException) {
      // Some ROMs stub this service out. Not knowing is a real answer.
      UNKNOWN
    }
  }

  private fun openAutostartSettings(): String {
    for (screen in AUTOSTART_SCREENS) {
      if (launch(Intent().setComponent(screen))) return OPENED_OEM
    }

    // THE FALLBACK ALWAYS EXISTS, which is the point of having one. Every
    // component above is undocumented and moves between OS versions; the
    // app's own settings page is part of Android itself. It is not as good —
    // the autostart switch is usually two screens further in — but it lands
    // somewhere real, and the caller is told which of the two it got so the
    // screen can say what to look for.
    val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
      .setData(Uri.parse("package:${packageName()}"))
    return if (launch(details)) OPENED_APP_SETTINGS else FAILED
  }

  /**
   * Start an activity, and answer whether one actually started.
   *
   * From the current Activity where there is one, so the settings screen
   * comes up as part of this task and returning lands back on MBOS. With no
   * Activity — the process was reaped and rebuilt behind a notification, say
   * — the application context can do it, but only with
   * `FLAG_ACTIVITY_NEW_TASK`, which Android requires and throws over.
   */
  private fun launch(intent: Intent): Boolean {
    val activity = appContext.currentActivity
    val context = activity ?: appContext.reactContext ?: return false
    if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    return try {
      context.startActivity(intent)
      true
    } catch (e: RuntimeException) {
      // ActivityNotFoundException where this ROM has no such screen, and
      // SecurityException where it has one the OEM did not export. Both are
      // RuntimeExceptions, and to a salesman both mean the same thing: try
      // the next one. Anything else that comes out of an OEM settings
      // component is the same answer for the same reason.
      false
    }
  }

  private companion object {
    const val EXEMPT = "exempt"
    const val OPTIMISED = "optimised"
    const val UNKNOWN = "unknown"

    const val OPENED_OEM = "opened_oem"
    const val OPENED_APP_SETTINGS = "opened_app_settings"
    const val FAILED = "failed"

    /**
     * THE AUTOSTART SCREENS, IN ORDER, AND NONE OF THEM IS DOCUMENTED.
     *
     * There is no Android API for "let this app start itself again after you
     * kill it" — the whole idea is an OEM invention, and every manufacturer
     * built it as a private Activity with its own name in its own package.
     * These component names come from the ROMs themselves; they are renamed
     * and moved between OS versions without notice, which is exactly why
     * this is an ordered list ending at a screen that cannot disappear
     * rather than a single best guess.
     *
     * **Each one is TRIED rather than queried.** The obvious implementation
     * asks `packageManager.resolveActivity` first and only launches what
     * resolves — and on Android 11 and up that is worse than useless:
     * package visibility filtering means a component in another package
     * answers `null` to the query while `startActivity` on it succeeds
     * perfectly well. Resolving first would report "your phone has no
     * autostart screen" on every modern handset that has one. Starting it
     * and catching the failure asks the only question that matters and
     * cannot be lied to.
     *
     * Order is immaterial between manufacturers — these packages are
     * mutually exclusive, so at most one family is present on any handset —
     * and it does matter WITHIN a family, where the newer name goes first
     * and the older ROM's name follows it. vivo leads because a vivo is the
     * handset this was built for.
     *
     * Written as fully-qualified class names. The `com.vivo.permissionmanager/
     * .activity.BgStartUpManagerActivity` shorthand is a manifest
     * convenience; `ComponentName` takes the whole thing.
     */
    val AUTOSTART_SCREENS = listOf(
      // vivo — Funtouch OS / OriginOS
      ComponentName(
        "com.vivo.permissionmanager",
        "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
      ),
      ComponentName(
        "com.iqoo.secure",
        "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"
      ),
      ComponentName(
        "com.vivo.permissionmanager",
        "com.vivo.permissionmanager.activity.PurviewTabActivity"
      ),

      // Xiaomi, Redmi, POCO — MIUI / HyperOS
      ComponentName(
        "com.miui.securitycenter",
        "com.miui.permcenter.autostart.AutoStartManagementActivity"
      ),

      // Oppo, Realme, OnePlus on newer ColorOS — OPLUS/ColorOS
      ComponentName(
        "com.oplus.safecenter",
        "com.oplus.safecenter.permission.startup.StartupAppListActivity"
      ),
      ComponentName(
        "com.coloros.safecenter",
        "com.coloros.safecenter.permission.startup.StartupAppListActivity"
      ),
      ComponentName(
        "com.coloros.safecenter",
        "com.coloros.safecenter.startupapp.StartupAppListActivity"
      ),
      ComponentName(
        "com.oppo.safe",
        "com.oppo.safe.permission.startup.StartupAppListActivity"
      ),

      // OnePlus — OxygenOS, before it became ColorOS underneath
      ComponentName(
        "com.oneplus.security",
        "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"
      ),

      // Huawei, Honor — EMUI
      ComponentName(
        "com.huawei.systemmanager",
        "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
      ),
      ComponentName(
        "com.huawei.systemmanager",
        "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"
      ),
      ComponentName(
        "com.huawei.systemmanager",
        "com.huawei.systemmanager.optimize.process.ProtectActivity"
      ),

      // Samsung — One UI. Samsung has no autostart list as such; what it has
      // is Device care's battery screen, where an app is put on the list
      // that is never put to sleep. Different wording, same job.
      ComponentName(
        "com.samsung.android.lool",
        "com.samsung.android.sm.ui.battery.BatteryActivity"
      ),
      ComponentName(
        "com.samsung.android.lool",
        "com.samsung.android.sm.battery.ui.BatteryActivity"
      ),
      ComponentName(
        "com.samsung.android.sm",
        "com.samsung.android.sm.ui.battery.BatteryActivity"
      )
    )
  }
}
