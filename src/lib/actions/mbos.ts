import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  attachments,
  bills,
  complaints,
  customers,
  mbosAttendanceDays,
  mbosConflicts,
  mbosDevices,
  mbosExpenses,
  mbosLeads,
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
import { today, recomputeOutstanding, recomputeLastContact } from "../recompute";
import { allocate, type AllocatableBill } from "../engines/allocation";
import { computeHealth, type HealthFacts } from "../engines/health";
import { fileStorage } from "../storage";
import { sniffContentType } from "../file-types";
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

async function handleItem(
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
  checkInAt: z.number().optional(),
  checkOutAt: z.number().optional(),
  checkInLat: z.number().optional(),
  checkInLng: z.number().optional(),
  checkInAccuracyM: z.number().int().optional(),
  checkOutLat: z.number().optional(),
  checkOutLng: z.number().optional(),
  checkOutAccuracyM: z.number().int().optional(),
  durationSeconds: z.number().int().optional(),
  outcome: z
    .enum(["visited", "order", "payment", "complaint", "sample", "not_available", "closed"])
    .default("visited"),
  notes: z.string().max(4000).optional(),
  transcript: z.string().max(20000).optional(),
  transcriptIsAi: z.boolean().optional(),
  shopPhotoId: z.string().optional(),
  custPhotoId: z.string().optional(),
  voiceNoteId: z.string().optional(),
  journeyPlanStopId: z.string().optional(),
  wasPlanned: z.boolean().optional(),
  deviationReason: z.string().max(500).optional(),
  nextFollowUpDate: z.string().optional(),
});

/** Metres between two fixes. Enough precision for "is this the same street". */
function metresBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

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
    if (distance > config["mbos.location.visitMismatchM"]) {
      locationMismatch = true;
      unverifiedReason = `The check-in was ${Math.round(distance)} m from ${customer.name}'s own pin.`;
    } else {
      verified = true;
    }
  }

  const checkInAt = p.checkInAt ? new Date(p.checkInAt) : new Date(item.clientCreatedAt);
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
               (${checkInAt}::timestamptz at time zone 'Asia/Kolkata')::date
             ),
             updated_at = now()
       where id = ${customer.id}
    `);

    if (p.journeyPlanStopId) {
      await tx.execute(sql`
        update mbos_journey_stops
           set status = 'visited', actual_visit_at = ${checkInAt}, updated_at = now()
         where id = ${p.journeyPlanStopId}
      `);
    }
  });

  return { kind: "accepted", value: { serverId: item.entityId } };
}

/* ------------------------------------------------------------------ orders */

const orderSchema = z.object({
  customerId: z.string(),
  orderedAt: z.number().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string(),
        /** CANS, like every other quantity in MahekOne. */
        quantityCans: z.number().int().positive(),
        ratePaise: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1),
  totalAmountPaise: z.number().int().nonnegative(),
  creditDays: z.number().int().optional(),
  expectedDispatch: z.string().optional(),
  /** What the handset believed the customer owed when it took the order. */
  outstandingAsOfPaise: z.number().int().optional(),
  outstandingAsOf: z.number().optional(),
  /** The price tag the lines were priced against, where they were priced. */
  priceTag: z.string().optional(),
  visitId: z.string().optional(),
});

async function handleOrder(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
  const parsed = orderSchema.safeParse(item.payload);
  if (!parsed.success) return validationRejection(parsed.error);
  const p = parsed.data;

  const found = await scopedCustomer(principal, p.customerId);
  if (!found.ok) return { kind: "rejected", value: found.value };
  const customer = found.customer;
  const config = await getConfig();

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
               (${orderedAt}::timestamptz at time zone 'Asia/Kolkata')::date
             ),
             last_order_value = ${p.totalAmountPaise},
             updated_at = now()
       where id = ${customer.id}
    `);

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
  receivedAt: z.string().optional(),
  mode: z.string().max(60).optional(),
  reference: z.string().max(120).optional(),
  note: z.string().max(2000).optional(),
  /** Named bills, or nothing — in which case the money goes oldest first. */
  billIds: z.array(z.string()).optional(),
  visitId: z.string().optional(),
});

async function handlePayment(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
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
    selectedBillIds: p.billIds,
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
  severity: z.enum(["low", "medium", "high"]).optional(),
  mobileNumber: z.string().max(20).optional(),
  requestCn: z.boolean().optional(),
  visitId: z.string().optional(),
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
  productId: z.string().optional(),
  quantityCans: z.number().int().positive().optional(),
  requestedDate: z.string().optional(),
  deliveredAt: z.number().optional(),
  deliveryPhotoId: z.string().optional(),
  followUpDate: z.string().optional(),
  feedbackNotes: z.string().max(2000).optional(),
  visitId: z.string().optional(),
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
  companyName: z.string().max(200).optional(),
  mobile: z.string().min(6).max(20),
  city: z.string().max(120).optional(),
  area: z.string().max(120).optional(),
  source: z
    .enum(["manual", "website", "referral", "exhibition", "cold_call", "whatsapp", "campaign"])
    .optional(),
  estimatedPotentialPaise: z.number().int().nonnegative().optional(),
  stage: z.enum(["new", "contacted", "qualified", "negotiation", "won", "lost"]).optional(),
  nextFollowUpDate: z.string().optional(),
  notes: z.string().max(4000).optional(),
  gpsLat: z.number().optional(),
  gpsLng: z.number().optional(),
  lostReason: z.string().max(500).optional(),
});

async function handleLead(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
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
  description: z.string().max(4000).optional(),
  customerId: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  dueDate: z.string().optional(),
  status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
  completionNote: z.string().max(2000).optional(),
  completionPhotoId: z.string().optional(),
  snoozedTo: z.string().optional(),
  snoozeReason: z.string().max(500).optional(),
});

async function handleTask(principal: MbosPrincipal, item: SyncItem): Promise<Handled> {
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
  description: z.string().max(2000).optional(),
  billPhotoId: z.string().optional(),
  claimId: z.string().optional(),
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
  checkInAt: z.number().optional(),
  checkOutAt: z.number().optional(),
  checkInLat: z.number().optional(),
  checkInLng: z.number().optional(),
  selfieId: z.string().optional(),
  notes: z.string().max(1000).optional(),
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
      checkInSelfieId: p.selfieId ?? null,
      checkOutAt: p.checkOutAt ? new Date(p.checkOutAt) : null,
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
        updatedAt: new Date(),
        updatedById: principal.user.id,
      },
    });

  return { kind: "accepted", value: { serverId: rowId } };
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

async function handleCustomerEdit(
  principal: MbosPrincipal,
  item: SyncItem,
): Promise<Handled> {
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
  const accepted = config["attachments.acceptedTypes"];
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
