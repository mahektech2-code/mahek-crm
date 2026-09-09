import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appIdEnum, auditLog, users, type User } from "@/db/schema";
import { APP_HEADER } from "@/proxy";
import { requireUser } from "./auth";
import { getScope as getScopePreference } from "./scope";

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
  role: "telecaller" | "manager" | "accounts" | "admin";
  scope: DataScope;
};

/**
 * Resolved once per request. A telecaller always sees their own book — the
 * preference cookie cannot widen it. A manager sees their reports, and an
 * admin sees everything.
 */
export const resolveScope = cache(
  async function resolveScope(): Promise<RequestScope> {
    const user = await requireUser();
    return scopeForUser(user, undefined, await requestAppRole(user));
  },
);

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
export async function requestAppRole(user: {
  id: string;
  role: string;
}): Promise<Role | null> {
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

  return (grant?.role as Role | null) ?? null;
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
  appRole?: Role | null,
): Promise<RequestScope> {
  /*
   * The hat worn in THIS app, falling back to the account's own.
   *
   * Only ever narrower than `user.role` — see the note above `requestAppId`.
   * The rest of this function is unchanged and reads `role` where it used to
   * read `user.role`, so a caller that supplies nothing gets exactly the
   * behaviour it got before this existed.
   */
  const role = (appRole ?? user.role) as Role;

  if (role === "telecaller") {
    return {
      user,
      role: "telecaller",
      scope: { kind: "own", userIds: [user.id] },
    };
  }

  // Accounts work the approval queue, which is every telecaller's orders
  // and nobody's book. Without this branch they fell through to the manager
  // path and were labelled managers — which then denied them the one
  // capability that is theirs. They are also never offered the My book / Team
  // switch, so the narrowing below must not reach them: `getScope` answers
  // "mine" for every non-manager, and reading it here would scope the approval
  // queue to an accounts clerk's own book, which is empty.
  if (role === "accounts") {
    return { user, role: "accounts", scope: { kind: "all", userIds: null } };
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
  if (!ids) return undefined;
  return or(
    inArray(ASSIGNED_TO_SQL, ids),
    inArray(BACK_OFFICE_SQL, ids),
    /*
     * And the Lead Manager, for a lead they have been given to run. Without
     * this the seat would be a label: the person told to coordinate the
     * conversion could not open the record, and the notification announcing it
     * would lead to a screen that refused them.
     */
    inArray(LEAD_MANAGER_SQL, ids),
  );
}

/* -------------------------------------------------------------- permissions */

export const CAPABILITIES = [
  "customer.read",
  "customer.write",
  "customer.export",
  "customer.deactivate",
  "call.log",
  "order.capture",
  "reminder.write",
  "target.set",
  "target.shortfall",
  "complaint.resolve",
  "whatsapp.bulk",
  "whatsapp.template.write",
  "team.report",
  "config.write",
  "order.approve",
  "payment.record",
  "payment.confirm",
  "creditnote.issue",
  "sheet.import",
  "customer.reassign",
  "customer.assignSalesManager",
  "customer.classify",
  /*
   * The expense policy: writing a draft, and putting one into force.
   *
   * Two capabilities rather than one because requirement 4 asks for a policy
   * to be VERIFIED by an authorised person before it goes live, and
   * verification by the person who typed the rates is not verification.
   */
  "expense.policy.write",
  "expense.policy.publish",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** §8's matrix, as data. Telecallers get everything not listed here. */
const MANAGER_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "customer.export",
  "customer.deactivate",
  "complaint.resolve",
  "whatsapp.bulk",
  "whatsapp.template.write",
  "team.report",
  "config.write",
  /*
   * Who the salesperson answers to — a manager's, and deliberately NOT in
   * `ACCOUNTS_ONLY` beside `customer.reassign`.
   *
   * The two look like the same act and are not. The sales seat decides who is
   * credited for an account's orders and whose targets it counts toward, so a
   * manager moving it is a manager moving numbers between their own people;
   * that is why it sits in the narrowest set in this file. The sales MANAGER
   * seat drives nothing at all — no queue, no scope, no target — so the
   * conflict does not exist, and holding it back would put the line management
   * of a sales team in the hands of the one desk that does not do any.
   *
   * Manager-only rather than shared: it moves work in bulk and by filter, and
   * "everything Rahul had" is a hundred accounts in one press.
   */
  "customer.assignSalesManager",
]);

