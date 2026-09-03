import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  attachments,
  bills,
  complaints,
  customerDistributors,
  customers,
  syncConflicts,
  mbosApprovals,
  mbosAttendanceDays,
  mbosConflicts,
  mbosDevices,
  mbosExpenses,
  mbosLeads,
  mbosActivityLocations,
  mbosJourneyPlans,
  mbosJourneyStops,
  mbosCompetitorRecords,
  mbosLeaveRequests,
  mbosTours,
  mbosSamples,
  mbosSyncReceipts,
  mbosTasks,
  mbosVisits,
  notifications,
  orders,
  paymentReceipts,
  payments,
  products,
  users,
  type OrderLine,
} from "@/db/schema";
import { writeTimelineEvent, type TimelineWriter } from "../timeline";
import { scopedToUsers} from "../access-control";
import { getConfig } from "../config/store";
import { financialYearOf } from "../financial-year";
import { metresBetween } from "../geo";
import { today, recomputeOutstanding, recomputeLastContact } from "../recompute";
import { allocate, type AllocatableBill } from "../engines/allocation";
import { computeHealth, type HealthFacts } from "../engines/health";
import { fileStorage } from "../storage";
import { transcribeSpeech } from "../dictation";
import { sniffContentType, ACCEPTED_AUDIO_TYPES } from "../file-types";
import { issueToken, verifyToken, signingKeyPresent } from "../mbos/token";
import {
  checkDeviceBinding,
  loadPrincipal,
  runLoginChecks,
  buildBootstrap,
  type MbosPrincipal,
} from "../services/mbos-service";
import type {
  RejectionCode,
  SyncEntityType,
  SyncItem,
  SyncResult,
} from "../mbos/types";

/* ---------------------------------------------------------------------------
 * MBOS — every write the handset makes.
 *
 * Three rules run through the whole file.
 *
 * **A replay writes nothing.** Every item carries an `idempotencyKey`, it is
 * looked up in `mbos_sync_receipts` BEFORE anything happens, and the stored
 * response is returned verbatim — including the number the record was given.
 * On 2G in a market, "send it again because we never saw the answer" is most
 * requests, and a second receipt for one transfer is not a retry, it is money
 * the business thinks arrived twice.
 *
 * **The server re-validates what the client validated against a stale cache.**
 * The handset checked the credit limit against a book that may be hours old,
 * and against a customer accounts blocked this morning. That check is redone
 * here, and a refusal is a REJECTION with a code and a sentence — never a
 * silent drop and never a 500.
 *
 * **The numbers are allocated here, in a transaction.** Two salesmen offline
 * must never produce the same order number, which is exactly why the number is
 * not the identity: the id came from the handset, the number comes from the
 * series, and they are different things.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

/* ═════════════════════════════════════════════════════════════════ sign-in */

export type LoginOutcome =
  | {
      ok: true;
      accessToken: string;
      accessExpiresAt: number;
      refreshToken: string;
      refreshExpiresAt: number;
      bootstrap: Awaited<ReturnType<typeof buildBootstrap>>;
    }
  | { ok: false; status: number; step: string; error: string };

export async function mbosLogin(input: {
  mobile: string;
  password?: string;
  otp?: string;
  deviceId: string;
  deviceLabel?: string;
  platform?: string;
  appVersion?: string;
}): Promise<LoginOutcome> {
  if (!signingKeyPresent()) {
    return {
      ok: false,
      status: 503,
      step: "not_configured",
      error:
        "MBOS_JWT_SECRET is not set on this deployment, so no handset can be signed in. An admin has to set it.",
    };
  }

  if (!input.deviceId) {
    return {
      ok: false,
      status: 400,
      step: "validation",
      error: "This handset did not send its device id, so the sign-in cannot be bound to it.",
    };
  }

  /* Checks 1, 2, 3 and 4, in that order, each with its own sentence. */
  const checks = await runLoginChecks({ mobile: input.mobile, password: input.password });
  if (!checks.ok) {
    const status =
      checks.step === "unknown_user" || checks.step === "bad_password" ? 401 : 403;
    return { ok: false, status, step: checks.step, error: checks.error };
  }
  const user = checks.user;

  /* Device binding — one active handset per person. */
  const device = await checkDeviceBinding(user.id, input.deviceId);
  if (!device.ok) {
    return { ok: false, status: 409, step: "device_bound", error: device.error };
  }

  const now = new Date();
  await db
    .insert(mbosDevices)
    .values({
      id: gen("mbos_device"),
      userId: user.id,
      deviceId: input.deviceId,
      model: input.deviceLabel ?? null,
      platform: input.platform ?? null,
      appVersion: input.appVersion ?? null,
      boundAt: now,
      lastSeenAt: now,
      active: true,
      createdById: user.id,
      updatedById: user.id,
    })
    .onConflictDoUpdate({
      target: mbosDevices.deviceId,
      set: {
        userId: user.id,
        model: input.deviceLabel ?? null,
        platform: input.platform ?? null,
        appVersion: input.appVersion ?? null,
        lastSeenAt: now,
        active: true,
        releasedAt: null,
        releaseReason: null,
        updatedAt: now,
        updatedById: user.id,
      },
    });

  /* Check 5 — the bootstrap actually loads. A sign-in that succeeds and then
   * opens an empty app is a sign-in that failed somewhere nobody was told
   * about, so it is part of the login rather than the screen after it. */
  const principal = await loadPrincipal(user.id, input.deviceId);
  if (!principal.ok) {
    return {
      ok: false,
      status: principal.status,
      step: principal.code,
      error: principal.error,
    };
  }

  let bootstrap: Awaited<ReturnType<typeof buildBootstrap>>;
  try {
    bootstrap = await buildBootstrap(principal.principal);
  } catch (e) {
    return {
      ok: false,
      status: 503,
      step: "bootstrap_failed",
      error: `Signed in, but your book could not be loaded: ${
        e instanceof Error ? e.message : "the server did not answer"
      }. Try again in a moment.`,
    };
  }

  // `users.lastLoginAt` is written on sign-in. Nothing used to write it, and
  // every screen asking when somebody last signed in answered "never".
  await db
    .update(users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, user.id));

  const tokens = await issueTokenPair(user.id, input.deviceId);
  return { ok: true, ...tokens, bootstrap };
}

