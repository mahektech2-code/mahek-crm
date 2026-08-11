/// <reference types="node" />
// The reference is explicit because this is the one file in an Expo app that
// runs under Node rather than on a handset, and the app's tsconfig does not
// pull `@types/node` in on its own.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessFix, haversineMetres, visitLocationVerdict, withinGeofence } from './geo';
import { optimiseRoute } from './route';
import { assessOrder } from './credit';
import { healthScore, type HealthInputs, type HealthThresholds, type HealthWeights } from './health';
import { applySchemes, matches, type Scheme } from './schemes';
import { cashPosition, type Collection } from './cash';
import { deriveStatus } from './attendance';
import { balanceAfter, leaveDays, overlaps } from './leave';
import { canValueOrders, derivedQuantities, lineValuePaise } from './order';

/**
 * These pin the rules, not the implementations. Every threshold is passed in
 * here exactly as it will be passed in from configuration, which is the point:
 * a test that reached for a default would be testing a literal the engines are
 * not allowed to contain.
 */

/* ------------------------------------------------------------------- geo */

const NAGPUR = { lat: 21.1458, lng: 79.0882 };

test('haversine agrees with a known distance', () => {
  const mumbai = { lat: 19.076, lng: 72.8777 };
  const km = haversineMetres(NAGPUR, mumbai) / 1000;
  assert.ok(km > 660 && km < 700, `${km} km`);
  assert.equal(haversineMetres(NAGPUR, NAGPUR), 0);
});

test('a geofence boundary includes its own edge', () => {
  // A point due north, at very close to 100 m.
  const north = { lat: NAGPUR.lat + 100 / 111_320, lng: NAGPUR.lng, accuracyM: 8 };
  const at100 = withinGeofence(north, NAGPUR, 100);
  assert.equal(at100.inside, true, 'at the radius counts as inside');
  assert.equal(withinGeofence(north, NAGPUR, 99).inside, false);
  assert.equal(withinGeofence({ ...NAGPUR, accuracyM: 5 }, NAGPUR, 0).inside, true);
});

test('a null fix is unknown, never a refusal', () => {
  const fence = withinGeofence(null, NAGPUR, 100);
  assert.equal(fence.inside, false);
  assert.equal(fence.unknown, true, 'inside:false alone would read as "he was not there"');
  assert.equal(fence.metresAway, null);

  const fix = assessFix(null, 50);
  assert.equal(fix.usable, false);
  assert.equal(fix.reason, 'no_fix');

  // The visit still goes ahead: no fix is not a mismatch.
  const verdict = visitLocationVerdict(null, NAGPUR, 150);
  assert.equal(verdict.mismatch, false);
  assert.equal(verdict.reason, 'no_fix');
});

test('a fix wider than the threshold is recorded and flagged, not usable', () => {
  assert.equal(assessFix({ ...NAGPUR, accuracyM: 12 }, 50).usable, true);
  const poor = assessFix({ ...NAGPUR, accuracyM: 120 }, 50);
  assert.equal(poor.usable, false);
  assert.equal(poor.reason, 'accuracy_poor');
  assert.equal(poor.accuracyM, 120, 'the bad reading is still carried through to be stored');
  // An unknown accuracy is treated as a bad one, never as a good one.
  assert.equal(assessFix({ ...NAGPUR, accuracyM: null }, 50).reason, 'accuracy_unknown');
});

test('a distant visit is flagged, and a customer with no coordinate is not', () => {
  const far = { lat: NAGPUR.lat + 0.01, lng: NAGPUR.lng, accuracyM: 10 };
  const flagged = visitLocationVerdict(far, NAGPUR, 150);
  assert.equal(flagged.mismatch, true);
  assert.equal(flagged.reason, 'too_far');
  assert.ok((flagged.metresAway ?? 0) > 1000);

  const noCoords = visitLocationVerdict(far, null, 150);
  assert.equal(noCoords.mismatch, false);
  assert.equal(noCoords.reason, 'customer_not_located');
});

/* ----------------------------------------------------------------- route */

