/**
 * §9's CONFIRM · CORRECT · UNABLE TO VERIFY, as RULES rather than as a screen.
 *
 * These three came out of `components/leads/verify-field-row.tsx`, which
 * imports React Native and therefore cannot be exercised without a device —
 * and the handset's test script says so in its own glob, which reaches
 * `components/ui/*.test.ts` and no `.tsx` anywhere. So a refusal that decides
 * whether six answers may be saved, and the shape of the record those answers
 * become, were both written to be testable and tested by nothing.
 *
 * It is the same argument `engines/` rests on and the same one that let the
 * `customerStage` bug survive: a rule that cannot be run without a handset is
 * a rule nobody checks. Pure, no I/O, no clock — `at` is passed in — so the
 * component renders and this decides.
 */

import { findingLabel } from './funnel';

export type VerifyVerdict = 'confirmed' | 'corrected' | 'unverified';

/** One field's answer while the form is open. */
export type VerifyAnswer = {
  verdict: VerifyVerdict | null;
  /** What he says it actually is. Only ever read under `corrected`. */
  corrected: string;
  /** Why the two differ. Required under `corrected`, offered under the third. */
  reason: string;
};

export const BLANK_VERIFY: VerifyAnswer = { verdict: null, corrected: '', reason: '' };

/* ------------------------------------------------------- the refusal, stated */

/**
 * The sentence that goes on `whyDisabled`, or null where nothing is missing.
 *
 * Said BEFORE the button is pressed: being refused afterwards loses whatever
 * the salesman had in mind, and on this form it would lose the other seven
 * answers with it. It names the field, because "a correction needs a reason"
 * over six rows is a refusal somebody has to go hunting through.
 *
 * Pure, and it takes the labels rather than looking them up, so the sentence a
 * salesman reads names the field in the same words the row above it does.
 */
export function correctionRefusal(
  answers: Record<string, VerifyAnswer>,
  labels: Record<string, string>,
): string | null {
  for (const [field, a] of Object.entries(answers)) {
    if (a.verdict !== 'corrected') continue;
    const what = labels[field] ?? findingLabel(field);
    if (!a.corrected.trim()) {
      return `Say what ${what.toLowerCase()} actually is — or go back to Confirm if it was right.`;
    }
    if (!a.reason.trim()) {
      return `Say why ${what.toLowerCase()} has changed. A correction with no reason reads later as somebody having written it down wrong.`;
    }
  }
  return null;
}
/* ------------------------------------------------- what the record looks like */

/**
 * One field, checked once, by somebody, on a day.
 *
 * The office's own row — `lead_verification_corrections` — is the same pair
 * plus its author and its date, and it is append-only for the reason every
 * append-only table here is: a check recorded wrongly is answered by a further
 * check, never by an edit, because the row records what somebody believed on a
 * day and a rewrite destroys the question rather than answering it.
 *
 * All THREE verdicts are kept, not only the corrections. A confirmation is the
 * evidence that somebody asked again and got the same answer, which is the
 * whole of what a second visit buys; dropping it would leave a record where
 * only disagreements were ever checked.
 */
export type FieldCheck = {
  field: string;
  verdict: VerifyVerdict;
  /** What the record held when he was asked. A COPY, for the reason the
      office's table gives: the lead's own column is live and a later visit
      legitimately overwrites it, so reading it back in March would answer with
      whatever the field says then. */
  original: string | null;
  /** Null unless the verdict is `corrected`. */
  corrected: string | null;
  reason: string | null;
  changedById: string | null;
  /** Readable after the account is gone, like `customer_am_changes`. */
  changedByName: string | null;
  /** Epoch milliseconds, like every other instant on this wire. */
  at: number;
};

/** The answers on the screen, as rows. Pure — `at` is passed in rather than
    read, because nothing here may read the clock during a render. */
export function fieldChecksFrom(
  answers: Record<string, VerifyAnswer>,
  originals: Record<string, string>,
  who: { id: string; name: string } | null,
  at: number,
): FieldCheck[] {
  const rows: FieldCheck[] = [];
  for (const [field, a] of Object.entries(answers)) {
    if (!a.verdict) continue;
    rows.push({
      field,
      verdict: a.verdict,
      original: originals[field]?.trim() || null,
      corrected: a.verdict === 'corrected' ? a.corrected.trim() : null,
      reason: a.reason.trim() || null,
      changedById: who?.id ?? null,
      changedByName: who?.name ?? null,
      at,
    });
  }
  return rows;
}