async function issueTokenPair(userId: string, deviceId: string) {
  const config = await getConfig();
  const access = issueToken({
    userId,
    deviceId,
    type: "access",
    ttlSeconds: config["mbos.sync.accessTokenMinutes"] * 60,
  });
  const refresh = issueToken({
    userId,
    deviceId,
    type: "refresh",
    // The same window a handset may stay signed in without ever reaching the
    // server — one number, so a device cannot be offline-valid for longer than
    // its refresh token lives.
    ttlSeconds: config["mbos.sync.offlineLoginValidityDays"] * 86_400,
  });
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export type RefreshOutcome =
  | {
      ok: true;
      accessToken: string;
      accessExpiresAt: number;
      refreshToken: string;
      refreshExpiresAt: number;
    }
  | { ok: false; status: number; code: string; error: string };

/**
 * Both tokens rotate. Handing back the same refresh token would make it a
 * long-lived password: one capture of a single request would be an open door
 * for its whole validity, and nothing would ever invalidate it.
 *
 * Everything is re-checked from the database — account open, app still
 * granted, handset still bound — because the refresh is the one moment a
 * long-running install comes back and asks whether it is still allowed.
 */
export async function mbosRefresh(refreshToken: string): Promise<RefreshOutcome> {
  const verified = verifyToken(refreshToken, "refresh");
  if (!verified.ok) {
    return {
      ok: false,
      status: 401,
      code: verified.reason,
      error:
        verified.reason === "expired"
          ? "This handset has been signed out for too long. Sign in again."
          : "That sign-in is not valid. Sign in again.",
    };
  }

  const principal = await loadPrincipal(verified.claims.sub, verified.claims.did);
  if (!principal.ok) {
    return {
      ok: false,
      status: principal.status,
      code: principal.code,
      error: principal.error,
    };
  }

  await db
    .update(mbosDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(mbosDevices.deviceId, verified.claims.did));

  return { ok: true, ...(await issueTokenPair(verified.claims.sub, verified.claims.did)) };
}

/* ══════════════════════════════════════════════════════════════ the ingest */

type Rejection = { code: RejectionCode; message: string };

const reject = (code: RejectionCode, message: string): Rejection => ({ code, message });

type Accepted = { serverId: string; serverNumber?: string };

/** What a handler may answer. `retry` is a dependency that has not landed yet. */
type Handled =
  | { kind: "accepted"; value: Accepted }
  | { kind: "rejected"; value: Rejection }
  | { kind: "retry"; message: string }
  | { kind: "conflict"; serverVersion: Record<string, unknown>; resolution: "server_wins" | "client_wins" };

/**
 * The batch, in the order the client sent it.
 *
 * The client has already dependency-sorted, and this trusts the ORDER but not
 * the CLAIM: `dependsOn` is verified against what exists, because an item
 * whose parent was rejected on a previous pass would otherwise land looking
 * like a payment against nothing.
 */
export async function ingestSyncBatch(
  principal: MbosPrincipal,
  items: SyncItem[],
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  /** Client ids accepted in THIS batch — a dependency may be one of them. */
  const acceptedHere = new Set<string>();
  /** Client ids refused in this batch, so their dependents can be blocked. */
  const refusedHere = new Set<string>();
  const touchedCustomers = new Set<string>();

  for (const item of items) {
    const receivedAt = Date.now();

    /* 1 — the idempotency ledger, before anything else happens. */
    const replay = await db
      .select({ resultJson: mbosSyncReceipts.resultJson })
      .from(mbosSyncReceipts)
      .where(eq(mbosSyncReceipts.idempotencyKey, item.idempotencyKey))
      .limit(1);

    if (replay.length) {
      const stored = replay[0].resultJson as SyncResult;
      // The queueId is the client's handle on this attempt and may differ
      // between the first send and the retry; everything else is verbatim.
      results.push({ ...stored, queueId: item.queueId } as SyncResult);
      if (stored.status === "accepted") acceptedHere.add(item.entityId);
      if (stored.status === "rejected") refusedHere.add(item.entityId);
      continue;
    }

    /* 2 — dependencies. Named but absent is `retry`, not `accepted`. */
    const missing = await missingDependencies(item, acceptedHere, refusedHere);
    if (missing.blocked) {
      const refusal: SyncResult = {
        queueId: item.queueId,
        status: "rejected",
        code: "validation",
        message: missing.message,
        blocks: dependentsOf(item.entityId, items),
      };
      results.push(refusal);
      refusedHere.add(item.entityId);
      // A rejection is stored like any other, so a replay of the same key
      // comes back as the same refusal rather than being worked out again.
      await storeReceipt(principal, item, refusal);
      continue;
    }
    if (missing.retry) {
      results.push({
        queueId: item.queueId,
        status: "retry",
        code: "dependency_missing",
        message: missing.message,
      });
      continue;
    }

    /* 3 — the write itself. */
    let handled: Handled;
    try {
      handled = await handleItem(principal, item);
    } catch (e) {
      // An unexpected failure is a RETRY, not a rejection. A rejection tells
      // the salesman their order was refused; a database that hiccuped has not
      // refused anything, and saying so would send them back to a shop for no
      // reason.
      results.push({
        queueId: item.queueId,
        status: "retry",
        code: "validation",
        message: `The server could not save this yet: ${
          e instanceof Error ? e.message : "unknown error"
        }. It will be tried again.`,
      });
      continue;
    }

    const result = toResult(item, handled, receivedAt, items);
    results.push(result);

    if (result.status === "accepted") {
      acceptedHere.add(item.entityId);
      const customerId = customerIdOf(item);
      if (customerId) touchedCustomers.add(customerId);
    }
    if (result.status === "rejected") {
      refusedHere.add(item.entityId);
      // A rejected ORDER also raises a task. The salesman stood in the shop
      // and said the order was placed; a notification can be missed, a task on
      // the list cannot.
      await raiseRejectionTask(principal, item, {
        code: result.code,
        message: result.message,
      });
    }

    /* 4 — the receipt. Stored for accepted, rejected and conflicted alike:
     * a replayed rejection has to come back as the same rejection, or the
     * handset would try the refused order again on the next pass. A `retry`
     * is deliberately NOT stored — it is the one answer that must not stick. */
    if (result.status !== "retry") await storeReceipt(principal, item, result);
  }

  /* 5 — the server-owned figures, once, after the batch. PROTOCOL §8: never
   * trusted from the client, and recomputed rather than incremented. */
  for (const customerId of touchedCustomers) {
    await recomputeOutstanding(customerId).catch(() => {});
    await recomputeLastContact(customerId).catch(() => {});
    await recomputeHealthScore(customerId).catch(() => {});
  }

  return results;
}

/**
 * The idempotency ledger. `resultJson` holds the WHOLE response rather than a
 * status, because the second caller has to receive exactly what the first one
 * did — including the number the record was given, which is the one thing they
 * cannot work out for themselves.
 *
 * `onConflictDoNothing` rather than an update: if two copies of one request
 * raced, the first answer is the one that was true and the second must not
 * overwrite it.
 */
async function storeReceipt(
  principal: MbosPrincipal,
  item: SyncItem,
  result: SyncResult,
): Promise<void> {
  await db
    .insert(mbosSyncReceipts)
    .values({
      id: gen("mbos_receipt"),
      idempotencyKey: item.idempotencyKey,
      deviceId: principal.deviceId,
      userId: principal.user.id,
      entityType: item.entityType,
      entityId: item.entityId,
      resultJson: result,
    })
    .onConflictDoNothing({ target: mbosSyncReceipts.idempotencyKey });
}

function toResult(
  item: SyncItem,
  handled: Handled,
  receivedAt: number,
  batch: SyncItem[],
): SyncResult {
  switch (handled.kind) {
    case "accepted":
      return {
        queueId: item.queueId,
        status: "accepted",
        serverId: handled.value.serverId,
        ...(handled.value.serverNumber
          ? { serverNumber: handled.value.serverNumber }
          : {}),
        serverReceivedAt: receivedAt,
      };
    case "rejected":
      return {
        queueId: item.queueId,
        status: "rejected",
        code: handled.value.code,
        message: handled.value.message,
        blocks: dependentsOf(item.entityId, batch),
      };
    case "conflict":
      return {
        queueId: item.queueId,
        status: "conflict",
        serverVersion: handled.serverVersion,
        resolution: handled.resolution,
      };
    case "retry":
      return {
        queueId: item.queueId,
        status: "retry",
        code: "dependency_missing",
        message: handled.message,
      };
  }
}

/** Which items in this batch named the given id as a dependency. */
function dependentsOf(entityId: string, batch: SyncItem[]): string[] {
  return batch
    .filter((i) => (i.dependsOn ?? []).includes(entityId))
    .map((i) => i.entityId);
}

function customerIdOf(item: SyncItem): string | null {
  const value = item.payload?.customerId;
  return typeof value === "string" ? value : null;
}

/* ------------------------------------------------------------ dependencies */

/**
 * A client id says which table it lives in: `mbos_order_<uuid>`. That is the
 * whole reason the prefix is in the id rather than only in a column — a
 * dependency arrives as a bare string and has to be looked up somewhere.
 */
const DEPENDENCY_TABLES: Record<string, string> = {
  visit: "mbos_visits",
  order: "orders",
  payment: "payment_receipts",
  complaint: "complaints",
  sample: "mbos_samples",
  lead: "mbos_leads",
  task: "mbos_tasks",
  expense: "mbos_expenses",
  attendance: "mbos_attendance_days",
  customer: "customers",
  leave: "mbos_leave_requests",
  approval: "mbos_approvals",
  plan: "mbos_journey_plans",
};

function entityOfClientId(id: string): string | null {
  const match = /^mbos_([a-z_]+)_/.exec(id);
  return match ? match[1] : null;
}

async function missingDependencies(
  item: SyncItem,
  acceptedHere: Set<string>,
  refusedHere: Set<string>,
): Promise<{ retry: boolean; blocked: boolean; message: string }> {
  const deps = item.dependsOn ?? [];
  for (const dep of deps) {
    if (acceptedHere.has(dep)) continue;

    /* A dependency refused EARLIER IN THIS BATCH is not something to wait for.
     * Answering `retry` would send the handset round the backoff schedule for
     * a parent that is never going to arrive — the case PROTOCOL §5 exists
     * for: a payment against an order the server refused must not land looking
     * like a payment against nothing. */
    if (refusedHere.has(dep)) {
      return {
        retry: false,
        blocked: true,
        message: `The record this depends on was refused in the same batch, so it was not saved either. Correct that one first — both are on the rejections screen.`,
      };
    }

    const entity = entityOfClientId(dep);
    const table = entity ? DEPENDENCY_TABLES[entity] : null;
    if (!table) {
      return {
        retry: false,
        blocked: true,
        message: `This record depends on ${dep}, which is not a kind of record MahekOne holds. It cannot be saved as it stands.`,
      };
    }

    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.raw(table)} where id = ${dep}`,
    );
    if (Number(rows[0]?.n ?? 0) === 0) {
      return {
        retry: true,
        blocked: false,
        message: `Waiting for ${dep}, which the server has not received yet.`,
      };
    }
  }
  return { retry: false, blocked: false, message: "" };
}

/* ---------------------------------------------------------------- handlers */

/**
 * One item, and where it was done.
 *
 * The location is recorded HERE rather than in each handler, and that is the
 * whole design: twelve handlers each remembering to write a coordinate is
 * eleven handlers remembering and one forgetting, which is precisely the state
 * this replaced — four tables out of twenty-seven carried one. A thirteenth
 * entity type gets it by existing.
 *
 * It is written only for an ACCEPTED item. A refused order did not happen, and
 * a position for it would be a record of somewhere the salesman stood while
 * something failed — noise on every screen that reads this, and one more row
 * to hold about a person for no reason. A retry writes the same row rather
 * than a second one, on the unique index.
 *
 * **It never affects the outcome.** The record is already written by the time
 * this runs, so a failure here leaves the activity intact with no location —
 * the same rule attachments follow, and for the same reason: a save must not
 * be lost to a thing that decorates it.
 */
async function handleItem(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const handled = await dispatchItem(principal, item);
  if (handled.kind === "accepted") {
    await recordActivityLocation(principal, item).catch(() => {});
  }
  return handled;
}

async function recordActivityLocation(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<void> {
  const where = item.location;
  if (!where) return;

  /* Checked on the server as well as on the handset. A setting that is only
     honoured by the phone is not a setting — an older build carries on doing
     whatever it was built to do, and the office turning this off has to mean
     nothing is stored. */
  const config = await getConfig();
  if (!config["mbos.location.logActivityLocation"]) return;

  const hasFix = typeof where.lat === "number" && typeof where.lng === "number";
  const inRange =
    hasFix &&
    (where.lat as number) >= -90 &&
    (where.lat as number) <= 90 &&
    (where.lng as number) >= -180 &&
    (where.lng as number) <= 180;

  await db
    .insert(mbosActivityLocations)
    .values({
      id: gen("aloc"),
      entityType: item.entityType,
      entityId: item.entityId,
      userId: principal.user.id,
      lat: inRange ? (where.lat as number) : null,
      lng: inRange ? (where.lng as number) : null,
      accuracyM: numberOrNull(where.accuracyM),
      capturedAt: where.capturedAt ? new Date(where.capturedAt) : null,
      ageSeconds: numberOrNull(where.ageSeconds),
      source: inRange ? (where.source ?? null) : null,
      /* No coordinates means the reason has to carry the answer, and an
         out-of-range pair is as good as none — `unavailable` rather than a
         silent null, so a screen can still tell asked-and-failed from
         never-asked. */
      reason: inRange ? null : (where.reason ?? "unavailable"),
      deviceId: principal.deviceId,
    })
    .onConflictDoNothing();
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

async function dispatchItem(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const type: SyncEntityType = item.entityType;
  switch (type) {
    case "visit":
      return handleVisit(principal, item);
    case "order":
      return handleOrder(principal, item);
    case "payment":
      return handlePayment(principal, item);
    case "complaint":
      return handleComplaint(principal, item);
    case "sample":
      return handleSample(principal, item);
    case "lead":
      return handleLead(principal, item);
    case "task":
      return handleTask(principal, item);
    case "expense":
      return handleExpense(principal, item);
    case "attendance":
      return handleAttendance(principal, item);
    case "customer":
      return handleCustomerEdit(principal, item);
    case "leave":
      return handleLeave(principal, item);
    case "tour":
      return handleTour(principal, item);
    case "competitor":
      return handleCompetitor(principal, item);
    case "approval":
      return handleApproval(principal, item);
    case "plan_day":
      return handlePlanDay(principal, item);
    case "plan_stops":
      return handlePlanStops(principal, item);
    default:
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `MahekOne does not know how to save a "${String(type)}". Nothing was written — this is a bug to report rather than something to retry.`,
        ),
      };
  }
}

/* -------------------------------------------------- the customer, in scope */

type ScopedCustomer = {
  id: string;
  name: string;
  creditBlocked: boolean;
  creditBlockReason: string | null;
  creditLimitPaise: number | null;
  outstanding: number;
  gpsLat: number | null;
  gpsLng: number | null;
  updatedAt: Date;
};

/**
 * A customer this principal may write against, or a rejection saying which of
 * the two things went wrong. "Not in your territory" and "does not exist" are
 * different sentences, but they are the same ANSWER — neither confirms to a
 * handset that a customer it cannot see is real.
 */
async function scopedCustomer(
  principal: MbosPrincipal,
  customerId: unknown,
): Promise<{ ok: true; customer: ScopedCustomer } | { ok: false; value: Rejection }> {
  if (typeof customerId !== "string" || !customerId) {
    return {
      ok: false,
      value: reject("validation", "This record does not name a customer, so it cannot be saved."),
    };
  }

  const ids = principal.scope.kind === "all" ? null : principal.scope.userIds;
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      creditBlocked: customers.creditBlocked,
      creditBlockReason: customers.creditBlockReason,
      creditLimitPaise: customers.creditLimitPaise,
      outstanding: customers.outstanding,
      gpsLat: customers.gpsLat,
      gpsLng: customers.gpsLng,
      updatedAt: customers.updatedAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  const customer = rows[0];
  if (!customer) {
    return {
      ok: false,
      value: reject(
        "validation",
        "That customer is not on MahekOne. Raise them as a lead and convert it, rather than ordering against a record that does not exist.",
      ),
    };
  }

  if (ids) {
    const [assigned] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          // The ONE definition of whose book a customer is in. Written out
          // here would be a second one, and the two would disagree the first
          // time either changed.
          scopedToUsers(ids),
        ),
      );
    if (Number(assigned?.n ?? 0) === 0) {
      return {
        ok: false,
        value: reject(
          "not_permitted",
          `${customer.name} is not in your territory, so this cannot be saved against them. Ask your manager to reassign the account if it should be.`,
        ),
      };
    }
  }

  return { ok: true, customer: customer as ScopedCustomer };
}

/* ------------------------------------------------------------------ visits */

const visitSchema = z.object({
  customerId: z.string(),
  checkInAt: z.number().nullish(),
  checkOutAt: z.number().nullish(),
  checkInLat: z.number().nullish(),
  checkInLng: z.number().nullish(),
  checkInAccuracyM: z.number().int().nullish(),
  checkOutLat: z.number().nullish(),
  checkOutLng: z.number().nullish(),
  checkOutAccuracyM: z.number().int().nullish(),
  durationSeconds: z.number().int().nullish(),
  outcome: z
    .enum(["visited", "order", "payment", "complaint", "sample", "not_available", "closed"])
    .default("visited"),
  notes: z.string().max(4000).nullish(),
  transcript: z.string().max(20000).nullish(),
  transcriptIsAi: z.boolean().nullish(),
  shopPhotoId: z.string().nullish(),
  custPhotoId: z.string().nullish(),
  voiceNoteId: z.string().nullish(),
  journeyPlanStopId: z.string().nullish(),
  wasPlanned: z.boolean().nullish(),
  deviationReason: z.string().max(500).nullish(),
  nextFollowUpDate: z.string().nullish(),
});

async function handleVisit(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = visitSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  const config = await getConfig();

  /* Verification is recorded, never enforced. A check-in 400 metres from the
   * shop's pin is not proof of anything — the pin may be wrong, the fix may be
   * poor, the shop may have moved — so the visit is saved with the mismatch
   * and a reason beside it. Refusing loses a real visit; accepting silently
   * makes every visit worth the same, which is worse. */
  let verified = false;
  let locationMismatch = false;
  let unverifiedReason: string | null = null;
  /* Kept whatever the outcome — a manager screen used to have nowhere to
   * read this number, only the sentence it got folded into for a mismatch,
   * and never at all for a visit that verified cleanly. */
  let distanceFromShopM: number | null = null;

  const accuracy = p.checkInAccuracyM ?? null;
  if (p.checkInLat == null || p.checkInLng == null) {
    unverifiedReason = "No location was captured with this check-in.";
  } else if (accuracy != null && accuracy > config["mbos.location.gpsAccuracyThresholdM"]) {
    unverifiedReason = `The handset rated its own fix at ${accuracy} m, which is worse than the ${config["mbos.location.gpsAccuracyThresholdM"]} m needed to prove where anybody was standing.`;
  } else if (customer.gpsLat == null || customer.gpsLng == null) {
    unverifiedReason = `${customer.name} has no shop pin on MahekOne yet, so there is nothing to check the check-in against.`;
  } else {
    const distance = metresBetween(
      p.checkInLat,
      p.checkInLng,
      customer.gpsLat,
      customer.gpsLng,
    );
    distanceFromShopM = Math.round(distance);
    if (distance > config["mbos.location.visitMismatchM"]) {
      locationMismatch = true;
      unverifiedReason = `The check-in was ${Math.round(distance)} m from ${customer.name}'s own pin.`;
    } else {
      verified = true;
    }
  }

  const checkInAt = p.checkInAt ? new Date(p.checkInAt) : new Date(item.clientCreatedAt);
  /*
   * A PARAMETER IS A STRING, NOT A DATE — the same rule as the order handler
   * below, and the visit is where it costs most. The two raw statements that
   * bind this are the derived `last_visit_date` and the journey stop, so every
   * visit came back as a RETRY: the outbox resends for ever, and because a
   * visit is the DEPENDENCY of the order and the payment taken on it, the
   * whole of a salesman's day stayed on the handset behind it.
   */
  const checkInAtIso = checkInAt.toISOString();
  const checkOutAt = p.checkOutAt ? new Date(p.checkOutAt) : null;

  await db.transaction(async (tx) => {
    await tx
      .insert(mbosVisits)
      .values({
        id: item.entityId,
        customerId: customer.id,
        salesmanId: principal.user.id,
        checkInLat: p.checkInLat ?? null,
        checkInLng: p.checkInLng ?? null,
        checkInAccuracyM: p.checkInAccuracyM ?? null,
        checkInAt,
        checkOutLat: p.checkOutLat ?? null,
        checkOutLng: p.checkOutLng ?? null,
        checkOutAccuracyM: p.checkOutAccuracyM ?? null,
        checkOutAt,
        durationSeconds:
          p.durationSeconds ??
          (checkOutAt ? Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 1000) : null),
        shopPhotoId: p.shopPhotoId ?? null,
        custPhotoId: p.custPhotoId ?? null,
        voiceNoteId: p.voiceNoteId ?? null,
        transcript: p.transcript ?? null,
        transcriptIsAi: p.transcriptIsAi ?? false,
        outcome: p.outcome,
        notes: p.notes ?? null,
        nextFollowUpDate: p.nextFollowUpDate ?? null,
        journeyPlanStopId: p.journeyPlanStopId ?? null,
        wasPlanned: p.wasPlanned ?? false,
        deviationReason: p.deviationReason ?? null,
        locationMismatch,
        verified,
        unverifiedReason,
        distanceFromShopM,
        clientCreatedAt: new Date(item.clientCreatedAt),
        createdById: principal.user.id,
        updatedById: principal.user.id,
        deviceId: principal.deviceId,
      })
      .onConflictDoNothing({ target: mbosVisits.id });

    await writeTimeline(tx, {
      customerId: customer.id,
      eventType: "visit",
      sourceRecordId: item.entityId,
      occurredAt: checkInAt,
      actorUserId: principal.user.id,
      summary: `Visited ${customer.name}${p.notes ? ` — ${p.notes.slice(0, 160)}` : ""}`,
    });

    // A derived cache, rebuilt from the visits rather than typed: the latest
    // check-in wins, and an out-of-order sync cannot move it backwards.
    await tx.execute(sql`
      update customers
         set last_visit_date = greatest(
               coalesce(last_visit_date, date '1900-01-01'),
               (${checkInAtIso}::timestamptz at time zone 'Asia/Kolkata')::date
             ),
             updated_at = now()
       where id = ${customer.id}
    `);

    if (p.journeyPlanStopId) {
      await tx.execute(sql`
        update mbos_journey_stops
           set status = 'visited', actual_visit_at = ${checkInAtIso}, updated_at = now()
         where id = ${p.journeyPlanStopId}
      `);
    }
  });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------------------ orders */