/**
 * Accepting an order is accounts' job and nobody else's. A manager is not
 * given it by seniority: the person chasing the target must not also be the
 * one signing off the orders that hit it. Confirming that money arrived is the
 * same kind of decision: accounts hold the bank statement, and nobody else can
 * honestly say a transfer landed.
 */
const ACCOUNTS_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "order.approve",
  "payment.confirm",
  // Issuing a credit note takes money off what a customer owes, which is the
  // same kind of decision as confirming that money arrived — and for the same
  // reason it is not a manager's by seniority. The telecaller answers only
  // whether the customer asked.
  "creditnote.issue",
  /*
   * Moving an account to a different account manager, and NOT a manager's by
   * seniority either — deliberately the narrowest set in the file.
   *
   * Whose book an account is in decides who is credited for its orders and
   * whose targets it counts toward, so a manager reassigning accounts is a
   * manager moving numbers between their own people, including themselves.
   * That is the same conflict `order.approve` exists to avoid, one level up:
   * there the person chasing the target must not sign off the orders that hit
   * it, here they must not choose which accounts feed it.
   *
   * It also moves work in bulk. One action can silently empty somebody's
   * calling queue, which is not something to hold by default.
   */
  "customer.reassign",
  /*
   * Authoring the expense policy — the ₹/km, the meal amounts, the hotel
   * ceilings, and who has to approve what.
   *
   * A manager is deliberately excluded, and it is the same conflict
   * `order.approve` and `customer.reassign` exist to avoid, one level up: the
   * person chasing a target must not write the rules for what the chase is
   * allowed to cost. Accounts hold it because accounts already maintain every
   * other money rule in this product, and admin holds everything.
   *
   * A manager still decides individual claims. Writing the policy and applying
   * it are different jobs and this is the line between them.
   */
  "expense.policy.write",
]);

/**
 * Putting an expense policy into force.
 *
 * The narrowest capability in the file, and the only one nobody but a platform
 * admin holds. Publishing is what makes a set of rates real: from that moment
 * every handset computes against them and every claim is paid on them, over
 * a date range that reaches backwards. Requirement 4 asks for somebody to
 * verify before that happens, so the person who typed the numbers cannot also
 * be the only person who has read them.
 *
 * Deliberately not `config.write`, which is a manager's — a manager may not
 * author this policy, so they certainly may not put one into force.
 */
const ADMIN_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "expense.policy.publish",
]);

/**
 * Running the bill import.
 *
 * Not `config.write`: that is manager-only, and accounts are the people who
 * notice Sales Bills is empty. On a deployment with no shell the screen is the
 * only door, so the desk that needs the bills must be able to open it. A
 * manager keeps it because they run the console today — nothing is taken away.
 */
const ACCOUNTS_OR_MANAGER: ReadonlySet<Capability> = new Set<Capability>([
  "sheet.import",
  /*
   * Setting somebody's target, publishing it, revising it, and reading the
   * coverage/customer shortfall behind it.
   *
   * This was manager-only from the day the module shipped, on the same
   * reasoning that keeps `order.approve` and `customer.reassign` away from
   * managers one level down: a target is a number somebody is measured
   * against, and the module was built on the assumption that the person
   * running the team's calling book is the one who sets it. Mahek's own
   * practice is the opposite of that assumption — the accounts desk is who
   * actually assigns and manages targets here — so the capability moved to
   * where the decision is really made, the same way `sheet.import` did.
   *
   * It is ADDED to accounts rather than MOVED off managers: nothing about
   * running a team stopped being a manager's job, and a manager coaching a
   * shortfall still needs to be able to act on it without asking accounts to
   * do it for them. Widening rather than narrowing is what kept `sheet.import`
   * a manager capability too when accounts needed it, and the reasoning is the
   * same reasoning here.
   *
   * Holding this alongside `order.approve` is a new hat combination worth
   * naming: an accounts user who is ALSO a telecaller could now set their own
   * target. See the telecaller+accounts entry in `lib/role-conflicts.ts`.
   */
  "target.set",
  "target.shortfall",
  /*
   * Marking an account as a shop we deliver to, or unmarking one — the same
   * action that reverts a third-party account back to reading as a plain
   * lead again, since only a lead is ever converted in the first place.
   *
   * Manager-only from the day it shipped, on the reasoning that it decides
   * who gets CALLED, which is the work of the team a manager runs — and that
   * reasoning does not go away here, it just stops being the WHOLE reasoning.
   * A converted shop is also who bills it (`customer_distributors`), which is
   * exactly the kind of account fact accounts already maintain when they
   * change who a customer's account manager is. Added rather than moved, for
   * the same reason `target.set` was: a manager coaching a telecaller through
   * which shops are worth marking still needs to be able to do it themselves.
   */
  "customer.classify",
]);

