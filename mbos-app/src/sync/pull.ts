import { all, getKv, one, run, setKv, tx } from '../db';
import { deviceId, type PullPayload, type TerritoryState } from './api';
import { isoDate } from '../lib/format';
import { CONVERTED_LEAD } from '../data/lead-query';

/** Where `storeTerritory` files it, and where `territoryState` reads it back. */
export const TERRITORY_KEY = 'territory';

/**
 * Applying what came down.
 *
 * The rule that governs this whole file: a pull overwrites REFERENCE data and
 * never touches OWNED data. The server is authoritative about what a customer
 * owes; it is not authoritative about the visit this salesman saved four
 * minutes ago and has not sent yet. Confusing the two is how an offline app
 * eats somebody's morning.
 *
 * Every reference row is stamped with `lastSyncedAt`, because the screens that
 * decide on a cached figure — credit limit and outstanding above all — have to
 * be able to say how old it is.
 */

export async function applyPull(pull: PullPayload): Promise<number> {
  const now = Date.now();
  let touched = 0;
  problems.length = 0;

  /*
   * ONE ROW THAT WILL NOT APPLY MUST NOT FREEZE THE BOOK.
   *
   * This was one transaction with nothing caught inside it, so a single row
   * this build could not hold — an office task with no due date against a
   * column that demands one was the live example — threw, rolled back every
   * table in the pull, and left the cursor where it was. The next pass asked
   * for the same rows, got the same row, and threw again: every sync on that
   * phone failed for ever, and a fresh sign-in failed at the "payload" step,
   * so the person could not get in at all.
   *
   * Each channel runs under `channel()`, and every row inside the generic
   * `upsert` and the hand-rolled loops under `eachRow()`, so a bad row costs
   * that row and is written down — `pullProblems`, which the Sync screen
   * reads — rather than costing everything. SQLite fails the one statement
   * and leaves the transaction standing, which is what makes catching inside
   * it safe.
   *
   * It also removes the other half of the damage: anything else written on
   * this connection while the pull's transaction was open used to roll back
   * with it, on a screen that had already said "saved". A pull that cannot
   * throw cannot take a save with it.
   */
  await tx(async () => {
    const c = async (name: string, fn: () => Promise<number>) => {
      touched += await channel(name, fn);
    };
    await c('customers', () => upsertCustomers(pull.customers, now));
    await c('products', () => upsertProducts(pull.products, now));
    await c('priceList', () => upsertPriceList(pull.priceList));
    await c('schemes', () => upsertSchemes(pull.schemes));
    await c('timeline', () => upsertTimeline(pull.timeline));
    await c('customerOrders', () => upsertCustomerOrders(pull.customerOrders, now));
    await c('customerPayments', () => upsertCustomerPayments(pull.customerPayments, now, pull.statementFrom));
    await c('customerBills', () => upsertCustomerBills(pull.customerBills, now, pull.statementFrom));
    await c('journeyStops', () => upsertStops(pull.journeyStops, now));
    await c('planDays', () => upsertPlanDays(pull.planDays, now));
    await c('config', () => upsertConfig(pull.config, now));
    await c('territory', () => storeTerritory(pull.territory));
    await c('notifications', () => upsertNotifications(pull.notifications));
    await c('leaveBalances', () => upsertLeaveBalances(pull.leaveBalances, now));
    await c('holidays', () => upsertHolidays(pull.holidays, now));
    await c('documents', () => upsertDocuments(pull.documents, now));
    await c('courses', () => upsertCourses(pull.courses, now));
    await c('performance', () => upsertPerformance(pull.performance, now));
    await c('customerTargets', () => replaceCustomerTargets(pull.customerTargets, now));
    await c('tasks', () => upsertTasks(pull.tasks, now));
    await c('leads', () => upsertLeads(pull.leads, now));
    /* AFTER the leads, so the record can never draw a check or a call against
       a lead this pull was about to introduce. Same reason the tombstones run
       where they do. */
    await c('leadValidations', () => upsertLeadValidations(pull.leadValidations));
    await c('leadFieldChecks', () => upsertLeadFieldChecks(pull.leadFieldChecks));
    await c('samples', () => upsertSamples(pull.samples, now));
    await c('salary', () => upsertSalary(pull.salary, now));
    await c('travelModes', () => upsertTravelModes(pull.travelModes, now));
    await c('expensePolicy', () => replaceExpensePolicy(pull.expensePolicy, now));
    /* His own history, for a phone that has none — a reinstall, a new handset.
       BEFORE the approvals, so an approval arriving in the same pull finds the
       request it decides. Insert-only: see `fillOwnHistory`. */
    await c('ownHistory', () => fillOwnHistory(pull as FullPull));
    await c('approvals', () => applyApprovals(pull.approvals));
    /* AFTER the history fill and the approvals: it is the office's current
       word on every expense and allowance in the window, so it lands last and
       corrects anything the two above wrote from an older reading. */
    await c('expenseBook', () => applyExpenseBook(pull.expenseBook));
    /* AFTER the approvals: an order's own row is the office's word on it, and
       a manager approval nobody can decide must not read it back to pending. */
    await c('myOrders', () => applyMyOrders(pull.myOrders));
    await c('orderChanges', () => applyOrderChanges(pull.orderChanges));
    await c('territoryRequests', () => applyTerritoryRequests(pull.territoryRequests));
    await c('attendanceToday', () => restoreAttendance(pull.attendanceToday));
    await c('deletions', () => applyDeletions(pull.deletions));
    /* AFTER the customer and lead upserts, so a mark set in the office today
       is seen, and BEFORE the book reconcile, which keeps any shop that still
       has a lead row. */
    await c('convertedLeads', () => releaseConvertedLeads());
    /* AFTER the tombstones and after the customer upsert, because it is the
       backstop for everything neither of them covered. */
    await c('book', () => reconcileBook(pull.bookIds));
    await c('customerOrdersPrune', () => pruneCustomerOrders());
  });

  /* Outside the transaction, because confirming a transcript deletes the audio
     file from the filesystem — which is not a thing a database transaction can
     roll back, and not a thing to hold one open across. */
  touched += await channel('transcripts', () => applyTranscripts(pull.transcripts));

  await recordProblems();
  return touched;
}

/* ------------------------------------------------------ what would not land */

type Problem = { channel: string; id: string | null; message: string };

/** Filled by one `applyPull` and written out at its end. */
const problems: Problem[] = [];

/** The kv key the Sync screen reads. */
export const PULL_PROBLEMS_KEY = 'pullProblems';

export type PullProblems = { at: number; count: number; samples: Problem[] };

function noteProblem(channel: string, id: string | null, e: unknown): void {
  problems.push({
    channel,
    id,
    message: e instanceof Error ? e.message : String(e),
  });
}

/**
 * Run one channel and never let it throw. What failed is noted, and the rest
 * of the pull carries on — see the header of `applyPull`.
 */
async function channel(name: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    noteProblem(name, null, e);
    return 0;
  }
}

/**
 * Apply each row by itself, so one bad row costs that row. The `channel`
 * name is what the Sync screen says the row was.
 */
async function eachRow<T>(name: string, rows: T[], fn: (row: T) => Promise<void>): Promise<number> {
  let n = 0;
  for (const row of rows) {
    try {
      await fn(row);
      n += 1;
    } catch (e) {
      const id = (row as { id?: unknown })?.id;
      noteProblem(name, typeof id === 'string' ? id : null, e);
    }
  }
  return n;
}

/**
 * Written once per pull, and CLEARED by a clean one — a problem that has gone
 * away must stop being reported, or the screen teaches him to ignore it.
 * Twenty samples is enough to name the fault; the count is the whole of it.
 */
async function recordProblems(): Promise<void> {
  try {
    if (!problems.length) {
      await run('DELETE FROM kv WHERE key = ?', [PULL_PROBLEMS_KEY]);
      return;
    }
    const value: PullProblems = { at: Date.now(), count: problems.length, samples: problems.slice(0, 20) };
    await setKv(PULL_PROBLEMS_KEY, JSON.stringify(value));
  } catch {
    /* The record of a problem must not become a problem. */
  }
}

/** What the last pull could not save, for the Sync screen. Null when clean. */
export async function pullProblems(): Promise<PullProblems | null> {
  const raw = await getKv(PULL_PROBLEMS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PullProblems;
  } catch {
    return null;
  }
}

/**
 * The words the office wrote out, coming home.
 *
 * This is the other end of the rule in `sync/media.ts`: a recording is kept
 * until its transcription is confirmed STORED, not merely until the upload
 * succeeded. Until this channel existed the confirmation never arrived, so
 * every voice note ever recorded stayed on the handset — correctly, and
 * forever.
 */
async function applyTranscripts(
  rows: { mediaId: string; transcript: string }[] | undefined,
): Promise<number> {
  if (!rows?.length) return 0;
  const { confirmTranscription } = await import('./media');
  for (const row of rows) {
    if (row.mediaId && row.transcript) {
      await confirmTranscription(row.mediaId, row.transcript);
    }
  }
  return rows.length;
}

/**
 * Today's attendance, for a handset that has none.
 *
 * THE ONE EXCEPTION TO THE RULE AT THE TOP OF THIS FILE, and it is written as
 * an exception rather than a relaxation: `INSERT OR IGNORE` against the unique
 * index on `(userId, day)`, so it can only ever fill a GAP. A row already here
 * — including a check-in saved four minutes ago in a market with no signal —
 * is never touched, which is the whole of what "a pull never overwrites owned
 * data" was protecting.
 *
 * It exists because a fresh install was blind. `checkIn()` asks `todayRow()`,
 * which is purely local, so a handset that has just been installed finds
 * nothing and concludes the day has not started — then files a SECOND check-in
 * for a day the server already holds, under a new id. The server merged it
 * onto the existing row and, having no `resumedAt` to go on, left the morning's
 * `check_out_at` in place: checked in on the phone, checked out on every
 * screen, and every position refused because the day the server could see was
 * closed. Silent on both ends. Losing the local database is simply what
 * installing a build does, so this met the first person to take one.
 *
 * The server-side upsert now also reopens a day on a check-in later than the
 * recorded check-out, which repairs it after the fact. This is the half that
 * stops it happening: with today's row present, `checkIn()` takes the resume
 * path it was always meant to take.
 *
 * Sent by bootstrap only. A delta pull omits it and this is a no-op.
 */