const orderSchema = z.object({
  customerId: z.string(),
  orderedAt: z.number().nullish(),
  lines: z
    .array(
      z.object({
        productId: z.string(),
        /** CANS, like every other quantity in MahekOne. */
        quantityCans: z.number().int().positive(),
        ratePaise: z.number().int().nonnegative().nullish(),
      }),
    )
    .min(1),
  totalAmountPaise: z.number().int().nonnegative(),
  creditDays: z.number().int().nullish(),
  expectedDispatch: z.string().nullish(),
  /** What the handset believed the customer owed when it took the order. */
  outstandingAsOfPaise: z.number().int().nullish(),
  outstandingAsOf: z.number().nullish(),
  /** The price tag the lines were priced against, where they were priced. */
  priceTag: z.string().nullish(),
  visitId: z.string().nullish(),
  /**
   * Where the goods go, when that is not where the bill goes.
   *
   * `customerId` above is who we INVOICE and stays the account every figure is
   * read from — credit, term, outstanding, the queue. This is the shop the
   * lorry stops at, and on a third-party account the two differ.
   *
   * Nullish, so every handset built before this sends nothing and means what
   * it has always meant: the billing party received them.
   */
  deliveryCustomerId: z.string().nullish(),
});

async function handleOrder(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = orderSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  /*
   * The BILLING party, and it is scope-checked. Whose credit limit, term and
   * outstanding this order is judged against is this account, so a salesman
   * may only bill somebody in his own book.
   */
  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;
  const config = await getConfig();

  /*
   * The delivery party, which is NOT scope-checked and must not be.
   *
   * It is an address on somebody else's order — the shop a distributor's goods
   * go to — and it routinely sits in another salesman's book or in nobody's.
   * Refusing it on scope would make the ordinary third-party case
   * unrecordable, which is the state this field exists to end. Nothing about
   * it moves money and no figure on this order is read from it.
   *
   * Naming the biller here is folded to null rather than refused: two
   * spellings of "they received it themselves" must not both reach the column.
   */
  let deliveryCustomerId: string | null = null;
  if (p.deliveryCustomerId && p.deliveryCustomerId !== customer.id) {
    const [shop] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, p.deliveryCustomerId));
    if (!shop) {
      return {
        kind: "rejected",
        value: reject(
          "delivery_party_unknown",
          "The shop this was to be delivered to is not on MahekOne any more. Sync and take the order again.",
        ),
      };
    }
    deliveryCustomerId = shop.id;
  }

  /* The same id arriving under a different idempotency key is a create the
   * handset changed and resent, not a retry. Accepting it would put a second
   * order in the book under one id. */
  const existing = await db
    .select({ id: orders.id, orderNo: orders.orderNo })
    .from(orders)
    .where(eq(orders.id, item.entityId))
    .limit(1);
  if (existing.length) {
    return {
      kind: "rejected",
      value: reject(
        "duplicate",
        `This order has already been recorded for ${customer.name}${
          existing[0].orderNo ? ` as ${existing[0].orderNo}` : ""
        }. Nothing was written twice.`,
      ),
    };
  }

  /* --- credit block. A DECISION accounts made, not a derivation. --- */
  if (customer.creditBlocked) {
    return {
      kind: "rejected",
      value: reject(
        "credit_blocked",
        `${customer.name} is credit-blocked${
          customer.creditBlockReason ? `: ${customer.creditBlockReason}` : ""
        }. The order was not accepted — ring accounts before promising anything.`,
      ),
    };
  }

  /* --- the products. A discontinued SKU cannot go on an order. --- */
  const productIds = [...new Set(p.lines.map((l) => l.productId))];
  const productRows = await db
    .select({
      id: products.id,
      name: products.name,
      active: products.active,
      status: products.status,
    })
    .from(products)
    .where(inArray(products.id, productIds));

  const byId = new Map(productRows.map((r) => [r.id, r]));
  for (const id of productIds) {
    const product = byId.get(id);
    if (!product) {
      return {
        kind: "rejected",
        value: reject(
          "product_inactive",
          `A product on this order for ${customer.name} is no longer in the catalogue. Ring the shop and take the order again with what we stock.`,
        ),
      };
    }
    if (!product.active || product.status !== "ok") {
      return {
        kind: "rejected",
        value: reject(
          "product_inactive",
          `${product.name} has been discontinued, so the order for ${customer.name} was not accepted. Ring the shop and offer a replacement.`,
        ),
      };
    }
  }

  /* --- minimum quantity, which is configuration and not a constant. --- */
  const minimum = config["mbos.orders.minimumQuantityCans"];
  if (minimum > 0) {
    const short = p.lines.find((l) => l.quantityCans < minimum);
    if (short) {
      const product = byId.get(short.productId);
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `${product?.name ?? "A line"} on ${customer.name}'s order is ${short.quantityCans} cans, below the ${minimum}-can minimum. Take the order again at or above it.`,
        ),
      };
    }
  }

  /* --- the price the handset quoted, against the price list today. --- */
  if (p.priceTag) {
    const day = await today();
    const priced = await db.execute<{ productId: string; ratePaise: string }>(sql`
      select distinct on (product_id)
             product_id as "productId", rate_paise as "ratePaise"
        from mbos_price_list
       where customer_price_tag = ${p.priceTag}
         and product_id in ${sql`(${sql.join(productIds.map((i) => sql`${i}`), sql`, `)})`}
         and (valid_from is null or valid_from <= ${day}::date)
         and (valid_to is null or valid_to >= ${day}::date)
       order by product_id, valid_from desc nulls last
    `);
    const rates = new Map(priced.map((r) => [r.productId, Number(r.ratePaise)]));
    for (const line of p.lines) {
      const current = rates.get(line.productId);
      if (line.ratePaise != null && current != null && current !== line.ratePaise) {
        const product = byId.get(line.productId);
        return {
          kind: "rejected",
          value: reject(
            "price_changed",
            `${product?.name ?? "A product"} is now ${rupees(current)} a can on the ${p.priceTag} list, not the ${rupees(line.ratePaise)} quoted to ${customer.name}. Confirm the new rate with the shop and take the order again.`,
          ),
        };
      }
    }
  }

  /* --- the credit limit, against what they owe NOW rather than what the
   * handset last saw. This is the whole reason the check is repeated here. --- */
  if (config["mbos.credit.blockOnLimitExceeded"] && customer.creditLimitPaise != null) {
    const projected = customer.outstanding + p.totalAmountPaise;
    if (projected > customer.creditLimitPaise) {
      /* If the handset priced its own decision on an outstanding figure that
       * has since moved, say THAT — "the limit moved under you" and "you went
       * over the limit" send the salesman to two different people. */
      const staleHours = config["mbos.credit.outstandingStaleHours"];
      const snapshotAgeHours =
        p.outstandingAsOf != null
          ? (Date.now() - p.outstandingAsOf) / 3_600_000
          : null;
      const clientBelieved = p.outstandingAsOfPaise;

      if (
        clientBelieved != null &&
        clientBelieved !== customer.outstanding &&
        (snapshotAgeHours == null || snapshotAgeHours > staleHours)
      ) {
        return {
          kind: "rejected",
          value: reject(
            "outstanding_stale",
            `${customer.name} owed ${rupees(clientBelieved)} on your handset but owes ${rupees(customer.outstanding)} today, which puts this order over their ${rupees(customer.creditLimitPaise)} limit. Sync and check the balance with them before taking it again.`,
          ),
        };
      }

      return {
        kind: "rejected",
        value: reject(
          "credit_exceeded",
          `${customer.name} owes ${rupees(customer.outstanding)} and this order of ${rupees(p.totalAmountPaise)} would take them past their ${rupees(customer.creditLimitPaise)} limit. Collect against the old bills or ask accounts to raise the limit.`,
        ),
      };
    }
  }

  /* --- accepted. The number comes from the series, in the transaction. --- */
  const orderedAt = p.orderedAt ? new Date(p.orderedAt) : new Date(item.clientCreatedAt);
  /*
   * A PARAMETER IS A STRING, NOT A DATE.
   *
   * `postgres` serialises a JS Date by asking Node to measure it as text, and
   * on Node 25 that throws — inside the driver, where no type check sees it.
   * The two `update customers` statements below both bind this, so every field
   * order failed with `Failed query: update customers set last_order_date …`
   * and came back as a RETRY: the outbox would resend it for ever and the
   * salesman's order would never land, with nothing on either end naming the
   * cause. It is the same bug the pull delta had, and the rule outlives both.
   *
   * An ISO instant carries its own zone, so this is not the bare-cast rule in
   * different clothes — the SQL still names Asia/Kolkata for the DATE it
   * truncates to.
   */
  const orderedAtIso = orderedAt.toISOString();
  const day = await today();
  const fy = financialYearOf(day);
  const prefix = seriesPrefix(config["mbos.orders.numberSeriesPrefix"], "MBOS");

  /* `OrderLine` is the shape the rest of MahekOne reads, with `productId`
   * carried alongside it: external order lines match back to the catalogue by
   * NAME, and a field order that knows the id should not throw it away. Where
   * the handset quoted no rate the line is worth nothing on its own and the
   * order's total — what the salesman typed — is what stands, because
   * `products.priceSource` is still `unset` and nothing here may invent a
   * price to make the arithmetic look tidy. */
  const lines: Array<OrderLine & { productId: string }> = p.lines.map((l) => ({
    product: byId.get(l.productId)?.name ?? l.productId,
    productId: l.productId,
    quantity: l.quantityCans,
    unitPrice: l.ratePaise ?? 0,
    amount: (l.ratePaise ?? 0) * l.quantityCans,
  }));

  let serverNumber = "";
  await db.transaction(async (tx) => {
    serverNumber = await allocateNumber(tx, prefix, fy, "orders");

    await tx.insert(orders).values({
      id: item.entityId,
      customerId: customer.id,
      // Null where the billing party received them, which is every field order
      // taken before the handset learned to ask.
      deliveryCustomerId,
      userId: principal.user.id,
      // A field order is its own source. `external` means the external ORDER
      // SYSTEM the office types into and `crm` means a telecaller took it;
      // reading either of those off a report would be reading a lie.
      source: "mbos",
      orderNo: serverNumber,
      // `external_ref` carries the same string because two existing readers
      // want it there: the bill detail screen resolves an order number from
      // it, and the accounts payment-capture search matches customers on it.
      externalRef: serverNumber,
      // An order taken in a shop is the customer saying yes, not the business.
      // Accounts check who they are and what they already owe.
      status: "pending_approval",
      orderedAt,
      totalAmount: p.totalAmountPaise,
      creditDays: p.creditDays ?? null,
      expectedDispatch: p.expectedDispatch ?? null,
      lineItems: lines,
      createdById: principal.user.id,
      updatedById: principal.user.id,
    });

    // `lastOrderDate` moves on CAPTURE, not on approval: it is the signal that
    // stops the queue chasing somebody who ordered this morning, and a
    // telecaller must not ring them because approval is slow.
    await tx.execute(sql`
      update customers
         set last_order_date = greatest(
               coalesce(last_order_date, date '1900-01-01'),
               (${orderedAtIso}::timestamptz at time zone 'Asia/Kolkata')::date
             ),
             last_order_value = ${p.totalAmountPaise},
             updated_at = now()
       where id = ${customer.id}
    `);

    /*
     * The shop it was DELIVERED to stops being chased as well.
     *
     * Being served is being served, whoever was invoiced — ringing a shop to
     * ask for an order the day after a lorry unloaded there is the call this
     * prevents. Only the DATE moves: `last_order_value` stays with the biller,
     * and so do the cycle, the targets, the outstanding and the product
     * history, all of which read `orders.customer_id`. The shop's own buying
     * cycle is still built from what the shop itself bought.
     */
    if (deliveryCustomerId) {
      await tx.execute(sql`
        update customers
           set last_order_date = greatest(
                 coalesce(last_order_date, date '1900-01-01'),
                 (${orderedAtIso}::timestamptz at time zone 'Asia/Kolkata')::date
               ),
               updated_at = now()
         where id = ${deliveryCustomerId}
      `);
    }

    await writeTimeline(tx, {
      customerId: customer.id,
      eventType: "order",
      sourceRecordId: item.entityId,
      occurredAt: orderedAt,
      actorUserId: principal.user.id,
      summary: `Order ${serverNumber} taken in the field — ${rupees(p.totalAmountPaise)}, awaiting approval`,
    });

    if (p.visitId) {
      await tx.execute(sql`
        update mbos_visits set linked_order_id = ${item.entityId}, updated_at = now()
         where id = ${p.visitId}
      `);
    }
  });

  return { kind: "accepted", value: { serverId: item.entityId, serverNumber } };
}

/* ---------------------------------------------------------------- payments */

const paymentSchema = z.object({
  customerId: z.string(),
  amountPaise: z.number().int().positive(),
  receivedAt: z.string().nullish(),
  mode: z.string().max(60).nullish(),
  reference: z.string().max(120).nullish(),
  note: z.string().max(2000).nullish(),
  /** Named bills, or nothing — in which case the money goes oldest first. */
  billIds: z.array(z.string()).nullish(),
  visitId: z.string().nullish(),
});

const paymentUpdateSchema = z.object({
  /** Cash paid into the bank, with the slip photographed. */
  deposited: z.boolean().nullish(),
  depositedAt: z.number().nullish(),
  depositProofId: z.string().nullish(),
  /** The cheque came back. */
  bounced: z.boolean().nullish(),
  bouncedAt: z.number().nullish(),
});

/**
 * The two things that happen to money after it is collected.
 *
 * Neither of them moves a figure, and that is the point of them being here
 * rather than anywhere near `applyToLedger`. A deposit is the salesman saying
 * he banked the cash; the money still counts for nothing until accounts find
 * it on the statement and confirm it, which is the second half of the answer
 * and the office's to give.
 *
 * A bounce is the same shape in reverse. On a receipt still `reported` there
 * is nothing to unwind — it never counted — so what the handset is doing is
 * TELLING somebody, and the note plus the notification is the whole of it. On
 * one accounts had already confirmed, reversing is their decision and their
 * capability: taking money off an account is the same kind of act as putting
 * it on, and a handset does not get to do it from a market.
 */
