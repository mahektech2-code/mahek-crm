import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryPercent, connectionAnswer, permissionAnswer } from './device-state';

describe('the foreground answer is read first', () => {
  test('refused in the foreground is refused, whatever background says', () => {
    /* A stale background grant on a phone whose location has since been
       revoked would otherwise report "always" for a handset that cannot take
       a single fix — and the office would stop looking for the real cause. */
    assert.equal(permissionAnswer('denied', 'granted'), 'denied');
    assert.equal(permissionAnswer('denied', 'denied'), 'denied');
  });

  test('separates all-the-time from while-using', () => {
    assert.equal(permissionAnswer('granted', 'granted'), 'always');
    assert.equal(permissionAnswer('granted', 'denied'), 'while_using');
    assert.equal(permissionAnswer('granted', 'undetermined'), 'while_using');
  });

  test('says undetermined only where nothing has been asked', () => {
    assert.equal(permissionAnswer('undetermined', 'undetermined'), 'undetermined');
    assert.equal(permissionAnswer('undetermined', 'denied'), 'undetermined');
  });
});

describe('connection is what it was on, never a claim about being off', () => {
  test('folds the types the office stores', () => {
    assert.equal(connectionAnswer('wifi', true), 'wifi');
    assert.equal(connectionAnswer('cellular', true), 'cellular');
  });

  test('anything else is unknown rather than guessed', () => {
    assert.equal(connectionAnswer('bluetooth', true), 'unknown');
    assert.equal(connectionAnswer(null, null), 'unknown');
    assert.equal(connectionAnswer(undefined, undefined), 'unknown');
  });

  test('keeps a reading taken while the radio was down', () => {
    /* It can be taken offline and sent later out of a queue. */
    assert.equal(connectionAnswer('none', false), 'none');
    assert.equal(connectionAnswer('wifi', false), 'none');
  });
});

describe('a battery level is a fraction until it is a percentage', () => {
  test('converts and rounds', () => {
    assert.equal(batteryPercent(0.436), 44);
    assert.equal(batteryPercent(1), 100);
  });

  test('keeps a genuine zero', () => {
    assert.equal(batteryPercent(0), 0);
  });

  test('refuses the -1 the platform returns when it will not say', () => {
    /* Passed through, it renders as a confident "-100%". */
    assert.equal(batteryPercent(-1), null);
    assert.equal(batteryPercent(1.5), null);
    assert.equal(batteryPercent(Number.NaN), null);
    assert.equal(batteryPercent(null), null);
    assert.equal(batteryPercent(undefined), null);
  });
});
