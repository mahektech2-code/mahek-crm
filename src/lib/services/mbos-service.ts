import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  customers,
  mbosDevices,
  notifications,
  users,
  type User,
} from "@/db/schema";
import {
  scopeForUser,
  scopedUserIds,
  type DataScope, scopedToUsers,} from "../access-control";
import { getConfig } from "../config/store";
import { verifyPassword } from "../password";
import { bearerFrom, verifyToken, signingKeyPresent } from "../mbos/token";
import { today } from "../recompute";
import { addDays } from "../business-date";
import type { PullDelta } from "../mbos/types";

/* ---------------------------------------------------------------------------
 * MBOS — every read the handset makes.
 *
 * Two things shape this file and nothing else does.
 *
 * **The scope is not this app's to invent.** A salesman's book is decided by
 * `ASSIGNED_TO_SQL`, the one definition every CRM list already reads, and the
 * user's scope comes from `scopeForUser` — the same function the cookie path
 * uses. A field app that filtered by `owner_id` on its own would show a book
 * the CRM would not have shown, and neither side would look wrong.
 *
 * **Internal notes are not in any payload here.** PROTOCOL §9 and brief §6.3:
 * a note that could leak is not on the device to leak. That is enforced by
 * this file never selecting `mbos_internal_notes` at all rather than by a
 * screen declining to draw it — a filter in the app is a filter somebody can
 * turn off, and the bytes would already be on the handset.
 * ------------------------------------------------------------------------- */

export type MbosPrincipal = {
  user: User;
  deviceId: string;
  role: "telecaller" | "manager" | "accounts" | "admin";
  scope: DataScope;
};

export type AuthFailure = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

export type Authenticated = { ok: true; principal: MbosPrincipal };

/* ------------------------------------------------------------ the five checks
 *
 * PROTOCOL's sign-in, in order, each with its own sentence. The order is the
 * point: telling somebody "no territory assigned" when the real problem is
 * their password sends them to the wrong person, and telling them "wrong
 * password" when their account was closed sends them nowhere at all.
 * ------------------------------------------------------------------------- */

export type LoginCheckFailure = {
  ok: false;
  /** Which of the five it fell at — used for the status code, never shown. */
  step:
    | "unknown_user"
    | "bad_password"
    | "inactive"
    | "no_app_access"
    | "bootstrap_failed";
  error: string;
};

export type LoginCheckSuccess = { ok: true; user: User };

/** Minimum password length. A field handset types this on a phone keypad. */
const MIN_PASSWORD_LENGTH = 8;

export async function runLoginChecks(input: {
  mobile: string;
  password?: string;
}): Promise<LoginCheckSuccess | LoginCheckFailure> {
  const identifier = input.mobile.trim();

  /* 1 — is this anybody? Work number OR email, because a salesman knows their
   * phone and the office knows their address, and one field takes both. */
  const [user] = await db
    .select()
    .from(users)
    .where(
      sql`lower(${users.email}) = lower(${identifier}) or ${users.phone} = ${identifier}`,
    )
    .limit(1);

  if (!user) {
    return {
      ok: false,
      step: "unknown_user",
      error: `No MahekOne account uses ${identifier}. Check the number, or ask your manager to have one created.`,
    };
  }

  /* 2 — does the password verify? */
  const password = input.password ?? "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      step: "bad_password",
      error: `A password is at least ${MIN_PASSWORD_LENGTH} characters. That one is shorter, so it cannot be the right one.`,
    };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return {
      ok: false,
      step: "bad_password",
      error: "That password is not right. Try again, or use Forgot password on the web app to set a new one.",
    };
  }

  /* 3 — is the account still open? Named separately from the password, because
   * a leaver typing their own correct password has not made a mistake and must
   * not be sent round the password loop. */
  if (!user.active) {
    return {
      ok: false,
      step: "inactive",
      error: `${user.name}'s MahekOne account has been closed. Your manager or the Admin Console team can reopen it — nothing on this handset is lost in the meantime.`,
    };
  }

  /* 4 — assigned territory. A salesman with no `field` grant has no book: the
   * app would open on an empty customer list with nothing saying why. */
  const [grant] = await db
    .select({ id: appAccess.id })
    .from(appAccess)
    .where(and(eq(appAccess.userId, user.id), eq(appAccess.app, "field")))
    .limit(1);

  if (!grant) {
    return {
      ok: false,
      step: "no_app_access",
      error: `${user.name} has a MahekOne account but has not been given the field app, so there is no territory to load. Ask your manager to grant it.`,
    };
  }

  return { ok: true, user };
}

