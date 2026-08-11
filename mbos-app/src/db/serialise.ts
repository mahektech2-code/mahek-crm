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
  /** True while a transaction is open. Callers use it to avoid nesting. */
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
      /* Already inside one: join it rather than opening a second. A nested
         transaction is almost always a helper that wants its caller's
         atomicity anyway, and committing early would break it. */
      if (busy) return fn();

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
