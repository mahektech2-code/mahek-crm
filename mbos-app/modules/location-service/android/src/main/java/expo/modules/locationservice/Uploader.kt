package expo.modules.locationservice

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * THE HALF THE RECORDER WAS MISSING.
 *
 * `MbosLocationService` fixed capture: it goes on taking fixes after Android
 * has killed the JavaScript, which is the failure the whole module exists for.
 * It did not fix DELIVERY. The only thing that ever posted a position was
 * `flush()` in `sync/trail.ts`, and that is JavaScript — so on exactly the
 * phones this module was written for, the service recorded faithfully into its
 * own buffer and the office saw the same silence it always had, followed by a
 * burst when somebody opened the app. A recorder nobody empties is
 * indistinguishable, from a desk in Nagpur, from a recorder that never ran.
 *
 * So the uploader is here, in the service, in Kotlin, where it is alive at the
 * moment the bundle is not.
 *
 * **ONE POST IN FLIGHT, EVER.** Everything below runs on ONE HandlerThread and
 * the next tick is scheduled by the one that just finished — never by a fixed
 * rate. On a 2G connection a post can take longer than the cadence, and a
 * timer that fired regardless would stack posts on a radio that is already the
 * bottleneck: work queued faster than it drains is the exact shape of the bug
 * `flush()` was fixed for once already, arriving from the other end.
 *
 * **ONE CONNECTION, HELD.** A fresh TLS handshake every few seconds is the
 * difference between this being viable and cooking the battery — a handshake
 * is several round trips on a link whose round trip is the expensive part.
 * `HttpURLConnection` is used rather than a bundled OkHttp for two reasons and
 * the first is decisive: on Android it IS OkHttp underneath, sharing a
 * process-wide connection pool and reusing a keep-alive connection across
 * calls with no configuration at all, so the reuse is had for nothing. The
 * second is that adding `com.squareup.okhttp3` to this module would put a
 * second copy of it in the graph beside React Native's own, resolved by Gradle
 * to whichever version is higher — a resolution nobody in this repository can
 * test, in the one component that must never fail to start, on an APK that
 * cannot be recalled. What is given up is a tidier API. `Connection: close` is
 * never sent and the response body is always read to the end and closed, which
 * is what actually returns a connection to the pool.
 *
 * **NOTHING HERE MAY THROW.** The same rule as every other file in this
 * directory: a service that crashes on the way to sending a fix has done worse
 * than not sending it.
 */
internal class Uploader(context: Context) {

  private val app = context.applicationContext
  private val thread = HandlerThread("mbos-upload")
  private val handler: Handler

  /** Ticks stop the moment this goes false; `stop()` is the only writer. */
  @Volatile
  private var running = false

  /**
   * Belt and braces over the single-threaded handler.
   *
   * The handler cannot run two ticks at once, so this can only ever be hit by
   * a `start()` racing a tick already in progress — and the answer to that is
   * to let the tick finish rather than to begin a second.
   */
  private val busy = AtomicBoolean(false)

  /** Attempts that have failed in a row. Reset by anything that worked. */
  private var failures = 0

  init {
    thread.start()
    handler = Handler(thread.looper)
  }

  /**
   * Begin, or re-arm.
   *
   * Idempotent because its caller is `onStartCommand`, which the OS, the
   * watchdog and the boot receiver all reach repeatedly. The pending tick is
   * removed before a new one is posted, so re-arming can never leave two
   * chains of ticks running beside each other — which would be two posts in
   * flight, which is the one thing this class promises does not happen.
   */
  fun start() {
    running = true
    handler.removeCallbacks(tick)
    handler.post(tick)
  }

  /** The service is going away. */
  fun stop() {
    running = false
    handler.removeCallbacks(tick)
    try {
      thread.quitSafely()
    } catch (e: Throwable) {
      /* Nothing to do; the process is going anyway. */
    }
  }

  private val tick = object : Runnable {
    override fun run() {
      if (!running) return
      if (!busy.compareAndSet(false, true)) return

      var delay = DEFAULT_CADENCE_MS
      try {
        delay = attempt()
      } catch (e: Throwable) {
        /* An uploader is not allowed to cost a day. Whatever this was, it is
           tried again after a wait rather than taking the service down. */
        Log.w(TAG, "upload attempt failed: ${e.javaClass.simpleName}")
        failures += 1
        delay = backoffMs(FixStore.of(app).uploadEveryMs(), failures, FAILED)
      } finally {
        busy.set(false)
        if (running) handler.postDelayed(this, delay.coerceAtLeast(MIN_DELAY_MS))
      }
    }
  }

