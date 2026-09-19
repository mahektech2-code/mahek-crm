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

  /**
   * A fix nobody is ever going to be able to file, let go of.
   *
   * The mirror of `flush()`'s own age-out, and it fires on the same one answer:
   * `no-session-yet`, which means the server has no working day these fixes
   * could belong to. Almost always that is a check-in still in the outbox and
   * the wait is minutes; a fix a WEEK past that is one whose check-in is never
   * coming, and keeping it for ever is how a queue becomes a queue that only
   * grows.
   *
   * It is deliberately NOT run on an ordinary failure. No signal loses nothing
   * and must lose nothing — that is the whole promise the buffer makes.
   */
  fun ageOut(beforeMs: Long): Int =
    helper.writableDatabase.delete("fixes", "at < ?", arrayOf(beforeMs.toString()))

  /**
   * Everything, gone — the office turned tracking off.
   *
   * The one answer where holding on to fixes would be storing something nobody
   * asked for. `flush()` does exactly this on the same word.
   */
  fun clear() {
    helper.writableDatabase.delete("fixes", null, null)
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

  /**
   * HOW OFTEN THE RECORDER SENDS, which is a different number from how often
   * it takes.
   *
   * Zero is a real and load-bearing value: it means the recorder does not send
   * at all and the app does the uploading, which is what this module did
   * before it could send for itself. It is the escape hatch for a build whose
   * uploader turns out to be wrong in the field, reachable from the Admin
   * Console rather than from a sideloaded APK — which matters more here than
   * anywhere else in this directory, because an APK cannot be recalled and
   * this is the one piece of it that spends a salesman's data.
   */
  fun setUpload(uploadEveryMs: Long, retentionMs: Long) {
    prefs.edit()
      .putLong(UPLOAD_EVERY_MS, uploadEveryMs)
      .putLong(RETENTION_MS, retentionMs)
      .apply()
  }

  fun uploadEveryMs(): Long = prefs.getLong(UPLOAD_EVERY_MS, DEFAULT_UPLOAD_EVERY_MS)

  fun retentionMs(): Long = prefs.getLong(RETENTION_MS, DEFAULT_RETENTION_MS)

  /* ------------------------------------------------------- the credential */

  /**
   * WHAT THE RECORDER SIGNS ITS POSTS WITH, and why it is HERE rather than in
   * the keychain where the app keeps it.
   *
   * The app's tokens live in `expo-secure-store`, which on Android is a
   * SharedPreferences file whose VALUES are encrypted with a key wrapped in the
   * AndroidKeyStore. Reading that from here would mean reimplementing another
   * package's storage format — its cipher, its key alias, its envelope, its
   * version prefix — and being right about it in a background service on a
   * phone that cannot be recalled, for ever, across every upgrade of that
   * package. That is not a credential store, it is a bet.
   *
   * So the app MIRRORS the pair here, exactly as it mirrors the office's
   * numbers above and for the same reason: something that runs with no
   * JavaScript anywhere in the process cannot ask JavaScript for anything. It
   * is written by `start` and by every token refresh the app itself performs,
   * and cleared on sign-out.
   *
   * **THE COST IS STATED RATHER THAN HIDDEN.** This file is app-private
   * (`MODE_PRIVATE`) and unreadable by another app on an unrooted phone, and it
   * is NOT the keychain: a refresh token here is protected by the sandbox
   * alone, where the app's own copy is protected by hardware-backed key
   * wrapping as well. What buys that back is that the refresh token rotates on
   * every use and the access token lives an hour — and that the alternative is
   * not "a safer uploader", it is no uploader, which is the failure this whole
   * module exists to end.
   */
  fun setCredentials(
    baseUrl: String,
    deviceId: String,
    accessToken: String,
    refreshToken: String,
  ) {
    val edit = prefs.edit()
    if (accessToken.isEmpty() && refreshToken.isEmpty()) {
      /* SIGN-OUT. Removed rather than written empty, so `credentials()` answers
         null and the uploader stops rather than posting an empty bearer and
         collecting a 401 every cadence. The base URL and the device id go with
         them: neither is a secret, and leaving them behind would have the next
         person to sign in on this handset momentarily posting under the last
         one's device id. */
      edit.remove(BASE_URL).remove(DEVICE_ID).remove(ACCESS_TOKEN).remove(REFRESH_TOKEN)
    } else {
      /* EACH FIELD IS WRITTEN ONLY IF IT ARRIVED, the same rule the wire keeps
         in both directions: a caller that can say three of the four must not
         wipe the fourth. */
      if (baseUrl.isNotEmpty()) edit.putString(BASE_URL, baseUrl)
      if (deviceId.isNotEmpty()) edit.putString(DEVICE_ID, deviceId)
      if (accessToken.isNotEmpty()) edit.putString(ACCESS_TOKEN, accessToken)
      if (refreshToken.isNotEmpty()) edit.putString(REFRESH_TOKEN, refreshToken)
    }
    /*
     * A NEW CREDENTIAL IS THE ONE THING THAT UNBLOCKS A BLOCKED UPLOADER.
     *
     * `blocked` means the server would not take what this handset held, and
     * nothing about waiting changes that — so the uploader stops asking and
     * waits for exactly this. Clearing it here, rather than on a timer, is what
     * makes recovery immediate and makes "blocked" mean what it says.
     */
    edit.putBoolean(AUTH_BLOCKED, false).apply()
  }

  /** Everything a post needs, or null where any part of it is missing. */
  data class Credentials(
    val baseUrl: String,
    val deviceId: String,
    val accessToken: String,
    val refreshToken: String,
  )

  fun credentials(): Credentials? {
    val base = prefs.getString(BASE_URL, null) ?: return null
    val device = prefs.getString(DEVICE_ID, null) ?: return null
    val access = prefs.getString(ACCESS_TOKEN, null) ?: return null
    val refresh = prefs.getString(REFRESH_TOKEN, null) ?: return null
    if (base.isEmpty() || device.isEmpty() || access.isEmpty() || refresh.isEmpty()) return null
    return Credentials(base, device, access, refresh)
  }

  /**
   * The rotated pair, written back by the uploader's own refresh.
   *
   * This is the ONE thing the native side writes that the app also holds, and
   * it does not write back across the bridge. Both refresh tokens go on
   * working: the server's refresh is a stateless JWT with no denylist, so
   * rotating one copy does not invalidate the other, and each side simply
   * carries its own until it expires. Keeping them in step would mean the
   * service reaching into the keychain, which is the thing this whole section
   * exists to avoid.
   */
  fun setTokens(accessToken: String, refreshToken: String) {
    prefs.edit()
      .putString(ACCESS_TOKEN, accessToken)
      .putString(REFRESH_TOKEN, refreshToken)
      .putBoolean(AUTH_BLOCKED, false)
      .apply()
  }

  /** The server would not take this handset's credential. Only a fresh one helps. */
  fun blockAuth() {
    prefs.edit().putBoolean(AUTH_BLOCKED, true).apply()
  }

  fun authBlocked(): Boolean = prefs.getBoolean(AUTH_BLOCKED, false)

  /**
   * IS THE RECORDER THE ONE SENDING, answered for the app rather than for
   * itself.
   *
   * `chooseSender` in `engines/upload.ts` is the rule and this is the fact it
   * reads. It is computed HERE, from the same values the uploader itself
   * reads, rather than inferred on the other side of the bridge from settings
   * that might mean something else by the time they get there.
   *
   * FIVE THINGS, and the last two are the ones that keep a queue from being
   * stranded. The office has asked for it, this handset holds something it can
   * sign a post with, and the server has not refused that — those are about
   * whether the uploader WOULD send. The other two are about whether it is
   * there to: a service the OEM has just killed, or a day that has ended, is a
   * buffer with nobody sending it, and the app has to take the queue back. The
   * check-out is the ordinary case of that: `stop()` clears the deadline and
   * then flushes, and this is what makes that flush actually pick up the last
   * few minutes of the day rather than leaving them for the next check-in.
   *
   * `isRunning()` is per PROCESS, which is exactly right here: the service has
   * no `android:process` of its own, so the process asking is the process that
   * would be running it.
   */
  fun uploads(): Boolean =
    uploadEveryMs() > 0L &&
      !authBlocked() &&
      credentials() != null &&
      wanted(System.currentTimeMillis()) &&
      MbosLocationService.isRunning()

  /* ------------------------------------------ what the uploader has managed */

  fun recordUpload(nowMs: Long) {
    prefs.edit().putLong(LAST_UPLOAD_AT, nowMs).apply()
  }

  fun lastUploadAt(): Long = prefs.getLong(LAST_UPLOAD_AT, 0L)

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
    private const val UPLOAD_EVERY_MS = "uploadEveryMs"
    private const val RETENTION_MS = "retentionMs"
    private const val BASE_URL = "baseUrl"
    private const val DEVICE_ID = "deviceId"
    private const val ACCESS_TOKEN = "accessToken"
    private const val REFRESH_TOKEN = "refreshToken"
    private const val AUTH_BLOCKED = "authBlocked"
    private const val LAST_UPLOAD_AT = "lastUploadAt"

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
     * Six seconds, and it is deliberately not three.
     *
     * The capture cadence and the send cadence are two questions — one decides
     * what the trail LOOKS like and the other only how fresh the live pin is —
     * and every captured fix is sent either way, so six sends two fixes per
     * post rather than one and draws exactly the same route. What it buys is
     * half the radio wakes over an eight-hour day, for a difference on a map
     * nobody watching it can perceive.
     *
     * Like the two above, this stands only between a fresh install and its
     * first pull; `mbos.location.serviceUploadEverySeconds` is the authority.
     */
    private const val DEFAULT_UPLOAD_EVERY_MS = 6_000L

    /** The same seven days `mbos.location.queueRetentionDays` states. */
    private const val DEFAULT_RETENTION_MS = 7L * 24 * 60 * 60 * 1_000

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