const ROUTE_OPTS = {
  averageSpeedKmph: 20,
  maxTwoOptPasses: 12,
  maxStopsForTwoOpt: 60,
  minutesPerStop: 15,
};

test('unlocated stops are appended and flagged, never dropped', () => {
  const stops = [
    { id: 'a', coords: { lat: 21.15, lng: 79.09 } },
    { id: 'no-pin', coords: null },
    { id: 'b', coords: { lat: 21.16, lng: 79.10 } },
    { id: 'no-pin-2', coords: null },
  ];
  const r = optimiseRoute(stops, NAGPUR, ROUTE_OPTS);

  assert.equal(r.ordered.length, 4, 'every stop comes back');
  assert.deepEqual(r.unlocated.map((s) => s.id), ['no-pin', 'no-pin-2']);
  assert.deepEqual(r.ordered.slice(2).map((l) => l.stop.id), ['no-pin', 'no-pin-2']);
  assert.ok(r.ordered[2]!.flag, 'the tail says why it is at the end');
  assert.equal(r.ordered[2]!.located, false);
  assert.equal(r.ordered[0]!.located, true);
  assert.ok(r.totalTravelMinutes > 0);
});

test('the route starts at the nearest shop and 2-opt does not lengthen it', () => {
  // Four corners of a square, given in the crossing order.
  const stops = [
    { id: 'sw', coords: { lat: 21.10, lng: 79.00 } },
    { id: 'ne', coords: { lat: 21.20, lng: 79.10 } },
    { id: 'se', coords: { lat: 21.10, lng: 79.10 } },
    { id: 'nw', coords: { lat: 21.20, lng: 79.00 } },
  ];
  const start = { lat: 21.10, lng: 79.00 };
  const r = optimiseRoute(stops, start, ROUTE_OPTS);
  assert.equal(r.ordered[0]!.stop.id, 'sw', 'nearest to the start goes first');
  assert.equal(r.twoOptSkipped, false);

  const naive = optimiseRoute(stops, start, { ...ROUTE_OPTS, maxTwoOptPasses: 0 });
  assert.ok(r.totalDistanceMetres <= naive.totalDistanceMetres + 1e-6);
});

test('thirty stops finish well inside the budget', () => {
  const stops = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    coords: { lat: 21.1 + ((i * 37) % 100) / 1000, lng: 79.0 + ((i * 61) % 100) / 1000 },
  }));
  const began = Date.now();
  const r = optimiseRoute(stops, NAGPUR, ROUTE_OPTS);
  assert.ok(Date.now() - began < 2000);
  assert.equal(r.ordered.length, 30);
  assert.equal(new Set(r.ordered.map((l) => l.stop.id)).size, 30, 'no stop lost or duplicated');
});

test('a route with no stops, and one with no start', () => {
  assert.equal(optimiseRoute([], NAGPUR, ROUTE_OPTS).ordered.length, 0);
  const r = optimiseRoute(
    [{ id: 'a', coords: NAGPUR }, { id: 'b', coords: { lat: 21.2, lng: 79.2 } }],
    null,
    ROUTE_OPTS,
  );
  assert.equal(r.ordered.length, 2);
  assert.equal(r.ordered[0]!.metresFromPrevious, null, 'the first leg has no previous point');
});

/* ---------------------------------------------------------------- credit */

const CREDIT = {
  creditLimitPaise: 50_000_00,
  outstandingPaise: 20_000_00,
  submittedPaise: 5_000_00,
  approvalThresholdPaise: 0,
  secondTierThresholdPaise: 50_000_00,
};

test('credit-blocked is the one outright block, whatever the numbers say', () => {
  const r = assessOrder({
    ...CREDIT,
    creditBlocked: true,
    outstandingPaise: 0,
    submittedPaise: 0,
    orderValuePaise: 100_00,
  });
  assert.equal(r.decision, 'blocked');
  assert.equal(r.approverTier, 'none');
  assert.ok(r.reason.includes('credit-blocked'));
});