/* ------------------------------------------------------------ device binding */

export type DeviceOutcome =
  | { ok: true; deviceRowId: string; firstBind: boolean }
  | { ok: false; error: string };

/**
 * One active handset per person.
 *
 * A shared handset is how one salesman's visits get attributed to another, and
 * a phone that left the company with a live session is a customer book
 * somebody else is carrying. So a second device is REFUSED rather than
 * silently allowed alongside the first — and the way back in is an admin
 * releasing the old row, which is a decision with a name against it.
 *
 * The override is `active = false` on the previous binding: releasing a device
 * is what an admin does, and this reads that rather than inventing a second
 * flag that could disagree with it.
 */
export async function checkDeviceBinding(
  userId: string,
  deviceId: string,
): Promise<DeviceOutcome> {
  const [existingForDevice] = await db
    .select()
    .from(mbosDevices)
    .where(eq(mbosDevices.deviceId, deviceId))
    .limit(1);

  // The device id is unique across the table: a handset that already belongs
  // to somebody else is not this person's to sign in on.
  if (existingForDevice && existingForDevice.userId !== userId) {
    return {
      ok: false,
      error:
        "This handset is registered to another employee. An admin has to release it in the Admin Console before it can be used by somebody else.",
    };
  }

  const otherActive = await db
    .select({ id: mbosDevices.id, deviceId: mbosDevices.deviceId })
    .from(mbosDevices)
    .where(and(eq(mbosDevices.userId, userId), eq(mbosDevices.active, true)));

  const conflicting = otherActive.filter((d) => d.deviceId !== deviceId);
  if (conflicting.length && !existingForDevice) {
    return {
      ok: false,
      error:
        "You are already signed in on another handset. One device per person — ask an admin to release the old one in the Admin Console, then sign in here.",
    };
  }

  return {
    ok: true,
    deviceRowId: existingForDevice?.id ?? "",
    firstBind: !existingForDevice,
  };
}

/* ---------------------------------------------------- authenticating a request */

/**
 * The bearer credential on every call but `/login`.
 *
 * Nothing is read from the token except who and which handset. Role, app
 * access and whether the account is still open are read from the database
 * every time, so moving somebody off the field app takes effect on their next
 * request rather than when their token happens to expire.
 */
export async function authenticate(
  request: Request,
): Promise<Authenticated | AuthFailure> {
  if (!signingKeyPresent()) {
    return {
      ok: false,
      status: 503,
      code: "not_configured",
      error:
        "MBOS_JWT_SECRET is not set on this deployment, so the field app cannot be signed in to.",
    };
  }

  const verified = verifyToken(bearerFrom(request), "access");
  if (!verified.ok) {
    return {
      ok: false,
      status: 401,
      code: verified.reason,
      error:
        verified.reason === "expired"
          ? "This sign-in has expired. The app will refresh it and try again."
          : "Not signed in.",
    };
  }

  const principal = await loadPrincipal(verified.claims.sub, verified.claims.did);
  if (!principal.ok) return principal;
  return principal;
}

export async function loadPrincipal(
  userId: string,
  deviceId: string,
): Promise<Authenticated | AuthFailure> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return { ok: false, status: 401, code: "unknown_user", error: "Not signed in." };
  }
  if (!user.active) {
    return {
      ok: false,
      status: 403,
      code: "inactive",
      error: `${user.name}'s account has been closed. Ask your manager to reopen it.`,
    };
  }

  const [grant] = await db
    .select({ id: appAccess.id })
    .from(appAccess)
    .where(and(eq(appAccess.userId, user.id), eq(appAccess.app, "field")))
    .limit(1);
  if (!grant) {
    return {
      ok: false,
      status: 403,
      code: "no_app_access",
      error: "The field app is no longer granted to this account, so there is no territory to load.",
    };
  }

  const [device] = await db
    .select()
    .from(mbosDevices)
    .where(eq(mbosDevices.deviceId, deviceId))
    .limit(1);
  if (!device || device.userId !== user.id || !device.active) {
    return {
      ok: false,
      status: 403,
      code: "device_released",
      error:
        "This handset is no longer bound to your account. Sign in again — an admin may have released it.",
    };
  }

  // `team` explicitly rather than by default: the narrowing preference is a
  // cookie, and a handset has no cookie jar to read one from. A manager on the
  // field app sees their team, which is what the launcher would have given
  // them anyway.
  const ctx = await scopeForUser(user, "team");
  return {
    ok: true,
    principal: { user, deviceId, role: ctx.role, scope: ctx.scope },
  };
}

