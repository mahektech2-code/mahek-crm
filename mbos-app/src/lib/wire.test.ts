import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  localPriority,
  wireComplaintCategory,
  wireNotes,
  wireOutcome,
  wirePriority,
  wireSource,
  wireStage,
  localStage,
} from '../lib/wire';

/**
 * The vocabularies that differ between this app and MahekOne — PROTOCOL.md §4.1.
 *
 * These are the translations that were missing for as long as both halves
 * existed, and the reason they are worth a test rather than a comment is that
 * NOTHING FAILS when one of them is wrong. An unknown field is not an invalid
 * one: half the drift was refused at the door with a message about a word the
 * salesman never typed, and the other half was accepted and silently dropped,
 * so a visit reached the office carrying a customer and nothing else and no
 * screen on either end reported a loss.
 *
 * They are pure functions for exactly this reason. A mapping that only exists
 * inside a payload literal cannot be tested without a device.
 */

test('a converted lead is `won`, because that is the only word that is not just a case change', () => {
  assert.equal(wireStage('Converted'), 'won');
  assert.equal(wireStage('New'), 'new');
  assert.equal(wireStage('Contacted'), 'contacted');
  assert.equal(wireStage('Qualified'), 'qualified');
  assert.equal(wireStage('Negotiation'), 'negotiation');
  assert.equal(wireStage('Lost'), 'lost');
});

test('a stage nobody knows is left undefined rather than guessed at', () => {
  /* Sending a stage the enum does not hold would be refused for the whole
     lead; sending none leaves the stage where it was, which is the smaller
     wrong answer of the two. */
  assert.equal(wireStage('Warm-ish'), undefined);
});

/* -------------------------------------------------------- the lead source */

/**
 * Every one of these was a rejected lead in production.
 *
 * `LEAD_SOURCES` in `engines/leads.ts` is what the salesman actually taps, and
 * the FIRST of them is the default — so this is not an edge case reachable by
 * an unusual pick, it is what happens when somebody fills the form in and
 * presses save without touching the source at all.
 */
test('every source the screen offers maps to a value MahekOne holds', () => {
  /* Kept in step with LEAD_SOURCES by hand rather than imported: importing it
     would make the test pass by construction, and what is being asserted is
     precisely that the two lists agree. */
  assert.equal(wireSource('Walked past'), 'cold_call');
  assert.equal(wireSource('Referral'), 'referral');
  assert.equal(wireSource('Market enquiry'), 'manual');
  assert.equal(wireSource('Exhibition'), 'exhibition');
  assert.equal(wireSource('Office'), 'manual');
});

test("MahekOne's own words go back out unchanged, so an edit is not refused for being right", () => {
  for (const v of ['manual', 'website', 'referral', 'exhibition', 'cold_call', 'whatsapp', 'campaign']) {
    assert.equal(wireSource(v), v, v + ' should survive a round trip');
  }
});

test('a source nobody knows is left undefined rather than guessed at', () => {
  /* The same rule as the stage above, and for the same reason: the server
     refuses the WHOLE lead over one bad enum value, so a lead that arrives
     with no source beats a lead that never arrives. */
  assert.equal(wireSource('Walked pastt'), undefined);
  assert.equal(wireSource(''), undefined);
  assert.equal(wireSource(null), undefined);
  assert.equal(wireSource(undefined), undefined);
});

test('notes flatten to one string, oldest first, keeping their dates', () => {
  const at = new Date(2026, 7, 3, 11, 30).getTime();
  const flat = wireNotes([
    { at, text: 'Asked for a rate list' },
    { at, text: 'Wants 45 days credit' },
  ]);
  assert.equal(flat, '2026-08-03 — Asked for a rate list\n2026-08-03 — Wants 45 days credit');
});

test('no notes is no field at all, not an empty string', () => {
  /* An empty string is a value, and on an update it would overwrite whatever
     history the office already had with nothing. */
  assert.equal(wireNotes([]), undefined);
});

test('a note with no timestamp keeps its sentence', () => {
  assert.equal(wireNotes([{ at: 0, text: 'Written before notes were a list' }]),
    'Written before notes were a list');
});

test('the five complaint buttons map onto the nine stored categories', () => {
  assert.equal(wireComplaintCategory('Late delivery'), 'dispatch_delay');
  assert.equal(wireComplaintCategory('Damaged goods'), 'packaging_damage');
  assert.equal(wireComplaintCategory('Wrong material'), 'product_quality');
  assert.equal(wireComplaintCategory('Short quantity'), 'shortage');
  assert.equal(wireComplaintCategory('Rate dispute'), 'pricing');
});

test('"Not available" is the one visit outcome MahekOne spells differently', () => {
  assert.equal(wireOutcome('closed_now'), 'not_available');
  for (const same of ['visited', 'order', 'payment', 'complaint', 'sample', 'closed']) {
    assert.equal(wireOutcome(same), same);
  }
});

test('Normal is medium, and an unnamed priority is too', () => {
  assert.equal(wirePriority('Normal'), 'medium');
  assert.equal(wirePriority('High'), 'high');
  assert.equal(wirePriority('Low'), 'low');
  assert.equal(wirePriority(undefined), 'medium');
});

test('a priority nobody knows still lands in the middle rather than being refused', () => {
  /* The task is the point; where it sits in a sorted list is not worth losing
     it over. */
  assert.equal(wirePriority('Blocker'), 'medium');
});

test('medium comes back as Normal, not Medium — the design never had that word', () => {
  assert.equal(localPriority('low'), 'Low');
  assert.equal(localPriority('medium'), 'Normal');
  assert.equal(localPriority('high'), 'High');
  assert.equal(localPriority(undefined), 'Normal');
});

test('a priority the office invents lands in the middle here too', () => {
  assert.equal(localPriority('urgent'), 'Normal');
});

test('an unrecognised complaint category becomes `other`, never a refusal', () => {
  /* A complaint filed under the wrong heading is still a complaint. One
     refused at the door is a customer nobody rings back — and this is the one
     record in the app that has to move fast. */
  assert.equal(wireComplaintCategory('Delivered to the wrong shop'), 'other');
});

test('On hold survives the round trip, in both spellings', () => {
  /* The screen says "On hold" and the enum says `on_hold`. The value reaches
     `wireStage` from a stage constant AND from the decision the visit screen
     picked, which speaks the enum — so both have to be accepted or half the
     paths silently send `undefined` and the lead stays where it was. */
  assert.equal(wireStage('On hold'), 'on_hold');
  assert.equal(wireStage('on_hold'), 'on_hold');
  assert.equal(localStage('on_hold'), 'On hold');
  /* And it must not have disturbed the four that were already right. */
  assert.equal(wireStage('Converted'), 'won');
  assert.equal(localStage('won'), 'Converted');
  assert.equal(localStage('lost'), 'Lost');
});