  /**
   * One attempt, start to finish, and the milliseconds to wait before the next.
   *
   * Every early return names an OUTCOME rather than a number, so the waiting
   * rule lives in one place and matches `backoffDelayMs` in
   * `engines/upload.ts` — which is where it is written down and tested, because
   * nothing in this file can be.
   */
  private fun attempt(): Long {
    val store = FixStore.of(app)
    val now = System.currentTimeMillis()
    val cadence = store.uploadEveryMs()

    /*
     * THE OFFICE TURNED THE RECORDER'S OWN SENDING OFF.
     *
     * Not a fault and not a stop: the app takes the queue back — `uploads()`
     * answers false, `chooseSender` reads it, and `drainService` starts moving
     * rows into `positions` again. This loop stays alive at the ceiling so that
     * turning it back on is noticed within five minutes rather than at the next
     * check-in.
     */
    if (cadence <= 0L) return backoffMs(DEFAULT_CADENCE_MS, 0, BLOCKED)

    /* The day is over, or the deadline passed. The service stops itself on the
       same reading; there is nothing here worth doing first. */
    if (!store.wanted(now)) return backoffMs(cadence, 0, BLOCKED)

    if (store.authBlocked()) return backoffMs(cadence, 0, BLOCKED)
    val credentials = store.credentials() ?: return backoffMs(cadence, 0, BLOCKED)

    /*
     * ASKED BEFORE THE RADIO IS, which is the entire point of asking.
     *
     * `ConnectivityManager` answers from state the system already holds, for
     * nothing. Posting into a dead network costs a connection attempt and a
     * timeout on a handset whose battery is the thing being protected — and a
     * salesman in a district with no signal would pay that every cadence, all
     * day, for an answer the OS would have given free.
     */
    if (!online()) {
      failures += 1
      return backoffMs(cadence, failures, OFFLINE)
    }

    val page = store.drain(BATCH)
    if (page.isEmpty()) {
      /* NOT A FAILURE, and the distinction matters: a recorder with nothing to
         send is not a recorder that cannot send, and treating it as one would
         have a phone parked at the ceiling every time it caught up. */
      failures = 0
      return backoffMs(cadence, 0, NOTHING)
    }

    /*
     * A ROW THIS CANNOT TURN INTO JSON IS DROPPED HERE, NOT SENT AND NOT KEPT.
     *
     * `JSONObject.put` throws on a NaN or an infinity, and a throw inside
     * `buildBody` would fail the whole attempt — for ever, because the same
     * oldest page is re-read on every tick. One unusable row would wedge a
     * salesman's entire queue behind it with nothing anywhere naming the
     * cause, which is the head-of-line failure `partial` was added to the wire
     * to prevent, arriving from inside the phone instead.
     *
     * "A fix with no coordinates is not a fix" is the server route's own
     * sentence about the same case, and it drops rather than refuses for the
     * same reason: one bad row must not cost the four hundred and ninety-nine
     * behind it, and there is nobody to tell about it anyway.
     */
    val rows = page.filter { usable(it) }
    val unusable = page.filterNot { usable(it) }.mapNotNull { it["id"] as? String }
    if (unusable.isNotEmpty()) store.forget(unusable)
    if (rows.isEmpty()) {
      failures = 0
      return backoffMs(cadence, 0, NOTHING)
    }

    val ids = rows.mapNotNull { it["id"] as? String }
    val body = buildBody(store, credentials, rows)

    var answer = post(credentials.baseUrl, credentials.deviceId, credentials.accessToken, body)

    /*
     * A 401 IS ASKED ABOUT ONCE, AND ONLY ONCE.
     *
     * The access token lives an hour and this loop runs all day, so expiry is
     * the ordinary case rather than the exceptional one — but a refresh that
     * itself fails means the handset is holding something the server will not
     * take, and asking again every six seconds would be a phone spending its
     * battery to be refused. `blockAuth` stops it until the app hands over a
     * fresh pair, which is the one thing that can change the answer.
     */
    if (answer.status == 401) {
      if (refresh(store, credentials)) {
        val fresh = store.credentials()
        answer =
          if (fresh == null) answer
          else post(fresh.baseUrl, fresh.deviceId, fresh.accessToken, body)
      }
      if (answer.status == 401) {
        store.blockAuth()
        return backoffMs(cadence, 0, BLOCKED)
      }
    }

    val text = answer.body
    if (answer.status !in 200..299 || text == null) {
      failures += 1
      return backoffMs(cadence, failures, FAILED)
    }

    return applyAnswer(store, text, ids, rows.size, cadence, now)
  }

