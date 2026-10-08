import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_FIELDS, voiceFill, voiceValues, type LeadVoiceField, type LeadVoiceFound } from './lead-voice';
import type { AreaChoice, AreaRule } from './lead-areas';

const LISTS = {
  salesTypes: [{ code: 'direct', label: 'Direct customer' }],
  sources: [
    { code: 'walk_in', label: 'Walk-in' },
    { code: 'other', label: 'Other' },
  ],
  customerTypes: [{ code: 'dealer', label: 'Dealer' }],
};

const found: LeadVoiceFound = {
  salesType: 'direct',
  businessName: 'Patil Paints',
  contactPerson: 'Suresh Patil',
  mobile: '9822011001',
  otherNumbers: [],
  gstin: null,
  gstinCheck: null,
  city: 'Nagpur',
  state: 'Maharashtra',
  address: null,
  source: 'other',
  sourceDetail: 'A painter sent him',
  potentialRupees: 40000,
  followUp: { date: '2026-09-26', explanation: null, choices: [] },
  customerType: 'dealer',
  requirement: 'Thinner',
  monthlyLitres: 200,
  decisionMaker: null,
  competitor: 'Asian Paints',
  questions: [],
};

const all = (on: boolean) => Object.fromEntries(VOICE_FIELDS.map((f) => [f, on])) as Record<LeadVoiceField, boolean>;
const nagpur: AreaChoice = { key: 'c:nagpur', label: 'Nagpur', city: 'Nagpur', area: null, state: 'Maharashtra' };

test('a code this phone does not draw is not a value', () => {
  const v = voiceValues({ ...found, source: 'newspaper', salesType: 'distributor' }, LISTS);
  assert.equal(v.source, '');
  assert.equal(v.salesType, '');
});

test('only ticked answers fill, and a source of "other" brings its detail', () => {
  const values = voiceValues(found, LISTS);
  const ticked = { ...all(true), competitor: false };
  const out = voiceFill({ values, ticked, found, areas: { kind: 'free' } });
  assert.equal(out.competitor, undefined);
  assert.equal(out.source, 'other');
  assert.equal(out.sourceDetail, 'A painter sent him');
  assert.equal(out.potential, '40000');
  assert.equal(out.followUp, '2026-09-26');
  assert.deepEqual(out.location, { kind: 'free', city: 'Nagpur' });
});

test('a heard town picks his area, as the scan does', () => {
  const areas: AreaRule = { kind: 'pick', choices: [nagpur] };
  const out = voiceFill({ values: voiceValues(found, LISTS), ticked: all(true), found, areas });
  assert.deepEqual(out.location, { kind: 'area', area: nagpur, city: null });
});

test('an edited figure keeps only its digits', () => {
  const values = { ...voiceValues(found, LISTS), potential: '₹40,000', litres: 'about 200' };
  const out = voiceFill({ values, ticked: all(true), found, areas: { kind: 'free' } });
  assert.equal(out.potential, '40000');
  assert.equal(out.litres, '200');
});
