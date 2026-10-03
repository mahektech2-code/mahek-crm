import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appIdEnum, auditLog, users, type User } from "@/db/schema";
import { APP_HEADER } from "@/proxy";
import { inCrmSalesManagerWorkspace, leadInSalesManagersBook } from "@/lib/services/crm-sales-manager-scope";
import { type AppId } from "@/lib/apps";
import { requireUser } from "./auth";
import { getScope as getScopePreference } from "./scope";
import {
  appLabel,
  can,
  canAny,
  grantingHat,
  isPlatformAdminHat,
  requirementFor,
  type Capability,
  type Hat,
} from "./capability-matrix";
export * from "./capability-matrix";
export { roleLabel, ROLE_LEVELS, type Role } from "./role-levels";
import type { Role } from "./role-levels";

/* ---------------------------------------------------------------------------
 * §8 Access control.
 *
 * Scope is resolved once per request and passed into every query as a
 * parameter. Scoping inside request handlers is how a single missed check
 * leaks another telecaller's book.
 * ------------------------------------------------------------------------- */

export type DataScope =
  | { kind: "own"; userIds: string[] }
  | { kind: "team"; userIds: string[] }
  | { kind: "all"; userIds: null };

export type RequestScope = {
  user: User;
  /** The LEVEL in force for this request. `Role` is declared further down. */
  role: "associate" | "manager" | "admin";
  scope: DataScope;
};

/**
 * Resolved once per request. An associate always sees their own book — the
 * preference cookie cannot widen it. A manager sees their reports, an admin
 * sees everything, and anybody standing in the Accounts app sees the whole
 * ledger whatever their level, because the approval queue is nobody's own
 * book.
 */
export const resolveScope = cache(
  async function resolveScope(): Promise<RequestScope> {
    const user = await requireUser();
    return scopeForUser(user, undefined, await hatInForce(user));
  },
);

/**
 * The hat this request is being made under.
 *
 * Normally the app header answers it. WHERE THERE IS NO HEADER the fallback
 * used to be `users.role`, and that stopped being a complete answer the day
 * roles became levels: `accounts` was a role, and `scopeForUser` read it to
 * mean "sees every book, because the approval queue is nobody's own". There
 * is no such value now, and a level cannot carry it — a clerk read as an
 * associate is scoped to their own book, a clerk read as a manager to their
 * reports, and a clerk has neither. Either way the approval queue goes blank.
 *
 * So where no app is named, the GRANTS are asked instead, and only the case
 * that used to be expressible is honoured: somebody whose apps are the ledger
 * desk and nothing else. That is exactly who `users.role = 'accounts'` meant.
 * A person who also holds the CRM is left to the header, as they already were
 * — `widestRole` put them at `manager` and the accounts branch never fired
 * for them either.
 *
 * Not free: it is one query where there used to be none, on requests that
 * name no app — a job, a script, a test, the MBOS API. `resolveScope` is
 * `cache`d per request and `requireCapability` reads the same rows a moment
 * later, so in the paths that matter it is a query that was happening anyway.
 */
export async function hatInForce(user: {
  id: string;
  role: string;
}): Promise<Hat | null> {
  const named = await requestHat(user);
  if (named) return named;

  const hats = (await hatsFor(user)).filter((h) => h.app !== null);
  if (!hats.length) return null;
  return hats.every((h) => h.app === "accounts") ? hats[0] : null;
}

/* ---------------------------------------------------------------------------
 * SCOPE RESOLVED PER APP.
 *
 * `users.role` is the widest role somebody holds anywhere, rebuilt by
 * `setAccess`. It is the right answer to "what may this person DO" — that is
 * the union, deliberately, and `requireCapability` still asks it that way.
 *
 * It was the wrong answer to "how much may this person SEE". Granting Vikram a
 * manager hat on the Sales Dashboard set `users.role` to manager, and every
 * screen in every app then read his scope as `team` — including the CRM, where
 * he was only ever meant to be a telecaller working his own book.
 *
 * The hat is on the GRANT, so scope is now read from the grant for the app the
 * request is actually in. Everything below rests on one property that makes it
 * safe: a per-app role can only ever be NARROWER than the derived one, because
 * the derived one is the widest of them. Resolving per app can lose reach and
 * cannot gain it, and where the app is unknown the old answer stands.
 * ------------------------------------------------------------------------- */

const APP_IDS: ReadonlySet<string> = new Set(appIdEnum.enumValues);

