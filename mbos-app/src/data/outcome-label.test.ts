import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOMES, outcomeLabel } from './fixtures';

/* The visits table keeps the KEY; every screen that prints one goes through
   this, so a salesman never reads "closed_now". */

test('every stored outcome key reads as its chip label', () => {
  for (const o of OUTCOMES) assert.equal(outcomeLabel(o.k), o.label);
  assert.equal(outcomeLabel('closed_now'), 'Owner away');
});

test("the office's spelling of Owner away reads the same", () => {
  assert.equal(outcomeLabel('not_available'), 'Owner away');
});

test('nothing stored is nothing shown, and an unknown word is shown rather than lost', () => {
  assert.equal(outcomeLabel(null), null);
  assert.equal(outcomeLabel(''), null);
  assert.equal(outcomeLabel('rescheduled'), 'rescheduled');
});