async function restoreAttendance(row: PullPayload['attendanceToday']): Promise<number> {
  if (!row?.id || !row.userId || !row.day) return 0;

  /* The server keeps two marks; the handset keeps a list of sessions. One
     session is the honest translation of one pair — still open where there is
     no check-out, closed where there is. */
  const sessions = row.checkInAt
    ? [{ inAt: row.checkInAt, outAt: row.checkOutAt ?? null }]
    : [];

  await run(
    `INSERT OR IGNORE INTO attendance_days
       (id, userId, day, checkInAt, checkInLat, checkInLng, checkInAccuracyM,
        checkOutAt, status, sessions, clientCreatedAt, deviceId, syncState)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'synced')`,
    [
      row.id,
      row.userId,
      row.day,
      row.checkInAt,
      row.checkInLat,
      row.checkInLng,
      row.checkInAccuracyM,
      row.checkOutAt,
      row.status,
      JSON.stringify(sessions),
      row.checkInAt ?? Date.now(),
      await deviceId(),
    ],
  );
  return 1;
}

/* ------------------------------------------------------------- primitives */

type Row = Record<string, unknown>;

/**
 * What this table can actually hold, asked of SQLite rather than assumed.
 *
 * Cached for the life of the process: a migration runs once, on open, before
 * any of this — so the answer cannot change underneath a sync.
 */
const columnsOf = new Map<string, Set<string>>();

async function knownColumns(table: string): Promise<Set<string>> {
  const cached = columnsOf.get(table);
  if (cached) return cached;
  const info = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  const cols = new Set(info.map((c) => c.name));
  columnsOf.set(table, cols);
  return cols;
}

/**
 * Upsert by primary key, writing the columns the server sent THAT THIS
 * HANDSET HAS SOMEWHERE TO PUT.
 *
 * The filter is the whole point, and it was missing. SQLite refuses a column
 * it does not have, so one field the server knew about and this build did not
 * threw — and because `applyPull` is a single transaction, that throw rolled
 * back every table in the pull, not just the one. `signIn` then caught it,
 * found it was not an `ApiError`, and signed the salesman in through the
 * offline path with an empty database and nothing on the screen.
 *
 * An APK cannot be recalled, so the server has to be able to move first. A
 * column this build does not know about is one it cannot use anyway; dropping
 * it costs a field the screens never read, and refusing it costs the book.
 *
 * `guard` is what lets an OWNED table come through here rather than being
 * hand-rolled. `leads` and `samples` both carry `WHERE ${noPending(...)}` on
 * their conflict clause — a queued row is one this handset has said something
 * about and the office has not heard yet, so the local answer is the newer fact
 * and it stands until it is sent — and both pay for it by typing their column
 * lists out, which is exactly the shape that silently NULLed every completed
 * task's note. A guard clause costs one string and keeps the column filter,
 * which is the half that cannot be got wrong by hand.
 */
