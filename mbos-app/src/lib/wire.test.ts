import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  localPriority,
  wireComplaintCategory,
  wireNotes,
  wireOutcome,
  wirePriority,
  wireStage,
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
