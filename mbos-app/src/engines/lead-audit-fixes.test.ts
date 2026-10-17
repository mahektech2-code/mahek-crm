import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAP_EXEMPT,
  CUSTOMER_TYPES,
  capStageOf,
  gateAsRun,
  gstinRefusal,
  rejectionReasonFrom,
  REJECTION_REASON_MAX,
  sampleAsk,
  visitCapState,
} from './leads';
import type { GateVerdict } from './funnel';

/**
 * The lead fixes from the October handset audit, pinned where they live.
 *
 * Every one of these was a disagreement between the phone and the office about
 * one lead, and every one failed silently: a rejected trial refused at the far
 * end, a Prospect asked to be decided again, a button shut over a condition
 * the office had switched off. Pure functions, so no handset is needed.
 */

/* ------------------------------------------------- the trial's refusal */

test('a rejected trial carries a reason built from the three refusal boxes', () => {
  const r = rejectionReasonFrom({
    otherComments: 'Dries too slow in winter',
    priceFeedback: 'Dearer than Asian',
    competitorComparison: '',
  });
  assert.equal(r, 'Dries too slow in winter. Price: Dearer than Asian');
});

test('no answer in any of the three is no reason at all, not an empty one', () => {
  assert.equal(rejectionReasonFrom({ otherComments: '  ', priceFeedback: null }), null);
});

test('a reason longer than the office keeps is trimmed, never refused', () => {
  const r = rejectionReasonFrom({ otherComments: 'x'.repeat(900) });
  assert.ok(r);
  assert.equal(r!.length, REJECTION_REASON_MAX);
});

/* ------------------------------------------------- the visit cap's word */

const cap = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };

test('a funnel Prospect stored as legacy Contacted is NOT asked to decide again', () => {
  const stage = capStageOf({ funnelStage: 'prospect', stage: 'Contacted' });
  assert.equal(stage, 'prospect');
  assert.equal(visitCapState(stage, 5, cap), 'ok');
});

test('an undecided Suspect is still capped', () => {
  const stage = capStageOf({ funnelStage: 'suspect', stage: 'New' });
  assert.equal(visitCapState(stage, 2, cap), 'decide');
});

test('a decided Suspect and a third-party shop are exempt, as the office exempts them', () => {
  assert.equal(capStageOf({ funnelStage: 'suspect', stage: 'New', suspectDecidedAt: 1 }), CAP_EXEMPT);
  assert.equal(capStageOf({ funnelStage: 'suspect', stage: 'New', thirdParty: 1 }), CAP_EXEMPT);
  assert.equal(visitCapState(CAP_EXEMPT, 9, cap), 'ok');
});

test('a legacy lead with no funnel stage is read from its six-word column', () => {
  assert.equal(capStageOf({ funnelStage: null, stage: 'Contacted' }), 'contacted');
});

/* ------------------------------------------------- the gate as run here */

const shut = (to: GateVerdict['to'], ids: string[]): GateVerdict => ({
  to,
  open: ids.length === 0,
  missing: ids.map((id) => ({ id, says: id })),
});

test('requireNextAction off lifts §24 on the phone, as it does at the office', () => {
  const v = gateAsRun(shut('prospect', ['next_action']), { salesType: 'direct' }, { requireNextAction: false });
  assert.equal(v.open, true);
  const on = gateAsRun(shut('prospect', ['next_action']), { salesType: 'direct' }, { requireNextAction: true });
  assert.equal(on.open, false);
});

test('a legacy lead may not move to Qualified without a GST number', () => {
  const v = gateAsRun(shut('qualified', []), { salesType: null, gstin: '' }, { requireNextAction: true });
  assert.equal(v.open, false);
  assert.equal(v.missing[0].id, 'gstin');
  const ok = gateAsRun(shut('qualified', []), { salesType: null, gstin: '27AAPFU0939F1ZV' }, { requireNextAction: true });
  assert.equal(ok.open, true);
});

test('a lead with no next rung is left alone', () => {
  const v: GateVerdict = { to: 'won', open: false, missing: [], noNextRung: true };
  assert.equal(gateAsRun(v, { salesType: null }, { requireNextAction: false }), v);
});

/* ------------------------------------------------- may a sample be asked */

test('a shop that is not a lead, or a legacy lead, is never gated', () => {
  assert.equal(sampleAsk(null, () => shut('sample_trial', ['x'])).ok, true);
  assert.equal(sampleAsk({ salesType: null, stage: 'new' }, () => shut('sample_trial', ['x'])).ok, true);
});

test('a distributor has no sample rung, and is told so', () => {
  const r = sampleAsk({ salesType: 'distributor', stage: 'qualification' }, () => shut('sample_trial', []));
  assert.equal(r.ok, false);
});

test('a direct lead below the rung is refused with what is missing', () => {
  const r = sampleAsk({ salesType: 'direct', stage: 'suspect' }, () => shut('sample_trial', ['contact']));
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing, ['contact']);
});

test('a direct lead already at or past the rung may ask', () => {
  const never = () => {
    throw new Error('the gate should not be asked');
  };
  assert.equal(sampleAsk({ salesType: 'direct', stage: 'sample_trial' }, never).ok, true);
  assert.equal(sampleAsk({ salesType: 'direct', stage: 'sample_review' }, never).ok, true);
});

/* --------------------------------------------------------------- GSTIN */

test('a GST number is checked by shape and checksum, and empty is fine', () => {
  assert.equal(gstinRefusal(''), null);
  assert.equal(gstinRefusal('27aapfu0939f1zv'), null);
  assert.ok(gstinRefusal('27AAPFU0939F1Z'));
  assert.ok(gstinRefusal('27AAPFU0939F1ZW'));
  assert.ok(gstinRefusal('2XAAPFU0939F1ZV'));
});

test('one list of business kinds, with the same code never two words', () => {
  const codes = CUSTOMER_TYPES.map((t) => t.value);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual([...codes].sort(), ['dealer', 'distributor', 'manufacturer', 'retailer']);
});
