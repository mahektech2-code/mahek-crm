import { all, getKv, run, setKv, tx } from '../db';
import { deviceId, type PullPayload, type TerritoryState } from './api';

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

  await tx(async () => {
    touched += await upsertCustomers(pull.customers, now);
    touched += await upsertProducts(pull.products, now);
    touched += await upsertPriceList(pull.priceList);
    touched += await upsertSchemes(pull.schemes);
    touched += await upsertTimeline(pull.timeline);
    touched += await upsertCustomerOrders(pull.customerOrders, now);
    touched += await upsertCustomerPayments(pull.customerPayments, now);
    touched += await upsertCustomerBills(pull.customerBills, now);
    touched += await upsertStops(pull.journeyStops, now);
    touched += await upsertPlanDays(pull.planDays, now);
    touched += await upsertConfig(pull.config, now);
    touched += await storeTerritory(pull.territory);
    touched += await upsertNotifications(pull.notifications);
    touched += await upsertLeaveBalances(pull.leaveBalances, now);
    touched += await upsertHolidays(pull.holidays, now);
    touched += await upsertDocuments(pull.documents, now);
    touched += await upsertCourses(pull.courses, now);
    touched += await upsertPerformance(pull.performance, now);
    touched += await upsertTasks(pull.tasks, now);
    touched += await upsertLeads(pull.leads, now);
    touched += await upsertSamples(pull.samples, now);
    touched += await upsertSalary(pull.salary, now);
    touched += await upsertTravelModes(pull.travelModes, now);
    touched += await replaceExpensePolicy(pull.expensePolicy, now);
    touched += await applyApprovals(pull.approvals);
    touched += await restoreAttendance(pull.attendanceToday);
    touched += await applyDeletions(pull.deletions);
  });

  /* Outside the transaction, because confirming a transcript deletes the audio
     file from the filesystem — which is not a thing a database transaction can
     roll back, and not a thing to hold one open across. */
  touched += await applyTranscripts(pull.transcripts);

  return touched;
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
 */