/**
 * Which app this request is in, or null.
 *
 * Written by `src/proxy.ts` from the URL, after stripping anything the client
 * sent under the same name. Null is ordinary rather than exceptional: a job, a
 * test, a cron route and the MBOS API all reach this code with no app route
 * behind them, and they get the account's own role exactly as before.
 */
export async function requestAppId(): Promise<string | null> {
  try {
    const value = (await headers()).get(APP_HEADER);
    return value && APP_IDS.has(value) ? value : null;
  } catch {
    /* No request headers here — a job or a test. Not an error. */
    return null;
  }
}

/**
 * The role this person holds IN THIS APP, or null to fall back to the account.
 *
 * A grant with no role means the account's own, which is what every grant
 * meant before the column existed and what `npm run app:grant` still writes —
 * so null here and "no grant at all" are answered the same way on purpose. A
 * person with no grant is refused by the app's own layout long before scope
 * matters; narrowing them here would only change what an unreachable screen
 * would have shown.
 */
/**
 * THE LEVEL SOMEBODY HOLDS IN ONE NAMED APP.
 *
 * `hatInForce` answers the same question from the REQUEST — the app header the
 * proxy writes — which is right for a capability check that does not know where
 * it is being called from. A layout does know: it is the app. So it says so,
 * rather than trusting a header it could have gone and read for itself, and the
 * designation cannot be wrong because a request arrived without one.
 *
 * NULL ON THE GRANT MEANS ASSOCIATE. It used to mean the account's own level,
 * which is the widest held anywhere — so a CRM grant made from a terminal
 * became a CRM manager the day its holder was made a manager of anything else.
 * `0197_admin_is_per_app` wrote every null row's effective level down, so this
 * moved nobody; from then on a grant is no wider than it says. NO GRANT AT ALL answers null, and the caller says so in words: a
 * person standing in an app they were never given is a redirect away from here
 * on every one of these screens, and drawing a level for them would be the
 * header inventing standing out of nothing.
 */
export async function levelInApp(
  user: { id: string; role: string },
  app: AppId,
): Promise<Role | null> {
  const [grant] = await db
    .select({ role: appAccess.role })
    .from(appAccess)
    .where(
      and(
        eq(appAccess.userId, user.id),
        eq(appAccess.app, app as (typeof appIdEnum.enumValues)[number]),
      ),
    )
    .limit(1);

  if (!grant) return null;
  return (grant.role ?? "associate") as Role;
}

export async function requestHat(user: {
  id: string;
  role: string;
}): Promise<Hat | null> {
  const app = await requestAppId();
  if (!app) return null;

  const [grant] = await db
    .select({ role: appAccess.role })
    .from(appAccess)
    .where(
      and(
        eq(appAccess.userId, user.id),
        eq(appAccess.app, app as (typeof appIdEnum.enumValues)[number]),
      ),
    )
    .limit(1);

  /*
   * The APP is returned even where the grant names no role, because the app is
   * half the answer now. A row with no role of its own is an associate's — but "which app am I standing in" is what
   * the ledger desk's scope hangs on, and dropping it here would take the
   * approval queue down for anybody granted Accounts from a terminal.
   */
  if (!grant) return null;
  return { app: app as AppId, role: (grant.role as Role | null) ?? "associate" };
}

/**
 * The scope rules themselves, for a user who is already known.
 *
 * `resolveScope` gets that user from the session cookie; MBOS gets it from a
 * bearer token, because a handset has no cookie jar. Both land here, so there
 * is exactly ONE statement of what "mine" means — a second copy for the field
 * app is how a salesman ends up seeing a book the CRM would not have shown
 * them.
 *
 * `preference` is the manager's own narrowing, which only the cookie path can
 * ask for. A caller that has no preference to offer gets the default.
 */
