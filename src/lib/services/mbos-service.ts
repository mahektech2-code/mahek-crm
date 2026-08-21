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
import { addDays, APP_TIMEZONE } from "../business-date";
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
  /**
   * Today's route and tomorrow's, as flat stops.
   *
   * It was `journey: { today, tomorrow }` and the handset reads `journeyStops`
   * — so the plan was built, sent, and applied by nothing. The split is not
   * needed either: every screen there asks for a `planDate`, which is on each
   * row, and a grouping by two fixed days cannot answer "the day after
   * tomorrow" the moment somebody plans one.
   */
  journeyStops: unknown[];
  /** In force today. See `priceListRows` — the handset replaces it wholesale. */
  priceList: unknown[];
  /** Live promotions, as data. Nothing here interprets eligibility or benefit. */
  schemes: unknown[];
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
    priceRows,
    schemeRowsForBootstrap,
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
    priceListRows(),
    schemeRows(null),
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
    journeyStops: journeyRows,
    priceList: priceRows,
    schemes: schemeRowsForBootstrap,
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

/**
 * The day's route, in the columns the handset's own table has.
 *
 * A pull row IS the local row — `applyPull` upserts whatever columns arrive,
 * verbatim — so this is the one query where the aliases are not MahekOne's
 * vocabulary but the app's. `sequence` is `seq` there and `actual_visit_at` is
 * `actualAt`; sending the server's spelling writes nothing at all, because
 * SQLite refuses a column it does not have and the whole plan goes with it.
 *
 * `beat`, `area` and the plan's status are deliberately NOT sent. The screen
 * joins each stop to the customer it names for everything it shows, and a
 * second copy of the shop's area on the stop is a second thing to keep true.
 */
async function journeyStops(userId: string, days: string[]) {
  const rows = await db.execute<{ planDate: string } & Record<string, unknown>>(sql`
    select s.id,
           p.plan_date::text as "planDate",
           s.customer_id as "customerId",
           s.sequence as "seq",
           /* HH:MM in Asia/Kolkata, because that is what the SCREEN treats
            * this as -- it prints the value (Planned 09:30) and compares it
            * against the wall clock to decide whether the salesman is running
            * late. A timestamp would print as an ISO string and compare as
            * nonsense. */
           to_char(s.planned_at at time zone ${APP_TIMEZONE}, 'HH24:MI') as "plannedAt",
           /* Epoch milliseconds: the column on the handset is an INTEGER, and
            * every other instant in that store is counted the same way.
            * double precision rather than bigint so it arrives as a number --
            * a bigint comes back as a string, and this is well inside the
            * range a float carries exactly. */
           (extract(epoch from s.actual_visit_at) * 1000)::double precision as "actualAt",
           s.status,
           s.skip_reason as "skipReason"
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
async function visibleDocuments(role: string, customerIds: string[], since?: string | null) {
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
       ${since ? sql`and d.updated_at > ${since}` : sql``}
     order by d.category asc, d.title asc
  `);
}

