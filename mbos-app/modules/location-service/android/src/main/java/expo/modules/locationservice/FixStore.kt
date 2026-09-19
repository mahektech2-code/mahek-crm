package expo.modules.locationservice

import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.util.Calendar
import kotlin.math.roundToLong

/**
 * WHERE A FIX LIVES BETWEEN BEING TAKEN AND BEING PUT IN THE TRAIL.
 *
 * The service takes fixes with no JavaScript runtime anywhere in the process —
 * that is the entire point of it — so it cannot write to `mbos.db`. Everything
 * else this app remembers is in that file, opened by expo-sqlite from the
 * bundle, and reaching it from here would be the worst kind of clever.
 *
 * **THE TWO-WRITER PROBLEM IS NOT ASSUMED AWAY; IT IS ARRANGED OUT OF
 * EXISTENCE.** The obvious implementation writes `positions` in `mbos.db`
 * directly, so the JS side needs no draining at all. It was rejected on three
 * counts, in order of how badly each one fails:
 *
 *  1. **Two different SQLite libraries on one file.** expo-sqlite ships and
 *     links its OWN build of SQLite; `android.database.sqlite` is the
 *     platform's, whose version, compile options and journal-mode defaults are
 *     the ROM vendor's business. Two such libraries on one database file,
 *     concurrently, is not a locking question — SQLite handles locking — it is
 *     a question of whether they agree about WAL, about `PRAGMA
 *     journal_size_limit`, and about recovery after a kill. On the handsets
 *     this app runs on, where the OS reaps the process mid-write routinely,
 *     the failure mode is a corrupt `mbos.db`, which is every unsent visit,
 *     order and payment on that phone.
 *  2. **The schema might not be there yet.** `positions` exists because
 *     `src/db/index.ts` migrated it. A service started by `BootReceiver` on a
 *     phone whose app has not run since the update would be writing to a table
 *     that does not exist, or worse, one at the wrong version.
 *  3. **It would make the native side own a JS invariant.** `fixId` is the
 *     reading, the id absorbs redelivery, and the cadence is `shouldKeepFix`.
 *     Two implementations of those, in two languages, drift.
 *
 * So the buffer is its OWN file, `mbos_fixes.db`, and there is exactly one
 * writer for it: this class, as a process singleton. The service writes, the
 * bridge reads and deletes, both through the same `SQLiteDatabase` handle —
 * so the concurrency here is two threads on one connection, which
 * `SQLiteDatabase` serialises itself, and not two connections on one file.
 *
 * **DRAINING IS TWO-PHASE and it has to be.** The bridge hands JavaScript the
 * rows AND their ids and deletes nothing; JavaScript inserts them into
 * `positions` and then calls `forget`. A crash in between costs a repeat, and a
 * repeat costs nothing, because `positions.id` is derived from the reading and
 * the insert is `INSERT OR IGNORE`. Deleting on read would be the other trade:
 * one round trip saved, and a morning of somebody's route lost to a kill
 * between the read and the insert.
 *
 * The settings and counters beside the rows are in SharedPreferences rather
 * than in the same database, for the reason `WatchdogStore` gives: a file the
 * OS hands back the moment the process exists, readable from a receiver with
 * nothing else initialised.
 */
internal class FixStore private constructor(context: Context) {

  private val app = context.applicationContext
  private val prefs: SharedPreferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private val helper = Helper(app)

  /* --------------------------------------------------------------- the rows */

  private class Helper(context: Context) : SQLiteOpenHelper(context, DB, null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
      /*
       * The columns are the wire's, exactly: this table's whole job is to hold
       * a row until `positions` can take it, and a shape that needed
       * translating is a shape that can be translated wrongly.
       *
       * `id` is the PRIMARY KEY and it is computed from the reading, the same
       * `at|lat|lng` rule `fixId` states in `sync/trail.ts`. Android hands a
       * batch of deferred fixes over AGAIN whenever it decides a delivery did
       * not complete, and a random id would make each redelivery a new row —
       * production reached 33,000 rows for 4,000 real fixes that way, one of
       * them stored ninety-three times. `INSERT OR IGNORE` against a key that
       * IS the reading costs nothing on a repeat.
       */
      db.execSQL(
        "CREATE TABLE IF NOT EXISTS fixes (" +
          "id TEXT PRIMARY KEY, at INTEGER NOT NULL, lat REAL NOT NULL, " +
          "lng REAL NOT NULL, accuracy_m INTEGER)",
      )
      db.execSQL("CREATE INDEX IF NOT EXISTS fixes_at ON fixes (at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
      /* Nothing to do at version 1, and nothing to guess at. A buffer is not a
         record: if a future version ever cannot read an old row, the honest
         answer is to drop the table rather than to migrate somebody's half-sent
         morning into a shape this build invented. */
    }
  }

