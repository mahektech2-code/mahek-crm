import { plural } from './format';
import type { OutcomeKey } from '../data/fixtures';

/**
 * What makes a visit real, expressed as data rather than as five conditions
 * scattered through a screen.
 *
 * This is the rule the design is most opinionated about, and it is worth
 * stating plainly: a visit can ALWAYS be saved. What the checks decide is
 * whether it is saved as verified, or saved unverified with a reason attached
 * and the manager told. Blocking the save outright would teach people to stop
 * logging visits, which costs more than a handful of doubtful ones.
 *
 * **That is still true, and the CHECK-IN is now a different question.** The
 * gate Mahek asked for sits on the arrival — `checkInVerdict` in
 * `engines/geo.ts` — where a refusal costs a walk to the right door rather
 * than a day's work, because he has not typed anything yet. By the time this
 * file is consulted the visit exists, the note is written and the photograph
 * is taken, and there is nothing here worth refusing.
 *
 * Pure on purpose — no clock, no GPS, no store. Everything it needs arrives as
 * an argument, so the thresholds can be tested without a device.
 */

/* The thresholds are NOT constants here. They arrive as arguments, from
   `mbos.visit.minimumDwellSeconds` and `mbos.location.visitMismatchM`, because
   a floor a manager may want to move is configuration wherever it is read. */

/**
 * An outcome that implies work is only complete once that work exists. Marking
 * "Order taken" and saving nothing leaves the office with a visit that claims
 * an order nobody can find.
 */
export const FOLLOW_ON: Partial<Record<OutcomeKey, { label: string; word: string; line: string; cta: string }>> = {
  order: {
    label: 'Order',
    word: 'order',
    line: 'Take the order without leaving this visit.',
    cta: 'Punch the order',
  },
  payment: {
    label: 'Payment',
    word: 'receipt',
    line: 'Collect it now and the receipt goes out on WhatsApp.',
    cta: 'Collect payment',
  },
  complaint: {
    label: 'Complaint',
    word: 'complaint',
    line: 'Log what they said so the desk team picks it up today.',
    cta: 'Log the complaint',
  },
  sample: {
    label: 'Sample request',
    word: 'request',
    line: 'Request the sample and set the trial follow-up.',
    cta: 'Request a sample',
  },
};

export type VisitCheck = {
  key: 'gps' | 'dwell' | 'photo' | 'followon' | 'outcome' | 'note';
  ok: boolean;
  line: string;
  /** Only shown when the check has failed — the reason the rule exists at all. */
  why: string;
};

export type VisitFacts = {
  gpsLocked: boolean;
  /**
   * Null when there is nothing to measure against — a shop whose coordinates
   * were never captured. Zero would read as "standing in the doorway", which
   * is a different claim entirely.
   */
  metresAway: number | null;
  dwellSeconds: number;
  /** `mbos.visit.minimumDwellSeconds`. */
  minimumDwellSeconds: number;
  /** `mbos.location.visitMismatchM`. */
  maxMetresFromShop: number;
  /**
   * He was refused at the door and said in writing that the pin is wrong.
   *
   * The check reads OK on this, and that is not the gate leaking: the question
   * "are you at the shop" has already been PUT to him, at the moment he was
   * standing there, and answered with a sentence his manager will read. Asking
   * it again on the save screen would be the app arguing with its own refusal
   * and would cost a second typed reason for one visit. The visit still saves
   * UNVERIFIED — `saveAndGo` sets that from the same reason — so nothing about
   * what the office is told changes; what changes is that he is asked once.
   */
  checkInOverridden: boolean;
  hasShopPhoto: boolean;
  outcome: OutcomeKey | null;
  followOnCaptured: boolean;
  /** How much he has written about the visit, trimmed. */
  noteChars: number;
  /** `mbos.visits.minimumNoteChars` — the least that counts as saying what happened. */
  minimumNoteChars: number;
};

/**
 * THE QUESTIONS, as against the evidence.
 *
 * GPS, time in the shop and the photograph are EVIDENCE: a salesman may be
 * unable to produce them for reasons that are not his fault, and "save it
 * unverified with a reason" exists for exactly that. The outcome, its
 * follow-on and the note are ANSWERS — only he can give them, nothing stops
 * him giving them, and a visit without them tells the office nothing. So an
 * unverified save waives the first kind and never the second.
 */