async function upsert(table: string, key: string, rows: unknown[] | undefined, extra: Row = {}): Promise<number> {
  if (!rows?.length) return 0;
  const known = await knownColumns(table);
  for (const raw of rows) {
    const row = { ...(raw as Row), ...extra };
    const cols = Object.keys(row).filter((c) => known.has(c));
    if (!cols.includes(key)) continue;
    const marks = cols.map(() => '?').join(',');
    const sets = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ');
    await run(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${marks})
       ON CONFLICT(${key}) DO UPDATE SET ${sets}`,
      cols.map((c) => normalise(row[c])),
    );
  }
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
 * The open bills, REPLACED WHOLESALE — the price list's rule, for the same
 * reason it has it.
 *
 * A rate that was withdrawn has to disappear; so does a bill that has been
 * settled. A per-row upsert leaves it behind, and a bill left behind is one
 * the picker goes on offering — so a salesman names it, the server refuses the
 * allocation with `bill_settled`, and the refusal looks like the app being
 * wrong rather than the phone being stale. The server sends the CURRENT open
 * set for every customer on this handset on every pass, never a delta, which
 * is what makes replacing correct.
 *
 * `!rows?.length` guards it exactly as the price list does: an empty payload
 * is the no-cursor pull saying nothing, not the office saying every bill in
 * the book has been paid.
 */
async function upsertCustomerBills(rows: unknown[] | undefined, now: number) {
  if (!rows?.length) return 0;
  await run('DELETE FROM customer_bills');
  return upsert('customer_bills', 'id', rows, { lastSyncedAt: now });
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

function upsertCustomerPayments(rows: unknown[] | undefined, now: number) {
  return upsert('customer_payments', 'id', rows, { lastSyncedAt: now });
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
 * `WHERE syncState = 'synced'` is what keeps that from happening. A queued row
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
  const { localNotes, localStage } = await import('../lib/wire');
  for (const raw of rows) {
    const l = raw as {
      id: string;
      name: string;
      companyName?: string | null;
      mobile?: string | null;
      city?: string | null;
      /* The locality inside the city. Sent since leads existed and
         dropped until this table had a column for it. */
      area?: string | null;
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
    };
    await run(
      `INSERT INTO leads (id, name, company, mobile, city, area, source, estimatedPotentialPaise,
                          assigneeId, stage, nextFollowUpDate, notes, convertedCustomerId,
                          archived, lastActivityDate, gpsLat, gpsLng,
                          leadManagerId, leadManagerName, visitCount, holdReason,
                          clientCreatedAt, serverCreatedAt, deviceId, syncState,
                          salesType, funnelStage, stageSince, customerType, monthlyLitres,
                          competitor, requiredProductId, requiredProductName, contactPerson,
                          decisionMaker, creditDaysWanted, application, gstin, qualification,
                          nextAction, nextActionDate, nextActionOwnerId, nextActionOutcome,
                          suspectDecidedAt, verifiedAt, thirdParty, distributorSalesmanId,
                          distributorSalesmanName, expectedOrderDate, expectedOrderValuePaise)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', 'synced',
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, company = excluded.company, mobile = excluded.mobile,
         city = excluded.city, area = excluded.area, source = excluded.source,
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
         gstin = excluded.gstin, qualification = excluded.qualification,
         nextAction = excluded.nextAction, nextActionDate = excluded.nextActionDate,
         nextActionOwnerId = excluded.nextActionOwnerId,
         nextActionOutcome = excluded.nextActionOutcome,
         suspectDecidedAt = excluded.suspectDecidedAt, verifiedAt = excluded.verifiedAt,
         thirdParty = excluded.thirdParty,
         distributorSalesmanId = excluded.distributorSalesmanId,
         distributorSalesmanName = excluded.distributorSalesmanName,
         expectedOrderDate = excluded.expectedOrderDate,
         expectedOrderValuePaise = excluded.expectedOrderValuePaise
       WHERE leads.syncState = 'synced'`,
      [
        l.id,
        l.name,
        l.companyName ?? null,
        l.mobile ?? null,
        l.city ?? null,
        l.area ?? null,
        l.source ?? null,
        l.estimatedPotentialPaise ?? null,
        localStage(l.stage),
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
      ],
    );
  }
  return rows.length;
}

async function upsertSamples(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localInstant, localSampleState } = await import('../lib/wire');
  for (const raw of rows) {
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
    };
    await run(
      `INSERT INTO samples (id, customerId, productId, productName, cans, reason,
                            requestedAt, state, deliveredAt, deliveryPhotoId, trialOutcome,
                            followUpDate, convertedOrderId,
                            dispatchedAt, courierName, trackingNumber, receivedAt,
                            trialStartedAt, trialCompletedAt, satisfaction,
                            additionalRequirement, rejectionReason,
                            clientCreatedAt, serverCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', 'synced')
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
         rejectionReason = excluded.rejectionReason
       WHERE samples.syncState = 'synced'`,
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
        now,
        now,
      ],
    );
  }
  return rows.length;
}

async function upsertTasks(rows: unknown[] | undefined, now: number): Promise<number> {
  if (!rows?.length) return 0;
  const { localPriority } = await import('../lib/wire');
  for (const raw of rows) {
    const t = raw as {
      id: string;
      title: string;
      description?: string | null;
      assignedToUserId: string;
      assignedByUserId?: string | null;
      priority: string;
      dueDate: string;
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
    };
    const status = t.status === 'in_progress' ? 'open' : t.status;
    const snoozeHistory = t.snoozedTo
      ? JSON.stringify([{ at: now, to: t.snoozedTo, reason: t.snoozeReason ?? '' }])
      : null;
    await run(
      `INSERT INTO tasks (id, title, description, assigneeId, assignerId, priority, dueDate,
                          customerId, status, completionNote, completionPhotoId, snoozeHistory,
                          sourceType, sourceId,
                          escalated, clientCreatedAt, serverCreatedAt, deviceId, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'server', 'synced')
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, description = excluded.description,
         priority = excluded.priority, dueDate = excluded.dueDate, customerId = excluded.customerId,
         status = excluded.status, completionNote = excluded.completionNote,
         completionPhotoId = excluded.completionPhotoId, escalated = excluded.escalated,
         sourceType = excluded.sourceType, sourceId = excluded.sourceId,
         syncState = 'synced'`,
      [
        t.id,
        t.title,
        t.description ?? null,
        t.assignedToUserId,
        t.assignedByUserId ?? null,
        localPriority(t.priority),
        t.dueDate,
        t.customerId ?? null,
        status,
        t.completionNote ?? null,
        t.completionPhotoId ?? null,
        snoozeHistory,
        t.sourceType ?? null,
        t.sourceId ?? null,
        t.escalatedAt ? 1 : 0,
        now,
      ],
    );
  }
  return rows.length;
}

/**
 * An approval decision coming back down.
 *
 * The subject record's state is DERIVED from its approval and never set on its
 * own — so an order becomes approved because its approval says so, not because
 * something wrote a flag onto the order.
 */
async function applyApprovals(rows: unknown[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  for (const raw of rows) {
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
         approverName = excluded.approverName, syncState = 'synced'`,
      [a.id, a.subjectType, a.subjectType, a.subjectId, a.state, a.decidedAt ?? null, a.decisionNote ?? null,
       a.approvedAmountPaise ?? null, a.approverName ?? null],
    );

    if (a.subjectType === 'order') {
      const status = a.state === 'approved' ? 'approved' : a.state === 'rejected' ? 'rejected' : 'pending_approval';
      await run('UPDATE orders SET status = ?, approvalId = ? WHERE id = ?', [status, a.id, a.subjectId]);
    } else if (a.subjectType === 'expense') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE expenses SET state = ?, approvedAmountPaise = ? WHERE id = ?', [state, a.approvedAmountPaise ?? null, a.subjectId]);
    } else if (a.subjectType === 'leave') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE leave_requests SET state = ? WHERE id = ?', [state, a.subjectId]);
    } else if (a.subjectType === 'sample') {
      await run('UPDATE samples SET state = ? WHERE id = ?', [a.state === 'approved' ? 'Approved' : 'Requested', a.subjectId]);
    } else if (a.subjectType === 'tour') {
      const state = a.state === 'approved' ? 'Approved' : a.state === 'rejected' ? 'Rejected' : 'Pending';
      await run('UPDATE tours SET state = ?, decisionNote = ? WHERE id = ?', [state, a.decisionNote ?? null, a.subjectId]);
    }
  }
  return rows.length;
}

