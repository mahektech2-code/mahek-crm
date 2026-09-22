/**
 * WHO SENDS THE TRAIL, AND HOW OFTEN TO TRY AGAIN WHEN SENDING FAILED.
 *
 * The recorder in `modules/location-service` fixed HALF of the problem it was
 * written for. It keeps taking fixes after Android has killed the JavaScript —
 * which is the whole failure — and then the fixes sat in its own buffer,
 * because the only thing that ever posted them was `flush()` in
 * `sync/trail.ts`, which is JavaScript. A phone recording perfectly into a
 * store nobody was emptying reads, in the office, exactly like a phone
 * recording nothing: silence, then a burst when somebody opens the app. So the
 * uploader moved into the service as well, and these two rules are what it
 * runs on.
 *
 * **IT IS AN ENGINE BECAUSE NEITHER PLACE THAT USES IT CAN BE TESTED.**
 * `sync/trail.ts` imports expo-location and TaskManager at module scope, so
 * nothing in it runs without a device; the uploader itself is Kotlin inside a
 * foreground service, so nothing in it runs without a handset and an APK that
 * cannot be recalled. `backoffDelayMs` in particular is MIRRORED in Kotlin
 * rather than called from it — there is no way to share a function across that
 * boundary — and this file is the statement of the rule that the mirror is
 * checked against by a person reading both. That is the same trade `fixId`
 * already makes, and it is safe for the same reason: the rule is small enough
 * to hold in one line of sight, and the worst a drift can do is a wake at the
 * wrong minute rather than a fix lost.
 *
 * PURE: no I/O, no clock beyond what is handed in.
 */

/* ------------------------------------------------------------------- owner */

/**
 * There are two things that can post a position and only one of them may.
 *
 * Both queues drain to the same endpoint and the same table, and the id of a
 * fix is its own reading, so a row sent twice costs a round trip and never a
 * record. That is what makes this a question about waste rather than about
 * correctness — and it is still worth answering unambiguously, because the
 * failure of a queue with two owners is not the duplicate, it is the day
 * nobody drains at all because each side believed the other was doing it.
 *
 * The recorder owns sending whenever it CAN send: it is the only one of the
 * two that is alive at the moment the app is not, which is the whole reason it
 * exists. The app takes the queue back exactly where the recorder has said it
 * will not be sending — the office set the cadence to zero, or it holds no
 * credential it can use — and both of those are states the recorder reports
 * rather than states the app guesses at.
 *
 * **AND THERE IS A THIRD STATE, WHICH IS THE ONE THAT COST A DAY'S ROUTE.**
 * `uploads` is a BELIEF, not an outcome: it is true whenever the cadence is
 * set, a credential is held, the server has not refused that credential, the
 * day is open and the service is up. Every one of those survives an uploader
 * that is wedged — a captive wifi that answers every request with its own
 * login page, a token the far end has stopped taking for a reason that is not
 * a refusal, a socket that times out for ever. The recorder goes on believing
 * it is the sender, so this function went on agreeing, so the app left the
 * queue alone — while the phone sat in its owner's hand, online, with the app
 * OPEN, holding hours of his route and able to post it in one pass.
 *
 * In production that ran from four in the afternoon until eleven at night on
 * a handset in constant contact with us, and it is invisible from every angle
 * but one: the buffer climbing, and the newest position in the office going
 * stale while `last_seen_at` moved every few minutes. Past
 * `serviceBufferCap` the OLDEST fixes are then dropped, so a wedge long
 * enough stops being a delay and becomes a morning nobody has.
 *
 * **SO THE APP TAKES THE QUEUE BACK ON EVIDENCE, never on the belief.** Not
 * one batch accepted for longer than any honest retry could account for, AND
 * fixes actually held: two facts the recorder reports about itself rather
 * than a verdict this side invents.
 *
 * Both halves are load bearing. Without the buffer check this would accuse a
 * recorder that has sent nothing because it has had nothing to send, which is
 * every phone on a quiet afternoon — an absence read as a fault. Without the
 * silence check it would take the queue off a recorder that is working.
 *
 * **AND TAKING IT BACK IS SAFE WHEN THIS SIDE CANNOT SEND EITHER.** A phone
 * out of signal fails the same test, and the handover still helps: the rows
 * move out of the recorder's own ring buffer — which drops its oldest to stay
 * under the cap — and into `positions`, which is a table and drops nothing.
 * The worst case is the fixes going up twice, and a fix's id is its own
 * reading, so both ends conflict-ignore and the cost is one round trip.
 */
export function chooseSender(input: {
  /** Is the native module in this binary at all? */
  serviceAvailable: boolean;
  /**
   * Does the recorder say it is sending? False covers both "switched off" and
   * "I have nothing to authenticate with", which are different faults with the
   * same answer: somebody else has to drain this.
   */
  nativeUploads: boolean;
  /**
   * Seconds since the recorder last had a batch ACCEPTED — the one reading in
   * its report that is an outcome rather than a belief. Null is "it never
   * has", which on a recorder that is holding fixes is the worst version of
   * this rather than the innocent one.
   *
   * OPTIONAL, because an answer nobody passed is an answer nobody has, and
   * the safe reading of that is today's behaviour. A caller that cannot say
   * leaves the queue where it is.
   */
  lastUploadAgoSeconds?: number | null;
  /**
   * Fixes held natively and not yet handed over. Null is "this build cannot
   * say" and is never read as zero — and never as "something is stuck"
   * either, which is why an unknown buffer leaves the recorder alone.
   */
  buffered?: number | null;
}): 'native' | 'js' {
  if (!input.serviceAvailable || !input.nativeUploads) return 'js';
  return wedged(input) ? 'js' : 'native';
}