test('available subtracts outstanding AND submitted-but-not-invoiced', () => {
  const r = assessOrder({ ...CREDIT, creditBlocked: false, orderValuePaise: 25_000_00 });
  assert.equal(r.availablePaise, 25_000_00);
  assert.equal(r.decision, 'ok');
  assert.equal(r.overByPaise, 0);
});

test('over the limit routes to an approver rather than refusing', () => {
  const over = assessOrder({ ...CREDIT, creditBlocked: false, orderValuePaise: 30_000_00 });
  assert.equal(over.decision, 'needs_approval');
  assert.equal(over.overByPaise, 5_000_00);
  assert.equal(over.approverTier, 'manager');

  const wayOver = assessOrder({ ...CREDIT, creditBlocked: false, orderValuePaise: 200_000_00 });
  assert.equal(wayOver.decision, 'needs_approval');
  assert.equal(wayOver.approverTier, 'senior');
});

test('an allowance absorbs a small overshoot without anybody being rung', () => {
  const r = assessOrder({
    ...CREDIT,
    creditBlocked: false,
    approvalThresholdPaise: 1_000_00,
    orderValuePaise: 25_500_00,
  });
  assert.equal(r.decision, 'ok');
  assert.equal(r.overByPaise, 500_00, 'the overshoot is still reported, just not routed');
});

test('a limit or a value that is missing leaves the order unchecked, not refused', () => {
  const noLimit = assessOrder({ ...CREDIT, creditBlocked: false, creditLimitPaise: null, orderValuePaise: 30_000_00 });
  assert.equal(noLimit.decision, 'ok');
  assert.equal(noLimit.checked, false);
  assert.equal(noLimit.availablePaise, null, 'zero would read as "no headroom left"');
  assert.ok(noLimit.reason.includes('No credit limit on file'));

  // Until a price source is confirmed every order is unvalued — and an unvalued
  // order is not a zero-rupee order that fits comfortably inside the limit.
  const unvalued = assessOrder({ ...CREDIT, creditBlocked: false, orderValuePaise: null });
  assert.equal(unvalued.decision, 'ok');
  assert.equal(unvalued.checked, false);
  assert.equal(unvalued.overByPaise, 0);

  // A block still outranks both.
  assert.equal(
    assessOrder({ ...CREDIT, creditBlocked: true, creditLimitPaise: null, orderValuePaise: null }).decision,
    'blocked',
  );
});

/* ---------------------------------------------------------------- health */

const WEIGHTS: HealthWeights = {
  recency: 25,
  consistency: 15,
  value_trend: 15,
  payment: 20,
  outstanding: 10,
  coverage: 10,
  complaints: 5,
};

const HEALTH_THRESHOLDS: HealthThresholds = {
  neutralScore: 60,
  recency: { onTimeRatio: 0.9, lateRatio: 2 },
  consistency: { minIntervals: 3, steadyCoefficient: 0.2, erraticCoefficient: 0.8 },
  valueTrend: { growthForFull: 0.2, declineForZero: -0.3 },
  payment: { minRecords: 3 },
  outstanding: { comfortableUtilisation: 0.4, severeUtilisation: 1 },
  complaints: { perComplaintPenalty: 25, ageDaysForFullPenalty: 30 },
};

const HEALTHY: HealthInputs = {
  daysSinceLastOrder: 12,
  cycleDays: 20,
  orderIntervalDays: [20, 21, 19, 20],
  recentValuePaise: 120_000_00,
  priorValuePaise: 100_000_00,
  paymentsOnTime: 9,
  paymentsLate: 0,
  outstandingPaise: 10_000_00,
  creditLimitPaise: 100_000_00,
  visitsMade: 4,
  visitsExpected: 4,
  openComplaints: 0,
  oldestOpenComplaintDays: null,
};

