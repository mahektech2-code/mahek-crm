import React from 'react';
import { View } from 'react-native';
import { Choice, Input, T } from '../ui/primitives';
import { color as C, radius, weight } from '../../theme/tokens';
import { getKv, setKv } from '../../db';
import { findingLabel } from '../../engines/funnel';

/**
 * §9 — CONFIRM · CORRECT · UNABLE TO VERIFY, on the handset.
 *
 * The office has this already: `src/components/leads/record/verify/` draws it
 * against the nine findings, and a correction made there is a row in
 * `lead_verification_corrections` — the field, what the salesman had, what he
 * was told instead, and WHY the two differ. This is the same control for the
 * other end of the same book.
 *
 * **WHY IT EXISTS AT ALL IS THE BEFORE/AFTER PAIR.** A plain box over a value
 * somebody already wrote down is a silent overwrite: the earlier reading is
 * gone, nothing records that the two disagreed, and nobody afterwards can tell
 * a shop that changed its mind from a salesman who wrote the wrong figure
 * down in the first place. Those are different facts about a lead and the
 * second is the one worth knowing, because it is about our own man. §1's "one
 * book, no re-asking" is what this operationalises: a second visit CHECKS the
 * first rather than typing over it.
 *
 * **CONFIRMING AND FAILING TO CONFIRM ARE NOT THE SAME ANSWER.** "Unable to
 * verify" leaves the value exactly where it is, like a confirmation does, and
 * it means the opposite thing — we asked and could not establish it. Folding
 * the two together would hand a reader a figure that looks checked when
 * nobody could check it. It is the same rule `mbos_activity_locations` keeps
 * about a missing fix: no fix is a recorded fact, not a missing row.
 *
 * **AND A CORRECTION COSTS A SENTENCE.** Required, said before the button is
 * pressed rather than refused after it: a correction with nothing behind it is
 * this man's word against last month's with nothing to settle it, which is the
 * argument the record exists to prevent rather than to store.
 *
 * **IT IS OFFERED ONLY OVER A VALUE THAT EXISTS.** A field nobody has answered
 * falls back to a plain input, because "Confirm" over an empty box is asking
 * somebody to confirm nothing — and it would put a verdict on the record
 * saying a blank had been checked.
 */

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

const VERDICTS: readonly { v: VerifyVerdict; label: string; sub: string }[] = [
  { v: 'confirmed', label: 'Confirm', sub: 'Still right' },
  { v: 'corrected', label: 'Correct', sub: 'It has changed' },
  { v: 'unverified', label: 'Could not verify', sub: 'Nobody would say' },
];

const EDGE: Record<VerifyVerdict, string> = {
  confirmed: C.success,
  corrected: C.warn,
  unverified: C.border,
};