export const ANSWER_KEYS: ReadonlyArray<VisitCheck['key']> = ['outcome', 'followon', 'note'];

/** The answers still owed, in the order the check-out sheet asks them. */
export function unansweredQuestions(checks: VisitCheck[]): VisitCheck[] {
  return ANSWER_KEYS.map((k) => checks.find((c) => c.key === k)).filter(
    (c): c is VisitCheck => !!c && !c.ok,
  );
}

/**
 * Whether this outcome needs a written account at all.
 *
 * Every visit where somebody was spoken to does — what was discussed, what
 * they said, what happens next — because that is the whole of what a manager
 * or the next visitor gets. A shop found shut has nothing to report beyond
 * the outcome itself, and demanding a sentence there teaches people to type
 * one to get past the box.
 */
export function outcomeNeedsNote(outcome: OutcomeKey | null): boolean {
  return outcome !== 'closed';
}

export function visitChecks(f: VisitFacts): VisitCheck[] {
  const fo = f.outcome ? FOLLOW_ON[f.outcome] : undefined;
  const mins = Math.floor(f.dwellSeconds / 60);
  const secs = f.dwellSeconds % 60;
  const dwellOk = f.dwellSeconds >= f.minimumDwellSeconds;
  const floor =
    f.minimumDwellSeconds >= 60
      ? plural(Math.round(f.minimumDwellSeconds / 60), 'minute')
      : plural(f.minimumDwellSeconds, 'second');
  /* No coordinate on the shop is not a mismatch — there is nothing to disagree
     with, and refusing on it would punish the salesman for a gap in the book. */
  const unlocated = f.metresAway == null;
  const near = !unlocated && (f.metresAway as number) <= f.maxMetresFromShop;

  return [
    {
      key: 'gps',
      ok: f.checkInOverridden || (f.gpsLocked && (unlocated || near)),
      line: f.checkInOverridden
        ? `Checked in ${f.metresAway ?? '?'} m from the recorded address — you said the shop’s pin is wrong`
        : !f.gpsLocked
          ? 'No GPS fix yet'
          : unlocated
            ? 'This shop has no recorded location yet — nothing to compare against.'
            : near
              ? `At the shop · ${f.metresAway} m from the recorded address`
              : `${f.metresAway} m from the shop — too far to count as a visit`,
      why: 'A visit is logged against the shop’s address, not where the phone is.',
    },
    {
      key: 'dwell',
      ok: dwellOk,
      line: dwellOk
        ? `In the shop ${mins}m ${secs}s`
        : `Only ${f.dwellSeconds}s so far — a visit needs ${floor}`,
      why: 'Two minutes is the floor agreed with your manager.',
    },
    {
      key: 'photo',
      ok: f.hasShopPhoto,
      line: f.hasShopPhoto ? 'Shop photo taken' : 'Shop photo not taken',
      why: 'The photo is what the office sees when nobody was there.',
    },
    {
      key: 'followon',
      ok: !fo || f.followOnCaptured,
      line: !fo || f.followOnCaptured ? 'Follow-on captured' : `${fo.label} not captured yet`,
      why: fo
        ? `You marked this outcome — the ${fo.word} is what the office acts on.`
        : 'You marked this outcome — the follow-on is what the office acts on.',
    },
    {
      key: 'outcome',
      ok: !!f.outcome,
      line: f.outcome ? 'Outcome recorded' : 'How it went is not recorded yet',
      why: 'Everything after this visit depends on the outcome.',
    },
    (() => {
      const needed = outcomeNeedsNote(f.outcome);
      const ok = !needed || f.noteChars >= f.minimumNoteChars;
      return {
        key: 'note' as const,
        ok,
        line: !needed
          ? 'No note needed for a closed shop'
          : ok
            ? 'Visit notes written'
            : f.noteChars === 0
              ? 'Nothing written about the visit yet'
              : `Say a little more about the visit — ${f.minimumNoteChars - f.noteChars} more characters`,
        why: 'Write the points of the visit: what was discussed, what they said, and what happens next. It is all your manager and the next visit will have.',
      };
    })(),
  ];
}

