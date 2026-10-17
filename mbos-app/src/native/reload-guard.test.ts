import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdReload, noteScreen, reloadIsSafe } from './reload-guard';

/* The guard is module state, so each test leaves it where it found it:
   on Home with nothing held. */

test('Home with nothing open is safe', () => {
  noteScreen('/home');
  assert.equal(reloadIsSafe(), true);
});

test('any screen past Home is not', () => {
  noteScreen('/order');
  assert.equal(reloadIsSafe(), false);
  noteScreen('/home');
});

test('an open sheet or camera holds it off, and releasing twice does not unbalance it', () => {
  noteScreen('/home');
  const a = holdReload();
  const b = holdReload();
  assert.equal(reloadIsSafe(), false);
  a();
  a();
  assert.equal(reloadIsSafe(), false);
  b();
  assert.equal(reloadIsSafe(), true);
});
