import { isoDate } from './format';
import { bandOf, isOnTheBookAt } from '../engines/funnel/lead-ladder';
import type { LeadSalesType, LeadStage } from '../engines/funnel/lead-labels';

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

/**
 * The other direction, for a lead the OFFICE holds.
 *
 * `won` becomes `Converted`, which is the same swap `wireStage` makes going
 * out, read backwards — and the reason this is a second table rather than an
 * inversion of the first is that `STAGES` is not injective: `converted` and
 * `won` both map to `won`, so reversing it would have to pick one and would
 * pick wrong half the time.
 *
 * An unrecognised stage becomes `New` rather than being dropped. The stage
 * column is what the filter chips select on, so a value none of them names is
 * a lead that exists and cannot be found on any chip — worse than one filed a
 * rung too early, which the next stage change corrects.
 */
const LOCAL_STAGES: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  negotiation: 'Negotiation',
  won: 'Converted',
  converted: 'Converted',
  lost: 'Lost',
};

export function localStage(stage: string | undefined): string {
  return LOCAL_STAGES[(stage ?? 'new').trim().toLowerCase()] ?? 'New';
}

/* --------------------------------------------------- the funnel's rungs */

/**
 * The specification's twenty-three rungs, going out.
 *
 * A funnel stage is stored as its CODE on both ends — `sample_review` is
 * `sample_review` here and there — so this is a validation rather than a
 * translation, and that is exactly why it has to exist. `LeadStage` is a
 * TypeScript union and the column is TEXT; a rung that is not one of the
 * twenty-three would be refused for the whole lead, taking the note, the next
 * action and the qualification answers with it. Undefined leaves the stage
 * where it was, which is the smaller of the two wrong answers — the same rule
 * `wireStage` follows above.
 *
 * TODO(integration): `leadSchema.stage` in `src/lib/actions/mbos.ts` is still
 * the six legacy values, so every rung below outside those six is currently
 * rejected by zod. Workstream A widens it to `LeadStage` — the column
 * `customers.lead_stage` is already `mbos_lead_stage` and holds all of them.
 */
const FUNNEL_STAGES = new Set<string>([
  'new', 'contacted', 'qualified', 'negotiation', 'won', 'lost',
  'suspect', 'prospect', 'qualification', 'sample_trial', 'sample_received',
  'sample_review', 'first_order', 'delivery', 'payment', 'second_order',
  'customer', 'management_review', 'commercial_discussion',
  'distributor_approval', 'distributor_agreement', 'initial_stock_order',
  'active_distributor',
]);

export function wireFunnelStage(stage: string | null | undefined): string | undefined {
  const s = (stage ?? '').trim().toLowerCase();
  return FUNNEL_STAGES.has(s) ? s : undefined;
}

export function localFunnelStage(stage: string | null | undefined): LeadStage | null {
  const s = wireFunnelStage(stage);
  return s ? (s as LeadStage) : null;
}

/**
 * The rung, said in the six words this app's filter chips select on.
 *
 * The two columns are kept in step HERE and nowhere else. `funnelStage` is the
 * truth about where a lead stands; `stage` is what the list draws and filters,
 * and a lead whose `stage` reads `sample_review` sits on no chip at all — it
 * exists and cannot be found, which is worse than being filed a rung early.
 *
 * `bandOf` is the same four-band reading the console's funnel bar and the
 * owner's cohort take, so a lead is in the same band on a phone and on a
 * report. The terminal rungs are outside every band by design, and they are
 * the two words this app already had for them.
 */
export function legacyStageFor(
  funnelStage: string | null | undefined,
  salesType: LeadSalesType | null | undefined,
): string {
  const s = localFunnelStage(funnelStage);
  if (!s) return 'New';
  if (s === 'lost') return 'Lost';
  /* On the book is `Converted` here, and `isOnTheBookAt` is asked rather than
     the band — a lead at `first_order` is in the funnel's Negotiation band and
     is plainly an account we have sold to, and this app's own word for that
     has always been Converted. The two questions have different answers on
     five rungs and the band is the wrong one to ask on a phone. */
  if (isOnTheBookAt(s, salesType)) return 'Converted';
  switch (bandOf(s)) {
    case 'new': return 'New';
    case 'contacted': return 'Contacted';
    case 'qualified': return 'Qualified';
    case 'negotiation': return 'Negotiation';
    default: return 'New';
  }
}

/**
 * The office's single note field as the list this app keeps.
 *
 * `notesOf` already reads a bare string as one undated note, so writing the
 * office's sentence straight through would render correctly — and then the
 * first local `addNote` would append to a list built from it and the office's
 * own dates would be gone. One note, dated to when it arrived, keeps the
 * append working and never claims a date the office did not give.
 */
export function localNotes(notes: string | undefined | null, at: number): string | null {
  const text = (notes ?? '').trim();
  return text ? JSON.stringify([{ at, text }]) : null;
}

/**
 * A sample's state, which the wire does not carry and the screen is built on.
 *
 * MahekOne tracks `trial_outcome` and the two timestamps; the design tracks one
 * word. Converted beats delivered beats requested, in that order, because that
 * is the order they happen in and the latest fact is the true one. Derived here
 * rather than sent so the wire keeps MahekOne's vocabulary — which is the whole
 * point of this file.
 */
export function localSampleState(s: {
  convertedOrderId?: string | null;
  deliveredAt?: string | number | null;
  trialOutcome?: string | null;
}): string {
  if (s.convertedOrderId) return 'Converted';
  if (s.trialOutcome === 'rejected') return 'Rejected';
  if (s.deliveredAt) return 'Awaiting feedback';
  return 'Requested';
}

/**
 * An instant off the wire as the epoch milliseconds every local column holds.
 *
 * A DATE IS NOT AN INSTANT UNTIL SOMETHING NAMES THE MIDNIGHT, which is the
 * same rule MahekOne states three times over about its own SQL, arriving here
 * in a third set of clothes. `Date.parse('2026-09-08')` is specified to read a
 * date-only string as UTC, so a `requestedDate` would land five and a half
 * hours before the day it names — invisible on a handset in IST, where it
 * still formats to the right date, and wrong the moment anything compares it
 * to a local day boundary. A date means local midnight to the person holding
 * the phone, so it is spelled that way; a full ISO instant carries its own
 * zone and is left alone.
 *
 * Null rather than `NaN` where it will not parse: a column that says nothing
 * is honest, and `NaN` in an INTEGER column compares false against everything
 * and is never noticed.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function localInstant(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(DATE_ONLY.test(value.trim()) ? `${value.trim()}T00:00:00` : value);
  return Number.isNaN(ms) ? null : ms;
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
