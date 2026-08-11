import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Opening the database exactly once, however many callers ask at once.
 *
 * The bug this pins: checking only the RESOLVED handle lets every caller that
 * arrives before the first `await` settles start its own open. Home fires nine
 * queries in one `Promise.all` on mount, the status strip polls two more, boot
 * adds another — fourteen connections all running the migration together, and
 * Android answers with fourteen `NativeDatabase.prepareAsync` NullPointer
 * rejections.
 *
 * The logic is reproduced here rather than imported because `db/index.ts`
 * imports expo-sqlite, which cannot load under `tsx --test`. Any change to the
 * memoisation has to be made in both.
 */

type Handle = { id: number };

function makeOpener(opts: { failFirst?: boolean } = {}) {
  let db: Handle | null = null;
  let opening: Promise<Handle> | null = null;
  let opens = 0;
  let migrations = 0;
  let attempt = 0;

  async function openDatabaseAsync(): Promise<Handle> {
    opens += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { id: opens };
  }

  async function migrate(): Promise<void> {
    migrations += 1;
    await new Promise((r) => setTimeout(r, 5));
  }

  function openDb(): Promise<Handle> {
    if (db) return Promise.resolve(db);

    if (!opening) {
      opening = (async () => {
        attempt += 1;
        if (opts.failFirst && attempt === 1) throw new Error('disk full');
        const handle = await openDatabaseAsync();
        await migrate();
        db = handle;
        return handle;
      })().catch((e) => {
        opening = null;
        throw e;
      });
    }

    return opening;
  }

  return {
    openDb,
    counts: () => ({ opens, migrations }),
    reset: () => {
      db = null;
      opening = null;
    },
  };
}

test('fourteen callers at once open ONE connection and run ONE migration', async () => {
  const o = makeOpener();

  /* Exactly the shape of a cold Home: a Promise.all of queries, plus the
     polled counts, plus boot — all before the first open has settled. */
  const handles = await Promise.all(Array.from({ length: 14 }, () => o.openDb()));

  assert.deepEqual(o.counts(), { opens: 1, migrations: 1 });
  /* And they all got the SAME connection, not one each. */
  assert.equal(new Set(handles.map((h) => h.id)).size, 1);
});

test('the naive version is what produced fourteen connections', async () => {
  /* Kept as the counter-example, so the fix is not mistaken for decoration. */
  let db: Handle | null = null;
  let opens = 0;

  async function naive(): Promise<Handle> {
    if (db) return db;
    opens += 1;
    await new Promise((r) => setTimeout(r, 5));
    db = { id: opens };
    return db;
  }

  await Promise.all(Array.from({ length: 14 }, () => naive()));
  assert.equal(opens, 14, 'this is the bug the memoised promise fixes');
});

test('callers arriving after it is open reuse it without reopening', async () => {
  const o = makeOpener();
  await o.openDb();
  await o.openDb();
  await o.openDb();
  assert.deepEqual(o.counts(), { opens: 1, migrations: 1 });
});

test('a failed open does not poison every later attempt', async () => {
  const o = makeOpener({ failFirst: true });

  await assert.rejects(o.openDb(), /disk full/);

  /* Without clearing the memo, this would reject forever and the app would
     never open its database again until it was force-quit. */
  const handle = await o.openDb();
  assert.ok(handle);
  assert.deepEqual(o.counts(), { opens: 1, migrations: 1 });
});

test('every caller of a failed open sees the failure, not a hang', async () => {
  const o = makeOpener({ failFirst: true });
  const results = await Promise.allSettled([o.openDb(), o.openDb(), o.openDb()]);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 3);
});

test('signing out lets the next sign-in open a fresh connection', async () => {
  const o = makeOpener();
  await o.openDb();
  o.reset();
  await o.openDb();
  assert.deepEqual(o.counts(), { opens: 2, migrations: 2 });
});
