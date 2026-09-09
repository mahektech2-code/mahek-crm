import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  attachmentParentEnum,
  attachments,
  bills,
  complaints,
  customerDistributors,
  distributorProfiles,
  customers,
  syncConflicts,
  mbosApprovals,
  mbosAttendanceDays,
  mbosConflicts,
  mbosDevices,
  mbosExpenseDays,
  mbosExpenseExceptions,
  mbosExpenses,
  mbosTravelLegs,
  mbosTravelModes,
  mbosActivityLocations,
  mbosJourneyPlans,
  mbosJourneyStops,
  mbosCompetitorRecords,
  mbosInternalNotes,
  mbosLeadValidations,
  mbosLeaveRequests,
  mbosTours,
  mbosSamples,
  sampleFeedback,
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
import { MBOS_EVENT, writeTimelineEvent, type TimelineWriter } from "../timeline";
import { APP_TIMEZONE, calendarDate } from "../business-date";
import { qualifyLead } from "../services/lead-qualification-service";
import { convertLeadOnSecondOrder } from "../services/lead-conversion-service";
import { canAny, grantingRole, rolesFor, scopedToUsers } from "../access-control";
import {
  applyLeadStageMove,
  evaluateLeadStageMove,
  leadGateInput,
  leadRow,
} from "../services/lead-service";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { getConfig } from "../config/store";
import { financialYearOf } from "../financial-year";
import { metresBetween } from "../geo";
import { today, recomputeOutstanding, recomputeLastContact } from "../recompute";
import { allocate, type AllocatableBill } from "../engines/allocation";
import { computeHealth, type HealthFacts } from "../engines/health";
import { fileStorage } from "../storage";
import { classOfCity } from "../services/expense-policy-service";
import { ensureDay } from "../services/expense-service";
import { submitDay } from "../services/expense-submit-service";
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
import {
  LEAVE_TYPES,
  type LeaveType,
  type RejectionCode,
  type SyncEntityType,
  type SyncItem,
  type SyncResult,
} from "../mbos/types";
import {
  leaveWorkingDays,
  MAX_LEAVE_SPAN_DAYS,
  type LeaveCalendar,
} from "../engines/leave";
import { notifyUsers } from "../notify";

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
  /* ONE LEAD, so a lead dependency is looked up in `customers` like the
   * customer one below it. Leaving this pointing at `mbos_leads` would make
   * every visit or order queued against a lead wait for a row that is never
   * written again — a retry loop with nothing at either end to explain it. */
  lead: "customers",
  lead_validation: "mbos_lead_validations",
  internal_note: "mbos_internal_notes",
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
    case "lead_validation":
      return handleLeadValidation(principal, item);
    case "internal_note":
      return handleInternalNote(principal, item);
    case "approval":
      return handleApproval(principal, item);
    case "plan_day":
      return handlePlanDay(principal, item);
    case "plan_stops":
      return handlePlanStops(principal, item);
    case "expense_day":
      return handleExpenseDay(principal, item);
    case "travel_leg":
      return handleTravelLeg(principal, item);
    case "expense_day_submit":
      return handleExpenseDaySubmit(principal, item);
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
  /** Null on a real customer. Non-null means this record is still a lead. */
  leadStage: string | null;
  ownerId: string | null;
  salesAmId: string | null;
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
      leadStage: customers.leadStage,
      /* Whose book it is, carried so a conversion can move the sales seat
         through `assignedUserId` rather than re-deriving a fallback. */
      ownerId: customers.ownerId,
      salesAmId: customers.salesAmId,
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
  /*
   * THE SUSPECT DECISION, answered on the visit that demanded it.
   *
   * `suspectDecision` is what the salesman chose — moving the lead on, or
   * keeping it a Suspect — and `suspectReason` is why, which is mandatory for
   * the second. They ride on the visit rather than on a separate lead update
   * because the answer and the visit that prompted it are one act: sending
   * them apart is how a visit lands with the decision lost to a failed second
   * request.
   */
  suspectDecision: z
    .enum(["contacted", "qualified", "on_hold", "lost", "still_suspect"])
    .nullish(),
  suspectReason: z.string().max(500).nullish(),
  /*
   * §G — what the requirement visit is FOR.
   *
   * The same three facts the lead form asks for, asked again by somebody
   * standing in the shop with the price list in his hand. They overwrite the
   * lead's own columns deliberately, unlike the validation call's `confirmed*`
   * answers: this is the same person asking the same question better informed,
   * not a second party's account of it.
   */
  requirement: z.string().max(1000).nullish(),
  monthlyVolumeLitres: z.number().int().nonnegative().nullish(),
  quantityCans: z.number().int().nonnegative().nullish(),
});

async function handleVisit(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = visitSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  const config = await getConfig();

  /*
   * A SUSPECT CANNOT BE VISITED FOR EVER, and the cap is a QUESTION rather
   * than a refusal.
   *
   * §B asks for a maximum of three visits "enforced". Enforced as a block is
   * the one shape this app must not use: `engines/geo.ts` states the principle
   * the whole field product rests on — a reading is evidence, never a gate —
   * because a salesman whose visit is refused stops recording visits, and the
   * company loses the GPS, the competitor note and the reason in order to stop
   * a number reaching four. The business outcome §B actually wants is that
   * nobody keeps visiting a shop nobody has decided about, and that is bought
   * by demanding an ANSWER, not by refusing the work.
   *
   * So: the visit is always saved. What is required at the cap is that the
   * salesman says which way it goes — and if the answer is "still a Suspect",
   * that he says why. Beyond the cap the lead escalates to the manager, which
   * is where an undecidable lead belongs anyway.
   *
   * Only leads, and only leads still at the top of the ladder. A qualified
   * prospect being visited a fourth time is a negotiation, not a stall.
   */
  const suspectStages = ["new", "contacted"];
  /* The working day in Asia/Kolkata, for the lead's own staleness clock — a
     visit is activity, so it has to move that date whichever way the decision
     went. Read once here rather than inside the transaction. */
  const day = await today();
  if (customer.leadStage && suspectStages.includes(customer.leadStage)) {
    const [seen] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(mbosVisits)
      .where(eq(mbosVisits.customerId, customer.id));
    /* The visit being saved is not in the table yet, so it is the next one. */
    const thisVisit = Number(seen?.n ?? 0) + 1;
    const decideAt = config["mbos.leads.maxSuspectVisits"];

    if (thisVisit >= decideAt && !p.suspectDecision) {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `This is visit ${thisVisit} to ${customer.name} and they are still a Suspect. Say which way it goes before closing the visit — a prospect, on hold, or lost. The visit itself is recorded either way.`,
        ),
      };
    }
    if (
      p.suspectDecision === "still_suspect" &&
      !p.suspectReason?.trim()
    ) {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `Keeping ${customer.name} as a Suspect after ${thisVisit} visits needs a reason. Somebody will ask why we are still going.`,
        ),
      };
    }
  }

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
      eventType: MBOS_EVENT.visit,
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

    /*
     * THE DECISION IS PART OF THE VISIT, so it is written in the visit's own
     * transaction.
     *
     * A visit that saved and a decision that failed a moment later would leave
     * the lead exactly where it was and the salesman believing he had answered
     * — and the next visit would demand the same answer again. Half-saved
     * calls are how telecaller data goes wrong; this is the same rule one app
     * over.
     */
    /* §G. Written in the visit's own transaction for the same reason the
       decision below is: a visit that saved and a requirement that did not
       would send the salesman back for something he had already asked. */
    if (
      p.requirement != null ||
      p.monthlyVolumeLitres != null ||
      p.quantityCans != null
    ) {
      await tx
        .update(customers)
        .set({
          ...(p.requirement != null ? { leadRequirement: p.requirement } : {}),
          ...(p.monthlyVolumeLitres != null
            ? { leadMonthlyVolumeLitres: p.monthlyVolumeLitres }
            : {}),
          leadLastActivityDate: day,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customer.id));

      /* §R. Keyed on the VISIT, so a requirement asked again on a later visit
         is a second entry rather than one that overwrites the first — what they
         said in March and what they say in September is a change worth seeing. */
      await writeTimeline(tx, {
        customerId: customer.id,
        eventType: MBOS_EVENT.requirement,
        sourceRecordId: item.entityId,
        occurredAt: checkInAt,
        actorUserId: principal.user.id,
        summary: [
          p.requirement?.trim(),
          p.monthlyVolumeLitres ? `${p.monthlyVolumeLitres} litres a month` : null,
          p.quantityCans ? `${p.quantityCans} cans to start` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }

    if (p.suspectDecision) {
      const stays = p.suspectDecision === "still_suspect";
      await tx
        .update(customers)
        .set({
          /* Staying a Suspect does not move the stage — it records why not.
             Everything else is a real move along the ladder. */
          ...(stays ? {} : { leadStage: p.suspectDecision as "contacted" }),
          ...(p.suspectReason?.trim()
            ? p.suspectDecision === "lost"
              ? { leadLostReason: p.suspectReason.trim() }
              : { leadHoldReason: p.suspectReason.trim() }
            : {}),
          leadLastActivityDate: day,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customer.id));
    }
  });

  /*
   * PAST THE CAP, THE MANAGER IS TOLD.
   *
   * This is the half of §B that a refusal was standing in for. A lead being
   * visited a fourth time while still a Suspect is not a salesman to be
   * blocked, it is a judgement somebody senior should look at — the shop may
   * be worth the persistence, or the salesman may be walking a comfortable
   * beat. Either way it is a conversation, and a conversation needs somebody
   * to have been told.
   *
   * Outside the transaction and unable to fail the visit: a notification is a
   * courtesy on top of a completed write, never a reason to lose one.
   */
  /* The same hook, from the other door. A lead qualified by answering the
   * visit's own decision must start §D and §E exactly as one qualified from the
   * lead screen does — a workflow that fires on one of two paths is a workflow
   * salesmen learn not to rely on. */
  if (p.suspectDecision === "qualified") {
    await qualifyLead(customer.id, principal.user.id, customer.name).catch(() => {});
  }

  if (customer.leadStage && suspectStages.includes(customer.leadStage)) {
    const decideAt = config["mbos.leads.maxSuspectVisits"];
    const [after] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(mbosVisits)
      .where(eq(mbosVisits.customerId, customer.id));
    if (Number(after?.n ?? 0) > decideAt) {
      await notifyManagers(
        principal.user.id,
        "A Suspect is still being visited",
        `${principal.user.name} has now visited ${customer.name} ${after.n} times and it is still a Suspect. Worth a look — either the shop is worth the persistence or the beat is.`,
      ).catch(() => {});
    }
  }

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------------------ orders */

/**
 * §M and §N — an order after somebody has agreed to it.
 *
 * Three parties again, and none of their words is another's: `status` is OURS
 * (accounts accepted it, the godown sent it, the lorry has it),
 * `customerConfirmedAt` is the SHOP agreeing to what was written down, and
 * `deliveryConfirmedAt` is the shop saying the goods came. They are routinely
 * days apart and either confirmation can precede the other.
 */
const orderProgressSchema = z.object({
  /** Ours. `captured`/`pending_approval` are not settable from a handset. */
  status: z.enum(["dispatched", "in_transit", "delivered"]).nullish(),
  customerConfirmedAt: z.number().nullish(),
  customerConfirmedNote: z.string().max(500).nullish(),
  deliveryConfirmedAt: z.number().nullish(),
  /** What actually turned up, where it was not what was sent. */
  deliveryDiscrepancy: z.string().max(1000).nullish(),
});

async function handleOrderProgress(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = orderProgressSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const [existing] = await db
    .select({
      id: orders.id,
      customerId: orders.customerId,
      status: orders.status,
      approvedAt: orders.approvedAt,
    })
    .from(orders)
    .where(eq(orders.id, item.entityId))
    .limit(1);

  if (!existing) {
    return {
      kind: "retry",
      message:
        "That order has not reached the office yet, so there is nothing to move along. It will be tried again once it has.",
    };
  }

  const found = await scopedCustomer(principal, existing.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  /*
   * A DECLINED OR CANCELLED ORDER IS NOT DISPATCHED, whatever a handset that
   * has not caught up believes.
   *
   * The salesman's phone may still be showing an order accounts turned down
   * ten minutes ago — the rejection reaches it on the next pull — and marking
   * it delivered would resurrect a sale the business refused into every figure
   * `PURCHASE_STATUSES` feeds. The mark is the office's decision, so the
   * office's decision wins.
   */
  if (p.status && (existing.status === "declined" || existing.status === "cancelled")) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `That order for ${customer.name} was ${existing.status === "declined" ? "declined by accounts" : "cancelled"}, so it cannot be marked ${p.status.replace("_", " ")}. Ring them before anything is delivered.`,
      ),
    };
  }

  const changed: Partial<typeof orders.$inferInsert> = { updatedAt: new Date() };
  if (p.status != null) changed.status = p.status;
  if (p.customerConfirmedAt != null) {
    changed.customerConfirmedAt = new Date(p.customerConfirmedAt);
  }
  if (p.customerConfirmedNote != null) {
    changed.customerConfirmedNote = p.customerConfirmedNote;
  }
  if (p.deliveryDiscrepancy != null) {
    changed.deliveryDiscrepancy = p.deliveryDiscrepancy;
  }
  /* Who reported the arrival, stored with the fact — a confirmation with
     nobody behind it is the same shape as a payment nobody vouched for. */
  if (p.deliveryConfirmedAt != null) {
    changed.deliveryConfirmedAt = new Date(p.deliveryConfirmedAt);
    changed.deliveryConfirmedById = principal.user.id;
  }

  await db.update(orders).set(changed).where(eq(orders.id, item.entityId));

  /* §R — the delivery, which B3-09 also named as unbuildable and which Phase 5
     gave a record to project from. Written on the SHOP's confirmation rather
     than on our own status, because that is the assertion worth a line in a
     history somebody reads before ringing them. */
  if (p.deliveryConfirmedAt != null) {
    await writeTimeline(db, {
      customerId: customer.id,
      eventType: MBOS_EVENT.delivery,
      sourceRecordId: item.entityId,
      occurredAt: new Date(p.deliveryConfirmedAt),
      actorUserId: principal.user.id,
      summary: p.deliveryDiscrepancy?.trim()
        ? `Delivery confirmed, with a problem: ${p.deliveryDiscrepancy.trim()}`
        : "Delivery confirmed by the customer",
    }).catch(() => {});
  }

  /*
   * A short or damaged delivery is told to the people who can do something
   * about it, rather than sitting in a column somebody reads next month. It is
   * NOT auto-raised as a complaint: a complaint is the customer's, with a
   * category and photographs, and inventing one on their behalf from a note
   * would put words in their mouth on a record they can dispute.
   */
  if (p.deliveryDiscrepancy?.trim()) {
    await notifyManagers(
      principal.user.id,
      "A delivery did not match the order",
      `${customer.name}: ${p.deliveryDiscrepancy.trim()}`,
    ).catch(() => {});
  }

  return { kind: "accepted", value: { serverId: item.entityId } };
}

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
  if (item.op === "update") return handleOrderProgress(principal, item);

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
   * AN ORDER ON A LEAD CONVERTS IT. It does not refuse it.
   *
   * This gate used to reject an order against a lead below `negotiation`,
   * reading §G's "no price negotiation at the requirement stage" as "no order
   * until the ladder says so". Mahek's answer is the opposite and it is theirs
   * to give: a shop that is ready to buy is a customer, whatever rung somebody
   * had filed it under, and a salesman standing in front of one with an order
   * in his hand must not be told to come back later.
   *
   * The stage machinery is not wasted by that. §L still opens negotiation off
   * an approved sample, the tasks still fire, and `lead_stage` still records
   * how the account was won — what has gone is only the refusal.
   *
   * The conversion itself is `lead-conversion-service`, the SAME function the
   * CRM's interaction save uses. Two copies of "what happens when a lead
   * orders" would drift within a release, and the half that drifts is the one
   * nobody is watching — which here is the handset.
   */

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

    /*
     * AND IF THIS WAS A LEAD, IT IS A CUSTOMER NOW.
     *
     * Inside the order's own transaction, deliberately: an order that landed
     * against a record still reading `kind = 'lead'` is an invoice on an
     * account with no buying cycle, no outstanding and no target — five
     * subsystems reading a column that has stopped meaning what it says. The
     * two either both happen or neither does.
     *
     * On the SECOND order, which is §Q as the client has corrected it — a
     * first order from a shop that has just finished a trial is a few cans to
     * try in their own booth, and it routinely does not repeat. The order just
     * written is passed so it can be excluded from that count by id: the
     * question is strictly whether this account has ordered BEFORE, and what
     * counts as an order is `lib/order-status.ts`, never a status literal.
     *
     * `customerSince` is the day the order is FOR rather than today, because a
     * salesman may state a past date and the account began when it began.
     */
    const convertedOn = (
      await tx.execute<{ d: string }>(sql`
        select ((${orderedAtIso}::timestamptz at time zone ${APP_TIMEZONE})::date)::text as d
      `)
    )[0]?.d;
    if (customer.leadStage !== null && convertedOn) {
      await convertLeadOnSecondOrder(
        tx,
        {
          id: customer.id,
          kind: "lead",
          ownerId: customer.ownerId ?? null,
          salesAmId: customer.salesAmId ?? null,
          leadSource: null,
        },
        convertedOn,
        principal.user.id,
        `ordered in the field (${serverNumber})`,
        item.entityId,
      );
    }

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
      eventType: MBOS_EVENT.order,
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
      eventType: MBOS_EVENT.payment,
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
      eventType: MBOS_EVENT.complaint,
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