  /**
   * Keep a fix, if it is far enough from the last one kept.
   *
   * THE CADENCE IS ENFORCED HERE AS WELL AS IN THE REQUEST, and the app has
   * already paid three days to learn why. `expo-location`'s `timeInterval`
   * never reaches Android — it is declared `Long?` and read out of JSON-backed
   * options with a strict `as?`, so a boxed `Integer` yields null and the
   * override is dropped in silence. That was a location request parameter
   * accepted and ignored, and the only thing that would have caught it is a
   * second gate on the receiving side. FusedLocationProviderClient's own
   * interval is a far better-behaved parameter than that one, and it is still
   * a HINT: the provider is free to deliver faster when another app has asked
   * for a faster rate, and on a shared device that is ordinary.
   *
   * The mark is a preference and not `MAX(at)` off the table, for the reason
   * `sync/trail.ts` gives about its own: the rows are DELETED as they drain, so
   * asking the table would answer "nothing kept recently" the moment a drain
   * succeeded and the cadence would collapse to whatever the radio felt like.
   *
   * A clock that went BACKWARDS resets the mark rather than stalling on it.
   * Otherwise a phone corrected an hour earlier would record nothing at all
   * until it caught up with a mark from a future it no longer believes in.
   */
  fun keep(atMs: Long, lat: Double, lng: Double, accuracyM: Int?): Boolean {
    val gap = keepEveryMs()
    val last = prefs.getLong(LAST_KEPT_AT, 0L)
    if (atMs < last) {
      prefs.edit().putLong(LAST_KEPT_AT, atMs).apply()
    } else if (last != 0L && atMs - last < gap) {
      return false
    }

    val values = ContentValues().apply {
      put("id", fixId(atMs, lat, lng))
      put("at", atMs)
      put("lat", lat)
      put("lng", lng)
      if (accuracyM != null) put("accuracy_m", accuracyM) else putNull("accuracy_m")
    }

    val db = helper.writableDatabase
    db.insertWithOnConflict("fixes", null, values, SQLiteDatabase.CONFLICT_IGNORE)
    prefs.edit().putLong(LAST_KEPT_AT, atMs).putLong(LAST_FIX_AT, atMs).apply()
    trim(db)
    return true
  }

  /**
   * The id IS the reading — the same rule, and the same spelling, as
   * `fixId` in `sync/trail.ts`.
   *
   * It is duplicated here rather than shared, because there is no way to share
   * it: one side is Kotlin in a service with no JavaScript runtime and the
   * other is TypeScript. What makes the duplication safe is that it is ONE
   * LINE and that both sides insert with a conflict-ignore, so the worst a
   * drift could do is store one fix twice rather than lose one. Six decimal
   * places is about a tenth of a metre, far finer than any reading this app
   * will see, so nothing genuinely distinct is folded together.
   */
  private fun fixId(atMs: Long, lat: Double, lng: Double): String =
    "mbos_pos_${atMs}_${(lat * 1e6).roundToLong()}_${(lng * 1e6).roundToLong()}"

  /**
   * A buffer that only ever grows is the other way to lose a day.
   *
   * The cap is a COUNT and the oldest go first, which is the opposite of the
   * rule `flush()` follows in JavaScript — that one sends oldest first because
   * a route is read in order. Here the question is different: something has
   * gone wrong enough that JavaScript has not run for long enough to overflow
   * a cap measured in days of fixes, and of the two ends of that buffer the
   * RECENT one is the half anybody can still act on. A manager looking for
   * where somebody is now is not helped by the first hour of a week-old
   * silence.
   *
   * It is deliberately not a time window. A phone in a district with no signal
   * fills this slowly and a phone whose bundle will not start fills it fast,
   * and it is storage, not age, that the cap is protecting.
   */
  private fun trim(db: SQLiteDatabase) {
    val cap = prefs.getInt(BUFFER_CAP, DEFAULT_BUFFER_CAP)
    db.execSQL(
      "DELETE FROM fixes WHERE id IN (" +
        "SELECT id FROM fixes ORDER BY at DESC LIMIT -1 OFFSET ?)",
      arrayOf<Any>(cap),
    )
  }