async function handlePaymentUpdate(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = paymentUpdateSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const [receipt] = await db
    .select({
      id: paymentReceipts.id,
      status: paymentReceipts.status,
      amount: paymentReceipts.amount,
      note: paymentReceipts.note,
      customerId: paymentReceipts.customerId,
    })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, item.entityId))
    .limit(1);

  if (!receipt) {
    return {
      kind: "retry",
      message:
        "That collection has not reached the office yet, so there is nothing to change. It will be tried again once it has.",
    };
  }

  const changed: Partial<typeof paymentReceipts.$inferInsert> = {
    updatedAt: new Date(),
    updatedById: principal.user.id,
  };

  if (p.deposited) {
    changed.depositedAt = new Date(p.depositedAt ?? Date.now());
    changed.depositedById = principal.user.id;
    if (p.depositProofId) changed.depositProofId = p.depositProofId;
  }

  if (p.bounced) {
    const said = `Cheque returned unpaid, reported from the field on ${
      await today()
    }.`;
    changed.note = receipt.note ? `${receipt.note}\n${said}` : said;

    const [customer] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, receipt.customerId))
      .limit(1);

    await notifyManagers(
      principal.user.id,
      "A cheque has bounced",
      `${customer?.name ?? "A customer"}'s cheque for ${rupees(receipt.amount)} came back unpaid.${
        receipt.status === "confirmed"
          ? " This receipt was already confirmed, so accounts have to reverse it — it is still counting against their balance until they do."
          : " It had not been confirmed, so nothing was counting; no reversal is needed."
      }`,
    );
  }

  await db
    .update(paymentReceipts)
    .set(changed)
    .where(eq(paymentReceipts.id, item.entityId));

  return { kind: "accepted", value: { serverId: item.entityId } };
}

async function handlePayment(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  if (item.op === "update") return handlePaymentUpdate(principal, item);

  const parsed = paymentSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  const already = await db
    .select({ id: paymentReceipts.id })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.id, item.entityId))
    .limit(1);
  if (already.length) {
    return {
      kind: "rejected",
      value: reject(
        "duplicate",
        `This receipt from ${customer.name} has already been recorded. Nothing was written twice — check the customer's statement rather than collecting again.`,
      ),
    };
  }

  const openBills = await db
    .select({
      id: bills.id,
      billNo: bills.billNo,
      billDate: bills.billDate,
      amount: bills.amount,
      paid: bills.paidAmount,
    })
    .from(bills)
    .where(eq(bills.customerId, customer.id));

  const allocatable: AllocatableBill[] = openBills.map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    amount: Number(b.amount),
    paid: Number(b.paid),
  }));

  /* A bill the handset named that has since been settled is a rejection with
   * its own code: the money is real, but where it was going no longer exists,
   * and silently re-allocating it is not a decision code should take. */
  if (p.billIds?.length) {
    const byId = new Map(allocatable.map((b) => [b.id, b]));
    for (const billId of p.billIds) {
      const bill = byId.get(billId);
      if (!bill) {
        return {
          kind: "rejected",
          value: reject(
            "bill_settled",
            `A bill this payment from ${customer.name} was against is no longer on their account. Re-enter the receipt against the bills that are open.`,
          ),
        };
      }
      if (bill.amount - bill.paid <= 0) {
        return {
          kind: "rejected",
          value: reject(
            "bill_settled",
            `Bill ${bill.billNo} has already been settled, so ${rupees(p.amountPaise)} from ${customer.name} was not applied to it. Record it against their open bills instead.`,
          ),
        };
      }
    }
  }

  const allocation = allocate(allocatable, {
    amount: p.amountPaise,
    mode: p.billIds?.length ? "settle" : "auto",
    selectedBillIds: p.billIds ?? undefined,
  });

  const day = await today();
  const receivedAt = p.receivedAt ?? day;
  const config = await getConfig();
  const fy = financialYearOf(day);
  const prefix = seriesPrefix(config["mbos.payments.receiptSeriesPrefix"], "MRCP");

  let serverNumber = "";
  await db.transaction(async (tx) => {
    serverNumber = await allocateNumber(tx, prefix, fy, "payments");

    await tx.insert(paymentReceipts).values({
      id: item.entityId,
      customerId: customer.id,
      amount: p.amountPaise,
      receivedAt,
      mode: p.mode ?? "Cash",
      reference: p.reference ?? null,
      receiptNo: serverNumber,
      // The note is the salesman's own sentence and nothing else. The receipt
      // number used to be prefixed onto it for want of a column; it has one.
      note: p.note ?? null,
      // Money the customer says has arrived is not money the business has
      // seen. It sits at `reported` and moves nothing in the ledger until
      // accounts find it in the bank.
      status: "reported",
      source: "mbos",
      reportedById: principal.user.id,
      idempotencyKey: item.idempotencyKey,
      createdById: principal.user.id,
      updatedById: principal.user.id,
    });

    for (const line of allocation.lines) {
      await tx.insert(payments).values({
        id: gen("pay"),
        receiptId: item.entityId,
        billId: line.billId,
        customerId: customer.id,
        amount: line.amount,
        paidAt: receivedAt,
        mode: p.mode ?? "Cash",
        reference: p.reference ?? null,
        externalRef: serverNumber,
        recordedById: principal.user.id,
        createdById: principal.user.id,
      });
    }

    // A remainder becomes money on account rather than being refused at the
    // door: refusing it is how a receipt gets recorded for the wrong amount to
    // make the screen accept it.
    if (allocation.onAccount > 0) {
      await tx.insert(payments).values({
        id: gen("pay"),
        receiptId: item.entityId,
        billId: null,
        customerId: customer.id,
        amount: allocation.onAccount,
        paidAt: receivedAt,
        mode: p.mode ?? "Cash",
        reference: p.reference ?? null,
        externalRef: serverNumber,
        recordedById: principal.user.id,
        createdById: principal.user.id,
      });
    }

    await writeTimeline(tx, {
      customerId: customer.id,
      eventType: "payment",
      sourceRecordId: item.entityId,
      occurredAt: new Date(item.clientCreatedAt),
      actorUserId: principal.user.id,
      summary: `${rupees(p.amountPaise)} collected in the field, receipt ${serverNumber} — reported, awaiting confirmation by accounts`,
    });

    if (p.visitId) {
      await tx.execute(sql`
        update mbos_visits set linked_payment_id = ${item.entityId}, updated_at = now()
         where id = ${p.visitId}
      `);
    }
  });

  // A large collection is something a manager is told about rather than
  // something they have to go looking for.
  if (p.amountPaise >= config["mbos.payments.managerNotifyThresholdPaise"]) {
    await notifyManagers(
      principal.user.id,
      "Field collection",
      `${principal.user.name} recorded ${rupees(p.amountPaise)} from ${customer.name} (receipt ${serverNumber}). It is reported, not confirmed.`,
    );
  }

  return { kind: "accepted", value: { serverId: item.entityId, serverNumber } };
}

/* -------------------------------------------------------------- complaints */

const complaintSchema = z.object({
  customerId: z.string(),
  category: z.enum([
    "product_quality",
    "packaging_damage",
    "dispatch_delay",
    "billing_issue",
    "delivery",
    "pricing",
    "service",
    "shortage",
    "other",
  ]),
  description: z.string().min(1).max(4000),
  severity: z.enum(["low", "medium", "high"]).nullish(),
  mobileNumber: z.string().max(20).nullish(),
  requestCn: z.boolean().nullish(),
  visitId: z.string().nullish(),
});

async function handleComplaint(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = complaintSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  const config = await getConfig();
  const severity = p.severity ?? config["complaints.defaultSeverity"];
  const slaHours = config["complaints.slaHours"][severity];
  const occurredAt = new Date(item.clientCreatedAt);

  await db.transaction(async (tx) => {
    await tx
      .insert(complaints)
      .values({
        id: item.entityId,
        customerId: customer.id,
        loggedByUserId: principal.user.id,
        category: p.category,
        description: p.description,
        severity,
        // A credit-note amount without a request reads as an approved figure
        // to whoever opens it next, so the field app answers the yes/no and
        // nothing more. Which bill and how much is accounts' work.
        requestCn: p.requestCn ?? false,
        cnStatus: p.requestCn ? "requested" : null,
        mobileNumber: p.mobileNumber ?? null,
        slaDueAt: new Date(occurredAt.getTime() + slaHours * 3_600_000),
        createdById: principal.user.id,
        updatedById: principal.user.id,
      })
      .onConflictDoNothing({ target: complaints.id });

    await writeTimeline(tx, {
      customerId: customer.id,
      eventType: "complaint",
      sourceRecordId: item.entityId,
      occurredAt,
      actorUserId: principal.user.id,
      summary: `Complaint raised in the field — ${p.description.slice(0, 160)}`,
    });

    if (p.visitId) {
      await tx.execute(sql`
        update mbos_visits set linked_complaint_id = ${item.entityId}, updated_at = now()
         where id = ${p.visitId}
      `);
    }
  });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ----------------------------------------------------------------- samples */

const sampleSchema = z.object({
  customerId: z.string(),
  productId: z.string().nullish(),
  quantityCans: z.number().int().positive().nullish(),
  requestedDate: z.string().nullish(),
  deliveredAt: z.number().nullish(),
  deliveryPhotoId: z.string().nullish(),
  followUpDate: z.string().nullish(),
  feedbackNotes: z.string().max(2000).nullish(),
  visitId: z.string().nullish(),
});

async function handleSample(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = sampleSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  if (p.productId) {
    const [product] = await db
      .select({ name: products.name, active: products.active, status: products.status })
      .from(products)
      .where(eq(products.id, p.productId))
      .limit(1);
    if (!product || !product.active || product.status !== "ok") {
      return {
        kind: "rejected",
        value: reject(
          "product_inactive",
          `The product sampled to ${customer.name} is no longer in the catalogue, so the handover was not recorded. Log it against a product we still stock.`,
        ),
      };
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(mbosSamples)
      .values({
        id: item.entityId,
        customerId: customer.id,
        salesmanId: principal.user.id,
        productId: p.productId ?? null,
        quantityCans: p.quantityCans ?? null,
        requestedDate: p.requestedDate ?? null,
        deliveredAt: p.deliveredAt ? new Date(p.deliveredAt) : null,
        deliveryPhotoId: p.deliveryPhotoId ?? null,
        followUpDate: p.followUpDate ?? null,
        feedbackNotes: p.feedbackNotes ?? null,
        clientCreatedAt: new Date(item.clientCreatedAt),
        createdById: principal.user.id,
        updatedById: principal.user.id,
        deviceId: principal.deviceId,
      })
      .onConflictDoNothing({ target: mbosSamples.id });

    await writeTimeline(tx, {
      customerId: customer.id,
      eventType: "sample",
      sourceRecordId: item.entityId,
      occurredAt: new Date(item.clientCreatedAt),
      actorUserId: principal.user.id,
      summary: `Sample handed to ${customer.name}${p.quantityCans ? ` — ${p.quantityCans} cans` : ""}`,
    });

    if (p.visitId) {
      await tx.execute(sql`
        update mbos_visits set linked_sample_id = ${item.entityId}, updated_at = now()
         where id = ${p.visitId}
      `);
    }
  });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------------------- leads */

const leadSchema = z.object({
  name: z.string().min(1).max(200),
  companyName: z.string().max(200).nullish(),
  mobile: z.string().min(6).max(20),
  city: z.string().max(120).nullish(),
  area: z.string().max(120).nullish(),
  source: z
    .enum(["manual", "website", "referral", "exhibition", "cold_call", "whatsapp", "campaign"])
    .nullish(),
  estimatedPotentialPaise: z.number().int().nonnegative().nullish(),
  stage: z.enum(["new", "contacted", "qualified", "negotiation", "won", "lost"]).nullish(),
  nextFollowUpDate: z.string().nullish(),
  notes: z.string().max(4000).nullish(),
  gpsLat: z.number().nullish(),
  gpsLng: z.number().nullish(),
  lostReason: z.string().max(500).nullish(),
  /** Out of the way, not gone — a filter on every read, never a delete. */
  archived: z.boolean().nullish(),
  /** The shop this lead became, so the two records stay joined up. */
  convertedCustomerId: z.string().nullish(),
});

/**
 * Moving a lead along: a stage, a note, a follow-up date, an archive.
 *
 * Partial like every other update — see `handleTaskUpdate`. The name and the
 * mobile are required to CREATE a lead and are not resent to change its stage,
 * so the create schema refused all five of the handset's edits.
 */
async function handleLeadUpdate(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = leadSchema.partial().safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const [existing] = await db
    .select({ id: mbosLeads.id, name: mbosLeads.name })
    .from(mbosLeads)
    .where(eq(mbosLeads.id, item.entityId))
    .limit(1);

  if (!existing) {
    return {
      kind: "retry",
      message:
        "That lead has not reached the office yet, so there is nothing to change. It will be tried again once it has.",
    };
  }

  if (p.stage === "lost" && !p.lostReason) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${existing.name} was marked lost with no reason. A loss nobody explained teaches nothing — reopen it and say what happened.`,
      ),
    };
  }

  const changed: Partial<typeof mbosLeads.$inferInsert> = {
    /* Any edit is contact, and staleness is measured from the last thing that
     * happened — so working a lead moves the clock whatever else it changed. */
    lastActivityDate: await today(),
    updatedAt: new Date(),
    updatedById: principal.user.id,
  };
  if (p.name != null) changed.name = p.name;
  if (p.companyName != null) changed.companyName = p.companyName;
  if (p.mobile != null) changed.mobile = p.mobile;
  if (p.city != null) changed.city = p.city;
  if (p.area != null) changed.area = p.area;
  if (p.stage != null) changed.stage = p.stage;
  if (p.nextFollowUpDate != null) changed.nextFollowUpDate = p.nextFollowUpDate;
  if (p.notes != null) changed.notes = p.notes;
  if (p.estimatedPotentialPaise != null) {
    changed.estimatedPotentialPaise = p.estimatedPotentialPaise;
  }
  if (p.lostReason != null) changed.lostReason = p.lostReason;
  if (p.archived != null) changed.archived = p.archived;
  if (p.convertedCustomerId != null) {
    changed.convertedCustomerId = p.convertedCustomerId;
    changed.convertedAt = new Date();
  }

  await db.update(mbosLeads).set(changed).where(eq(mbosLeads.id, item.entityId));

  return { kind: "accepted", value: { serverId: item.entityId } };
}

async function handleLead(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  if (item.op === "update") return handleLeadUpdate(principal, item);

  const parsed = leadSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  if (p.stage === "lost" && !p.lostReason) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${p.name} was marked lost with no reason. A loss nobody explained teaches nothing — reopen it and say what happened.`,
      ),
    };
  }

  /* The duplicate check runs on the mobile, which is what a business card
   * carries. A second row for one shop is two salesmen working it. */
  if (item.op === "create") {
    const clash = await db
      .select({ id: mbosLeads.id, name: mbosLeads.name })
      .from(mbosLeads)
      .where(and(eq(mbosLeads.mobile, p.mobile), eq(mbosLeads.archived, false)))
      .limit(1);
    if (clash.length && clash[0].id !== item.entityId) {
      return {
        kind: "rejected",
        value: reject(
          "duplicate",
          `${p.mobile} is already on MahekOne as the lead "${clash[0].name}". Work that one rather than raising a second — ask your manager if it is somebody else's.`,
        ),
      };
    }
  }

  const day = await today();
  await db
    .insert(mbosLeads)
    .values({
      id: item.entityId,
      name: p.name,
      companyName: p.companyName ?? null,
      mobile: p.mobile,
      city: p.city ?? null,
      area: p.area ?? null,
      source: p.source ?? "manual",
      estimatedPotentialPaise: p.estimatedPotentialPaise ?? null,
      assignedToUserId: principal.user.id,
      stage: p.stage ?? "new",
      nextFollowUpDate: p.nextFollowUpDate ?? null,
      notes: p.notes ?? null,
      gpsLat: p.gpsLat ?? null,
      gpsLng: p.gpsLng ?? null,
      lostReason: p.lostReason ?? null,
      lastActivityDate: day,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoUpdate({
      target: mbosLeads.id,
      set: {
        name: p.name,
        companyName: p.companyName ?? null,
        mobile: p.mobile,
        city: p.city ?? null,
        area: p.area ?? null,
        stage: p.stage ?? "new",
        nextFollowUpDate: p.nextFollowUpDate ?? null,
        notes: p.notes ?? null,
        lostReason: p.lostReason ?? null,
        lastActivityDate: day,
        updatedAt: new Date(),
        updatedById: principal.user.id,
      },
    });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------------------- tasks */

const taskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullish(),
  customerId: z.string().nullish(),
  priority: z.enum(["low", "medium", "high"]).nullish(),
  dueDate: z.string().nullish(),
  status: z.enum(["open", "in_progress", "done", "cancelled"]).nullish(),
  completionNote: z.string().max(2000).nullish(),
  completionPhotoId: z.string().nullish(),
  snoozedTo: z.string().nullish(),
  snoozeReason: z.string().max(500).nullish(),
});