/*
 * A MARK ON AN EXISTING SAMPLE IS NOT A HANDOVER, and parsing both with this
 * schema rejected every one of them.
 *
 * `handleSample` ran the full non-partial schema over every `sample` item, so a
 * courier docket — which carries a sample id and a docket and nothing else —
 * failed on a missing `customerId` and came back to the salesman as though the
 * docket itself were invalid. Sending the customer id along to get past it was
 * the workaround the handset reached for, and it made the real bug worse: the
 * insert is `onConflictDoNothing`, so each mark wrote another "Sample handed to
 * X" line onto the customer's timeline.
 *
 * `sampleUpdateSchema` is the update branch, and `handleSample` routes on
 * `item.op` the way `handleLead` already does.
 */
const sampleUpdateSchema = z.object({
  state: z
    .enum([
      "requested",
      "approved",
      "rejected",
      "dispatched",
      "received",
      "trial_done",
      "reviewed",
      "cancelled",
    ])
    .nullish(),
  reasonCode: z.string().max(80).nullish(),
  application: z.string().max(500).nullish(),
  /*
   * WE SENT IT, THE CARRIER CARRIED IT, THEY CONFIRMED IT — three assertions by
   * three parties, and the columns keep them apart the way `payment_receipts`
   * keeps a reported payment apart from a confirmed one. `dispatchedAt` is our
   * own claim, `deliveredAt` is what the carrier says, and `receivedAt` is the
   * shop's word. §J turns entirely on the third: a single delivery date could
   * never tell a sample in transit from one nobody had picked up.
   *
   * `courierDocket` and `trackingNumber` are BOTH here rather than one folded
   * into the other. They reached the office from two different builds and the
   * columns are two — collapsing them would make every docket already stored
   * unreadable by whichever name lost.
   */
  dispatchedAt: z.number().nullish(),
  courierName: z.string().max(200).nullish(),
  courierDocket: z.string().max(120).nullish(),
  trackingNumber: z.string().max(120).nullish(),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  receivedConfirmedAt: z.number().nullish(),
  /** The CUSTOMER's word that it arrived — see the column comment. */
  receivedAt: z.number().nullish(),
  trialStartedAt: z.number().nullish(),
  trialCompletedAt: z.number().nullish(),
  deliveredAt: z.number().nullish(),
  deliveryPhotoId: z.string().nullish(),
  followUpDate: z.string().nullish(),
  feedbackNotes: z.string().max(2000).nullish(),
  /** How the shop found it, in their own words rather than a score. */
  satisfaction: z.string().max(200).nullish(),
  /** What else they asked for while we had their attention. */
  additionalRequirement: z.string().max(1000).nullish(),
  /* §K — demanded on a rejection by the rule in `handleSampleUpdate`, never by
     the schema: the column is null on every sample nobody has decided yet. */
  rejectionReason: z.string().max(500).nullish(),
  trialOutcome: z.enum(["pending", "approved", "rejected", "more_testing"]).nullish(),
  /* §16 — the seven, where the review was taken on the phone. */
  feedback: z
    .object({
      quality: z.string().max(1000).nullish(),
      performance: z.string().max(1000).nullish(),
      application: z.string().max(1000).nullish(),
      drying: z.string().max(1000).nullish(),
      competitorComparison: z.string().max(1000).nullish(),
      priceFeedback: z.string().max(1000).nullish(),
      otherComments: z.string().max(1000).nullish(),
    })
    .nullish(),
});

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

/**
 * A mark on a sample that already exists — a docket, a delivery, a review.
 *
 * §I, §J and §K, and the reason it is a schema of its own: the two carry
 * different payloads and were being parsed by one. A docket arrives with a
 * sample id and a courier and no `customerId`, which the non-partial
 * `sampleSchema` refused — and the salesman was told his docket was invalid.
 * Working around it by sending the customer id along made it worse rather than
 * better: the handover path's insert is `onConflictDoNothing`, so it did not
 * fail, it quietly wrote another "Sample handed to X" line onto the customer's
 * timeline for every mark.
 *
 * Partial like every other update. What is NOT partial is the rule below it: a
 * rejection has to say why, because a sample rejected with nothing written down
 * teaches nobody anything and the next one goes out exactly the same.
 *
 * The state machine itself is `lib/actions/lead-samples.ts` and is not
 * duplicated here. This writes the columns the salesman established in the
 * field and lets the office's own transitions own the approvals.
 */
async function handleSampleUpdate(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = sampleUpdateSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const [existing] = await db
    .select({
      id: mbosSamples.id,
      customerId: mbosSamples.customerId,
      salesmanId: mbosSamples.salesmanId,
      dispatchedAt: mbosSamples.dispatchedAt,
      receivedAt: mbosSamples.receivedAt,
      trialOutcome: mbosSamples.trialOutcome,
      rejectionReason: mbosSamples.rejectionReason,
    })
    .from(mbosSamples)
    .where(eq(mbosSamples.id, item.entityId))
    .limit(1);

  /* A retry rather than a rejection: the handover is a separate outbox item and
     may simply not have drained yet. The same answer `handleLeadUpdate` gives
     for a lead that has not reached the office. */
  if (!existing) {
    return {
      kind: "retry",
      message:
        "That sample has not reached the office yet, so there is nothing to move along. It will be tried again once it has.",
    };
  }

  const found = await scopedCustomer(principal, existing.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  /*
   * §K — A REJECTION HAS TO SAY WHY.
   *
   * The same rule as a lost lead and an On Hold, and for the same reason: a
   * sample turned down with nothing written down teaches nobody anything, and
   * the next one goes out exactly the same. It reads what is already stored as
   * well as what arrived, so a verdict recorded a second time does not demand
   * the reason again. `more_testing` is deliberately outside it — "try it on a
   * different substrate" is an opinion rather than a refusal, and demanding a
   * rejection reason for one would be asking why about something nobody
   * rejected.
   */
  if (
    p.trialOutcome === "rejected" &&
    !(p.rejectionReason ?? existing.rejectionReason)?.trim()
  ) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `The sample to ${customer.name} was marked rejected with no reason. Say what was wrong with it — the next one goes out the same otherwise.`,
      ),
    };
  }

  const changed: Partial<typeof mbosSamples.$inferInsert> = { updatedAt: new Date() };
  if (p.state != null) changed.state = p.state;
  if (p.reasonCode != null) changed.reasonCode = p.reasonCode;
  if (p.application != null) changed.application = p.application;
  if (p.courierName != null) changed.courierName = p.courierName;
  if (p.expectedDeliveryDate != null) changed.expectedDeliveryDate = p.expectedDeliveryDate;
  if (p.trialCompletedAt != null) changed.trialCompletedAt = new Date(p.trialCompletedAt);
  if (p.deliveredAt != null) changed.deliveredAt = new Date(p.deliveredAt);
  if (p.deliveryPhotoId != null) changed.deliveryPhotoId = p.deliveryPhotoId;
  if (p.followUpDate != null) changed.followUpDate = p.followUpDate;
  if (p.feedbackNotes != null) changed.feedbackNotes = p.feedbackNotes;
  if (p.trialOutcome != null) changed.trialOutcome = p.trialOutcome;
  if (p.dispatchedAt != null) changed.dispatchedAt = new Date(p.dispatchedAt);
  /*
   * TWO NAMES, ONE COLUMN — see the schema, which says the same thing from the
   * other end. Two teams built §15 at once and each named the docket and the
   * customer's confirmation for itself; the columns were merged, and the WIRE
   * cannot be, because an APK in somebody's pocket goes on sending whichever
   * word its build was written with. Whichever arrives is written to the one
   * column, and `??` rather than an if-chain so a payload carrying both cannot
   * land two different answers about one fact.
   */
  const docket = p.trackingNumber ?? p.courierDocket;
  if (docket != null) changed.trackingNumber = docket;
  const confirmed = p.receivedConfirmedAt ?? p.receivedAt;
  if (p.trialStartedAt != null) changed.trialStartedAt = new Date(p.trialStartedAt);
  if (p.satisfaction != null) changed.satisfaction = p.satisfaction;
  if (p.additionalRequirement != null) {
    changed.additionalRequirement = p.additionalRequirement;
  }
  if (p.rejectionReason != null) changed.rejectionReason = p.rejectionReason;
  /* Who said it arrived, recorded with the fact. A confirmation with nobody
     behind it is the same shape as a payment nobody vouched for. */
  if (confirmed != null) {
    changed.receivedAt = new Date(confirmed);
    changed.receivedReportedById = principal.user.id;
  }

  await db.update(mbosSamples).set(changed).where(eq(mbosSamples.id, item.entityId));

  /* §16 — one review per sample. A second opinion is a second sample, which is
     what the unique index says, so a re-sent item updates rather than duplicates. */
  if (p.feedback) {
    const f = Object.fromEntries(
      Object.entries(p.feedback).filter(([, v]) => v != null),
    );
    if (Object.keys(f).length) {
      await db
        .insert(sampleFeedback)
        .values({
          id: `sfb_${randomUUID().slice(0, 12)}`,
          sampleId: item.entityId,
          customerId: existing.customerId,
          ...f,
          recordedById: principal.user.id,
        })
        .onConflictDoUpdate({
          target: sampleFeedback.sampleId,
          set: { ...f, recordedAt: new Date(), recordedById: principal.user.id },
        });
    }
  }


  /*
   * §R — B3-09 named these as unbuildable because there was no record to
   * project from. There is now: Phase 4 gave a sample a dispatch and a
   * confirmed receipt, so the two entries the brief asks for have sources.
   *
   * `sourceRecordId` carries the STAGE as well as the id, because the natural
   * key is (app, kind, source row) and three events about one sample would
   * otherwise collapse onto one row — the first written would win and the
   * receipt would never appear.
   */
  if (p.dispatchedAt != null) {
    await writeTimeline(db, {
      customerId: customer.id,
      eventType: MBOS_EVENT.sampleDispatched,
      sourceRecordId: `${item.entityId}:dispatched`,
      occurredAt: new Date(p.dispatchedAt),
      actorUserId: principal.user.id,
      summary: `Sample sent${p.courierName ? ` by ${p.courierName}` : ""}${docket ? ` (${docket})` : ""}`,
    }).catch(() => {});
  }
  if (confirmed != null && !existing.receivedAt) {
    await writeTimeline(db, {
      customerId: customer.id,
      eventType: MBOS_EVENT.sampleReceived,
      sourceRecordId: `${item.entityId}:received`,
      occurredAt: new Date(confirmed),
      actorUserId: principal.user.id,
      summary: "Customer confirmed the sample arrived",
    }).catch(() => {});
  }
  if (p.trialOutcome && p.trialOutcome !== "pending") {
    await writeTimeline(db, {
      customerId: customer.id,
      eventType: MBOS_EVENT.sampleReview,
      sourceRecordId: `${item.entityId}:review`,
      occurredAt: new Date(),
      actorUserId: principal.user.id,
      /* Three verdicts, not two. `more_testing` is the answer the two-value
         version could not give — a trial that happened and produced an opinion
         — and folding it into the `else` would have printed "Sample rejected"
         on a customer who asked to try it again. */
      summary:
        p.trialOutcome === "approved"
          ? `Sample approved${p.satisfaction ? ` — ${p.satisfaction}` : ""}`
          : p.trialOutcome === "more_testing"
            ? `More testing wanted${p.satisfaction ? ` — ${p.satisfaction}` : ""}`
            : `Sample rejected: ${p.rejectionReason ?? existing.rejectionReason ?? "no reason recorded"}`,
    }).catch(() => {});
  }

  /* §J — dispatched and not yet confirmed. Raised on the TRANSITION, so a
     re-sent dispatch date does not stack a second chase on somebody's list. */
  if (p.dispatchedAt != null && !existing.dispatchedAt) {
    await afterSampleDispatched(
      principal,
      existing.id,
      customer.id,
      customer.name,
      new Date(p.dispatchedAt),
      p.courierName ?? null,
      docket ?? null,
    ).catch(() => {});
  }

  /* Confirmed received starts the review clock — §K's "review call every 2–3
     days". Raised once, on the transition, so a re-sent confirmation does not
     stack a second task on somebody's list. */
  if (confirmed != null && !existing.receivedAt) {
    /*
     * AND IT ANSWERS THE CHASE. The question "where did this parcel get to"
     * has just been answered by the shop, so leaving its task open puts work
     * on somebody's list that is already done — which is how a task list stops
     * being read. Closed before the review is raised, so the two never sit
     * there together saying opposite things about the same sample.
     */
    await closeTransitChase(existing.id, principal.user.id).catch(() => {});
    await afterSampleReceived(principal, existing.id, customer.id, customer.name).catch(
      () => {},
    );
  }

  /* A verdict, and both people who care are told. */
  if (p.trialOutcome && p.trialOutcome !== "pending" && existing.trialOutcome === "pending") {
    await afterSampleVerdict(
      existing.id,
      customer.id,
      customer.name,
      existing.salesmanId,
      p.trialOutcome,
      p.rejectionReason ?? null,
    ).catch(() => {});
  }

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/**
 * §J — WHERE DID THE PARCEL GET TO, and who is asked.
 *
 * THE SEAT §J NAMES IS "LOGISTICS", AND MAHEKONE ALREADY HAS IT — it is just
 * not called that. `back_office_am_id` is dispatch, billing and paperwork; the
 * back office team are the people who put things on lorries and chase them.
 * Reading the brief's word as a role to be invented is what kept this item
 * unbuilt: a fifth `users.role` value would have been a new way to see the
 * whole company's book (see the note on `customer.handOver`), to model a seat
 * that has existed since the second account manager column shipped.
 *
 * WHERE NOBODY HOLDS THAT SEAT the task still has to land somewhere, and it
 * goes to the Lead Manager — but the description SAYS it came here because no
 * back office person is named. That distinction is the whole objection this
 * item was parked on: quietly moving a job the brief puts elsewhere is
 * dishonest, and naming why it moved is not. It also turns the gap into
 * something somebody can fix, which a silent fallback never does.
 *
 * `back_office_am_id` and not `back_office_name`: a task needs somebody who can
 * sign in and close it, and that column is a name the customer master states
 * for a person who may have no login at all.
 */
