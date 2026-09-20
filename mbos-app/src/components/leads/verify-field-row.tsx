import React from 'react';
import { View } from 'react-native';
import { Choice, Input, T } from '../ui/primitives';
import { color as C, radius, weight } from '../../theme/tokens';
import { getKv, setKv } from '../../db';
/* The pure half lives in `engines/field-check.ts` and is re-exported here, so
   every caller keeps ONE import site while the rules stay somewhere a test can
   reach them without a device. See that file's header. */
import {
  BLANK_VERIFY,
  correctionRefusal,
  fieldChecksFrom,
  type FieldCheck,
  type VerifyAnswer,
  type VerifyVerdict,
} from '../../engines/field-check';
import { findingLabel } from '../../engines/funnel';

export { BLANK_VERIFY, correctionRefusal, fieldChecksFrom };
export type { FieldCheck, VerifyAnswer, VerifyVerdict };

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



/*
 * WHERE THESE USED TO WAIT, AND WHY THE STORE IS NOW ONLY READ.
 *
 * `leadSchema` named no field for a correction when this form shipped, and Zod
 * strips what it does not name WITHOUT A WORD — the quietest failure on this
 * wire: the salesman answers six rows standing in the shop, the sync says
 * accepted, and the office has nothing. So the pairs waited in `kv`, which is
 * touched by no sync at all, rather than being thrown at a schema that would
 * drop them. A column was never the answer either: a pull upserts `leads`, and
 * a column the office never sends is one that reads correctly today and is
 * overwritten the day somebody adds it.
 *
 * `leadSchema.fieldChecks` exists now, and `saveProspectFields` carries them
 * with the answers they are about. So NOTHING WRITES HERE ANY MORE and what is
 * left is the two functions that empty it: `takeFieldChecks` carries as many of
 * the oldest as a payload will hold, and `forgetFieldChecks` drops them once
 * the save has queued. A phone that has not been opened since the wire changed
 * still holds a fortnight of answers, and the first save on each lead sends
 * them.
 *
 * They were deliberately NOT folded into the lead's note on the way out, which
 * was the obvious way to make the office see them sooner. The office's own
 * schema comment is the argument: a correction folded into free text is a
 * sentence nobody can count, and it could not have been deduplicated against
 * the real rows when the field landed — the office would be holding one
 * correction twice and disagreeing with itself about one shop.
 */

const KEY = (leadId: string) => `lead.fieldChecks.${leadId}`;

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
 * THE BACKLOG, drained a save at a time.
 *
 * `leadSchema` had nowhere for these when the form shipped, so what a salesman
 * answered on a second visit sat in `kv` and went nowhere. It has somewhere
 * now, and the rows written before that are still on the phone — so each save
 * takes as many of the OLDEST as it can carry and sends them with the new ones.
 * Oldest first because they are the ones that have been waiting, and because
 * the newest were answered on the screen that is open.
 *
 * CAPPED, and the cap is the schema's own forty. A payload the server refuses
 * for length is one that takes the seven answers beside it down with it, and
 * this backlog is the one part of the request whose size nobody on the screen
 * controls.
 */
export async function takeFieldChecks(leadId: string, max: number): Promise<FieldCheck[]> {
  if (max <= 0) return [];
  return (await fieldChecksFor(leadId)).slice(0, max);
}

/**
 * Dropped only once the save that carried them has been QUEUED, never before.
 *
 * The outbox is durable, so a queued row is a row that will reach the office on
 * whatever signal comes next; a refusal at the far end loses them, exactly as
 * it loses every other answer in that payload. Forgetting them BEFORE the queue
 * would lose them to a save that never happened, which is the one failure the
 * backlog exists to prevent.
 */
export async function forgetFieldChecks(leadId: string, howMany: number): Promise<void> {
  if (howMany <= 0) return;
  try {
    const rest = (await fieldChecksFor(leadId)).slice(howMany);
    await setKv(KEY(leadId), rest.length ? JSON.stringify(rest) : '[]');
  } catch {
    /* Swallowed, like every other local write in this app that sits on top of
       a completed save. The worst it costs is one shop's answers being sent
       twice, which the office settles on (lead, field, `at`); throwing here
       would cost the save itself. */
  }
}