/**
 * Completing a task, snoozing one, moving its date.
 *
 * An update payload names the id and what CHANGED, and nothing else — which is
 * the shape every edit on the handset has always sent and the shape nothing
 * here could read. Parsed against the create schema, a completion was missing
 * `title` and was refused as invalid: the salesman closed the task, the office
 * never heard, and he was told his own tick had been rejected. Absent means
 * unchanged; the columns nobody named are not touched.
 */
async function handleTaskUpdate(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = taskSchema.partial().safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const [existing] = await db
    .select({ id: mbosTasks.id, title: mbosTasks.title })
    .from(mbosTasks)
    .where(eq(mbosTasks.id, item.entityId))
    .limit(1);

  /* The create is somewhere behind this in the outbox — a retry rather than a
   * refusal, or a tick would be lost for being quicker than the thing it
   * ticked. */
  if (!existing) {
    return {
      kind: "retry",
      message:
        "That task has not reached the office yet, so there is nothing to change. It will be tried again once it has.",
    };
  }

  const config = await getConfig();
  if (p.status === "done" && config["mbos.tasks.requireCompletionNote"] && !p.completionNote) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `"${existing.title}" was closed with nothing said about how. A completion note is required — reopen it and write one line.`,
      ),
    };
  }

  const changed: Partial<typeof mbosTasks.$inferInsert> = {
    updatedAt: new Date(),
    updatedById: principal.user.id,
  };
  if (p.title != null) changed.title = p.title;
  if (p.description != null) changed.description = p.description;
  if (p.priority != null) changed.priority = p.priority;
  if (p.dueDate != null) changed.dueDate = p.dueDate;
  if (p.status != null) {
    changed.status = p.status;
    changed.completedAt = p.status === "done" ? new Date() : null;
  }
  if (p.completionNote != null) changed.completionNote = p.completionNote;
  if (p.completionPhotoId != null) changed.completionPhotoId = p.completionPhotoId;
  if (p.snoozedTo != null) changed.snoozedTo = p.snoozedTo;
  if (p.snoozeReason != null) changed.snoozeReason = p.snoozeReason;

  await db.update(mbosTasks).set(changed).where(eq(mbosTasks.id, item.entityId));

  return { kind: "accepted", value: { serverId: item.entityId } };
}

async function handleTask(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  if (item.op === "update") return handleTaskUpdate(principal, item);

  const parsed = taskSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  if (p.customerId) {
    const found = await scopedCustomer(principal, p.customerId);
    if (!found.ok) return { kind: "rejected", value: found.value };
  }

  const config = await getConfig();
  if (p.status === "done" && config["mbos.tasks.requireCompletionNote"] && !p.completionNote) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `"${p.title}" was closed with nothing said about how. A completion note is required — reopen it and write one line.`,
      ),
    };
  }

  const done = p.status === "done";
  await db
    .insert(mbosTasks)
    .values({
      id: item.entityId,
      title: p.title,
      description: p.description ?? null,
      assignedToUserId: principal.user.id,
      priority: p.priority ?? "medium",
      dueDate: p.dueDate ?? null,
      customerId: p.customerId ?? null,
      status: p.status ?? "open",
      completionNote: p.completionNote ?? null,
      completionPhotoId: p.completionPhotoId ?? null,
      completedAt: done ? new Date() : null,
      snoozedTo: p.snoozedTo ?? null,
      snoozeReason: p.snoozeReason ?? null,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoUpdate({
      target: mbosTasks.id,
      set: {
        title: p.title,
        description: p.description ?? null,
        priority: p.priority ?? "medium",
        dueDate: p.dueDate ?? null,
        status: p.status ?? "open",
        completionNote: p.completionNote ?? null,
        completionPhotoId: p.completionPhotoId ?? null,
        completedAt: done ? new Date() : null,
        snoozedTo: p.snoozedTo ?? null,
        snoozeReason: p.snoozeReason ?? null,
        updatedAt: new Date(),
        updatedById: principal.user.id,
      },
    });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ---------------------------------------------------------------- expenses */

const expenseSchema = z.object({
  category: z.enum(["travel", "food", "lodging", "other"]),
  amountPaise: z.number().int().positive(),
  expenseDate: z.string(),
  description: z.string().max(2000).nullish(),
  billPhotoId: z.string().nullish(),
  claimId: z.string().nullish(),
});

async function handleExpense(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = expenseSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const config = await getConfig();
  const cap = config["mbos.expenses.categoryCapsPaise"][p.category];
  if (cap != null && p.amountPaise > cap) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${rupees(p.amountPaise)} of ${p.category} is over the ${rupees(cap)} daily cap. Split it, or ask your manager to raise the cap before claiming.`,
      ),
    };
  }

  if (p.amountPaise >= config["mbos.expenses.billPhotoThresholdPaise"] && !p.billPhotoId) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `A claim of ${rupees(p.amountPaise)} needs the bill photographed. Attach it and submit again.`,
      ),
    };
  }

  const day = await today();
  const allowed = config["mbos.expenses.backdatedDaysAllowed"];
  const ageDays = Math.floor(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${p.expenseDate}T00:00:00Z`)) / 86_400_000,
  );
  if (Number.isFinite(ageDays) && ageDays > allowed) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `That expense is ${ageDays} days old and claims are accepted up to ${allowed} days back. Ask your manager to enter it for you.`,
      ),
    };
  }

  await db
    .insert(mbosExpenses)
    .values({
      id: item.entityId,
      userId: principal.user.id,
      category: p.category,
      amountPaise: p.amountPaise,
      expenseDate: p.expenseDate,
      remarks: p.description ?? null,
      billPhotoId: p.billPhotoId ?? null,
      claimId: p.claimId ?? null,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoNothing({ target: mbosExpenses.id });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* -------------------------------------------------------------- attendance */

const attendanceSchema = z.object({
  day: z.string(),
  checkInAt: z.number().nullish(),
  checkOutAt: z.number().nullish(),
  checkInLat: z.number().nullish(),
  checkInLng: z.number().nullish(),
  checkInAccuracyM: z.number().nullish(),
  checkOutLat: z.number().nullish(),
  checkOutLng: z.number().nullish(),
  checkOutAccuracyM: z.number().nullish(),
  selfieId: z.string().nullish(),
  notes: z.string().max(1000).nullish(),
  /** Whether the check-in was inside the permitted radius, where one is set. */
  withinGeofence: z.boolean().nullish(),
  geofenceDistanceM: z.number().nullish(),
  /** A correction asked for. The DECISION lives in `mbos_approvals`. */
  regularisationRequested: z.boolean().nullish(),
  regularisationReason: z.string().max(1000).nullish(),
});

async function handleAttendance(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = attendanceSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  /* One row per person per day, and a second check-in reopens the same row
   * rather than becoming a second session — a lunch break is not two days. */
  const existing = await db
    .select({ id: mbosAttendanceDays.id })
    .from(mbosAttendanceDays)
    .where(
      and(eq(mbosAttendanceDays.userId, principal.user.id), eq(mbosAttendanceDays.day, p.day)),
    )
    .limit(1);

  const rowId = existing[0]?.id ?? item.entityId;

  await db
    .insert(mbosAttendanceDays)
    .values({
      id: rowId,
      userId: principal.user.id,
      day: p.day,
      checkInAt: p.checkInAt ? new Date(p.checkInAt) : null,
      checkInLat: p.checkInLat ?? null,
      checkInLng: p.checkInLng ?? null,
      checkInAccuracyM: round(p.checkInAccuracyM),
      checkInSelfieId: p.selfieId ?? null,
      checkOutAt: p.checkOutAt ? new Date(p.checkOutAt) : null,
      checkOutLat: p.checkOutLat ?? null,
      checkOutLng: p.checkOutLng ?? null,
      checkOutAccuracyM: round(p.checkOutAccuracyM),
      withinGeofence: p.withinGeofence ?? null,
      geofenceDistanceM: round(p.geofenceDistanceM),
      regularisationRequested: p.regularisationRequested ?? false,
      regularisationReason: p.regularisationReason ?? null,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoUpdate({
      target: [mbosAttendanceDays.userId, mbosAttendanceDays.day],
      // Only the check-out is written on a second arrival. A later sync must
      // not move the check-in: the mark is the moment the day started, and
      // `workedSeconds` and `status` are derived caches a job rebuilds from
      // the two marks rather than values this may type.
      set: {
        ...(p.checkOutAt ? { checkOutAt: new Date(p.checkOutAt) } : {}),
        ...(p.checkOutLat != null ? { checkOutLat: p.checkOutLat } : {}),
        ...(p.checkOutLng != null ? { checkOutLng: p.checkOutLng } : {}),
        ...(p.checkOutAccuracyM != null
          ? { checkOutAccuracyM: round(p.checkOutAccuracyM) }
          : {}),
        /* A correction asked for after the fact — the reason for a check-in
         * outside the radius, or a day somebody wants changed. It arrives as
         * its own write because the day starts when the button is pressed:
         * asking why first, and losing the check-in if nobody answers, is the
         * block this whole module exists to avoid. */
        ...(p.regularisationRequested != null
          ? { regularisationRequested: p.regularisationRequested }
          : {}),
        ...(p.regularisationReason != null
          ? { regularisationReason: p.regularisationReason }
          : {}),
        updatedAt: new Date(),
        updatedById: principal.user.id,
      },
    });

  return { kind: "accepted", value: { serverId: rowId } };
}

/** GPS accuracy arrives fractional; the columns it lands in are integers. */
function round(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value);
}

/* -------------------------------------------------------------------- leave */

/**
 * The four leave types the schema knows, keyed by every spelling a handset
 * might send one under.
 *
 * The kind arrives as the WORD the salesman saw on the button — "Casual",
 * "Loss of pay" — because the list on that screen is drawn from his own
 * balances rather than from an enum. Normalising here rather than demanding
 * the enum spelling is what lets the balance channel keep sending readable
 * names; an unrecognised one is refused by name rather than filed as
 * something adjacent, because "we recorded your sick leave as casual" is a
 * conversation about somebody's pay.
 */
const LEAVE_TYPES = ["casual", "sick", "earned", "loss_of_pay"] as const;
type LeaveType = (typeof LEAVE_TYPES)[number];

function leaveTypeOf(kind: string): LeaveType | null {
  const key = kind.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const direct = LEAVE_TYPES.find((t) => t === key);
  if (direct) return direct;
  /* "Casual leave", "Sick Leave", "LOP" — the words around the word. */
  if (key.includes("casual")) return "casual";
  if (key.includes("sick")) return "sick";
  if (key.includes("earned") || key.includes("privilege")) return "earned";
  if (key.includes("loss_of_pay") || key === "lop" || key.includes("unpaid")) {
    return "loss_of_pay";
  }
  return null;
}

const leaveSchema = z.object({
  kind: z.string().min(1).max(60),
  fromDate: z.string(),
  toDate: z.string(),
  /** "Morning" or "Afternoon" on a single day; absent on a whole one. */
  halfDay: z.string().nullish(),
  reason: z.string().max(2000).nullish(),
});

/** Whole calendar days between two ISO dates, both ends counted. */
function inclusiveDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000) + 1;
}

/**
 * §2.11 — a leave request, and its withdrawal.
 *
 * `days` is RECOMPUTED here rather than taken from the payload, like every
 * other derived figure in this file: it is what a balance is debited by, and a
 * number the handset can set is a number somebody can set. A half day is a
 * single day with `halfDay` true rather than a `days` of 0.5, because the
 * column is an integer and half of one day is a fact about the day, not a
 * different quantity of them.
 *
 * The overlap check is here as well as on the handset. It is one of the two
 * outright refusals in MBOS, and the reason is that the alternative is not a
 * doubtful record — it is a second request approved by somebody who could not
 * see the first, and a balance debited twice for one absence.
 */
async function handleLeave(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  /* A withdrawal is a partial payload naming only the new state. It is not a
   * cancellation by the office — the person asking is the person who asked —
   * so it needs no approval and simply marks the row. */
  if (item.op === "update") {
    const state = typeof item.payload.state === "string" ? item.payload.state : "";
    if (state.toLowerCase() !== "withdrawn") {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          "The only change a handset may make to a leave request is to withdraw it. Anything else is the approver's.",
        ),
      };
    }

    const [existing] = await db
      .select({ id: mbosLeaveRequests.id, cancelledAt: mbosLeaveRequests.cancelledAt })
      .from(mbosLeaveRequests)
      .where(
        and(
          eq(mbosLeaveRequests.id, item.entityId),
          eq(mbosLeaveRequests.userId, principal.user.id),
        ),
      )
      .limit(1);

    if (!existing) {
      return {
        kind: "retry",
        message:
          "That leave request has not reached the office yet, so there is nothing to withdraw. It will be tried again once it has.",
      };
    }

    /* Withdrawing twice is the same withdrawal — the first date stands, or a
     * retried request would move the moment it was cancelled. */
    if (!existing.cancelledAt) {
      await db
        .update(mbosLeaveRequests)
        .set({
          cancelledAt: new Date(),
          cancelReason: typeof item.payload.cancelReason === "string"
            ? item.payload.cancelReason
            : null,
          updatedAt: new Date(),
          updatedById: principal.user.id,
        })
        .where(eq(mbosLeaveRequests.id, item.entityId));

      await notifyManagers(
        principal.user.id,
        "A leave request was withdrawn",
        `${principal.user.name} withdrew the leave they had asked for. Nothing needs deciding.`,
      );
    }

    return { kind: "accepted", value: { serverId: item.entityId } };
  }

  const parsed = leaveSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const leaveType = leaveTypeOf(p.kind);
  if (!leaveType) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `"${p.kind}" is not a kind of leave MahekOne records. Ask your manager which of casual, sick, earned or loss of pay this should be, and apply again.`,
      ),
    };
  }

  const from = p.fromDate;
  const to = p.toDate || p.fromDate;
  if (to < from) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        "That request ends before it starts. Check the dates and apply again.",
      ),
    };
  }

  const days = inclusiveDays(from, to);
  if (days < 1) {
    return {
      kind: "rejected",
      value: reject("validation", "Those are not two dates this can count days between."),
    };
  }

  /* A half only means anything on a single day: the middle days of a range are
   * whole days whatever the marker says, which is the same reading the pure
   * engine on the handset takes. */
  const halfDay = Boolean(p.halfDay) && from === to;

  /* Pending AND approved, because two requests for the same week sit in the
   * same inbox and get decided separately by somebody reading them one at a
   * time. A withdrawn one is not in anybody's way. */
  const clashes = await db
    .select({
      id: mbosLeaveRequests.id,
      fromDate: mbosLeaveRequests.fromDate,
      toDate: mbosLeaveRequests.toDate,
    })
    .from(mbosLeaveRequests)
    .where(
      and(
        eq(mbosLeaveRequests.userId, principal.user.id),
        sql`${mbosLeaveRequests.cancelledAt} is null`,
        sql`${mbosLeaveRequests.id} <> ${item.entityId}`,
        sql`${mbosLeaveRequests.fromDate} <= ${to}`,
        sql`${mbosLeaveRequests.toDate} >= ${from}`,
      ),
    )
    .limit(1);

  if (clashes.length) {
    const clash = clashes[0];
    return {
      kind: "rejected",
      value: reject(
        "duplicate",
        `You have already asked for leave covering ${clash.fromDate} to ${clash.toDate}. Withdraw that one first if this is meant to replace it.`,
      ),
    };
  }

  await db
    .insert(mbosLeaveRequests)
    .values({
      id: item.entityId,
      userId: principal.user.id,
      leaveType,
      fromDate: from,
      toDate: to,
      halfDay,
      days,
      reason: p.reason ?? null,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoNothing({ target: mbosLeaveRequests.id });

  const span = from === to
    ? `${from}${halfDay ? " (half day)" : ""}`
    : `${from} to ${to}, ${days} days`;
  await notifyManagers(
    principal.user.id,
    "Leave requested",
    `${principal.user.name} has asked for ${leaveType.replace(/_/g, " ")} leave — ${span}.${
      p.reason ? ` ${p.reason}` : ""
    }`,
  );

  return { kind: "accepted", value: { serverId: item.entityId } };
}

const tourSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  cities: z.array(z.string().max(120)).max(20).default([]),
  purpose: z.string().max(500).nullish(),
  estimatedCostPaise: z.number().int().nonnegative().nullish(),
  notes: z.string().max(2000).nullish(),
});

