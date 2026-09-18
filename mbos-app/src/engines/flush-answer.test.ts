import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideFlush } from './flush-answer';

/**
 * The queue drain, pinned.
 *
 * Two production data-loss bugs have been in this loop — a batch that could
 * only be partly filed was answered as delivered and the handset deleted rows
 * the office never stored, and before that the drain sent one batch per tick
 * and could never catch up. Neither was catchable by anything, because the loop
 * lives in a file that imports expo-location at module scope. So the decision
 * is here and the doing is there.
 */

const SENT = ['a', 'b', 'c', 'd'];

test('a clean delivery deletes exactly what was sent and goes round again', () => {
  const d = decideFlush({ ok: true, stored: 4, dropped: 0 }, SENT);
  assert.deepEqual(d.remove.sort(), SENT);
  assert.equal(d.carryOn, true);
  assert.equal(d.sent, 4);
  assert.equal(d.effect, 'none');
});

test('a word this build has never heard of still means delivered', () => {
  /* The property that lets the server ship a fifth word before any handset can
     be updated. An APK cannot be recalled, and a phone that refused to drain on
     an unfamiliar word would wedge its own queue until somebody sideloaded a
     new build. */
  const d = decideFlush({ ok: true, stored: 4, tracking: 'something-new' }, SENT);
  assert.deepEqual(d.remove.sort(), SENT);
  assert.equal(d.carryOn, true);
});

test('partial with holes keeps what the server did not name', () => {
  const d = decideFlush(
    { ok: true, stored: 2, dropped: 2, tracking: 'partial', filed: ['a', 'c'] },
    SENT,
  );
  assert.deepEqual(d.remove.sort(), ['a', 'c']);
  assert.equal(d.sent, 2);
  /* THE HEAD-OF-LINE HALF. `b` and `d` stay, and the queue behind them is not
     held hostage to them — answering `no-session-yet` for a mixed batch would
     have blocked everything for `queueRetentionDays`. */
  assert.equal(d.carryOn, true);
  assert.equal(d.effect, 'none');
});

test('partial naming an id that was never sent deletes nothing extra', () => {
  /* The only way `filed` could otherwise reach a fix this call never offered —
     a stale id from an earlier batch, a duplicate, a server bug. */
  const d = decideFlush(
    { ok: true, stored: 1, tracking: 'partial', filed: ['a', 'zzz', 'a'] },
    SENT,
  );
  assert.deepEqual(d.remove, ['a']);
  assert.equal(d.sent, 1);
});

test('partial naming nothing deletes nothing and does not spin', () => {
  /* Carrying on here re-reads the identical oldest five hundred and posts them
     again, up to MAX_PASSES times, for the same answer — fifty round trips on
     2G paid by the handset already having the worst day. The rows are kept
     either way and the next flush tries again, so progress is what licenses
     another pass. */
  const d = decideFlush({ ok: true, stored: 0, tracking: 'partial', filed: [] }, SENT);
  assert.deepEqual(d.remove, []);
  assert.equal(d.sent, 0);
  assert.equal(d.carryOn, false);
});

test('a filed that is not a list keeps everything', () => {
  /* Failure falls towards keeping a row. It came off a wire. */
  for (const filed of [undefined, null, 'a,b', 42, { a: 1 }]) {
    const d = decideFlush({ ok: true, stored: 0, tracking: 'partial', filed }, SENT);
    assert.deepEqual(d.remove, [], `${String(filed)} must not delete anything`);
    assert.equal(d.carryOn, false);
  }
});

test('non-string ids inside filed are ignored rather than coerced', () => {
  const d = decideFlush(
    { ok: true, stored: 1, tracking: 'partial', filed: ['a', 1, null, undefined] },
    SENT,
  );
  assert.deepEqual(d.remove, ['a']);
});

test('the office switching it off drops everything and stops', () => {
  const d = decideFlush({ ok: true, stored: 0, tracking: 'off' }, SENT);
  assert.equal(d.effect, 'stop-tracking');
  assert.equal(d.carryOn, false);
  assert.deepEqual(d.remove, [], 'the whole table goes, which is not a list of ids');
});

test('no session yet keeps the batch, ages the ancient out, and stops', () => {
  const d = decideFlush({ ok: true, stored: 0, tracking: 'no-session-yet' }, SENT);
  assert.equal(d.effect, 'age-out');
  assert.deepEqual(d.remove, []);
  assert.equal(d.carryOn, false);
  assert.equal(d.sent, 0);
});

test('a refusal or a torn connection deletes nothing', () => {
  for (const answer of [null, { ok: false }, { ok: false, tracking: 'partial', filed: SENT }]) {
    const d = decideFlush(answer, SENT);
    assert.deepEqual(d.remove, [], 'a failed call must never be a reason to let go of a fix');
    assert.equal(d.carryOn, false);
  }
});

test('an empty batch is harmless in every branch', () => {
  assert.deepEqual(decideFlush({ ok: true, stored: 0 }, []).remove, []);
  assert.equal(decideFlush({ ok: true, stored: 0 }, []).carryOn, true);
  assert.deepEqual(
    decideFlush({ ok: true, stored: 0, tracking: 'partial', filed: ['a'] }, []).remove,
    [],
  );
});
