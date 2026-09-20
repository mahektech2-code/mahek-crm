import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLANK_VERIFY,
  correctionRefusal,
  fieldChecksFrom,
  type VerifyAnswer,
} from './field-check';

/**
 * §9's before/after pair, pinned.
 *
 * These two functions decide whether six answers may leave the shop and what
 * the record of them looks like afterwards, and until this file existed
 * neither could be run at all — they lived in a `.tsx` that imports React
 * Native, which the handset's test glob cannot reach and a node runner cannot
 * load. The rules were written to be testable and were tested by nothing.
 */

const LABELS: Record<string, string> = {
  competitor: 'Competitor',
  monthly_litres: 'Monthly requirement',
};

function answer(over: Partial<VerifyAnswer>): VerifyAnswer {
  return { ...BLANK_VERIFY, ...over };
}

/* --------------------------------------------------------------- the refusal */

test('an unanswered row refuses nothing', () => {
  assert.equal(correctionRefusal({ competitor: answer({}) }, LABELS), null);
});

test('confirming and failing to verify both save with nothing else typed', () => {
  /* This is the whole reason the third verdict exists. "We asked and could not
     establish it" leaves the value where it is exactly as a confirmation does,
     and demanding a corrected value for it would make it unusable — which is
     how it collapses back into Confirm and stops being a separate answer. */
  for (const verdict of ['confirmed', 'unverified'] as const) {
    assert.equal(correctionRefusal({ competitor: answer({ verdict }) }, LABELS), null, verdict);
  }
});

test('a correction with no value is refused, and the sentence names the field', () => {
  const said = correctionRefusal({ competitor: answer({ verdict: 'corrected' }) }, LABELS);
  assert.ok(said, 'a correction with nothing corrected must be refused');
  assert.match(said, /competitor/i);
});

test('a correction with a value and no reason is refused', () => {
  /* The reason is the half that makes it a CHECK rather than an overwrite. A
     corrected figure with no reason reads later as somebody having written it
     down wrong, which is a statement about our own man that nobody made. */
  const said = correctionRefusal(
    { competitor: answer({ verdict: 'corrected', corrected: 'Asian Paints' }) },
    LABELS,
  );
  assert.ok(said, 'a correction with no reason must be refused');
  assert.match(said, /why/i);
});

test('a complete correction is accepted', () => {
  assert.equal(
    correctionRefusal(
      { competitor: answer({ verdict: 'corrected', corrected: 'Asian Paints', reason: 'He switched in July' }) },
      LABELS,
    ),
    null,
  );
});

test('whitespace is not an answer', () => {
  assert.ok(
    correctionRefusal({ competitor: answer({ verdict: 'corrected', corrected: '   ' }) }, LABELS),
  );
  assert.ok(
    correctionRefusal(
      { competitor: answer({ verdict: 'corrected', corrected: 'Asian Paints', reason: '  ' }) },
      LABELS,
    ),
  );
});

test('the FIRST unanswered row is the one named, over several', () => {
  /* One sentence under one button, so it has to name a field somebody can go
     and fix rather than counting how many are wrong. */
  const said = correctionRefusal(
    {
      monthly_litres: answer({ verdict: 'corrected', corrected: '200', reason: 'Counted the drums' }),
      competitor: answer({ verdict: 'corrected' }),
    },
    LABELS,
  );
  assert.ok(said);
  assert.match(said, /competitor/i);
});

/* ----------------------------------------------------------------- the record */

const WHO = { id: 'u1', name: 'Mahesh' };

test('an unanswered row produces no record at all', () => {
  /* Not a row saying "nobody answered". A field nobody was asked about and a
     field somebody could not confirm are different facts, and only the second
     is evidence of anything. */
  assert.deepEqual(fieldChecksFrom({ competitor: answer({}) }, {}, WHO, 1), []);
});

test('all three verdicts are kept, not only the corrections', () => {
  const rows = fieldChecksFrom(
    {
      competitor: answer({ verdict: 'confirmed' }),
      monthly_litres: answer({ verdict: 'unverified' }),
    },
    { competitor: 'Berger', monthly_litres: '150' },
    WHO,
    1,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.verdict).sort(), ['confirmed', 'unverified']);
});

test('the ORIGINAL is copied, because the lead column is live', () => {
  /* A later visit legitimately overwrites the field, so reading it back in
     March would answer with whatever it says then rather than with what he was
     shown on the day. The office's own table keeps the copy for this reason. */
  const [row] = fieldChecksFrom(
    { competitor: answer({ verdict: 'corrected', corrected: 'Asian Paints', reason: 'Switched' }) },
    { competitor: 'Berger' },
    WHO,
    1,
  );
  assert.equal(row!.original, 'Berger');
  assert.equal(row!.corrected, 'Asian Paints');
});

test('only a correction carries a corrected value', () => {
  const [row] = fieldChecksFrom(
    { competitor: answer({ verdict: 'confirmed', corrected: 'typed then confirmed' }) },
    { competitor: 'Berger' },
    WHO,
    1,
  );
  assert.equal(row!.corrected, null, 'a confirmation must assert no new value');
});

test('an empty original is null rather than an empty string', () => {
  const [row] = fieldChecksFrom({ competitor: answer({ verdict: 'unverified' }) }, {}, WHO, 1);
  assert.equal(row!.original, null);
});

test('the author may be absent and the row still stands', () => {
  /* The check happened whether or not this phone knows who is signed in; a row
     dropped for want of a name is evidence thrown away to avoid a null. */
  const [row] = fieldChecksFrom({ competitor: answer({ verdict: 'confirmed' }) }, {}, null, 7);
  assert.equal(row!.changedById, null);
  assert.equal(row!.changedByName, null);
  assert.equal(row!.at, 7);
});

test('the instant is the one passed in, never the clock', () => {
  /* Nothing here may read the clock: this runs during a render, and the React
     Compiler rules in this repo forbid it. Passing `at` is what makes the
     function pure, and this is the assertion that keeps it that way. */
  const [row] = fieldChecksFrom({ competitor: answer({ verdict: 'confirmed' }) }, {}, WHO, 1234);
  assert.equal(row!.at, 1234);
});
