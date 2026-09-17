package expo.modules.trackerwatchdog

import android.content.Context
import android.util.Log

/**
 * PUTTING THE LOCATION TASK BACK, THROUGH EXPO'S OWN DOOR.
 *
 * `expo-task-manager` persists every registered task — its name, its consumer
 * class and its options — into SharedPreferences, and `TaskService`'s
 * constructor restores the lot whenever it finds the process has no task map
 * yet:
 *
 *     if (!mTasksAndEventsRepository.tasksExist()) { createTasks(); restoreTasks(); }
 *
 * `tasksExist()` reads a STATIC field, so that condition is exactly "this
 * process has not yet built its task list" — a cold process. Restoring calls
 * `LocationTaskConsumer.didRegister`, which starts location updates again. So
 * the whole restart, in a process the OS has just brought back, is one
 * constructor call, made by expo's own code, with no JavaScript runtime and no
 * guess about what the task's options were.
 *
 * That is also what `TaskBroadcastReceiver` does on BOOT_COMPLETED, which is
 * why this module ships no boot receiver of its own.
 *
 * **IT IS REACHED BY REFLECTION, AND THAT IS THE CAREFUL CHOICE RATHER THAN
 * THE LAZY ONE.** The alternative is `implementation project(':expo-task-manager')`,
 * which couples this module to a name expo's autolinking generates and turns a
 * library rename into a build that will not compile — on a release path that
 * cannot be run locally, since there is no JDK on the machine this was written
 * on and the APK is built in CI. Reflection moves that failure from "nobody can
 * ship" to "this one call logs a miss and the rest of the watchdog carries on",
 * which for a mechanism whose entire purpose is to keep working when other
 * things have stopped is the right direction to fail in.
 *
 * **WHAT IT DOES NOT RESTORE IS THE FOREGROUND SERVICE**, and pretending
 * otherwise would be the worst thing this file could do.
 * `LocationTaskConsumer.maybeStartForegroundService` returns early while
 * `AppForegroundedSingleton.isForegrounded` is false, which it always is in a
 * headless process — there is no Activity. So what comes back here is the task
 * registration and the location PendingIntent, which on Android 10 and up the
 * platform then throttles to a few deliveries an hour for an app with no
 * foreground service. That is a sparse trail rather than a dense one, and it is
 * a great deal better than nothing: deliveries resume, the queue starts filling
 * again, and the burst is no longer waiting on somebody happening to open the
 * app. The dense trail comes back when he does open it, which is why the worker
 * also tells him to.
 *
 * Flipping `AppForegroundedSingleton.isForegrounded` to defeat that guard was
 * considered and refused. Android 12 would in fact allow the start — this app
 * asks for and usually holds the battery-optimisation exemption, which is on
 * the platform's own exemption list — but the guard is expo's, the throw lands
 * inside expo's ServiceConnection callback where nothing here can catch it, and
 * the punishment for a foreground service that fails to call `startForeground`
 * in time is the app being killed. Trading a sparse trail for a crash loop on
 * handsets that cannot be recalled is not a trade.
 */
internal object TaskRestore {

  /**
   * Ask expo to rebuild this process's task list. Answers whether the call was
   * made at all — never whether tracking is now working, which is precisely the
   * claim this whole subsystem has learned not to make on the strength of a
   * function returning.
   */
  fun ensure(context: Context): Boolean {
    return try {
      val cls = Class.forName("expo.modules.taskManager.TaskService")
      val ctor = cls.getConstructor(Context::class.java)
      ctor.newInstance(context.applicationContext)
      true
    } catch (e: Throwable) {
      /*
       * `Throwable` rather than `Exception`, and that is not carelessness. A
       * missing class arrives as `NoClassDefFoundError`, which is an Error; a
       * shrunk release build that renamed the class arrives the same way; and
       * expo's own restore path can throw anything an OEM settings screen or a
       * refused foreground service throws. None of those is worth losing the
       * run's own liveness mark over, which was already written before this was
       * called.
       */
      Log.w(TAG, "could not restore the location task: ${e.javaClass.simpleName}")
      false
    }
  }

  private const val TAG = "MbosTrackerWatchdog"
}