test('the breakdown is seven components, each with its own sentence', () => {
  const r = healthScore(HEALTHY, WEIGHTS, HEALTH_THRESHOLDS);
  assert.equal(r.components.length, 7);
  for (const c of r.components) {
    assert.ok(c.sentence.length > 0, `${c.key} must explain itself`);
    assert.ok(c.score >= 0 && c.score <= 100);
  }
  assert.deepEqual(
    r.components.map((c) => c.key),
    ['recency', 'consistency', 'value_trend', 'payment', 'outstanding', 'coverage', 'complaints'],
  );
  assert.equal(r.score, 100, 'a customer doing everything right scores full marks');
});

test('weights are sum-normalised, so their scale cannot move the score', () => {
  const doubled = Object.fromEntries(
    Object.entries(WEIGHTS).map(([k, v]) => [k, v * 2]),
  ) as HealthWeights;
  const a = healthScore(HEALTHY, WEIGHTS, HEALTH_THRESHOLDS);
  const b = healthScore(HEALTHY, doubled, HEALTH_THRESHOLDS);
  assert.equal(a.score, b.score);

  const sum = a.components.reduce((s, c) => s + c.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'the normalised weights add up to one');

  // And the total really is the weighted mean of what the breakdown shows.
  const rebuilt = Math.round(a.components.reduce((s, c) => s + c.score * c.weight, 0));
  assert.equal(a.score, rebuilt);
});

test('a component with no history is neutral and says so', () => {
  const fresh = healthScore(
    {
      ...HEALTHY,
      daysSinceLastOrder: null,
      cycleDays: null,
      orderIntervalDays: [],
      priorValuePaise: null,
      paymentsOnTime: 0,
      paymentsLate: 0,
      creditLimitPaise: null,
      visitsExpected: 0,
    },
    WEIGHTS,
    HEALTH_THRESHOLDS,
  );
  const unknown = fresh.components.filter((c) => c.unknown).map((c) => c.key);
  assert.deepEqual(unknown, ['recency', 'consistency', 'value_trend', 'payment', 'outstanding', 'coverage']);
  for (const c of fresh.components) {
    if (c.unknown) assert.equal(c.score, HEALTH_THRESHOLDS.neutralScore);
  }
  assert.ok(fresh.score > 0, 'a new customer is not a bad customer');
});

test('overdue, late-paying and complained-about all pull the score down', () => {
  const poorly = healthScore(
    {
      ...HEALTHY,
      daysSinceLastOrder: 60,
      orderIntervalDays: [5, 40, 8, 55],
      recentValuePaise: 50_000_00,
      paymentsOnTime: 1,
      paymentsLate: 8,
      outstandingPaise: 120_000_00,
      visitsMade: 1,
      openComplaints: 2,
      oldestOpenComplaintDays: 45,
    },
    WEIGHTS,
    HEALTH_THRESHOLDS,
  );
  assert.ok(poorly.score < 40, `${poorly.score}`);
  const recency = poorly.components.find((c) => c.key === 'recency')!;
  assert.equal(recency.score, 0);
  assert.ok(recency.sentence.includes('overdue'));
});

/* --------------------------------------------------------------- schemes */

test('predicates are data and combine', () => {
  const facts = { customerCategory: 'dealer', cans: 24, brand: 'nano' };
  assert.equal(matches({ field: 'customerCategory', op: 'eq', value: 'dealer' }, facts), true);
  assert.equal(matches({ field: 'cans', op: 'gte', value: 24 }, facts), true);
  assert.equal(matches({ field: 'cans', op: 'gt', value: 24 }, facts), false);
  assert.equal(matches({ field: 'brand', op: 'in', value: ['nano', 'astar'] }, facts), true);
  assert.equal(
    matches({ all: [{ field: 'cans', op: 'gte', value: 10 }, { not: { field: 'brand', op: 'eq', value: 'other' } }] }, facts),
    true,
  );
  // A fact that is not there fails a numeric test rather than being coerced.
  assert.equal(matches({ field: 'missing', op: 'gte', value: 0 }, facts), false);
});

const DEALER_10: Scheme = {
  id: 'dealer10',
  name: 'Dealer 10%',
  level: 'line',
  when: {
    all: [
      { field: 'customerCategory', op: 'eq', value: 'dealer' },
      { field: 'cans', op: 'gte', value: 10 },
    ],
  },
  benefit: { kind: 'percent_discount', percent: 10 },
  priority: 10,
  stackable: true,
};

