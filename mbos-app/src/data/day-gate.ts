import { setKv } from '../db';
import { getConfig } from './config';
import { phoneReadiness, type ReadinessItem } from '../engines/phone-readiness';
import { ACK_KEY, readFacts } from './phone-readiness';

/**
 * WHETHER THIS PHONE MAY OPEN A DAY AT ALL.
 *
 * A field salesman on a vivo checked in at 04:16 and posted not one position
 * for the whole day. Every permission on the handset read correct — the
 * background grant was genuinely held, `startLocationUpdatesAsync` genuinely
 * answered yes — and Funtouch's battery manager killed the foreground service
 * behind it within minutes. The office saw a man standing at his check-in
 * point until evening. Nothing on either end was broken, nothing logged, and
 * the day was unrecoverable by the time anybody looked, because a trail cannot
 * be reconstructed after the fact.
 *
 * So the decision is to STOP THE DAY rather than record it and hope. That
 * reverses this module's oldest rule — `attendance.ts` says in as many words
 * that a check-in is never blocked by a location, and every word of that still
 * stands: a poor fix, no fix, a refused geofence are all RECORDED and the day
 * starts, because a salesman who cannot mark attendance cannot work. This is
 * not that. A missing fix costs one coordinate on one mark; a phone that will
 * not run the tracking service costs the entire record of where a man spent a
 * working day, and he finds out at six in the evening, by which time there is
 * nothing to be done about it.
 *
 * **THE SELFIE IS THE PRECEDENT, and it is exact.** That one is mandatory, it
 * is mandatory BY THE TYPE rather than by the screen, and its "Start the day
 * without a photo" button was removed because a skip produced two kinds of day
 * nobody could tell apart afterwards — some proved something, some proved
 * nothing, and nothing on the record said which. A skippable trail gate is the
 * same shape: a day that opened on a phone that could not record it, filed
 * beside one that could, indistinguishable a week later.
 *
 * **WHERE THE PHONE GENUINELY CANNOT, THE ANSWER IS A DEAD END SAID IN
 * WORDS.** Not a skip button, not an override, not a warning nobody reads —
 * the same shape as a refused camera permission, which this app already treats
 * as a real dead end rather than working around itself. `deadEnd` is that
 * answer travelling out of here; `app/phone-setup.tsx` is what says it.
 *
 * **AND IT IS CONFIGURATION, because a gate that locks a workforce out of its
 * own attendance is the last thing that should be a literal.** See
 * `mbos.location.startOfDayGate`. The default is `block`, which is Mahek's
 * decision and not this file's opinion.
 */

/** What the office has decided this gate does. */
export type GateLevel = 'block' | 'warn' | 'off';

/**
 * THE PROOF THAT THE QUESTION WAS ASKED, and the reason `checkIn` takes one.
 *
 * `unique symbol` is what makes it unforgeable: the property cannot be written
 * anywhere outside this module, so `mayOpenDay()` is the only thing in the app
 * that can produce one of these and no screen can hand `checkIn` a cheerful
 * object literal. That is the selfie's own discipline — "a screen that forgets
 * to ask is a screen, and a parameter that cannot be omitted is the rule" —
 * carried one step further, because a plain `readiness: boolean` parameter
 * would be both unomittable and trivially answered `true` by a caller in a
 * hurry.
 */
declare const proved: unique symbol;

export type DayMayOpen = {
  readonly [proved]: true;
  /**
   * WHAT THE PHONE COULD CHECK, as it stood at the moment the day opened.
   *
   * True is a clean start. False is a day that opened anyway — on a claim, or
   * because a manager has the gate at `warn` — and without it those two would
   * arrive at the office looking exactly like a day that had nothing wrong
   * with it. That is the same loss the selfie's skip button produced and the
   * reason it was removed: two kinds of day, indistinguishable afterwards.
   */
  readonly ready: boolean;
  /**
   * When he said he had done the steps the phone cannot check, or null where
   * nothing needed saying.
   *
   * A CLAIM, NEVER A PROOF, and every screen that renders it has to say so.
   * No Android API reports whether an OEM battery manager will kill a
   * foreground service; the only available evidence is the man saying he went
   * into the settings and allowed it, and then the trail either appearing or
   * not. The office gets both halves — see `handset-health.ts`, where a day
   * opened on a claim that then produced no trail is the one pattern worth a
   * sentence of its own.
   */
  readonly acknowledgedAt: number | null;
  /**
   * The rows that were not ticked as the day opened — the engine's own item
   * keys, and the shortest honest answer to "why was he stopped".
   *
   * Read from THIS morning's reading rather than from the claim, which may
   * have been made days earlier: what is worth knowing in the office is what
   * was outstanding when the day started, not what was outstanding when he
   * last pressed a button.
   */
  readonly unverified: readonly string[];
};

/** Refused, with everything the screen needs to explain itself. */
export type GateRefusal = {
  ok: false;
  /**
   * Nothing he can do on this handset will satisfy it — the location
   * permission is refused at the OS level and MahekOne cannot ask again, or
   * the device's own location is off and this build cannot reach the toggle.
   * The screen says so plainly instead of offering a step that leads nowhere.
   */
  deadEnd: boolean;
  items: ReadinessItem[];
};

export type GateAnswer = { ok: true; gate: DayMayOpen } | GateRefusal;

