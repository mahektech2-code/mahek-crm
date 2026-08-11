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
  key: 'gps' | 'dwell' | 'photo' | 'followon' | 'outcome';
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
  hasShopPhoto: boolean;
  outcome: OutcomeKey | null;
  followOnCaptured: boolean;
};

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
      ok: f.gpsLocked && (unlocated || near),
      line: !f.gpsLocked
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
  ];
}

export function visitVerdict(checks: VisitCheck[]) {
  const failed = checks.filter((c) => !c.ok);
  return {
    failed,
    verified: failed.length === 0,
    title: failed.length ? 'Before you can save this' : 'Everything checks out',
    blockedLine: plural(failed.length, 'thing') + ' missing before this can be saved',
    firstFailure: failed[0]?.line ?? '',
    overrideBody:
      'This visit does not meet ' +
      plural(failed.length, 'requirement') +
      '. It will be saved, marked unverified, and sent to your manager to confirm.',
  };
}

export function elapsedLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
