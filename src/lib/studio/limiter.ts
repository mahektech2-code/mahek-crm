// A small concurrency limiter. Rendering is CPU and memory work (Phase 0 measured about 111 MB for
// one render and about 190 MB sustained), so only a few renders run at once; the rest wait in order.
export type Limiter = {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
};

export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new Error("concurrency must be a whole number of at least 1");
  let active = 0;
  const queue: (() => void)[] = [];

  const release = () => {
    active--;
    queue.shift()?.();
  };

  return {
    async run(task) {
      if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
      active++;
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}