/**
 * Held by every signed-in role, including accounts.
 *
 * Reporting that a customer has paid is not a privilege — a telecaller told it
 * on a call has to be able to write it down, or it lives in their head and the
 * customer gets chased anyway. What separates the roles is not who may record
 * a payment but whether recording it is believed: without `payment.confirm` a
 * receipt lands as `reported` and moves no money.
 */
const SHARED: ReadonlySet<Capability> = new Set<Capability>([
  "payment.record",
]);

/* ---------------------------------------------------------------------------
 * SEVERAL HATS, ONE PERSON.
 *
 * `app_access.role` is the role a grant is held under, so somebody can be a
 * manager in the CRM and a clerk in Accounts. What they may DO is the union:
 * hold a capability under any hat and you hold it. That is the whole feature,
 * and it is also the thing that makes the paragraph below necessary.
 * ------------------------------------------------------------------------- */

export type Role = "telecaller" | "manager" | "accounts" | "admin";

const ROLE_LABELS: Record<Role, string> = {
  telecaller: "Telecaller",
  manager: "Manager",
  accounts: "Accounts",
  admin: "Admin",
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

/**
 * Every role a person holds: one per app they have been granted, plus the
 * account's own. A grant with no role means the account's primary one, which
 * is what every grant meant before roles existed and what `app:grant` writes.
 */
export async function rolesFor(user: {
  id: string;
  role: string;
}): Promise<Role[]> {
  const rows = await db
    .select({ role: appAccess.role })
    .from(appAccess)
    .where(eq(appAccess.userId, user.id));

  const held = new Set<Role>([user.role as Role]);
  for (const r of rows) held.add((r.role ?? user.role) as Role);
  return [...held];
}

/**
 * WHICH HAT ALLOWS IT — the narrowest one, not the most powerful.
 *
 * Returned so the audit can say it, and ordered deliberately: an admin holds
 * everything, so asking admin first would stamp "admin" on every action
 * anybody senior takes and the log would stop distinguishing the clerk doing
 * their job from the administrator reaching past a rule. Ask in order of how
 * ordinary the answer is.
 */
const ROLE_ORDER: Role[] = ["telecaller", "accounts", "manager", "admin"];

export function grantingRole(
  roles: readonly Role[],
  capability: Capability,
): Role | null {
  for (const role of ROLE_ORDER) {
    if (roles.includes(role) && can(role, capability)) return role;
  }
  return null;
}

/** Holding it under ANY hat is holding it. */
export function canAny(roles: readonly Role[], capability: Capability): boolean {
  return grantingRole(roles, capability) !== null;
}

/**
 * THE PRIMARY ROLE IS DERIVED, and it is derived for scope alone.
 *
 * `users.role` decides mine/team/all and is read by thirty-one screens through
 * `isManager`. Rather than teach all of them about a list, it becomes a cache:
 * the widest role somebody holds anywhere. A manager in the CRM sees their
 * team, which is the answer they expect on the day the role is granted.
 *
 * The ordering is by how much a role WIDENS READING, which is the only
 * question this answers — not by seniority, which accounts and telecaller do
 * not have between them. Accounts sits above telecaller because the accounts
 * screens deliberately sit outside the narrowing.
 *
 * IT IS NO LONGER WHAT SCOPE READS. This used to be the whole answer, and the
 * imprecision was named here rather than hidden: an admin in the Admin console
 * was an admin for reading everywhere, the calling book included. `resolveScope`
 * now asks `requestAppRole` for the hat worn in the app the request is actually
 * in, and only falls back to this where there is no app to ask about — a job, a
 * test, the MBOS API.
 *
 * It stays derived, and it stays the widest, because two things still read it:
 * `isManager` on thirty-one screens deciding whether to DRAW a control, and the
 * fallback above. Both want "is this person a manager anywhere", which is the
 * question this has always answered.
 */
const SCOPE_WIDTH: Role[] = ["telecaller", "accounts", "manager", "admin"];

export function widestRole(roles: readonly Role[]): Role {
  let widest: Role = "telecaller";
  for (const role of roles) {
    if (SCOPE_WIDTH.indexOf(role) > SCOPE_WIDTH.indexOf(widest)) widest = role;
  }
  return widest;
}

/*
 * The conflict rules live in `lib/role-conflicts.ts`, pure and client-safe:
 * the access dialog has to say them on its review page before anything is
 * written, and that is a client component. Re-exported here so server code
 * asking access-control what somebody holds gets the answer from one place.
 */
export { conflictsFor, ROLE_CONFLICTS, type RoleConflict } from "@/lib/role-conflicts";

export function can(role: string, capability: Capability): boolean {
  if (SHARED.has(capability)) return true;
  if (ADMIN_ONLY.has(capability)) return role === "admin";
  if (ACCOUNTS_ONLY.has(capability)) {
    return role === "accounts" || role === "admin";
  }
  if (ACCOUNTS_OR_MANAGER.has(capability)) {
    return role === "accounts" || role === "manager" || role === "admin";
  }
  if (role === "admin" || role === "manager") return true;
  // Accounts do not work the calling book, so they get none of the rest.
  if (role === "accounts") return false;
  return !MANAGER_ONLY.has(capability);
}

export class NotPermittedError extends Error {
  readonly capability: Capability;
  readonly requiredRole: "manager" | "accounts" | "admin";
  constructor(capability: Capability) {
    const role = ADMIN_ONLY.has(capability)
      ? "admin"
      : ACCOUNTS_ONLY.has(capability)
        ? "accounts"
        : "manager";
    // Names the required role rather than pretending the resource is absent —
    // the interface shows locked-but-visible controls, and the backend should
    // tell the same story. It has to name the RIGHT role: telling a manager
    // they need the manager role is a dead end.
    const article = role === "accounts" ? "an accounts" : role === "admin" ? "an administrator" : "a manager";
    super(`That is ${article} action. "${capability}" requires the ${role} role.`);
    this.name = "NotPermittedError";
    this.capability = capability;
    this.requiredRole = role;
  }
}

/**
 * Throws unless the caller holds the capability under ANY hat, and records
 * every denial.
 *
 * The check is the union — that is what holding several roles means — and the
 * hat that granted it comes back in the context so the action can write it
 * into its audit row. A log that says who did it and not what allowed them is
 * a log that cannot answer the only question ever asked of it afterwards.
 */
export async function requireCapability(
  capability: Capability,
): Promise<RequestScope & { authorisedBy: Role }> {
  const ctx = await resolveScope();
  const roles = await rolesFor(ctx.user);
  const granting = grantingRole(roles, capability);
  if (granting) return { ...ctx, authorisedBy: granting };

  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: ctx.user.id,
    action: "access.denied",
    entityType: "capability",
    entityId: capability,
    // Every hat they were wearing, so a refusal can be argued with. "Vikram
    // was refused" is unactionable; "Vikram, holding telecaller and accounts,
    // was refused customer.classify" names the grant that is missing.
    afterState: { roles, capability } as never,
  });

  throw new NotPermittedError(capability);
}

/** Non-throwing form, for shaping a response rather than aborting. */
export async function checkCapability(capability: Capability) {
  const ctx = await resolveScope();
  return { allowed: can(ctx.role, capability), ctx };
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
  } | null,
) {
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