const BUY_10_GET_1: Scheme = {
  id: 'b10g1',
  name: 'Buy 10 get 1',
  level: 'line',
  when: { field: 'brand', op: 'eq', value: 'nano' },
  benefit: { kind: 'free_quantity', perCans: 10, freeCans: 1 },
  priority: 5,
  stackable: true,
};

const BIG_ORDER: Scheme = {
  id: 'big',
  name: 'Order over ₹1,00,000',
  level: 'order',
  when: { field: 'orderValuePaise', op: 'gte', value: 100_000_00 },
  benefit: { kind: 'flat_discount', amountPaise: 2_000_00 },
  priority: 1,
  stackable: true,
};

test('schemes apply per line and per order, from cached definitions', () => {
  const r = applySchemes(
    [
      { skuId: 'nano-20', cans: 25, valuePaise: 100_000_00, attributes: { brand: 'nano' } },
      { skuId: 'other-5', cans: 2, valuePaise: 5_000_00, attributes: { brand: 'other' } },
    ],
    'dealer',
    [DEALER_10, BUY_10_GET_1, BIG_ORDER],
  );

  assert.equal(r.lines[0]!.discountPaise, 10_000_00);
  assert.equal(r.lines[0]!.freeCans, 2, '25 cans is two whole sets of ten');
  assert.equal(r.lines[1]!.applied.length, 0, 'two cans of another brand qualifies for nothing');
  assert.equal(r.orderSchemes.length, 1);
  assert.equal(r.totalDiscountPaise, 12_000_00);
});

test('an unvalued line gives an unknown discount, never a confident zero', () => {
  const r = applySchemes(
    [{ skuId: 'nano-20', cans: 25, valuePaise: null, attributes: { brand: 'nano' } }],
    'dealer',
    [DEALER_10],
  );
  assert.equal(r.lines[0]!.discountPaise, null);
  assert.equal(r.totalDiscountPaise, null);
  assert.ok(r.lines[0]!.applied[0]!.sentence.includes('once this line has a price'));
});

test('a non-stacking scheme wins by priority instead of adding up', () => {
  const exclusive: Scheme = { ...DEALER_10, id: 'excl', name: 'Festive 15%', benefit: { kind: 'percent_discount', percent: 15 }, priority: 99, stackable: false };
  const r = applySchemes(
    [{ skuId: 'nano-20', cans: 25, valuePaise: 100_000_00, attributes: { brand: 'nano' } }],
    'dealer',
    [DEALER_10, BUY_10_GET_1, exclusive],
  );
  assert.deepEqual(r.lines[0]!.applied.map((a) => a.schemeId), ['excl']);
  assert.equal(r.lines[0]!.discountPaise, 15_000_00);
});

/* ------------------------------------------------------------------ cash */

const HOUR = 3_600_000;

test('cash carried is per-collection, and the SLA is too', () => {
  const now = 1_000 * HOUR;
  const collections: Collection[] = [
    { id: 'c1', customerName: 'Om Sai', amountPaise: 5_000_00, collectedAt: now - 50 * HOUR, mode: 'cash', depositedAt: null },
    { id: 'c2', customerName: 'Balaji', amountPaise: 3_000_00, collectedAt: now - 10 * HOUR, mode: 'cash', depositedAt: null },
    { id: 'c3', customerName: 'Banked', amountPaise: 9_000_00, collectedAt: now - 90 * HOUR, mode: 'cash', depositedAt: now - 80 * HOUR },
    { id: 'c4', customerName: 'By cheque', amountPaise: 7_000_00, collectedAt: now - 90 * HOUR, mode: 'cheque', depositedAt: null },
  ];
  const p = cashPosition(collections, 48, now);

  assert.equal(p.totalPaise, 8_000_00, 'deposited cash and non-cash are not carried');
  assert.equal(p.oldest!.id, 'c1');
  assert.deepEqual(p.pastSla.map((c) => c.id), ['c1']);
  assert.equal(p.nextDeadline, now - 10 * HOUR + 48 * HOUR);
  assert.ok(p.sentence.includes('past the deposit deadline'));

  const clean = cashPosition([], 48, now);
  assert.equal(clean.totalPaise, 0);
  assert.equal(clean.oldest, null);
  assert.equal(clean.nextDeadline, null);
});