/**
 * Rows the server says are gone.
 *
 * Only ever reference data. Nothing the salesman authored is deleted by a
 * sync — not a rejected order, not a visit that lost a conflict.
 */
const DELETABLE = new Set(['customers', 'products', 'timeline_events', 'journey_stops', 'documents', 'courses', 'notifications', 'schemes', 'holidays']);

async function applyDeletions(deletions: { entity: string; ids: string[] }[] | undefined): Promise<number> {
  if (!deletions?.length) return 0;
  let n = 0;
  for (const d of deletions) {
    if (!DELETABLE.has(d.entity) || !d.ids.length) continue;
    const marks = d.ids.map(() => '?').join(',');
    await run(`DELETE FROM ${d.entity} WHERE id IN (${marks})`, d.ids);
    n += d.ids.length;
  }
  return n;
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
  for (const raw of rows) {
    const m = raw as {
      key: string;
      label: string;
      sortOrder: number;
      reimbursementKind: string;
      requiresOdometer: boolean;
      requiresTicket: boolean;
    };
    await run(
      `INSERT INTO travel_modes (key, label, sortOrder, reimbursementKind,
                                 requiresOdometer, requiresTicket, lastSyncedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         label = excluded.label,
         sortOrder = excluded.sortOrder,
         reimbursementKind = excluded.reimbursementKind,
         requiresOdometer = excluded.requiresOdometer,
         requiresTicket = excluded.requiresTicket,
         lastSyncedAt = excluded.lastSyncedAt`,
      [
        m.key,
        m.label,
        m.sortOrder ?? 0,
        m.reimbursementKind,
        m.requiresOdometer ? 1 : 0,
        m.requiresTicket ? 1 : 0,
        now,
      ],
    );
  }
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
