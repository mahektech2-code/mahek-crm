import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authLostReasonFor,
  authLostSentence,
  DEVICE_KV_KEYS,
  handoverRefusal,
  handoverVerdict,
  loginStepFor,
  noAnswerSentence,
  offlineWindow,
  unreadableAnswerSentence,
} from './sign-in';

/**
 * Signing in and out, pinned.
 *
 * Every one of these was wrong in production with a green suite, because the
 * code lived in `data/session.ts` beside the keychain and the database and
 * nothing could run it.
 */

test('a wrong WhatsApp code is a credential refusal, never a red mobile number', () => {
  assert.equal(loginStepFor('bad_otp'), 'credential');
  assert.equal(loginStepFor('bad_password'), 'credential');
});

test('only an unknown account or an unreadable request is put on the mobile field', () => {
  assert.equal(loginStepFor('unknown_user'), 'mobile');
  assert.equal(loginStepFor('validation'), 'mobile');
  for (const step of ['device_bound', 'device_released', 'inactive', 'not_configured', 'bootstrap_failed']) {
    assert.equal(loginStepFor(step), 'status', step);
  }
});

test('a word this build has never heard of goes to the banner, not the number', () => {
  assert.equal(loginStepFor('something_new'), 'status');
  assert.equal(loginStepFor(null), 'status');
});

test('a server that is down is a network answer', () => {
  assert.equal(loginStepFor('server_down'), 'network');
});

test('the 403s that last until a person acts end the session; others do not', () => {
  assert.equal(authLostReasonFor(403, 'device_released'), 'device_released');
  assert.equal(authLostReasonFor(403, 'inactive'), 'inactive');
  assert.equal(authLostReasonFor(403, 'no_app_access'), 'no_app_access');
  assert.equal(authLostReasonFor(401, 'unknown_user'), 'unknown_user');
  /* An ordinary refusal of one request is not a lost session. */
  assert.equal(authLostReasonFor(403, 'not_permitted'), null);
  assert.equal(authLostReasonFor(409, 'device_bound'), null);
  assert.equal(authLostReasonFor(500, null), null);
});

test('every lost-session reason has a sentence, and none says "no internet"', () => {
  for (const r of ['expired', 'device_released', 'inactive', 'no_app_access', 'unknown_user'] as const) {
    const s = authLostSentence(r);
    assert.ok(s.length > 20, r);
    assert.ok(!/internet/i.test(s), r);
  }
});

test('the first person on a phone is let in', () => {
  assert.deepEqual(handoverVerdict({ last: null, mobile: '9820011007', unsent: 5 }), { kind: 'first-sign-in' });
});

test('the same person is recognised by number, however it was typed', () => {
  const last = { userId: 'u1', mobile: '9820011007', name: 'Mahesh' };
  assert.equal(handoverVerdict({ last, mobile: '+91 98200 11007', unsent: 4 }).kind, 'same-person');
});

test('the same person is recognised by account id once the server has named it', () => {
  const last = { userId: 'u1', mobile: '9820011007', name: 'Mahesh' };
  assert.equal(handoverVerdict({ last, userId: 'u1', mobile: 'mahesh@mahek.in', unsent: 4 }).kind, 'same-person');
});

test("a different person is refused while the last person's work is waiting", () => {
  const last = { userId: 'u1', mobile: '9820011007', name: 'Mahesh' };
  const v = handoverVerdict({ last, mobile: '9820011008', unsent: 3 });
  assert.deepEqual(v, { kind: 'refuse', unsent: 3, lastName: 'Mahesh' });
  const msg = handoverRefusal(3, 'Mahesh');
  assert.match(msg, /3 entries from Mahesh/);
});

test('a different person on a phone with nothing waiting starts clean', () => {
  const last = { userId: 'u1', mobile: '9820011007', name: 'Mahesh' };
  assert.equal(handoverVerdict({ last, userId: 'u2', unsent: 0 }).kind, 'new-person-clean');
});

test('the last-user record survives the wipe a new person causes', () => {
  assert.ok(DEVICE_KV_KEYS.includes('mbos.lastUser'));
  /* The person's own day must not survive it. */
  for (const k of ['pullCursor', 'mbos.session', 'territory', 'trailLastKeptAt', 'mbos.offPlanReason']) {
    assert.ok(!DEVICE_KV_KEYS.includes(k), k);
  }
});

test('the offline window is measured from the last online sign-in', () => {
  const day = 86_400_000;
  assert.deepEqual(offlineWindow({ lastOnlineAt: 10 * day, now: 15 * day, validityDays: 7 }), { ok: true });
  assert.deepEqual(offlineWindow({ lastOnlineAt: 10 * day, now: 18 * day, validityDays: 7 }), { ok: false, ageDays: 8 });
  /* Never signed in online: no window at all. */
  assert.equal(offlineWindow({ lastOnlineAt: 0, now: day, validityDays: 7 }).ok, false);
});

test('a timeout is never described as having no internet', () => {
  assert.ok(!/no internet/i.test(noAnswerSentence('timeout')));
  assert.match(noAnswerSentence('offline'), /No internet/);
});

test('an unreadable server answer is a sentence, not a page of HTML', () => {
  assert.match(unreadableAnswerSentence(502), /not answering/);
  assert.match(unreadableAnswerSentence(418), /error 418/);
});
