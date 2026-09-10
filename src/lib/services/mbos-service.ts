import "server-only";
import { and, eq, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
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
import { readSecret } from "../secrets";
import { dictationAvailability } from "../dictation-requests";
import {
  territoriesFor,
  territoryClause,
  type Territory,
} from "./territory-service";
import { policyForDate, resolveSubject } from "./expense-policy-service";
import { describeRule } from "../expense-rule-forms";
import { verifyPassword } from "../password";
import { bearerFrom, verifyToken, signingKeyPresent } from "../mbos/token";
import { today } from "../recompute";
import { addDays, asDate, APP_TIMEZONE, type BusinessDate } from "../business-date";
import { bandFor } from "../engines/inactivity";
import {
  leaveBalances as computeLeaveBalances,
  leaveDebitDays,
} from "../engines/leave";
import {
  LEAVE_LABELS,
  type LeaveType,
  type PullDelta,
  type TerritoryState,
} from "../mbos/types";
import { employeeJoinOn } from "../employee-link";
/* The Accounts ledger's own read. See `customerBills` — the handset must not
   have a second opinion about what a shop owes. */
import { listBills } from "./payment-service";

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
  role: "associate" | "manager" | "admin";
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
    /*
     * `leads.` as well as `mbos.`, and the prefix test is why it had to be
     * said out loud.
     *
     * The funnel's settings were named for the FEATURE rather than for the app
     * — `leads.suspectMaxVisits`, `leads.prospectReasons`, `leads.lostReasons`
     * — because the console reads them too. This loop sent only `mbos.*`, so
     * none of them reached a handset: the phone fell back to the defaults
     * compiled into it, and a manager who changed the suspect window on the
     * Settings screen changed it in the office and nowhere else. Silent in both
     * directions, since a defaulted value is a plausible value.
     *
     * The salesman is the person those settings are actually about, so they go
     * where he is.
     */
    if (key.startsWith("mbos.") || key.startsWith("leads.")) out[key] = value;
  }
  out["products.priceSource"] = config["products.priceSource"];

  /*
   * THE MAP KEY, and it is the one credential that goes down this wire.
   *
   * The handset draws the same maps the console does and must ask Ola for the
   * same tiles — a key that never left the server could not load a single
   * street. It is the exception `lib/secrets.ts` already names for the browser,
   * one client further out, and the caveat is written there: a browser key is
   * restricted to a domain and a phone has none, so a separate revocable key
   * with a spend cap is the honest mitigation.
   *
   * It goes only to a device that has already authenticated as a bound handset
   * — this payload is behind the MBOS bearer token — which is the most this
   * side can do about it.
   *
   * Absent where no key is set, and the map screens draw nothing rather than a
   * grey rectangle: a map that fails when opened is worse than one never
   * offered, which is the same rule the microphone follows.
   */
  const mapKey = await readSecret("olamaps.apiKey").catch(() => null);
  if (mapKey) out["maps.olaKey"] = mapKey;

  /*
   * WHETHER A MICROPHONE MAY BE DRAWN, and how long it may listen for.
   *
   * The CRM asks `/api/dictate` at the moment it draws one, which is right for
   * a browser and useless here: a salesman opens the expenses form in a godown
   * with no bars, and a screen that had to ask a server whether it may offer a
   * button would offer none exactly where speaking beats typing most. So the
   * answer rides down on the pull like every other threshold and is read from
   * the local cache.
   *
   * What crosses is the ANSWER, never the question. None of the `voice.*`
   * settings go down this wire and neither do the keys behind them — unlike
   * the map key above, which the handset must spend itself, nothing on a phone
   * calls a transcription provider directly. A handset has no use for a model
   * name and no business holding one; what it needs is whether to draw the
   * mic, when to stop recording, and whether Tighten and Rewrite are worth
   * showing.
   *
   * CAUGHT, like the map key above, and for a reason worth stating: this is a
   * settings read and a secrets read, and it sits inside the payload that
   * bootstraps a handset. A throw here would not disable dictation, it would
   * fail the bootstrap — and a failed bootstrap is a salesman signed in
   * against an empty database with a full day in front of him. The worst this
   * may cost is a microphone that is not drawn.
   */
  const dictation = await dictationAvailability().catch(() => null);
  out["mbos.ai.dictation"] =
    dictation?.available === true
      ? {
          available: true,
          maxSeconds: dictation.maxSeconds,
          maxSizeMb: dictation.maxSizeMb,
          canRefine: dictation.canRefine,
        }
      : { available: false, reason: dictation?.available === false ? dictation.reason : "unknown" };

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