export async function scopeForUser(
  user: User,
  preference?: "mine" | "team",
  /**
   * The hat worn in THIS app, falling back to the account's own. It carries
   * the app as well as the level now, because which app somebody is standing
   * in decides the ledger desk's scope and a level cannot say it.
   */
  hat?: Hat | null,
): Promise<RequestScope> {
  /*
   * The hat worn in THIS app, falling back to the account's own.
   *
   * Only ever narrower than `user.role` — see the note above `requestAppId`.
   * The rest of this function is unchanged and reads `role` where it used to
   * read `user.role`, so a caller that supplies nothing gets exactly the
   * behaviour it got before this existed.
   */
  const role = (hat?.role ?? user.role) as Role;

  /*
   * THE LEDGER DESK SEES EVERYBODY'S BOOK, and that is a fact about the APP
   * rather than about the level.
   *
   * Accounts work the approval queue, which is every associate's orders and
   * nobody's own book. This used to key on a role called `accounts`; with
   * roles reduced to levels there is no such value, and keying on the level
   * instead would be the same bug the comment here has always warned about,
   * arriving from the other end. An Accounts associate would fall to the
   * associate branch and be scoped to their own book, which is empty; an
   * Accounts manager would fall to the manager branch and be scoped to their
   * reports, which for a clerk is also empty. Either way the approval queue
   * goes blank, with nothing on the screen saying why.
   *
   * They are also never offered the My book / Team switch, so the narrowing
   * below must not reach them — `getScope` answers "mine" for every
   * non-manager, and reading it here would scope the queue to a clerk's own
   * book all over again.
   */
  if (hat?.app === "accounts") {
    return { user, role, scope: { kind: "all", userIds: null } };
  }

  /*
   * THE FOUNDER COMMAND CENTRE IS COMPANY-WIDE, at every level (PRD §5.3,
   * decision Q1). A delegate is narrowed by the MODULES they hold, never by
   * whose book they sit in, and no preference cookie from the CRM reaches in
   * here — an admin who ticked "My book" there must not read the company's
   * figures as their own book here.
   */
  if (hat?.app === "founder") {
    return { user, role, scope: { kind: "all", userIds: null } };
  }

  if (role === "associate") {
    return {
      user,
      role: "associate",
      scope: { kind: "own", userIds: [user.id] },
    };
  }

  // A manager OR AN ADMIN may deliberately narrow to their own book. The
  // switch is drawn for both — `isManager` is true for an admin — and it used
  // to move the highlight and change nothing, because the admin branch
  // returned `all` before the preference was ever read. Two definitions of
  // scope: the cookie one relabelled the header while this one kept every
  // screen team-wide.
  const narrowing = preference ?? (await getScopePreference(user));
  if (narrowing === "mine") {
    return {
      user,
      role: role === "admin" ? "admin" : "manager",
      scope: { kind: "own", userIds: [user.id] },
    };
  }

  // An admin's team is the whole company, not a reporting line.
  if (role === "admin") {
    return { user, role: "admin", scope: { kind: "all", userIds: null } };
  }

  const reports = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.reportsToId, user.id), eq(users.id, user.id)));

  return {
    user,
    role: "manager",
    scope: { kind: "team", userIds: reports.map((r) => r.id) },
  };
}

/** The user ids a query may read, or null for unrestricted. */
export function scopedUserIds(scope: DataScope): string[] | null {
  return scope.kind === "all" ? null : scope.userIds;
}

/**
 * Whose book a customer record sits in — the ONE definition, so no query can
 * quietly disagree with another about what "mine" means.
 *
 * A lead answers to its owner. A customer answers to its sales account
 * manager, falling back to the owner while the field is unset, so a record
 * mid-migration is never orphaned out of everybody's list.
 */
export function assignedUserId(c: {
  kind: "lead" | "customer";
  ownerId: string | null;
  salesAmId: string | null;
  amDecidedAt?: Date | string | null;
}): string | null {
  if (c.kind === "lead") return c.ownerId;
  // A DECIDED account is what it says it is, empty included.
  if (c.amDecidedAt) return c.salesAmId;
  return c.salesAmId ?? c.ownerId;
}

/**
 * The same rule as SQL, for the VALUE — who holds the book, singular. Written
 * out rather than built from Drizzle column refs because these run inside
 * correlated subqueries, where a bare "owner_id" binds to the wrong table.
 */
/*
 * The fallback to the owner is for a field NOBODY HAS SET, not for one
 * somebody has deliberately emptied.
 *
 * `owner_id` is whoever imported the account — one person holds it on 1,078
 * rows here — so a salesperson leaving, recorded honestly as "this account now
 * has no salesperson", handed the account to them instead. It arrived in their
 * personal calling list, on a customer they had never sold to, and the screen
 * still showed the departed salesperson's name because that is a different
 * column. It took a report of "why is this in my book" to find.
 *
 * `am_decided_at` is the mark that a person chose, and after it the sales seat
 * is read exactly as it stands: null means unassigned, and an unassigned
 * account belongs on a manager's list of accounts nobody is working — which
 * is what the team view already labels in words — rather than in the book of
 * whoever happened to run the import.
 */
