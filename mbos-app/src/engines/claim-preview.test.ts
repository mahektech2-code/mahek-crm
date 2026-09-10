import test from 'node:test';
import assert from 'node:assert/strict';

import { previewClaim, type PricingPolicy } from './claim-preview';
import type { PolicyRule } from './generated/expense-policy';

/**
 * The join between the office's engine and the sentence on the salesman's
 * screen.
 *
 * Both halves of this compile perfectly alone, and that is exactly the failure
 * `mbos-wire.test.ts` was written for one wire over: the engine can price a day
 * correctly while the screen asks it the wrong question, and nothing anywhere
 * goes red. The bug this pins is the one that shipped — the preview priced a
 * day of exactly ONE line, the claim being typed, so a per-day cap was reported
 * whole however much of it had already gone. He read ₹600 with ₹340 left.
 *
 * So these run the REAL generated engine, never a stand-in for it. A test
 * against a hand-built copy of the arithmetic proves the copy.
 */

const ANY = { grade: null, cityClass: null };

function policyOf(rules: readonly PolicyRule[]): PricingPolicy {
  return {
    policy: { id: 'p1', versionNo: 3, effectiveFrom: '2026-01-01', effectiveTo: null, rules },
    subject: { grade: null, cityClass: null },
  };
}

/** ₹300 a fare, ₹600 a day. The shape the client's own policy is written in. */
const AUTO = policyOf([
  {
    ...ANY,
    kind: 'actuals',
    scopeKey: 'category:local_transport',
    capPerInstancePaise: 30000,
    capPerDayPaise: 60000,
  },
]);

const DAY = '2026-09-08';

const claim = (n: number, id = 'x') => ({ id, kind: 'local_transport' as const, claimedPaise: n, hasProof: true });

test('what is left is the day’s own remainder, not the whole cap', () => {
  const p = previewClaim({
    policy: AUTO,
    kind: 'local_transport',
    claimedPaise: 0,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [claim(26000, 'morning')],
  });
  assert.equal(p.remainingBeforePaise, 34000);
  assert.match(p.line, /340 left for local transport today/);
});

test('and it is said before he types, on a day nothing has been claimed on', () => {
  const p = previewClaim({
    policy: AUTO,
    kind: 'local_transport',
    claimedPaise: 0,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [],
  });
  assert.equal(p.remainingBeforePaise, 60000);
});

test('a claim inside the day’s remainder is within policy, and says what is left after', () => {
  const p = previewClaim({
    policy: AUTO,
    kind: 'local_transport',
    claimedPaise: 20000,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [claim(26000, 'morning')],
  });
  assert.equal(p.eligiblePaise, 20000);
  assert.equal(p.excessPaise, 0);
  assert.equal(p.remainingAfterPaise, 14000);
  assert.match(p.line, /Within policy/);
});

/* The bug itself: each fare is well inside the ₹300 one-fare cap, and the day
   is not. Before the engine honoured `capPerDayPaise` this answered ₹250. */
test('a fare inside the per-fare cap is still trimmed by the day’s', () => {
  const p = previewClaim({
    policy: AUTO,
    kind: 'local_transport',
    claimedPaise: 25000,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [claim(25000, 'a'), claim(25000, 'b')],
  });
  assert.equal(p.eligiblePaise, 10000);
  assert.equal(p.excessPaise, 15000);
  assert.match(p.line, /needs your manager to agree it/);
});

test('a spent day says so, and still does not refuse the claim', () => {
  const p = previewClaim({
    policy: AUTO,
    kind: 'local_transport',
    claimedPaise: 0,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [claim(30000, 'a'), claim(30000, 'b')],
  });
  assert.equal(p.remainingBeforePaise, 0);
  assert.match(p.line, /Nothing left for local transport today/);

  const typed = previewClaim({
    policy: AUTO,
    kind: 'local_transport',
    claimedPaise: 15000,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [claim(30000, 'a'), claim(30000, 'b')],
  });
  assert.equal(typed.eligiblePaise, 0);
  assert.equal(typed.excessPaise, 15000);
});

/* A kind the policy caps must not spend a kind it does not. */
test('another kind’s spending does not eat this one’s headroom', () => {
  const p = previewClaim({
    policy: AUTO,
    kind: 'local_transport',
    claimedPaise: 0,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [{ id: 'f', kind: 'food', claimedPaise: 50000, hasProof: true }],
  });
  assert.equal(p.remainingBeforePaise, 60000);
});

test('a kind this policy caps not at all reports no headroom rather than a false one', () => {
  const p = previewClaim({
    policy: AUTO,
    kind: 'other',
    claimedPaise: 0,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [],
  });
  assert.equal(p.remainingBeforePaise, null);
  assert.equal(p.line, '');
});

test('no policy on the phone is its own answer, unchanged', () => {
  const p = previewClaim({
    policy: null,
    kind: 'food',
    claimedPaise: 10000,
    hasBill: false,
    day: DAY,
    alreadyClaimed: [],
  });
  assert.equal(p.unpriced, true);
  assert.match(p.line, /no policy yet/);
});

/* A bill missing off this morning's fare must not light up the box he is
   typing in now — the exception belongs to a line he cannot see. */
test('another line’s missing bill is not this claim’s problem', () => {
  const withProof = policyOf([
    { ...ANY, kind: 'proof_threshold', scopeKey: 'category:local_transport', atPaise: 10000 },
    {
      ...ANY,
      kind: 'actuals',
      scopeKey: 'category:local_transport',
      capPerInstancePaise: null,
      capPerDayPaise: null,
    },
  ]);
  const p = previewClaim({
    policy: withProof,
    kind: 'local_transport',
    claimedPaise: 5000,
    hasBill: false,
    day: DAY,
    alreadyClaimed: [{ id: 'morning', kind: 'local_transport', claimedPaise: 40000, hasProof: false }],
  });
  assert.equal(p.proofRequired, false);
});

/* A limit on one fare is not a budget for the day, and must never be printed
   as one — the sentence says "today" and he plans the afternoon on it. */
test('a per-fare cap with no day cap behind it reports no daily budget', () => {
  const perFareOnly = policyOf([
    {
      ...ANY,
      kind: 'actuals',
      scopeKey: 'category:local_transport',
      capPerInstancePaise: 30000,
      capPerDayPaise: null,
    },
  ]);
  const p = previewClaim({
    policy: perFareOnly,
    kind: 'local_transport',
    claimedPaise: 0,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [],
  });
  assert.equal(p.remainingBeforePaise, null);
  assert.equal(p.line, '');

  /* The per-fare cap still bites on the claim itself. */
  const over = previewClaim({
    policy: perFareOnly,
    kind: 'local_transport',
    claimedPaise: 40000,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [],
  });
  assert.equal(over.eligiblePaise, 30000);
  assert.equal(over.excessPaise, 10000);
});

/* A hotel night nobody has priced earns nothing, which is the same shape as a
   budget fully spent and a completely different sentence. */
test('an unpriced hotel night is not a spent budget', () => {
  const noLodging = policyOf([]);
  const p = previewClaim({
    policy: noLodging,
    kind: 'lodging',
    claimedPaise: 0,
    hasBill: true,
    day: DAY,
    alreadyClaimed: [],
  });
  assert.equal(p.remainingBeforePaise, null);
  assert.doesNotMatch(p.line, /Nothing left/);
});
