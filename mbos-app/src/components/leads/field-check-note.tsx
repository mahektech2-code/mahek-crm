import React from 'react';
import { View } from 'react-native';
import { T } from '../ui/primitives';
import { color as C } from '../../theme/tokens';
import { isoDate, pretty } from '../../lib/format';
import type { VerificationCheck } from '../../data/validations';

/**
 * §5.2 — WHAT SOMEBODY DID TO THIS FIGURE, DRAWN UNDER THE FIGURE.
 *
 * `verify-field-row.tsx` is the control that makes one of these; this is the
 * answer read back, on the handset, for the first time. The corrected VALUES
 * have always arrived here on the lead itself and the record of the correction
 * never has — so a salesman opened a shop he had answered for last week and
 * found his own number replaced, with nothing on any screen saying whose
 * reading it now was or on what grounds. That is precisely the silent
 * overwrite the mechanism exists to prevent, kept honestly in the office and
 * broken in the field.
 *
 * **IT SITS UNDER THE FIELD AND NOT IN A LIST.** A "Corrections" panel further
 * down the record is a panel somebody has to match against the values above it
 * by eye, one code at a time, while standing in the shop the argument is about.
 * Under the value there is no matching to do: what he is reading and how it got
 * there are one thing.
 *
 * **ALL THREE VERDICTS ARE DRAWN, and they say three different things.** A
 * confirmation is the evidence somebody asked again and got the same answer —
 * which is the whole of what a second visit buys and is invisible if only
 * corrections are shown. `unverified` is we asked and could not establish it,
 * which leaves the value exactly where a confirmation does and means the
 * opposite: drawn as a confirmation it would hand him a figure that looks
 * checked when nobody could check it.
 *
 * **AND THE ORIGINAL IS PRINTED BESIDE THE CORRECTION**, because the pair is
 * the point. "Berger, not Asian Paints" is a fact about the shop AND a fact
 * about whoever wrote the first one down, and only the second is worth knowing
 * a month later.
 */

/** `null` is the answer to WHICH DOOR, so the two are said in different words. */
function where(check: VerificationCheck): string {
  return check.validationId ? 'on a call from the office' : 'in the shop';
}

function toneOf(verdict: VerificationCheck['verdict']): string {
  /* The correction is the one that changes what the record says, so it is the
     one drawn in the body colour. The other two are marks on a value that has
     not moved and read as the caption they are. */
  return verdict === 'corrected' ? C.body : C.muted;
}

function headline(check: VerificationCheck): string {
  const who = check.changedByName?.trim() || 'Somebody at the office';
  const when = pretty(isoDate(new Date(check.changedAt)));
  if (check.verdict === 'corrected') {
    return `${who} corrected this ${where(check)} on ${when}`;
  }
  if (check.verdict === 'confirmed') {
    return `${who} checked this ${where(check)} on ${when} — still right`;
  }
  return `${who} asked ${where(check)} on ${when} and could not confirm it`;
}

export function FieldCheckNote({ checks }: { checks: VerificationCheck[] }) {
  if (!checks.length) return null;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {checks.map((c) => (
        <View key={c.id} style={{ paddingLeft: 132 }}>
          <T s="caption" style={{ color: toneOf(c.verdict) }}>
            {headline(c)}
          </T>
          {/* Only under a correction. The other two assert no new value at
              all, which is the whole difference between them and this one. */}
          {c.verdict === 'corrected' && c.original?.trim() ? (
            <T s="caption" style={{ marginTop: 1 }}>
              {'You had: ' + c.original.trim()}
            </T>
          ) : null}
          {c.reason?.trim() ? (
            <T s="caption" style={{ marginTop: 1, color: C.muted }}>
              {c.reason.trim()}
            </T>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * The checks for each finding, newest first inside each.
 *
 * Grouped here rather than in the screen so the record and anything else that
 * grows a need for this cannot come to two different answers about which check
 * belongs to which field — the reader hands back one flat list ordered by when,
 * and the ORDER inside a group is what says which reading is the current one.
 */
export function checksByField(checks: VerificationCheck[]): Map<string, VerificationCheck[]> {
  const byField = new Map<string, VerificationCheck[]>();
  for (const c of checks) {
    const held = byField.get(c.field);
    if (held) held.push(c);
    else byField.set(c.field, [c]);
  }
  return byField;
}

/**
 * A finding whose value this record has nowhere to draw.
 *
 * Six of the nine — who we ask for, who signs off, the credit they want and
 * the rest — have no line in "What you learned in the shop", so a check on one
 * of them would have nothing to sit under and would fall off the screen
 * silently. They get a line of their own, labelled with the finding's own
 * words, carrying whatever the last correction says the value is. That keeps
 * the rule the header states: every check is beside the field it is about, and
 * there is never a second list to match by eye.
 */
export function valueFromChecks(checks: VerificationCheck[]): string | null {
  const corrected = checks.find((c) => c.verdict === 'corrected' && c.corrected?.trim());
  if (corrected?.corrected) return corrected.corrected.trim();
  const confirmed = checks.find((c) => c.original?.trim());
  return confirmed?.original?.trim() ?? null;
}