export const ASSIGNED_TO_SQL = sql`
  case when customers.kind = 'lead'
       then customers.owner_id
       when customers.am_decided_at is not null
       then customers.sales_am_id
       else coalesce(customers.sales_am_id, customers.owner_id)
  end`;

/** The other seat, spelled out for the same reason. */
export const BACK_OFFICE_SQL = sql`customers.back_office_am_id`;

/**
 * The THIRD seat that grants sight: the Lead Manager coordinating a lead.
 *
 * Deliberately not part of `ASSIGNED_TO_SQL`. Whose book a lead is in stays the
 * owner's, because that is what puts it on a salesman's handset and dates his
 * follow-ups — and the whole point of this seat is that the salesman keeps
 * visiting the shop while somebody senior runs the conversion. Reading it as
 * ownership would have moved the lead off his phone on the day he qualified it.
 */
export const LEAD_MANAGER_SQL = sql`customers.lead_manager_id`;

/**
 * The FOURTH seat that grants sight: whoever the relationship was handed over
 * to once the lead became a customer.
 *
 * Same split as the three above, and here it is the one that matters most.
 * `ASSIGNED_TO_SQL` decides whose orders an account is and whose target it
 * counts toward; reading this there would move revenue between people as a
 * side effect of naming a relationship manager, and quietly — nobody reads a
 * target screen looking for a handover. Moving money is `customer.reassign`,
 * accounts' and admin's. This only lets the person who was handed the account
 * open it, which is the least a seat can do and still be a seat.
 */
export const RELATIONSHIP_OWNER_SQL = sql`customers.relationship_owner_id`;

/**
 * WHOSE LIST A CUSTOMER APPEARS ON, which is not the same question as who
 * holds the book — and is the one every scoped query actually asks.
 *
 * Both seats count. The back office team calls their accounts too: they are
 * telecallers who also do the dispatch and the paperwork, so an account
 * reaches whoever sells to it AND whoever handles it. Reading the sales seat
 * alone gave Seema Roy an empty CRM — back office on 195 accounts, sales on
 * none, so her calling queue said "queue cleared" on a day she had 195
 * accounts to work.
 *
 * It follows that one account can be on two people's lists, and that is
 * intended rather than a leak: they are the two people responsible for it.
 *
 * `ASSIGNED_TO_SQL` stays what it was and is still the answer to "whose book
 * is this" — the column a reassignment writes and the queue dates work from.
 * This is only about who may SEE it.
 */
export function scopedToUsers(ids: string[] | null): SQL | undefined {
  /*
   * NOT IN THE LEAD TRASH, for every reader — the whole-book one included,
   * which is why this no longer answers `undefined` for them. Everything that
   * narrows a customer read to a book comes through here: the calling queue,
   * the handset's book, collections, reminders, WhatsApp. A lead an
   * administrator has not restored is in nobody's book.
   */
  if (!ids) return sql`customers.deleted_at is null`;
  return and(sql`customers.deleted_at is null`, or(
    inArray(ASSIGNED_TO_SQL, ids),
    inArray(BACK_OFFICE_SQL, ids),
    /*
     * And the Lead Manager, for a lead they have been given to run. Without
     * this the seat would be a label: the person told to coordinate the
     * conversion could not open the record, and the notification announcing it
     * would lead to a screen that refused them.
     */
    inArray(LEAD_MANAGER_SQL, ids),
    /*
     * And whoever now runs the relationship. Exactly the same reasoning one
     * step later in the account's life: a handover that did not carry sight
     * with it would announce to somebody that an account is theirs and then
     * refuse them the screen.
     */
    inArray(RELATIONSHIP_OWNER_SQL, ids),
  ));
}

/**
 * Every hat a person wears: one per app they have been granted, plus the
 * account's own. A grant with no role is an associate's — see `levelInApp`.
 */
const hatsForIds = cache(async function hatsForIds(
  userId: string,
  role: string,
): Promise<Hat[]> {
  const rows = await db
    .select({ app: appAccess.app, role: appAccess.role })
    .from(appAccess)
    .where(eq(appAccess.userId, userId));

  const hats: Hat[] = [{ app: null, role: role as Role }];
  for (const r of rows) {
    hats.push({ app: r.app as AppId, role: (r.role ?? "associate") as Role });
  }
  return hats;
});

