import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FEEDBACK_PREFS,
  FEEDBACK_DEBOUNCE_MS,
  feedbackForTone,
  plan,
  shouldFire,
  toneOfNotification,
} from './feedback';

test('sounds are off and haptics on until somebody chooses otherwise', () => {
  assert.deepEqual(DEFAULT_FEEDBACK_PREFS, { haptics: true, sounds: false });
  assert.deepEqual(plan('success', DEFAULT_FEEDBACK_PREFS, 'normal'), { haptic: 'success', sound: null });
});

test('a silenced phone never chimes; the buzz is left to the system touch setting', () => {
  assert.deepEqual(plan('success', { haptics: true, sounds: true }, 'silent'), { haptic: 'success', sound: null });
});

test('vibrate mode keeps the buzz and drops the chime', () => {
  assert.deepEqual(plan('error', { haptics: true, sounds: true }, 'vibrate'), { haptic: 'error', sound: null });
});

test('an unknown ringer mode is read as silent for sound, never for touch', () => {
  assert.deepEqual(plan('success', { haptics: true, sounds: true }, 'unknown'), { haptic: 'success', sound: null });
});

test('only outcomes have a sound — a tab switch is never heard', () => {
  const loud = { haptics: true, sounds: true };
  assert.equal(plan('select', loud, 'normal').sound, null);
  assert.equal(plan('tap', loud, 'normal').sound, null);
  assert.equal(plan('success', loud, 'normal').sound, 'ui_success');
  assert.equal(plan('warning', loud, 'normal').sound, 'ui_warning');
  assert.equal(plan('error', loud, 'normal').sound, 'ui_error');
  assert.equal(plan('arrive', loud, 'normal').sound, 'ui_arrive');
});

test('each switch governs only its own half', () => {
  assert.deepEqual(plan('success', { haptics: false, sounds: true }, 'normal'), { haptic: null, sound: 'ui_success' });
  assert.deepEqual(plan('success', { haptics: false, sounds: false }, 'normal'), { haptic: null, sound: null });
});

test('the same kind twice inside the window is one event; a different kind is not', () => {
  const at = 10_000;
  assert.equal(shouldFire('success', null, at), true);
  assert.equal(shouldFire('success', { kind: 'success', at }, at + FEEDBACK_DEBOUNCE_MS - 1), false);
  assert.equal(shouldFire('success', { kind: 'success', at }, at + FEEDBACK_DEBOUNCE_MS), true);
  assert.equal(shouldFire('error', { kind: 'success', at }, at + 10), true);
  assert.equal(shouldFire('success', { kind: 'success', at }, at - 5_000), true);
});

test('every spelling of a warning reads as a warning, and an unknown kind is neutral', () => {
  for (const k of ['warn', 'warning', 'WARNING', 'danger', 'rejected', 'error']) assert.equal(toneOfNotification(k), 'warn');
  for (const k of ['success', 'accepted', 'approved']) assert.equal(toneOfNotification(k), 'success');
  for (const k of ['info', 'lead', '', null, undefined, 7]) assert.equal(toneOfNotification(k), 'info');
  assert.equal(feedbackForTone('warn'), 'warning');
  assert.equal(feedbackForTone('success'), 'arrive');
});