/**
 * Working away from the usual beat for several days.
 *
 * `mbosTours` existed with zero code ever writing to it — a real approval
 * type in the enum with no way to create the thing it approves. This is that
 * door, mirroring `handleLeave`'s shape exactly: the subject record is
 * written here, pending; the separate `approval` sync item the handset also
 * sends is what actually asks the office to decide it.
 */
async function handleTour(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = tourSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  if (p.endDate < p.startDate) {
    return {
      kind: "rejected",
      value: reject("validation", "That tour ends before it starts. Check the dates and ask again."),
    };
  }

  await db
    .insert(mbosTours)
    .values({
      id: item.entityId,
      userId: principal.user.id,
      startDate: p.startDate,
      endDate: p.endDate,
      cities: p.cities,
      purpose: p.purpose ?? null,
      estimatedCostPaise: p.estimatedCostPaise ?? null,
      notes: p.notes ?? null,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoNothing({ target: mbosTours.id });

  await notifyManagers(
    principal.user.id,
    "A tour was requested",
    `${principal.user.name} has asked to work ${p.cities.length ? p.cities.join(", ") : "away from the usual beat"} from ${p.startDate} to ${p.endDate}.${p.purpose ? ` ${p.purpose}` : ""}`,
  );

  return { kind: "accepted", value: { serverId: item.entityId } };
}

const competitorSchema = z.object({
  customerId: z.string().min(1),
  visitId: z.string().nullish(),
  competitorName: z.string().min(1).max(200),
  productName: z.string().max(200).nullish(),
  /** Paise. The handset's own column is `ratePaise`; the server's is `pricePaise`. */
  ratePaise: z.number().int().nonnegative().nullish(),
  creditDays: z.number().int().nonnegative().nullish(),
  delivery: z.string().max(1000).nullish(),
  strengths: z.string().max(1000).nullish(),
  weaknesses: z.string().max(1000).nullish(),
  recordedOn: z.string().nullish(),
});

/**
 * What was heard about somebody else's price at a shop.
 *
 * `mbos_competitor_records` had a table, a read query the customer record's
 * Competitors tab already rendered, and no way for a "+ Add what you heard"
 * button anywhere to actually write one — the button toasted and nothing
 * happened. This is that door.
 *
 * Column names differ from the handset's own local table on purpose rather
 * than by drift: `ratePaise`/`delivery` there, `pricePaise`/`deliveryNote`
 * here, matching this table's own established names rather than renaming a
 * column the customer record already reads from elsewhere.
 */
async function handleCompetitor(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = competitorSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const scoped = await scopedCustomer(principal, p.customerId);
  if (!scoped.ok) return { kind: "rejected", value: scoped.value };

  await db
    .insert(mbosCompetitorRecords)
    .values({
      id: item.entityId,
      customerId: scoped.customer.id,
      visitId: p.visitId ?? null,
      competitorName: p.competitorName,
      productName: p.productName ?? null,
      pricePaise: p.ratePaise ?? null,
      creditDays: p.creditDays ?? null,
      deliveryNote: p.delivery ?? null,
      strengths: p.strengths ?? null,
      weaknesses: p.weaknesses ?? null,
      recordedOn: p.recordedOn ?? null,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoNothing({ target: mbosCompetitorRecords.id });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------------- the plan day */

const planDaySchema = z.object({
  /** `agreed` or `refused`. Nothing else is the handset's to say. */
  answer: z.enum(["agreed", "refused"]),
  reason: z.string().max(2000).nullish(),
  /** Where he would rather go. Optional — "not this" is a legitimate answer. */
  counterCity: z.string().max(120).nullish(),
});

/**
 * The salesman answering a proposed day.
 *
 * This is the half of the negotiation the handset speaks, and it is the whole
 * reason the model exists: the office proposes a city, and the man who walks
 * it is the one who knows the market shuts on Wednesdays.
 *
 * **A refusal must carry a reason.** Without one the manager has nothing to
 * act on and the day sits unplanned while each waits for the other — which is
 * worse than either answer.
 *
 * What he cannot do is move a day to `planned`. That happens when he picks
 * shops, which is an ordinary stop write; conflating the two would let an
 * empty day claim to be a route.
 */
async function handlePlanDay(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = planDaySchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const [plan] = await db
    .select()
    .from(mbosJourneyPlans)
    .where(
      and(
        eq(mbosJourneyPlans.id, item.entityId),
        eq(mbosJourneyPlans.userId, principal.user.id),
      ),
    )
    .limit(1);

  if (!plan) {
    return {
      kind: "retry",
      message:
        "That day is not on the office's plan yet. It will be tried again once it is.",
    };
  }

  /* Already walked, or already picked. Answering it now would unpick a day
   * that has moved on. */
  if (plan.dayState === "planned") {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${plan.planDate} already has its shops picked, so there is nothing left to agree. Change the stops instead.`,
      ),
    };
  }

  if (p.answer === "refused" && !p.reason?.trim()) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        "Say why the day will not work. Without a reason your manager has nothing to go on and the day stays unplanned.",
      ),
    };
  }

  await db
    .update(mbosJourneyPlans)
    .set({
      dayState: p.answer,
      refusalReason: p.answer === "refused" ? (p.reason ?? "").trim() : null,
      counterCity: p.answer === "refused" ? (p.counterCity?.trim() || null) : null,
      respondedAt: new Date(),
      updatedAt: new Date(),
      updatedById: principal.user.id,
    })
    .where(eq(mbosJourneyPlans.id, item.entityId));

  /* The manager is the other half of this conversation and has no reason to
   * be looking at the screen when the answer arrives. */
  await notifyManagers(
    principal.user.id,
    p.answer === "agreed"
      ? `${principal.user.name} agreed ${plan.planDate}`
      : `${principal.user.name} cannot work ${plan.planDate}`,
    p.answer === "agreed"
      ? `${plan.city ?? "The day"} is agreed. He picks the shops next.`
      : `${(p.reason ?? "").trim()}${p.counterCity ? ` He would rather have ${p.counterCity.trim()}.` : ""}`,
  );

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------- picking the shops */

const planStopsSchema = z.object({
  /** In the order he means to walk them. The sequence IS the array's order. */
  customerIds: z.array(z.string().min(1)).max(60),
});

/**
 * The shops he picked for a day he agreed.
 *
 * The other half of the negotiation. The office proposes a city; the man who
 * walks it picks the doors, because he is the one who knows which of them are
 * worth a Tuesday morning. Until this existed he could agree to a day and then
 * had no way to fill it — the office arranged the stops, which the console
 * offers as its explicit exception rather than as the ordinary path.
 *
 * **It REPLACES the day's stops rather than adding to them.** Picking is one
 * act performed on one screen, and the payload is the whole answer: sending a
 * shorter list is how a shop is unpicked, and merging would make that
 * impossible. A stop already visited is kept regardless — the day has started
 * and a visit is not a plan any more.
 *
 * **The day only becomes `planned` if something was picked.** An empty day
 * claiming to be a route is the one state this model exists to prevent.
 */
async function handlePlanStops(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = planStopsSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const wanted = [...new Set(parsed.data.customerIds)];

  const [plan] = await db
    .select()
    .from(mbosJourneyPlans)
    .where(
      and(
        eq(mbosJourneyPlans.id, item.entityId),
        eq(mbosJourneyPlans.userId, principal.user.id),
      ),
    )
    .limit(1);

  if (!plan) {
    return {
      kind: "retry",
      message: "That day is not on the office's plan yet. It will be tried again once it is.",
    };
  }

  /* A day he has not agreed to, or has sent back. Picking shops for it would
   * agree to it by the back door, and the answer he gave is the record. */
  if (plan.dayState !== "agreed" && plan.dayState !== "planned") {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${plan.planDate} has not been agreed, so there is nothing to pick shops for yet.`,
      ),
    };
  }

  /* Every shop, checked against his own book — one bad id must not cost the
   * other nineteen, so an unreachable customer is dropped and counted rather
   * than refusing the whole day. */
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const customerId of wanted) {
    const found = await scopedCustomer(principal, customerId);
    if (found.ok) allowed.push(customerId);
    else refused.push(customerId);
  }

  await db.transaction(async (tx) => {
    /* Anything already walked stays. The rest is replaced, because the payload
     * is the whole answer and a shorter list is how something is unpicked. */
    await tx
      .delete(mbosJourneyStops)
      .where(
        and(
          eq(mbosJourneyStops.planId, plan.id),
          eq(mbosJourneyStops.status, "planned"),
        ),
      );

    const kept = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(mbosJourneyStops)
      .where(eq(mbosJourneyStops.planId, plan.id));
    let sequence = Number(kept[0]?.n ?? 0);

    for (const customerId of allowed) {
      sequence += 1;
      await tx.insert(mbosJourneyStops).values({
        id: `mbos_stop_${randomUUID()}`,
        planId: plan.id,
        customerId,
        sequence,
        status: "planned",
        createdById: principal.user.id,
        updatedById: principal.user.id,
        deviceId: principal.deviceId,
      });
    }

    await tx
      .update(mbosJourneyPlans)
      .set({
        /* Picked nothing puts the day back to agreed rather than leaving it
         * `planned` with no stops — an empty route is not a route. */
        dayState: sequence > 0 ? "planned" : "agreed",
        updatedAt: new Date(),
        updatedById: principal.user.id,
      })
      .where(eq(mbosJourneyPlans.id, plan.id));
  });

  await notifyManagers(
    principal.user.id,
    `${principal.user.name} planned ${plan.planDate}`,
    `${allowed.length} ${allowed.length === 1 ? "shop" : "shops"} picked${plan.city ? ` in ${plan.city}` : ""}.`,
  );

  /* Accepted, and the shortfall said out loud rather than swallowed. Silently
   * planning nineteen of twenty shops is how somebody walks a day missing a
   * stop they chose, and finds out at four in the afternoon. It goes as a
   * notification because the accept has no room for a sentence and inventing
   * one would change the shape of every other handler's answer. */
  if (refused.length) {
    await db
      .insert(notifications)
      .values({
        id: gen("ntf"),
        userId: principal.user.id,
        title: `${plan.planDate}: ${refused.length} ${refused.length === 1 ? "shop" : "shops"} left out`,
        body: `${allowed.length} of ${allowed.length + refused.length} picked. The rest are not in your book any more — ask your manager if one of them should be.`,
        kind: "warning",
        href: "/journey",
      })
      .catch(() => {});
  }

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ---------------------------------------------------------------- approvals */

const APPROVAL_TYPES = [
  "order",
  "expense_claim",
  "leave",
  "tour",
  "sample",
  "attendance_regularisation",
] as const;
type ApprovalType = (typeof APPROVAL_TYPES)[number];

const approvalSchema = z.object({
  type: z.string().min(1).max(60),
  subjectType: z.string().min(1).max(60),
  subjectId: z.string().min(1),
  reason: z.string().max(2000).nullish(),
});

/**
 * The handset names WHY as well as what — `order_over_credit` and
 * `order_over_threshold` are both an order approval, and the difference
 * between them is a sentence in `reason` rather than a second kind of thing
 * for an approver to learn. `out_of_territory` is a visit somewhere it should
 * not have been, which is the same conversation as regularising a day.
 */
const APPROVAL_ALIASES: Record<string, ApprovalType> = {
  order_over_credit: "order",
  order_over_threshold: "order",
  out_of_territory: "attendance_regularisation",
  expense: "expense_claim",
};

function approvalTypeOf(raw: string): ApprovalType | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return APPROVAL_TYPES.find((t) => t === key) ?? APPROVAL_ALIASES[key] ?? null;
}

/**
 * Somebody in the field asking somebody in the office to say yes.
 *
 * This is the record the handset always wrote and never sent: `raiseApproval`
 * filed it locally, marked it queued and stopped, so a salesman standing in a
 * shop over his credit limit waited on a request that existed on his own phone
 * and nowhere else. `mbos_approvals` was on the other end of that the whole
 * time, with the nightly sweep already watching it for anything undecided too
 * long.
 *
 * The decision is deliberately NOT here. Nothing a handset sends may set
 * `state`, `approverUserId` or `decidedAt` — an approval that could approve
 * itself is not an approval — so the row is written pending and the office
 * decides it.
 */
async function handleApproval(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = approvalSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const type = approvalTypeOf(p.type);
  if (!type) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `MahekOne has nobody to send a "${p.type}" approval to. This is a bug to report rather than something to try again.`,
      ),
    };
  }

  await db
    .insert(mbosApprovals)
    .values({
      id: item.entityId,
      type,
      requestedByUserId: principal.user.id,
      subjectType: p.subjectType,
      subjectId: p.subjectId,
      reason: p.reason ?? null,
      requestedAt: new Date(item.clientCreatedAt),
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoNothing({ target: mbosApprovals.id });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* -------------------------------------------- the one thing that can conflict */

/**
 * Customer details are the only mutable record the handset edits, so they are
 * the only ones that can conflict (PROTOCOL §7). Append-only records — a
 * visit, an order, a payment — created twice are two records, never a merge.
 *
 * Two things this deliberately refuses:
 *
 *  - the credit fields. A limit and a block are decisions accounts made with
 *    the ledger in front of them, and a handset must not be able to raise its
 *    own customer's limit.
 *  - the derived caches. Outstanding, the health score and the last-visit date
 *    are the server's (PROTOCOL §8) and are recomputed, never accepted.
 */
const customerEditSchema = z.object({
  customerId: z.string(),
  /** What the handset held when the edit was made — the base of the merge. */
  baseUpdatedAt: z.number().optional(),
  contactPerson: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  altPhone: z.string().max(20).optional(),
  whatsappPhone: z.string().max(20).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(120).optional(),
  area: z.string().max(120).optional(),
  beat: z.string().max(120).optional(),
  territoryRegion: z.string().max(120).optional(),
  dealerCode: z.string().max(60).optional(),
  customerType: z.enum(["dealer", "manufacturer", "distributor", "retailer"]).optional(),
  potential: z.enum(["high", "medium", "low"]).optional(),
  visitFrequencyDays: z.number().int().positive().optional(),
  gpsLat: z.number().optional(),
  gpsLng: z.number().optional(),
  gpsAccuracyM: z.number().int().optional(),
});

const FORBIDDEN_CUSTOMER_FIELDS = [
  "creditLimitPaise",
  "creditBlocked",
  "creditBlockReason",
  "outstanding",
  "healthScore",
  "status",
  "salesAmId",
  "ownerId",
];

const customerCreateSchema = z.object({
  name: z.string().min(1).max(200),
  contactPerson: z.string().max(200).nullish(),
  phone: z.string().min(6).max(20),
  city: z.string().max(120).nullish(),
  address: z.string().max(500).nullish(),
  /** The lead this shop was won from, so the two records stay joined up. */
  fromLeadId: z.string().nullish(),
  estimatedPotentialPaise: z.number().int().nonnegative().nullish(),
  gpsLat: z.number().nullish(),
  gpsLng: z.number().nullish(),
  /**
   * A shop we DELIVER to and do not bill, opened in the field.
   *
   * The case is a salesman standing in an outlet that is not on the book,
   * taking an order that his distributor will be invoiced for. Without this he
   * either abandons the order or files it as though the distributor received
   * the goods, and where the lorry actually went is lost.
   */
  thirdParty: z.boolean().nullish(),
  /**
   * Who invoices it. Required WITH `thirdParty`, because a shop marked as one
   * we do not bill, with nobody recorded as billing it, is precisely the row
   * the console already has a tidying list for — and creating those from the
   * field would fill it faster than anybody empties it.
   */
  distributorCustomerId: z.string().nullish(),
});

/**
 * A lead that became a shop.
 *
 * The handset has always been able to convert one — it writes the customer
 * locally, moves the lead to Converted and opens the new record. What it could
 * not do was tell anybody: `customer` only ever meant an EDIT here, so the
 * conversion arrived asking to change a customer that existed on one phone,
 * was refused as out of territory, and the salesman was left working an
 * account MahekOne had never heard of.
 *
 * What it does NOT set is the commercial machinery. A credit limit, a
 * potential band and a visit frequency are the office's to decide with the
 * ledger in front of them, and a new account arriving with a confident zero in
 * each of them reads as a decision somebody made. `salesAmId` is the salesman
 * who won it, because scope has to resolve to somebody who can see the work.
 */
async function handleCustomerCreate(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = customerCreateSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  /* Four columns on `customers` are NOT NULL and a lead is not required to
   * carry all of them. Refusing with the missing one named is better than
   * inventing a blank city that somebody has to find and fix later. */
  if (!p.city) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${p.name} cannot be opened as an account without a town. Add it to the lead and convert again.`,
      ),
    };
  }
  /* Held in a const: the guard above narrows `p.city`, and that narrowing does
     not survive into the transaction callback below. */
  const city = p.city;

  const existing = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, item.entityId))
    .limit(1);
  if (existing.length) {
    /* A replay of the conversion, not a second shop. */
    return { kind: "accepted", value: { serverId: item.entityId } };
  }

  /*
   * A shop we do not bill has to say who does.
   *
   * Checked here rather than trusted: the distributor must be an account we
   * actually invoice — a real customer, and not itself a third party — which
   * is the same rule the console's own picker enforces. A shop pointed at
   * another shop is an arrangement that cannot be acted on.
   */
  let distributor: { id: string; name: string } | null = null;
  if (p.thirdParty) {
    if (!p.distributorCustomerId) {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `${p.name} was opened as a shop we deliver to but nobody was named as billing it. Say who is invoiced and add it again.`,
        ),
      };
    }
    const [biller] = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        thirdParty: customers.thirdParty,
      })
      .from(customers)
      .where(eq(customers.id, p.distributorCustomerId))
      .limit(1);
    if (!biller || biller.kind !== "customer" || biller.thirdParty) {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `Whoever was named as billing ${p.name} is not an account we invoice. Pick the distributor again and add it.`,
        ),
      };
    }
    distributor = { id: biller.id, name: biller.name };
  }

  /*
   * THE DUPLICATE IS FLAGGED, NOT REFUSED, AND NOT MERGED.
   *
   * Merged is impossible: the handset does not act on the `serverId` we return,
   * so folding this onto an existing record would leave the phone holding a
   * customer id that exists nowhere — and the order queued behind it would
   * fail against a shop that was never created.
   *
   * Refused is worse than it looks. The salesman is standing in the shop with
   * the order in his hand; losing it to a message about a record he cannot see
   * teaches him to type the name slightly differently until it goes through,
   * which is how three spellings of one shop get onto the book.
   *
   * So the shop is created and the collision is written down where somebody
   * can act on it. The phone is the right key: it is the one field two people
   * will type identically, and a shop's name is not.
   */
  const digits = p.phone.replace(/\D/g, "").slice(-10);
  const clash = digits.length === 10
    ? await db
        .select({ id: customers.id, name: customers.name })
        .from(customers)
        /*
         * `[^0-9]`, NOT `\D`. Postgres does not read that escape the way
         * JavaScript does — `regexp_replace('98123 45678', '\D', '', 'g')`
         * returns `8123 45678`, stripping a digit and keeping the space, which
         * would have made this match almost nothing and looked like "we simply
         * have no duplicates". The JS side above is a real JS regex and `\D`
         * is right there.
         */
        .where(sql`right(regexp_replace(${customers.phone}, '[^0-9]', '', 'g'), 10) = ${digits}`)
        .limit(1)
    : [];

  await db.transaction(async (tx) => {
    await tx.insert(customers).values({
      id: item.entityId,
      name: p.name,
      contactPerson: p.contactPerson || p.name,
      phone: p.phone,
      city,
      address: p.address ?? null,
      kind: "customer",
      leadSource: "mbos",
      ownerId: principal.user.id,
      salesAmId: principal.user.id,
      // Goods here, invoice elsewhere — the mark and the arrangement are
      // written together, or the console gets a shop nobody bills.
      thirdParty: Boolean(p.thirdParty),
      gpsLat: p.gpsLat ?? null,
      gpsLng: p.gpsLng ?? null,
    });

    if (distributor) {
      await tx.insert(customerDistributors).values({
        id: `cd_${randomUUID().slice(0, 12)}`,
        customerId: item.entityId,
        distributorCustomerId: distributor.id,
        // The only one there is, so it is the one that serves it usually.
        isPrimary: true,
        note: "Opened in the field",
        createdById: principal.user.id,
        updatedById: principal.user.id,
      });
    }

    if (clash.length) {
      await tx
        .insert(syncConflicts)
        .values({
          id: `cfl_${randomUUID().slice(0, 12)}`,
          entityType: "customers",
          entityId: item.entityId,
          field: "phone",
          sheetValue: `${clash[0].name} (${clash[0].id})`,
          appValue: `${p.name} (${item.entityId})`,
          decidedById: principal.user.id,
          decidedAt: new Date(),
        })
        .onConflictDoNothing();
    }
  });

  await notifyManagers(
    principal.user.id,
    "A new account was opened in the field",
    `${principal.user.name} converted ${p.name} in ${p.city} from a lead. It has no credit limit or terms yet — accounts decide those.`,
  );

  return { kind: "accepted", value: { serverId: item.entityId } };
}

async function handleCustomerEdit(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  if (item.op === "create") return handleCustomerCreate(principal, item);

  const attempted = FORBIDDEN_CUSTOMER_FIELDS.filter((f) => f in (item.payload ?? {}));
  if (attempted.length) {
    return {
      kind: "rejected",
      value: reject(
        "not_permitted",
        `The field app cannot change ${attempted.join(", ")} — a credit limit, a block and a balance are accounts' decisions with the ledger in front of them. Ring accounts if one of them is wrong.`,
      ),
    };
  }

  const parsed = customerEditSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  const [before] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customer.id))
    .limit(1);

  /* Named one field at a time rather than spread from the payload. A loop over
   * `Object.entries` needs a cast to reach `.set()`, and a cast there would
   * silence exactly the mistake worth catching: a key that is not a column. */
  const changed: Partial<typeof customers.$inferInsert> = {};
  if (p.contactPerson !== undefined) changed.contactPerson = p.contactPerson;
  if (p.phone !== undefined) changed.phone = p.phone;
  if (p.altPhone !== undefined) changed.altPhone = p.altPhone;
  if (p.whatsappPhone !== undefined) changed.whatsappPhone = p.whatsappPhone;
  if (p.address !== undefined) changed.address = p.address;
  if (p.city !== undefined) changed.city = p.city;
  if (p.area !== undefined) changed.area = p.area;
  if (p.beat !== undefined) changed.beat = p.beat;
  if (p.territoryRegion !== undefined) changed.territoryRegion = p.territoryRegion;
  if (p.dealerCode !== undefined) changed.dealerCode = p.dealerCode;
  if (p.customerType !== undefined) changed.customerType = p.customerType;
  if (p.potential !== undefined) changed.potential = p.potential;
  if (p.visitFrequencyDays !== undefined) changed.visitFrequencyDays = p.visitFrequencyDays;
  if (p.gpsLat !== undefined) changed.gpsLat = p.gpsLat;
  if (p.gpsLng !== undefined) changed.gpsLng = p.gpsLng;
  if (p.gpsAccuracyM !== undefined) changed.gpsAccuracyM = p.gpsAccuracyM;

  if (!Object.keys(changed).length) {
    return { kind: "accepted", value: { serverId: customer.id } };
  }
  if (p.gpsLat != null && p.gpsLng != null) changed.gpsCapturedAt = new Date();

  /* Latest-write-wins on SERVER-RECEIVED time, never on device time — a
   * handset's clock is wrong and its owner can set it. This edit is arriving
   * now, so it is the later of the two; what that costs is the office edit it
   * overwrote, which is why the losing version is kept rather than dropped. */
  const conflicted =
    p.baseUpdatedAt != null && before && before.updatedAt.getTime() > p.baseUpdatedAt;

  await db.transaction(async (tx) => {
    await tx
      .update(customers)
      .set({ ...changed, updatedAt: new Date(), updatedById: principal.user.id })
      .where(eq(customers.id, customer.id));

    if (conflicted) {
      await tx.insert(mbosConflicts).values({
        id: gen("mbos_conflict"),
        recordId: customer.id,
        entityType: "customer",
        localVersion: changed,
        serverVersion: JSON.parse(JSON.stringify(before)),
        resolution: "client_wins",
        flaggedForReview: true,
        clientCreatedAt: new Date(item.clientCreatedAt),
        createdById: principal.user.id,
        updatedById: principal.user.id,
        deviceId: principal.deviceId,
      });
    }
  });

  if (conflicted) {
    // Nothing is discarded silently: whoever made the edit that lost is told.
    if (before?.updatedById && before.updatedById !== principal.user.id) {
      await db.insert(notifications).values({
        id: gen("ntf"),
        userId: before.updatedById,
        title: "Your edit was overwritten",
        body: `${principal.user.name} changed ${customer.name} from the field after you did. Both versions are kept — open the conflict log to compare.`,
        kind: "warning",
        href: `/crm/customers/${customer.id}`,
      });
    }
    return {
      kind: "conflict",
      serverVersion: JSON.parse(JSON.stringify(before)) as Record<string, unknown>,
      resolution: "client_wins",
    };
  }

  return { kind: "accepted", value: { serverId: customer.id } };
}

