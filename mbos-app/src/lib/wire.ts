import { isoDate } from './format';

/**
 * The words this app shows, in the words MahekOne stores — PROTOCOL.md §4.1.
 *
 * One file, and pure, for two reasons.
 *
 * The mappings were missing entirely until the two halves were first run
 * against each other, and the reason nobody noticed is that NOTHING FAILS when
 * one is wrong: an unknown field is not an invalid one. Half the drift was
 * refused at the door with a message naming a word the salesman never typed,
 * and the other half was accepted and quietly dropped — a visit reaching the
 * office with a customer on it and nothing else, reported by neither end.
 *
 * And they are the kind of thing that can only be tested if it is a function.
 * A mapping written inline in a payload literal needs a device, a database and
 * a server to exercise, which means it is never exercised.
 *
 * The local tables keep the design's words, because the screens are built to
 * the design. The wire carries MahekOne's. This is the seam.
 */

/* ------------------------------------------------------------------ visits */

/**
 * They agree on six of the seven outcomes. `closed_now` is "Not available",
 * which MahekOne has always called `not_available` — and a visit carrying our
 * spelling was refused outright as an invalid outcome.
 */
const OUTCOMES: Record<string, string> = { closed_now: 'not_available' };

export function wireOutcome(outcome: string): string {
  return OUTCOMES[outcome] ?? outcome;
}

/* ------------------------------------------------------------------- leads */

/**
 * Five of the six stages are the same word in a different case. The sixth is
 * not: a lead that became a shop is `Converted` here and `won` there.
 */
const STAGES: Record<string, string> = {
  new: 'new',
  contacted: 'contacted',
  qualified: 'qualified',
  negotiation: 'negotiation',
  converted: 'won',
  won: 'won',
  lost: 'lost',
};

/**
 * Undefined where the stage is not one MahekOne holds. Sending an unknown one
 * would be refused for the whole lead; sending none leaves the stage where it
 * was, which is the smaller of the two wrong answers.
 */
export function wireStage(stage: string): string | undefined {
  return STAGES[stage.trim().toLowerCase()];
}

export type LeadNote = { at: number; text: string };

/**
 * The note list as one string.
 *
 * Notes are a list here because they are APPENDED and nothing overwrites; the
 * wire carries a single field. Flattening keeps the dates and the order, so
 * the office reads the same history rather than the last sentence somebody
 * typed. Nothing at all where there are no notes — an empty string is a value,
 * and on an update it would overwrite whatever the office already had.
 */
export function wireNotes(notes: LeadNote[]): string | undefined {
  if (!notes.length) return undefined;
  return notes
    .map((n) => (n.at ? `${isoDate(new Date(n.at))} — ${n.text}` : n.text))
    .join('\n')
    .slice(0, 4000);
}

/* ------------------------------------------------------------------- tasks */

/**
 * The design says Low, Normal and High; the database has known these as low,
 * medium and high since before this app existed. "Normal" is not a value it
 * accepts, so every task raised in the field was refused on a word the
 * salesman never typed — including the ones this app raises ITSELF when the
 * office rejects an order, which turned a failure to file one order into a
 * failure to file the reminder to ring the shop about it.
 */
const PRIORITIES: Record<string, string> = {
  low: 'low',
  normal: 'medium',
  medium: 'medium',
  high: 'high',
  urgent: 'high',
};

export function wirePriority(priority: string | undefined): string {
  return PRIORITIES[(priority ?? 'Normal').toLowerCase()] ?? 'medium';
}

/**
 * The other direction — a task the OFFICE raised, coming down. `medium`
 * becomes `Normal`, not `Medium`: the design never had a `Medium`, and a
 * value it does not recognise is a task that renders with nothing in its
 * priority chip rather than one that reads oddly.
 */
const LOCAL_PRIORITIES: Record<string, string> = {
  low: 'Low',
  medium: 'Normal',
  high: 'High',
};

export function localPriority(priority: string | undefined): string {
  return LOCAL_PRIORITIES[(priority ?? 'medium').toLowerCase()] ?? 'Normal';
}

/* -------------------------------------------------------------- complaints */

/**
 * The five categories on the buttons and the nine the column holds are two
 * different lists, and neither can be derived from the other — the CRM has the
 * same problem in reverse and answers it the same way, in
 * `lib/complaint-labels.ts`.
 *
 * Anything unrecognised becomes `other` rather than being refused. A complaint
 * filed under the wrong heading is still a complaint; one refused at the door
 * is a customer nobody rings back, and this is the one record in the app that
 * has to move fast.
 */
const COMPLAINT_CATEGORIES: Record<string, string> = {
  'late delivery': 'dispatch_delay',
  'damaged goods': 'packaging_damage',
  'wrong material': 'product_quality',
  'short quantity': 'shortage',
  'rate dispute': 'pricing',
};

export function wireComplaintCategory(category: string): string {
  return COMPLAINT_CATEGORIES[category.trim().toLowerCase()] ?? 'other';
}