/**
 * MEMOIZED PER REQUEST, AND KEYED ON THE IDS RATHER THAN THE OBJECT.
 *
 * `canFor` asks this once per capability and `requireCapability` once per
 * audited write, so it is the same `app_access` read several times over inside
 * one request — four times on the customer record page, three on the customers
 * list, and once more on every save. None of them can disagree: a grant cannot
 * change half way through rendering a page.
 *
 * The inner function takes the id and the role as STRINGS deliberately.
 * React's `cache` keys on argument identity, so memoizing on the `user` object
 * would miss the moment two callers pass separately-read rows for one person —
 * which is exactly the case this exists to collapse, and it would fail by
 * silently doing nothing rather than by breaking.
 */
export async function hatsFor(user: {
  id: string;
  role: string;
}): Promise<Hat[]> {
  return hatsForIds(user.id, user.role);
}

/** The union, for a user whose hats have not already been read. */
export async function canFor(
  user: { id: string; role: string },
  capability: Capability,
): Promise<boolean> {
  return canAny(await hatsFor(user), capability);
}

/** Whether this person is a platform administrator — read off the grants, never the account. */
export async function isPlatformAdmin(user: { id: string; role: string }): Promise<boolean> {
  return (await hatsFor(user)).some(isPlatformAdminHat);
}

/**
 * THE GATE ON EVERY ACT THAT CHANGES WHAT SOMEBODY CAN REACH — granting an
 * app, a level, a module or a power, issuing a password, ending sessions,
 * disabling a sign-in. A platform administrator's, and nobody else's.
 *
 * It used to be `isManager`, the widest level held anywhere, which let any
 * manager of any app post `setAccess` for themselves with `admin` on every
 * app. A server action is a URL, so the page gate in front of the Access
 * screen protected nothing.
 */
export async function requirePlatformAdminUser(): Promise<User> {
  const user = await requireUser();
  if (!(await isPlatformAdmin(user))) {
    throw new NotPermittedError("access.manage");
  }
  return user;
}

/*
 * The conflict rules live in `lib/role-conflicts.ts`, pure and client-safe:
 * the access dialog has to say them on its review page before anything is
 * written, and that is a client component. Re-exported here so server code
 * asking access-control what somebody holds gets the answer from one place.
 */
export { conflictsFor, ROLE_CONFLICTS, type RoleConflict } from "@/lib/role-conflicts";

export class NotPermittedError extends Error {
  readonly capability: Capability;
  /** The narrowest level that would have carried it. */
  readonly requiredRole: Role;
  /** And where — null when several apps carry it, or when it is admin's. */
  readonly requiredApp: AppId | null;
  constructor(capability: Capability) {
    /*
     * WHAT WOULD HAVE ALLOWED IT, read off the matrix rather than off a list
     * of role names.
     *
     * It used to pick between three words — admin, accounts, manager — which
     * worked only while two of the four roles were secretly app names. With
     * levels there is no word that names the ledger desk, so it is searched
     * for instead: the most ordinary (app, level) pair in the table that
     * carries this capability.
     *
     * The APP is named only when exactly one carries it. `order.approve` is
     * the Accounts desk's and nowhere else, so saying so sends somebody to ask
     * for the right grant; `team.report` belongs to the manager level of five
     * different apps, and naming whichever happened to sort first would send
     * them to ask for the wrong one. That is the failure mode this sentence
     * exists to avoid — telling a manager they need the manager role was
     * always a dead end, and telling them they need the wrong app is worse.
     */
    const found = requirementFor(capability);
    const where = found?.app ? ` in ${appLabel(found.app)}` : "";
    super(
      !found
        ? `"${capability}" is granted to nobody by the access matrix.`
        : found.role === "admin"
          ? `That is a platform administrator's action. "${capability}" requires Admin on the Admin Console.`
          : `That is ${found.role === "manager" ? "a manager's" : "an associate's"} action${where}. "${capability}" requires the ${found.role} level${where || " of an app you hold"}.`,
    );
    this.name = "NotPermittedError";
    this.capability = capability;
    this.requiredRole = found?.role ?? "admin";
    this.requiredApp = found?.app ?? null;
  }
}