/* -------------------------------------------------------------- the cursor */

/**
 * Opaque to the client, and deliberately so: it is a server-received
 * timestamp, and a handset that could read it would be tempted to construct
 * one from its own clock — which PROTOCOL §7 says is wrong and its owner can
 * set.
 */
export function encodeCursor(at: Date): string {
  return Buffer.from(`v1:${at.toISOString()}`).toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): Date | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    if (!raw.startsWith("v1:")) return null;
    const at = new Date(raw.slice(3));
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- the config */

/**
 * What the handset is allowed to know about configuration: every `mbos.*` key,
 * plus `products.priceSource` — which is not an MBOS setting but decides
 * whether the order form may show a value at all, and a handset that guessed
 * would put a confident wrong figure in front of a customer.
 */
export async function mbosConfigPayload(): Promise<Record<string, unknown>> {
  const config = (await getConfig()) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith("mbos.")) out[key] = value;
  }
  out["products.priceSource"] = config["products.priceSource"];
  return out;
}

/* ------------------------------------------------------------- the payloads */

function scopeIn(ids: string[] | null) {
  return scopedToUsers(ids);
}

/** The customer ids this principal may see. Every other query filters on it. */
export async function customerIdsInScope(
  principal: MbosPrincipal,
): Promise<string[]> {
  const ids = scopedUserIds(principal.scope);
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(scopeIn(ids));
  return rows.map((r) => r.id);
}

export type BootstrapPayload = {
  serverTime: number;
  cursor: string;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    role: string;
    initials: string;
  };
  device: { deviceId: string };
  customers: unknown[];
  products: unknown[];
  journey: { today: unknown[]; tomorrow: unknown[] };
  tasks: unknown[];
  samples: unknown[];
  leads: unknown[];
  timeline: unknown[];
  leaveBalances: unknown[];
  documents: unknown[];
  courses: unknown[];
  notifications: unknown[];
  config: Record<string, unknown>;
};

/** How many timeline events per customer the snapshot carries. */
const TIMELINE_PER_CUSTOMER = 50;

export async function buildBootstrap(
  principal: MbosPrincipal,
): Promise<BootstrapPayload> {
  const now = new Date();
  const ids = await customerIdsInScope(principal);
  const day = await today();
  const tomorrow = addDays(day, 1);

  const [
    customerRows,
    productRows,
    journeyRows,
    taskRows,
    sampleRows,
    leadRows,
    timelineRows,
    leaveRows,
    documentRows,
    courseRows,
    notificationRows,
    config,
  ] = await Promise.all([
    customersForDevice(ids),
    activeCatalogue(),
    journeyStops(principal.user.id, [day, tomorrow]),
    openTasks(principal.user.id),
    openSamples(principal.user.id, ids),
    openLeads(principal.user.id),
    recentTimeline(ids, TIMELINE_PER_CUSTOMER),
    leaveBalances(principal.user.id, Number(day.slice(0, 4))),
    visibleDocuments(principal.role, ids),
    coursesFor(principal.user.id),
    unreadNotifications(principal.user.id),
    mbosConfigPayload(),
  ]);

  return {
    serverTime: now.getTime(),
    cursor: encodeCursor(now),
    user: {
      id: principal.user.id,
      name: principal.user.name,
      email: principal.user.email,
      phone: principal.user.phone,
      role: principal.role,
      initials: principal.user.initials,
    },
    device: { deviceId: principal.deviceId },
    customers: customerRows,
    products: productRows,
    journey: {
      today: journeyRows.filter((r) => r.planDate === day),
      tomorrow: journeyRows.filter((r) => r.planDate === tomorrow),
    },
    tasks: taskRows,
    samples: sampleRows,
    leads: leadRows,
    timeline: timelineRows,
    leaveBalances: leaveRows,
    documents: documentRows,
    courses: courseRows,
    notifications: notificationRows,
    config,
  };
}