async function afterSampleDispatched(
  principal: MbosPrincipal,
  sampleId: string,
  customerId: string,
  customerName: string,
  dispatchedAt: Date,
  courierName: string | null,
  trackingNumber: string | null,
): Promise<void> {
  const config = await getConfig();
  const [seats] = await db
    .select({
      backOfficeAmId: customers.backOfficeAmId,
      backOfficeName: customers.backOfficeName,
      leadManagerId: customers.leadManagerId,
      ownerId: customers.ownerId,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  const logistics = seats?.backOfficeAmId ?? null;
  const assignee = logistics ?? seats?.leadManagerId ?? seats?.ownerId;
  if (!assignee) return;

  const days = config["mbos.samples.transitChaseAfterDays"];
  /* `calendarDate`, not `toISOString().slice(0, 10)` — that spelling answers in
     UTC, so a chase scheduled at 2am IST lands on the previous day, wrong on
     every machine equally. The §11 grep test guards it. Dated from DISPATCH
     rather than from now, because a dispatch is routinely recorded a day late
     from a phone that was offline, and the parcel does not wait for the sync. */
  const due = calendarDate(new Date(dispatchedAt.getTime() + days * 86_400_000));

  const carrier = [courierName, trackingNumber].filter(Boolean).join(" · ");
  const standingIn = logistics
    ? ""
    : " This is on your list because no back office person is named on this account — naming one sends the next chase to them.";

  await db
    .insert(mbosTasks)
    .values({
      id: gen("mbos_task"),
      title: `Where is the sample — ${customerName}`,
      description:
        `Sent${carrier ? ` by ${carrier}` : ""}, and the shop has not confirmed it arrived. Find out where it is, and either get it moving or send another. Mark the sample received once they say they have it.${standingIn}`,
      assignedToUserId: assignee,
      priority: "medium",
      dueDate: due,
      customerId,
      status: "open",
      /* The natural key with `sourceId` below: one chase per sample, so a
         re-sent dispatch cannot stack a second. */
      sourceType: "sample_in_transit",
      sourceId: sampleId,
      createdById: principal.user.id,
      updatedById: principal.user.id,
    })
    .onConflictDoNothing();

  await db
    .insert(notifications)
    .values({
      id: gen("ntf"),
      userId: assignee,
      title: "A sample is on its way",
      body: `${customerName} is expecting a sample${carrier ? ` (${carrier})` : ""}. If they have not confirmed it by ${due}, chase it.`,
      kind: "info",
    })
    .catch(() => {});
}

/**
 * The chase, answered.
 *
 * `done` rather than deleted, and the row keeps its `sourceId`, because "we
 * asked where this parcel was and then it arrived" is the record of a sample
 * that went slowly — which is the only way anybody ever finds out a courier is
 * the problem. A deleted task leaves a lead that converted late and nothing
 * saying why.
 */
async function closeTransitChase(sampleId: string, actorId: string): Promise<void> {
  await db
    .update(mbosTasks)
    .set({ status: "done", completedAt: new Date(), updatedById: actorId, updatedAt: new Date() })
    .where(
      and(
        eq(mbosTasks.sourceType, "sample_in_transit"),
        eq(mbosTasks.sourceId, sampleId),
        eq(mbosTasks.status, "open"),
      ),
    );
}

/**
 * §K — the review call, once the shop actually has the sample.
 *
 * Dated from CONFIRMED RECEIPT and not from dispatch, which is the whole reason
 * `received_at` exists: a review call timed from the day we posted it rings a
 * customer who is still waiting for the parcel, and that call teaches them we
 * do not know where our own stock is.
 *
 * It goes to the Lead Manager, who runs the conversion — §K says so — falling
 * back to the salesman where a lead has no manager yet.
 */
async function afterSampleReceived(
  principal: MbosPrincipal,
  sampleId: string,
  customerId: string,
  customerName: string,
): Promise<void> {
  const config = await getConfig();
  const [lead] = await db
    .select({ leadManagerId: customers.leadManagerId, ownerId: customers.ownerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  const assignee = lead?.leadManagerId ?? lead?.ownerId;
  if (!assignee) return;

  const days = config["mbos.samples.reviewAfterDays"];
  /*
   * `calendarDate`, not `toISOString().slice(0, 10)`.
   *
   * That spelling answers in UTC, so a review scheduled at 2am IST lands on the
   * previous day — and unlike the SQL version of this mistake it is wrong on
   * every machine equally, so it never looks like a timezone bug. The §11 grep
   * test caught this one.
   */
  const due = calendarDate(new Date(Date.now() + days * 86_400_000));

  await db
    .insert(mbosTasks)
    .values({
      id: gen("mbos_task"),
      title: `Sample review — ${customerName}`,
      description:
        "Have they started the trial? How did it perform, and what did they make of the quality? Anything wrong with it, and is there anything else they need. Then say approved or rejected — a rejection has to say why.",
      assignedToUserId: assignee,
      priority: "medium",
      dueDate: due,
      customerId,
      status: "open",
      sourceType: "sample_review",
      sourceId: sampleId,
      createdById: principal.user.id,
      updatedById: principal.user.id,
    })
    .onConflictDoNothing();

  await db
    .insert(notifications)
    .values({
      id: gen("ntf"),
      userId: assignee,
      title: "A sample reached the customer",
      body: `${customerName} has the sample. A review call is on your list for ${due}.`,
      kind: "info",
    })
    .catch(() => {});
}

/**
 * §K — the verdict, and the two people it changes work for.
 *
 * The Lead Manager decided it and the salesman has to act on it: approved sends
 * him back to negotiate, rejected tells him why before he hears it from the
 * shop. Notifying only one of them is how a salesman turns up to a shop that
 * turned us down last week.
 */
async function afterSampleVerdict(
  sampleId: string,
  customerId: string,
  customerName: string,
  salesmanId: string,
  outcome: string,
  reason: string | null,
): Promise<void> {
  const [lead] = await db
    .select({ leadManagerId: customers.leadManagerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  const approved = outcome === "approved";
  /*
   * THREE VERDICTS, because §15 gave the outcome a third value.
   *
   * "The customer wants to try it again on a different substrate" is neither an
   * approval nor a rejection, and a two-branch ternary would have notified the
   * salesman that his sample was REJECTED by a shop that had asked for another
   * one. It does not open negotiation either — the trial has not finished
   * saying anything yet.
   */
  const moreTesting = outcome === "more_testing";
  const title = approved
    ? "A sample was approved"
    : moreTesting
      ? "A sample needs more testing"
      : "A sample was rejected";
  const body = approved
    ? `${customerName} is happy with the trial. Negotiation is open — price, discount, credit and delivery are on the table now.`
    : moreTesting
      ? `${customerName} tried it and wants to test it again${reason ? `: ${reason}` : ""}. The sample is not settled either way yet.`
      : `${customerName} turned the sample down: ${reason ?? "no reason recorded"}.`;

  const targets = [salesmanId, lead?.leadManagerId].filter(
    (id, i, all): id is string => Boolean(id) && all.indexOf(id) === i,
  );
  if (targets.length) {
    await db
      .insert(notifications)
      .values(
        targets.map((userId) => ({
          id: gen("ntf"),
          userId,
          title,
          body,
          kind: "info",
        })),
      )
      .catch(() => {});
  }

  /*
   * §L — an approved sample OPENS negotiation, which is what unlocks the order
   * gate in `handleOrder`. It is the sample review that authorises a commercial
   * conversation, not the salesman deciding he is ready for one.
   */
  if (approved) {
    await db
      .update(customers)
      .set({ leadStage: "negotiation", updatedAt: new Date() })
      .where(and(eq(customers.id, customerId), eq(customers.leadStage, "qualified")));

    await writeTimeline(db, {
      customerId,
      eventType: MBOS_EVENT.negotiation,
      sourceRecordId: sampleId,
      occurredAt: new Date(),
      actorUserId: salesmanId,
      summary: "Negotiation opened — the sample came through",
    }).catch(() => {});

    /*
     * And the visit that spends it. A stage that opens and no work attached to
     * it is a lead that sits at `negotiation` for a month — the salesman was
     * told he may negotiate and nothing told him to go.
     */
    const day = await today();
    await db
      .insert(mbosTasks)
      .values({
        id: gen("mbos_task"),
        title: `Negotiation visit — ${customerName}`,
        description:
          "The sample came through, so price, discount, credit and delivery are open now. Anything past your approved discount goes up as an approval before you agree it.",
        assignedToUserId: salesmanId,
        priority: "high",
        dueDate: day,
        customerId,
        status: "open",
        sourceType: "negotiation_visit",
        sourceId: sampleId,
        createdById: salesmanId,
        updatedById: salesmanId,
      })
      .onConflictDoNothing();
  }
}

async function handleSample(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  if (item.op === "update") return handleSampleUpdate(principal, item);

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
      eventType: MBOS_EVENT.sample,
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
  /*
   * THE FUNNEL'S RUNGS, and the original six are still first.
   *
   * An APK cannot be recalled, so the wire has to keep meaning what it meant:
   * a handset that has never heard of the funnel goes on sending `new` and
   * `contacted` against a lead carrying no sales type, and that lead goes on
   * climbing `LEGACY_LADDER` exactly as it did. What is added is the
   * seventeen new values, which only a build that knows about them can send.
   */
  stage: z
    .enum([
      "new",
      "contacted",
      "qualified",
      "negotiation",
      /*
       * `on_hold` is on the WIRE and not on any ladder, which is why it sits
       * here and not in `LeadStage`. It is a legacy-ladder answer — a lead
       * somebody has parked with a reason — and the funnel has no rung for it;
       * the branch below stands it aside from the gate exactly as
       * `convertedCustomerId` is stood aside, because asking a ladder about a
       * stage that is not on it can only ever refuse.
       */
      "on_hold",
      "won",
      "lost",
      "suspect",
      "prospect",
      "qualification",
      "sample_trial",
      "sample_received",
      "sample_review",
      "first_order",
      "delivery",
      "payment",
      "second_order",
      "customer",
      "management_review",
      "commercial_discussion",
      "distributor_approval",
      "distributor_agreement",
      "initial_stock_order",
      "active_distributor",
    ])
    .nullish(),
  /* §2 — which of the three ways we are selling, and therefore which ladder. */
  salesType: z.enum(["direct", "distributor", "third_party"]).nullish(),
  /*
   * §26 §5 §28 — the CODE behind a move, from the matching configured list.
   *
   * Distinct from `lostReason` below, which is the free text this schema has
   * always carried and which older builds still send. Both are read: a code is
   * countable and a sentence is not, but refusing a loss because the handset in
   * somebody's pocket predates the list would lose the loss.
   */
  reasonCode: z.string().max(80).nullish(),
  /* §6 — the eight answers a Suspect owes before it may be a Prospect. */
  customerType: z
    .enum(["dealer", "manufacturer", "distributor", "retailer"])
    .nullish(),
  monthlyLitres: z.number().int().nonnegative().nullish(),
  competitor: z.string().max(200).nullish(),
  requiredProductId: z.string().nullish(),
  contactPerson: z.string().max(200).nullish(),
  decisionMaker: z.string().max(200).nullish(),
  creditDaysWanted: z.number().int().min(0).max(365).nullish(),
  application: z.string().max(500).nullish(),
  gstin: z.string().max(20).nullish(),
  /* §9 §11 — the checklist, keyed by condition id. Merged, never replaced. */
  qualification: z.record(z.string(), z.union([z.boolean(), z.string()])).nullish(),
  /*
   * §11 — the thirty a distributor answers, as the handset holds them.
   *
   * A field the handset SENDS and the schema does not name is stripped by
   * `safeParse` without a word, which is the quietest failure on this wire: the
   * salesman fills four screens standing in a godown, the sync says `accepted`,
   * and the office has nothing. Named here so it lands, and merged into
   * `distributor_profiles` rather than written over it — the office fills the
   * commercial half of that row and must not lose it to a phone that has never
   * seen those columns.
   */
  distributorProfile: z.record(z.string(), z.unknown()).nullish(),
  /*
   * §23 — the chain, named on the lead rather than reconstructed at conversion.
   *
   * `thirdParty` is the mark; the other two are who invoices the shop and which
   * of their own people covers it. AGENTS.md is explicit that no IMPORT may set
   * the mark — this is not an import, it is a salesman standing in the shop
   * saying who delivers to it, which is the one place the answer is actually
   * known.
   */
  thirdParty: z.boolean().nullish(),
  distributorCustomerId: z.string().nullish(),
  distributorSalesmanId: z.string().nullish(),
  /*
   * §18 — what the customer said when asked for the first order.
   *
   * LOAD-BEARING, and the reason this omission mattered more than the other
   * three: `gateTo(..., "first_order")` refuses without an expected date. With
   * the field stripped on the way in, a salesman could pass that rung on his own
   * phone — his copy of the engine had the date — and be refused at the office,
   * with the two halves of one engine disagreeing about one lead. An offline
   * gate is only worth having if the same answer survives the wire.
   */
  expectedOrderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  expectedOrderValuePaise: z.number().int().nonnegative().nullish(),
  /* §24 — what happens next, on what day, and who is doing it. */
  nextAction: z
    .object({
      action: z.string().min(1).max(300),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      ownerId: z.string().min(1),
      outcome: z.string().max(500).nullish(),
    })
    .nullish(),
  /*
   * §4 — that the Suspect question has been answered.
   *
   * Epoch milliseconds, like every other instant on this wire. It is sent
   * rather than derived because the salesman answers it standing in the shop
   * and the answer is his, not the server's guess from a stage that may have
   * arrived hours later.
   */
  suspectDecidedAt: z.number().nullish(),
  nextFollowUpDate: z.string().nullish(),
  notes: z.string().max(4000).nullish(),
  gpsLat: z.number().nullish(),
  gpsLng: z.number().nullish(),
  /* Where the shop is, in words. `city`/`area` are the filters; this is what
     somebody reads to find the door. */
  address: z.string().max(500).nullish(),
  requirement: z.string().max(1000).nullish(),
  /*
   * THE SAME ANSWER UNDER TWO NAMES, and both are accepted rather than one
   * chosen.
   *
   * `monthlyLitres` above is what the funnel build sends and what `openLeads`
   * sends back down; `monthlyVolumeLitres` is what the build already in
   * somebody's pocket sends up. An APK cannot be recalled, so dropping either
   * name would silently strip the answer off half the handsets in the field —
   * the quietest failure on this wire, since `safeParse` removes an unnamed
   * field without a word. One column, `lead_monthly_volume_litres`, written
   * from whichever arrived.
   */
  monthlyVolumeLitres: z.number().int().nonnegative().nullish(),
  /* An `attachments` id the media queue will fill in later — see
     `bindMbosMedia`. It routinely names a file whose bytes are still on the
     phone, which is why nothing here checks that it exists. */
  shopPhotoId: z.string().max(80).nullish(),
  /* The one competitor question worth asking cold. The full record — price,
     credit days, strengths — is `mbos_competitor_records`, asked on a visit. */
  competitorName: z.string().max(200).nullish(),
  /* §L — what was agreed once negotiation opened. On the customer rather than
     the order: terms are the standing arrangement, and the first order is
     priced under them rather than carrying them. */
  deliveryTerms: z.string().max(1000).nullish(),
  agreedTerms: z.string().max(2000).nullish(),
  lostReason: z.string().max(500).nullish(),
  /* Why a held or stuck lead is not moving. Demanded for `on_hold`, and for a
     lead the salesman is keeping as a Suspect past the decision visit. */
  holdReason: z.string().max(500).nullish(),
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

  const existing = await leadRow(item.entityId);
  /*
   * The hold reason is fetched BESIDE the lead rather than added to
   * `LEAD_COLUMNS`.
   *
   * That row is what every gate in `lead-gates.ts` reads, and `on_hold` is not
   * on any ladder — widening the shape every rung in the funnel is evaluated
   * against, to carry a legacy-ladder answer none of them consults, would put a
   * column in front of thirty callers to serve one. What it is for is the rule
   * below, which reads what is already stored so a lead held last week is not
   * asked for its reason again.
   */
  const [held] = existing
    ? await db
        .select({ holdReason: customers.leadHoldReason })
        .from(customers)
        .where(eq(customers.id, item.entityId))
        .limit(1)
    : [];

  if (!existing) {
    return {
      kind: "retry",
      message:
        "That lead has not reached the office yet, so there is nothing to change. It will be tried again once it has.",
    };
  }

  if (p.stage === "lost" && !p.lostReason && !p.reasonCode) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${existing.name} was marked lost with no reason. A loss nobody explained teaches nothing — reopen it and say what happened.`,
      ),
    };
  }

  /*
   * WHICH LADDER THIS LEAD IS ON DECIDES WHICH PATH IT TAKES, and that is what
   * lets the funnel land without touching a single lead raised before it.
   *
   * A lead carrying a sales type — one raised on a build that asks the §2
   * question, or one an office screen has since set — goes through the gates.
   * A lead carrying none is on `LEGACY_LADDER`, predates every rule in §28, and
   * takes exactly the path it has always taken: the stage is written, nothing
   * is asked. Demanding a next action to move a four-year-old lead would freeze
   * the book the rule was meant to unstick, which is the same reasoning
   * `gateTo` itself uses when it skips §24 for a lead with no sales type.
   */
  const salesType = (p.salesType ?? existing.leadSalesType) as LeadSalesType | null;
  const onTheFunnel = Boolean(salesType);
  /*
   * `convertedCustomerId` is the ONE LEAD promotion path and it takes
   * precedence over the ladder. It is what an older build sends to say "this
   * lead is won", and the branch below moves `kind` and parks the stage at
   * `won` — which is off every real ladder. Asking the gate about a rung after
   * that has happened would refuse the item as off-ladder and report a
   * conversion that in fact landed, so the funnel stands aside for it.
   */
  const movingStage =
    p.stage != null &&
    p.stage !== existing.leadStage &&
    p.convertedCustomerId == null &&
    /* And `on_hold` stands aside from the gate for the same reason a
       conversion does: it is on the wire and on no ladder, so asking a rung
       engine about it can only ever answer "off ladder" and refuse a park the
       salesman is entitled to. */
    p.stage !== "on_hold";

  /*
   * ON HOLD IS AN ANSWER, so it has to say something.
   *
   * Held and lost are different and that is the whole reason the status exists
   * — but they are alike in this: both are somebody deciding a lead is not
   * progressing, and a decision with no reason on it teaches the next person
   * nothing. Unlike lost, this one is reversible, which is exactly why the
   * reason matters: "back after Diwali" is what tells somebody when to look
   * again.
   */
  if (p.stage === "on_hold" && !(p.holdReason ?? held?.holdReason)?.trim()) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${existing.name} was put on hold with no reason. Say what you are waiting for — that is what tells anybody when to pick it up again.`,
      ),
    };
  }

  /*
   * QUALIFYING A LEAD ASKS FOR THE GST NUMBER, and it is asked HERE.
   *
   * §C of the brief makes GST mandatory at the Prospect transition, and the
   * form on the handset asks for it. A form is not a rule: this is a sync
   * endpoint, it accepts a payload from a device somebody owns, and an older
   * build that never learned to ask would otherwise qualify leads without one.
   *
   * Mandatory at the STAGE CHANGE and never on the column. 5,292 shops came in
   * from the EMP 2.0 master with no GSTIN between them, so a NOT NULL would
   * refuse the entire imported book — the constraint belongs on the moment
   * somebody asserts this is a real commercial prospect, not on the record.
   *
   * It reads what is already stored as well as what arrived, so a lead that was
   * given its number last week qualifies today without retyping it.
   */
  if (p.stage === "qualified") {
    const gstin = (p.gstin ?? existing.gstin ?? "").trim();
    if (!gstin) {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `${existing.name} cannot be qualified without a GST number. That is what makes them a business we can invoice — add it and try again.`,
        ),
      };
    }
  }

  const changed: Partial<typeof customers.$inferInsert> = {
    /* Any edit is contact, and staleness is measured from the last thing that
     * happened — so working a lead moves the clock whatever else it changed. */
    leadLastActivityDate: await today(),
    updatedAt: new Date(),
  };
  if (p.name != null) changed.name = p.name;
  if (p.companyName != null) changed.companyName = p.companyName;
  if (p.mobile != null) changed.phone = p.mobile;
  if (p.city != null) changed.city = p.city;
  if (p.area != null) changed.area = p.area;
  /* A stage on a funnel lead is NOT written here — it is written by
     `applyLeadStageMove` below, after the gate has been asked, and only if it
     said yes. Writing it here as well would move the rung whatever the gate
     answered, which is §28 defeated by an assignment. */
  if (p.stage != null && !onTheFunnel) changed.leadStage = p.stage;
  if (p.nextFollowUpDate != null) changed.leadNextFollowUpDate = p.nextFollowUpDate;
  if (p.notes != null) changed.leadNotes = p.notes;
  if (p.estimatedPotentialPaise != null) {
    changed.leadEstimatedPotentialPaise = p.estimatedPotentialPaise;
  }
  if (p.lostReason != null) changed.leadLostReason = p.lostReason;
  if (p.archived != null) changed.leadArchived = p.archived;

  /*
   * THE ANSWERS LAND WHETHER OR NOT THE MOVE DOES, and that is deliberate.
   *
   * A salesman standing in a shop fills in the eight prospect answers and taps
   * the rung in one gesture; if the gate then refuses because one of them is
   * still blank, throwing away the seven he typed would be the worst possible
   * response — he is outside the shop by the time the outbox drains, and he
   * would have to go back. The answers are facts he established, the move is a
   * request, and only the request is refused.
   */
  if (p.salesType != null) changed.leadSalesType = p.salesType;
  if (p.customerType != null) changed.customerType = p.customerType;
  if (p.monthlyLitres != null) changed.leadMonthlyVolumeLitres = p.monthlyLitres;
  if (p.competitor != null) changed.leadCompetitor = p.competitor;
  if (p.requiredProductId != null) changed.leadRequiredProductId = p.requiredProductId;
  if (p.contactPerson != null) changed.contactPerson = p.contactPerson;
  if (p.decisionMaker != null) changed.leadDecisionMaker = p.decisionMaker;
  if (p.creditDaysWanted != null) changed.leadCreditDaysWanted = p.creditDaysWanted;
  if (p.application != null) changed.leadApplication = p.application;
  if (p.gstin != null) changed.gstin = p.gstin;
  /* Merged, not replaced: twelve questions are not answered in one sitting, and
     a handset posting only what was on screen would erase the four somebody
     established last week. */
  if (p.qualification != null) {
    changed.leadQualification = { ...(existing.leadQualification ?? {}), ...p.qualification };
  }
  if (p.nextAction != null) {
    changed.leadNextAction = p.nextAction.action;
    changed.leadNextActionDate = p.nextAction.date;
    changed.leadNextActionOwnerId = p.nextAction.ownerId;
    changed.leadNextActionOutcome = p.nextAction.outcome ?? null;
  }
  if (p.suspectDecidedAt != null) {
    changed.leadSuspectDecidedAt = new Date(p.suspectDecidedAt);
  }
  /* §18 — and this one is why the omission mattered. The gate in front of
     `first_order` reads it, so with the field stripped the salesman's own copy
     of the engine said yes and the office said no about the same lead. */
  if (p.expectedOrderDate != null) changed.leadExpectedOrderDate = p.expectedOrderDate;
  if (p.expectedOrderValuePaise != null) {
    changed.leadExpectedOrderValuePaise = p.expectedOrderValuePaise;
  }
  /* §23 — the mark, from the one place the answer is actually known. The
     no-import rule is about a spreadsheet, not about a salesman standing in the
     shop; the distributor behind it is written below, after the row lands. */
  if (p.thirdParty != null) changed.thirdParty = p.thirdParty;
  if (p.distributorSalesmanId != null) {
    changed.leadDistributorSalesmanId = p.distributorSalesmanId;
  }
  if (p.address != null) changed.address = p.address;
  if (p.requirement != null) changed.leadRequirement = p.requirement;
  /* The other spelling of the same answer — see the schema. Whichever name the
     build in somebody's pocket uses, one column is written. */
  if (p.monthlyVolumeLitres != null) {
    changed.leadMonthlyVolumeLitres = p.monthlyVolumeLitres;
  }
  if (p.holdReason != null) changed.leadHoldReason = p.holdReason;
  if (p.deliveryTerms != null) changed.leadDeliveryTerms = p.deliveryTerms;
  if (p.agreedTerms != null) changed.leadAgreedTerms = p.agreedTerms;
  /*
   * A lead that starts moving again is no longer explaining itself. Clearing
   * the reason on the way out of a hold is what stops "waiting for their
   * budget quarter" sitting on a lead that has since ordered.
   */
  if (p.stage != null && p.stage !== "on_hold" && p.stage !== "new") {
    changed.leadHoldReason = null;
  }
  if (p.gpsLat != null && p.gpsLng != null) {
    changed.gpsLat = p.gpsLat;
    changed.gpsLng = p.gpsLng;
    changed.gpsCapturedAt = new Date();
  }
  /*
   * ONE LEAD, so winning one is this row becoming a customer rather than a
   * second row being written and pointed at. The handset still sends
   * `convertedCustomerId` — its payload shape is unchanged — and what that now
   * means is "this is won": `kind` moves, and the calls, timeline and GPS fix
   * come with it because they never moved.
   */
  if (p.convertedCustomerId != null) {
    changed.kind = "customer";
    changed.leadStage = "won";
    changed.leadConvertedAt = new Date();
  }

  /* §R — an internal note is a fact about the account and belongs in its
     history. The BODY is not repeated here: `mbos_internal_notes` carries a
     role list deciding who may read it, and the timeline has no such gate, so
     copying the words in would route a restricted note around its own
     restriction. The entry says one was written and where to find it. */

  await db.update(customers).set(changed).where(eq(customers.id, item.entityId));

  /*
   * §11 — the thirty answers MERGE into the profile rather than replace it.
   *
   * The office fills the commercial half of that row — the discount, the credit
   * limit, the exclusivity — and a handset that has never seen those columns
   * would null every one of them by sending the twenty-six it does know. That
   * is `upsertTasks` in different clothes: a typed column list wrote `undefined`
   * over a completed task's note because the field was read and never sent.
   * Only the keys actually present are written.
   */
  if (p.distributorProfile && Object.keys(p.distributorProfile).length) {
    const patch = Object.fromEntries(
      Object.entries(p.distributorProfile).filter(([, v]) => v !== undefined),
    );
    await db
      .insert(distributorProfiles)
      .values({
        id: `dp_${randomUUID().slice(0, 12)}`,
        customerId: item.entityId,
        ...patch,
        createdById: principal.user.id,
        updatedById: principal.user.id,
      })
      .onConflictDoUpdate({
        target: distributorProfiles.customerId,
        set: { ...patch, updatedAt: new Date(), updatedById: principal.user.id },
      });
  }

  /*
   * §23 — who invoices this shop, recorded from the first visit.
   *
   * Checked rather than trusted, on exactly the rule the console's own picker
   * enforces and `handleCustomerCreate` already repeats: a distributor is an
   * account we invoice, so it must be a real customer and not itself a third
   * party. A shop pointed at another shop is an arrangement nobody can act on.
   * A bad id is dropped rather than refusing the whole item — the lead's own
   * answers are good and the salesman is long gone from the shop.
   */
  if (p.distributorCustomerId) {
    const [biller] = await db
      .select({ id: customers.id, kind: customers.kind, thirdParty: customers.thirdParty })
      .from(customers)
      .where(eq(customers.id, p.distributorCustomerId))
      .limit(1);
    if (biller && biller.kind === "customer" && !biller.thirdParty) {
      await db
        .insert(customerDistributors)
        .values({
          id: `cd_${randomUUID().slice(0, 12)}`,
          customerId: item.entityId,
          distributorCustomerId: biller.id,
          distributorSalesmanId: p.distributorSalesmanId ?? null,
          isPrimary: true,
          note: "Named on the lead in the field",
          createdById: principal.user.id,
          updatedById: principal.user.id,
        })
        .onConflictDoNothing();
    }
  }

  /*
   * §28 — THE PHONE IS NOT TRUSTED, IT IS MERELY INFORMED.
   *
   * The handset compiles `lead-gates.ts` and draws the rung disabled with the
   * missing list underneath it, which is what lets a salesman with no signal
   * know why he cannot move a lead. That is a courtesy to him and not a
   * permission: an outbox drains hours later against a book that has moved, and
   * a handset one build behind knows a shorter list of conditions than the
   * server does. So the same function is asked again here, over the row as it
   * now stands, and a refusal is a REJECTION rather than a retry — the gate
   * will not open by itself, so resending for ever is the one answer that
   * cannot help.
   */
  if (onTheFunnel && movingStage) {
    const moved = await moveLeadFromHandset(principal, item, p.stage as LeadStage);
    if (moved) return moved;
  }

  /*
   * QUALIFYING IS WHAT STARTS §D AND §E: the Lead Manager seat is filled from
   * the org chart, they are told, and a validation call lands on their list for
   * the next working day.
   *
   * After the write and unable to fail it. `qualifyLead` is idempotent — a
   * handset that never saw the response sends the same qualification again, and
   * the seat itself is the guard — so a retry costs nothing and produces no
   * second task.
   *
   * It runs AFTER the gate rather than instead of it, and only for the legacy
   * rung: a funnel lead refused above has already returned, so nothing fills a
   * seat for a move that did not happen. `qualified` is the old ladder's rung
   * and `qualification` is the funnel's — the seat is filled at whichever of
   * them this lead's ladder actually uses.
   */
  if (p.stage === "qualified" || p.stage === "qualification") {
    await qualifyLead(item.entityId, principal.user.id, existing.name).catch(() => {});
  }

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/**
 * A stage move arriving from a salesman's outbox.
 *
 * Returns a refusal, or null where the move was made — the caller has already
 * accepted the answers that came with it, and a move it does not refuse is one
 * that has been written.
 */
async function moveLeadFromHandset(
  principal: MbosPrincipal,
  item: SyncItem,
  to: LeadStage,
): Promise<Handled | null> {
  /*
   * The capability is checked HERE and not by the handset drawing a button.
   * `lead.work` is held by every telecaller and every field salesman, so this
   * refuses almost nobody — which is exactly why it has to be written down: a
   * check that never fires is one somebody deletes as dead code, and the day an
   * accounts clerk is given a handset it is the only thing standing between
   * them and the funnel.
   */
  const roles = await rolesFor(principal.user);
  if (!canAny(roles, "lead.work")) {
    return {
      kind: "rejected",
      value: reject(
        "not_permitted",
        "Your MahekOne account is not set up to work leads, so the stage was not changed. Ask your manager.",
      ),
    };
  }

  /* Re-read, because the answers that arrived with this item have just landed
     and the gate has to see the row as it now stands rather than as it was when
     the handset queued this. */
  const [lead, gate] = await Promise.all([
    leadRow(item.entityId),
    leadGateInput(item.entityId),
  ]);
  if (!lead || !gate) {
    return {
      kind: "retry",
      message: "That lead has not reached the office yet. It will be tried again once it has.",
    };
  }

  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const reasonCode =
    typeof payload.reasonCode === "string" && payload.reasonCode
      ? payload.reasonCode
      : typeof payload.lostReason === "string" && payload.lostReason
        ? payload.lostReason
        : null;

  const decision = await evaluateLeadStageMove({
    lead,
    gate,
    to,
    reasonCode,
    /*
     * A handset never overrides. §28's escape hatch is a manager's, it demands
     * a reason from a configured list, and it stores what was still missing —
     * none of which is a thing to do standing in a shop with the customer
     * waiting. A manager passes the gate from the console, and the move then
     * reaches the phone on the next pull.
     */
    override: null,
    canOverride: false,
  });

  if (!decision.ok) {
    /* The missing conditions are NAMED, because a refusal that does not say
       what is missing teaches a salesman to press the button again rather than
       to do the work — which is the whole reason the gate returns a list. */
    const missing = decision.missing.map((c) => c.says).join("; ");
    return {
      kind: "rejected",
      value: reject(
        decision.code === "revert_not_permitted" ||
          decision.code === "override_not_permitted"
          ? "not_permitted"
          : "validation",
        missing
          ? `${decision.message} Still to do: ${missing}.`
          : decision.message,
      ),
    };
  }

  await applyLeadStageMove(
    {
      userId: principal.user.id,
      /* The narrowest hat that carries it, exactly as `requireCapability`
         resolves it on the console side — so `audit_log.actor_role` reads the
         same whichever door the move came through. */
      role: grantingRole(roles, "lead.work"),
      sourceApp: "mbos",
    },
    lead,
    to,
    {
      decision,
      reasonCode,
      note: typeof payload.notes === "string" ? payload.notes : null,
      nextAction: null,
      day: await today(),
    },
  );

  return null;
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
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(eq(customers.phone, p.mobile), eq(customers.leadArchived, false)))
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
  /*
   * `customers.city` is NOT NULL and the handset's lead form does not require
   * a town, so one is fallen back to rather than refusing a lead a salesman
   * has already captured standing in the shop. The convert flow still insists
   * on a real town before the account is opened — that is where it matters.
   */
  const city = p.city ?? p.area ?? "Unknown";

  /*
   * WHERE A NEW LEAD STARTS DEPENDS ON WHETHER IT NAMES A SALES TYPE.
   *
   * A build that asks the §2 question raises a lead at `suspect`, the foot of
   * all three real ladders. A build that does not goes on raising it at `new`,
   * the foot of `LEGACY_LADDER`, exactly as it always has — an APK cannot be
   * recalled, so the server moves first and the phone catches up.
   */
  const foot = p.salesType ? "suspect" : "new";
  /* §6 and §9's answers, sent with the lead where the form asked them. */
  const funnelFields = {
    leadSalesType: p.salesType ?? null,
    customerType: p.customerType ?? null,
    /* Both spellings of the one answer — see the schema. `??` rather than two
       assignments, so a payload carrying both cannot write two answers about
       one fact and let the later line win. */
    leadMonthlyVolumeLitres: p.monthlyLitres ?? p.monthlyVolumeLitres ?? null,
    leadCompetitor: p.competitor ?? null,
    leadRequiredProductId: p.requiredProductId ?? null,
    contactPerson: p.contactPerson ?? null,
    leadDecisionMaker: p.decisionMaker ?? null,
    leadCreditDaysWanted: p.creditDaysWanted ?? null,
    leadApplication: p.application ?? null,
    gstin: p.gstin ?? null,
    leadQualification: p.qualification ?? {},
    leadNextAction: p.nextAction?.action ?? null,
    leadNextActionDate: p.nextAction?.date ?? null,
    leadNextActionOwnerId: p.nextAction?.ownerId ?? null,
    leadNextActionOutcome: p.nextAction?.outcome ?? null,
    leadSuspectDecidedAt: p.suspectDecidedAt ? new Date(p.suspectDecidedAt) : null,
  } as const;

  await db
    .insert(customers)
    .values({
      id: item.entityId,
      name: p.name,
      companyName: p.companyName ?? null,
      phone: p.mobile,
      city,
      area: p.area ?? null,
      kind: "lead",
      leadSource: p.source ?? "manual",
      /* The salesman who raised it OWNS it, and that is what puts it on his
       * handset AND in the scoped lists the office reads — `ASSIGNED_TO_SQL`
       * resolves a lead through `owner_id`. One column, three screens. */
      ownerId: principal.user.id,
      leadStage: p.stage ?? foot,
      /* The rung it is standing on, dated — the console ages every list by this
         and a null would read as a lead that has been there since the epoch. */
      leadStageSince: day,
      leadEstimatedPotentialPaise: p.estimatedPotentialPaise ?? null,
      leadNextFollowUpDate: p.nextFollowUpDate ?? null,
      leadNotes: p.notes ?? null,
      gpsLat: p.gpsLat ?? null,
      gpsLng: p.gpsLng ?? null,
      /* Captured standing in the shop. `gpsCapturedAt` is what tells a later
         reader whether the pin is the salesman's own or something an import
         guessed, so it is written with the fix rather than left null. */
      gpsCapturedAt: p.gpsLat != null && p.gpsLng != null ? new Date() : null,
      address: p.address ?? null,
      leadRequirement: p.requirement ?? null,
      leadLostReason: p.lostReason ?? null,
      leadLastActivityDate: day,
      /*
       * `customerType`, `gstin`, `leadDecisionMaker` and the litres are NOT
       * repeated above this spread. They were, and the spread came second, so
       * every one of them was written and then overwritten with the funnel's
       * own reading of the same payload — which is null on a build that sends
       * the other spelling. A lead raised on the deployed APK arrived with its
       * four answers and stored none of them, and nothing failed.
       */
      ...funnelFields,
    })
    .onConflictDoUpdate({
      target: customers.id,
      set: {
        name: p.name,
        companyName: p.companyName ?? null,
        phone: p.mobile,
        city,
        area: p.area ?? null,
        leadStage: p.stage ?? foot,
        leadNextFollowUpDate: p.nextFollowUpDate ?? null,
        leadNotes: p.notes ?? null,
        address: p.address ?? null,
        leadRequirement: p.requirement ?? null,
        leadLostReason: p.lostReason ?? null,
        leadLastActivityDate: day,
        updatedAt: new Date(),
        ...funnelFields,
      },
    });

  /*
   * The shop front, now that there is a record to hang it on.
   *
   * The photograph was taken before this row existed — the salesman shoots the
   * shop while he is standing in front of it and types the rest afterwards —
   * so the handset queued it under the literal parent `pending`. Binding it
   * here is what makes it readable and what keeps the nightly orphan sweep off
   * it. After the record, deliberately: a lead is never lost to a photograph.
   */
  await bindMbosMedia(p.shopPhotoId, "mbos_lead", item.entityId);

  /*
   * §R — where the account began. Outside the insert's own transaction and
   * unable to fail it: a lead is never lost to its own timeline entry, and the
   * natural key makes a retry write nothing rather than a second row.
   */
  await writeTimeline(db, {
    customerId: item.entityId,
    eventType: MBOS_EVENT.leadCreated,
    sourceRecordId: item.entityId,
    occurredAt: new Date(item.clientCreatedAt),
    actorUserId: principal.user.id,
    summary: `Lead raised in the field${p.city ? ` — ${p.city}` : ""}${p.source ? ` (${p.source.replace("_", " ")})` : ""}`,
  }).catch(() => {});

  /*
   * And the pin, which is its own event because it is its own fact: somebody
   * stood in this shop and recorded where it is. Written only where there IS a
   * fix — "no GPS" is not an event, it is the absence of one, and a row saying
   * so would be a timeline entry about nothing having happened.
   */
  if (p.gpsLat != null && p.gpsLng != null) {
    await writeTimeline(db, {
      customerId: item.entityId,
      eventType: MBOS_EVENT.gps,
      sourceRecordId: `${item.entityId}:gps`,
      occurredAt: new Date(item.clientCreatedAt),
      actorUserId: principal.user.id,
      summary: "Shop location captured on the spot",
    }).catch(() => {});
  }

  /*
   * And the competitor, if he got one.
   *
   * It goes in `mbos_competitor_records` rather than a column on the lead,
   * because that is where every other competitor sighting in this product
   * lives and a second home for the same fact is how the two disagree. `visitId`
   * is null: there is no visit behind a lead being raised, which is precisely
   * why that column is nullable.
   */
  if (p.competitorName?.trim()) {
    await db
      .insert(mbosCompetitorRecords)
      .values({
        id: gen("mbos_comp"),
        customerId: item.entityId,
        visitId: null,
        competitorName: p.competitorName.trim(),
        recordedOn: day,
        createdById: principal.user.id,
        updatedById: principal.user.id,
      })
      .onConflictDoNothing();

    await writeTimeline(db, {
      customerId: item.entityId,
      eventType: MBOS_EVENT.competitor,
      sourceRecordId: item.entityId,
      occurredAt: new Date(item.clientCreatedAt),
      actorUserId: principal.user.id,
      summary: `Buying from ${p.competitorName.trim()} at the moment`,
    }).catch(() => {});
  }

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------- internal notes */

const internalNoteSchema = z.object({
  customerId: z.string(),
  body: z.string().min(1).max(4000),
  /**
   * Who may read it. Empty means everybody who can see the customer — which is
   * what a note with no list has always meant on the read side.
   */
  visibleToRoles: z.array(z.string().max(40)).max(8).nullish(),
});

/**
 * §R — a note about a customer that the customer must never see, and that a
 * field salesman is never sent either.
 *
 * The table, the role list and the bootstrap's narrowing have existed since the
 * module shipped. What did not exist was any way to WRITE one, so the feature
 * was a read path over an empty table — the same shape `mbos_competitor_records`
 * was in before it got a write path.
 *
 * The timeline entry deliberately does NOT carry the body. `visibleToRoles`
 * decides who may read a note and the timeline has no such gate, so copying the
 * words into it would route a restricted note straight around its own
 * restriction. The entry records that one was written; the note itself stays
 * where the rule about reading it lives.
 */
async function handleInternalNote(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = internalNoteSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  await db
    .insert(mbosInternalNotes)
    .values({
      id: item.entityId,
      customerId: customer.id,
      authorId: principal.user.id,
      body: p.body,
      visibleToRoles: p.visibleToRoles ?? [],
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
      clientCreatedAt: new Date(item.clientCreatedAt),
    })
    .onConflictDoNothing({ target: mbosInternalNotes.id });

  await writeTimeline(db, {
    customerId: customer.id,
    eventType: MBOS_EVENT.internalNote,
    sourceRecordId: item.entityId,
    occurredAt: new Date(item.clientCreatedAt),
    actorUserId: principal.user.id,
    summary: "An internal note was added",
  }).catch(() => {});

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* -------------------------------------------------- lead validation call */

const leadValidationSchema = z.object({
  customerId: z.string(),
  calledAt: z.number().nullish(),
  /** A call nobody answered is still a call that was made. */
  reached: z.boolean().nullish(),
  productFeedback: z.string().max(2000).nullish(),
  qualityFeedback: z.string().max(2000).nullish(),
  dispatchFeedback: z.string().max(2000).nullish(),
  salesmanFeedback: z.string().max(2000).nullish(),
  confirmedRequirement: z.string().max(1000).nullish(),
  confirmedMonthlyVolumeLitres: z.number().int().nonnegative().nullish(),
  confirmedCompetitor: z.string().max(200).nullish(),
  confirmedPotentialPaise: z.number().int().nonnegative().nullish(),
  /** §F — the Lead Manager's decision, or `pending` where they left it open. */
  verdict: z.enum(["pending", "confirmed", "not_qualified", "on_hold"]).nullish(),
  verdictReason: z.string().max(500).nullish(),
  notes: z.string().max(4000).nullish(),
  /** The task this answered, so it can be closed in the same pass. */
  taskId: z.string().nullish(),
});

/**
 * §E and §F — the validation call, and what it sets in motion.
 *
 * The answers are stored on their OWN row and never written over the lead's
 * columns. That is the whole design: `lead_requirement` is what the salesman
 * was told standing in the shop, `confirmed_requirement` is what the office was
 * told on the phone, and the two disagreeing is the single most useful thing
 * this call produces. Collapsing them would overwrite the first reading with
 * the second and destroy the comparison the call exists to make.
 */
async function handleLeadValidation(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = leadValidationSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;

  /* §F: a rejection has to say why. The same rule as a lost lead and for the
     same reason — a Prospect turned down with no reason teaches the salesman
     who raised it nothing, and he will raise the next one exactly like it. */
  if (
    (p.verdict === "not_qualified" || p.verdict === "on_hold") &&
    !p.verdictReason?.trim()
  ) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `${customer.name} was turned down with no reason given. Say what was wrong — the salesman who raised it will raise the next one just like it otherwise.`,
      ),
    };
  }

  const calledAt = p.calledAt ? new Date(p.calledAt) : new Date(item.clientCreatedAt);
  const day = await today();

  await db
    .insert(mbosLeadValidations)
    .values({
      id: item.entityId,
      customerId: customer.id,
      calledByUserId: principal.user.id,
      calledAt,
      reached: p.reached ?? true,
      productFeedback: p.productFeedback ?? null,
      qualityFeedback: p.qualityFeedback ?? null,
      dispatchFeedback: p.dispatchFeedback ?? null,
      salesmanFeedback: p.salesmanFeedback ?? null,
      confirmedRequirement: p.confirmedRequirement ?? null,
      confirmedMonthlyVolumeLitres: p.confirmedMonthlyVolumeLitres ?? null,
      confirmedCompetitor: p.confirmedCompetitor ?? null,
      confirmedPotentialPaise: p.confirmedPotentialPaise ?? null,
      verdict: p.verdict ?? "pending",
      verdictReason: p.verdictReason ?? null,
      notes: p.notes ?? null,
      createdById: principal.user.id,
      updatedById: principal.user.id,
    })
    .onConflictDoNothing({ target: mbosLeadValidations.id });

  /* A call is activity on the lead whatever it concluded. */
  await db
    .update(customers)
    .set({ leadLastActivityDate: day, updatedAt: new Date() })
    .where(eq(customers.id, customer.id));

  /* The task that asked for this call is answered. Closed here rather than by
     the handset sending a second item: two writes for one act is how the call
     lands and the task stays open on somebody's list for ever. */
  if (p.taskId) {
    await db
      .update(mbosTasks)
      .set({
        status: "done",
        completedAt: new Date(),
        completionNote: p.verdictReason ?? p.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(mbosTasks.id, p.taskId));
  }

  /* §R — the office's own reading of the shop, beside the salesman's. */
  await writeTimeline(db, {
    customerId: customer.id,
    eventType: MBOS_EVENT.validation,
    sourceRecordId: item.entityId,
    occurredAt: calledAt,
    actorUserId: principal.user.id,
    summary: p.reached
      ? `Validation call — ${p.verdict === "confirmed" ? "confirmed as a prospect" : p.verdict === "not_qualified" ? "not qualified" : p.verdict === "on_hold" ? "put on hold" : "no verdict yet"}${p.verdictReason ? `: ${p.verdictReason}` : ""}`
      : "Validation call — no answer",
  }).catch(() => {});

  await afterValidationVerdict(principal, customer.id, customer.name, p.verdict ?? "pending", p.verdictReason ?? null);

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/**
 * §F and §G — what the verdict starts.
 *
 * Confirmed sends the salesman back with a requirement visit; the other two
 * move the lead and tell him why. Every branch notifies the person whose work
 * it changes, because a lead that quietly stops being worked is one nobody
 * chases and nobody closes.
 *
 * Best-effort on top of a completed write, like every other notification in
 * this file.
 */
async function afterValidationVerdict(
  principal: MbosPrincipal,
  customerId: string,
  customerName: string,
  verdict: string,
  reason: string | null,
): Promise<void> {
  const [lead] = await db
    .select({ ownerId: customers.ownerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const salesmanId = lead?.ownerId;

  if (verdict === "confirmed") {
    if (!salesmanId) return;
    const day = await today();
    await db
      .insert(mbosTasks)
      .values({
        id: gen("mbos_task"),
        title: `Requirement visit — ${customerName}`,
        description:
          "Take the price list and the approved discount. Get the product, the quantity and the monthly consumption in writing. No price or delivery commitments at this stage — anything commercial goes to the Lead Manager as a note.",
        assignedToUserId: salesmanId,
        priority: "high",
        dueDate: day,
        customerId,
        status: "open",
        sourceType: "requirement_visit",
        sourceId: customerId,
        createdById: principal.user.id,
        updatedById: principal.user.id,
      })
      .onConflictDoNothing();

    await db
      .insert(notifications)
      .values({
        id: gen("ntf"),
        userId: salesmanId,
        title: "A Prospect was confirmed",
        body: `${customerName} came through the validation call. There is a requirement visit on your list — take the price list.`,
        kind: "info",
      })
      .catch(() => {});
    return;
  }

  if (verdict === "not_qualified" || verdict === "on_hold") {
    await db
      .update(customers)
      .set({
        leadStage: verdict === "on_hold" ? "on_hold" : "lost",
        ...(verdict === "on_hold"
          ? { leadHoldReason: reason }
          : { leadLostReason: reason }),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, customerId));

    if (salesmanId) {
      await db
        .insert(notifications)
        .values({
          id: gen("ntf"),
          userId: salesmanId,
          title:
            verdict === "on_hold"
              ? "A Prospect was put on hold"
              : "A Prospect was not qualified",
          body: `${customerName}: ${reason ?? "no reason recorded"}.`,
          kind: "info",
        })
        .catch(() => {});
    }
  }
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
  /* ---- the policy module. Every one optional, so a handset that has not
     been updated goes on syncing exactly as it did. ---- */
  kind: z.enum(["travel", "food", "lodging", "local_transport", "other"]).nullish(),
  expenseDayId: z.string().nullish(),
  vendorName: z.string().max(200).nullish(),
  billNumber: z.string().max(100).nullish(),
  billDate: z.string().nullish(),
  /** Requirement 43 — why he is claiming something outside policy. */
  exceptionReason: z.string().max(2000).nullish(),
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
      kind: p.kind ?? p.category,
      sourceType: "manual",
      expenseDayId: p.expenseDayId ?? null,
      vendorName: p.vendorName ?? null,
      billNumber: p.billNumber ?? null,
      billDate: p.billDate ?? null,
      exceptionReason: p.exceptionReason ?? null,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      updatedById: principal.user.id,
      deviceId: principal.deviceId,
    })
    .onConflictDoNothing({ target: mbosExpenses.id });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------- travel, and the day itself */

const expenseDaySchema = z.object({
  day: z.string(),
  departedAt: z.number().nullish(),
  returnedAt: z.number().nullish(),
  departedFromHometown: z.boolean().nullish(),
  destinationCity: z.string().max(200).nullish(),
  arrivedAtDestinationAt: z.number().nullish(),
  overnight: z.boolean().nullish(),
  stayedInHotel: z.boolean().nullish(),
  openingOdometerKm: z.number().int().nullish(),
  closingOdometerKm: z.number().int().nullish(),
  tourId: z.string().nullish(),
  note: z.string().max(2000).nullish(),
});

/**
 * The day a salesman opened and closed.
 *
 * Idempotent on `(userId, day)` rather than on the client id, because a
 * handset reinstalled mid-week mints a new id for a day the office already
 * has — and two rows for one Tuesday would give that Tuesday two sets of
 * meals. The client id is kept where it wins the race and the payload is
 * merged where it does not.
 *
 * **A locked day is refused rather than merged.** Requirement 54 is the point
 * of the lock; a handset that has been offline since before the day was
 * submitted must not be able to quietly move the departure time that the
 * meals were worked out from.
 */
async function handleExpenseDay(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = expenseDaySchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const existing = await db
    .select({ id: mbosExpenseDays.id, lockedAt: mbosExpenseDays.lockedAt })
    .from(mbosExpenseDays)
    .where(and(eq(mbosExpenseDays.userId, principal.user.id), eq(mbosExpenseDays.day, p.day)))
    .limit(1);

  if (existing[0]?.lockedAt) {
    return {
      kind: "rejected",
      value: reject(
        "day_locked",
        `${p.day} has already been submitted and locked. Ask your manager to reopen it — what was submitted stays exactly as it was, and a correction is recorded beside it.`,
      ),
    };
  }

  const cityClass = p.destinationCity ? await classOfCity(p.destinationCity) : null;
  const values = {
    departedAt: p.departedAt ? new Date(p.departedAt) : null,
    returnedAt: p.returnedAt ? new Date(p.returnedAt) : null,
    departedFromHometown: p.departedFromHometown ?? true,
    destinationCity: p.destinationCity ?? null,
    destinationCityClass: cityClass,
    arrivedAtDestinationAt: p.arrivedAtDestinationAt ? new Date(p.arrivedAtDestinationAt) : null,
    overnight: p.overnight ?? false,
    stayedInHotel: p.stayedInHotel ?? false,
    openingOdometerKm: p.openingOdometerKm ?? null,
    closingOdometerKm: p.closingOdometerKm ?? null,
    tourId: p.tourId ?? null,
    note: p.note ?? null,
    updatedAt: new Date(),
    updatedById: principal.user.id,
  };

  if (existing[0]) {
    await db.update(mbosExpenseDays).set(values).where(eq(mbosExpenseDays.id, existing[0].id));
    return { kind: "accepted", value: { serverId: existing[0].id } };
  }

  await db
    .insert(mbosExpenseDays)
    .values({
      id: item.entityId,
      userId: principal.user.id,
      day: p.day,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      deviceId: principal.deviceId,
      ...values,
    })
    .onConflictDoNothing();

  /* Requirement 20's random draw, made HERE and never on the phone. A check a
     device rolls for itself is a check it can decline to fail. Drawn once per
     day, on the day's first arrival, so it cannot be re-rolled by re-syncing. */
  const config = await getConfig();
  const pct = config["expenses.odometerPhotoRandomPct"];
  if (pct > 0 && Math.random() * 100 < pct) {
    await db
      .update(mbosExpenseDays)
      .set({ odometerPhotoDemanded: true })
      .where(eq(mbosExpenseDays.id, item.entityId));
  }

  return { kind: "accepted", value: { serverId: item.entityId } };
}

const travelLegSchema = z.object({
  expenseDayId: z.string().nullish(),
  day: z.string().nullish(),
  modeKey: z.string().max(60),
  fromLabel: z.string().max(200).nullish(),
  toLabel: z.string().max(200).nullish(),
  fromLat: z.number().nullish(),
  fromLng: z.number().nullish(),
  toLat: z.number().nullish(),
  toLng: z.number().nullish(),
  startedAt: z.number().nullish(),
  endedAt: z.number().nullish(),
  purpose: z.string().max(60).nullish(),
  customerId: z.string().nullish(),
  visitId: z.string().nullish(),
  manualMetres: z.number().int().min(0).nullish(),
  manualReason: z.string().max(500).nullish(),
  odometerStartKm: z.number().int().min(0).nullish(),
  odometerEndKm: z.number().int().min(0).nullish(),
  odometerPhotoId: z.string().nullish(),
  ticketAmountPaise: z.number().int().min(0).nullish(),
  ticketPhotoId: z.string().nullish(),
  ticketReference: z.string().max(100).nullish(),
  note: z.string().max(2000).nullish(),
});

/**
 * One movement.
 *
 * The mode is checked against `mbos_travel_modes` rather than trusted: a leg
 * naming a mode nobody has priced would be recorded, be worth nothing, and say
 * nothing about why — and the salesman would find out at month end. Refusing
 * it names the modes that exist, which is something he can act on.
 *
 * The distance is NOT worked out here. The trail arrives in batches and a leg
 * synced the minute it ended has fewer positions behind it than the same leg
 * has by evening, so scoring happens on submission, when the day is complete.
 */
async function handleTravelLeg(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = travelLegSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const [mode] = await db
    .select({ key: mbosTravelModes.key })
    .from(mbosTravelModes)
    .where(and(eq(mbosTravelModes.key, p.modeKey), eq(mbosTravelModes.active, true)))
    .limit(1);
  if (!mode) {
    const available = await db
      .select({ label: mbosTravelModes.label })
      .from(mbosTravelModes)
      .where(eq(mbosTravelModes.active, true));
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `MahekOne has no travel mode called "${p.modeKey}". The ones it has are: ${available.map((m) => m.label).join(", ")}.`,
      ),
    };
  }

  /* A leg has to belong to a day, and the day is what makes the meals work —
     so one is opened rather than the leg being refused for the want of it. */
  let dayId = p.expenseDayId ?? null;
  if (!dayId && p.day) {
    dayId = await ensureDay(principal.user.id, p.day, principal.deviceId);
  }

  if (dayId) {
    const [day] = await db
      .select({ lockedAt: mbosExpenseDays.lockedAt })
      .from(mbosExpenseDays)
      .where(eq(mbosExpenseDays.id, dayId))
      .limit(1);
    if (day?.lockedAt) {
      return {
        kind: "rejected",
        value: reject(
          "day_locked",
          "That day has already been submitted and locked, so a leg cannot be added to it. Ask your manager to reopen it.",
        ),
      };
    }
  }

  /* A customer named on a leg is checked the same way one named on an order
     is. A leg is how servicing cost is told from acquisition cost, so a leg
     pointing at somebody else's shop moves money between two figures the
     owner reads. */
  if (p.customerId) {
    const scoped = await scopedCustomer(principal, p.customerId);
    if (!scoped.ok) return { kind: "rejected", value: scoped.value };
  }

  const values = {
    expenseDayId: dayId,
    modeKey: p.modeKey,
    fromLabel: p.fromLabel ?? null,
    toLabel: p.toLabel ?? null,
    fromLat: p.fromLat ?? null,
    fromLng: p.fromLng ?? null,
    toLat: p.toLat ?? null,
    toLng: p.toLng ?? null,
    startedAt: p.startedAt ? new Date(p.startedAt) : null,
    endedAt: p.endedAt ? new Date(p.endedAt) : null,
    purpose: p.purpose ?? null,
    customerId: p.customerId ?? null,
    visitId: p.visitId ?? null,
    manualMetres: p.manualMetres ?? null,
    manualReason: p.manualReason ?? null,
    odometerStartKm: p.odometerStartKm ?? null,
    odometerEndKm: p.odometerEndKm ?? null,
    odometerPhotoId: p.odometerPhotoId ?? null,
    ticketAmountPaise: p.ticketAmountPaise ?? null,
    ticketPhotoId: p.ticketPhotoId ?? null,
    ticketReference: p.ticketReference ?? null,
    note: p.note ?? null,
    updatedAt: new Date(),
    updatedById: principal.user.id,
  };

  await db
    .insert(mbosTravelLegs)
    .values({
      id: item.entityId,
      userId: principal.user.id,
      clientCreatedAt: new Date(item.clientCreatedAt),
      createdById: principal.user.id,
      deviceId: principal.deviceId,
      ...values,
    })
    .onConflictDoUpdate({ target: mbosTravelLegs.id, set: values });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

const submitSchema = z.object({
  day: z.string(),
  /** What the handset made the total. Compared, never trusted. */
  clientClaimedPaise: z.number().int().min(0).nullish(),
  note: z.string().max(2000).nullish(),
});

/**
 * The salesman closing his day.
 *
 * **The server recomputes and the server's answer wins — and the difference is
 * RECORDED.** The handset ran the same engine offline against the policy it
 * last pulled, which may be a version behind. Silently overwriting his figure
 * is how somebody is told ₹450 and paid ₹250 with nothing on any screen
 * explaining it, and that is the fastest way to make a field app untrusted.
 * `sync_conflicts` already does exactly this for the order sheet.
 */
async function handleExpenseDaySubmit(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
  const parsed = submitSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const outcome = await submitDay(principal.user.id, p.day, { note: p.note ?? null });
  if (!outcome.ok) {
    return { kind: "rejected", value: reject("day_locked", outcome.reason) };
  }

  if (
    typeof p.clientClaimedPaise === "number" &&
    p.clientClaimedPaise !== outcome.claimedPaise
  ) {
    await db
      .insert(mbosExpenseExceptions)
      .values({
        id: gen("xexc"),
        userId: principal.user.id,
        expenseDayId: outcome.dayId,
        kind: "client_disagreement",
        severity: "info",
        message: `The handset made this day ${rupees(p.clientClaimedPaise)} and the office makes it ${rupees(outcome.claimedPaise)}. The office figure is the one paid; the difference is usually a policy the phone had not yet pulled.`,
        detail: {
          clientClaimedPaise: p.clientClaimedPaise,
          serverClaimedPaise: outcome.claimedPaise,
        },
      })
      .onConflictDoNothing();
  }

  return {
    kind: "accepted",
    value: {
      serverId: outcome.dayId,
      /* The handset prints this, so the salesman learns what happened to his
         day at the moment it syncs rather than at month end. */
      serverNumber: outcome.autoApproved ? "Approved" : "With your manager",
    },
  };
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
  checkOutSelfieId: z.string().nullish(),
  /**
   * The day as the handset holds it, and the only place N selfies can live.
   *
   * Every check-in and every check-out is photographed, so a day with two
   * breaks carries six — and `selfieId`/`checkOutSelfieId` above can hold two.
   * Sent on every attendance write, create and update both, because the whole
   * list is the answer: a shorter one is how a session is corrected, and
   * merging here would make a correction impossible.
   *
   * Capped at a number no real day reaches. Twelve sessions is six breaks;
   * past that it is a handset in a loop, and an unbounded list from a client
   * is a column somebody can grow without limit.
   */
  sessions: z
    .preprocess(
      /*
       * A STRING IS AS VALID AS AN ARRAY HERE, and refusing one would refuse
       * check-ins.
       *
       * The handset holds `attendance_days.sessions` as TEXT — SQLite has no
       * array — and passes the parsed array into its payload. But the two are
       * one character apart at the call site, the field was never in this
       * schema before (so zod silently stripped whatever arrived, in any
       * shape), and an APK already in somebody's pocket cannot be recalled.
       * Accepting both is the same trade the wire contract makes everywhere
       * else: the server moves first, and a shape it can read costs nothing.
       *
       * A string that will not parse becomes `undefined` rather than an error,
       * so the day is still recorded. The sessions are the richest part of the
       * payload and the least urgent — losing them costs the office a break
       * time; refusing the row costs a salesman his attendance.
       */
      (v) => {
        if (typeof v !== "string") return v;
        try {
          return JSON.parse(v);
        } catch {
          return undefined;
        }
      },
      z
        .array(
          z.object({
            inAt: z.number(),
            outAt: z.number().nullish(),
            inSelfieId: z.string().nullish(),
            outSelfieId: z.string().nullish(),
          }),
        )
        .max(12),
    )
    .nullish(),
  notes: z.string().max(1000).nullish(),
  /** Whether the check-in was inside the permitted radius, where one is set. */
  withinGeofence: z.boolean().nullish(),
  geofenceDistanceM: z.number().nullish(),
  /** A correction asked for. The DECISION lives in `mbos_approvals`. */
  regularisationRequested: z.boolean().nullish(),
  regularisationReason: z.string().max(1000).nullish(),
  /**
   * Sent by the handset when a checked-out day is started again — a lunch
   * break, or a phone that swapped devices mid-afternoon. It carries no date
   * of its own to write anywhere; it is a signal to REOPEN the row, read only
   * below, next to the `checkOutAt` it exists to undo.
   */
  resumedAt: z.number().nullish(),
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

  /*
   * The selfies are checked before they are STORED against the day.
   *
   * These columns are foreign keys onto `attachments`, and media syncs AFTER
   * its parent by design — the record goes up first so 840 KB of photograph
   * never delays it. So on the create the attachment row does not exist yet
   * and the key would be violated, which would reject the check-in over a file
   * that is on its way. The id is kept only where the row is already there,
   * and the handset re-sends the same payload as the media queue drains, so
   * the second pass fills it in. `sessions` carries the ids regardless, since
   * it is jsonb and holds what the handset reported whether or not the bytes
   * have landed — the mark is never lost to the ordering of an upload.
   */
  const known = await knownAttachments([
    p.selfieId,
    p.checkOutSelfieId,
    ...(p.sessions ?? []).flatMap((x) => [x.inSelfieId, x.outSelfieId]),
  ]);
  const selfieRef = (id: string | null | undefined) =>
    id && known.has(id) ? id : null;

  /* Normalised to the column's own shape: an open session is explicitly
     `outAt: null`, never a missing key. `undefined` in jsonb is how a row
     comes back with a field that reads as absent rather than as "still
     running", and `openSession` on the handset keys on exactly that. */
  const sessions = p.sessions?.map((x) => ({
    inAt: x.inAt,
    outAt: x.outAt ?? null,
    inSelfieId: x.inSelfieId ?? null,
    outSelfieId: x.outSelfieId ?? null,
  }));

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
      checkInSelfieId: selfieRef(p.selfieId),
      checkOutAt: p.checkOutAt ? new Date(p.checkOutAt) : null,
      checkOutLat: p.checkOutLat ?? null,
      checkOutLng: p.checkOutLng ?? null,
      checkOutAccuracyM: round(p.checkOutAccuracyM),
      checkOutSelfieId: selfieRef(p.checkOutSelfieId),
      sessions: sessions ?? [],
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
        /* A real checkout wins if both arrive together, which they never do
         * in practice — `resumedAt` only reopens a row when this sync carries
         * no checkout of its own. Without this branch, `checkOutAt` from the
         * PREVIOUS checkout stayed on the row forever: the client had already
         * cleared it locally and resumed GPS collection, but nothing told the
         * server, so the Live map's "who's out" filter (`checkInAt &&
         * !checkOutAt`) kept excluding him and `/api/mbos/positions` kept
         * discarding every fix he sent with `tracking: "not-checked-in"` —
         * both silent, because the sync call itself still answered
         * "accepted". */
        /* AND A CHECK-IN LATER THAN THE RECORDED CHECK-OUT IS A NEW SESSION,
         * which is what the third branch says.
         *
         * `resumedAt` reaches us only from the handset's RESUME path, and it
         * can only take that path while it still holds today's row locally. A
         * phone that reinstalled, signed out, or otherwise lost its local
         * database finds no row for today, takes the CREATE path instead, and
         * sends a fresh id carrying `checkInAt` and neither `checkOutAt` nor
         * `resumedAt`. That arrived here as "no branch matched", so the
         * morning's `check_out_at` stayed on the row — the person checked in
         * on their phone and checked out on every screen, missing from the
         * Live map's `checkInAt && !checkOutAt` filter, with
         * `/api/mbos/positions` refusing every fix they sent because the day
         * it could see was closed. Silent again: the sync answered "accepted".
         *
         * Losing the local database is the ordinary consequence of installing
         * a new build, so this would have met every salesman on the next
         * release — and did, on the first phone to take one.
         *
         * It is COMPARED against the stored check-out rather than believed
         * outright, because a re-sent create must stay idempotent: the
         * morning's own check-in arriving twice is EARLIER than the check-out
         * it later produced, and reopening the day on that would silently undo
         * a real check-out. Only a check-in after the close is a new session.
         *
         * Unqualified `check_out_at` inside DO UPDATE SET is the EXISTING
         * row's value — `excluded` would be the proposed one — so this is the
         * one place a bare column is what is wanted, the opposite of the
         * correlated-subquery trap in AGENTS.md. `.toISOString()` because
         * binding a JS Date into a raw fragment throws inside the driver on
         * Node 25, which is its own rule over there. */
        ...(p.checkOutAt
          ? { checkOutAt: new Date(p.checkOutAt) }
          : p.resumedAt != null
            ? { checkOutAt: null }
            : p.checkInAt != null
              ? {
                  checkOutAt: sql`case when ${mbosAttendanceDays.checkOutAt} < ${new Date(p.checkInAt).toISOString()}::timestamptz then null else ${mbosAttendanceDays.checkOutAt} end`,
                }
              : {}),
        ...(p.checkOutLat != null ? { checkOutLat: p.checkOutLat } : {}),
        ...(p.checkOutLng != null ? { checkOutLng: p.checkOutLng } : {}),
        ...(p.checkOutAccuracyM != null
          ? { checkOutAccuracyM: round(p.checkOutAccuracyM) }
          : {}),
        /*
         * The photographs, and the sessions they hang off.
         *
         * Written on every arrival rather than only the first, unlike the
         * check-in mark above — a day GROWS: the afternoon session and its two
         * selfies are new facts about a row that already exists, and the whole
         * list is what the handset sends. Each id is only stored once its
         * attachment has actually landed (see `selfieRef`), so a re-send after
         * the media queue drains is what fills the two key columns in; the
         * jsonb list holds the ids from the first pass either way.
         */
        ...(sessions ? { sessions } : {}),
        ...(selfieRef(p.selfieId) ? { checkInSelfieId: selfieRef(p.selfieId) } : {}),
        ...(selfieRef(p.checkOutSelfieId)
          ? { checkOutSelfieId: selfieRef(p.checkOutSelfieId) }
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

/**
 * Which of these attachment ids actually exist yet.
 *
 * Media syncs after its parent — that is the whole point of it being a
 * separate queue — so an attendance row routinely names a photograph whose
 * bytes are still on the phone. A foreign key does not care about the reason:
 * it would refuse the check-in, which is the one write in this app that must
 * not be refused over a file.
 */
async function knownAttachments(
  ids: (string | null | undefined)[],
): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Set();
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(inArray(attachments.id, wanted));
  return new Set(rows.map((r) => r.id));
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
 * The working week and the holidays it excludes, for the span being asked for.
 *
 * Only the holidays inside the request are fetched. The table is small, but the
 * query is per leave request and a `select *` here would grow with the years
 * rather than with the request.
 *
 * A regionally-scoped holiday counts the same as a universal one: a day the
 * office is shut is a day nobody was going to work, and the handset's own
 * caution about scoped holidays is about which days it may auto-apply, not
 * about what somebody's leave costs them.
 */
async function leaveCalendarFor(from: string, to: string): Promise<LeaveCalendar> {
  const config = await getConfig();
  const rows = await db.execute<{ onDate: string }>(
    sql`select on_date::text as "onDate" from mbos_holidays
         where on_date between ${from}::date and ${to}::date`,
  );
  return {
    workingDays: config["workingDay.workingDays"],
    holidays: new Set(rows.map((r) => r.onDate)),
  };
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

  const spanned = inclusiveDays(from, to);
  if (spanned < 1) {
    return {
      kind: "rejected",
      value: reject("validation", "Those are not two dates this can count days between."),
    };
  }
  if (spanned > MAX_LEAVE_SPAN_DAYS) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        `That request covers ${spanned} days. Leave is applied for a stretch at a time — if this is right, it is a conversation with your manager rather than a form.`,
      ),
    };
  }

  /* A day nobody works is not a day of leave.
   *
   * This counted plain calendar days until now, so a Friday-to-Monday request
   * spent four days of somebody's balance to be absent for two — and the
   * column's own comment has said "derived from the dates and the working
   * calendar" since the table was written. See `engines/leave.ts`. */
  const days = leaveWorkingDays(from, to, await leaveCalendarFor(from, to));
  if (days < 1) {
    return {
      kind: "rejected",
      value: reject(
        "validation",
        from === to
          ? "That day is a holiday or a day the company does not work, so there is no leave to take. Nothing was saved."
          : "Every day in that range is a holiday or a non-working day, so there is no leave to take. Nothing was saved.",
      ),
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
  /* Only on a day he is STARTING. Both are required there and ignored
     everywhere else — answering a proposed day may not move its date or
     rewrite the city the office asked for. */
  planDate: z.string().nullish(),
  city: z.string().max(120).nullish(),
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
    /* A day he is STARTING, not answering.
     *
     * The negotiation this table was built for runs one way — the office
     * proposes, he agrees or refuses — and it left him unable to plan a day
     * nobody had proposed. He could not work on a Tuesday the office had not
     * thought about, which is most Tuesdays.
     *
     * A created day is born `agreed`, because there is nobody to agree with:
     * the whole content of `agreed` is "the city is settled, the shops are
     * next", and that is exactly true of a day he chose. It is NOT born
     * `planned` — that word means the shops are picked, and picking is
     * `plan_stops`, a separate write on a separate screen.
     */
    if (item.op !== "create") {
      return {
        kind: "retry",
        message:
          "That day is not on the office's plan yet. It will be tried again once it is.",
      };
    }

    const planDate = (p.planDate ?? "").trim();
    const city = (p.city ?? "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
      return {
        kind: "rejected",
        value: reject("validation", "A day needs the date it is for."),
      };
    }

    /* THE CITY IS REQUIRED, and this is the check that matters most here.
     *
     * `pickCandidates` filters the shop list by the day's city and applies NO
     * clause at all when it is empty — so a day created without one would open
     * the picker on the entire book. That is precisely the unfiltered list
     * Mahek overruled, and it would arrive silently, with nothing on the screen
     * saying the filter had gone. Refusing here is the only place it cannot be
     * got round: the handset asks for a city, and a handset is not a check. */
    if (!city) {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          "A day needs the city you are working. The shop list is filtered by it, and without one the picker would offer your whole book.",
        ),
      };
    }

    /* The business day in Asia/Kolkata, not the server's. `today()` applies
       the configured day boundary; a bare Date would answer in whatever zone
       the machine is set to and refuse a perfectly good tomorrow. */
    const todayIso = await today();
    if (planDate < todayIso) {
      return {
        kind: "rejected",
        value: reject(
          "validation",
          `${planDate} has already gone, so there is nothing left to plan. Pick today or a day ahead.`,
        ),
      };
    }

    /* `agreed` and nothing else. A handset may not mint a day already walked,
     * already refused, or already planned — the states are reached by the acts
     * that earn them. */
    await db
      .insert(mbosJourneyPlans)
      .values({
        id: item.entityId,
        userId: principal.user.id,
        planDate,
        city,
        dayState: "agreed",
        selfPlanned: true,
        respondedAt: new Date(),
        clientCreatedAt: new Date(item.clientCreatedAt),
        createdById: principal.user.id,
        updatedById: principal.user.id,
        deviceId: principal.deviceId,
      })
      /* One row per person per day, on `mbos_journey_plans_user_day_key`. A
       * clash is the office having proposed that date between him opening the
       * form and it reaching here, which is a real race on a slow connection
       * and not an error in what he did. */
      .onConflictDoNothing();

    const [landed] = await db
      .select({ id: mbosJourneyPlans.id })
      .from(mbosJourneyPlans)
      .where(eq(mbosJourneyPlans.id, item.entityId))
      .limit(1);

    if (!landed) {
      return {
        kind: "rejected",
        value: reject(
          "duplicate",
          `${planDate} is already on your plan — the office proposed it. Answer it on the Journey tab rather than starting a second one.`,
        ),
      };
    }

    /* The office is not asked, and is told. That is the difference between
     * this and the negotiation, and the manager still sees the whole calendar
     * rather than discovering the day from the visits that came off it. */
    await notifyManagers(
      principal.user.id,
      `${principal.user.name} planned ${planDate}`,
      `He is working ${city} on ${planDate}, his own plan rather than a proposed one. He picks the shops next.`,
    );

    return { kind: "accepted", value: { serverId: item.entityId } };
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
    await notifyUsers([
      {
        userId: principal.user.id,
        title: `${plan.planDate}: ${refused.length} ${refused.length === 1 ? "shop" : "shops"} left out`,
        body: `${allowed.length} of ${allowed.length + refused.length} picked. The rest are not in your book any more — ask your manager if one of them should be.`,
        kind: "warning",
        href: "/journey",
        mbosHref: "/journey",
      },
    ]).catch(() => {});
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
  /* 2-§P — the figure the band cannot give you. A judgement, so who made it and
     when are written with it: an estimate with no date is one nobody can weigh. */
  potentialMonthlyPaise: z.number().int().nonnegative().optional(),
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

  /*
   * ONE LEAD, so winning one PROMOTES the row rather than writing a second.
   *
   * The handset creates a customer locally with its own id and sends
   * `fromLeadId` alongside — a field that has been in this schema since the
   * convert flow shipped and was read by nothing, so the comment claiming the
   * two records stayed joined up was never true. It is now the whole
   * mechanism: the lead row becomes the customer, keeping its calls, its
   * timeline, its GPS fix and its history, and the lead's id goes back as
   * `serverId` so the handset points at the record that already exists.
   *
   * Without this the conversion would write a SECOND row for a shop that is
   * already in the book — which is exactly the duplication collapsing the two
   * tables was meant to end.
   */
  if (p.fromLeadId) {
    const [lead] = await db
      .select({ id: customers.id, kind: customers.kind })
      .from(customers)
      .where(eq(customers.id, p.fromLeadId))
      .limit(1);

    if (lead && lead.kind === "lead") {
      await db
        .update(customers)
        .set({
          kind: "customer",
          name: p.name,
          contactPerson: p.contactPerson || p.name,
          phone: p.phone,
          city,
          address: p.address ?? null,
          salesAmId: principal.user.id,
          thirdParty: Boolean(p.thirdParty),
          gpsLat: p.gpsLat ?? null,
          gpsLng: p.gpsLng ?? null,
          leadStage: "won",
          leadConvertedAt: new Date(),
          leadArchived: false,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, lead.id));

      if (distributor) {
        await db
          .insert(customerDistributors)
          .values({
            id: `cd_${randomUUID().slice(0, 12)}`,
            customerId: lead.id,
            distributorCustomerId: distributor.id,
            isPrimary: true,
            note: "Opened in the field",
            createdById: principal.user.id,
            updatedById: principal.user.id,
          })
          .onConflictDoNothing();
      }

      await writeTimeline(db, {
        customerId: lead.id,
        eventType: MBOS_EVENT.leadConverted,
        sourceRecordId: `${lead.id}:converted`,
        occurredAt: new Date(),
        actorUserId: principal.user.id,
        summary: `Became a customer — opened in the field${distributor ? `, billed through ${distributor.name}` : ""}`,
      }).catch(() => {});

      await notifyManagers(
        principal.user.id,
        "A new account was opened in the field",
        `${principal.user.name} converted ${p.name} in ${p.city} from a lead. It has no credit limit or terms yet — accounts decide those.`,
      );

      return { kind: "accepted", value: { serverId: lead.id } };
    }
  }

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
  /* 2-§P. Stamped with WHO and WHEN in the same breath, because this is a
     judgement rather than a measurement — nothing in MahekOne can derive what
     a shop could spend while `products.priceSource` is unset, and a figure with
     no author and no date is one a reader cannot weigh. */
  if (p.potentialMonthlyPaise !== undefined) {
    changed.potentialMonthlyPaise = p.potentialMonthlyPaise;
    changed.potentialEstimatedAt = new Date();
    changed.potentialEstimatedById = principal.user.id;
  }
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
      await notifyUsers([
        {
          userId: before.updatedById,
          title: "Your edit was overwritten",
          body: `${principal.user.name} changed ${customer.name} from the field after you did. Both versions are kept — open the conflict log to compare.`,
          kind: "warning",
          href: `/crm/customers/${customer.id}`,
        },
      ]);
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

  await notifyUsers([
    {
      userId: principal.user.id,
      title: "An order was refused",
      body: rejection.message,
      kind: "warning",
      href: "/field",
      mbosHref: "/rejections",
    },
  ]).catch(() => {});
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
/**
 * WHAT A FIELD FILE HANGS OFF, in the vocabulary `attachments.parent_type`
 * speaks.
 *
 * The handset names its own tables — `attendance`, `visit`, `expense` — and
 * the enum names them `mbos_*`, except for a payment, which lands in the CRM's
 * own `payment_receipts` and so takes the CRM's own value. Mapping here rather
 * than renaming either side: the enum values are shared with the CRM, and the
 * handset's names are in an APK that cannot be recalled.
 *
 * An unrecognised name parents NOTHING rather than guessing. That is the state
 * every MBOS upload was already in, so it is no worse than before — and it is
 * visibly wrong the moment somebody looks, where a guess would file a
 * photograph under a parent whose `canRead` rules do not apply to it.
 */
const MBOS_PARENTS: Record<string, (typeof attachmentParentEnum.enumValues)[number]> = {
  attendance: "mbos_attendance",
  visit: "mbos_visit",
  expense: "mbos_expense",
  sample: "mbos_sample",
  task: "mbos_task",
  /* A shop front photographed while raising a lead. A lead IS a `customers`
     row, so `canRead` resolves this straight through the customer's scope. */
  lead: "mbos_lead",
  /* Not `mbos_payment`: a field collection is written into `payment_receipts`,
     the same table the CRM's own receipts use, so this is that parent and
     `canRead` resolves it through the customer exactly as it does for one
     captured at a desk. */
  payment: "payment_receipt",
};

/**
 * BIND A FILE TO THE RECORD THAT NOW EXISTS.
 *
 * Media syncs AFTER its parent — that is the whole point of a separate queue —
 * so the handset uploads a photograph naming `parentId: 'pending'`, because at
 * the moment the camera closed the record it belongs to had not been written
 * yet. Something has to go back and say what it was, and until now nothing did:
 * the attachment kept the literal string `pending` as its parent for ever, so
 * `canRead` looked for a record with that id, found none, and refused the file
 * to everybody.
 *
 * Called from the handler that writes the parent, in the same pass, and
 * deliberately unable to fail it — the record is the thing that matters and a
 * photograph that stays unbound for another sync is recoverable. It is the
 * MBOS half of what `bindAttachments` does for the CRM's own forms.
 */
async function bindMbosMedia(
  attachmentId: string | null | undefined,
  parentType: (typeof attachmentParentEnum.enumValues)[number],
  parentId: string,
): Promise<void> {
  if (!attachmentId) return;
  await db
    .update(attachments)
    .set({ parentType, parentId, updatedAt: new Date() })
    .where(eq(attachments.id, attachmentId))
    .catch(() => {});
}

export async function storeMbosMedia(
  principal: MbosPrincipal,
  input: {
    clientId: string;
    kind: string;
    /** The handset's own name for the table — see `MBOS_PARENTS`. */
    parentType?: string;
    parentId?: string;
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

    /* The parent, which nothing was recording — see the note in
     * `api/mbos/media/route.ts`. A file with none is readable by its uploader
     * alone and is deleted by the nightly orphan sweep, so this pair of
     * columns is the difference between an attachment and a file with a
     * twenty-four-hour life. */
    const parentType = input.parentType
      ? (MBOS_PARENTS[input.parentType] ?? null)
      : null;
    const parentId = parentType && input.parentId ? input.parentId : null;

    await db
      .insert(attachments)
      .values({
        id: input.clientId,
        filename: input.filename,
        storedRef: stored.ref,
        contentType: actual,
        sizeBytes: stored.sizeBytes,
        thumbnailRef: actual.startsWith("image/") ? stored.ref : null,
        /* Requirement 47. The same file uploaded twice is the commonest
           duplicate there is, and this is the only moment its bytes are here
           to be hashed. */
        contentHash: createHash("sha256").update(input.bytes).digest("hex"),
        status: "available",
        parentType,
        parentId,
        uploadedById: principal.user.id,
      })
      .onConflictDoUpdate({
        target: attachments.id,
        set: {
          storedRef: stored.ref,
          contentType: actual,
          sizeBytes: stored.sizeBytes,
          contentHash: createHash("sha256").update(input.bytes).digest("hex"),
          status: "available",
          /* Re-parented on a re-upload only where this one names a parent: a
             retry that has lost the name must not orphan a file that was
             already filed correctly. */
          ...(parentType ? { parentType, parentId } : {}),
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
