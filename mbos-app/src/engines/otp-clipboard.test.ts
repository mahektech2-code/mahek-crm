import { test } from 'node:test';
import assert from 'node:assert/strict';

import { otpFromClipboard } from './otp-clipboard';

const none = new Set<string>();

test('a bare code is taken', () => {
  assert.equal(otpFromClipboard('482913', none), '482913');
  assert.equal(otpFromClipboard(' 482913\n', none), '482913');
});

test('a whole copied message gives up its one code', () => {
  assert.equal(otpFromClipboard('482913 is your verification code. Valid for 10 minutes.', none), '482913');
  assert.equal(otpFromClipboard('Your MahekOne OTP is 004517', none), '004517');
});

test('nothing that is not exactly one six-digit run', () => {
  assert.equal(otpFromClipboard('', none), null);
  assert.equal(otpFromClipboard(null, none), null);
  assert.equal(otpFromClipboard('12345', none), null);
  assert.equal(otpFromClipboard('1234567', none), null);
  assert.equal(otpFromClipboard('9876543210', none), null, 'a phone number is not a code');
  assert.equal(otpFromClipboard('Order 123456 for ₹654321', none), null, 'two runs is a guess');
  assert.equal(otpFromClipboard(`${'x'.repeat(600)} 482913`, none), null);
});

test('a code already tried is left alone', () => {
  assert.equal(otpFromClipboard('482913', new Set(['482913'])), null);
});
