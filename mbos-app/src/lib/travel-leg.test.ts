import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arrivalPrompt, checkFare, checkOdometer, legLine, travellingFor } from './travel-leg';

/**
 * The rules a journey is measured by.
 *
 * Pinned here rather than exercised on a handset because every one of them
 * decides money: the distance the policy engine prices, and whether a fare
 * reaches the day's claim at all. A rule that can only be tested by standing
 * in a street with a camera is a rule nobody tests.
 */

/* ────────────────────────────────────────────────────────── the odometer */

test('a departure reading is accepted on its own, with no distance yet', () => {
  const v = checkOdometer({ typed: '41208', previousKm: null, maxLegKilometres: 400 });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.km, 41208);
  /* Null, not zero. Zero is a real distance meaning he came back to where he
     started, and a departure is not a zero-length journey. */
  assert.equal(v.ok && v.distanceKm, null);
});

test('a decimal trip reading is accepted and floored, never refused', () => {
  /* Trip meters show a decimal and odometers do not. Refusing somebody over
     the part nobody is paid for would be refusing to record the journey. */
  const v = checkOdometer({ typed: '41208.6', previousKm: null, maxLegKilometres: 400 });
  assert.equal(v.ok && v.km, 41208);
});

test('an arrival lower than the departure is refused, because meters do not run backwards', () => {
  const v = checkOdometer({ typed: '4120', previousKm: 41208, maxLegKilometres: 400 });
  assert.equal(v.ok, false);
  /* And it names the likely cause. "Invalid reading" sends somebody looking
     for a fault in the app; "a digit dropped from the front" sends them back
     to the meter, which is where the answer is. */
  assert.match(!v.ok ? v.why : '', /digit dropped/i);
});

test('an implausible distance is refused while he is still at the meter', () => {
  const v = checkOdometer({ typed: '48000', previousKm: 41208, maxLegKilometres: 400 });
  assert.equal(v.ok, false);
  assert.match(!v.ok ? v.why : '', /6,792 km|6792 km/);
});

test('the cap is the configured one, not a number written into the rule', () => {
  const tight = checkOdometer({ typed: '41308', previousKm: 41208, maxLegKilometres: 50 });
  assert.equal(tight.ok, false);
  const loose = checkOdometer({ typed: '41308', previousKm: 41208, maxLegKilometres: 400 });
  assert.equal(loose.ok, true);
  assert.equal(loose.ok && loose.distanceKm, 100);
});

test('a journey that ends where it started is a real answer, not a refusal', () => {
  /* It is what a called-off trip records, and it has to be storable. */
  const v = checkOdometer({ typed: '41208', previousKm: 41208, maxLegKilometres: 400 });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.distanceKm, 0);
});

test('anything that is not a reading is refused before it can be stored', () => {
  for (const typed of ['', '   ', 'about 40', '41,208', '-5', '1e9']) {
    assert.equal(
      checkOdometer({ typed, previousKm: null, maxLegKilometres: 400 }).ok,
      false,
      `${JSON.stringify(typed)} should not be accepted as a reading`,
    );
  }
});

/* ───────────────────────────────────────────────────────────── the fare */

test('a fare is read into paise, because money is paise everywhere', () => {
  assert.deepEqual(checkFare('40'), { ok: true, paise: 4000 });
  assert.deepEqual(checkFare('40.50'), { ok: true, paise: 4050 });
  assert.deepEqual(checkFare('1,250'), { ok: true, paise: 125000 });
});

test('a ticket that cost nothing is not a ticket to claim', () => {
  /* Zero would reach the day's claim as a line somebody has to open, read and
     dismiss — and a free ride is not a ticket. */
  assert.equal(checkFare('0').ok, false);
  assert.equal(checkFare('0.00').ok, false);
  assert.equal(checkFare('').ok, false);
  assert.equal(checkFare('forty').ok, false);
});

/* ────────────────────────────────────────────────── what the screen says */

test('the arrival prompt names the camera on a metered mode and not otherwise', () => {
  const metered = arrivalPrompt({ requiresOdometer: true, odometerStartKm: 41208 });
  assert.match(metered.button, /meter/i);
  /* The departure reading is repeated back, so he checks the second number
     against the first rather than against his memory. */
  assert.match(metered.line, /41,208/);

  const free = arrivalPrompt({ requiresOdometer: false, odometerStartKm: null });
  assert.match(free.button, /start the visit/i);
  assert.doesNotMatch(free.button, /meter/i);
});

test('a leg prints a distance or a fare, and never invents either', () => {
  assert.equal(
    legLine({ modeLabel: 'Bike', odometerStartKm: 41208, odometerEndKm: 41231, ticketAmountPaise: null }),
    'Bike · 23 km',
  );
  assert.equal(
    legLine({ modeLabel: 'Bus', odometerStartKm: null, odometerEndKm: null, ticketAmountPaise: 4000 }),
    'Bus · ₹40',
  );
  /* ONE reading is not half a distance — it is a departure nobody closed. The
     mode alone, never "0 km", which is a claim about a journey nobody
     measured. */
  assert.equal(
    legLine({ modeLabel: 'Bike', odometerStartKm: 41208, odometerEndKm: null, ticketAmountPaise: null }),
    'Bike',
  );
  assert.equal(
    legLine({ modeLabel: 'Walked', odometerStartKm: null, odometerEndKm: null, ticketAmountPaise: null }),
    'Walked',
  );
});

test('travelling time counts up and is never negative', () => {
  const at = 1_700_000_000_000;
  assert.equal(travellingFor(at, at + 14 * 60_000), '14 min');
  assert.equal(travellingFor(at, at + 95 * 60_000), '1h 35m');
  /* A phone whose clock stepped backwards mid-journey must not report a
     negative ride. */
  assert.equal(travellingFor(at, at - 60_000), '0 min');
});