async function upsert(
  table: string,
  key: string,
  rows: unknown[] | undefined,
  extra: Row = {},
  guard?: string,
): Promise<number> {
  if (!rows?.length) return 0;
  const known = await knownColumns(table);
  await eachRow(table, rows, async (raw) => {
    const row = { ...(raw as Row), ...extra };
    const cols = Object.keys(row).filter((c) => known.has(c));
    if (!cols.includes(key)) return;
    const marks = cols.map(() => '?').join(',');
    const sets = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ');
    await run(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${marks})
       ON CONFLICT(${key}) DO UPDATE SET ${sets}${guard ? ` WHERE ${guard}` : ''}`,
      cols.map((c) => normalise(row[c])),
    );
  });
  return rows.length;
}

/** SQLite takes no booleans, no objects and no undefined. */
function normalise(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number') return v;
  return String(v);
}

/**
 * NOTHING OF HIS IS STILL ON ITS WAY for this record — the guard every table
 * with an office end writes under.
 *
 * It was `syncState = 'synced'`, and that is a different question. A record
 * whose UPDATE the office refused carries `rejected` on its own row for ever,
 * so the office's next word on it — the approval of the very order he had
 * tried to edit, a lead the manager moved on — never landed, and the phone
 * went on showing a record the office had long since changed. What the guard
 * exists to protect is an edit the office has NOT HEARD YET; a refused one it
 * has heard and answered, and its answer is the newer fact. So the question is
 * asked of the outbox directly: anything queued, in flight, exhausted or
 * blocked is still his to send, and only then does the local row stand.
 */
export const PENDING_STATES = "('queued','syncing','failed','blocked')";

function noPending(table: string): string {
  return `NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.entityId = ${table}.id AND q.state IN ${PENDING_STATES})`;
}

/* ---------------------------------------------------------------- tables */

function upsertCustomers(rows: unknown[] | undefined, now: number) {
  return upsert('customers', 'id', rows, { lastSyncedAt: now });
}

function upsertProducts(rows: unknown[] | undefined, now: number) {
  return upsert('products', 'id', rows, { lastSyncedAt: now });
}

async function upsertPriceList(rows: unknown[] | undefined) {
  if (!rows?.length) return 0;
  /* The price list is small and replaced wholesale — a rate that was withdrawn
     has to disappear, and a per-row upsert would leave it behind. */
  await run('DELETE FROM price_list');
  for (const raw of rows) {
    const r = raw as { priceTag: string; productId: string; ratePaise: number };
    await run('INSERT INTO price_list (priceTag, productId, ratePaise) VALUES (?, ?, ?)', [r.priceTag, r.productId, r.ratePaise]);
  }
  return rows.length;
}

/**
 * The bills, UPSERTED AND THEN PRUNED BY DATE — and that is a reversal.
 *
 * It replaced the table wholesale, on the price list's rule and for the price
 * list's reason: the server sent the CURRENT OPEN set every pass, so a bill
 * that had been settled had to disappear, and a per-row upsert would have left
 * it behind for the payment picker to go on offering.
 *
 * The channel is not that any more. It carries every bill inside a window now,
 * settled ones included, because the customer record grew a statement — and
 * inside a window the server can send only what CHANGED, which is the whole
 * point: the last thirteen months is thousands of rows and re-sending a
 * salesman's share of them every few minutes all day is not a thing to do to a
 * phone on 2G. A delta and a wholesale delete cannot both be true, and the
 * delete is the half that has to go: it would throw away every bill the
 * current pass did not happen to mention, which is nearly all of them.
 *
 * WHAT REPLACES IT IS A DATE. A bill leaves this handset by ageing out of the
 * window, and `statementFrom` is the same boundary the server built the
 * payload from, so the phone prunes exactly what the office stopped sending.
 * Nothing else removes a bill, which is what makes that sufficient: a bill is
 * never deleted in the office either.
 *
 * The picker is unaffected by the widening — `openBills` filters on the
 * balance, so a settled bill arriving here is not a settled bill being
 * offered.
 */
async function upsertCustomerBills(
  rows: unknown[] | undefined,
  now: number,
  from: string | undefined,
) {
  const n = rows?.length ? await upsert('customer_bills', 'id', rows, { lastSyncedAt: now }) : 0;
  /* Only where the server said what the window is. An older server sends no
     boundary, and pruning against a guess would empty the table. */
  if (from) await run('DELETE FROM customer_bills WHERE billDate IS NOT NULL AND billDate < ?', [from]);
  return n;
}

function upsertSchemes(rows: unknown[] | undefined) {
  return upsert('schemes', 'id', rows);
}

function upsertTimeline(rows: unknown[] | undefined) {
  return upsert('timeline_events', 'id', rows);
}

/* The office's history, read-only here. Its own tables rather than `orders`
   and `payments`, which are the salesman's own and feed his outbox. */
function upsertCustomerOrders(rows: unknown[] | undefined, now: number) {
  return upsert('customer_orders', 'id', rows, { lastSyncedAt: now });
}

async function upsertCustomerPayments(
  rows: unknown[] | undefined,
  now: number,
  from: string | undefined,
) {
  const n = rows?.length ? await upsert('customer_payments', 'id', rows, { lastSyncedAt: now }) : 0;
  /* Pruned on the same boundary as the bills, and it has to be the same one:
     they are the two halves of one running balance, and a statement whose
     receipts reach further back than its bills opens on a credit that pays
     for an invoice not on the screen. */
  if (from) await run('DELETE FROM customer_payments WHERE receivedAt IS NOT NULL AND receivedAt < ?', [from]);
  return n;
}

function upsertStops(rows: unknown[] | undefined, now: number) {
  return upsert('journey_stops', 'id', rows, { lastSyncedAt: now });
}

/**
 * The days, and where each has got to.
 *
 * `syncState: 'synced'` is set alongside, because a pull is the office's word
 * arriving — it overwrites whatever this handset thought, including an answer
 * that has since been superseded. An answer still waiting in the outbox is not
 * lost by this: the outbox is what will resend it.
 */
function upsertPlanDays(rows: unknown[] | undefined, now: number) {
  return upsert('journey_days', 'id', rows, { lastSyncedAt: now, syncState: 'synced' });
}

function upsertNotifications(rows: unknown[] | undefined) {
  return upsert('notifications', 'id', rows);
}

function upsertLeaveBalances(rows: unknown[] | undefined, now: number) {
  return upsert('leave_balances', 'kind', rows, { lastSyncedAt: now });
}

function upsertHolidays(rows: unknown[] | undefined, now: number) {
  return upsert('holidays', 'id', rows, { lastSyncedAt: now });
}

/*
 * Keyed on the PERIOD, so a rebuilt month replaces itself rather than stacking.
 * The office recomputes this hourly and the same period comes down again and
 * again; an id-keyed upsert would leave one row per rebuild and the screen
 * would pick whichever it read first.
 */
function upsertPerformance(rows: unknown[] | undefined, now: number) {
  return upsert('performance', 'period', rows, { lastSyncedAt: now });
}

/**
 * His customers' targets, REPLACED rather than upserted.
 *
 * A shop that left his book, or a month that rolled off the two the office
 * sends, has no row left to say so — the price list's problem exactly. So the
 * whole table goes and comes back. ABSENT is the opposite answer: an older
 * server, or the cursorless reply, says nothing about targets and must leave
 * what is here alone. An empty list is the office saying he has none.
 */
async function replaceCustomerTargets(rows: unknown[] | undefined, now: number) {
  if (!rows) return 0;
  await run('DELETE FROM customer_targets');
  const keyed = rows.map((raw) => {
    const r = raw as { period: string; customerId: string };
    return { ...r, key: `${r.period}|${r.customerId}` };
  });
  return upsert('customer_targets', 'key', keyed, { lastSyncedAt: now });
}

function upsertSalary(rows: unknown[] | undefined, now: number) {
  return upsert('salary', 'period', rows, { lastSyncedAt: now });
}

function upsertDocuments(rows: unknown[] | undefined, now: number) {
  return upsert('documents', 'id', rows, { lastSyncedAt: now });
}

function upsertCourses(rows: unknown[] | undefined, now: number) {
  return upsert('courses', 'id', rows, { lastSyncedAt: now });
}

/**
 * §8 — THE OFFICE'S OWN CALL TO THE SHOP, landing in the table this phone
 * already writes.
 *
 * The same row either way: `handleLeadValidation` keeps the id the handset
 * minted, so a call made here comes back as itself. A second, office-only
 * table would have held a copy of every one of them and the record would have
 * drawn each call twice, which is worse than not drawing the office's at all.
 *
 * GUARDED, like `leads` and `samples`: a call still in the outbox is one the
 * office has not heard yet, so nothing arriving may write over it. `syncState`
 * is stamped rather than sent, because what it records is how this ROW got
 * here and that is not a fact the server holds.
 */
function upsertLeadValidations(rows: unknown[] | undefined) {
  return upsert(
    'lead_validations',
    'id',
    rows,
    { syncState: 'synced' },
    noPending('lead_validations'),
  );
}

/**
 * §5.2 — WHO CHECKED A FINDING, AND WHAT CAME OF IT.
 *
 * Reference, wholly. A salesman's own Confirm/Correct/Unable-to-verify answers
 * go up inside the lead save as `fieldChecks` and come back here as rows, so
 * there is never a local answer for a pull to lose and no guard to keep.
 *
 * Append-only at the office, which is what makes a plain upsert right: a row
 * that never changes cannot be written back wrongly, and the conflict clause
 * is there only so a row arriving twice costs nothing.
 */
function upsertLeadFieldChecks(rows: unknown[] | undefined) {
  return upsert('lead_field_checks', 'id', rows);
}

/**
 * WHY THE BOOK IS THE SIZE IT IS — kept so a screen can tell an empty book
 * apart from a switched-off one.
 *
 * In `kv` rather than `config`: `config` mirrors the thresholds the Admin
 * Console holds and is the same for everybody on the team, and this is a fact
 * about ONE salesman that changes when the office moves him. Filing it there
 * would make the next person reading a config key wonder why it is personal.
 *
 * Replaced wholesale on every pass, because an area taken away has to
 * disappear and there is only ever one answer. Absent leaves what was there:
 * an older server sends nothing, and forgetting a real allocation on a pull
 * from one would make the handset accuse the office of not having set it.
 */
/**
 * What the office last said about where he works.
 *
 * Null means it has never been told — an older server, or a handset that has
 * not completed a pull since this shipped. The screens read that as "we do not
 * know" and draw the ordinary empty state, because telling a salesman his area
 * is unset when nobody has actually said so sends him to the office for
 * nothing.
 */
export async function territoryState(): Promise<TerritoryState | null> {
  const raw = await getKv(TERRITORY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TerritoryState;
    return typeof parsed?.allocated === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

async function storeTerritory(
  territory: PullPayload['territory'],
): Promise<number> {
  if (!territory) return 0;
  await setKv(TERRITORY_KEY, JSON.stringify(territory));
  return 1;
}

async function upsertConfig(config: Record<string, unknown> | undefined, now: number): Promise<number> {
  if (!config) return 0;
  for (const [key, value] of Object.entries(config)) {
    await run(
      'INSERT INTO config (key, value, lastSyncedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, lastSyncedAt = excluded.lastSyncedAt',
      [key, JSON.stringify(value), now],
    );
  }
  return Object.keys(config).length;
}

/**
 * A task the office raised or reassigned, coming down.
 *
 * The columns are not the same word on both ends — see `lib/wire.ts`'s own
 * account of why a mapping like this has to be a function and not a payload
 * literal. `assignedToUserId`/`assignedByUserId` become `assigneeId`/
 * `assignerId`; `snoozedTo`/`snoozeReason` fold into the one JSON history
 * column this table already keeps; `escalatedAt` becomes the boolean this
 * table already has. `in_progress` is not a bucket this app's screens draw,
 * so it reads as `open` rather than a status nothing knows how to show.
 *
 * `clientCreatedAt: 0` / `deviceId: 'server'` mark a row that never touched a
 * device — the same convention `applyApprovals` below already uses. Like
 * every other channel in this file, a pull overwrites what is here: an
 * outbox write still in flight for this same task is not lost, because the
 * outbox is what resends it and wins the next round trip.
 */
/**
 * A lead and a sample the OFFICE holds, coming home.
 *
 * These are the only two tables written from both ends. They are OWNED — the
 * salesman raises them in the field — and they also have an office end, which
 * is why a plain reference upsert is wrong for both: it would overwrite an
 * edit sitting in the outbox with the older row the server still believes.
 * `noPending` on the conflict clause is what keeps that from happening. A queued row
 * is one this handset has said something about and the office has not heard
 * yet, so the local answer is the newer fact and it stands until it is sent.
 *
 * The words differ too, and not only in case — PROTOCOL.md §4.1 and
 * `lib/wire.ts`. `companyName` is `company`, a lower-case `won` is
 * `Converted`, one note field is a list, and a sample's `state` is not on the
 * wire at all because MahekOne tracks the two timestamps behind it instead.
 * That is exactly why neither of these can go through the generic upsert: it
 * writes the keys it is given, and none of these five is the same word twice.
 *
 * NEITHER READS A FUNNEL COLUMN, deliberately. The lead row now carries a
 * sales type, a rung, the eight prospect answers and a qualification object,
 * and `openLeads` sends none of them yet — so reading them here would be
 * exactly the `upsertTasks` bug again, one release later: an undefined field
 * becomes NULL and the `ON CONFLICT` clause writes it over the answers a
 * salesman typed standing in the shop. They are added to the list below ONLY
 * in the same change that adds them to the server's query.
 */
async function upsertLeads(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localNotes, legacyStageFor, localSalesType } = await import('../lib/wire');
  await eachRow('leads', rows, async (raw) => {
    const l = raw as {
      id: string;
      name: string;
      companyName?: string | null;
      mobile?: string | null;
      city?: string | null;
      /* The locality inside the city. Sent since leads existed and
         dropped until this table had a column for it. */
      area?: string | null;
      /* WHERE THE SHOP IS, in words. The column has been here since the
         capture sheet shipped and `app/lead.tsx` has drawn it as "Where it
         is" all along; `openLeads` simply never selected it, so an address
         corrected at a desk reached this phone on no pass, ever, and roughly
         half this book has no pin to navigate from instead. */
      address?: string | null;
      source?: string | null;
      stage?: string;
      estimatedPotentialPaise?: number | null;
      nextFollowUpDate?: string | null;
      notes?: string | null;
      convertedCustomerId?: string | null;
      lastActivityDate?: string | null;
      /*
       * THE FUNNEL, ARRIVING — and every one of these is now on the wire.
       *
       * The rule this obeys is the one `upsertTasks` broke: a field READ here
       * that the server does not send is `undefined`, and the `ON CONFLICT`
       * clause then writes that NULL over whatever the row held. That is how
       * every completed task lost its note and its photograph. So these are
       * added in the same change as `openLeads`, never ahead of it — and the
       * list below is the whole of what `openLeads` selects, no more.
       */
      salesType?: string | null;
      stageSince?: string | null;
      customerType?: string | null;
      /* `lead_monthly_volume_litres` under its wire name. The server holds one
         column for the fact and aliases it to this. */
      monthlyLitres?: number | null;
      competitor?: string | null;
      requiredProductId?: string | null;
      requiredProductName?: string | null;
      contactPerson?: string | null;
      decisionMaker?: string | null;
      creditDaysWanted?: number | null;
      application?: string | null;
      gstin?: string | null;
      /*
       * §11.6 — WHETHER ANYBODY CHECKED THE NUMBER, which is a different fact
       * from the number and is not this phone's to assert.
       *
       * The gate reads `gstin && gstVerified === true`, so while this was on
       * no wire and in no column here it was `undefined` on every handset and
       * a shop lead could never once reach Sample/Trial from the field — the
       * refusal naming the GST over a number that was already typed in and
       * already verified in the office. It arrives as a boolean off a NOT NULL
       * column, so a lead the office has looked at carries a real false rather
       * than an absence; SQLite holds it as 1/0 below.
       */
      gstVerified?: boolean | null;
      qualification?: unknown;
      nextAction?: string | null;
      nextActionDate?: string | null;
      nextActionOwnerId?: string | null;
      nextActionOutcome?: string | null;
      suspectDecidedAt?: string | null;
      verifiedAt?: string | null;
      thirdParty?: boolean | null;
      distributorSalesmanId?: string | null;
      distributorSalesmanName?: string | null;
      expectedOrderDate?: string | null;
      expectedOrderValuePaise?: number | null;
      /* §5.5 — the size of the promise and what is in the way. They lived in
         this app's `kv` store while the office had no column for either; both
         are now on the wire in both directions, so the one place they live is
         the row. */
      expectedOrderQuantityCans?: number | null;
      expectedOrderBlockerCode?: string | null;
      /* Sent since leads existed and dropped on the floor until the
         `a lead has a place` migration gave this table somewhere to put
         them — a lead map with no coordinates. */
      gpsLat?: number | null;
      gpsLng?: number | null;
      /* The coordinating seat, and the name beside it. Reference data: it does
         not move the lead out of this salesman's book. */
      leadManagerId?: string | null;
      leadManagerName?: string | null;
      /* Counted by the office over every visit, not just this phone's — see
         `visitsHere`, which adds what has not synced yet. */
      visitCount?: number | null;
      holdReason?: string | null;
      /*
       * THE FACTS THE GATES READ, and every one of them was missing.
       *
       * `engines/funnel/lead-gates.ts` is the server's file byte for byte, so
       * this app has known all twenty-three rungs since the funnel shipped —
       * and none of the facts they turn on. An absent field is `undefined`,
       * `undefined >= 1` is false, and every rung above Negotiation was shut
       * behind a sentence the salesman could not act on: "There is no order on
       * this account yet", on a shop that had ordered three times.
       *
       * They are read here in the SAME change that adds them to `openLeads`
       * and to the handset's schema, never ahead of either — a field read and
       * not sent is `undefined`, and the `ON CONFLICT` clause writes that NULL
       * over whatever the row held. That is how every completed task lost its
       * note and its photograph.
       */
      countingOrderCount?: number | null;
      deliveredOrderCount?: number | null;
      confirmedPaymentCount?: number | null;
      /* §23 — how many distributors invoice this shop, plus the usual one by
         name for the two columns this table has had all along and never
         filled. */
      distributorCount?: number | null;
      distributorCustomerId?: string | null;
      distributorName?: string | null;
      /* §11 — the thirty answers, keyed in the engine's own words. Held as
         text here and parsed by `distributorProfileOf`, exactly like
         `qualification` above. */
      distributorProfile?: unknown;
      /* §12 — the two steps, the terms and the agreement. Down only: nothing
         here writes one, and a phone that could would be appointing its own
         distributor. */
      managementReviewApproved?: boolean | null;
      distributorApprovalApproved?: boolean | null;
      commercialTermsAgreed?: boolean | null;
      agreementOnFile?: boolean | null;
      /* §5.3 — the DAY somebody last confirmed the four conversion figures,
         not a verdict about it. The threshold is configuration this phone
         already holds, so it answers against its own clock rather than
         against the moment of a pull it may not have had for a week. */
      figuresConfirmedAt?: string | null;
      qualificationReview?: string | null;
      /* §4.2 — who places the order where that is not who approves it. */
      buyer?: string | null;
      /* The office's own marks: worth, when a parked lead comes back, the
         CODE behind the hold sentence, and where the lead came from. */
      priority?: string | null;
      holdResumeDate?: string | null;
      holdReasonCode?: string | null;
      sourceDetail?: string | null;
      /* §7 — what `roleAction` forks on, and the seat it resolves a vantage
         from. A commitment is a day AND a size, decided on the server so this
         phone cannot hold a second opinion about one lead. */
      hasCommitment?: boolean | null;
      hasOrder?: boolean | null;
      backOfficeAmId?: string | null;
      /* The name beside the id, resolved by the office because this app holds
         no user table — exactly as `leadManagerName` is. */
      backOfficeAmName?: string | null;
      /* When the lead was actually RAISED, and not when this handset first saw
         it. `clientCreatedAt` below is bound to `now` and means the second;
         two facts, two columns. */
      createdAt?: string | null;
    };
    await run(
      `INSERT INTO leads (id, name, company, mobile, city, area, address, source, estimatedPotentialPaise,
                          assigneeId, stage, nextFollowUpDate, notes, convertedCustomerId,
                          archived, lastActivityDate, gpsLat, gpsLng,
                          leadManagerId, leadManagerName, visitCount, holdReason,
                          clientCreatedAt, serverCreatedAt, deviceId, syncState,
                          salesType, funnelStage, stageSince, customerType, monthlyLitres,
                          competitor, requiredProductId, requiredProductName, contactPerson,
                          decisionMaker, creditDaysWanted, application, gstin, gstVerified,
                          qualification,
                          nextAction, nextActionDate, nextActionOwnerId, nextActionOutcome,
                          suspectDecidedAt, verifiedAt, thirdParty, distributorSalesmanId,
                          distributorSalesmanName, expectedOrderDate, expectedOrderValuePaise,
                          expectedOrderQuantityCans, expectedOrderBlockerCode,
                          distributorCustomerId, distributorName, distributorProfile,
                          countingOrderCount, deliveredOrderCount, confirmedPaymentCount,
                          distributorCount, managementReviewApproved, distributorApprovalApproved,
                          commercialTermsAgreed, agreementOnFile, figuresConfirmedAt,
                          qualificationReview, buyer, priority, holdResumeDate,
                          holdReasonCode, sourceDetail, hasCommitment, hasOrder,
                          backOfficeAmId, backOfficeAmName, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', 'synced',
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, company = excluded.company, mobile = excluded.mobile,
         city = excluded.city, area = excluded.area, address = excluded.address,
         source = excluded.source,
         estimatedPotentialPaise = excluded.estimatedPotentialPaise,
         stage = excluded.stage, nextFollowUpDate = excluded.nextFollowUpDate,
         convertedCustomerId = excluded.convertedCustomerId,
         lastActivityDate = excluded.lastActivityDate,
         gpsLat = excluded.gpsLat, gpsLng = excluded.gpsLng,
         leadManagerId = excluded.leadManagerId,
         leadManagerName = excluded.leadManagerName,
         visitCount = excluded.visitCount,
         holdReason = excluded.holdReason,
         salesType = excluded.salesType, funnelStage = excluded.funnelStage,
         stageSince = excluded.stageSince, customerType = excluded.customerType,
         monthlyLitres = excluded.monthlyLitres, competitor = excluded.competitor,
         requiredProductId = excluded.requiredProductId,
         requiredProductName = excluded.requiredProductName,
         contactPerson = excluded.contactPerson, decisionMaker = excluded.decisionMaker,
         creditDaysWanted = excluded.creditDaysWanted, application = excluded.application,
         gstin = excluded.gstin, gstVerified = excluded.gstVerified,
         qualification = excluded.qualification,
         nextAction = excluded.nextAction, nextActionDate = excluded.nextActionDate,
         nextActionOwnerId = excluded.nextActionOwnerId,
         nextActionOutcome = excluded.nextActionOutcome,
         suspectDecidedAt = excluded.suspectDecidedAt, verifiedAt = excluded.verifiedAt,
         thirdParty = excluded.thirdParty,
         distributorSalesmanId = excluded.distributorSalesmanId,
         distributorSalesmanName = excluded.distributorSalesmanName,
         expectedOrderDate = excluded.expectedOrderDate,
         expectedOrderValuePaise = excluded.expectedOrderValuePaise,
         expectedOrderQuantityCans = excluded.expectedOrderQuantityCans,
         expectedOrderBlockerCode = excluded.expectedOrderBlockerCode,
         distributorCustomerId = excluded.distributorCustomerId,
         distributorName = excluded.distributorName,
         distributorProfile = excluded.distributorProfile,
         countingOrderCount = excluded.countingOrderCount,
         deliveredOrderCount = excluded.deliveredOrderCount,
         confirmedPaymentCount = excluded.confirmedPaymentCount,
         distributorCount = excluded.distributorCount,
         managementReviewApproved = excluded.managementReviewApproved,
         distributorApprovalApproved = excluded.distributorApprovalApproved,
         commercialTermsAgreed = excluded.commercialTermsAgreed,
         agreementOnFile = excluded.agreementOnFile,
         figuresConfirmedAt = excluded.figuresConfirmedAt,
         qualificationReview = excluded.qualificationReview,
         buyer = excluded.buyer, priority = excluded.priority,
         holdResumeDate = excluded.holdResumeDate,
         holdReasonCode = excluded.holdReasonCode,
         sourceDetail = excluded.sourceDetail,
         hasCommitment = excluded.hasCommitment, hasOrder = excluded.hasOrder,
         backOfficeAmId = excluded.backOfficeAmId,
         backOfficeAmName = excluded.backOfficeAmName,
         -- Kept on conflict as well as inserted. A lead is on this phone long
         -- before anybody asks how old it is, so a value written once and
         -- never restated is one that stays null on every row already here.
         createdAt = excluded.createdAt, syncState = 'synced'
       WHERE ${noPending('leads')}`,
      [
        l.id,
        l.name,
        l.companyName ?? null,
        l.mobile ?? null,
        l.city ?? null,
        l.area ?? null,
        l.address ?? null,
        l.source ?? null,
        l.estimatedPotentialPaise ?? null,
        /*
         * THE SEVENTEEN NEW RUNGS ALL READ AS `New` HERE, and this line is the
         * whole of why.
         *
         * `localStage` knows the six legacy rungs and nothing else, so every
         * funnel rung the office sent fell through its lookup to `New`. Two
         * things went wrong and only one of them looks like a label bug: the
         * filter chips filed a lead at `sample_review` under New, which is
         * merely wrong — and the visit cap read the same column, so a shop at
         * `first_order`, or one we have been selling to for a year, told the
         * salesman "Visit 2 of 3, a decision is due" and REFUSED TO CLOSE HIS
         * VISIT until he answered Prospect-or-not about a customer.
         *
         * `legacyStageFor` is the one place the two columns are kept in step —
         * its own header says so — and every other writer of this column
         * already calls it. The pull was the last one that did not, which is
         * exactly why it was invisible: a lead moved on the phone read
         * correctly and the same lead after a sync did not.
         *
         * It takes the sales type because "on the book" is answered five rungs
         * differently on the three ladders, and the type is on this same row.
         */
        legacyStageFor(l.stage, localSalesType(l.salesType)),
        l.nextFollowUpDate ?? null,
        /* Only on INSERT. The note list is APPENDED to locally and the wire
           carries one flattened string, so re-writing it on every pass would
           replace a salesman's own notes with the office's rendering of them. */
        localNotes(l.notes, now),
        l.convertedCustomerId ?? null,
        l.lastActivityDate ?? null,
        l.gpsLat ?? null,
        l.gpsLng ?? null,
        l.leadManagerId ?? null,
        l.leadManagerName ?? null,
        l.visitCount ?? 0,
        l.holdReason ?? null,
        now,
        now,
        l.salesType ?? null,
        /* The specification's rung, kept apart from `stage`. `stage` is what the
           filter chips select on and only ever holds one of the original six —
           writing `sample_review` into it makes a lead findable on no chip. */
        l.stage ?? null,
        l.stageSince ?? null,
        l.customerType ?? null,
        l.monthlyLitres ?? null,
        l.competitor ?? null,
        l.requiredProductId ?? null,
        l.requiredProductName ?? null,
        l.contactPerson ?? null,
        l.decisionMaker ?? null,
        l.creditDaysWanted ?? null,
        l.application ?? null,
        l.gstin ?? null,
        /* A boolean on the wire, an integer here — and null kept as null,
           because a server that has not sent it and an office that has said no
           are different facts and only the second may be drawn as one. */
        l.gstVerified == null ? null : l.gstVerified ? 1 : 0,
        /* jsonb arrives as an object and SQLite holds text. */
        l.qualification == null ? '{}' : JSON.stringify(l.qualification),
        l.nextAction ?? null,
        l.nextActionDate ?? null,
        l.nextActionOwnerId ?? null,
        l.nextActionOutcome ?? null,
        /* An ISO instant carries its own zone, so `Date.parse` is right here —
           it is a date-ONLY string that would be read as UTC and land five and a
           half hours early. */
        l.suspectDecidedAt ? Date.parse(l.suspectDecidedAt) : null,
        l.verifiedAt ? Date.parse(l.verifiedAt) : null,
        l.thirdParty ? 1 : 0,
        l.distributorSalesmanId ?? null,
        l.distributorSalesmanName ?? null,
        l.expectedOrderDate ?? null,
        l.expectedOrderValuePaise ?? null,
        /* NULL KEPT AS NULL on the blocker, and it is not the same fact as
           `no_blocker`. That code is somebody being asked and answering that
           nothing is stopping the order; null is nobody having been asked. A
           card that read the second as the first would assert a clear road on
           every commitment taken before the question existed. */
        l.expectedOrderQuantityCans ?? null,
        l.expectedOrderBlockerCode ?? null,
        l.distributorCustomerId ?? null,
        l.distributorName ?? null,
        /* jsonb arrives as an object and SQLite holds text — and the column is
           NOT NULL DEFAULT '{}', so a lead with no application on file gets the
           empty object the gate already reads as thirty unanswered questions
           rather than a null nothing would parse. */
        l.distributorProfile == null ? '{}' : JSON.stringify(l.distributorProfile),
        /* NULL KEPT AS NULL on all three counts. Zero is the office saying
           there is no order on this account; null is this phone not having
           heard, and only the first may be drawn as a fact. The gate reads
           both the same way, so the distinction costs it nothing. */
        l.countingOrderCount ?? null,
        l.deliveredOrderCount ?? null,
        l.confirmedPaymentCount ?? null,
        l.distributorCount ?? null,
        /* Booleans on the wire, integers here, and null preserved for the same
           reason it is on `gstVerified`: an approval nobody has recorded and
           one this handset has not been told about are different facts. */
        l.managementReviewApproved == null ? null : l.managementReviewApproved ? 1 : 0,
        l.distributorApprovalApproved == null ? null : l.distributorApprovalApproved ? 1 : 0,
        l.commercialTermsAgreed == null ? null : l.commercialTermsAgreed ? 1 : 0,
        l.agreementOnFile == null ? null : l.agreementOnFile ? 1 : 0,
        /* An ISO instant carries its own zone, so `Date.parse` is right — it is
           a date-ONLY string that would be read as UTC and land five and a half
           hours early. */
        l.figuresConfirmedAt ? Date.parse(l.figuresConfirmedAt) : null,
        l.qualificationReview ?? null,
        l.buyer ?? null,
        l.priority ?? null,
        l.holdResumeDate ?? null,
        l.holdReasonCode ?? null,
        l.sourceDetail ?? null,
        l.hasCommitment == null ? null : l.hasCommitment ? 1 : 0,
        l.hasOrder == null ? null : l.hasOrder ? 1 : 0,
        l.backOfficeAmId ?? null,
        l.backOfficeAmName ?? null,
        /* An ISO instant carries its own zone, so `Date.parse` is right — it is
           a date-ONLY string that would be read as UTC and land five and a half
           hours early. Null kept as null: a lead whose creation date has not
           arrived must read as unknown rather than as raised the moment this
           handset happened to pull it, which is the whole reason this column is
           not `clientCreatedAt`. */
        l.createdAt ? Date.parse(l.createdAt) : null,
      ],
    );
  });
  return rows.length;
}

async function upsertSamples(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localInstant, localSampleState } = await import('../lib/wire');
  await eachRow('samples', rows, async (raw) => {
    const s = raw as {
      id: string;
      customerId: string;
      productId?: string | null;
      productName?: string | null;
      quantityCans?: number | null;
      requestedDate?: string | null;
      deliveredAt?: string | null;
      deliveryPhotoId?: string | null;
      trialOutcome?: string | null;
      followUpDate?: string | null;
      feedbackNotes?: string | null;
      convertedOrderId?: string | null;
      /* THE OFFICE'S OWN WORD, which the wire did not carry until now.
         `localSampleState` prefers it and keeps its timestamp derivation as
         the fallback — that derivation can never produce the approved state,
         because approval leaves no timestamp behind it, so a sample already on
         a lorry read as one still waiting to be approved. */
      state?: string | null;
      /* The lifecycle, §I–§K. `receivedAt` is the shop's own word and is what
         the review call is dated from — never inferred from `deliveredAt`. */
      dispatchedAt?: string | null;
      courierName?: string | null;
      trackingNumber?: string | null;
      receivedAt?: string | null;
      trialStartedAt?: string | null;
      trialCompletedAt?: string | null;
      satisfaction?: string | null;
      additionalRequirement?: string | null;
      rejectionReason?: string | null;
      /* §16 — the chase, as the office counts it. It did not cross the wire
         until now, so `chaseCountOf` answered null on every handset and a
         screen could not say "asked three times". Optional here for the same
         reason it is nullable in the schema: a build of the SERVER that
         predates the columns sends neither, and reading a field nothing sends
         writes `undefined` — which the `ON CONFLICT` clause below would then
         put over whatever was there. That is `upsertTasks` erasing completion
         notes, and it is why the SELECT and this list have to land together. */
      reviewChaseCount?: number | null;
      lastReviewChaseAt?: string | number | null;
    };
    await run(
      `INSERT INTO samples (id, customerId, productId, productName, cans, reason,
                            requestedAt, state, deliveredAt, deliveryPhotoId, trialOutcome,
                            followUpDate, convertedOrderId,
                            dispatchedAt, courierName, trackingNumber, receivedAt,
                            trialStartedAt, trialCompletedAt, satisfaction,
                            additionalRequirement, rejectionReason,
                            reviewChaseCount, lastReviewChaseAt,
                            clientCreatedAt, serverCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET
         productId = excluded.productId, productName = excluded.productName,
         cans = excluded.cans, reason = excluded.reason, state = excluded.state,
         deliveredAt = excluded.deliveredAt, deliveryPhotoId = excluded.deliveryPhotoId,
         trialOutcome = excluded.trialOutcome, followUpDate = excluded.followUpDate,
         convertedOrderId = excluded.convertedOrderId,
         dispatchedAt = excluded.dispatchedAt, courierName = excluded.courierName,
         trackingNumber = excluded.trackingNumber, receivedAt = excluded.receivedAt,
         trialStartedAt = excluded.trialStartedAt,
         trialCompletedAt = excluded.trialCompletedAt,
         satisfaction = excluded.satisfaction,
         additionalRequirement = excluded.additionalRequirement,
         rejectionReason = excluded.rejectionReason,
         reviewChaseCount = excluded.reviewChaseCount,
         lastReviewChaseAt = excluded.lastReviewChaseAt, syncState = 'synced'
       WHERE ${noPending('samples')}`,
      [
        s.id,
        s.customerId,
        s.productId ?? null,
        s.productName ?? null,
        s.quantityCans ?? null,
        /* `feedbackNotes` is what this app sends its `reason` as — the round
           trip, not two different fields. See `requestSample`. */
        s.feedbackNotes ?? null,
        /* NOT NULL, and a sample with no requested date is still a sample:
           the day it arrived is a worse answer than the day it was raised and
           a better one than refusing the row. */
        localInstant(s.requestedDate) ?? now,
        localSampleState(s),
        localInstant(s.deliveredAt),
        s.deliveryPhotoId ?? null,
        s.trialOutcome ?? null,
        s.followUpDate ?? null,
        s.convertedOrderId ?? null,
        /* Instants off the wire. `localInstant` is already imported here for
           `deliveredAt` — a date-only string parses as UTC and lands five and a
           half hours before the day it names. */
        s.dispatchedAt ? localInstant(s.dispatchedAt) : null,
        s.courierName ?? null,
        s.trackingNumber ?? null,
        s.receivedAt ? localInstant(s.receivedAt) : null,
        s.trialStartedAt ? localInstant(s.trialStartedAt) : null,
        s.trialCompletedAt ? localInstant(s.trialCompletedAt) : null,
        s.satisfaction ?? null,
        s.additionalRequirement ?? null,
        s.rejectionReason ?? null,
        s.reviewChaseCount ?? null,
        s.lastReviewChaseAt ? localInstant(s.lastReviewChaseAt) : null,
        now,
        now,
      ],
    );
  });
  return rows.length;
}

async function upsertTasks(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localPriority } = await import('../lib/wire');
  await eachRow('tasks', rows, async (raw) => {
    const t = raw as {
      id: string;
      title: string;
      description?: string | null;
      assignedToUserId: string;
      assignedByUserId?: string | null;
      priority: string;
      /* NULLABLE AT THE OFFICE — `mbos_tasks.due_date` has no NOT NULL, and
         `tasksSince` orders it `nulls last` — while this table's column is
         `TEXT NOT NULL`. One undated office task threw inside the pull's
         transaction and froze every sync on the phone. */
      dueDate: string | null;
      customerId?: string | null;
      status: string;
      completionNote?: string | null;
      /* What KIND of work this is, so the list can open the right screen. */
      sourceType?: string | null;
      sourceId?: string | null;
      completionPhotoId?: string | null;
      snoozedTo?: string | null;
      snoozeReason?: string | null;
      escalatedAt?: string | null;
      /* The assignment's form and his answers to it — see `engines/task-form`. */
      campaignId?: string | null;
      form?: unknown;
      responses?: unknown;
      /* The customer record as the linked questions see it. */
      context?: unknown;
    };
    const status = t.status === 'in_progress' ? 'open' : t.status;
    const asJson = (v: unknown) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
    const snoozeHistory = t.snoozedTo
      ? JSON.stringify([{ at: now, to: t.snoozedTo, reason: t.snoozeReason ?? '' }])
      : null;
    await run(
      `INSERT INTO tasks (id, title, description, assigneeId, assignerId, priority, dueDate,
                          customerId, status, completionNote, completionPhotoId, snoozeHistory,
                          sourceType, sourceId, campaignId, form, responses, context,
                          escalated, clientCreatedAt, serverCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, description = excluded.description,
         priority = excluded.priority, dueDate = excluded.dueDate, customerId = excluded.customerId,
         status = excluded.status, completionNote = excluded.completionNote,
         completionPhotoId = excluded.completionPhotoId, escalated = excluded.escalated,
         sourceType = excluded.sourceType, sourceId = excluded.sourceId,
         campaignId = excluded.campaignId, form = excluded.form, responses = excluded.responses,
         context = excluded.context,
         syncState = 'synced'
       WHERE ${noPending('tasks')}`,
      [
        t.id,
        t.title,
        t.description ?? null,
        t.assignedToUserId,
        t.assignedByUserId ?? null,
        localPriority(t.priority),
        /* An undated task is something to do, so it lands on today's list
           rather than nowhere. */
        t.dueDate ?? isoDate(new Date()),
        t.customerId ?? null,
        status,
        t.completionNote ?? null,
        t.completionPhotoId ?? null,
        snoozeHistory,
        t.sourceType ?? null,
        t.sourceId ?? null,
        t.campaignId ?? null,
        asJson(t.form),
        asJson(t.responses),
        asJson(t.context),
        t.escalatedAt ? 1 : 0,
        now,
      ],
    );
  });
  return rows.length;
}

/**
 * An approval decision coming back down.
 *
 * The subject record's state is DERIVED from its approval and never set on its
 * own — so an order becomes approved because its approval says so, not because
 * something wrote a flag onto the order.
 */
/** The office's status for each of his field orders — see `myOrderStates`. */
const ORDER_STATUS: Record<string, string> = {
  captured: 'submitted',
  pending_approval: 'pending_approval',
  confirmed: 'approved',
  declined: 'rejected',
  cancelled: 'cancelled',
  dispatched: 'dispatched',
  in_transit: 'in_transit',
  delivered: 'delivered',
};

/**
 * HIS ORDERS, AS THE OFFICE NOW STANDS ON THEM.
 *
 * Status, the reason a declined one was declined, the number, and the LINES —
 * an edit before approval or a change accounts accepted after it rewrites them
 * at the office, and the phone has to show what the order now is. Only a row
 * the phone has nothing queued for is touched: a queued edit is the newer fact
 * until it is sent, the rule `leads` and `samples` already follow.
 */
async function applyMyOrders(rows: unknown[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  let n = 0;
  await eachRow('myOrders', rows, async (raw) => {
    const o = raw as {
      id: string; status: string; declineReason?: string | null; orderNo?: string | null;
      totalAmountPaise?: number | null;
      lineItems?: { product: string; productId?: string; quantity: number; unitPrice?: number; amount?: number }[] | null;
    };
    const status = ORDER_STATUS[o.status] ?? o.status;
    const local = await one<{ id: string }>('SELECT id FROM orders WHERE id = ?', [o.id]);
    if (!local) return;
    const pending = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sync_queue WHERE entityId = ? AND state IN ${PENDING_STATES}`,
      [o.id],
    );
    if ((pending?.n ?? 0) > 0) return;
    await run(
      `UPDATE orders SET status = ?, cancelReason = COALESCE(?, cancelReason),
              orderNumber = COALESCE(orderNumber, ?), netTotalPaise = COALESCE(?, netTotalPaise),
              syncState = 'synced'
        WHERE id = ?`,
      [status, o.declineReason ?? null, o.orderNo ?? null, o.totalAmountPaise ?? null, o.id],
    );
    if (Array.isArray(o.lineItems) && o.lineItems.length) {
      await run('DELETE FROM order_lines WHERE orderId = ?', [o.id]);
      for (const [i, l] of o.lineItems.entries()) {
        const p = l.productId
          ? await one<{ millilitresPerCan: number | null; cansPerBox: number | null }>(
              'SELECT millilitresPerCan, cansPerBox FROM products WHERE id = ?',
              [l.productId],
            )
          : null;
        await run(
          `INSERT INTO order_lines (id, orderId, productId, productName, cans, boxes, litres, ratePaise, lineTotalPaise)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `${o.id}:${i}`, o.id, l.productId ?? '', l.product, l.quantity,
            p?.cansPerBox ? Math.floor(l.quantity / p.cansPerBox) : 0,
            p?.millilitresPerCan ? (l.quantity * p.millilitresPerCan) / 1000 : null,
            l.unitPrice ?? null, l.amount ?? null,
          ],
        );
      }
    }
    n += 1;
  });
  return n;
}

/** The changes he asked for, as accounts answered them. */
async function applyOrderChanges(rows: unknown[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  await eachRow('orderChanges', rows, async (raw) => {
    const r = raw as {
      id: string; orderId: string; status: string; note?: string | null; decisionNote?: string | null;
      totalAmountPaise?: number | null; lineItems?: unknown; requestedAt?: number | null; decidedAt?: number | null;
    };
    await run(
      `INSERT INTO order_change_requests (id, orderId, status, note, decisionNote, totalAmountPaise, linesJson,
                                          requestedAt, decidedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, decisionNote = excluded.decisionNote,
         decidedAt = excluded.decidedAt, totalAmountPaise = excluded.totalAmountPaise, syncState = 'synced'
       WHERE ${noPending('order_change_requests')}`,
      [r.id, r.orderId, r.status, r.note ?? null, r.decisionNote ?? null, r.totalAmountPaise ?? null,
       r.lineItems ? JSON.stringify(r.lineItems) : null, r.requestedAt ?? null, r.decidedAt ?? null],
    );
  });
  return rows.length;
}

/**
 * What he said about his areas, as the office holds it. Written only where
 * nothing is pending for it (`noPending`): a row still in the outbox is newer than anything
 * the office can say about it.
 */
async function applyTerritoryRequests(rows: unknown[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  await eachRow('territoryRequests', rows, async (raw) => {
    const r = raw as {
      id: string; kind: string; currentPlaces?: unknown; requestedPlaces?: unknown;
      reason?: string | null; signature?: string | null; state?: string | null;
      decisionNote?: string | null; decidedAt?: number | null;
      clientCreatedAt?: number | null; serverCreatedAt?: number | null;
    };
    await run(
      `INSERT INTO territory_requests (id, kind, currentPlaces, requestedPlaces, reason, signature, state,
                                       decisionNote, decidedAt, clientCreatedAt, serverCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, decisionNote = excluded.decisionNote,
         decidedAt = excluded.decidedAt, serverCreatedAt = excluded.serverCreatedAt, syncState = 'synced'
       WHERE ${noPending('territory_requests')}`,
      [r.id, r.kind, JSON.stringify(r.currentPlaces ?? []), JSON.stringify(r.requestedPlaces ?? []),
       r.reason ?? null, r.signature ?? '', r.state ?? 'pending', r.decisionNote ?? null, r.decidedAt ?? null,
       r.clientCreatedAt ?? r.serverCreatedAt ?? 0, r.serverCreatedAt ?? null],
    );
  });
  return rows.length;
}

async function applyApprovals(rows: unknown[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  await eachRow('approvals', rows, async (raw) => {
    const a = raw as {
      id: string; subjectType: string; subjectId: string; state: string;
      decidedAt?: number; decisionNote?: string; approvedAmountPaise?: number; approverName?: string;
    };
    await run(
      `INSERT INTO approvals (id, type, subjectType, subjectId, state, decidedAt, decisionNote, approvedAmountPaise, approverName,
                              requestedAt, clientCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, decidedAt = excluded.decidedAt,
         decisionNote = excluded.decisionNote, approvedAmountPaise = excluded.approvedAmountPaise,
         approverName = excluded.approverName, syncState = 'synced'
       WHERE ${noPending('approvals')}`,
      [a.id, a.subjectType, a.subjectType, a.subjectId, a.state, a.decidedAt ?? null, a.decisionNote ?? null,
       a.approvedAmountPaise ?? null, a.approverName ?? null],
    );

    if (a.subjectType === 'order') {
      const status = a.state === 'approved' ? 'approved' : a.state === 'rejected' ? 'rejected' : 'pending_approval';
      await run('UPDATE orders SET status = ?, approvalId = ? WHERE id = ?', [status, a.id, a.subjectId]);
    } else if (a.subjectType === 'expense') {
      /* A PART approval is a yes for less, so it is Approved with the amount
         beside it. It used to fall through to Pending, so a claim his manager
         had already allowed ₹800 of sat on his phone as still waiting. And the
         manager's words travel with every decision: a refusal printed "your
         manager did not give a reason" over a reason sitting in this row. */
      const state =
        a.state === 'approved' || a.state === 'partially_approved'
          ? 'Approved'
          : a.state === 'rejected'
            ? 'Rejected'
            : 'Pending';
      await run(
        'UPDATE expenses SET state = ?, approvedAmountPaise = ?, rejectionReason = ?, decisionNote = ? WHERE id = ?',
        [
          state,
          a.state === 'partially_approved' ? a.approvedAmountPaise ?? null : null,
          a.state === 'rejected' ? a.decisionNote ?? null : null,
          a.decisionNote ?? null,
          a.subjectId,
        ],
      );
    } else if (a.subjectType === 'leave') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE leave_requests SET state = ? WHERE id = ?', [state, a.subjectId]);
    } else if (a.subjectType === 'sample') {
      await run('UPDATE samples SET state = ? WHERE id = ?', [a.state === 'approved' ? 'Approved' : 'Requested', a.subjectId]);
    } else if (a.subjectType === 'territory_request') {
      await run('UPDATE territory_requests SET state = ?, decisionNote = ?, decidedAt = ? WHERE id = ?',
        [a.state, a.decisionNote ?? null, a.decidedAt ?? null, a.subjectId]);
    } else if (a.subjectType === 'tour') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE tours SET state = ?, decisionNote = ? WHERE id = ?', [state, a.decisionNote ?? null, a.subjectId]);
    }
  });
  return rows.length;
}

/**
 * Rows the server says are gone.
 *
 * Only ever reference data. Nothing the salesman authored is deleted by a
 * sync — not a rejected order, not a visit that lost a conflict.
 */
const DELETABLE = new Set(['customers', 'products', 'timeline_events', 'journey_stops', 'documents', 'courses', 'notifications', 'schemes', 'holidays']);

/**
 * LETTING GO OF SHOPS THAT ARE NO LONGER HIS.
 *
 * A pull says what exists and a tombstone says what stopped, and there was a
 * gap between the two that nothing was watching. `mbos_deletions` is written
 * when somebody EDITS an allocation — so every OTHER way a book can shrink
 * wrote no tombstone at all. A role changed under him, an account reassigned,
 * a customer's city corrected: each one narrowed what the server would send
 * and never told this phone to drop what it was already holding.
 *
 * The case that made it plain: a salesman with no territory. The server is
 * right to send him nothing — `customerIdsInScope` short-circuits before it
 * asks — and his handset went on showing a book downloaded under an older
 * rule, indefinitely, because no pass had ever been asked to compare the two.
 * He could open shops he is not allowed to see, and nothing on any screen
 * looked wrong.
 *
 * So the server states the whole book on every pass and this drops the
 * difference, rather than the difference being guessed at by whichever write
 * path remembered to record one.
 *
 * ABSENT IS NOT EMPTY, and the safety of the whole thing is in that line.
 * `undefined` is an older server that does not send this — touch nothing,
 * because reading silence as "you may hold nothing" would wipe every book in
 * the field the moment a handset met a deployment that predates it. `[]` is
 * this server saying the book IS empty, which is a true answer, and it is
 * acted on.
 *
 * ONLY REFERENCE DATA GOES. The customer row and the office history hanging
 * off it — never a visit, an order, a payment or a lead this salesman
 * authored. That is the rule the whole pull is built on and a shrinking book
 * is not a licence to break it: work he did in a shop that has since moved to
 * somebody else is still work he did, and it still has to reach the office.
 */
async function reconcileBook(bookIds: string[] | undefined): Promise<number> {
  if (!Array.isArray(bookIds)) return 0;

  /* A LEAD'S SHOP STAYS, whatever the territory says.
   *
   * `leads` is keyed on the same id as `customers` and rides its OWN channel,
   * narrowed by who owns the lead rather than by where the shop is — so the
   * office can legitimately send a lead whose customer row the territory
   * clause excludes. Deleting that row would take the lead off the Customers
   * view, which asks an EXISTS against this very table, while leaving it on
   * the Leads one: the same shop present on one screen and gone from another.
   * It is also his own work, and this is a sync. */
  /* A SHOP HE ADDED HIMSELF STAYS TOO, until the office has it.
   *
   * A shop created on this phone is in no `bookIds` until its create has been
   * accepted — and for a while after, because a shop created with no region
   * falls outside a state or city allocation. The reconcile deleted it on the
   * very pull that answered the create, so his orders were left pointing at a
   * shop that was gone from his own phone. Anything with a create still in
   * the outbox, refused or not, is his work; it is kept. */
  const local = await all<{ id: string }>(
    `SELECT id FROM customers
      WHERE id NOT IN (SELECT id FROM leads)
        AND NOT EXISTS (SELECT 1 FROM sync_queue q
                         WHERE q.entityId = customers.id AND q.state <> 'synced')`,
  );
  const keep = new Set(bookIds);
  await rememberMissing(bookIds);
  if (!local.length) return 0;
  const gone = local.map((r) => r.id).filter((id) => !keep.has(id));
  if (!gone.length) return 0;

  /* Chunked: SQLite has a ceiling on bound variables — 999 on the builds this
     app has shipped against — and a reassignment can move a whole book at
     once. 400 keeps every statement below it with room to spare. */
  for (let i = 0; i < gone.length; i += 400) {
    const batch = gone.slice(i, i + 400);
    const marks = batch.map(() => '?').join(',');
    /* The office's history first, then the row it hangs off. Orphaned history
       is what `applyDeletions` leaves behind today, and there is no screen
       that could ever show it again. */
    for (const t of ['timeline_events', 'customer_orders', 'customer_payments', 'customer_bills']) {
      await run(`DELETE FROM ${t} WHERE customerId IN (${marks})`, batch);
    }
    await run(`DELETE FROM customers WHERE id IN (${marks})`, batch);
  }
  return gone.length;
}

/** The kv key the next sync reads its `missingIds` from. */
export const MISSING_KEY = 'missingCustomerIds';

/** At most this many asked for in one pull, so the reply stays small on 2G. */
export const MISSING_PER_PULL = 300;

/**
 * SHOPS IN HIS BOOK THAT THIS PHONE HAS NEVER BEEN SENT.
 *
 * A delta sends customers whose row CHANGED. A shop that is newly HIS — a
 * territory allocated this morning, an account moved to him — has not changed,
 * so it arrived on no pass and his phone stayed empty until he signed out and
 * in. That is the rollout path itself, now that no territory means no book.
 *
 * The book's ids come down on every pass, so the difference is known here:
 * whatever the office says is his and this phone does not hold. It is asked
 * for by id on the next sync, a page at a time, and the office sends those
 * shops whole, with their history.
 */
async function rememberMissing(bookIds: string[]): Promise<void> {
  if (!bookIds.length) {
    await run('DELETE FROM kv WHERE key = ?', [MISSING_KEY]);
    return;
  }
  const held = new Set((await all<{ id: string }>('SELECT id FROM customers')).map((r) => r.id));
  const missing = bookIds.filter((id) => !held.has(id)).slice(0, MISSING_PER_PULL);
  if (missing.length) await setKv(MISSING_KEY, JSON.stringify(missing));
  else await run('DELETE FROM kv WHERE key = ?', [MISSING_KEY]);
}

/** What the next sync should ask for by id. Empty when nothing is missing. */
export async function missingCustomerIds(): Promise<string[]> {
  const raw = await getKv(MISSING_KEY);
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A LEAD THAT HAS BECOME A CUSTOMER HAS NO LEAD ROW ON THIS PHONE.
 *
 * It began with third-party shops: most were CRM leads before somebody marked
 * them, the office sent them down the leads channel with their old stage, and
 * every screen here reads "is a lead" as a row in the leads table — so they
 * were listed under Leads, opened on the funnel and asked to be qualified as
 * Suspects. The same was true of every lead that converted by ordering: the
 * channel stops sending a `won` lead, a pull only says what exists, and the
 * row stayed at its last rung for the life of the installation.
 *
 * The office now tombstones a conversion, which ARCHIVES the row — off every
 * Leads screen but the Archived one, where Mahek does not want it either. So
 * this removes it, on every pass, by `CONVERTED_LEAD`: the same four facts the
 * office's own Leads lists leave out, read from the customer row the office
 * keeps current as well as from the lead row an older sync may have frozen.
 *
 * Synced rows only. A lead the salesman has changed and not yet sent is his
 * own work, and it waits in the outbox until the office has heard it.
 */
async function releaseConvertedLeads(): Promise<number> {
  const where = `${noPending('leads')} AND ${CONVERTED_LEAD}`;
  const rows = await all<{ id: string }>(`SELECT id FROM leads WHERE ${where}`);
  if (!rows.length) return 0;
  await run(`DELETE FROM leads WHERE ${where}`);
  return rows.length;
}

async function applyDeletions(deletions: { entity: string; ids: string[] }[] | undefined): Promise<number> {
  if (!deletions?.length) return 0;
  let n = 0;
  for (const d of deletions) {
    if (!d.ids.length) continue;
    /* Chunked like `reconcileBook`: a reassignment can tombstone two thousand
       shops at once, and an IN list that long is past SQLite's ceiling on
       bound variables — which threw, and took the whole pull with it. */
    for (let i = 0; i < d.ids.length; i += 400) {
      n += await applyDeletionChunk(d.entity, d.ids.slice(i, i + 400));
    }
  }
  return n;
}

async function applyDeletionChunk(entity: string, ids: string[]): Promise<number> {
  const marks = ids.map(() => '?').join(',');
  /*
   * A LEAD MOVED TO THE OFFICE'S TRASH is ARCHIVED here, never deleted. A
   * lead is something the salesman works and may still have changes queued
   * in the outbox for, and nothing he authored is deleted by a sync. Every
   * Leads screen reads `archived = 0`, so it leaves them all; if an
   * administrator restores it, the next pull sends it back and `upsertLeads`
   * writes `archived = 0` over it.
   */
  if (entity === 'leads') {
    await run(`UPDATE leads SET archived = 1 WHERE id IN (${marks})`, ids);
    return ids.length;
  }
  if (!DELETABLE.has(entity)) return 0;
  await run(`DELETE FROM ${entity} WHERE id IN (${marks})`, ids);
  return ids.length;
}

/* ------------------------------------------------------- his own history */

/**
 * HIS EXPENSES AND ALLOWANCES, as the office now holds them.
 *
 * The office sends the whole window every pull (`expenseBookFor`), because
 * what changes here is as often a decision on an approval, or an allowance
 * re-worked from a trip the trail has only now measured, as the row itself.
 *
 * Every row is upserted — never over one he has changed and not yet sent
 * (`noPending`), the rule every owned table follows. Then any ALLOWANCE in the
 * window the office no longer names is dropped: a trip re-moded to walking
 * pays nothing, and the office keeps no ₹0 line, so a missing allowance is the
 * office saying it is gone. An expense he LOGGED is never dropped here — it is
 * his, and one the office has lost is something he must still be able to see.
 *
 * Absent is an older server, and changes nothing.
 */
const EXPENSE_BOOK_LIMIT = 400;

async function applyExpenseBook(book: { from: string; rows: unknown[] } | undefined): Promise<number> {
  if (!book || !Array.isArray(book.rows) || typeof book.from !== 'string') return 0;
  const device = await deviceId();
  const seen: string[] = [];
  const n = await eachRow('expenses', book.rows, async (raw) => {
    const e = raw as {
      id: string; userId: string; spentOn: string; category: string; kind?: string | null;
      amountPaise: number; remarks?: string | null; billPhotoId?: string | null;
      expenseDayId?: string | null; allowance?: number | boolean; state: string;
      approvedAmountPaise?: number | null; decisionNote?: string | null;
      clientCreatedAt?: number | null; serverCreatedAt?: number | null;
    };
    seen.push(e.id);
    const allowance = e.allowance === true || e.allowance === 1 ? 1 : 0;
    const state = allowance
      ? 'Approved'
      : e.state === 'approved' || e.state === 'partially_approved'
        ? 'Approved'
        : e.state === 'rejected'
          ? 'Rejected'
          : 'Pending';
    await run(
      `INSERT INTO expenses (id, userId, spentOn, category, kind, amountPaise, remarks, billPhotoId,
                             expenseDayId, allowance, state, approvedAmountPaise, rejectionReason,
                             decisionNote, clientCreatedAt, serverCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
       ON CONFLICT(id) DO UPDATE SET
         spentOn = excluded.spentOn, category = excluded.category, kind = excluded.kind,
         amountPaise = excluded.amountPaise, remarks = excluded.remarks,
         billPhotoId = COALESCE(expenses.billPhotoId, excluded.billPhotoId),
         allowance = excluded.allowance, state = excluded.state,
         approvedAmountPaise = excluded.approvedAmountPaise,
         rejectionReason = excluded.rejectionReason, decisionNote = excluded.decisionNote,
         serverCreatedAt = excluded.serverCreatedAt, syncState = 'synced'
       WHERE ${noPending('expenses')}`,
      [
        e.id,
        e.userId,
        e.spentOn,
        e.category,
        e.kind ?? e.category,
        e.amountPaise,
        e.remarks ?? null,
        e.billPhotoId ?? null,
        e.expenseDayId ?? null,
        allowance,
        state,
        e.state === 'partially_approved' ? e.approvedAmountPaise ?? null : null,
        e.state === 'rejected' ? e.decisionNote ?? null : null,
        e.decisionNote ?? null,
        e.clientCreatedAt ?? e.serverCreatedAt ?? 0,
        e.serverCreatedAt ?? null,
        device,
      ],
    );
  });

  /* A FULL page may have left allowances out for room rather than because
     they are gone, so nothing is dropped from one — the next pull, with fewer
     rows, says it properly. */
  if (book.rows.length < EXPENSE_BOOK_LIMIT) {
    await run(
      `DELETE FROM expenses
        WHERE allowance = 1 AND spentOn >= ?
          ${seen.length ? `AND id NOT IN (${seen.map(() => '?').join(',')})` : ''}`,
      [book.from, ...seen],
    );
  }
  return n;
}

/**
 * What the bootstrap adds beyond `PullPayload`: his own requests, for a phone
 * that holds none of them. Optional, so an older server changes nothing.
 */
export type FullPull = PullPayload & {
  myLeaveRequests?: unknown[];
  myExpenses?: unknown[];
  myTours?: unknown[];
  myApprovals?: unknown[];
};

/**
 * HIS LEAVE, CLAIMS, TOURS AND THE APPROVALS BEHIND THEM, for a phone that
 * has none — a reinstall, or a new handset.
 *
 * These are OWNED tables and were never pulled, by the rule that a sync must
 * not write over what somebody authored offline. So a salesman who changed
 * phones saw no leave he had asked for, no claim he had made and no tour he had
 * been approved — and `applyApprovals` UPDATEs local rows, so a decision on a
 * request the phone did not hold landed on nothing.
 *
 * INSERT OR IGNORE, and only that. A row already here — including one saved a
 * minute ago with no signal — is never touched; this only fills gaps, which is
 * the same exception `restoreAttendance` makes and for the same reason.
 */
async function fillOwnHistory(pull: FullPull): Promise<number> {
  let n = 0;
  n += await fillGaps('leave_requests', pull.myLeaveRequests);
  n += await fillGaps('expenses', pull.myExpenses);
  n += await fillGaps('tours', pull.myTours);
  n += await fillGaps('approvals', pull.myApprovals);
  return n;
}

async function fillGaps(table: string, rows: unknown[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  const known = await knownColumns(table);
  const device = await deviceId();
  return eachRow(table, rows, async (raw) => {
    const row: Row = { deviceId: device, syncState: 'synced', ...(raw as Row) };
    const cols = Object.keys(row).filter((c) => known.has(c));
    if (!cols.includes('id')) return;
    await run(
      `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => normalise(row[c])),
    );
  });
}

/**
 * THE NEWEST TEN PER SHOP, and nothing older.
 *
 * The office sends each shop's last ten orders, and an eleventh does not change
 * a row there — it displaces one, and nothing tells the phone which. So the
 * displaced order sat here for ever and the table only grew. The count is the
 * server's own (`HISTORY_PER_CUSTOMER`), restated as the one number both ends
 * keep.
 */
export const ORDERS_PER_SHOP = 10;

async function pruneCustomerOrders(): Promise<number> {
  await run(
    `DELETE FROM customer_orders WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY customerId ORDER BY orderedAt DESC, id DESC
                ) AS rn
           FROM customer_orders
       ) WHERE rn > ?
     )`,
    [ORDERS_PER_SHOP],
  );
  return 0;
}

/* ------------------------------------------------- travel and the policy */

/**
 * The modes a leg may name.
 *
 * Upserted rather than replaced, so a mode the office retires stops being
 * OFFERED — the pickers read `active` through the pull, which stops sending
 * it — while a leg already recorded against it keeps resolving to a label.
 * The same rule retired quick notes follow in the CRM.
 */
async function upsertTravelModes(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  await eachRow('travelModes', rows, async (raw) => {
    const m = raw as {
      key: string;
      label: string;
      sortOrder: number;
      reimbursementKind: string;
      requiresOdometer: boolean;
      requiresTicket: boolean;
      scope?: string;
    };
    await run(
      `INSERT INTO travel_modes (key, label, sortOrder, reimbursementKind,
                                 requiresOdometer, requiresTicket, scope, lastSyncedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         label = excluded.label,
         sortOrder = excluded.sortOrder,
         reimbursementKind = excluded.reimbursementKind,
         requiresOdometer = excluded.requiresOdometer,
         requiresTicket = excluded.requiresTicket,
         scope = excluded.scope,
         lastSyncedAt = excluded.lastSyncedAt`,
      [
        m.key,
        m.label,
        m.sortOrder ?? 0,
        m.reimbursementKind,
        m.requiresOdometer ? 1 : 0,
        m.requiresTicket ? 1 : 0,
        /* A SERVER THAT HAS NOT BEEN DEPLOYED YET SENDS NOTHING, and `leg` is
           the answer that keeps a phone working: every mode goes on being
           offered at the stop exactly as it was, which is where they were all
           offered before this existed. Reading a missing scope as `day` would
           empty the journey's own picker on a handset whose office is one
           release behind. */
        m.scope ?? 'leg',
        now,
      ],
    );
  });
  return rows.length;
}

/**
 * The expense policy, REPLACED WHOLESALE.
 *
 * Exactly like the price list, and for exactly the same reason: a rule the
 * office withdrew has to disappear. A merge would leave a rate on this phone
 * that the office will not pay, and the salesman would be told a number, act
 * on it, and be paid a different one — which is the single fastest way to make
 * a field app untrusted.
 *
 * Null is a real answer and it is kept as one: no policy covers today, so the
 * screens say the office has not published one rather than showing ₹0 eligible
 * against every claim.
 */
async function replaceExpensePolicy(policy: unknown, now: number): Promise<number> {
  /* ABSENT is not null. The reply to a phone with no cursor sends no policy at
     all, and reading that as "none covers today" deleted the one the
     bootstrap had delivered a second earlier. */
  if (policy === undefined) return 0;
  await run(`DELETE FROM expense_policy`);
  if (!policy) return 0;
  const p = policy as {
    policyId: string;
    versionNo: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    grade: string | null;
    cityClass: string | null;
    rules: unknown[];
    sentences: string[];
  };
  await run(
    `INSERT INTO expense_policy
       (id, policyId, versionNo, effectiveFrom, effectiveTo, grade, cityClass,
        rulesJson, sentencesJson, lastSyncedAt)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.policyId,
      p.versionNo,
      p.effectiveFrom,
      p.effectiveTo,
      p.grade,
      p.cityClass,
      JSON.stringify(p.rules ?? []),
      JSON.stringify(p.sentences ?? []),
      now,
    ],
  );
  return 1;
}
