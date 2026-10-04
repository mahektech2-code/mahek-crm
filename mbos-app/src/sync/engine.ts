import NetInfo from '@react-native-community/netinfo';
import { checkLeftShopFromLastKnown } from './left-shop';
import { getKv, run, setKv } from '../db';
import * as api from './api';
import {
  markFailure,
  markRejected,
  markSynced,
  markSyncing,
  markUnsent,
  readyItems,
  recoverInterrupted,
  pruneSynced,
  batchLimit,
  type QueueItem,
  autoRetryStuck,
  anythingDue,
  whenQueued,
} from './queue';
import { applyPull, missingCustomerIds } from './pull';
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
  if (!(await signedIn())) return { ...empty, reason: 'Nobody is signed in.' };
  if (!(await isOnline())) return { ...empty, reason: 'No signal. Everything waits to send.' };

  running = true;
  try {
    return await onePass(empty, opts);
  } catch (e) {
    /*
     * A PASS THAT THROWS SAYS SO. Nothing caught here before, so a pull that
     * would not apply rejected `syncNow`, the Sync screen's "Send now" showed
     * no toast at all, and the background tick failed in silence every minute
     * — the phone simply stopped updating with nothing anywhere saying why.
     */
    const why = e instanceof Error && e.message ? e.message : 'Something went wrong on this phone';
    return { ...empty, ran: true, reason: `Your book did not refresh: ${why}` };
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

async function onePass(empty: SyncOutcome, _opts: { manual?: boolean }): Promise<SyncOutcome> {
  /* Media is NOT reset here — only on a cold start. See `recoverInterrupted`. */
  await recoverInterrupted(Date.now(), { media: false });
  /* Refused and exhausted records go back in the queue on their own, every
     few hours — see `autoRetryStuck`. Never allowed to stop the sync. */
  await autoRetryStuck().catch(() => 0);
  await pruneSynced().catch(() => undefined);

  const items = await readyItems(Date.now(), await batchLimit());
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

  /* Shops the office says are his and this phone was never sent — see
     `rememberMissing`. A variable rather than a literal so the extra field
     rides through `postSync`'s spread without that function's own type
     having to learn it; the server reads it as optional. */
  const body = { cursor, items: items.map(toWireItem), missingIds: await missingCustomerIds() };

  try {
    response = await api.postSync(body);
  } catch (e) {
    /*
     * NOBODY IS SIGNED IN ANY MORE, which is not the item's fault.
     *
     * A lapsed refresh, a released handset, a closed account: every item in
     * the batch used to burn an attempt on it, and after six the day's
     * orders were `failed` and everything behind them blocked — for a
     * reason none of them had anything to do with. They wait, uncounted,
     * and the pass stops; the banner that sends him back to sign in is
     * raised where the refusal is recognised.
     */
    if (authLost(e)) {
      const reason = e instanceof Error ? e.message : 'Sign in again to send this.';
      for (const item of items) await markUnsent(item, reason);
      return { ...empty, ran: true, pushed: 0, reason };
    }
    /* The whole request failed — the tower dropped, the server is down.
       Every item goes back to the queue with its backoff advanced; none of
       them is lost and none is assumed delivered. */
    const reason = e instanceof Error ? e.message : 'Could not reach MahekOne';
    for (const item of items) await markFailure(item, reason);
    return { ...empty, ran: true, pushed: items.length, failed: items.length, reason };
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  for (const result of response.results) {
    const item = byId.get(result.queueId);
    if (!item) continue;

    if (result.status === 'accepted' || result.status === 'conflict') {
      /* A CONFLICT IS AN ACCEPTANCE. The server applied the write and says
         somebody else had changed the record first; it used to fall to
         `markFailure`, fail six times and then be resent every three hours
         for ever, for a write that had landed on the first attempt. */
      await markSynced(item, result.serverReceivedAt ?? null);
      if (result.serverNumber) await stampServerNumber(item, result.serverNumber);
      accepted += 1;
    } else if (result.status === 'rejected' && isOwnDuplicate(item, result.code)) {
      /*
       * "ALREADY RECORDED" ABOUT OUR OWN ID MEANS IT LANDED.
       *
       * An order or a receipt is keyed on an id this phone minted, so the
       * office finding that id already written can only mean an earlier
       * send of this very record got there — a batch that outlived the
       * phone's patience, then resent. Read as a refusal it raised "Order
       * not accepted", a ring-back task and a blocked payment behind it, all
       * about an order the office had.
       */
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
}

/** Order and payment creates are keyed on our own id — see `syncNow`. */
export function isOwnDuplicate(item: Pick<QueueItem, 'entityType' | 'op'>, code: string | undefined): boolean {
  return code === 'duplicate' && item.op === 'create' && (item.entityType === 'order' || item.entityType === 'payment');
}

/*
 * THE TWO QUESTIONS ASKED OF THE SIGN-IN, asked defensively.
 *
 * `sessionOpen` and `isAuthLost` arrive with the sign-in work (data/session.ts
 * and sync/api.ts). Read by name so this file compiles whichever lands first:
 * absent, a session is assumed and nothing is treated as a lost sign-in, which
 * is exactly how this behaved before either existed.
 */
async function signedIn(): Promise<boolean> {
  try {
    const session = (await import('../data/session')) as { sessionOpen?: () => boolean | Promise<boolean> };
    return session.sessionOpen ? Boolean(await session.sessionOpen()) : true;
  } catch {
    return true;
  }
}

function authLost(e: unknown): boolean {
  const check = (api as unknown as { isAuthLost?: (e: unknown) => boolean }).isAuthLost;
  return check ? check(e) : false;
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
 * What a refusal costs the salesman: one bell, ONCE.
 *
 * It used to raise a bell AND a local "Call the customer" task on every
 * refusal — and `autoRetryStuck` resends refused records every three hours, so
 * an order that was still wrong added a new High task and a new bell to his
 * list every three hours the app was open. Each local task was also queued up
 * to the office as a task of its own. The office already raises the ring-back
 * task for a refused order itself, once, so the phone's copy was a second task
 * about one refusal from the very first time. It is gone; the bell is raised
 * the first time a record is refused for a reason, and not again for the same
 * one.
 */
async function onRejection(item: QueueItem, code: string, message: string): Promise<void> {
  const key = `rejectionNotified:${item.id}`;
  const told = await getKv(key);
  if (told !== code) {
    await setKv(key, code);
    const { notify } = await import('../data/notifications');
    const payload = safeParse(item.payload) as { customerName?: string } | undefined;
    const who = payload?.customerName ? ` · ${payload.customerName}` : '';
    await notify({
      title: item.entityType === 'order' ? 'Order not accepted' : 'Not accepted by the office',
      body: message + who,
      kind: 'danger',
      href: '/rejections',
      priority: 1,
    });
  }

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
    /* The listener outlives a sign-out — it is attached once per process — so
       `syncNow` asks whether anybody is signed in before it does anything. */
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