/**
 * Where the claim is kept. One per handset, not one per day — see below.
 *
 * WRITTEN HERE AND READ IN `phone-readiness.ts`, which hands it to the engine
 * as an input: a standing claim is what lets a phone past the rows nothing can
 * verify. The gate owns the writing because the gate is what spends it, and
 * one key rather than two because a screen ticking a row the gate had never
 * heard of would refuse a man the day he had just been told he could start.
 *
 * So the NAME is imported rather than respelled. It was typed out in both
 * files for an afternoon, which is the shape every silent failure in this
 * subsystem has had: two halves joined by nothing but a string, where a change
 * to one leaves the other reading a key nobody writes and the gate quietly
 * stops being able to spend a claim anybody made. It is declared beside the
 * read because the gate already imports that module and the reverse would be
 * a cycle.
 */

type Ack = { at: number; items: string[] };

/**
 * He says he has done the steps the phone cannot check.
 *
 * Called by `app/phone-setup.tsx` and by nothing else. `items` is what that
 * screen was still asking him for at the moment he pressed it — it is stored
 * with the claim and sent to the office with the day, because "he said he did
 * the battery steps" and "he said he did them while three things were still
 * outstanding" are different facts about the same press.
 *
 * IT IS NOT DATED TO A DAY, deliberately. What he changed is a phone setting,
 * and a setting does not expire overnight — asking him again every morning
 * would train him to press it without reading it, which is how an
 * acknowledgement stops meaning anything. What makes a stale claim visible is
 * not a clock here but the trail: a handset opening day after day on a claim
 * and producing nothing is a man who has pressed the button twice and is still
 * not being recorded, and that is a sentence on the office's own screen rather
 * than a refusal on his.
 */
export async function acknowledgePhoneSetup(items: readonly string[]): Promise<void> {
  const ack: Ack = { at: Date.now(), items: [...items] };
  await setKv(ACK_KEY, JSON.stringify(ack));
}

/**
 * May a day be opened right now, and if not, what is to be said about it.
 *
 * The reading is `readFacts` next door and the rule is the pure engine beside
 * that; what lives here is the CONSEQUENCE, which is the only part a screen
 * could get wrong twice.
 *
 * THE ENGINE IS ASKED TWICE OVER ONE READING, and the second answer is the one
 * the office never had. `phoneReadiness` already takes the acknowledgement as
 * an input — a standing claim is what lets a phone past the rows nobody can
 * verify — so its `mayCheckIn` cannot say whether this day would have opened
 * on its own merits. Asking again with the claim removed says exactly that,
 * costs nothing (both calls are pure, over facts already gathered, and the
 * native reading is not repeated) and is what makes a clean day and a claimed
 * one distinguishable at the far end. Without it they arrive identical, which
 * is the loss the attendance selfie's skip button produced.
 *
 * - **`mayCheckIn`** — the day opens. Clean where it would have opened with no
 *   claim, on the claim where it would not, and the row says which.
 * - **refused** — at `block`, the day does not open and the screen says what
 *   is missing. `deadEnd` is the case an override would be worst in: a phone
 *   whose location permission Android will no longer even offer to ask for
 *   will not produce a trail however firmly anybody presses a button, so a
 *   button that opened the day would be a lie told at nine and discovered at
 *   six.
 *
 * `warn` and `off` skip none of the reading — they change only what is DONE
 * with it, and what happened is recorded either way. A deployment that has
 * turned the gate down still wants the office to be able to count the handsets
 * it would have stopped.
 */
export async function mayOpenDay(userId: string | null): Promise<GateAnswer> {
  const level = await getConfig<GateLevel>('mbos.location.startOfDayGate', 'block');

  let facts;
  try {
    facts = await readFacts(userId);
  } catch {
    /* THE GATE'S OWN FAILURE IS NOT THE SALESMAN'S. A native call that throws
       on a handset nobody has tested is a bug here, and refusing his day over
       it would take a whole workforce off attendance for as long as it took
       somebody to notice. The day opens exactly as it did before any of this
       existed, and `ready` is left TRUE rather than false: false is a claim
       about his phone, and nothing was established about his phone. */
    return { ok: true, gate: mark(true, null, []) };
  }

  const verdict = phoneReadiness(facts);
  /* What the phone would have answered with nothing claimed. */
  const ready = phoneReadiness({ ...facts, acknowledgedAt: null }).mayCheckIn;
  const outstanding = unverifiedKeys(verdict.items);

  if (verdict.mayCheckIn) {
    return {
      ok: true,
      gate: ready ? mark(true, null, []) : mark(false, facts.acknowledgedAt, outstanding),
    };
  }

  /* Off and warn let the day through, and the second one is the reason both
     exist. `off` is a deployment that does not want this at all. `warn` is the
     week a deployment turns it on: the day opens, the reading is still taken,
     and the office can count who would have been stopped before anybody is —
     which is how a gate this consequential reaches nine handsets without a
     morning of nobody being able to mark attendance. Neither is a skip the
     salesman can reach; only a manager, on the Settings screen. */
  if (level !== 'block') return { ok: true, gate: mark(false, facts.acknowledgedAt, outstanding) };

  return { ok: false, deadEnd: verdict.deadEnd, items: verdict.items };
}

/**
 * The rows that were not ticked when the day opened.
 *
 * Taken from the reading rather than from the stored claim, because the two
 * answer different questions: the claim records what was outstanding when he
 * pressed the button, which may have been days ago, and this records what was
 * outstanding this morning. `unknowable` counts — it is the autostart row, the
 * one nothing can check and the one this whole gate exists because of, and
 * leaving it out would report a day as having nothing outstanding when the
 * thing that killed the vivo's trail was the only thing outstanding.
 */
function unverifiedKeys(items: readonly ReadinessItem[]): string[] {
  return items.filter((x) => x.state !== 'ok').map((x) => x.key);
}

function mark(
  ready: boolean,
  acknowledgedAt: number | null,
  unverified: readonly string[],
): DayMayOpen {
  return { ready, acknowledgedAt, unverified } as DayMayOpen;
}