/**
 * `partyNameKey` in SQL: trim, collapse the whitespace, uppercase.
 *
 * Written once and applied to BOTH sides of the comparison, so the two halves
 * cannot fold differently from each other — which is the failure a second
 * spelling of a normalisation always produces, and the one nobody sees until
 * two names that are obviously the same stop matching.
 */
function nameFold(column: SQL | AnyColumn) {
  /* `[[:space:]]` rather than `\s`: a backslash escape inside a template
     literal is cooked away before Postgres ever sees it, and the regex would
     silently become `s+` — matching the letter s. */
  return sql`upper(regexp_replace(btrim(${column}), '[[:space:]]+', ' ', 'g'))`;
}

/**
 * THE SHOPS THAT NAME THIS SALESMAN, joined by the name rather than by a seat.
 *
 * `scopedToUsers` asks which customers carry this person in one of the two
 * manager seats, and for a field salesman the answer is none of them: those
 * seats hold account managers, and a field salesman is named — as text, off
 * the party sheet — in `customers.sales_person_name`. So his handset was
 * correctly empty, and no screen anywhere could say why.
 *
 * MBOS ONLY, deliberately. The CRM's lists are unchanged: `scopedToUsers`
 * stays exactly what it was, because widening it would hand thirty-one screens
 * a different answer to "whose book is this" overnight. The question MBOS asks
 * is a narrower one — which shops does this salesman work — and this is the
 * one place it is answered.
 *
 * It reads every user in scope, not just the principal, so a manager on the
 * handset sees his team's shops the same way each of them does. Anything else
 * would give the manager and his salesman two different books.
 */
function namedByUsers(ids: string[]) {
  return sql`${nameFold(customers.salesPersonName)} in (
    select ${nameFold(sql`u.sales_person_name`)}
      from users u
     where u.id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}
       and u.sales_person_name is not null
       and btrim(u.sales_person_name) <> ''
  )`;
}

/** The customer ids this principal may see. Every other query filters on it. */
export async function customerIdsInScope(
  principal: MbosPrincipal,
): Promise<string[]> {
  const ids = scopedUserIds(principal.scope);
  /*
   * WHO MAY SEE IT, AND WHERE HE WORKS — two clauses doing two different jobs,
   * and they are ANDed rather than folded together.
   *
   * The first is the security boundary and is main's: the three seats decide
   * whose book a record is in, `namedByUsers` adds the salesman the customer
   * master NAMES, and `null` short-circuits BEFORE the `or` because
   * `scopeIn(null)` is `undefined` — Drizzle drops an undefined operand, so
   * `or(undefined, namedBy…)` would collapse to the name match alone and NARROW
   * an admin to it, which is the opposite of what null means.
   *
   * The second is the territory, and it can only ever REMOVE rows from what the
   * first allows. Nobody is given sight of another salesman's customer by being
   * allocated a city. `territoryClauseFor` answers undefined where nothing is
   * allocated and `and()` drops it, so a person with no territory keeps the
   * whole book they had — allocating cities to eight people and forgetting the
   * ninth must not empty her handset.
   *
   * `and(undefined, undefined)` is undefined, so an admin with no territory is
   * still unrestricted. Both null-handling rules survive the pairing.
   */
  const visible = ids === null ? undefined : or(scopeIn(ids), namedByUsers(ids));

  /*
   * NO TERRITORY, NO BOOK — and the short-circuit is here rather than in the
   * clause so the query is never asked at all.
   *
   * Who this applies to is the whole of the carve-out below: a field salesman
   * works a beat somebody allocates him, and an unallocated one carrying five
   * thousand shops is the failure this reverses. A MANAGER or an ADMIN on a
   * handset is not walking a beat — the console is oversight, their scope has
   * already answered the question, and emptying their phone for want of an
   * allocation nobody would think to make reads as a broken sync rather than
   * as a rule. `role` is the derived widest role, so this is the same answer
   * `scopeForUser` gave a line earlier rather than a second reading of it.
   *
   * The emptiness is NAMED, never silent: `mbosTerritoryState` puts the reason
   * on the handset and the team screen counts who it has switched off. An
   * empty book that says why is a question; one that does not is a fortnight
   * of somebody assuming the sync is broken.
   */
  const exempt = principal.role === "admin" || principal.role === "manager";
  const territories = await territoriesFor(principal.user.id);
  if (!exempt && !territories.length) return [];

  const territory = territories.length ? territoryClause(territories) : undefined;

  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(visible, territory));
  return rows.map((r) => r.id);
}

