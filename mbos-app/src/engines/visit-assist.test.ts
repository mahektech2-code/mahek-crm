import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cartFrom,
  complaintDraft,
  fillVisit,
  openQuestions,
  paymentFill,
  requirementFill,
  sampleDraft,
  type VisitAction,
  type VisitAnalysis,
} from './visit-assist';

/* The assistant proposes; he decides. Every test here is one half of that. */

function analysis(over: Partial<VisitAnalysis> = {}): VisitAnalysis {
  return {
    summary: '',
    outcome: null,
    outcomeChoices: [],
    comeBack: null,
    actions: [],
    competitor: null,
    feedback: [],
    questions: [],
    notes: [],
    readByModel: true,
    ...over,
  };
}

const day = (date: string) => ({ date, source: 'said', explanation: null, choices: [] });

test('a sure outcome and a said day fill an empty visit', () => {
  const f = fillVisit(
    { outcome: null, nextDate: '2026-10-10', nextDatePicked: false },
    analysis({
      outcome: { key: 'order', label: 'Order taken', state: 'ready', why: '' },
      comeBack: day('2026-09-28'),
    }),
  );
  assert.deepEqual(f.patch, { outcome: 'order', nextDate: '2026-09-28' });
});

test('what he already chose is never overwritten', () => {
  const f = fillVisit(
    { outcome: 'payment', nextDate: '2026-10-02', nextDatePicked: true },
    analysis({
      outcome: { key: 'order', label: 'Order taken', state: 'ready', why: '' },
      comeBack: day('2026-09-28'),
    }),
  );
  assert.deepEqual(f.patch, {});
  assert.equal(f.kept.length, 2);
});

test('a question is never answered by the fill button', () => {
  const f = fillVisit(
    { outcome: null, nextDate: '2026-10-10', nextDatePicked: false },
    analysis({ outcome: { key: 'sample', label: 'Sample required', state: 'confirm', why: '' } }),
  );
  assert.equal(f.patch.outcome, undefined);
});

test('an outcome this build has no chip for is not filled', () => {
  const f = fillVisit(
    { outcome: null, nextDate: '2026-10-10', nextDatePicked: false },
    analysis({ outcome: { key: 'teleported', label: '?', state: 'ready', why: '' } }),
  );
  assert.equal(f.patch.outcome, undefined);
});

const order: Extract<VisitAction, { kind: 'order' }> = {
  kind: 'order',
  state: 'confirm',
  title: '',
  why: '',
  questions: [],
  lines: [
    { said: 'nano', product: { state: 'matched', productId: 'p1', name: 'Nano' }, quantityCans: 10, saidAs: null },
    {
      said: 'PU',
      product: { state: 'ambiguous', options: [{ productId: 'p2', name: 'PU 1L' }, { productId: 'p3', name: 'PU 4L' }] },
      quantityCans: 4,
      saidAs: null,
    },
    { said: 'sealer', product: { state: 'matched', productId: 'p4', name: 'Sealer' }, quantityCans: null, saidAs: '20 litres' },
  ],
};

test('the cart takes matched lines, keeps his quantities, and counts the rest', () => {
  const r = cartFrom(order, { p9: '2' });
  assert.deepEqual(r.cart, { p9: '2', p1: '10' });
  assert.equal(r.added, 1);
  assert.equal(r.missing, 2);

  const picked = cartFrom(order, { p1: '3' }, { 1: 'p3' });
  assert.equal(picked.cart.p1, '3', 'his quantity stands');
  assert.equal(picked.cart.p3, '4', 'the pack he picked on the card goes in');
  assert.equal(picked.missing, 1);
});

test('payment fills only the boxes he left empty', () => {
  const a: Extract<VisitAction, { kind: 'payment' }> = {
    kind: 'payment', state: 'ready', title: '', why: '', questions: [], amountRupees: 20000, mode: 'Cash',
  };
  assert.deepEqual(paymentFill(a, { payAmt: '', payMode: null }), { payAmt: '20000', payMode: 'Cash' });
  assert.deepEqual(paymentFill(a, { payAmt: '15000', payMode: 'UPI' }), {});
});

test('the complaint and sample drafts use only chips the sheets carry', () => {
  const c = complaintDraft(
    {
      kind: 'complaint', state: 'ready', title: '', why: '', questions: [],
      category: 'Delivery Delay', description: 'Late', priority: 'high', duplicateOf: null,
    },
    ['Delivery Delay', 'Other'],
  );
  assert.deepEqual(c, { cat: 'Delivery Delay', what: 'Late', priority: 'high' });
  const unknown = complaintDraft(
    {
      kind: 'complaint', state: 'ready', title: '', why: '', questions: [],
      category: 'Made Up', description: null, priority: 'medium', duplicateOf: null,
    },
    ['Other'],
  );
  assert.deepEqual(unknown, {});

  const s = sampleDraft(
    {
      kind: 'sample', state: 'ready', title: '', why: '', questions: [],
      productSaid: 'nano', product: { state: 'matched', productId: 'p1', name: 'Nano' },
      cans: 2, application: 'doors', reasonCode: 'nope', duplicateOf: null,
    },
    ['comparison'],
  );
  assert.deepEqual(s, { sku: 'p1', skuName: 'Nano', cans: '2', application: 'doors' });
});

test('the requirement fills only empty boxes', () => {
  const a: Extract<VisitAction, { kind: 'requirement' }> = {
    kind: 'requirement', state: 'ready', title: '', why: '', questions: [],
    what: 'Spray thinner', monthlyLitres: 200, cans: null,
  };
  assert.deepEqual(requirementFill(a, { what: '', litres: '', cans: '' }), { what: 'Spray thinner', litres: '200' });
  assert.deepEqual(requirementFill(a, { what: 'His words', litres: '50', cans: '' }), {});
});

test('a duplicate is not a question waiting on him', () => {
  const n = openQuestions(
    analysis({
      questions: ['a'],
      outcome: { key: 'visited', label: '', state: 'confirm', why: '' },
      actions: [
        {
          kind: 'complaint', state: 'duplicate', title: '', why: '', questions: ['x'],
          category: null, description: null, priority: 'medium', duplicateOf: 'c1',
        },
        { kind: 'opportunity', state: 'confirm', title: '', why: '', questions: ['b'], product: null, date: null },
      ],
    }),
  );
  assert.equal(n, 3);
});
