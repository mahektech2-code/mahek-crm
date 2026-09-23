import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentStep,
  outstandingPopups,
  setupSteps,
  shouldOpenWalkthrough,
  type SetupFacts,
  type StepKey,
} from './setup-walkthrough';

/**
 * The walkthrough, pinned.
 *
 * Two things are worth a test here: the ORDER, because Android refuses the
 * background permission until the foreground one is held, and WHEN the screen
 * takes over the phone, because a screen that opens on every launch is one
 * people learn to dismiss.
 */

/** A phone with everything done. Each test undoes exactly one thing. */
const SET_UP: SetupFacts = {
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
  autostartConfirmedAt: 1,
};

/** A fresh install on Android: nothing asked yet. */
const FRESH: SetupFacts = {
  ...SET_UP,
  foreground: 'undetermined',
  background: 'undetermined',
  notifications: 'undetermined',
  camera: 'undetermined',
  microphone: 'undetermined',
  batteryExemption: 'optimised',
  autostartConfirmedAt: null,
};

function step(f: SetupFacts, key: StepKey) {
  const s = setupSteps(f).find((x) => x.key === key);
  assert.ok(s, `no ${key} step`);
  return s;
}

test('a phone with everything done has no step left and never opens the walkthrough', () => {
  const steps = setupSteps(SET_UP);
  assert.equal(currentStep(steps), null);
  assert.equal(shouldOpenWalkthrough({ steps, version: '1.11.0 (16)', shownForVersion: null }), false);
});

test('a fresh install walks the five steps in the order Android allows', () => {
  assert.deepEqual(
    setupSteps(FRESH).map((s) => s.key),
    ['allow', 'location_services', 'background', 'battery', 'autostart'],
  );
  assert.equal(currentStep(setupSteps(FRESH))?.key, 'allow');
});

test('the four popups are asked together, and the button counts them', () => {
  const s = step(FRESH, 'allow');
  assert.equal(s.state, 'todo');
  assert.equal(s.action, 'ask_popups');
  assert.equal(s.button, 'Allow all 4');
  assert.deepEqual(outstandingPopups(FRESH).ask, ['location', 'notifications', 'camera', 'microphone']);
});

test('a popup Android has stopped showing is sent to Settings once the others are answered', () => {
  const f: SetupFacts = { ...SET_UP, camera: 'denied', cameraCanAsk: false };
  const s = step(f, 'allow');
  assert.equal(s.state, 'settings');
  assert.equal(s.action, 'app_settings');
  assert.match(s.detail, /camera/);
});

test('popups that can still be asked go first, even when another needs Settings', () => {
  const f: SetupFacts = { ...SET_UP, camera: 'denied', cameraCanAsk: false, microphone: 'undetermined' };
  const s = step(f, 'allow');
  assert.equal(s.action, 'ask_popups');
  assert.equal(s.button, 'Allow');
});

test('"all the time" waits for the foreground permission rather than spending the ask', () => {
  const f: SetupFacts = { ...SET_UP, foreground: 'undetermined', background: 'undetermined' };
  const s = step(f, 'background');
  assert.equal(s.action, null);
  /* And the walkthrough is on the popups, not here. */
  assert.equal(currentStep(setupSteps(f))?.key, 'allow');
});

test('"all the time" opens the location page once location is allowed', () => {
  const f: SetupFacts = { ...SET_UP, background: 'denied' };
  const s = step(f, 'background');
  assert.equal(s.state, 'todo');
  assert.equal(s.action, 'ask_background');
  assert.match(s.detail, /Allow all the time/);
});

test('"all the time" goes to app settings once Android stops offering it', () => {
  const s = step({ ...SET_UP, background: 'denied', backgroundCanAsk: false }, 'background');
  assert.equal(s.state, 'settings');
  assert.equal(s.action, 'app_settings');
});

test('location switched off is its own step; a phone that will not say is not held against him', () => {
  assert.equal(step({ ...SET_UP, locationServicesEnabled: false }, 'location_services').action, 'location_settings');
  assert.equal(step({ ...SET_UP, locationServicesEnabled: null }, 'location_services').state, 'done');
});

test('the battery step is the one-tap popup, and an unreadable answer is not a step', () => {
  assert.equal(step({ ...SET_UP, batteryExemption: 'optimised' }, 'battery').action, 'battery');
  assert.equal(step({ ...SET_UP, batteryExemption: 'unknown' }, 'battery').state, 'done');
});

test('autostart names the switch in the manufacturer’s own words, until he confirms it', () => {
  const s = step({ ...SET_UP, autostartConfirmedAt: null }, 'autostart');
  assert.equal(s.state, 'todo');
  assert.equal(s.action, 'autostart');
  assert.ok(s.detail.length > 20);
  assert.equal(step(SET_UP, 'autostart').state, 'done');
});

test('iOS has no battery or autostart step', () => {
  const f: SetupFacts = { ...FRESH, android: false };
  assert.equal(step(f, 'battery').state, 'done');
  assert.equal(step(f, 'autostart').state, 'done');
});

test('it opens once per build: after install, after an update, and not again after Later', () => {
  const steps = setupSteps(FRESH);
  /* Fresh install — never shown. */
  assert.equal(shouldOpenWalkthrough({ steps, version: '1.11.0 (16)', shownForVersion: null }), true);
  /* Shown on this build and left — the day gate holds the line from here. */
  assert.equal(shouldOpenWalkthrough({ steps, version: '1.11.0 (16)', shownForVersion: '1.11.0 (16)' }), false);
  /* An update with something still missing opens it again. */
  assert.equal(shouldOpenWalkthrough({ steps, version: '1.12.0 (17)', shownForVersion: '1.11.0 (16)' }), true);
});
