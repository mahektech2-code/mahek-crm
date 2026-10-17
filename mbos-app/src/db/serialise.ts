/**
 * The transaction serialiser, on its own so it can be tested.
 *
 * SQLite has one connection here and no nested transactions. Two async flows
 * that both open one produce a pair of errors that read as unrelated —
 * `cannot start a transaction within a transaction`, then `cannot rollback -
 * no transaction is active` as the loser unwinds — and the second one is the
 * misleading half: it looks like a rollback bug and is really the wreckage of
 * the first.
 *
 * Signing in triggers exactly that: the pull opens a transaction while the
 * background sync, started a moment earlier, opens its own.
 */

export type Serialiser = {
  /** Run `fn` with exclusive use of the connection, queued behind any others. */
  run<T>(fn: () => Promise<T>, wrap: (body: () => Promise<void>) => Promise<void>): Promise<T>;
  /** True while a transaction is open. Read by tests; nothing joins on it. */
  readonly busy: boolean;
};

export function createSerialiser(): Serialiser {
  let chain: Promise<unknown> = Promise.resolve();
  let busy = false;

  return {
    get busy() {
      return busy;
    },

    run<T>(fn: () => Promise<T>, wrap: (body: () => Promise<void>) => Promise<void>): Promise<T> {
      /*
       * NO JOINING. This used to say "already inside one: join it", and the
       * test for being inside one was a flag — `busy` — that is true while ANY
       * transaction is open, not while THIS caller's is. JavaScript has no way
       * to tell the two apart here. So an unrelated save that arrived during
       * the pull's long transaction (an order edit, a payment) ran its body
       * straight inside the pull's: if it threw half way, the half it had
       * written committed with the pull; if the pull rolled back, the save went
       * with it, on a screen that had already said "saved".
       *
       * Nothing in this app nests a transaction — every `tx()` call site was
       * checked when this changed — so the join was only ever reached by the
       * case that is wrong. Everything queues. A transaction that called
       * `tx()` from inside itself would now wait on itself; do not write one.
       */
      const task = chain.then(async () => {
        busy = true;
        try {
          let result!: T;
          await wrap(async () => {
            result = await fn();
          });
          return result;
        } finally {
          busy = false;
        }
      });

      /* The chain has to survive a failure, or one bad write stops every
         write that follows it for the life of the process. */
      chain = task.catch(() => undefined);
      return task;
    },
  };
}