/**
 * Throws unless the caller holds the capability under ANY hat, and records
 * every denial.
 *
 * The check is the union — that is what holding several hats means — and the
 * hat that granted it comes back in the context so the action can write it
 * into its audit row. A log that says who did it and not what allowed them is
 * a log that cannot answer the only question ever asked of it afterwards.
 *
 * BOTH HALVES of that hat, since roles became levels. "Deepa, as an
 * associate" no longer distinguishes the ledger desk from the phones; "Deepa,
 * as a manager in Accounts" does, and that is the sentence the column exists
 * to be able to write.
 */
export async function requireCapability(
  capability: Capability,
): Promise<RequestScope & { authorisedBy: Role; authorisedIn: AppId | null }> {
  const ctx = await resolveScope();
  const hats = await hatsFor(ctx.user);
  /*
   * THE REQUEST'S OWN APP IS ASKED FIRST (PRD §5.2, P16). An approval taken in
   * the Founder Command Centre must be recorded as the founder's, even when
   * the same person also holds Accounts — the narrowest-hat rule below would
   * otherwise write "Accounts manager" and hide who actually decided.
   */
  const inForce = await requestHat(ctx.user);
  const granting =
    inForce && hats.some((h) => h.app === inForce.app) && can(inForce, capability)
      ? inForce
      : grantingHat(hats, capability);
  if (granting) {
    /*
     * TWO HALVES, and they are returned separately rather than as the hat
     * itself so the forty-odd audit writes downstream keep reading
     * `authorisedBy` for the level. `authorisedIn` is the app it was worn in,
     * null where the account's own role carried it.
     */
    return { ...ctx, authorisedBy: granting.role, authorisedIn: granting.app };
  }

  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: ctx.user.id,
    action: "access.denied",
    entityType: "capability",
    entityId: capability,
    // Every hat they were wearing, so a refusal can be argued with. "Vikram
    // was refused" is unactionable; "Vikram, an associate in the CRM and a
    // manager in Accounts, was refused customer.classify" names the grant that
    // is missing. Both halves of each hat, because the level alone stopped
    // identifying one the day roles became levels.
    afterState: { hats, capability } as never,
  });

  throw new NotPermittedError(capability);
}

/** Non-throwing form, for shaping a response rather than aborting. */
export async function checkCapability(capability: Capability) {
  const ctx = await resolveScope();
  return { allowed: await canFor(ctx.user, capability), ctx };
}

/** Guard for a single customer, used by detail routes. */
/**
 * Takes the record, not an owner id, so it goes through assignedUserId like
 * every list query does. Passing ownerId here while the lists filtered on the
 * sales account manager is how a customer becomes visible in a list and then
 * refuses to open.
 */
/**
 * The row-level half of `scopedToUsers`, and it has to ask the same question.
 *
 * It did not, and that took the Accounts app down. `scopedToUsers` was widened
 * so both seats count — sales AND back office — because reading the sales seat
 * alone gave the back office team an empty CRM. This check was left asking
 * only about the sales seat, so the two disagreed in the worst possible
 * direction: a customer appeared on the list, and opening them threw.
 *
 * From the Accounts bill list that is a click on a row and a "This page
 * couldn't load" — a 500, because a throw in a server component is not a
 * redirect. The list said the record was yours; the record said it was not.
 *
 * Both seats, therefore, in both places. If one of these two ever changes
 * again, the other has to change with it.
 *
 * It happened again, from the Reminders list, and the third seat is the owner.
 * The same sentence applies and the same screenshot came back: the list said
 * the record was yours, the record said it was not. The lesson the second time
 * is that "the same question" was the wrong goal — a LIST asks which single
 * person a record belongs to, and a READ asks whether this person has any
 * business with it at all. Those are different questions and the read is the
 * wider of the two, so this no longer tries to mirror `assignedUserId` and
 * instead names every seat it accepts.
 */