  /** Rows for JavaScript, oldest first, and NOTHING is deleted by reading. */
  fun drain(limit: Int): List<Map<String, Any?>> {
    val out = ArrayList<Map<String, Any?>>()
    helper.readableDatabase.rawQuery(
      "SELECT id, at, lat, lng, accuracy_m FROM fixes ORDER BY at ASC LIMIT ?",
      arrayOf(limit.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(
          mapOf(
            "id" to c.getString(0),
            /* A Double, because the bridge carries JS numbers and a Long past
               2^53 would be silently rounded. An epoch in milliseconds is
               nowhere near that, and saying so here is cheaper than finding out
               in 285,000 years. */
            "at" to c.getLong(1).toDouble(),
            "lat" to c.getDouble(2),
            "lng" to c.getDouble(3),
            "accuracyM" to if (c.isNull(4)) null else c.getInt(4),
          ),
        )
      }
    }
    return out
  }

  /** The second half of the drain: these reached `positions` and may go. */
  fun forget(ids: List<String>) {
    if (ids.isEmpty()) return
    val db = helper.writableDatabase
    db.beginTransaction()
    try {
      for (id in ids) db.delete("fixes", "id = ?", arrayOf(id))
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun buffered(): Int =
    helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM fixes", null).use { c ->
      if (c.moveToFirst()) c.getInt(0) else 0
    }

  /* ---------------------------------------------------- what the office set */

  /**
   * The office's numbers, mirrored where a dead process can read them.
   *
   * `app_settings` reaches the handset on a pull and is read through
   * `data/config.ts`, which needs SQLite and a bundle. A service started by
   * `BootReceiver` has neither, so `start()` writes the two numbers it was
   * given into preferences on its way past and the service reads them from
   * there. It is a MIRROR and not a second source: JavaScript writes, native
   * reads, nothing here ever writes back.
   *
   * The defaults are the same three-second cadence `registry.ts` states, and
   * they stand only in the window between a fresh install and its first pull.
   */
  fun setCapture(askEveryMs: Long, keepEveryMs: Long, bufferCap: Int) {
    prefs.edit()
      .putLong(ASK_EVERY_MS, askEveryMs)
      .putLong(KEEP_EVERY_MS, keepEveryMs)
      .putInt(BUFFER_CAP, bufferCap)
      .apply()
  }

  fun askEveryMs(): Long = prefs.getLong(ASK_EVERY_MS, DEFAULT_EVERY_MS)

  fun keepEveryMs(): Long = prefs.getLong(KEEP_EVERY_MS, DEFAULT_EVERY_MS)

  /* ------------------------------------------------------- is a day open */

  /**
   * WHETHER THE OFFICE WANTS THIS HANDSET TRACKING, AND UNTIL WHEN.
   *
   * Two values rather than one, and the second is the one that matters.
   * "Not one second either side" is the rule the whole trail is built on, and
   * a boolean is exactly where a rule like that gets lost: a phone that was
   * switched off mid-afternoon and turned on again at eleven at night would
   * find `wanted = true` in a preferences file nobody had been able to clear,
   * and would follow its owner home. There is no check-out coming — that is
   * what "switched off mid-afternoon" means — so nothing but a deadline can
   * end it.
   *
   * JavaScript refreshes the deadline whenever it is alive and the day is
   * open. The service checks it on every start and on every fix, and stops
   * itself the moment it passes.
   */
  fun setWanted(wanted: Boolean, untilMs: Long) {
    prefs.edit().putBoolean(WANTED, wanted).putLong(WANTED_UNTIL, untilMs).apply()
  }

  fun wanted(nowMs: Long): Boolean {
    if (!prefs.getBoolean(WANTED, false)) return false
    val until = prefs.getLong(WANTED_UNTIL, 0L)
    return until > nowMs
  }

  /* ------------------------------------------------------- what happened */

  fun lastFixAt(): Long = prefs.getLong(LAST_FIX_AT, 0L)

  /**
   * IS THE SERVICE ACTUALLY RUNNING, asked the only honest way.
   *
   * `ActivityManager.getRunningServices` was deprecated in API 26 and, for
   * anything but your own package, lies by design. A static boolean on the
   * service class is better and is still not enough on its own: it is per
   * PROCESS, so a process the OS reaped and rebuilt reads false, which is
   * correct, and a process killed with the service still in the system's
   * mind reads false too, which is also what we want to act on. The flag is
   * set in `onCreate` and cleared in `onDestroy`, and where the process dies
   * without either running, the next process starts at false. Every wrong
   * answer this can give is wrong in the direction of starting a service that
   * is already running, which `START_STICKY` and `startForeground` make a
   * no-op.
   */
  fun running(): Boolean = MbosLocationService.isRunning()

  /**
   * How many times the service has had to be STARTED today, counted on the
   * local calendar day.
   *
   * A start is not by itself a fault — the first of the day is the check-in.
   * Twenty is a phone killing the service twenty times, which is the single
   * most useful number the office could not see before, and the reason this is
   * counted rather than inferred from gaps in the trail: a gap says the trail
   * stopped and this says who stopped it.
   *
   * Rolled over at local midnight for the reason `WatchdogStore` gives about
   * its own count: overnight is when a phone is charged and when an OEM
   * battery manager's own bookkeeping resets, so yesterday's twenty say
   * nothing about this morning.
   */
  fun recordStart(nowMs: Long) {
    val today = localDay(nowMs)
    val count = if (prefs.getString(STARTS_DAY, null) == today) prefs.getInt(STARTS, 0) else 0
    prefs.edit().putString(STARTS_DAY, today).putInt(STARTS, count + 1).apply()
  }

  fun startsToday(nowMs: Long): Int {
    if (prefs.getString(STARTS_DAY, null) != localDay(nowMs)) return 0
    return prefs.getInt(STARTS, 0)
  }

  /**
   * THE START THE OS REFUSED, which is a completely different support call.
   *
   * Android 12 forbids starting a foreground service from the background
   * outside a short list of exempt moments — see `ServiceLauncher` — and a
   * refusal there is not the battery manager killing anything. It is the
   * platform working as designed on a phone that has not been given the
   * battery exemption `phone-setup` offers in one tap. Recorded separately
   * because the fix is different and the conversation with the salesman is
   * different.
   */
  fun recordRefusal(nowMs: Long, reason: String) {
    prefs.edit().putLong(LAST_REFUSAL_AT, nowMs).putString(LAST_REFUSAL, reason).apply()
  }

  fun lastRefusalAt(): Long = prefs.getLong(LAST_REFUSAL_AT, 0L)

  fun lastRefusal(): String? = prefs.getString(LAST_REFUSAL, null)

  /**
   * The day as a local calendar date, with `Calendar` rather than
   * `java.time`.
   *
   * minSdk here is 24 and `LocalDate` needs core library desugaring, which is
   * an app-level build setting this module must not quietly depend on — and
   * the failure mode of getting that wrong is a `NoClassDefFoundError` inside
   * a background component, which is precisely the kind of silence this module
   * exists to end. `SimpleDateFormat` is avoided for the separate reason that
   * it is not thread safe and this is reached from two.
   */
  private fun localDay(atMs: Long): String {
    val c = Calendar.getInstance()
    c.timeInMillis = atMs
    return String.format(
      "%04d-%02d-%02d",
      c.get(Calendar.YEAR),
      c.get(Calendar.MONTH) + 1,
      c.get(Calendar.DAY_OF_MONTH),
    )
  }

  companion object {
    private const val DB = "mbos_fixes.db"
    private const val PREFS = "MbosLocationService"

    private const val ASK_EVERY_MS = "askEveryMs"
    private const val KEEP_EVERY_MS = "keepEveryMs"
    private const val BUFFER_CAP = "bufferCap"
    private const val WANTED = "wanted"
    private const val WANTED_UNTIL = "wantedUntil"
    private const val LAST_KEPT_AT = "lastKeptAt"
    private const val LAST_FIX_AT = "lastFixAt"
    private const val STARTS = "starts"
    private const val STARTS_DAY = "startsDay"
    private const val LAST_REFUSAL_AT = "lastRefusalAt"
    private const val LAST_REFUSAL = "lastRefusal"

    /**
     * The numbers that stand between a fresh install and its first pull.
     *
     * They are the registry's own defaults, stated twice on purpose and never
     * silently: `data/config.ts` does exactly this on the other side of the
     * bridge, for the same window and the same reason. A salesman signing in
     * for the first time on a bad connection still has to have his day
     * recorded.
     */
    private const val DEFAULT_EVERY_MS = 3_000L
    private const val DEFAULT_BUFFER_CAP = 50_000

    /**
     * ONE INSTANCE PER PROCESS, and that is the whole of the concurrency
     * argument.
     *
     * The service writes on the location callback's thread and the bridge
     * reads on a module queue. Two `SQLiteOpenHelper`s would be two
     * connections to one file; one is one connection used by two threads,
     * which `SQLiteDatabase` serialises internally. Double-checked with a
     * `@Volatile` field because both callers can arrive at once on a cold
     * start — the receiver starting the service while the bundle boots.
     */
    @Volatile
    private var instance: FixStore? = null

    fun of(context: Context): FixStore =
      instance ?: synchronized(this) {
        instance ?: FixStore(context).also { instance = it }
      }
  }
}