/**
 * What the screen may say about the visit it is about to save.
 *
 * **NOTHING MISSING IS NOT THE SAME AS VERIFIED, and running the two together
 * made this screen say the opposite of what it then wrote.** The gps check
 * above reads OK on an overridden check-in — deliberately, so he is not asked
 * for a second sentence at the save — and with nothing else outstanding that
 * used to produce "Everything checks out", a green Ready badge and no warning
 * line, on a visit `saveAndGo` was about to mark unverified and raise a "Visit
 * saved unverified" bell for. He was told the visit was clean and then told it
 * was not, on a record his manager would question him about.
 *
 * So there are two answers rather than one. `complete` is whether the checklist
 * is satisfied, which is what keeps the save bar live — the override must not
 * cost him a second typed reason. `verified` is whether the record that lands
 * is a clean one, which is what the words and the badge are drawn from.
 */
export function visitVerdict(checks: VisitCheck[], f?: { checkInOverridden?: boolean }) {
  const failed = checks.filter((c) => !c.ok);
  const overridden = !!f?.checkInOverridden;
  const complete = failed.length === 0;
  return {
    failed,
    /** Nothing the checklist asks for is outstanding: the save may go ahead. */
    complete,
    /** …and the visit that lands is a clean one. */
    verified: complete && !overridden,
    title: !complete
      ? 'Before you can save this'
      : overridden
        ? 'This will save unverified'
        : 'Everything checks out',
    blockedLine: plural(failed.length, 'thing') + ' missing before this can be saved',
    firstFailure: failed[0]?.line ?? '',
    /**
     * The line the save bar carries above the button. It is the first missing
     * thing where something is missing, and otherwise the reason a complete
     * visit is still not a verified one — which is the case that used to print
     * nothing at all.
     */
    warning:
      failed[0]?.line ??
      (overridden
        ? 'You said the shop’s pin is wrong — this saves unverified and your manager reads your reason.'
        : ''),
    /* "does not meet 0 requirements" is what this said where nothing was
       outstanding, which is now a state somebody can reach — an overridden
       check-in leaves the checklist complete and the visit unverified. */
    overrideBody: complete
      ? 'This visit will be saved, marked unverified, and sent to your manager to confirm.'
      : 'This visit does not meet ' +
        plural(failed.length, 'requirement') +
        '. It will be saved, marked unverified, and sent to your manager to confirm.',
  };
}

export function elapsedLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/* ══════════════════════════════════════ arriving, and then going in */

/**
 * The two decisions behind an arrival, kept PURE and out of `data/arrival.ts`.
 *
 * That file imports the database, so nothing in it can be exercised without a
 * handset — and these two are exactly the kind of rule that is invisible when
 * it goes wrong. A stale arrival restored on the wrong morning offers to check
 * somebody into yesterday's last shop, and a second check-in that overwrote
 * the first would silently shorten every visit it happened on. Neither shows
 * up as an error anywhere.
 */

/** What an arrival needs to be judged, and nothing more. */
export type ArrivalFacts = { arrivedAt: number; checkedInAt: number | null; day: string };

/**
 * Is this arrival today's?
 *
 * An arrival from an earlier day is not restored: he did not go in, the day
 * has ended, and the journey behind it was closed at the boundary by
 * `closeStaleLegs`. Offering it back on Wednesday morning would put Tuesday's
 * last shop on the one bar this app never lets him dismiss.
 */
export function arrivalIsCurrent(arrival: ArrivalFacts, today: string): boolean {
  return arrival.day === today;
}

/**
 * Walking in, applied once.
 *
 * A second tap is a slip — a slow screen, or Android redrawing it — and
 * reading it as a second arrival would move the start of the visit forward and
 * take the difference off the dwell figure. The FIRST instant is the one he
 * walked in on, so it is the one that stands.
 */
export function withCheckIn<T extends ArrivalFacts>(arrival: T, now: number): T {
  return arrival.checkedInAt != null ? arrival : { ...arrival, checkedInAt: now };
}
