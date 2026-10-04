import NetInfo from '@react-native-community/netinfo';
import { checkLeftShopFromLastKnown } from './left-shop';
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
  autoRetryStuck,
  anythingDue,
  whenQueued,
} from './queue';
import { applyPull } from './pull';
import { flush as flushTrail } from './trail';
import { runMediaQueue } from './media';
import { isoDate } from '../lib/format';
import { buildLabel } from '../native/updates';
import { needsRebootstrap } from '../engines/rebootstrap';
import { BOOTSTRAPPED_BUILD_KEY, markBootstrapped, refreshSessionUser } from '../data/session';

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

  /* Asked on every tick, with or without signal — the reminder is local and
     the reading is the OS's own last one. Not awaited: a sync is not held up
     by a question about where he is. */
  void checkLeftShopFromLastKnown();

  if (running) return { ...empty, reason: 'Already sending. Please wait.' };
  if (!(await isOnline())) return { ...empty, reason: 'No signal. Everything waits to send.' };

  running = true;
  try {
    await recoverInterrupted();
    /* Refused and exhausted records go back in the queue on their own, every
       few hours — see `autoRetryStuck`. Never allowed to stop the sync. */
    await autoRetryStuck().catch(() => 0);

    const items = await readyItems();
    let accepted = 0;
    let rejected = 0;
    let failed = 0;

    if (items.length) {
      await markSyncing(items.map((i) => i.id));
    }

    /* BEFORE the cursor is read: a snapshot replaces it, and the delta below
       then picks up from the snapshot rather than from the old build's
       cursor. Inside the lock, so no delta can land between the two and
       write an older cursor over the newer one. */
    await refreshBookIfBuildChanged();

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
        await markRejected(item, result.code ?? 'validation', result.message ?? 'The office did not accept this.');
        await onRejection(item, result.code ?? 'validation', result.message ?? '');
        rejected += 1;
      } else {
        await markFailure(item, result.message ?? 'The office could not take this yet. It will try again.');
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

const REBOOTSTRAP_FAILED_KEY = 'mbos.rebootstrapFailedAt';

/**
 * AN UPGRADE TAKES THE WHOLE BOOK AGAIN, without anybody signing in.
 *
 * Installing a new APK over the old one keeps the session, so the snapshot a
 * sign-in applies never runs — and a delta only carries what changed, so a
 * new build's new configuration keys, columns and channels never arrived
 * until somebody happened to sign out and back in. `engines/rebootstrap.ts`
 * has the whole of when; this is the doing of it, with the token the phone
 * already holds.
 *
 * It is the same `applyPull` sign-in uses, so it obeys the same rule: it
 * overwrites reference data and never touches owned data, and nothing in the
 * outbox is lost to it. A failure is not the sync's failure — the delta goes
 * ahead on the old cursor exactly as it would have, and the snapshot is
 * asked for again after a pause.
 */
async function refreshBookIfBuildChanged(): Promise<void> {
  const current = buildLabel();
  const failed = Number(await getKv(REBOOTSTRAP_FAILED_KEY)) || null;
  if (!needsRebootstrap({ bootstrappedBuild: await getKv(BOOTSTRAPPED_BUILD_KEY), currentBuild: current, lastFailedAt: failed, now: Date.now() })) {
    return;
  }
  try {
    const snapshot = (await api.bootstrap()) as api.PullPayload & { user?: api.SessionUser };
    await applyPull(snapshot);
    await markBootstrapped(snapshot.cursor);
    await refreshSessionUser(snapshot.user);
    await setKv(REBOOTSTRAP_FAILED_KEY, '');
    await setKv('lastPullAt', String(Date.now()));
  } catch {
    await setKv(REBOOTSTRAP_FAILED_KEY, String(Date.now()));
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

  /*
   * A pick the office refused has to give the day back.
   *
   * `pickShops` moves the day to `planned` on this handset the moment the
   * shops are chosen, so the screen reflects the decision rather than the
   * network. Where the office then refuses it — the day was un-agreed, or it
   * has moved on since — nothing lifted that, and the day sat `planned` with
   * no stops behind it: absent from the "shops to pick" prompt, absent from
   * today's route, and unreachable from either. Back to `agreed` puts the
   * prompt back, and the refusal is on the day itself as well as in the bell.
   */
  if (item.entityType === 'plan_stops') {
    await run(
      `UPDATE journey_days SET dayState = 'agreed', picked = 0 WHERE id = ? AND dayState = 'planned'`,
      [item.entityId],
    );
  }

  if (item.entityType === 'order' && payload.customerId) {
    const { createTask } = await import('../data/tasks');
    await createTask({
      title: `Call ${payload.customerName ?? 'the customer'}. The order was not accepted`,
      description: `${message} (${code})`,
      customerId: payload.customerId,
      priority: 'High',
      dueDate: isoDate(new Date()),
    });
  }
}

/* ------------------------------------------------------------- the ticker */

let timer: ReturnType<typeof setInterval> | null = null;
let pushTimer: ReturnType<typeof setInterval> | null = null;
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * HOW OFTEN THE OUTBOX IS LOOKED AT, while the app is open: every three
 * seconds. What a salesman saves should reach the office in seconds, not on
 * the next minute's tick — an order taken at a counter is one the office may
 * be asked about before he has left the shop.
 *
 * It costs almost nothing when there is nothing to send: one local count, and
 * no request at all. Something failing does not make it hammer either — a
 * failed item carries its own backoff in `nextAttemptAt`, and the count only
 * sees what is DUE. The minute's tick below still runs for everything else
 * the sync does, pulling the office's changes above all.
 */
const PUSH_EVERY_MS = 3_000;

/** Send whatever is due now. Quiet if a sync is already running or nothing is ready. */
async function pushIfWaiting(): Promise<void> {
  if (running) return;
  if (!(await anythingDue())) return;
  /* The count can include an item still waiting on a dependency that is not
     due yet; asking the real rule before going to the network keeps that
     case from sending an empty request every three seconds. */
  if (!(await readyItems(Date.now(), 1)).length) return;
  await syncNow();
}

/**
 * Start syncing in the background: on an interval, and immediately whenever
 * connectivity comes back. The second one is what matters — a salesman walking
 * out of a godown into signal should not have to know to press anything.
 */
export function startBackgroundSync(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => void syncNow(), intervalMs);
  pushTimer = setInterval(() => void pushIfWaiting(), PUSH_EVERY_MS);
  /* A save sends within half a second. Debounced, because one action often
     writes two items — a record and its approval — and they should go up in
     one request. */
  whenQueued(() => {
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      void pushIfWaiting();
    }, 500);
  });

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
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = null;
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = null;
  whenQueued(null);
}