export function VerifyFieldRow({
  /** One of `VERIFICATION_FINDINGS` — a code, never a label. */
  field,
  /** What the record already holds, in the words a salesman would read it in. */
  reported,
  /** The screen's own heading for the field, where it is friendlier than the
      finding's own label — "Litres a month" beats "What they use in a month"
      on a phone. */
  label,
  answer,
  onChange,
  placeholder,
  keyboardType,
  /**
   * For a field whose value is PICKED rather than typed — the product. The row
   * cannot own a catalogue search, so the screen hands one in and the pick
   * mirrors its name into `answer.corrected`, which is what makes the refusal
   * below and the stored pair read the same for all six fields.
   */
  renderCorrected,
}: {
  field: string;
  reported: string;
  label?: string;
  answer: VerifyAnswer;
  onChange: (patch: Partial<VerifyAnswer>) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
  renderCorrected?: () => React.ReactNode;
}) {
  const edge = answer.verdict ? EDGE[answer.verdict] : C.hairline;

  return (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: edge,
        borderRadius: radius.md,
        backgroundColor: C.surface,
        paddingLeft: 12,
        paddingRight: 12,
        paddingVertical: 12,
        gap: 10,
      }}>
      <View>
        <T s="caption">{'Already recorded · ' + (label ?? findingLabel(field))}</T>
        <T style={[{ fontSize: 17, lineHeight: 23, color: C.ink, marginTop: 2 }, weight(600)]}>
          {reported}
        </T>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {VERDICTS.map((o) => (
          <Choice
            key={o.v}
            label={o.label}
            sub={o.sub}
            selected={answer.verdict === o.v}
            onPress={() => onChange({ verdict: o.v })}
            style={{ flexGrow: 1, minWidth: 104, paddingHorizontal: 12 }}
          />
        ))}
      </View>

      {answer.verdict === null ? (
        <T s="caption">Not asked yet — leaving it alone keeps what is written above.</T>
      ) : null}

      {answer.verdict === 'corrected' ? (
        <View style={{ gap: 10 }}>
          {renderCorrected ? (
            renderCorrected()
          ) : (
            <View>
              <T s="caption" style={{ marginBottom: 6 }}>What it actually is</T>
              <Input
                value={answer.corrected}
                onChangeText={(t) => onChange({ corrected: t })}
                placeholder={placeholder}
                keyboardType={keyboardType}
              />
            </View>
          )}
          <View>
            <T s="caption" style={{ marginBottom: 6 }}>Why it differs — required</T>
            <Input
              value={answer.reason}
              onChangeText={(t) => onChange({ reason: t })}
              placeholder="They switched in June; the earlier figure was the owner guessing"
            />
          </View>
        </View>
      ) : null}

      {answer.verdict === 'unverified' ? (
        <View>
          {/* Optional, and stored WITH the answer rather than instead of it.
              "The proprietor was out" is worth having and is not worth
              refusing the record over — the answer itself is the fact. */}
          <T s="caption" style={{ marginBottom: 6 }}>Why not — if it is worth saying</T>
          <Input
            value={answer.reason}
            onChangeText={(t) => onChange({ reason: t })}
            placeholder="The proprietor was out"
          />
        </View>
      ) : null}
    </View>
  );
}

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

/*
 * WHERE THESE WAIT, AND WHY IT IS THE KEY/VALUE STORE.
 *
 * The lead wire — `leadSchema` in `src/lib/actions/mbos.ts` — names no field
 * for a correction, and Zod strips what it does not name WITHOUT A WORD, which
 * is the quietest failure on this wire: the salesman answers six rows standing
 * in the shop, the sync says accepted, and the office has nothing. So until
 * the field lands the pair stays on the phone rather than being thrown at a
 * schema that will drop it.
 *
 * It is `kv` and not a column because the handset's `leads` table is not this
 * screen's to widen, and because a pull upserts `leads` — a column added here
 * would be the one the office never sends, and `upsert` writes exactly the
 * columns that arrive, so nothing would be overwritten today and everything
 * would be the day somebody added it. `kv` is touched by no sync at all.
 *
 * It is deliberately NOT folded into the lead's note on the way out, which is
 * the obvious way to make the office see it today. The office's own schema
 * comment is the argument: a correction folded into free text is a sentence
 * nobody can count, and "how many leads had their competitor corrected" is the
 * question the row exists to answer. Worse, a note cannot be deduplicated
 * against the real rows when the field lands, so the office would end up
 * holding one correction twice and disagreeing with itself about a shop.
 */

const KEY = (leadId: string) => `lead.fieldChecks.${leadId}`;

/**
 * A cap, because this is one string in one row. A prospect form is saved a
 * handful of times per lead and two hundred checks is far past anything a real
 * shop produces; the newest are kept, since the oldest reading is the one the
 * later ones have already answered.
 */
const KEEP = 200;

export async function fieldChecksFor(leadId: string): Promise<FieldCheck[]> {
  const raw = await getKv(KEY(leadId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FieldCheck[]) : [];
  } catch {
    /* A string that will not parse is a row nobody can act on. Answering with
       nothing is honest and lets the next save write a good one; throwing here
       would take the save with it, which is the one thing this must not cost. */
    return [];
  }
}

/**
 * Appended as part of the save, and it can never fail one.
 *
 * A save is never refused for want of signal on this app, and it must not be
 * refused for want of a local write either: the lead's own fields are already
 * queued by the time this runs, so a failure here costs the reason and never
 * the record.
 */
export async function rememberFieldChecks(leadId: string, rows: FieldCheck[]): Promise<void> {
  if (!rows.length) return;
  try {
    const kept = [...(await fieldChecksFor(leadId)), ...rows].slice(-KEEP);
    await setKv(KEY(leadId), JSON.stringify(kept));
  } catch {
    /* Deliberately swallowed — see above. */
  }
}