/* ═══════════════════════════════════════════════════════ rejection follow-up */

/**
 * A rejected ORDER raises a task, because the salesman stood in the shop and
 * said the order was placed. A notification can be missed; a task on the list
 * cannot (PROTOCOL §6).
 */
export async function raiseRejectionTask(
  principal: MbosPrincipal,
  item: SyncItem,
  rejection: { code: string; message: string },
): Promise<void> {
  if (item.entityType !== "order") return;
  const customerId = customerIdOf(item);
  if (!customerId) return;

  const day = await today();
  await db
    .insert(mbosTasks)
    .values({
      id: gen("mbos_task"),
      title: "Ring back — an order was refused",
      description: rejection.message,
      assignedToUserId: principal.user.id,
      priority: "high",
      dueDate: day,
      customerId,
      status: "open",
      sourceType: "rejected_order",
      sourceId: item.entityId,
      createdById: principal.user.id,
      updatedById: principal.user.id,
    })
    .catch(() => {});

  await db
    .insert(notifications)
    .values({
      id: gen("ntf"),
      userId: principal.user.id,
      title: "An order was refused",
      body: rejection.message,
      kind: "warning",
      href: "/field",
    })
    .catch(() => {});
}

async function notifyManagers(actorId: string, title: string, body: string) {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId)).limit(1);
  const targets = await db
    .select({ id: users.id })
    .from(users)
    .where(
      actor?.reportsToId
        ? eq(users.id, actor.reportsToId)
        : and(inArray(users.role, ["manager", "admin"]), eq(users.active, true)),
    );

  if (!targets.length) return;
  await db
    .insert(notifications)
    .values(
      targets.map((t) => ({
        id: gen("ntf"),
        userId: t.id,
        title,
        body,
        kind: "info",
      })),
    )
    .catch(() => {});
}