  /**
   * WHAT THE SERVER SAID, AND WHAT THAT MEANS FOR THE ROWS WE JUST SENT.
   *
   * This is a MIRROR of `decideFlush` in `engines/flush-answer.ts` and it has
   * to stay one. Getting it wrong does not cost a round trip, it costs a
   * salesman's morning: the buffer is emptied on the strength of this reading,
   * so a word misread as "delivered" deletes fixes the office never stored, and
   * everything reports success all the way down.
   *
   * The five cases, in the order the engine states them:
   *
   *  - `off` — the office turned tracking off. Drop the lot and end the day.
   *    Keeping them would be storing something nobody asked for.
   *  - `no-session-yet` — there is no working day these could belong to,
   *    almost always a check-in still in the outbox. KEEP them, and let go only
   *    of anything so old that no check-in is ever coming.
   *  - `partial` — the server names the ids it is FINISHED with. Delete those
   *    and keep the rest. The shape is ids-that-landed and never ids-to-keep,
   *    and the asymmetry is the whole safety argument: an id the server forgets
   *    to name costs one round trip, where under the opposite shape it would
   *    cost the fix.
   *  - anything else, INCLUDING A WORD THIS BUILD HAS NEVER HEARD OF — the
   *    batch was delivered. That is deliberate, not an oversight: it is what
   *    lets MahekOne ship a fifth word before any handset can be updated, and
   *    an APK cannot be recalled. A phone that refused to drain on an unknown
   *    word would wedge its own queue until somebody sideloaded a new build.
   */
  private fun applyAnswer(
    store: FixStore,
    body: String,
    sentIds: List<String>,
    sentCount: Int,
    cadenceMs: Long,
    nowMs: Long,
  ): Long {
    val json =
      try {
        JSONObject(body)
      } catch (e: Throwable) {
        /* A body we cannot read is a different thing from a refusal we can.
           Nothing is deleted. */
        failures += 1
        return backoffMs(cadenceMs, failures, FAILED)
      }

    if (!json.optBoolean("ok", false)) {
      failures += 1
      return backoffMs(cadenceMs, failures, FAILED)
    }

    /* A `when` USED AS AN EXPRESSION, so every path demonstrably answers a
       delay. As a statement with a `return` in each arm it would mean the same
       thing and depend on the compiler's flow analysis agreeing that it does. */
    return when (json.optString("tracking", "")) {
      "off" -> {
        store.clear()
        store.setWanted(wanted = false, untilMs = 0L)
        failures = 0
        backoffMs(cadenceMs, 0, BLOCKED)
      }
      "no-session-yet" -> {
        store.ageOut(nowMs - store.retentionMs())
        failures += 1
        backoffMs(cadenceMs, failures, NOT_YET)
      }
      "partial" -> {
        val accepted = landed(json.opt("filed"), sentIds)
        if (accepted.isEmpty()) {
          /* NO PROGRESS. The next tick re-reads the same oldest rows and would
             post them again for the same answer — fifty pointless round trips
             on the connection of the handset already having the worst day. The
             rows are kept either way; what is refused is the spinning. */
          failures += 1
          backoffMs(cadenceMs, failures, FAILED)
        } else {
          store.forget(accepted)
          store.recordUpload(nowMs)
          failures = 0
          catchUp(accepted.size, cadenceMs)
        }
      }
      else -> {
        store.forget(sentIds)
        store.recordUpload(nowMs)
        failures = 0
        catchUp(sentCount, cadenceMs)
      }
    }
  }

  /**
   * A FULL BATCH MEANS THERE IS MORE, so the next one goes almost at once.
   *
   * A phone coming back from three hours with no signal is holding thousands of
   * fixes, and waiting the ordinary cadence between five-hundred-row batches
   * would take most of an hour to catch up — with the newest fix, which is the
   * only one the Live map wants, sitting at the back of the queue the whole
   * time. That is the production failure `MAX_PASSES` was added to `flush()`
   * for, and this is the same answer in the shape this loop allows.
   *
   * It is a SHORT DELAY rather than a loop inside the tick, deliberately.
   * Looping here would hold the handler for as long as the catch-up took, so a
   * check-out arriving mid-catch-up would wait on it; going round the handler
   * leaves `stop()` able to land between any two batches.
   */
  private fun catchUp(moved: Int, cadenceMs: Long): Long =
    if (moved >= BATCH) CATCH_UP_MS else backoffMs(cadenceMs, 0, SENT)

