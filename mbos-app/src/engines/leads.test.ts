import test from 'node:test';
import assert from 'node:assert/strict';

import { stageRefusal, visitCapLabel, visitCapState } from './leads';

/**
 * The visit cap, and why it is a question rather than a gate.
 *
 * §B of the brief asks for a maximum of three visits to a Suspect, "enforced".
 * These tests pin the reading of that word this app took, because it is the
 * kind of decision somebody will later mistake for a missing feature: the cap
 * demands an ANSWER and never refuses the visit. `engines/geo.ts` states the
 * principle it follows — a reading is evidence, never a gate — and the failure
 * mode a refusal produces is the visit that simply never gets logged, taking
 * the GPS, the competitor note and the reason with it.
 *
 * Pure, so the rule can be checked with no handset and no database. The server
 * enforces `decide` against the same two configured numbers; that is what keeps
 * two runtimes agreeing without a module they cannot share.
 */


/* ------------------------------------------------------------ the visit cap */

test('a Suspect is warned before the decision is demanded, never after', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  /* Nothing to say on the first visit — the answer must not be sprung on
     somebody standing in a shop. */
  assert.equal(visitCapState('New', 0, cfg), 'ok');
  /* The second visit warns that the next one needs an answer. */
  assert.equal(visitCapState('New', 1, cfg), 'warn');
  /* The third demands it. */
  assert.equal(visitCapState('New', 2, cfg), 'decide');
});

test('past the cap it still says decide, and never says stop', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  /* There is no fourth state. A refused visit is an unlogged visit, and the
     company loses the GPS, the competitor note and the reason to prevent a
     number reaching four — see the note above `visitCapState`. */
  assert.equal(visitCapState('New', 5, cfg), 'decide');
  assert.equal(visitCapState('New', 50, cfg), 'decide');
});

test('only a Suspect is asked to justify itself', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  /* A qualified prospect visited a fourth time is a negotiation, not a stall.
     Asking him to decide again would be asking a question already answered. */
  for (const stage of ['Qualified', 'Negotiation', 'On hold', 'Converted', 'Lost']) {
    assert.equal(visitCapState(stage, 9, cfg), 'ok', stage + ' should not be capped');
    assert.equal(visitCapLabel(stage, 9, cfg), null, stage + ' should carry no counter');
  }
});

test('the counter keeps counting past the cap rather than sticking', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  assert.equal(visitCapLabel('New', 1, cfg), 'Visit 1 / 3');
  assert.equal(visitCapLabel('Contacted', 3, cfg), 'Visit 3 / 3');
  /* A fourth visit happened and the manager has been told. A counter that
     reads "3 / 3" there is lying about it. */
  assert.equal(visitCapLabel('New', 4, cfg), 'Visit 4 / 3');
});

test('a warning threshold equal to the cap means no warning, and is allowed', () => {
  /* checkConsistency permits it: a team that wants the answer on the second
     visit with no build-up can say so. What it refuses is a warning that comes
     AFTER the demand, which would ask for an answer nobody was told to expect. */
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 2 };
  assert.equal(visitCapState('New', 0, cfg), 'ok');
  assert.equal(visitCapState('New', 1, cfg), 'decide');
});

test('On hold asks for a reason, and for the opposite reason to Lost', () => {
  assert.equal(
    stageRefusal('On hold', ''),
    'Say what you are waiting for — that is what tells anybody when to pick it up again.',
  );
  assert.equal(stageRefusal('On hold', 'Back after Diwali'), null);
  /* Lost still asks, and everything else still does not. */
  assert.ok(stageRefusal('Lost', '  '));
  assert.equal(stageRefusal('Qualified', ''), null);
});
