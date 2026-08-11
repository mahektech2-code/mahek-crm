/**
 * Which queue items may go out, and in what order.
 *
 * Pulled out of the queue module and made pure so it can be tested without a
 * database or a device. This is the single most consequential decision the
 * sync layer makes — the brief's Phase 0 gate is "a record can be created
 * offline, queued, synced, and survives an app restart mid-queue" — and a rule
 * this important should not only be exercised through an emulator.
 */

export type Eligible = {
  id: string;
  entityId: string;
  dependsOn: string[];
  nextAttemptAt: number;
  createdAt: number;
  state: string;
};

export type Verdict<T> = {
  /** Ready to send, already in dependency order. */
  ready: T[];
  /** Waiting on something that has not landed yet. Not an error. */
  waiting: T[];
  /** Depending on something that will never land. These must be blocked. */
  blocked: T[];
};

/**
 * Partition the queue.
 *
 * Three things decide it: the backoff gate, whether every dependency is
 * already `synced`, and whether any dependency is dead. That last one is what
 * stops a payment reaching the server for an order the server refused — it is
 * blocked, not sent and not quietly dropped.
 *
 * Items in the SAME batch can satisfy each other's dependencies, so a visit
 * and the order punched inside it both go out on one pass in the right order,
 * rather than the order waiting for the next tick.
 */
export function partition<T extends Eligible>(args: {
  queued: T[];
  syncedIds: Set<string>;
  deadIds: Set<string>;
  now: number;
  limit?: number;
}): Verdict<T> {
  const { queued, syncedIds, deadIds, now } = args;
  const limit = args.limit ?? 50;

  const ready: T[] = [];
  const waiting: T[] = [];
  const blocked: T[] = [];

  /* Oldest first within the constraint, so work leaves in roughly the order it
     was done — a salesman looking at the queue should recognise the sequence. */
  const ordered = [...queued].sort((a, b) => a.createdAt - b.createdAt);
  const satisfied = new Set(syncedIds);

  /* Repeat until nothing new becomes eligible. One pass is not enough: an item
     may be unblocked by another item earlier in the list that was itself only
     unblocked on this pass. */
  let progressed = true;
  const remaining = new Set(ordered.map((i) => i.id));

  while (progressed) {
    progressed = false;
    for (const item of ordered) {
      if (!remaining.has(item.id)) continue;

      if (item.dependsOn.some((d) => deadIds.has(d))) {
        blocked.push(item);
        remaining.delete(item.id);
        /* Anything depending on THIS is now dead too. */
        deadIds.add(item.entityId);
        progressed = true;
        continue;
      }

      if (item.nextAttemptAt > now) continue;

      if (item.dependsOn.every((d) => satisfied.has(d))) {
        if (ready.length >= limit) continue;
        ready.push(item);
        satisfied.add(item.entityId);
        remaining.delete(item.id);
        progressed = true;
      }
    }
  }

  for (const item of ordered) {
    if (remaining.has(item.id)) waiting.push(item);
  }

  return { ready, waiting, blocked };
}

/**
 * Backoff: six attempts across roughly forty minutes, then surfaced as failed.
 *
 * A queue that retries forever is a queue nobody ever looks at, and the record
 * sitting in it is one the office does not have.
 */
export const BACKOFF_MS = [2_000, 8_000, 30_000, 120_000, 600_000, 1_800_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length;

export function backoffFor(attempts: number, now: number, jitter = Math.random()): number {
  const base = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
  /* Jittered so a hundred handsets regaining signal off one tower do not all
     retry on the same millisecond and knock the server over. */
  return now + base + Math.floor(jitter * base * 0.25);
}

/** Every id that transitively depends on `entityId`. Used to block a subtree. */
export function dependents<T extends Eligible>(items: T[], entityId: string): T[] {
  const out: T[] = [];
  const dead = new Set([entityId]);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const item of items) {
      if (out.includes(item)) continue;
      if (item.dependsOn.some((d) => dead.has(d))) {
        out.push(item);
        dead.add(item.entityId);
        progressed = true;
      }
    }
  }
  return out;
}
