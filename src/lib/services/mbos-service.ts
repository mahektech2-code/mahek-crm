import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  customers,
  mbosAttendanceDays,
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
import { policyForDate, resolveSubject } from "./expense-policy-service";
import { describeRule } from "../expense-rule-forms";
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
 * One active handset per person — by default, and now only by default.
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
 *
 * `mbos.devices.onePerPerson` can suspend the rule for a business that needs
 * to — see the note at the check itself. The rule that a handset belongs to
 * ONE employee is not part of that and cannot be switched off.
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

  // The device id is unique across the table, so a handset somebody else is
  // ACTIVELY on is not this person's to sign in on. A RELEASED row is a
  // different fact: `releaseDevice` (Sales Dashboard → Handsets) exists
  // precisely so the physical phone can be handed to somebody else. Refusing
  // here regardless of `active` used to make that impossible — releasing the
  // old employee's row never actually freed the handset for a new one,
  // because this check never looked at `active` at all. The row for the new
  // employee is written by the ordinary `onConflictDoUpdate` below, which
  // already reassigns `userId` on a released row; this is the only change
  // needed to let it be reached.
  //
  // The message stays generic on purpose: whose account this handset is tied
  // to, and which screen releases it, are an admin's business rather than
  // the person holding the phone's — this is the one login refusal that is
  // never that person's own account or credential being wrong.
  if (existingForDevice && existingForDevice.active && existingForDevice.userId !== userId) {
    return {
      ok: false,
      error: "This handset can't be used to sign in right now. Contact your admin.",
    };
  }

  const otherActive = await db
    .select({ id: mbosDevices.id, deviceId: mbosDevices.deviceId })
    .from(mbosDevices)
    .where(and(eq(mbosDevices.userId, userId), eq(mbosDevices.active, true)));

  /*
   * ONE HANDSET PER PERSON IS A SETTING, NOT A CONSTANT.
   *
   * It is on by default and should usually stay on — the reasoning above is
   * still the reasoning. But it is a rule about how a business chooses to run
   * its field team rather than a fact about the data, and it was the one thing
   * in this file a manager could not change: a salesman whose phone broke on a
   * Tuesday had no way back in short of somebody with database access, because
   * the screen the refusal names does not exist yet. A rule with no way to
   * suspend it and no way to satisfy it is a rule people work around by
   * sharing a login, which is worse than the thing it was protecting against.
   *
   * Turning it off never lets somebody take over a handset registered to
   * ANOTHER employee — that check is above this one and is not configurable,
   * because it is about whose phone it is rather than how many they may hold.
   */
  const onePerPerson = (await getConfig())["mbos.devices.onePerPerson"];

  const conflicting = otherActive.filter((d) => d.deviceId !== deviceId);
  if (onePerPerson && conflicting.length && !existingForDevice) {
    return {
      ok: false,
      error:
        "You are already signed in on another handset. One device per person — ask an admin to release the old one, or have them allow more than one handset in the Sales Dashboard settings.",
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

  /*
   * `mine` explicitly: A HANDSET IS ONE PERSON WALKING ONE BEAT.
   *
   * The narrowing preference is a cookie and a handset has no cookie jar, so
   * this argument is the whole of the answer rather than a default somebody
   * can move. It used to say `team` on the reasoning that a manager on the
   * field app should see their team — and for a manager that was arguable,
   * but `scopeForUser` does not honour the preference for an ADMIN at all:
   * that branch returns `all` before the narrowing is read. So the one admin
   * holding `field` was handed the entire company — 5,915 customers — onto a
   * phone, where the customer list rendered every one of them and stopped
   * responding.
   *
   * Scope is the right place to fix that rather than the screen, because
   * every MBOS screen is personal in the same way: my day, my visits, my
   * customers, my performance, my pay. There is no screen on this app that a
   * team-wide answer makes better, and a field handset is the one client
   * where the cost of a wide answer is paid in battery, bandwidth and a book
   * nobody can scroll.
   *
   * Still the ONE `scopeForUser` — an argument to it, not a second reading of
   * what "mine" means. `accounts` is unaffected: that branch answers `all`
   * before any preference is read, and no accounts user holds `field`.
   */
  const ctx = await scopeForUser(user, "mine");
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


/* ------------------------------------------------- the expense policy, sent */

/**
 * The policy this person is under, as the rules his own copy of the engine
 * will read, plus the same rules in English for the screen that shows them.
 *
 * Sent NARROWED to his grade and to nothing else — a policy carries every
 * grade's hotel ceiling and putting all of them on a handset is putting
 * somebody else's allowance on a device in a market. The narrowing keeps the
 * qualifier on each rule, because the engine still matches on it and a rule
 * stripped of its qualifier would apply to a city class it was never meant for.
 */
async function expensePolicyFor(userId: string, onDate: string) {
  const [policy, subject] = await Promise.all([
    policyForDate(onDate),
    resolveSubject(userId, null),
  ]);
  if (!policy) return null;

  const mine = policy.rules.filter(
    (r) => r.grade === null || r.grade === subject.grade,
  );

  return {
    policyId: policy.id,
    versionNo: policy.versionNo,
    effectiveFrom: policy.effectiveFrom,
    effectiveTo: policy.effectiveTo,
    grade: subject.grade,
    cityClass: subject.cityClass,
    rules: mine as unknown[],
    sentences: mine.map((r) => describeRule(r)),
  };
}

/** Every mode a leg may name. Read, never a literal on the handset. */
async function travelModeRows() {
  return db.execute<{
    key: string;
    label: string;
    sortOrder: number;
    reimbursementKind: string;
    requiresOdometer: boolean;
    requiresTicket: boolean;
  }>(sql`
    select key, label, sort_order as "sortOrder",
           reimbursement_kind as "reimbursementKind",
           requires_odometer as "requiresOdometer",
           requires_ticket as "requiresTicket"
      from mbos_travel_modes
     where active
     order by sort_order asc
  `);
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
  /**
   * TODAY'S ATTENDANCE, so a fresh install is not blind about a day it already
   * has. The one piece of OWNED data this payload carries, and it is here
   * because the handset cannot ask the question any other way — see
   * `restoreAttendance` on the other side for why it may only ever fill a gap.
   */
  attendanceToday: unknown | null;
  /** This year's and last's. See `holidaysFor` for why only `universal` ones bind. */
  holidays: unknown[];
  documents: unknown[];
  courses: unknown[];
  notifications: unknown[];
  /**
   * The months he is being measured on, from the cache.
   *
   * On the delta channel this is gated on `computed_at`, which is right there
   * and wrong here — a fresh install has no cursor, so the delta sends nothing
   * and a handset signed in on a new phone would show an empty Performance
   * screen until the nightly rebuild happened to run. Bootstrap asks for it
   * unconditionally.
   */
  performance: unknown[];
  /** This month's and last's. See `salaryFor` — read-only, nothing here writes it. */
  salary: unknown[];
  /**
   * The travel modes a leg may name, and how each is reimbursed.
   *
   * A list, never a constant in the app: requirement 3 says an admin adds one
   * without a developer, and a mode typed into a picker is the same mistake as
   * a product list typed into a screen.
   */
  travelModes: unknown[];
  /**
   * The expense policy in force, resolved for THIS person, as rules the
   * handset's own copy of the engine reads.
   *
   * **Replaced wholesale, like the price list, and for the same reason.** A
   * withdrawn rule has to disappear; a per-row upsert leaves a rate nobody
   * pays any more sitting on the phone, and the salesman is told a number the
   * office will not honour.
   *
   * Only the rules that apply to him are sent. The whole table would be every
   * grade's hotel ceiling on every handset, which is somebody else's salary
   * band on a device in a market.
   */
  expensePolicy: {
    policyId: string;
    versionNo: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    grade: string | null;
    cityClass: string | null;
    rules: unknown[];
    /** In English, for the "what am I allowed" screen. */
    sentences: string[];
  } | null;
  config: Record<string, unknown>;
};

/** How many timeline events per customer the snapshot carries. */
const TIMELINE_PER_CUSTOMER = 50;

/**
 * How far back the journey channels reach.
 *
 * Both the stops and the days themselves used to filter `plan_date >= today`,
 * on both bootstrap and every delta pass since — deliberately, but it left
 * the handset with no way to show a salesman his own recent history: what
 * was planned for last Tuesday, and what he actually did with it, was gone
 * the moment the day ended. Fifteen days back is a fortnight either side of
 * today, matching the fifteen-to-twenty-day forward window a manager plans
 * in one sitting.
 *
 * Every use of this constant in a query needs `::int` on it explicitly. Bound
 * as a bare parameter next to `(now() at time zone $tz)::date - $this`,
 * Postgres cannot resolve which of `date - integer` and `date - date` the
 * subtraction is before it knows this parameter's type, defaults it to `date`
 * under the datetime category's own preference rule, and the subtraction
 * comes back `integer` — so the surrounding `plan_date >= …` then fails with
 * `operator does not exist: date >= integer`. The cast pins the type before
 * Postgres has to guess. Confirmed by reproducing the exact failure with a
 * plain `PREPARE` carrying no parameter types, and confirming the cast alone
 * fixes it; a literal `15` typed into the query text never hits this, because
 * a literal is not an unresolved parameter.
 */
const PLAN_HISTORY_DAYS = 15;

export async function buildBootstrap(
  principal: MbosPrincipal,
): Promise<BootstrapPayload> {
  const now = new Date();
  const ids = await customerIdsInScope(principal);
  const day = await today();
  /* A fortnight either side of today, matching `PLAN_HISTORY_DAYS` and the
     manager's own MAX_PLAN_DAYS (31) forward cap — so a fresh sign-in shows
     the whole relevant window immediately rather than waiting for it to
     trickle in through the delta over the following days. */
  const planFrom = addDays(day, -PLAN_HISTORY_DAYS);
  const planTo = addDays(day, 31);

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
    attendanceRow,
    holidayRows,
    documentRows,
    courseRows,
    notificationRows,
    performanceRows,
    salaryRows,
    config,
  ] = await Promise.all([
    customersForDevice(ids),
    activeCatalogue(),
    journeyStops(principal.user.id, planFrom, planTo),
    priceListRows(),
    schemeRows(null),
    openTasks(principal.user.id),
    openSamples(principal.user.id, ids),
    openLeads(principal.user.id),
    recentTimeline(ids, TIMELINE_PER_CUSTOMER),
    leaveBalances(principal.user.id, Number(day.slice(0, 4))),
    attendanceToday(principal.user.id, day),
    holidaysFor(),
    visibleDocuments(principal.role, ids),
    coursesFor(principal.user.id),
    unreadNotifications(principal.user.id),
    // The epoch, so the cache's own `computed_at` gate lets everything through.
    performanceFor(principal.user.id, new Date(0).toISOString()),
    salaryFor(principal.user.id),
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
    attendanceToday: attendanceRow,
    holidays: holidayRows,
    documents: documentRows,
    courses: courseRows,
    notifications: notificationRows,
    performance: performanceRows,
    salary: salaryRows,
    travelModes: await travelModeRows(),
    expensePolicy: await expensePolicyFor(principal.user.id, await today()),
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
/**
 * The book, and — new — who we BILL for each account in it.
 *
 * `thirdParty` says the goods go to this shop and the invoice does not.
 * `distributors` says where the invoice goes instead. A LIST, because a shop
 * on a territory boundary is served by two and storing one of them makes the
 * other unrecordable; `isPrimary` is who serves it usually.
 *
 * Sent so the handset can default the billing party the moment a salesman
 * picks a shop, offline, with no round trip. It is REFERENCE data about the
 * arrangement and not permission to bill: the billing party still has to be a
 * customer in this salesman's own book, because that is the account whose
 * credit limit, term and outstanding decide whether the order can be taken at
 * all. A shop whose distributor belongs to somebody else is one this salesman
 * cannot write an order for — and with this list the handset can say so while
 * he is standing in the shop, rather than the order being refused at sync
 * hours later with nothing on the screen explaining why.
 *
 * The comment above is out here rather than inside the query because the SQL
 * is a template literal, and a backtick in a comment inside one ends the
 * string.
 */
async function customersForDevice(ids: string[]) {
  if (!ids.length) return [];
  return db.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.contact_person as "contactPerson", c.phone,
           c.city, c.area, c.beat,
           c.territory_region as "territoryRegion", c.dealer_code as "dealerCode",
           -- what mbos_price_list is keyed on for this account
           c.price_tag as "priceTag",
           c.status, c.gstin,
           c.gps_lat as "gpsLat", c.gps_lng as "gpsLng",
           c.gps_accuracy_m as "gpsAccuracyM",
           c.customer_type as "customerType", c.potential,
           -- The standing term, falling back the way every other screen falls
           -- back. The handset prints this as "N days" on the shop card and
           -- has no second field to put a term in.
           coalesce(c.credit_days, c.credit_term_days) as "creditDays",
           c.credit_limit_paise as "creditLimitPaise",
           c.credit_blocked as "creditBlocked",
           c.credit_block_reason as "creditBlockReason",
           c.outstanding as "outstandingPaise",
           c.health_score as "healthScore",
           c.health_components as "healthComponents",
           c.last_order_date as "lastOrderDate",
           c.last_visit_date as "lastVisitDate",
           c.visit_frequency_days as "visitFrequencyDays",
           c.cycle_days as "cycleDays",
           -- who we bill for this one; see the note above the function
           c.third_party as "thirdParty",
           coalesce((
             select json_agg(json_build_object(
                      'id', d.distributor_customer_id,
                      'name', dc.name,
                      'isPrimary', d.is_primary
                    ) order by d.is_primary desc, dc.name asc)
               from customer_distributors d
               join customers dc on dc.id = d.distributor_customer_id
              where d.customer_id = c.id
           ), '[]'::json) as "distributors"
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
           p.cans_per_box as "cansPerBox", p.active,
           -- brand and formulation are what the catalogue and the order
           -- form read for the subtitle under a SKU -- one liquid sells as
           -- Nano, Astar Nano and M5x4 Thinner, and that line is what tells
           -- them apart mid-call.
           b.name as brand, f.name as formulation
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
async function journeyStops(userId: string, fromDate: string, toDate: string) {
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
       and p.plan_date >= ${fromDate}::date
       and p.plan_date <= ${toDate}::date
     order by p.plan_date asc, s.sequence asc
  `);
  return rows;
}

async function openTasks(userId: string) {
  return db.execute<Record<string, unknown>>(sql`
    select t.id, t.title, t.description,
           t.assigned_to_user_id as "assignedToUserId",
           t.assigned_by_user_id as "assignedByUserId",
           t.priority, t.due_date::text as "dueDate",
           t.customer_id as "customerId", t.status,
           t.snoozed_to::text as "snoozedTo", t.snooze_reason as "snoozeReason",
           t.source_type as "sourceType", t.source_id as "sourceId",
           -- Read by upsertTasks and never sent, so every pull wrote them
           -- back as NULL: a task the salesman completed lost its note and its
           -- photograph the moment the office next mentioned the task at all.
           t.completion_note as "completionNote",
           t.completion_photo_id as "completionPhotoId",
           t.escalated_at as "escalatedAt",
           t.updated_at as "updatedAt"
      from mbos_tasks t
     where t.assigned_to_user_id = ${userId}
       and t.status in ('open', 'in_progress')
     order by t.due_date asc nulls last
  `);
}

/**
 * A task assigned or changed since the last pull.
 *
 * Every status, not only open ones — a task the office just cancelled, or
 * marked done on somebody's behalf, has to reach the handset the same way a
 * newly-assigned one does. Sent only on a real cursor: the empty-since branch
 * of `buildPull` answers nothing for every channel, tasks included, because
 * the FIRST pull is bootstrap's job.
 */
async function tasksSince(userId: string, sinceIso: string) {
  return db.execute<Record<string, unknown>>(sql`
    select t.id, t.title, t.description,
           t.assigned_to_user_id as "assignedToUserId",
           t.assigned_by_user_id as "assignedByUserId",
           t.priority, t.due_date::text as "dueDate",
           t.customer_id as "customerId", t.status,
           t.snoozed_to::text as "snoozedTo", t.snooze_reason as "snoozeReason",
           t.source_type as "sourceType", t.source_id as "sourceId",
           -- Read by upsertTasks and never sent, so every pull wrote them
           -- back as NULL: a task the salesman completed lost its note and its
           -- photograph the moment the office next mentioned the task at all.
           t.completion_note as "completionNote",
           t.completion_photo_id as "completionPhotoId",
           t.escalated_at as "escalatedAt",
           t.updated_at as "updatedAt"
      from mbos_tasks t
     where t.assigned_to_user_id = ${userId}
       and t.updated_at > ${sinceIso}
     order by t.updated_at asc
     limit 500
  `);
}

/**
 * Samples out on trial.
 *
 * `productName` is joined rather than left to the handset to look up: a sample
 * can name a SKU that is no longer active, and the catalogue the handset holds
 * carries only what can currently be ordered — so the one screen that lists
 * these would have printed a row with no product on it. The name is what the
 * salesman asks the shop about; the id is what an order would be raised from.
 *
 * `since` makes it a delta as well as a bootstrap. Without it, a sample the
 * office marked delivered this morning reached the phone only on a fresh
 * sign-in.
 */
async function openSamples(userId: string, customerIds: string[], since?: string | null) {
  if (!customerIds.length) return [];
  return db.execute<Record<string, unknown>>(sql`
    select s.id, s.customer_id as "customerId", s.product_id as "productId",
           pr.name as "productName",
           s.quantity_cans as "quantityCans",
           s.requested_date::text as "requestedDate",
           -- Three assertions by three parties, and never collapsed: we sent
           -- it, the carrier says it arrived, the shop says it has it. Only
           -- the third starts the review clock.
           s.dispatched_at as "dispatchedAt",
           s.courier_name as "courierName",
           s.tracking_number as "trackingNumber",
           s.delivered_at as "deliveredAt",
           s.delivery_photo_id as "deliveryPhotoId",
           s.received_at as "receivedAt",
           s.trial_started_at as "trialStartedAt",
           s.trial_completed_at as "trialCompletedAt",
           s.satisfaction,
           s.additional_requirement as "additionalRequirement",
           s.rejection_reason as "rejectionReason",
           s.trial_outcome as "trialOutcome",
           s.follow_up_date::text as "followUpDate",
           s.feedback_notes as "feedbackNotes",
           s.converted_order_id as "convertedOrderId",
           s.updated_at as "updatedAt"
      from mbos_samples s
      left join products pr on pr.id = s.product_id
     where s.salesman_id = ${userId}
       and s.trial_outcome = 'pending'
       ${since ? sql`and s.updated_at > ${since}` : sql``}
     order by s.follow_up_date asc nulls last
  `);
}

/**
 * The salesman's open leads.
 *
 * ONE LEAD, so this reads `customers` — but the WIRE SHAPE is unchanged, field
 * for field, because a handset in somebody's pocket was built against it and
 * an APK cannot be recalled. `mobile` is `customers.phone`, `id` is the
 * customer's own id, and `convertedCustomerId` is that same id once it has
 * been won rather than a pointer to a second row that no longer exists.
 */
async function openLeads(userId: string, since?: string | null) {
  return db.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.company_name as "companyName", c.phone as mobile,
           c.city, c.area,
           coalesce(c.lead_source, 'manual') as source, c.lead_stage as stage,
           c.lead_estimated_potential_paise as "estimatedPotentialPaise",
           c.lead_next_follow_up_date::text as "nextFollowUpDate",
           c.lead_notes as notes,
           c.gps_lat as "gpsLat", c.gps_lng as "gpsLng",
           -- The coordinating seat, and the NAME beside it: a salesman with a
           -- commercial question needs somebody to ring, and an id is not a
           -- person. Resolved here rather than on the handset because the
           -- handset holds no user table.
           c.lead_manager_id as "leadManagerId",
           lm.name as "leadManagerName",
           c.lead_hold_reason as "holdReason",
           -- How many times anybody has stood in this shop.
           --
           -- Counted rather than cached: a cached count needs a recompute
           -- path, an invalidation on every visit write, and a way to be
           -- wrong. This is count(*) on mbos_visits_customer_idx for the
           -- handful of open leads one salesman owns.
           (select count(*)::int from mbos_visits v
             where v.customer_id = c.id) as "visitCount",
           case when c.lead_converted_at is not null then c.id end as "convertedCustomerId",
           c.lead_last_activity_date::text as "lastActivityDate",
           c.updated_at as "updatedAt"
      from customers c
      left join users lm on lm.id = c.lead_manager_id
     where (c.owner_id = ${userId} or c.lead_manager_id = ${userId})
       and c.lead_stage is not null
       and c.lead_archived = false
       -- on_hold is deliberately NOT excluded. A held lead is a live
       -- prospect with a reason it is not moving, and taking it off the
       -- handset would make "on hold" mean "gone" — which is exactly the
       -- conflation the status exists to end.
       and c.lead_stage not in ('won', 'lost')
       ${since ? sql`and c.updated_at > ${since}` : sql``}
     order by c.lead_next_follow_up_date asc nulls last
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
           "occurredAt", actor, summary
      from (
        select t.id, t.customer_id as "customerId", t.event_type as "eventType",
               t.source_app as "sourceApp", t.source_record_id as "sourceRecordId",
               t.occurred_at as "occurredAt", t.actor_user_id as actor,
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

/**
 * Today's attendance row, or null.
 *
 * The ONLY owned record this payload carries, and it earns the exception by
 * being the one thing a handset cannot work out for itself. `checkIn()` asks
 * `todayRow()`, which is purely local, so a phone that has just been installed
 * finds nothing and concludes the day has not started — then creates a second
 * check-in for a day the server already holds. Until this existed there was no
 * channel that could have told it otherwise: attendance is pushed and never
 * pulled, by the rule that a sync must not overwrite what somebody authored
 * offline.
 *
 * That rule is kept intact on the other side rather than bent here: the
 * handset FILLS A GAP with this and never overwrites a row it already has, so
 * a check-in saved four minutes ago in a market with no signal still wins.
 */
async function attendanceToday(userId: string, day: string) {
  const [row] = await db
    .select({
      id: mbosAttendanceDays.id,
      userId: mbosAttendanceDays.userId,
      day: mbosAttendanceDays.day,
      checkInAt: mbosAttendanceDays.checkInAt,
      checkInLat: mbosAttendanceDays.checkInLat,
      checkInLng: mbosAttendanceDays.checkInLng,
      checkInAccuracyM: mbosAttendanceDays.checkInAccuracyM,
      checkOutAt: mbosAttendanceDays.checkOutAt,
      status: mbosAttendanceDays.status,
    })
    .from(mbosAttendanceDays)
    .where(and(eq(mbosAttendanceDays.userId, userId), eq(mbosAttendanceDays.day, day)))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    checkInAt: row.checkInAt ? row.checkInAt.getTime() : null,
    checkOutAt: row.checkOutAt ? row.checkOutAt.getTime() : null,
  };
}

async function leaveBalances(userId: string, year: number) {
  return db.execute<Record<string, unknown>>(sql`
    select b.leave_type as kind, b.year::text as period,
           b.entitled_days as entitled, b.used_days as used,
           -- Derived here because the handset has a column for it and no
           -- arithmetic to fill it with; the row is upserted verbatim.
           (b.entitled_days - b.used_days) as available
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
    select d.id, d.title, d.category,
           -- What the handset fetches the bytes by, and the column it keeps
           -- them under once it has.
           d.attachment_id as "remoteRef"
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
    select c.id, c.title, c.category, c.duration_minutes as minutes,
           c.mandatory, c.due_date::text as deadline,
           -- Epoch milliseconds: the column on the handset is an INTEGER and
           -- every other instant in that store is counted the same way. See
           -- actualAt in journeyStops, which does this for the same reason.
           (extract(epoch from p.completed_at) * 1000)::double precision as "completedAt",
           p.quiz_score_percent as "quizScore"
      from mbos_courses c
      left join mbos_course_progress p
             on p.course_id = c.id and p.user_id = ${userId}
     where c.active = true
       ${since ? sql`and (c.updated_at > ${since} or p.updated_at > ${since})` : sql``}
     order by c.mandatory desc, c.due_date asc nulls last, c.title asc
  `);
}

/**
 * The calendar, so attendance can tell a real day off from a missed check-in.
 *
 * The whole year rather than a window: a holiday calendar is a few dozen rows
 * and there is no cheap way to bound "which ones matter" without a client
 * telling us its own working-day horizon, which is exactly the kind of
 * two-projections-that-disagree this codebase keeps getting bitten by.
 *
 * `scope` is free text on the server (see the schema comment) and the handset
 * has no reliable way to match it against a salesman's own territory, so only
 * a NULL-scope (everywhere) row is sent as `universal: true` — the one signal
 * the attendance engine may act on automatically. A regionally-scoped holiday
 * still goes down, `universal: false`, so it can be shown in a list, but
 * nothing here pretends to know it applies to any one salesman.
 */
async function holidaysFor(since?: string | null) {
  return db.execute<Record<string, unknown>>(sql`
    select h.id, h.on_date::text as "onDate", h.name, h.scope,
           (h.scope is null) as "universal"
      from mbos_holidays h
     where extract(year from h.on_date) >= extract(year from (now() at time zone ${APP_TIMEZONE})) - 1
       ${since ? sql`and h.updated_at > ${since}` : sql``}
     order by h.on_date asc
     limit 500
  `);
}

/**
 * His own pay, this month and last — the channel `app/salary.tsx` on the
 * handset was built to read and never had.
 *
 * A per-user narrowing of `payForPeriod` (the web Sales Dashboard's team-wide
 * version), not a second implementation of it — same columns, same
 * employee-record join by email-then-mobile, same "no incentive column"
 * shape AGENTS.md already settled: MahekOne sets no monthly target for a
 * field salesman, so a number computed from one would be an invention on the
 * one screen where a wrong figure is least forgivable.
 *
 * Two periods, current and previous, for the same reason `performanceFor`
 * sends two: on the 2nd of a month the one somebody actually cares about is
 * still last month's, and a handset showing one two-day-old empty month
 * reads as a broken screen rather than an early one.
 */
async function salaryFor(userId: string): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(sql`
    with periods as (
      select date_trunc('month', (now() at time zone ${APP_TIMEZONE}))::date as "from",
             (date_trunc('month', (now() at time zone ${APP_TIMEZONE})) + interval '1 month')::date as "to"
      union all
      select date_trunc('month', (now() at time zone ${APP_TIMEZONE}) - interval '1 month')::date,
             date_trunc('month', (now() at time zone ${APP_TIMEZONE}))::date
    )
    select p."from"::text as period,
           e.employee_code as "employeeCode",
           e.status_raw as "employeeStatus",
           e.net_salary_paise as "netSalaryPaise",
           e.conveyance_paise as "conveyancePaise",
           e.other_salary_paise as "otherSalaryPaise",
           e.pf_esic_applicable as "pfEsicApplicable",
           e.date_of_joining::text as "dateOfJoining",

           (select count(*)::int from mbos_attendance_days d
             where d.user_id = ${userId} and d.check_in_at is not null
               and d.day >= p."from" and d.day < p."to") as "daysWorked",
           (select count(*)::int from mbos_attendance_days d
             where d.user_id = ${userId} and d.status = 'on_leave'
               and d.day >= p."from" and d.day < p."to") as "daysOnLeave",

           coalesce((select sum(coalesce(ap.approved_amount_paise, ex.amount_paise))
                       from mbos_expenses ex
                       join mbos_approvals ap
                         on ap.subject_id = ex.id and ap.type = 'expense_claim'
                      where ex.user_id = ${userId}
                        and ap.state in ('approved', 'partially_approved')
                        and ex.expense_date >= p."from" and ex.expense_date < p."to"), 0)
             as "reimbursedPaise"

      from periods p
      left join users u on u.id = ${userId}
      left join employees e
             on lower(e.email) = lower(u.email)
             or (e.company_mobile is not null and e.company_mobile = u.phone)
     order by p."from" desc
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
/**
 * His own score, from the cache.
 *
 * Two periods rather than one: on the 2nd of a month the month he is actually
 * being judged on is still the previous one, and a handset showing a two-day-
 * old month with nothing in it reads as a broken screen. The categories ride
 * along as JSON on the row, because a handset that has one of the two halves
 * can render neither.
 */
async function performanceFor(
  userId: string,
  sinceIso: string,
): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(sql`
    select p.period,
           p.revenue_target_paise as "revenueTargetPaise",
           p.revenue_actual_paise as "revenueActualPaise",
           p.revenue_achievement_bp as "revenueAchievementBp",
           p.volume_target_ml as "volumeTargetMl",
           p.volume_actual_ml as "volumeActualMl",
           p.volume_achievement_bp as "volumeAchievementBp",
           p.mix_achievement_bp as "mixAchievementBp",
           p.new_customer_target as "newCustomerTarget",
           p.new_customer_actual as "newCustomerActual",
           p.collection_target_paise as "collectionTargetPaise",
           p.collection_actual_paise as "collectionActualPaise",
           p.activity_target as "activityTarget",
           p.activity_actual as "activityActual",
           p.total_score_bp as "totalScoreBp",
           p.rating,
           p.untargeted,
           p.unmatched_revenue_paise as "unmatchedRevenuePaise",
           p.computed_at as "computedAt",
           coalesce(
             (select json_agg(json_build_object(
                        'name', pc.name,
                        'targetBp', c.target_bp,
                        'minimumBp', c.minimum_bp,
                        'actualBp', c.actual_bp,
                        'actualMl', c.actual_ml,
                        'status', c.status)
                      order by pc.display_order)
                from sales_performance_categories c
                join product_categories pc on pc.id = c.category_id
               where c.performance_id = p.id),
             '[]'::json
           ) as categories
      from sales_performance p
     where p.user_id = ${userId}
       and p.computed_at > ${sinceIso}
     order by p.period desc
     limit 2
  `);
}

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
      performance: [],
      tasks: [],
      planDays: [],
      leaveBalances: [],
      holidays: [],
      priceList: [],
      schemes: [],
      documents: [],
      courses: [],
      salary: [],
      travelModes: [],
      expensePolicy: null,
      leads: [],
      samples: [],
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
    holidayRows,
    priceRows,
    schemeChanges,
    documentChanges,
    courseChanges,
    salaryRows,
    deletionRows,
    taskChanges,
    leadChanges,
    sampleChanges,
  ] = await Promise.all([
      idList
        ? db.execute<Record<string, unknown>>(sql`
            select c.id, c.name, c.contact_person as "contactPerson", c.phone,
                   c.city, c.area, c.beat, c.status,
                   c.price_tag as "priceTag",
                   c.gps_lat as "gpsLat", c.gps_lng as "gpsLng",
                   c.credit_limit_paise as "creditLimitPaise",
                   c.credit_blocked as "creditBlocked",
                   c.credit_block_reason as "creditBlockReason",
                   c.outstanding as "outstandingPaise",
                   c.health_score as "healthScore",
                   c.health_components as "healthComponents",
                   c.last_order_date as "lastOrderDate",
                   c.last_visit_date as "lastVisitDate"
              from customers c
             where c.id in ${idList} and c.updated_at > ${sinceIso}
             order by c.updated_at asc
             limit 2000
          `)
        : Promise.resolve([]),
      db.execute<Record<string, unknown>>(sql`
        select p.id, p.name, p.pack_size as "packSize", p.packing,
               p.millilitres_per_can as "millilitresPerCan",
               p.cans_per_box as "cansPerBox", p.active
          from products p
         where p.updated_at > ${sinceIso}
         order by p.updated_at asc
         limit 2000
      `),
      idList
        ? db.execute<Record<string, unknown>>(sql`
            select t.id, t.customer_id as "customerId", t.event_type as "eventType",
                   t.source_app as "sourceApp", t.source_record_id as "sourceRecordId",
                   t.occurred_at as "occurredAt", t.actor_user_id as actor,
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
           and p.plan_date >= (now() at time zone ${APP_TIMEZONE})::date - ${PLAN_HISTORY_DAYS}::int
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
           and p.plan_date >= (now() at time zone ${APP_TIMEZONE})::date - ${PLAN_HISTORY_DAYS}::int
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

      holidaysFor(sinceIso),

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

      /* Not `since`-gated — see `salaryFor`. Two small rows, one join each,
         cheap enough to send on every pass rather than track a change time
         nothing here otherwise needs. */
      salaryFor(principal.user.id),

      deletionsSince(principal.user.id, sinceIso),

      tasksSince(principal.user.id, sinceIso),

      /* A lead raised at a desk and a sample the office has moved on — both
       * were sent at sign-in and nowhere else, and applied nowhere at all.
       * Narrowed by the same functions the bootstrap uses, so nothing can
       * reach a handset through the delta that sign-in would have withheld. */
      openLeads(principal.user.id, sinceIso),
      openSamples(principal.user.id, ids, sinceIso),
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
    holidays: holidayRows as unknown[],
    priceList: priceRows as unknown[],
    schemes: schemeChanges as unknown[],
    documents: documentChanges as unknown[],
    courses: courseChanges as unknown[],
    deletions: deletionRows,
    performance: await performanceFor(principal.user.id, sinceIso),
    tasks: taskChanges as unknown[],
    salary: salaryRows as unknown[],
    travelModes: await travelModeRows(),
    /* Sent on EVERY delta rather than gated on the cursor, and deliberately.
       It is a handful of rows, and the failure it prevents is the expensive
       one: a phone quietly holding a superseded rate and telling a salesman a
       number the office will not pay. */
    expensePolicy: await expensePolicyFor(principal.user.id, await today()),
    leads: leadChanges as unknown[],
    samples: sampleChanges as unknown[],
  };
}
