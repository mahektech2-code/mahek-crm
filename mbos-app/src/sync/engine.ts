import NetInfo from '@react-native-community/netinfo';
import { getKv, run, setKv } from '../db';
import * as api from './api';
import {
  markFailure,
  markRejected,
  markSynced,
  markSyncing,
  readyItems,
  recoverInterrupted,
  type QueueItem,
} from './queue';
import { applyPull } from './pull';
import { flush as flushTrail } from './trail';
import { runMediaQueue } from './media';
import { isoDate } from '../lib/format';

/**
 * The sync loop.
 *
 * It is a background reconciliation between two stores that are both allowed
 * to be right, not a request the UI is waiting on. Nothing here is ever
 * awaited by a screen.
 *
 * One pass does both directions in one round trip. A salesman who gets thirty
 * seconds of signal walking between two shops should spend it pushing his work
 * AND refreshing his book, not on a push that leaves the outstanding figures
 * four hours stale.
 */

export type SyncOutcome = {
  ran: boolean;
  pushed: number;
  accepted: number;
  rejected: number;
  failed: number;
  pulled: number;
  reason?: string;
};

let running = false;
let listenerAttached = false;

export async function isOnline(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return !!state.isConnected && state.isInternetReachable !== false;
}

/**
 * Run one pass. Safe to call at any time from anywhere; overlapping calls
 * return immediately rather than racing each other through the same items.
 */
export async function syncNow(opts: { manual?: boolean } = {}): Promise<SyncOutcome> {
  const empty: SyncOutcome = { ran: false, pushed: 0, accepted: 0, rejected: 0, failed: 0, pulled: 0 };

  if (running) return { ...empty, reason: 'A sync is already running' };
  if (!(await isOnline())) return { ...empty, reason: 'No signal — everything stays queued' };

  running = true;
  try {
    await recoverInterrupted();

    const items = await readyItems();
    let accepted = 0;
    let rejected = 0;
    let failed = 0;

    if (items.length) {
      await markSyncing(items.map((i) => i.id));
    }

    const cursor = (await getKv('pullCursor')) ?? '';
    let response: api.SyncResponse;

    try {
      response = await api.postSync({
        cursor,
        items: items.map(toWireItem),
      });
    } catch (e) {
      /* The whole request failed — the tower dropped, the token expired, the
         server is down. Every item goes back to the queue with its backoff
         advanced; none of them is lost and none is assumed delivered. */
      const reason = e instanceof Error ? e.message : 'Could not reach MahekOne';
      for (const item of items) await markFailure(item, reason);
      return { ...empty, ran: true, pushed: items.length, failed: items.length, reason };
    }

    const byId = new Map(items.map((i) => [i.id, i]));
    for (const result of response.results) {
      const item = byId.get(result.queueId);
      if (!item) continue;

      if (result.status === 'accepted') {
        await markSynced(item, result.serverReceivedAt ?? null);
        if (result.serverNumber) await stampServerNumber(item, result.serverNumber);
        accepted += 1;
      } else if (result.status === 'rejected') {
        await markRejected(item, result.code ?? 'validation', result.message ?? 'The office refused this record.');
        await onRejection(item, result.code ?? 'validation', result.message ?? '');
        rejected += 1;
      } else {
        await markFailure(item, result.message ?? 'The office could not accept this yet.');
        failed += 1;
      }
    }

    let pulled = 0;
    if (response.pull) {
      pulled = await applyPull(response.pull);
      if (response.pull.cursor) await setKv('pullCursor', response.pull.cursor);
      await setKv('lastPullAt', String(Date.now()));
    }

    return { ran: true, pushed: items.length, accepted, rejected, failed, pulled };
  } finally {
    running = false;
    /* Media goes after records, always. The parent has to exist on the server
       before its photograph has anything to attach to. */
    void runMediaQueue();
    /* And the trail last of all. It depends on nothing and nothing depends on
       it, so it takes whatever signal is left after the work has gone up. */
    void flushTrail();
  }
}

function toWireItem(item: QueueItem): api.WireItem {
  return {
    queueId: item.id,
    entityType: item.entityType,
    entityId: item.entityId,
    op: item.op as 'create' | 'update',
    idempotencyKey: item.idempotencyKey,
    clientCreatedAt: item.createdAt,
    dependsOn: JSON.parse(item.dependsOn),
    payload: JSON.parse(item.payload),
    location: item.location ? safeParse(item.location) : undefined,
  };
}

/** A location that will not parse is one activity without a place, not a sync
 *  that fails — the record is what matters and it is already written. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** An order number or receipt number the server assigned on first acceptance. */
async function stampServerNumber(item: QueueItem, serverNumber: string): Promise<void> {
  if (item.entityType === 'order') {
    await run('UPDATE orders SET orderNumber = ? WHERE id = ?', [serverNumber, item.entityId]);
  } else if (item.entityType === 'payment') {
    await run('UPDATE payments SET receiptNumber = ? WHERE id = ?', [serverNumber, item.entityId]);
  }
}

/**
 * What a refusal costs the salesman, and what he is owed in return.
 *
 * A notification alone is not enough for an order: he stood in the shop and
 * told the customer it was placed. So a rejected order also raises a task
 * against that customer — a bell can be missed, a task on the list cannot.
 */
async function onRejection(item: QueueItem, code: string, message: string): Promise<void> {
  const { notify } = await import('../data/notifications');
  const payload = JSON.parse(item.payload) as { customerId?: string; customerName?: string };
  const who = payload.customerName ? ` · ${payload.customerName}` : '';

  await notify({
    title: item.entityType === 'order' ? 'Order not accepted' : 'Not accepted by the office',
    body: message + who,
    kind: 'danger',
    href: '/rejections',
    priority: 1,
  });

  if (item.entityType === 'order' && payload.customerId) {
    const { createTask } = await import('../data/tasks');
    await createTask({
      title: `Ring ${payload.customerName ?? 'the customer'} — the order was not accepted`,
      description: `${message} (${code})`,
      customerId: payload.customerId,
      priority: 'High',
      dueDate: isoDate(new Date()),
    });
  }
}

/* ------------------------------------------------------------- the ticker */

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start syncing in the background: on an interval, and immediately whenever
 * connectivity comes back. The second one is what matters — a salesman walking
 * out of a godown into signal should not have to know to press anything.
 */
export function startBackgroundSync(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => void syncNow(), intervalMs);

  if (!listenerAttached) {
    listenerAttached = true;
    NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) void syncNow();
    });
  }
  void syncNow();
}

export function stopBackgroundSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