/**
 * WHY THE BOOK IS THE SIZE IT IS, in the shape the handset renders.
 *
 * Sent so the Customers tab can tell an empty book apart from a switched-off
 * one. Those are different facts about somebody's day and no screen may draw
 * them alike: "nothing in your book yet" sends a salesman to ask why nobody has
 * given him shops, and "no area has been allocated to you" sends him to the one
 * person who can fix it.
 *
 * `allocated` is the answer, `places` is what to print, and `exempt` says the
 * rule does not apply to this principal at all — a manager whose handset is
 * empty for want of customers must not be told to go and ask for a territory.
 */
/** The same, for a caller holding a principal and no list. */
export async function territoryStateFor(
  principal: MbosPrincipal,
): Promise<TerritoryState> {
  return mbosTerritoryState(principal, await territoriesFor(principal.user.id));
}

export function mbosTerritoryState(
  principal: MbosPrincipal,
  territories: Territory[],
): TerritoryState {
  const exempt = principal.role === "admin" || principal.role === "manager";
  const working = territories.filter((t) => t.kind !== "region");
  return {
    allocated: working.length > 0,
    exempt,
    /* The narrowest name of each branch, which is what somebody recognises:
       "Pune" rather than "Maharashtra, Pune" on a chip a phone has to fit. */
    places: [...new Set(working.map((t) => t.value))].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * HIS BOOK BEFORE TERRITORY IS APPLIED — the two seats and the party sheet.
 *
 * Exported for one caller: the action that changes where somebody works has to
 * know which shops LEAVE the handset, and that is this set narrowed by the old
 * territory minus the same set narrowed by the new one. Computing it from the
 * whole `customers` table instead would tombstone thousands of shops that were
 * never on the phone.
 *
 * It takes a user id rather than a principal because the office is holding
 * neither a device nor a session for the person it is reallocating.
 */
export async function bookIdsIgnoringTerritory(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(or(scopeIn([userId]), namedByUsers([userId])));
  return rows.map((r) => r.id);
}

export type BootstrapPayload = {
  serverTime: number;
  cursor: string;
  /** Why the book is the size it is. See `TerritoryState`. */
  territory: TerritoryState;
  user: {
    id: string;
    name: string;
    /* Null where somebody signs in with a work number alone — which on a
       handset is most of them. `mbos-app/src/sync/api.ts` has typed this
       nullable since it was written, so the wire needed nothing; it was only
       ever the server insisting on a value it could not always have. */
    email: string | null;
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
  /**
   * The days themselves, and how far each has got in being agreed.
   *
   * The stops channel above carries a day only once it is PLANNED, so without
   * this a fresh sign-in showed nothing on the Journey tab — no day to agree,
   * no day to pick shops for, no history — and the delta could not make it up
   * afterwards, being gated on `updated_at`: a day proposed before this
   * handset signed in and never touched again would arrive on no pass ever.
   */
  planDays: unknown[];
  /** In force today. See `priceListRows` — the handset replaces it wholesale. */
  priceList: unknown[];
  /** Live promotions, as data. Nothing here interprets eligibility or benefit. */
  schemes: unknown[];
  tasks: unknown[];
  samples: unknown[];
  leads: unknown[];
  timeline: unknown[];
  customerOrders: unknown[];
  customerPayments: unknown[];
  /** The open bills behind `outstandingPaise`. See `customerBills`. */
  customerBills: unknown[];
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
 * Ten orders and ten receipts a customer. Enough to answer "what do they buy"
 * and "do they pay" while standing in the shop; far short of an accounts
 * ledger, which is not what a handset is for and would not fit on one.
 */
const HISTORY_PER_CUSTOMER = 10;

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
  /* Read again rather than threaded out of `customerIdsInScope`: that function
     is the security path and is called from a dozen places, and widening its
     return type to carry a screen's sentence is how a boundary picks up a
     second job. Two cheap reads of one indexed table beat that. */
  const territories = await territoriesFor(principal.user.id);
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
    planDayRows,
    priceRows,
    schemeRowsForBootstrap,
    taskRows,
    sampleRows,
    leadRows,
    timelineRows,
    orderHistoryRows,
    paymentHistoryRows,
    billRows,
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
    /* Null, so the whole window comes down rather than a delta of it — see
       `planDaysFor`. */
    planDaysFor(principal.user.id, null),
    priceListRows(),
    schemeRows(null),
    openTasks(principal.user.id),
    openSamples(principal.user.id, ids),
    openLeads(principal.user.id),
    recentTimeline(ids, TIMELINE_PER_CUSTOMER),
    recentOrders(ids, HISTORY_PER_CUSTOMER),
    recentPayments(ids, HISTORY_PER_CUSTOMER),
    customerBills(principal, ids, HISTORY_PER_CUSTOMER),
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
    territory: mbosTerritoryState(principal, territories),
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
    planDays: planDayRows,
    priceList: priceRows,
    schemes: schemeRowsForBootstrap,
    tasks: taskRows,
    samples: sampleRows,
    leads: leadRows,
    timeline: timelineRows,
    customerOrders: orderHistoryRows,
    customerPayments: paymentHistoryRows,
    customerBills: billRows,
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
/**
 * THE CUSTOMERS A DELTA SENDS — the same shape the bootstrap sends, because it
 * is the same function.
 *
 * IT WAS A SECOND QUERY, and it was a SUBSET. `customersForDevice` selects
 * thirty-one fields; the delta spelled out twenty of them inline, so eleven
 * reached a handset at sign-in and never again: `thirdParty`, `cycleDays`,
 * `gstin`, `dealerCode`, `territoryRegion`, `customerType`, `potential`,
 * `creditDays`, `visitFrequencyDays`, `gpsAccuracyM` and the `distributors`
 * list — plus `healthBand`, which is not in either SELECT at all but computed
 * by `bandFor` on the way out of the bootstrap and nowhere else.
 *
 * Nothing looked wrong, because `upsert` writes exactly the columns that
 * ARRIVE. A missing column is not written as null; it is simply not written,
 * so the value from the bootstrap sits there being right about the day the
 * salesman signed in and wrong from then on. `pullCursor` is set once and
 * cleared nowhere, so "then on" is the life of the installation.
 *
 * What it cost is three things on the customers card. `thirdParty` is the
 * "Third party" chip, `healthBand` is the whole status dot and its word, and
 * `cycleDays` is the reorder line — so a shop marked third-party in the office
 * on Tuesday still read as an ordinary customer, and a customer who went
 * dormant in March still read Active. A column added for a new handset screen
 * reached a phone only if its owner happened to sign out and back in.
 *
 * The 2,000 cap and the `updated_at` ordering stay where they were and on the
 * IDS, which is the half that has to be ordered: the cap must take the oldest
 * changes first or the ones it drops are never asked for again. Which order
 * `customersForDevice` then returns them in does not matter, because the
 * handset upserts them.
 */
async function changedCustomersForDevice(ids: string[], sinceIso: string) {
  if (!ids.length) return [];
  const idList = sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;
  const changed = await db.execute<{ id: string }>(sql`
    select c.id
      from customers c
     where c.id in ${idList} and c.updated_at > ${sinceIso}
     order by c.updated_at asc
     limit 2000
  `);
  return customersForDevice(changed.map((r) => r.id));
}

async function customersForDevice(ids: string[]) {
  if (!ids.length) return [];
  const rows = await db.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.contact_person as "contactPerson", c.phone,
           c.city, c.area, c.beat,
           c.territory_region as "territoryRegion", c.dealer_code as "dealerCode",
           -- what mbos_price_list is keyed on for this account
           c.price_tag as "priceTag",
           -- A lead reaches this list through its owner, so the card has to be
           -- able to say which it is looking at. See migration v12.
           c.kind, c.status, c.gstin,
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

  /*
   * THE RETENTION BAND, computed here rather than in the SQL above.
   *
   * `bandFor` is the one definition of "has this customer gone quiet" — the
   * same function `customers.status`, the Call Log and the owner's retention
   * report all read. Spelling it as a CASE expression in the query would have
   * been a second copy of a rule whose whole point is that there is one, and
   * the copy would drift the first time somebody changed a multiplier.
   *
   * It is sent rather than computed on the handset for the reason the score
   * beside it is: one answer, made once. A phone that derived its own would
   * derive it from a book that is hours old, and two salesmen standing in one
   * shop would read different words about it.
   *
   * Null is a real answer and means the customer has never ordered — they have
   * not stopped buying, they have not started, and the handset says so in
   * words rather than drawing a band it invented.
   */
  const config = await getConfig();
  const day = await today();
  return rows.map((r) => ({
    ...r,
    healthBand:
      bandFor(
        {
          lastOrderDate: (r.lastOrderDate as BusinessDate | null) ?? null,
          cycleDays: Number(r.cycleDays ?? 0),
        },
        day,
        config,
      )?.band ?? null,
  }));
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

/**
 * The days themselves, and how far each has got in being agreed.
 *
 * A STOP ONLY EXISTS ONCE A DAY IS PLANNED, so the stops channel cannot show
 * a salesman a day he is merely being asked about — which, on a month laid out
 * in advance, is nearly all of them. This is the channel that can, and the
 * bootstrap did not carry it: a fresh sign-in got an empty Journey tab and had
 * to wait for a delta, which is `updated_at`-gated, so a day proposed before
 * that handset signed in and never touched again arrived NEVER. It is the same
 * failure `journeyStops` above already carries a note about — built, sent by
 * one channel, and applied by nothing on the other.
 *
 * `since` null is the bootstrap asking for the whole window, exactly as
 * `holidaysFor` and `openLeads` are asked.
 *
 * **A NUMBER SUBTRACTED FROM A DATE NEEDS ITS TYPE SAID OUT LOUD.**
 * `${PLAN_HISTORY_DAYS}` is a bind parameter, and an untyped parameter next to
 * a date lets Postgres resolve `date - $n` as `date - date` — which yields an
 * integer, and `date >= integer` has no operator, so the query throws. It is
 * the same family as the bare-cast rules in AGENTS.md and it hides the same
 * way: the SQL is correct-looking, `tsc` sees a string, and nothing fails
 * until the query actually runs. `::int` is the fix and the two callers of
 * this now share one copy of it.
 */
async function planDaysFor(userId: string, since: string | null) {
  return db.execute<Record<string, unknown>>(sql`
    select p.id, p.plan_date::text as "planDate", p.city, p.beat,
           p.day_state::text as "dayState",
           p.refusal_reason as "refusalReason",
           p.counter_city as "counterCity",
           p.self_planned as "selfPlanned",
           (extract(epoch from p.proposed_at) * 1000)::double precision as "proposedAt",
           m.name as "proposedBy",
           (select count(*)::int from mbos_journey_stops s where s.plan_id = p.id)
             as "picked"
      from mbos_journey_plans p
      left join users m on m.id = p.proposed_by_id
     where p.user_id = ${userId}
       and p.plan_date >= (now() at time zone ${APP_TIMEZONE})::date - ${PLAN_HISTORY_DAYS}::int
       ${since ? sql`and p.updated_at > ${since}` : sql``}
     order by p.plan_date asc
     limit 200
  `);
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
           /*
            * THE FUNNEL, SENT — and it was not, which made the whole thing
            * one-way.
            *
            * Everything a salesman AUTHORS reached the office perfectly from
            * the first build: the sales type, the eight answers, the checklist,
            * all of it went up. None of it came back. So a lead the office
            * verified, re-typed or corrected showed the phone the version it
            * had already had — and a lead created on the Leads screen in the
            * console arrived on the handset as a bare name with no ladder,
            * where every gate refused it for want of answers that existed.
            * Exactly the shape of the bug that left MBOS with no reference data
            * at all: the authored half worked, so nothing looked broken.
            *
            * Both sides in ONE change, always. A column added here that the
            * handset has no place for throws inside applyPull and rolls back
            * the entire pull, not just the leads.
            *
            * (And no backticks in this comment: it lives inside a sql template
            * literal, where one would end the literal mid-query.)
            */
           c.lead_sales_type as "salesType",
           c.lead_stage_since::text as "stageSince",
           c.customer_type as "customerType",
           c.lead_monthly_volume_litres as "monthlyLitres",
           c.lead_competitor as competitor,
           c.lead_required_product_id as "requiredProductId",
           p.name as "requiredProductName",
           c.contact_person as "contactPerson",
           c.lead_decision_maker as "decisionMaker",
           c.lead_credit_days_wanted as "creditDaysWanted",
           c.lead_application as application,
           c.gstin,
           c.lead_qualification as qualification,
           c.lead_next_action as "nextAction",
           c.lead_next_action_date::text as "nextActionDate",
           c.lead_next_action_owner_id as "nextActionOwnerId",
           c.lead_next_action_outcome as "nextActionOutcome",
           c.lead_suspect_decided_at as "suspectDecidedAt",
           c.lead_verified_at as "verifiedAt",
           c.third_party as "thirdParty",
           c.lead_distributor_salesman_id as "distributorSalesmanId",
           ds.name as "distributorSalesmanName",
           c.lead_expected_order_date::text as "expectedOrderDate",
           c.lead_expected_order_value_paise as "expectedOrderValuePaise",
           c.updated_at as "updatedAt"
      from customers c
      left join products p on p.id = c.lead_required_product_id
      left join distributor_salesmen ds on ds.id = c.lead_distributor_salesman_id
      left join users lm on lm.id = c.lead_manager_id
      -- The lead manager reads it too, not only the salesman who raised it.
      -- The commercial half of a lead is his to answer, and a screen that
      -- listed only what a person OWNS would hide every lead he was named on.
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
/**
 * What the office knows this shop bought, newest first, capped per customer.
 *
 * The record's Orders tab was a placeholder and the cheap fix was to render it
 * off the timeline, which already syncs. Production says no: 10,874 orders
 * against 61 order timeline events. A tab built that way would show one order
 * to a salesman standing in a shop that has placed forty — and be believed.
 *
 * Capped the same way `recentTimeline` is, and for the same reason: a book of
 * 587 customers must not put its whole order history on a phone.
 *
 * `total_amount` is what was actually billed or typed. Nothing here reaches for
 * the catalogue to value a line — `products.priceSource` is still unset, and a
 * confident wrong figure on a customer's record is worse than no figure.
 */
async function recentOrders(ids: string[], perCustomer: number) {
  if (!ids.length) return [];
  return db.execute<Record<string, unknown>>(sql`
    select id, "customerId", "orderedAt", status, "valuePaise", lines, "orderNo"
      from (
        select o.id, o.customer_id as "customerId",
               (o.ordered_at at time zone ${APP_TIMEZONE})::date::text as "orderedAt",
               o.status::text as status,
               o.total_amount as "valuePaise",
               coalesce(jsonb_array_length(o.line_items), 0) as lines,
               o.order_no as "orderNo",
               row_number() over (
                 partition by o.customer_id order by o.ordered_at desc, o.id desc
               ) as rn
          from orders o
         where o.customer_id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}
      ) ranked
     where rn <= ${perCustomer}
     order by "customerId" asc, "orderedAt" desc
  `);
}

/**
 * And what it has paid. Every receipt, whatever its status.
 *
 * A REJECTED or REVERSED receipt is shown rather than hidden, because it is a
 * fact about the account the salesman will be asked about — "we paid that" —
 * and a statement that silently drops it leaves him with no answer. The status
 * rides along so the screen can say which it is; only `confirmed` money has
 * moved anything.
 */
async function recentPayments(ids: string[], perCustomer: number) {
  if (!ids.length) return [];
  return db.execute<Record<string, unknown>>(sql`
    select id, "customerId", "receivedAt", "amountPaise", mode, reference, status
      from (
        select r.id, r.customer_id as "customerId",
               r.received_at::text as "receivedAt",
               r.amount as "amountPaise",
               r.mode, r.reference, r.status::text as status,
               row_number() over (
                 partition by r.customer_id order by r.received_at desc, r.id desc
               ) as rn
          from payment_receipts r
         where r.customer_id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}
      ) ranked
     where rn <= ${perCustomer}
     order by "customerId" asc, "receivedAt" desc
  `);
}

/**
 * WHAT THE MONEY IS AGAINST — the open bills, read off the Accounts ledger.
 *
 * The handset has always carried `outstandingPaise`, one number, and a
 * salesman could tell a shop it owed ₹47,000 without being able to say which
 * invoices that was. Worse, `handlePayment` has accepted `billIds` since it
 * was written — it validates each against the customer's open bills and runs
 * the same pure `allocate` the record form runs — and nothing on the handset
 * ever filled it. So every rupee collected in the field was spread OLDEST
 * FIRST, including from the customer standing there paying against the
 * invoice in his hand. AGENTS.md says newest-first exists for exactly that
 * person; the field was the one place it could not be expressed.
 *
 * IT IS THE ACCOUNTS READ, not a second one. `listBills` is what the ledger,
 * the Outstanding screen and `listOutstandingByCustomer` all go through, so
 * the due date resolved from the customer's term, the aging and
 * `paymentPosition` are worked out once. A handset totalling a debt from its
 * own query is how a salesman and an accounts clerk come to disagree about a
 * bill in front of the customer.
 *
 * `openOnly` is deliberate and it is the collections question rather than the
 * ledger one: a settled bill is most of a year and none of it is collectable.
 * It is also NOT cut by financial year — the oldest debt on an account is
 * usually last year's, and it is the first thing anybody chases.
 *
 * The payload is TRIMMED rather than forwarded. `listBills` returns the
 * customer's name, the status and the bucket, none of which the handset has a
 * column for, and one extra key on the wire empties the phone.
 */
async function customerBills(
  principal: MbosPrincipal,
  ids: string[],
  perCustomer: number,
) {
  if (!ids.length) return [];

  const rows = await listBills({ openOnly: true, customerIds: ids }, principal);

  /* Oldest first within each customer: that is the order they get chased in,
     and it is the order the automatic spread would settle them in. */
  const byCustomer = new Map<string, typeof rows>();
  for (const b of [...rows].sort((a, z) => a.billDate.localeCompare(z.billDate))) {
    const held = byCustomer.get(b.customerId) ?? [];
    if (held.length >= perCustomer) continue;
    held.push(b);
    byCustomer.set(b.customerId, held);
  }

  return [...byCustomer.values()].flat().map((b) => ({
    id: b.id,
    customerId: b.customerId,
    billNo: b.billNo,
    billDate: b.billDate,
    dueDate: b.dueDate,
    amountPaise: b.amount,
    paidPaise: b.paid,
    balancePaise: b.balance,
    overdueDays: b.overdueDays,
    disputed: b.disputed ? 1 : 0,
    /*
     * Whether anybody has spoken for this bill, carried so the screen can say
     * which kind of number the balance is. On an `unstated` bill it is the
     * full amount purely because nothing has been recorded against it either
     * way — it is not a debt, `recomputeOutstanding` keeps it out of the
     * figure above it, and drawing it as one would be the imported-book
     * mistake arriving on a phone.
     */
    paymentPosition: b.paymentPosition,
  }));
}

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

/**
 * What leave somebody has, has spent, and has left — one row per kind they
 * could ask for, whether or not anything has been stored about them.
 *
 * Read from three places, and NONE of them is `mbos_leave_balances.used_days`:
 *
 *  - the entitlement is `mbos.leave.annualEntitlementDays`, configuration,
 *    because nothing in MahekOne ever set one. The only code that created a
 *    balance row was the approval path, at zero days entitled, so a person had
 *    a row for a kind of leave only after taking some — and the handset builds
 *    its list of kinds from these rows, so before anybody had taken any leave
 *    the form could offer nothing but loss of pay. Every request a salesman
 *    could make was unpaid and no screen said why.
 *  - a row in `mbos_leave_balances` overrides it for one person, which is what
 *    that table is for now: somebody on different terms, stated deliberately.
 *  - what has been SPENT is derived from the approved requests themselves,
 *    never from the cached `used_days`. That column was incremented on approval
 *    and decremented by nothing at all, so a request approved and then reversed
 *    left the balance permanently short with no way to notice. Deriving is also
 *    what makes a half day cost half a day: the debit is the request's own
 *    arithmetic rather than a number somebody added up once.
 *
 * `year` is the calendar year the entitlement runs in. Only requests STARTING
 * in it are counted — a leave straddling New Year is spent where it began,
 * which is arbitrary but stated, and the alternative is splitting one absence
 * across two balances so that neither reads as the leave anybody took.
 */
async function leaveBalances(userId: string, year: number) {
  const config = await getConfig();

  const [overrideRows, usedRows] = await Promise.all([
    db.execute<{ kind: string; entitled: number }>(sql`
      select b.leave_type::text as kind, b.entitled_days as entitled
        from mbos_leave_balances b
       where b.user_id = ${userId} and b.year = ${year}
    `),
    /* The approved requests themselves, NOT a sum. What a request costs is
       `leaveDebitDays`, and spelling that arithmetic out in SQL as well would
       be two statements of one rule — the half-day half is exactly the sort
       that drifts, and the drifting copy would be the one debiting somebody's
       balance. A person's year is a few dozen rows. */
    db.execute<{ kind: string; days: number; halfDay: boolean }>(sql`
      select l.leave_type::text as kind, l.days, l.half_day as "halfDay"
        from mbos_leave_requests l
        join mbos_approvals a
          on a.subject_id = l.id and a.type = 'leave' and a.state = 'approved'
       where l.user_id = ${userId}
         and l.cancelled_at is null
         and extract(year from l.from_date) = ${year}
    `),
  ]);

  const used: Record<string, number> = {};
  for (const row of usedRows) {
    used[row.kind] =
      (used[row.kind] ?? 0) + leaveDebitDays(Number(row.days), row.halfDay);
  }

  const overrides = Object.fromEntries(
    overrideRows.map((r) => [r.kind, Number(r.entitled)]),
  );

  return leaveBalanceRows(
    config["mbos.leave.annualEntitlementDays"],
    used,
    overrides,
    year,
  );
}

/**
 * The rows as the handset stores them. `period` is the year, which is the only
 * thing on the handset's table saying which year a balance belongs to.
 */
function leaveBalanceRows(
  entitlement: Readonly<Record<string, number>>,
  used: Readonly<Record<string, number>>,
  overrides: Readonly<Record<string, number>>,
  year: number,
): Record<string, unknown>[] {
  return computeLeaveBalances(entitlement, used, overrides).map((b) => ({
    /* The label, not the enum. This is what the handset draws its leave
       buttons from, and it was sending `loss_of_pay` — see `LEAVE_LABELS`.
       It comes back as its enum through `leaveTypeOf`, which reads the words
       around the word. */
    kind: LEAVE_LABELS[b.kind as LeaveType] ?? b.kind,
    period: String(year),
    entitled: b.entitled,
    used: b.used,
    available: b.available,
  }));
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
      /* The same join the Sales Dashboard's Salary screen makes, from the same
         file, so the figure on a handset and the figure in the office cannot
         come from two different readings of who this person is. See
         lib/employee-link.ts. */
      left join employees e on ${employeeJoinOn("u", "e")}
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
const DELETIONS_PER_PULL = 2000;

async function deletionsSince(userId: string, since: string) {
  const rows = await db.execute<{ entity: string; entityId: string; at: Date | string }>(sql`
    select d.entity, d.entity_id as "entityId", d.at
      from mbos_deletions d
     where d.at > ${since}
       and (d.user_id is null or d.user_id = ${userId})
     order by d.at asc
     limit ${DELETIONS_PER_PULL}
  `);

  const byEntity = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEntity.get(row.entity);
    if (list) list.push(row.entityId);
    else byEntity.set(row.entity, [row.entityId]);
  }

  /*
   * A PAGE THAT IS FULL HAS TO HOLD THE CURSOR BACK, or the rows past it are
   * lost rather than delivered next time.
   *
   * The cursor moves to `now` at the top of the pull, so a deletion that did
   * not fit in this page would fall behind it and never be read again — the
   * handset would keep a shop it no longer works, for ever, with nothing
   * anywhere looking wrong. Reallocating a whole territory is exactly the
   * event that fills this page: a book of 2,587 shops moving to somebody else
   * is 2,587 tombstones from one click.
   *
   * `lastAt` is what the caller clamps to. Re-sending the other channels back
   * to that instant costs a few upserts and they are idempotent; losing a
   * tombstone costs a wrong book nobody can see the cause of.
   */
  const full = rows.length === DELETIONS_PER_PULL;
  const lastAt = full ? asDate(rows[rows.length - 1].at) : null;

  return {
    groups: [...byEntity].map(([entity, ids]) => ({ entity, ids })),
    more: full,
    lastAt,
  };
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
      territory: await territoryStateFor(principal),
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
      customerOrders: [],
      customerPayments: [],
      customerBills: [],
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

  /* The business day's year, not the server's. `today()` applies the working
     day boundary in Asia/Kolkata; reading the year off a bare `Date` answers
     in whatever zone the machine is set to, which on the last night of
     December is a different year and a different leave balance. */
  const deltaYear = Number((await today()).slice(0, 4));

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
    orderHistoryChanges,
    paymentHistoryChanges,
    billChanges,
  ] = await Promise.all([
      changedCustomersForDevice(ids, sinceIso),
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
       * month laid out in advance, is nearly all of them.
       *
       * The SAME function the bootstrap calls, for the reason `leaveBalances`
       * beside it carries: two spellings of one channel drift, and the half
       * that drifts is the one nobody is looking at. */
      planDaysFor(principal.user.id, sinceIso),

      /* What leave he has left.
       *
       * The SAME function the bootstrap calls, not a second spelling of it.
       * This was one — four columns off `mbos_leave_balances`, a table that
       * only ever got a row after somebody had already taken leave — and the
       * two would now disagree about every person in the company, because the
       * entitlement moved into configuration and the usage is derived from the
       * requests. That is exactly the drift the delta test downstairs exists to
       * catch, and the cheapest way to pass it is to have one query. */
      leaveBalances(principal.user.id, deltaYear),

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

      /* Not `since`-gated. These are capped at ten a customer and the cap is
         what a delta would have to re-derive anyway: an eleventh order does
         not CHANGE a row, it displaces one, and no `updated_at` on any row
         says so. Sending the current ten is both correct and smaller than the
         query that would work out which ten changed. */
      recentOrders(ids, HISTORY_PER_CUSTOMER),
      recentPayments(ids, HISTORY_PER_CUSTOMER),

      /* Not `since`-gated either, and for a second reason on top of the one
         above: a bill's balance changes when a RECEIPT is confirmed, and that
         touches `bills.updated_at` — but a bill leaving the open set because
         it was settled has no row left to carry a cursor. Sending the current
         open set is the only reading that lets a settled bill disappear. */
      customerBills(principal, ids, HISTORY_PER_CUSTOMER),
    ]);

  return {
    /* CLAMPED where a full page of tombstones was cut short — see
       `deletionsSince`. Everything else is re-sent from that instant and is
       idempotent; a tombstone that fell behind the cursor is a shop nobody can
       get off the phone. */
    cursor: deletionRows.lastAt ? encodeCursor(deletionRows.lastAt) : nextCursor,
    territory: await territoryStateFor(principal),
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
    deletions: deletionRows.groups,
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
    customerOrders: orderHistoryChanges as unknown[],
    customerPayments: paymentHistoryChanges as unknown[],
    customerBills: billChanges as unknown[],
  };
}