/* -------------------------------------------------------------- the queries */

/**
 * The customer as the handset holds it: identity, where the shop is, what they
 * owe and what they may owe.
 *
 * `outstanding` and `creditLimitPaise` travel together on purpose — a limit
 * without a balance cannot answer the only question the order form asks of
 * either, and `outstandingAsOf` is what lets the app say how old its answer is
 * rather than presenting a cached figure as current (PROTOCOL §8).
 */
async function customersForDevice(ids: string[]) {
  if (!ids.length) return [];
  return db.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.contact_person as "contactPerson", c.phone,
           c.whatsapp_phone as "whatsappPhone", c.alt_phone as "altPhone",
           c.address, c.city, c.region, c.area, c.beat,
           c.territory_region as "territoryRegion", c.dealer_code as "dealerCode",
           c.kind, c.status, c.gstin,
           c.gps_lat as "gpsLat", c.gps_lng as "gpsLng",
           c.gps_accuracy_m as "gpsAccuracyM", c.gps_captured_at as "gpsCapturedAt",
           c.customer_type as "customerType", c.potential,
           c.credit_term_days as "creditTermDays", c.credit_days as "creditDays",
           c.credit_limit_paise as "creditLimitPaise",
           c.credit_blocked as "creditBlocked",
           c.credit_block_reason as "creditBlockReason",
           c.outstanding as "outstandingPaise",
           c.slow_payer as "slowPayer",
           c.health_score as "healthScore",
           c.health_components as "healthComponents",
           c.health_computed_at as "healthComputedAt",
           c.last_order_date as "lastOrderDate",
           c.last_visit_date as "lastVisitDate",
           c.visit_frequency_days as "visitFrequencyDays",
           c.cycle_days as "cycleDays",
           c.sales_person_name as "salesPersonName",
           c.updated_at as "updatedAt"
      from customers c
     where c.id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}
     order by c.name asc
  `);
}

/**
 * The catalogue, and only what can actually be ordered: a SKU is the only
 * level `interaction_product_lines` may point at, so offering anything above
 * it puts a line on an order that cannot be saved.
 */
async function activeCatalogue() {
  return db.execute<Record<string, unknown>>(sql`
    select p.id, p.name, p.raw_name as "rawName", p.pack_size as "packSize",
           p.packing, p.millilitres_per_can as "millilitresPerCan",
           p.cans_per_box as "cansPerBox",
           p.weight_grams as "weightGrams", p.weight_basis as "weightBasis",
           p.active, p.status, p.display_order as "displayOrder",
           b.name as "brandName", f.name as "formulationName",
           p.updated_at as "updatedAt"
      from products p
      left join product_brands b on b.id = p.brand_id
      left join product_formulations f on f.id = p.formulation_id
     where p.active = true and p.status = 'ok'
     order by p.display_order asc, p.name asc
  `);
}

async function journeyStops(userId: string, days: string[]) {
  const rows = await db.execute<{ planDate: string } & Record<string, unknown>>(sql`
    select s.id, s.plan_id as "planId", s.customer_id as "customerId",
           s.sequence, s.planned_at as "plannedAt", s.status,
           s.actual_visit_at as "actualVisitAt", s.skip_reason as "skipReason",
           p.plan_date::text as "planDate", p.beat, p.area, p.status as "planStatus"
      from mbos_journey_stops s
      join mbos_journey_plans p on p.id = s.plan_id
     where p.user_id = ${userId}
       and p.plan_date::text in ${sql`(${sql.join(days.map((d) => sql`${d}`), sql`, `)})`}
     order by p.plan_date asc, s.sequence asc
  `);
  return rows;
}

async function openTasks(userId: string) {
  return db.execute<Record<string, unknown>>(sql`
    select t.id, t.title, t.description, t.priority, t.due_date::text as "dueDate",
           t.customer_id as "customerId", t.status,
           t.snoozed_to::text as "snoozedTo", t.snooze_reason as "snoozeReason",
           t.source_type as "sourceType", t.source_id as "sourceId",
           t.updated_at as "updatedAt"
      from mbos_tasks t
     where t.assigned_to_user_id = ${userId}
       and t.status in ('open', 'in_progress')
     order by t.due_date asc nulls last
  `);
}

async function openSamples(userId: string, customerIds: string[]) {
  if (!customerIds.length) return [];
  return db.execute<Record<string, unknown>>(sql`
    select s.id, s.customer_id as "customerId", s.product_id as "productId",
           s.quantity_cans as "quantityCans",
           s.requested_date::text as "requestedDate",
           s.delivered_at as "deliveredAt", s.trial_outcome as "trialOutcome",
           s.follow_up_date::text as "followUpDate",
           s.feedback_notes as "feedbackNotes",
           s.converted_order_id as "convertedOrderId",
           s.updated_at as "updatedAt"
      from mbos_samples s
     where s.salesman_id = ${userId}
       and s.trial_outcome = 'pending'
     order by s.follow_up_date asc nulls last
  `);
}

async function openLeads(userId: string) {
  return db.execute<Record<string, unknown>>(sql`
    select l.id, l.name, l.company_name as "companyName", l.mobile, l.city, l.area,
           l.source, l.stage, l.estimated_potential_paise as "estimatedPotentialPaise",
           l.next_follow_up_date::text as "nextFollowUpDate", l.notes,
           l.gps_lat as "gpsLat", l.gps_lng as "gpsLng",
           l.converted_customer_id as "convertedCustomerId",
           l.last_activity_date::text as "lastActivityDate",
           l.updated_at as "updatedAt"
      from mbos_leads l
     where l.assigned_to_user_id = ${userId}
       and l.archived = false
       and l.stage not in ('won', 'lost')
     order by l.next_follow_up_date asc nulls last
  `);
}

/**
 * The last N events for each customer, in one query.
 *
 * A window function rather than N queries: a book of six hundred shops would
 * otherwise be six hundred round trips to a database three hundred
 * milliseconds away, which is the bootstrap taking three minutes.
 */
async function recentTimeline(ids: string[], perCustomer: number) {
  if (!ids.length) return [];
  return db.execute<Record<string, unknown>>(sql`
    select id, "customerId", "eventType", "sourceApp", "sourceRecordId",
           "occurredAt", "actorUserId", summary
      from (
        select t.id, t.customer_id as "customerId", t.event_type as "eventType",
               t.source_app as "sourceApp", t.source_record_id as "sourceRecordId",
               t.occurred_at as "occurredAt", t.actor_user_id as "actorUserId",
               t.summary,
               row_number() over (
                 partition by t.customer_id order by t.occurred_at desc, t.id desc
               ) as rn
          from timeline_events t
         where t.customer_id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}
      ) ranked
     where rn <= ${perCustomer}
     order by "customerId" asc, "occurredAt" desc
  `);
}

async function leaveBalances(userId: string, year: number) {
  return db.execute<Record<string, unknown>>(sql`
    select b.id, b.year, b.leave_type as "leaveType",
           b.entitled_days as "entitledDays", b.used_days as "usedDays"
      from mbos_leave_balances b
     where b.user_id = ${userId} and b.year = ${year}
     order by b.leave_type asc
  `);
}

/**
 * The library, filtered by role and by book.
 *
 * `visible_to_roles` empty means everybody — a price list nobody tagged is
 * still a price list the field team needs, and an empty list read as "nobody"
 * would produce a document section that is silently blank on every handset.
 */
async function visibleDocuments(role: string, customerIds: string[]) {
  const scoped = customerIds.length
    ? sql`(d.customer_id is null or d.customer_id in ${sql`(${sql.join(customerIds.map((i) => sql`${i}`), sql`, `)})`})`
    : sql`d.customer_id is null`;

  return db.execute<Record<string, unknown>>(sql`
    select d.id, d.title, d.category, d.attachment_id as "attachmentId",
           d.customer_id as "customerId", d.updated_at as "updatedAt"
      from mbos_documents d
     where d.active = true
       and (jsonb_array_length(d.visible_to_roles) = 0
            or d.visible_to_roles ? ${role})
       and ${scoped}
     order by d.category asc, d.title asc
  `);
}

async function coursesFor(userId: string) {
  return db.execute<Record<string, unknown>>(sql`
    select c.id, c.title, c.category, c.duration_minutes as "durationMinutes",
           c.attachment_id as "attachmentId",
           c.pass_mark_percent as "passMarkPercent",
           c.mandatory, c.due_date::text as "dueDate",
           p.started_at as "startedAt", p.completed_at as "completedAt",
           p.quiz_score_percent as "quizScorePercent", p.passed,
           p.certificate_ref as "certificateRef"
      from mbos_courses c
      left join mbos_course_progress p
             on p.course_id = c.id and p.user_id = ${userId}
     where c.active = true
     order by c.mandatory desc, c.due_date asc nulls last, c.title asc
  `);
}

async function unreadNotifications(userId: string) {
  return db
    .select({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      kind: notifications.kind,
      href: notifications.href,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
    .orderBy(sql`${notifications.createdAt} desc`)
    .limit(100);
}

/* ---------------------------------------------------------------- the delta */

/**
 * Everything that changed since the cursor, in the same shapes the bootstrap
 * used — so the handset applies one merge path rather than two.
 *
 * With no cursor this returns nothing rather than everything: a client with no
 * cursor should call `/bootstrap`, and quietly answering a full snapshot from
 * the sync endpoint is how a handset on 2G ends up downloading the book on
 * every pass.
 */
export async function buildPull(
  principal: MbosPrincipal,
  cursor: string | null | undefined,
): Promise<PullDelta> {
  const now = new Date();
  const since = decodeCursor(cursor);
  const nextCursor = encodeCursor(now);

  if (!since) {
    return {
      cursor: nextCursor,
      customers: [],
      products: [],
      timeline: [],
      config: await mbosConfigPayload(),
      notifications: [],
    };
  }

  const ids = await customerIdsInScope(principal);
  const idList = ids.length
    ? sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`
    : null;

  const [changedCustomers, changedProducts, newTimeline, freshNotifications] =
    await Promise.all([
      idList
        ? db.execute<Record<string, unknown>>(sql`
            select c.id, c.name, c.contact_person as "contactPerson", c.phone,
                   c.address, c.city, c.area, c.beat, c.status,
                   c.gps_lat as "gpsLat", c.gps_lng as "gpsLng",
                   c.credit_limit_paise as "creditLimitPaise",
                   c.credit_blocked as "creditBlocked",
                   c.credit_block_reason as "creditBlockReason",
                   c.outstanding as "outstandingPaise",
                   c.slow_payer as "slowPayer",
                   c.health_score as "healthScore",
                   c.health_components as "healthComponents",
                   c.health_computed_at as "healthComputedAt",
                   c.last_order_date as "lastOrderDate",
                   c.last_visit_date as "lastVisitDate",
                   c.updated_at as "updatedAt"
              from customers c
             where c.id in ${idList} and c.updated_at > ${since}
             order by c.updated_at asc
             limit 2000
          `)
        : Promise.resolve([]),
      db.execute<Record<string, unknown>>(sql`
        select p.id, p.name, p.pack_size as "packSize", p.packing,
               p.millilitres_per_can as "millilitresPerCan",
               p.cans_per_box as "cansPerBox", p.active, p.status,
               p.updated_at as "updatedAt"
          from products p
         where p.updated_at > ${since}
         order by p.updated_at asc
         limit 2000
      `),
      idList
        ? db.execute<Record<string, unknown>>(sql`
            select t.id, t.customer_id as "customerId", t.event_type as "eventType",
                   t.source_app as "sourceApp", t.source_record_id as "sourceRecordId",
                   t.occurred_at as "occurredAt", t.actor_user_id as "actorUserId",
                   t.summary
              from timeline_events t
             where t.customer_id in ${idList} and t.created_at > ${since}
             order by t.created_at asc
             limit 2000
          `)
        : Promise.resolve([]),
      db
        .select({
          id: notifications.id,
          title: notifications.title,
          body: notifications.body,
          kind: notifications.kind,
          href: notifications.href,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, principal.user.id),
            sql`${notifications.createdAt} > ${since}`,
          ),
        )
        .orderBy(sql`${notifications.createdAt} asc`)
        .limit(200),
    ]);

  return {
    cursor: nextCursor,
    customers: changedCustomers as unknown[],
    products: changedProducts as unknown[],
    timeline: newTimeline as unknown[],
    config: await mbosConfigPayload(),
    notifications: freshNotifications as unknown[],
  };
}