async function coursesFor(userId: string, since?: string | null) {
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
       ${since ? sql`and (c.updated_at > ${since} or p.updated_at > ${since})` : sql``}
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

/**
 * What a customer pays, per can.
 *
 * Only rates in force TODAY. A rate dated out is not a rate — sending it would
 * put the handset in the position of deciding which of two prices applies, and
 * the answer to that is a date comparison the server has already made.
 *
 * The whole list rather than a delta, because the handset replaces it
 * wholesale: a withdrawn rate has to disappear, and there is no `updated_at`
 * on a row that no longer exists to say so.
 */
async function priceListRows() {
  return db.execute<Record<string, unknown>>(sql`
    select pl.customer_price_tag as "priceTag",
           pl.product_id as "productId",
           pl.rate_paise as "ratePaise"
      from mbos_price_list pl
     where (pl.valid_from is null
            or pl.valid_from <= (now() at time zone ${APP_TIMEZONE})::date)
       and (pl.valid_to is null
            or pl.valid_to >= (now() at time zone ${APP_TIMEZONE})::date)
     order by pl.customer_price_tag asc, pl.product_id asc
     limit 20000
  `);
}

/**
 * Live promotions.
 *
 * Eligibility and benefit go down as they are stored — as data. That is what
 * lets a manager add a Diwali scheme in October without shipping a handset
 * build, and it is why nothing here interprets either column.
 *
 * A scheme whose dates have passed is not sent; the tombstone channel is what
 * removes it from a phone that already has it.
 */
async function schemeRows(since: string | null) {
  return db.execute<Record<string, unknown>>(sql`
    select s.id, s.name, s.description, s.eligibility, s.benefit,
           s.valid_from::text as "validFrom", s.valid_to::text as "validTo",
           s.active
      from mbos_schemes s
     where s.active
       and (s.valid_from is null or s.valid_from <= (now() at time zone ${APP_TIMEZONE})::date)
       and (s.valid_to is null or s.valid_to >= (now() at time zone ${APP_TIMEZONE})::date)
       ${since ? sql`and s.updated_at > ${since}` : sql``}
     order by s.updated_at asc
     limit 500
  `);
}

/**
 * Rows the server says are gone.
 *
 * Two kinds in one channel: a tombstone written against this salesman, and one
 * written against nobody — a product withdrawn from the catalogue is gone for
 * the whole team, so `user_id is null` means everybody.
 *
 * Grouped by table on the way out because that is the shape the handset
 * applies: one `DELETE … WHERE id IN` per entity rather than one per row.
 */
async function deletionsSince(userId: string, since: string) {
  const rows = await db.execute<{ entity: string; entityId: string }>(sql`
    select d.entity, d.entity_id as "entityId"
      from mbos_deletions d
     where d.at > ${since}
       and (d.user_id is null or d.user_id = ${userId})
     order by d.at asc
     limit 2000
  `);

  const byEntity = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEntity.get(row.entity);
    if (list) list.push(row.entityId);
    else byEntity.set(row.entity, [row.entityId]);
  }
  return [...byEntity].map(([entity, ids]) => ({ entity, ids }));
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
      transcripts: [],
      journeyStops: [],
      approvals: [],
      planDays: [],
      leaveBalances: [],
      priceList: [],
      schemes: [],
      documents: [],
      courses: [],
      deletions: [],
    };
  }

  /* A parameter is a STRING, not a Date.
   *
   * `postgres` serialises a JS Date by asking Node to measure it as text, and
   * on Node 25 that throws — so every query in this delta carrying the cursor
   * failed, which is every query in it. It fails inside the driver rather than
   * in SQL, so the type checker sees nothing and the whole pull answers 500
   * the moment a handset has a cursor. Bootstrap passes no Date at all, which
   * is exactly why sign-in worked and syncing after it did not.
   *
   * An ISO instant carries its own zone, so this is not the bare-cast rule in
   * different clothes — nothing is being truncated to a day here. */
  const sinceIso = since.toISOString();

  const ids = await customerIdsInScope(principal);
  const idList = ids.length
    ? sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`
    : null;

  const [
    changedCustomers,
    changedProducts,
    newTimeline,
    freshNotifications,
    newTranscripts,
    journeyRows,
    approvalRows,
    planDayRows,
    leaveBalanceRows,
    priceRows,
    schemeChanges,
    documentChanges,
    courseChanges,
    deletionRows,
  ] = await Promise.all([
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
             where c.id in ${idList} and c.updated_at > ${sinceIso}
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
         where p.updated_at > ${sinceIso}
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
             where t.customer_id in ${idList} and t.created_at > ${sinceIso}
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
            sql`${notifications.createdAt} > ${sinceIso}`,
          ),
        )
        .orderBy(sql`${notifications.createdAt} asc`)
        .limit(200),

      /* What the voice note said.
       *
       * This is what lets a handset let go of a recording: the audio is kept
       * until the transcript is confirmed STORED, not merely until the upload
       * succeeded, because it is the only copy of what the customer actually
       * said. Without this channel the confirmation never came and every
       * recording ever made stayed on the phone. */
      db.execute<Record<string, unknown>>(sql`
        select v.voice_note_id as "mediaId", v.transcript, v.id as "visitId"
          from mbos_visits v
         where v.created_by_id = ${principal.user.id}
           and v.voice_note_id is not null
           and v.transcript is not null
           and v.updated_at > ${sinceIso}
         order by v.updated_at asc
         limit 200
      `),

      /* The route, on every pass and not only at sign-in.
       *
       * A plan is made in the office, often for tomorrow and sometimes for
       * this afternoon. Sending it only in the bootstrap meant a salesman had
       * to sign out and back in to see a day somebody had just planned for
       * him — and signing out is the one thing an offline-first app makes
       * expensive, because the outbox goes with the session. */
      db.execute<Record<string, unknown>>(sql`
        select s.id,
               p.plan_date::text as "planDate",
               s.customer_id as "customerId",
               s.sequence as "seq",
               to_char(s.planned_at at time zone ${APP_TIMEZONE}, 'HH24:MI') as "plannedAt",
               (extract(epoch from s.actual_visit_at) * 1000)::double precision as "actualAt",
               s.status,
               s.skip_reason as "skipReason"
          from mbos_journey_stops s
          join mbos_journey_plans p on p.id = s.plan_id
         where p.user_id = ${principal.user.id}
           and p.plan_date >= (now() at time zone ${APP_TIMEZONE})::date
           and (s.updated_at > ${sinceIso} or p.updated_at > ${sinceIso})
         order by p.plan_date asc, s.sequence asc
         limit 500
      `),

      /* The answer to something he asked for.
       *
       * The handset has applied this channel since the day it was written — it
       * moves the expense to Approved, the leave to Rejected, the order to
       * approved — and the server had never sent a single row, so a salesman
       * who asked for anything watched it sit at Pending for ever. There was
       * nothing to send until the Sales Dashboard existed to decide them.
       *
       * Pending rows go too, not only decided ones: the handset minted the id
       * and this is what confirms the office holds it. */
      db.execute<Record<string, unknown>>(sql`
        select ap.id, ap.subject_type as "subjectType", ap.subject_id as "subjectId",
               ap.state::text as state,
               (extract(epoch from ap.decided_at) * 1000)::double precision as "decidedAt",
               ap.decision_note as "decisionNote",
               ap.approved_amount_paise as "approvedAmountPaise",
               d.name as "approverName"
          from mbos_approvals ap
          left join users d on d.id = ap.approver_user_id
         where ap.requested_by_user_id = ${principal.user.id}
           and ap.updated_at > ${sinceIso}
         order by ap.updated_at asc
         limit 500
      `),

      /* The days themselves, and how far each has got in being agreed.
       *
       * A stop only exists once a day is PLANNED, so the stops channel alone
       * cannot show a salesman the days he is being asked about — which, on a
       * month laid out in advance, is nearly all of them. */
      db.execute<Record<string, unknown>>(sql`
        select p.id, p.plan_date::text as "planDate", p.city, p.beat,
               p.day_state::text as "dayState",
               p.refusal_reason as "refusalReason",
               p.counter_city as "counterCity",
               (extract(epoch from p.proposed_at) * 1000)::double precision as "proposedAt",
               m.name as "proposedBy",
               (select count(*)::int from mbos_journey_stops s where s.plan_id = p.id)
                 as "picked"
          from mbos_journey_plans p
          left join users m on m.id = p.proposed_by_id
         where p.user_id = ${principal.user.id}
           and p.plan_date >= (now() at time zone ${APP_TIMEZONE})::date
           and p.updated_at > ${sinceIso}
         order by p.plan_date asc
         limit 200
      `),

      /* What leave he has left.
       *
       * The handset's leave screen builds its list of kinds from these, so
       * with none sent the only thing it could offer was Loss of pay — a
       * salesman with twelve days of casual leave being shown no way to ask
       * for any of it. The balance is a subtraction rather than a stored
       * number, because a stored one is a figure two writers can disagree
       * about. */
      db.execute<Record<string, unknown>>(sql`
        select b.leave_type::text as kind,
               b.entitled_days as entitled,
               b.used_days as used,
               (b.entitled_days - b.used_days) as available
          from mbos_leave_balances b
         where b.user_id = ${principal.user.id}
           and b.year = extract(year from (now() at time zone ${APP_TIMEZONE}))
         order by b.leave_type asc
      `),

      /* What the customer pays.
       *
       * Sent whole on every pass rather than as a delta, because the handset
       * replaces the table wholesale — a rate that was withdrawn has to
       * disappear, and a row that no longer exists has no `updated_at` to say
       * so. It is a few hundred rows of three columns; a delta would save
       * nothing worth the way it fails. */
      priceListRows(),

      schemeRows(sinceIso),

      /* The library and the training, narrowed exactly as the bootstrap
       * narrows them — same functions, so a document a salesman could not see
       * at sign-in cannot arrive an hour later through the delta. */
      visibleDocuments(principal.role, ids, sinceIso),
      coursesFor(principal.user.id, sinceIso),

      deletionsSince(principal.user.id, sinceIso),
    ]);

  return {
    cursor: nextCursor,
    customers: changedCustomers as unknown[],
    products: changedProducts as unknown[],
    timeline: newTimeline as unknown[],
    config: await mbosConfigPayload(),
    notifications: freshNotifications as unknown[],
    transcripts: newTranscripts as unknown[],
    journeyStops: journeyRows as unknown[],
    approvals: approvalRows as unknown[],
    planDays: planDayRows as unknown[],
    leaveBalances: leaveBalanceRows as unknown[],
    priceList: priceRows as unknown[],
    schemes: schemeChanges as unknown[],
    documents: documentChanges as unknown[],
    courses: courseChanges as unknown[],
    deletions: deletionRows,
  };
}