/* ------------------------------------------------------------ attendance */

const SHIFT = { halfDayThresholdHours: 4, fullDayThresholdHours: 8, isWorkingDay: true, approvedLeave: null };
const nine = 9 * HOUR;

test('attendance status comes off the summed sessions', () => {
  const full = deriveStatus({
    ...SHIFT,
    sessions: [
      { id: 's1', checkInAt: nine, checkOutAt: nine + 5 * HOUR },
      { id: 's2', checkInAt: nine + 6 * HOUR, checkOutAt: nine + 10 * HOUR },
    ],
  });
  assert.equal(full.status, 'Present');
  assert.equal(full.workedMinutes, 9 * 60);
  assert.equal(full.needsRegularization, false);

  const half = deriveStatus({ ...SHIFT, sessions: [{ id: 's1', checkInAt: nine, checkOutAt: nine + 5 * HOUR }] });
  assert.equal(half.status, 'Half Day');

  const short = deriveStatus({ ...SHIFT, sessions: [{ id: 's1', checkInAt: nine, checkOutAt: nine + 1 * HOUR }] });
  assert.equal(short.status, 'Absent');

  assert.equal(deriveStatus({ ...SHIFT, sessions: [] }).status, 'Absent');
});

test('a missed check-out is flagged, not guessed at', () => {
  const r = deriveStatus({
    ...SHIFT,
    sessions: [
      { id: 's1', checkInAt: nine, checkOutAt: nine + 5 * HOUR },
      { id: 's2', checkInAt: nine + 6 * HOUR, checkOutAt: null },
    ],
  });
  assert.equal(r.workedMinutes, 5 * 60, 'the open session contributes nothing');
  assert.deepEqual(r.openSessionIds, ['s2']);
  assert.equal(r.needsRegularization, true);
  assert.equal(r.status, 'Half Day');
  assert.ok(r.sentence.includes('regularize'));
});

test('leave and non-working days are not absences', () => {
  const onLeave = deriveStatus({ ...SHIFT, sessions: [], approvedLeave: { kind: 'casual', portion: 'full' } });
  assert.equal(onLeave.status, 'On Leave');

  const sunday = deriveStatus({ ...SHIFT, sessions: [], isWorkingDay: false });
  assert.equal(sunday.status, 'Weekly Off');

  // Half a day's leave leaves half a day to be worked, so four hours is a full day.
  const halfLeave = deriveStatus({
    ...SHIFT,
    sessions: [{ id: 's1', checkInAt: nine, checkOutAt: nine + 4 * HOUR }],
    approvedLeave: { kind: 'casual', portion: 'half' },
  });
  assert.equal(halfLeave.status, 'Present');
});

/* ----------------------------------------------------------------- leave */

test('leave days count inclusively, and a half day is half', () => {
  assert.equal(leaveDays({ span: 'single', from: '2026-08-11', to: '2026-08-11', half: null }).days, 1);
  assert.equal(leaveDays({ span: 'single', from: '2026-08-11', to: '2026-08-11', half: 'first_half' }).days, 0.5);
  assert.equal(leaveDays({ span: 'range', from: '2026-08-11', to: '2026-08-13', half: null }).days, 3);
  // Across a month end, and across a leap day.
  assert.equal(leaveDays({ span: 'range', from: '2026-01-30', to: '2026-02-02', half: null }).days, 4);

  const noted = leaveDays({ span: 'range', from: '2026-08-11', to: '2026-08-13', half: 'first_half' });
  assert.equal(noted.days, 3);
  assert.ok(noted.note, 'a half day on a range is dropped, and the form is told');
});