  /**
   * Has this row the three things a position is made of, in a shape JSON can
   * carry? Anything else is not a fix. See the call site for why it matters
   * more here than it would anywhere else.
   */
  private fun usable(row: Map<String, Any?>): Boolean {
    if (row["id"] as? String == null) return false
    val at = row["at"] as? Double ?: return false
    val lat = row["lat"] as? Double ?: return false
    val lng = row["lng"] as? Double ?: return false
    if (!at.isFinite() || !lat.isFinite() || !lng.isFinite()) return false
    if (at <= 0.0) return false
    return lat >= -90.0 && lat <= 90.0 && lng >= -180.0 && lng <= 180.0
  }

  /**
   * Only the ids that were actually sent, and only strings.
   *
   * `filed` arrives from a server this handset does not control and may hold
   * an id from another batch, a duplicate, or something that is not a string.
   * Intersecting with what was sent is what stops this deleting a row this call
   * never offered — the only way `filed` could otherwise reach a fix the server
   * has not seen.
   */
  private fun landed(filed: Any?, sentIds: List<String>): List<String> {
    val array = filed as? JSONArray ?: return emptyList()
    val sent = sentIds.toHashSet()
    val out = LinkedHashSet<String>()
    for (i in 0 until array.length()) {
      val id = array.opt(i) as? String ?: continue
      if (sent.contains(id)) out.add(id)
    }
    return out.toList()
  }

  /* --------------------------------------------------------------- the wire */

  private class Answer(val status: Int, val body: String?)