/* ═════════════════════════════════════════════════════════ number allocation */

/** A prefix with a slash in it would break `split_part`, so it is refused. */
function seriesPrefix(configured: string, fallback: string): string {
  const cleaned = (configured ?? "").trim();
  if (!cleaned || cleaned.includes("/")) return fallback;
  return cleaned;
}

/**
 * `MBOS/26-27/0041`, allocated under an advisory lock held to the end of the
 * transaction that writes the row.
 *
 * Two salesmen offline must never produce the same number, which is exactly
 * why the number is not the identity — but two SYNCS landing in the same
 * second must not either, and nothing about a client id prevents that. The
 * lock is per series and per financial year, so an order and a receipt do not
 * queue behind each other.
 *
 * The highest number is read from the table rather than from a counter,
 * because a counter is a second place the truth lives and the two drift the
 * first time a row is inserted by anything else. It is read from the column
 * that MEANS the number — `orders.order_no`, `payment_receipts.receipt_no` —
 * rather than from `external_ref`, which is a shared scratch column that also
 * holds sheet keys and allocation-line keys and would one day hand out a
 * number already in use.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const NUMBER_COLUMN = {
  orders: { table: "orders", column: "order_no" },
  payments: { table: "payment_receipts", column: "receipt_no" },
} as const;

async function allocateNumber(
  tx: Tx,
  prefix: string,
  fy: string,
  series: "orders" | "payments",
): Promise<string> {
  const { table, column } = NUMBER_COLUMN[series];
  const lockKey = `mbos:number:${series}:${prefix}:${fy}`;
  await tx.execute<Record<string, unknown>>(
    sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`,
  );

  const pattern = `${prefix}/${fy}/%`;
  const rows = await tx.execute<{ n: number }>(sql`
    select coalesce(max(split_part(${sql.raw(column)}, '/', 3)::bigint), 0)::int as n
      from ${sql.raw(table)}
     where ${sql.raw(column)} like ${pattern}
       and split_part(${sql.raw(column)}, '/', 3) ~ '^[0-9]+$'
  `);

  const next = Number(rows[0]?.n ?? 0) + 1;
  return `${prefix}/${fy}/${String(next).padStart(4, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════ the timeline */

/**
 * The handset's half of the shared stream. The CRM writes its own half through
 * the same helper — see `lib/timeline.ts` — so the two cannot drift apart in
 * id shape, conflict handling or which column means what.
 */
async function writeTimeline(
  tx: TimelineWriter,
  event: {
    customerId: string;
    eventType: string;
    sourceRecordId: string;
    occurredAt: Date;
    actorUserId: string;
    summary: string;
  },
) {
  await writeTimelineEvent(tx, { ...event, sourceApp: "mbos" });
}

/* ═════════════════════════════════════════════════════════════ the health score */

/**
 * A derived cache, in exactly the sense `outstanding` and `slowPayer` are.
 * The rule lives in the pure engine; this is the data fetching, which is the
 * only reason it is not in `lib/engines`.
 */
export async function recomputeHealthScore(customerId: string): Promise<void> {
  const config = await getConfig();
  const day = await today();

  const [row] = await db.execute<{
    lastOrderDate: string | null;
    lastVisitDate: string | null;
    cycleDays: number;
    visitFrequencyDays: number | null;
    outstanding: string;
    recentValue: string;
    priorValue: string;
    billsTotal: number;
    billsLate: number;
    overdue: string;
    complaintsOpened: number;
    complaintsOpen: number;
  }>(sql`
    select c.last_order_date::text as "lastOrderDate",
           c.last_visit_date::text as "lastVisitDate",
           c.cycle_days as "cycleDays",
           c.visit_frequency_days as "visitFrequencyDays",
           c.outstanding as "outstanding",
           coalesce((select sum(o.total_amount) from orders o
                      where o.customer_id = c.id
                        and o.status in ('captured','confirmed','dispatched')
                        and o.ordered_at >= now() - interval '90 days'), 0) as "recentValue",
           coalesce((select sum(o.total_amount) from orders o
                      where o.customer_id = c.id
                        and o.status in ('captured','confirmed','dispatched')
                        and o.ordered_at >= now() - interval '180 days'
                        and o.ordered_at <  now() - interval '90 days'), 0) as "priorValue",
           (select count(*)::int from bills b where b.customer_id = c.id) as "billsTotal",
           (select count(*)::int from bills b
             where b.customer_id = c.id and b.status = 'paid'
               and exists (select 1 from payments pm
                            where pm.bill_id = b.id and pm.paid_at > b.due_date)
           ) as "billsLate",
           coalesce((select sum(b.amount - b.paid_amount) from bills b
                      where b.customer_id = c.id
                        and b.due_date < ${day}::date
                        and b.amount > b.paid_amount), 0) as "overdue",
           (select count(*)::int from complaints cp
             where cp.customer_id = c.id
               and cp.created_at >= now() - interval '180 days') as "complaintsOpened",
           (select count(*)::int from complaints cp
             where cp.customer_id = c.id and cp.status <> 'resolved') as "complaintsOpen"
      from customers c
     where c.id = ${customerId}
  `);

  if (!row) return;

  const facts: HealthFacts = {
    lastOrderDate: row.lastOrderDate,
    lastVisitDate: row.lastVisitDate,
    cycleDays: Number(row.cycleDays ?? 30),
    recentOrderValuePaise: Number(row.recentValue ?? 0),
    priorOrderValuePaise: Number(row.priorValue ?? 0),
    billsPaidLate: Number(row.billsLate ?? 0),
    billsTotal: Number(row.billsTotal ?? 0),
    overduePaise: Number(row.overdue ?? 0),
    outstandingPaise: Number(row.outstanding ?? 0),
    complaintsOpened: Number(row.complaintsOpened ?? 0),
    complaintsOpen: Number(row.complaintsOpen ?? 0),
    visitFrequencyDays: row.visitFrequencyDays == null ? null : Number(row.visitFrequencyDays),
  };

  const result = computeHealth(facts, config["mbos.health.componentWeights"], day);

  await db
    .update(customers)
    .set({
      healthScore: result.score,
      healthComponents: result.components,
      healthComputedAt: new Date(),
    })
    .where(eq(customers.id, customerId));
}

/* ═══════════════════════════════════════════════════════════════════ media */

export type MediaOutcome =
  | { ok: true; attachmentId: string; deduped: boolean }
  | { ok: false; status: number; error: string };

/**
 * One file, through the EXISTING attachment subsystem — `lib/storage.ts` and
 * the `attachments` table. MBOS does not build its own: the rules about what a
 * file may be, how big it is and who may open it are the same wherever a file
 * lands, and a second implementation is a second place for them to drift.
 *
 * `clientId` is the dedupe key, so a re-POST after a dropped connection is
 * resumable rather than a second copy of 840 KB of shop front. It is stored as
 * the attachment id, which makes the dedupe a primary-key lookup rather than a
 * column somebody has to remember to index.
 */
export async function storeMbosMedia(
  principal: MbosPrincipal,
  input: {
    clientId: string;
    kind: string;
    entityId?: string;
    filename: string;
    bytes: Uint8Array;
  },
): Promise<MediaOutcome> {
  if (!/^mbos_[a-z_]+_[a-z0-9-]+$/i.test(input.clientId)) {
    return {
      ok: false,
      status: 400,
      error: "That is not a client id this app can store a file under.",
    };
  }

  const existing = await db
    .select({ id: attachments.id, status: attachments.status })
    .from(attachments)
    .where(eq(attachments.id, input.clientId))
    .limit(1);
  if (existing.length && existing[0].status === "available") {
    return { ok: true, attachmentId: existing[0].id, deduped: true };
  }

  const config = await getConfig();
  const maxBytes = config["attachments.maxSizeMb"] * 1024 * 1024;
  if (input.bytes.byteLength > maxBytes) {
    const mb = (input.bytes.byteLength / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      status: 413,
      error: `That file is ${mb} MB and the limit is ${config["attachments.maxSizeMb"]} MB. The handset should resize before queueing it.`,
    };
  }

  /* Validated on the BYTES. `.jpg` is three characters anyone can type, and
   * the declared MIME comes from the same untrusted place the name does. */
  const actual = sniffContentType(input.bytes);

  /* A voice note is the one upload that may be audio, and only that kind may
   * be. Nobody picks an audio file on a form — a handset records one — so the
   * permitted list is not widened for every attachment field in MahekOne to
   * carry this. */
  const isVoiceNote = input.kind === "voice_note";
  const accepted = isVoiceNote
    ? [...config["attachments.acceptedTypes"], ...ACCEPTED_AUDIO_TYPES]
    : config["attachments.acceptedTypes"];

  if (!actual || !accepted.includes(actual)) {
    return {
      ok: false,
      status: 415,
      error: actual
        ? `${input.filename} is a ${actual} file, which is not accepted here.`
        : `${input.filename} is not a file type MahekOne accepts, whatever it is named.`,
    };
  }

  try {
    const stored = await fileStorage.upload({
      key: `attachments/${input.clientId}`,
      body: input.bytes,
      contentType: actual,
    });

    await db
      .insert(attachments)
      .values({
        id: input.clientId,
        filename: input.filename,
        storedRef: stored.ref,
        contentType: actual,
        sizeBytes: stored.sizeBytes,
        thumbnailRef: actual.startsWith("image/") ? stored.ref : null,
        status: "available",
        uploadedById: principal.user.id,
      })
      .onConflictDoUpdate({
        target: attachments.id,
        set: {
          storedRef: stored.ref,
          contentType: actual,
          sizeBytes: stored.sizeBytes,
          status: "available",
          updatedAt: new Date(),
        },
      });

    /* The transcript, where this was speech. Deliberately AFTER the bytes are
     * safe and deliberately unable to fail the upload: the recording is the
     * only copy of what the customer actually said, and losing it because a
     * transcription provider was slow would be the worst trade in the app. A
     * failure leaves the audio stored and untranscribed, which is exactly the
     * state the handset already knows how to wait in. */
    if (isVoiceNote) {
      await transcribeVoiceNote(principal, input.clientId, actual, input.bytes).catch(
        () => {},
      );
    }

    return { ok: true, attachmentId: input.clientId, deduped: false };
  } catch (e) {
    return {
      ok: false,
      status: 503,
      error: `${input.filename} could not be stored: ${
        e instanceof Error ? e.message : "the store did not answer"
      }. The handset will try again.`,
    };
  }
}

/**
 * What was said in the shop, in writing.
 *
 * The handset keeps the audio until a transcript comes BACK — not merely until
 * the upload succeeded — so this closing of the loop is what lets a salesman's
 * phone let go of a recording. Nothing did it before: the bytes were refused
 * at the door for being audio at all, and had they been accepted there was
 * nothing here to transcribe them and no channel to return one.
 *
 * The same two providers the CRM's own dictation uses, through the same
 * function, so a deployment configures this once. Where neither is configured
 * the audio simply stays audio, and the visit says so rather than claiming a
 * note nobody wrote.
 */
async function transcribeVoiceNote(
  principal: MbosPrincipal,
  attachmentId: string,
  mediaType: string,
  bytes: Uint8Array,
): Promise<void> {
  const config = await getConfig();
  if (!config["voice.enabled"]) return;

  const [visit] = await db
    .select({ id: mbosVisits.id, transcript: mbosVisits.transcript })
    .from(mbosVisits)
    .where(eq(mbosVisits.voiceNoteId, attachmentId))
    .limit(1);

  /* No visit yet, or one somebody has already written a note onto by hand.
   * Media syncs after its parent, so the first is a race rather than a rule —
   * and re-transcribing on a re-upload would overwrite a corrected note. */
  if (!visit || visit.transcript) return;

  const heard = await transcribeSpeech({
    audio: bytes,
    mediaType,
    /* The recorder counted the seconds and the handset does not send them with
     * the file. Past Sarvam's 30-second ceiling this is simply wrong in the
     * safe direction: it routes to OpenAI, which is where a long recording was
     * going anyway. */
    seconds: config["voice.maxSeconds"],
    provider: config["voice.transcriptionProvider"],
    fallbackToOpenai: config["voice.fallbackToOpenai"],
    sarvamModel: config["voice.transcriptionModel"],
    openaiTranscriptionModel: config["voice.openaiTranscriptionModel"],
    languageModel: config["voice.languageModel"],
  });

  if (!heard.ok) return;

  await db
    .update(mbosVisits)
    .set({
      transcript: heard.english,
      transcriptIsAi: true,
      updatedAt: new Date(),
      updatedById: principal.user.id,
    })
    .where(eq(mbosVisits.id, visit.id));
}

/* ------------------------------------------------------------------ helpers */

function validationRejection(error: z.ZodError): Handled {
  const first = error.issues[0];
  const where = first?.path?.length ? ` (${first.path.join(".")})` : "";
  return {
    kind: "rejected",
    value: reject(
      "validation",
      `This record could not be saved: ${first?.message ?? "it is not the shape the server expects"}${where}. Nothing was written — correct it on the handset and send it again.`,
    ),
  };
}
