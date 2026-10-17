import { test } from 'node:test';
import assert from 'node:assert/strict';

import { phoneReadiness, type ReadinessInput } from './phone-readiness';
import { setupSteps, type SetupFacts } from './setup-walkthrough';
import { firstOpen, outstandingChecks, stepsForEntry, type SetupEntry } from './setup-steps';

const NOW = Date.parse('2026-10-04T08:00:00+05:30');

function facts(over: Partial<SetupFacts> = {}): SetupFacts {
  return {
    android: true,
    manufacturer: 'vivo',
    locationServicesEnabled: true,
    foreground: 'granted',
    foregroundCanAsk: true,
    background: 'granted',
    backgroundCanAsk: true,
    notifications: 'granted',
    notificationsCanAsk: true,
    camera: 'granted',
    cameraCanAsk: true,
    microphone: 'granted',
    microphoneCanAsk: true,
    batteryExemption: 'exempt',
    autostartConfirmedAt: NOW - 86_400_000,
    ...over,
  };
}

/** The gate's input for the same phone, so both engines read one state. */
function readinessOf(f: SetupFacts, over: Partial<ReadinessInput> = {}) {
  return phoneReadiness({
    manufacturer: f.manufacturer,
    locationServicesEnabled: f.locationServicesEnabled,
    foreground: f.foreground,
    background: f.background,
    canAskAgain: f.backgroundCanAsk,
    batteryExemption: f.batteryExemption,
    previousWorkedDay: { day: '2026-10-03', hadTrail: true },
    acknowledgedAt: null,
    nowMs: NOW,
    ...over,
  });
}

const ENTRIES: SetupEntry[] = ['walkthrough', 'gate', 'tracking'];

const STATES: [string, Partial<SetupFacts>][] = [
  ['a phone that is fully set up', {}],
  ['a fresh install', {
    foreground: 'undetermined', background: 'undetermined', notifications: 'undetermined',
    camera: 'undetermined', microphone: 'undetermined', batteryExemption: 'optimised', autostartConfirmedAt: null,
  }],
  ['location switched off', { locationServicesEnabled: false }],
  ['background refused for good', { background: 'denied', backgroundCanAsk: false }],
  ['battery saver on', { batteryExemption: 'optimised' }],
];

for (const [name, over] of STATES) {
  test(`every screen lists the same steps under the same titles — ${name}`, () => {
    const f = facts(over);
    const steps = setupSteps(f);
    const readiness = readinessOf(f);
    const lists = ENTRIES.map((e) => stepsForEntry(e, steps, readiness).map((s) => `${s.key}:${s.title}`));
    for (const list of lists.slice(1)) assert.deepEqual(list, lists[0]);
    assert.equal(lists[0].length, 5);
  });
}

test('only the gate says a step holds the day', () => {
  const f = facts({ batteryExemption: 'optimised' });
  const steps = setupSteps(f);
  const readiness = readinessOf(f);
  const gate = stepsForEntry('gate', steps, readiness);
  assert.equal(gate.find((s) => s.key === 'battery')?.blocksDay, true);
  for (const entry of ['walkthrough', 'tracking'] as const) {
    assert.ok(stepsForEntry(entry, steps, readiness).every((s) => !s.blocksDay));
  }
});

test('a silent last day reopens autostart on the gate, in the gate\'s own words, under the shared title', () => {
  const f = facts();
  const steps = setupSteps(f);
  const readiness = readinessOf(f, { previousWorkedDay: { day: '2026-10-03', hadTrail: false } });
  const walkthrough = stepsForEntry('walkthrough', steps, readiness).find((s) => s.key === 'autostart')!;
  const gate = stepsForEntry('gate', steps, readiness).find((s) => s.key === 'autostart')!;
  assert.equal(walkthrough.tone, 'done', 'he confirmed it once on this install');
  assert.equal(gate.tone, 'todo');
  assert.equal(gate.blocksDay, true);
  assert.equal(gate.title, walkthrough.title);
  assert.match(gate.detail, /saved no movement/);
});

test('a permission Android will not ask for again is stuck on the gate, and still has a button', () => {
  const f = facts({ background: 'denied', backgroundCanAsk: false });
  const gate = stepsForEntry('gate', setupSteps(f), readinessOf(f));
  const bg = gate.find((s) => s.key === 'background')!;
  assert.equal(bg.tone, 'stuck');
  assert.equal(bg.action, 'app_settings');
  assert.ok(bg.button);
});

test('the gate without a reading yet draws the shared list unchanged', () => {
  const steps = setupSteps(facts({ batteryExemption: 'optimised' }));
  assert.deepEqual(stepsForEntry('gate', steps, null), stepsForEntry('walkthrough', steps));
});

test('the first open step is the first with anything to press', () => {
  const f = facts({ batteryExemption: 'optimised', autostartConfirmedAt: null });
  assert.equal(firstOpen(stepsForEntry('walkthrough', setupSteps(f)))?.key, 'battery');
  assert.equal(firstOpen(stepsForEntry('walkthrough', setupSteps(facts()))), null);
});

test('the acknowledgement records what the gate still had outstanding', () => {
  const f = facts({ batteryExemption: 'optimised' });
  const keys = outstandingChecks(readinessOf(f));
  assert.ok(keys.includes('battery'));
  assert.ok(!keys.includes('foreground'));
  assert.deepEqual(outstandingChecks(null), []);
});
