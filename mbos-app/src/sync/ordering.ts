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
 * THE DEPENDENCIES THAT HAVE LANDED although no synced row says so.
 *
 * A dependency with NO row waiting anywhere in the outbox has landed: its
 * create went up and has since been pruned (`pruneSynced`), or it is a record
 * the office made. Without this, pruning sent rows would leave anything
 * depending on a fortnight-old record waiting for ever.
 *
 * And an item is never held behind ITSELF. The day's picks (`plan_stops`)
 * share their id with the day they depend on, so "is a row with that id still
 * waiting" was always yes — the picks' own row — and once the day's create had
 * been pruned they waited for ever. A row of the same KIND under that id (an
 * earlier set of picks for the same day) is not what it waits on either; only
 * a different kind of record under the id is.
 */
export function landedDependencies(
  queued: { entityId: string; entityType: string; dependsOn: string[] }[],
  inFlight: { entityId: string; entityType: string }[],
  deadIds: Set<string>,
): Set<string> {
  const kindsWaiting = new Map<string, string[]>();
  for (const r of [...queued, ...inFlight]) {
    kindsWaiting.set(r.entityId, [...(kindsWaiting.get(r.entityId) ?? []), r.entityType]);
  }
  const landed = new Set<string>();
  for (const q of queued) {
    for (const d of q.dependsOn) {
      const kinds = kindsWaiting.get(d) ?? [];
      const others = q.entityId === d ? kinds.filter((k) => k !== q.entityType) : kinds;
      if (!others.length && !deadIds.has(d)) landed.add(d);
    }
  }
  return landed;
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
