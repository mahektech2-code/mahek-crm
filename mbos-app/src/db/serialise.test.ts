import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerialiser } from './serialise';

/**
 * The bug this file exists for, reproduced without a device.
 *
 * A fake connection that throws exactly as SQLite does when a transaction is
 * opened inside another, or rolled back when none is open. If the serialiser
 * stops working, these fail here rather than on somebody's phone.
 */
function fakeDb() {
  let open = false;
  const log: string[] = [];

  return {
    log,
    async wrap(body: () => Promise<void>) {
      if (open) throw new Error('cannot start a transaction within a transaction');
      open = true;
      log.push('begin');
      try {
        await body();
        log.push('commit');
      } catch (e) {
        if (!open) throw new Error('cannot rollback - no transaction is active');
        log.push('rollback');
        throw e;
      } finally {
        open = false;
      }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('two transactions started at once do not overlap', async () => {
  const db = fakeDb();
  const s = createSerialiser();

  /* Signing in: the pull and the background sync, both in flight. */
  await Promise.all([
    s.run(async () => { await tick(); }, db.wrap),
    s.run(async () => { await tick(); }, db.wrap),
  ]);

  assert.deepEqual(db.log, ['begin', 'commit', 'begin', 'commit']);
});

test('an unrelated write arriving mid-transaction waits instead of joining it', async () => {
  /* The pull's long transaction, and a save that lands while it is open. The
     save used to run INSIDE the pull's transaction, so a pull that rolled back
     took a save the screen had already called saved with it. */
  const db = fakeDb();
  const s = createSerialiser();
  const order: string[] = [];

  const pull = s.run(async () => {
    order.push('pull:start');
    await tick();
    await tick();
    order.push('pull:end');
    throw new Error('the pull failed');
  }, db.wrap);
  await tick();
  const save = s.run(async () => {
    order.push('save');
    return 'saved';
  }, db.wrap);

  await assert.rejects(pull, /the pull failed/);
  assert.equal(await save, 'saved');
  assert.deepEqual(order, ['pull:start', 'pull:end', 'save']);
  assert.deepEqual(db.log, ['begin', 'rollback', 'begin', 'commit'], 'the save had its own transaction');
});

test('the result of a transaction is not lost on the way out', async () => {
  const db = fakeDb();
  const s = createSerialiser();
  assert.equal(await s.run(async () => 'saved', db.wrap), 'saved');
});

test('a failed transaction rejects its own caller and nobody else', async () => {
  const db = fakeDb();
  const s = createSerialiser();

  const bad = s.run(async () => { throw new Error('constraint failed'); }, db.wrap);
  await assert.rejects(bad, /constraint failed/);

  /* The queue must not be poisoned — the next write still goes through. */
  assert.equal(await s.run(async () => 'still working', db.wrap), 'still working');
});

test('writes queued behind a failure all still run, in order', async () => {
  const db = fakeDb();
  const s = createSerialiser();
  const seen: string[] = [];

  const results = await Promise.allSettled([
    s.run(async () => { seen.push('a'); throw new Error('boom'); }, db.wrap),
    s.run(async () => { seen.push('b'); return 'b'; }, db.wrap),
    s.run(async () => { seen.push('c'); return 'c'; }, db.wrap),
  ]);

  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
});

test('the connection is never left open after a failure', async () => {
  const db = fakeDb();
  const s = createSerialiser();

  await assert.rejects(s.run(async () => { throw new Error('boom'); }, db.wrap));
  assert.equal(s.busy, false);

  /* If `busy` had stuck true, every later transaction would silently run
     OUTSIDE a transaction — the worst outcome, because it looks like it works. */
  await s.run(async () => { await tick(); }, db.wrap);
  assert.deepEqual(db.log, ['begin', 'rollback', 'begin', 'commit']);
});

test('a burst of writes serialises rather than racing', async () => {
  const db = fakeDb();
  const s = createSerialiser();

  await Promise.all(
    Array.from({ length: 8 }, (_, i) => s.run(async () => { await tick(); return i; }, db.wrap)),
  );

  assert.equal(db.log.filter((l) => l === 'begin').length, 8);
  assert.equal(db.log.filter((l) => l === 'commit').length, 8);
  /* Strictly alternating means none of them overlapped. */
  assert.deepEqual(db.log, Array.from({ length: 8 }).flatMap(() => ['begin', 'commit']));
});