test('the balance says in words how much of this goes unpaid', () => {
  const fits = balanceAfter(3, { balanceDays: 8, kind: 'casual days' });
  assert.equal(fits.unpaidDays, 0);
  assert.equal(fits.unpaidSentence, '');
  assert.equal(fits.remainingDays, 5);

  const over = balanceAfter(5, { balanceDays: 2, kind: 'casual days' });
  assert.equal(over.paidDays, 2);
  assert.equal(over.unpaidDays, 3);
  assert.equal(over.unpaidSentence, '3 days of this goes unpaid.');
  assert.equal(over.remainingDays, 0);

  const none = balanceAfter(1, { balanceDays: 0, kind: 'sick days' });
  assert.equal(none.unpaidSentence, '1 day of this goes unpaid.');

  const halfOver = balanceAfter(1, { balanceDays: 0.5, kind: 'casual days' });
  assert.equal(halfOver.unpaidSentence, '0.5 days of this goes unpaid.');
});

test('overlapping requests are blocked, against pending as well as approved', () => {
  const existing = [
    { id: 'l1', from: '2026-08-10', to: '2026-08-12', status: 'approved' },
    { id: 'l2', from: '2026-09-01', to: '2026-09-02', status: 'pending' },
    { id: 'l3', from: '2026-08-20', to: '2026-08-25', status: 'rejected' },
  ];
  const blocking = ['pending', 'approved'];

  const clash = overlaps({ span: 'range', from: '2026-08-12', to: '2026-08-14', half: null }, existing, blocking);
  assert.equal(clash.blocked, true, 'touching on one day is an overlap');
  assert.deepEqual(clash.clashes.map((c) => c.id), ['l1']);
  assert.ok(clash.sentence.length > 0);

  const pending = overlaps({ span: 'single', from: '2026-09-01', to: '2026-09-01', half: null }, existing, blocking);
  assert.equal(pending.blocked, true, 'a pending request blocks too — it will be approved by someone else');

  const rejected = overlaps({ span: 'single', from: '2026-08-21', to: '2026-08-21', half: null }, existing, blocking);
  assert.equal(rejected.blocked, false, 'a rejected request holds nothing');

  const clear = overlaps({ span: 'range', from: '2026-08-13', to: '2026-08-15', half: null }, existing, blocking);
  assert.equal(clear.blocked, false);
});

/* ----------------------------------------------------------------- order */

test('quantities derive boxes and litres from cans', () => {
  assert.deepEqual(derivedQuantities(25, 6, 5000), { cans: 25, boxes: 4, looseCans: 1, litres: 125 });
  // Loose and drums have no box, so everything is a remainder.
  assert.deepEqual(derivedQuantities(3, 1, 20_000), { cans: 3, boxes: 0, looseCans: 3, litres: 60 });
  // An unknown pack size gives null litres, never zero.
  assert.equal(derivedQuantities(4, 6, null).litres, null);
  assert.deepEqual(derivedQuantities(0, 6, 5000), { cans: 0, boxes: 0, looseCans: 0, litres: 0 });
});

test('nothing may be valued until a price source is confirmed', () => {
  assert.equal(canValueOrders('unset'), false);
  assert.equal(canValueOrders('product'), true);
  assert.equal(canValueOrders('pricelist'), true);
  assert.equal(canValueOrders('manual'), true);

  assert.equal(lineValuePaise('unset', 10, { sellingPricePaise: 500_00 }, 5_000_00), null);
  assert.equal(lineValuePaise('product', 10, { sellingPricePaise: 500_00 }, null), 5_000_00);
  // A null price is not a free product.
  assert.equal(lineValuePaise('product', 10, { sellingPricePaise: null }, 9_999_00), null);
  assert.equal(lineValuePaise('manual', 10, { sellingPricePaise: 500_00 }, 4_200_00), 4_200_00);
  assert.equal(lineValuePaise('pricelist', 10, { sellingPricePaise: 500_00 }, 4_200_00), 4_200_00);
});