  /**
   * The post itself.
   *
   * Timeouts rather than none: a hung socket on a market-lane connection would
   * hold this thread — and therefore every later fix — until the process died.
   * Twenty seconds is what `sync/api.ts` allows itself for the same reason and
   * on the same connections.
   */
  private fun post(
    baseUrl: String,
    deviceId: String,
    accessToken: String,
    body: String,
  ): Answer {
    var connection: HttpURLConnection? = null
    return try {
      val url = URL(baseUrl.trimEnd('/') + POSITIONS_PATH)
      connection = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        doOutput = true
        setRequestProperty("content-type", "application/json")
        setRequestProperty("authorization", "Bearer $accessToken")
        /* The same header `sync/api.ts` puts on every request. The server reads
           the device off the token as well, and sending it keeps one shape of
           request rather than two. */
        setRequestProperty("x-mbos-device", deviceId)
      }
      write(connection.outputStream, body)
      val status = connection.responseCode
      val text = read(connection, status)
      Answer(status, text)
    } catch (e: Throwable) {
      Log.w(TAG, "post failed: ${e.javaClass.simpleName}")
      Answer(0, null)
    } finally {
      /* NOT `disconnect()`. That closes the underlying socket, which is exactly
         the keep-alive connection the next post in six seconds wants — calling
         it would pay for a TLS handshake every cadence, which is the cost this
         class is written around. Reading the stream to its end and closing it,
         which `read` does, is what hands the connection back to the pool. */
      connection?.errorStream?.close()
    }
  }

  private fun write(stream: OutputStream, body: String) {
    stream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
  }

  private fun read(connection: HttpURLConnection, status: Int): String? =
    try {
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      stream?.use { raw ->
        BufferedReader(raw.reader(Charsets.UTF_8)).use { reader -> reader.readText() }
      }
    } catch (e: Throwable) {
      null
    }

  /**
   * Spend the refresh token, and keep the pair that comes back.
   *
   * Both tokens rotate, and the old refresh token goes on working until it
   * expires — the server's refresh is a stateless JWT with no denylist. That is
   * what lets the service and the app each hold their own copy without either
   * signing the other out, and it is the fact this whole arrangement rests on.
   */
  private fun refresh(store: FixStore, credentials: FixStore.Credentials): Boolean {
    var connection: HttpURLConnection? = null
    return try {
      val url = URL(credentials.baseUrl.trimEnd('/') + REFRESH_PATH)
      connection = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        doOutput = true
        setRequestProperty("content-type", "application/json")
      }
      val payload = JSONObject().put("refreshToken", credentials.refreshToken).toString()
      write(connection.outputStream, payload)
      val status = connection.responseCode
      if (status !in 200..299) return false
      val text = read(connection, status) ?: return false
      val json = JSONObject(text)
      val access = json.optString("accessToken", "")
      val next = json.optString("refreshToken", "")
      if (access.isEmpty() || next.isEmpty()) return false
      store.setTokens(access, next)
      true
    } catch (e: Throwable) {
      false
    } finally {
      connection?.errorStream?.close()
    }
  }

  /* -------------------------------------------------------------- the body */

  /**
   * The same body `postPositions` sends, minus what only JavaScript can know.
   *
   * **THE PHONE'S OWN STATE RIDES THIS REQUEST, because this request is going
   * anyway.** A flat battery is the commonest reason a trail simply stops
   * mid-beat and the one cause a manager can still act on while the day is
   * running — and it used to be reported only by the app, which is to say only
   * when the app was alive, which is precisely not the case this module exists
   * for. Everything below is read from the platform without a network call and
   * without waking anything.
   *
   * What is deliberately ABSENT is `queuedPositions`, which counts the APP's
   * queue and not this one, and `trackerStalledAgoSeconds`, which is a verdict
   * about the expo task this handset is no longer using. The server reads an
   * absent key as "leave the column alone", so saying nothing about them is
   * exactly right: the app's own answers stand until the app next speaks.
   */
  private fun buildBody(
    store: FixStore,
    credentials: FixStore.Credentials,
    rows: List<Map<String, Any?>>,
  ): String {
    val positions = JSONArray()
    for (row in rows) {
      val item = JSONObject()
      item.put("id", row["id"])
      /* Back to a Long. `drain` widens it to a Double for the JS bridge, and a
         Double reaching JSON prints as `1.7e12`, which `Number(p.at)` would
         read fine and a reader never would. */
      item.put("at", (row["at"] as? Double)?.toLong() ?: 0L)
      item.put("lat", row["lat"])
      item.put("lng", row["lng"])
      val accuracy = row["accuracyM"]
      if (accuracy == null) item.put("accuracyM", JSONObject.NULL) else item.put("accuracyM", accuracy)
      positions.put(item)
    }

    val body = JSONObject()
    body.put("positions", positions)
    body.put("deviceId", credentials.deviceId)

    val now = System.currentTimeMillis()
    battery(body)
    connectionType(body)

    body.put("locationServiceRunning", MbosLocationService.isRunning())
    val lastFix = store.lastFixAt()
    /* SECONDS-AGO AND NEVER AN INSTANT, the rule the whole device report keeps:
       the office stamps on its own clock because a phone's clock is its
       owner's to set, and `null` — never a negative — is how "this has never
       happened" crosses. */
    body.put(
      "locationServiceLastFixAgoSeconds",
      if (lastFix > 0L && lastFix <= now) (now - lastFix) / 1000L else JSONObject.NULL,
    )
    body.put("locationServiceBuffered", store.buffered())
    body.put("locationServiceStartsToday", store.startsToday(now))
    val refused = store.lastRefusalAt()
    body.put(
      "locationServiceRefusedAgoSeconds",
      if (refused > 0L && refused <= now) (now - refused) / 1000L else JSONObject.NULL,
    )
    store.lastRefusal()?.let { body.put("locationServiceRefusal", it) }

    return body.toString()
  }

  /**
   * The battery, off the sticky broadcast — no receiver registered, no
   * listener kept, no wake.
   *
   * A reading that will not come is OMITTED rather than sent as zero. The
   * office reads an absent field as "this build did not say"; a zero would be
   * a flat phone, which is the one thing on this row somebody acts on.
   */
  private fun battery(body: JSONObject) {
    try {
      val intent: Intent =
        app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return
      val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
      val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
      if (level >= 0 && scale > 0) {
        body.put("batteryPercent", Math.round(level * 100f / scale))
      }
      when (intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
        /* CHARGING AND FULL ARE BOTH "on charge" — 18% climbing needs no phone
           call, and the office draws the two differently for that reason. */
        BatteryManager.BATTERY_STATUS_CHARGING,
        BatteryManager.BATTERY_STATUS_FULL,
        -> body.put("batteryCharging", true)
        BatteryManager.BATTERY_STATUS_DISCHARGING,
        BatteryManager.BATTERY_STATUS_NOT_CHARGING,
        -> body.put("batteryCharging", false)
        else -> {
          /* `UNKNOWN`, which is the platform declining to answer. Left absent. */
        }
      }
    } catch (e: Throwable) {
      /* A courtesy on top of a request that has its own job. Never its cost. */
    }
  }

  /** What it was connected BY — never a claim about being disconnected. */
  private fun connectionType(body: JSONObject) {
    try {
      val capabilities = capabilities() ?: return
      val word =
        when {
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
          else -> "unknown"
        }
      body.put("connectionType", word)
    } catch (e: Throwable) {
      /* Absent, which the server reads as "did not say". */
    }
  }

  private fun capabilities(): NetworkCapabilities? {
    val manager =
      app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
    val network = manager.activeNetwork ?: return null
    return manager.getNetworkCapabilities(network)
  }

  /**
   * Is there a network worth posting into?
   *
   * `NET_CAPABILITY_INTERNET` alone is the answer, deliberately, and NOT
   * `VALIDATED` beside it. A validated network is one Android has itself
   * reached the internet over, and on the connections this app runs on — a
   * market lane, a 2G cell, a captive hotel Wi-Fi — validation lags reality by
   * minutes in both directions. Requiring it would park a working handset at
   * the backoff ceiling; requiring neither would post into flight mode. The
   * middle answer costs an occasional wasted attempt, which the backoff already
   * pays for.
   *
   * NOTHING HERE EVER CLAIMS A PHONE IS OFFLINE to the office. A phone with no
   * connection cannot report having no connection — silence carries that, and
   * silence is `last_seen_at`.
   */
  private fun online(): Boolean =
    try {
      capabilities()?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (e: Throwable) {
      /* Cannot tell. Try the post: a wasted attempt is cheaper than a trail
         that stopped because a system service would not answer. */
      true
    }

  /* ------------------------------------------------------------- the waiting */

  /**
   * MIRRORED FROM `backoffDelayMs` IN `engines/upload.ts`, which is where the
   * rule is written down and tested.
   *
   * It cannot be shared — one side is Kotlin in a service with no JavaScript
   * runtime — so what makes the duplication safe is that it is small enough to
   * check by reading both, exactly as `fixId` is. The numbers below are the
   * engine's own and any change belongs there first.
   */
  private fun backoffMs(cadenceMs: Long, consecutiveFailures: Int, outcome: Int): Long {
    val cadence = if (cadenceMs > 0L) cadenceMs else DEFAULT_CADENCE_MS
    return when (outcome) {
      SENT, NOTHING -> cadence
      OFFLINE, BLOCKED -> CEILING_MS
      NOT_YET -> minOf(SETTLE_CEILING_MS, climb(cadence, consecutiveFailures))
      else -> minOf(CEILING_MS, climb(cadence, consecutiveFailures))
    }
  }

  private fun climb(cadenceMs: Long, failures: Int): Long {
    val n = failures.coerceIn(0, MAX_DOUBLINGS)
    /* Shifted rather than raised to a power, and bounded above — a Long
       shifted by more than 63 is not a large number, it is a wrapped one, and
       a negative delay would be posted immediately for ever. */
    return cadenceMs shl n
  }

  private companion object {
    private const val TAG = "MbosLocationService"

    private const val POSITIONS_PATH = "/api/mbos/positions"
    private const val REFRESH_PATH = "/api/mbos/auth/refresh"

    /** The server's own `MAX_BATCH`. A larger one is refused with a 400. */
    private const val BATCH = 500

    private const val TIMEOUT_MS = 20_000

    /** Never zero: a delay of nothing is a spin on a thread that owns a radio. */
    private const val MIN_DELAY_MS = 250L

    /** Between two full batches while catching up. See `catchUp`. */
    private const val CATCH_UP_MS = 500L

    private const val DEFAULT_CADENCE_MS = 6_000L

    /* The engine's numbers, and only the engine's. */
    private const val CEILING_MS = 5L * 60_000
    private const val SETTLE_CEILING_MS = 60_000L
    private const val MAX_DOUBLINGS = 20

    /* The engine's outcomes. Ints rather than an enum because they are read in
       one `when` five lines long and an enum would be a file of its own. */
    private const val SENT = 0
    private const val NOTHING = 1
    private const val FAILED = 2
    private const val OFFLINE = 3
    private const val NOT_YET = 4
    private const val BLOCKED = 5
  }
}