export async function assertCustomerInScope(
  customer: {
    kind: "lead" | "customer";
    ownerId: string | null;
    salesAmId: string | null;
    /**
     * Optional only because a handful of callers select a narrow shape. Where
     * it is absent the check is the old, stricter one — which is the safe
     * direction, and never the cause of a customer being wrongly readable.
     */
    backOfficeAmId?: string | null;
    /**
     * The coordinating seat on a lead. Optional for the same reason as the one
     * above, and absent means the same thing: the old, stricter check.
     */
    leadManagerId?: string | null;
    /**
     * Whoever the relationship was handed over to. Optional for the same
     * reason as the two above, and absent means the same thing: the old,
     * stricter check.
     */
    relationshipOwnerId?: string | null;
    /**
     * The Sales Manager seat. Read ONLY inside the CRM Sales Manager workspace,
     * where it is the whole rule; everywhere else it is ignored, because that
     * seat drives no scope anywhere else (see `crm-sales-manager-scope.ts`).
     * Optional for the reason the four above are, with one difference: inside
     * that workspace a caller that leaves it out is REFUSED, not given the old
     * check — the read that drew the lead used this same seat, and a write that
     * cannot show it must not pass.
     */
    salesManagerId?: string | null;
    /**
     * In the lead trash. A trashed lead is opened by nobody and written by
     * nobody until an administrator restores it — the same answer as a
     * customer out of scope, so a stale screen, a bookmark or a handset still
     * holding it cannot act on it. Optional for the reason the seats above
     * are: a caller that selects a narrow shape and leaves it out is checked
     * as before, and every full-row `select()` carries it.
     */
    deletedAt?: Date | string | null;
  } | null,
) {
  if (customer?.deletedAt) throw new NotPermittedError("customer.read");

  /* THE CRM SALES MANAGER WORKSPACE HAS ONE RULE, and it is the read's rule.
     A lead that `leadsVisible` drew from `sales_manager_id` is a lead this
     lets the person act on, whatever level their CRM hat happens to be. */
  if (await inCrmSalesManagerWorkspace()) {
    const { user } = await resolveScope();
    if (leadInSalesManagersBook(customer, user)) return;
    throw new NotPermittedError("customer.read");
  }

  const { scope } = await resolveScope();
  const ids = scopedUserIds(scope);
  if (ids === null) return;
  if (!customer) throw new NotPermittedError("customer.read");

  /*
   * Three seats, not one, because WHOSE LIST a record appears in is a narrower
   * question than WHO MAY WORK IT — and only the first is `assignedUserId`.
   *
   * "Work it" rather than "read it": this guard sits in front of logging a
   * call, recording a payment, sending a WhatsApp and attaching a file as well
   * as opening the record. Letting the owner through has to be right for all
   * of them, and it is — the owner is the person making those calls. A seat
   * that could read the callback and not log its outcome would be worse than
   * the refusal it replaced.
   *
   * That function answers `salesAmId ?? ownerId`, so the moment a sales AM is
   * set the owner is DROPPED. For a list that is right: a record belongs on
   * one person's list, not two. For a read it was the same disagreement this
   * function was widened for once already, one seat further along — the owner
   * still works the account, still logs its calls, and still gets the reminders
   * those calls produce. Reminders are assigned to whoever promised the call
   * back, and that list scopes by `assigned_user_id`; the record scoped by the
   * sales seat alone. So a telecaller was handed a callback and got a 500 for
   * opening the customer it was about.
   *
   * The lists are untouched by this — nothing here feeds `ASSIGNED_TO_SQL`.
   * What changes is only that a record you own, or do the back office for, can
   * be READ by you after the sales seat moves to somebody else.
   */
  const assigned = assignedUserId(customer);
  const backOffice = customer.backOfficeAmId ?? null;
  const leadManager = customer.leadManagerId ?? null;
  const relationshipOwner = customer.relationshipOwnerId ?? null;
  const owner = customer.ownerId;
  const mine =
    (assigned !== null && ids.includes(assigned)) ||
    (backOffice !== null && ids.includes(backOffice)) ||
    /*
     * The fourth seat, added with `LEAD_MANAGER_SQL` in `scopedToUsers` and in
     * the same commit — because the paragraph above this function is the record
     * of what happens when these two are changed apart. Twice now a seat was
     * added to the list and not to the read, and both times it surfaced as the
     * same thing: the row is on your screen and opening it throws a 500.
     */
    (leadManager !== null && ids.includes(leadManager)) ||
    /*
     * The fifth, and the paragraph above is why it is in the same edit as
     * `RELATIONSHIP_OWNER_SQL` rather than a commit later. "If one of these
     * ever changes again, the other has to change with it" is the whole rule,
     * and it has been broken twice by people who meant to come back to it.
     */
    (relationshipOwner !== null && ids.includes(relationshipOwner)) ||
    (owner !== null && ids.includes(owner));

  if (!mine) throw new NotPermittedError("customer.read");
}

export async function userIdsInScope(): Promise<string[] | null> {
  const { scope } = await resolveScope();
  return scopedUserIds(scope);
}

export async function usersByIds(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(users).where(inArray(users.id, ids));
}