/**
 * How long a recorder that says it is sending may send nothing before the app
 * stops believing it.
 *
 * It is deliberately well ABOVE `CEILING_MS` below, which is the longest the
 * recorder's own retry curve ever waits. At five minutes a handset with a bad
 * patch of signal is walking up that curve perfectly correctly, and reading
 * three ordinary retries as a wedge would hand the queue back and forth all
 * afternoon. Three ceilings of silence is not a patch of signal any more.
 *
 * Like the ceiling it sits under, this is a retry curve rather than a product
 * decision, so it is not configuration: there is no screen on which "how long
 * before the app stops trusting the recorder" is a sentence anybody can
 * answer.
 */
const WEDGED_MS = 15 * 60_000;

function wedged(input: { lastUploadAgoSeconds?: number | null; buffered?: number | null }): boolean {
  const held = input.buffered;
  /* Nothing stuck, or no way to know: there is nothing for a second sender to
     rescue, and a handover on an unknown is a guess. */
  if (typeof held !== 'number' || !Number.isFinite(held) || held <= 0) return false;

  const ago = input.lastUploadAgoSeconds;
  /* Holding fixes and never once accepted. Nothing about this recorder's
     sending has ever worked, so waiting for it to start is waiting on the
     only evidence there is saying it will not. */
  if (ago === null || ago === undefined) return true;
  if (!Number.isFinite(ago)) return false;
  return ago * 1_000 > WEDGED_MS;
}

/* ----------------------------------------------------------------- backoff */

/** What the last attempt came to. */
export type UploadOutcome =
  /** Rows went up and the server took them. */
  | 'sent'
  /** The buffer was empty. Not a failure and must not be treated as one. */
  | 'nothing-to-send'
  /** A refusal, a torn connection, a body that would not parse. */
  | 'failed'
  /** There is no usable network. Asking again in six seconds asks the radio. */
  | 'offline'
  /**
   * `no-session-yet` — the server has no working day these fixes could belong
   * to, almost always a check-in still sitting in the outbox. Nothing is
   * wrong with the connection and nothing is wrong with the fixes.
   */
  | 'not-yet-fileable'
  /**
   * No credential, or one the server will not take any more. Nothing will
   * change until the app runs and hands over a fresh one.
   */
  | 'blocked';

/**
 * The longest this will ever wait before trying again.
 *
 * Past five minutes the live pin has stopped being live in any sense a manager
 * would recognise, so there is nothing to buy by waiting longer — and on the
 * other side, a phone in a district with no signal is woken twelve times an
 * hour rather than six hundred, which is the whole point of having a ceiling.
 *
 * It is NOT configuration and the cadence beside it is. The cadence is a
 * decision about the product — how fresh the office's answer is, against the
 * battery of a phone that has to last a day — and somebody will want to change
 * it. This is a retry curve: the shape of what to do when the thing that was
 * decided cannot be done, which nobody sets from a screen and which has no
 * honest units on one.
 */
const CEILING_MS = 5 * 60_000;

/**
 * A shorter ceiling for the one failure that is somebody else arriving.
 *
 * `no-session-yet` ends the moment the check-in behind it syncs, which is
 * usually the very next outbox pass. Climbing to five minutes there would have
 * the trail sitting on its hands for five minutes after the thing it was
 * waiting for had already landed.
 */
const SETTLE_CEILING_MS = 60_000;

/** Doubling past this stops meaning anything and starts overflowing. */
const MAX_DOUBLINGS = 20;

/**
 * How long to wait before the next attempt.
 *
 * `consecutiveFailures` is the number of attempts that have failed IN A ROW,
 * counted by the caller and reset by anything that worked — including an empty
 * buffer, because a recorder with nothing to send is not a recorder that
 * cannot send.
 *
 * The curve is the ordinary doubling one, and the two things worth noticing
 * are the cases that do NOT climb it. `offline` goes straight to the ceiling
 * rather than walking up to it: the radio is what a wake costs, and a dozen
 * wakes to establish something `ConnectivityManager` already said is a dozen
 * wakes spent proving a known fact. `blocked` does the same for the same
 * reason — nothing about waiting changes whether this handset holds a token.
 */
export function backoffDelayMs(input: {
  cadenceMs: number;
  consecutiveFailures: number;
  outcome: UploadOutcome;
}): number {
  const cadence = Number.isFinite(input.cadenceMs) && input.cadenceMs > 0 ? input.cadenceMs : 1_000;

  switch (input.outcome) {
    case 'sent':
    case 'nothing-to-send':
      return cadence;
    case 'offline':
    case 'blocked':
      return CEILING_MS;
    case 'not-yet-fileable':
      return Math.min(SETTLE_CEILING_MS, climb(cadence, input.consecutiveFailures));
    case 'failed':
      return Math.min(CEILING_MS, climb(cadence, input.consecutiveFailures));
  }
}

function climb(cadenceMs: number, failures: number): number {
  const n = Number.isFinite(failures) && failures > 0 ? Math.min(failures, MAX_DOUBLINGS) : 0;
  return cadenceMs * 2 ** n;
}
