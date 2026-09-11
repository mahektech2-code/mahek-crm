import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appIdEnum, auditLog, users, type User } from "@/db/schema";
import { APP_HEADER } from "@/proxy";
import { getApp, type AppId } from "@/lib/apps";
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
   * half the answer now. A row with no role of its own means the account's
   * level, and that is still true — but "which app am I standing in" is what
   * the ledger desk's scope hangs on, and dropping it here would take the
   * approval queue down for anybody granted Accounts from a terminal.
   */
  if (!grant) return null;
  return { app: app as AppId, role: (grant.role as Role | null) ?? (user.role as Role) };
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
    /*
     * And whoever now runs the relationship. Exactly the same reasoning one
     * step later in the account's life: a handover that did not carry sight
     * with it would announce to somebody that an account is theirs and then
     * refuse them the screen.
     */
    inArray(RELATIONSHIP_OWNER_SQL, ids),
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
  "customer.handOver",
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
  /*
   * THE LEAD FUNNEL, §28.
   *
   * `lead.work` is in none of the sets below, which is how a capability is
   * given to "everybody who works the book": a telecaller holds anything not
   * named in `MANAGER_ONLY`, and a field salesman signs in as one. That is the
   * right shape here rather than an accident — moving a lead up its ladder is
   * the ordinary work of the person standing in the shop, and a funnel only a
   * manager can advance is a funnel nobody updates. Accounts fall out of it for
   * free: they do not work the calling book and they do not work this one.
   */
  "lead.work",
  "lead.override",
  "lead.verify",
  /*
   * §15 — letting a sample go out, which is stock leaving the godown.
   *
   * It exists because a capability that does NOT exist is one everybody holds:
   * `can()` falls through to `!MANAGER_ONLY.has(...)` for anything it does not
   * recognise, so an unnamed capability fails OPEN. Without this the salesman
   * would have been approving the stock he had just asked for.
   */
  "sample.approve",
  /*
   * §12 — the discount, the credit limit and the exclusivity.
   *
   * Separate from `distributor.approve` because they are different acts by
   * different people: a sales manager NEGOTIATES the terms and management
   * ALLOWS them, and it is the terms themselves that decide whether management
   * has to be asked at all. A salesman writing his own customer a 30% discount
   * would route his own appointment past the person meant to weigh it.
   */
  "distributor.terms",
  "distributor.approve",
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
  /*
   * §28 — passing a gate that is shut, and it is a manager's alone.
   *
   * A system that refuses everything is defeated in a week by people recording
   * the work after the event, and the record then says the process was followed
   * when it was not — which is worse than the gate being open. So the escape
   * hatch exists, it demands a reason code, it stores exactly which conditions
   * were still missing, and it is held by the one person who can be asked about
   * it afterwards. It is also what a downward move needs: putting a lead back
   * down its ladder undoes work somebody recorded, and the ladder engine's own
   * `previousStage` says in as many words that it is for a manager reverting
   * one.
   */
  "lead.override",
  /*
   * §8 — the verification call, which is the whole point of §7.
   *
   * The sales manager rings the customer to establish that the salesman was
   * there and that Mahek was explained. Two of the twelve questions are about
   * the salesman rather than the sale, which is exactly why the salesman may
   * not be the person who records the answers — a check somebody performs on
   * their own work is not a check.
   */
  "lead.verify",
  /*
   * §15 — a salesman must not approve the stock he asked for.
   *
   * The same shape as `order.approve` being kept off the person carrying the
   * target: the sample is a cost, the person who wants it out of the door is
   * the person it helps, and one signature covering both is not a signature.
   */
  "sample.approve",
  /*
   * §12 — terms are negotiated by a manager and allowed by management.
   *
   * A manager may agree them; whether that agreement needs management is
   * decided by `approvalRouteReason` from the numbers, not by who typed them.
   */
  "distributor.terms",
  /*
   * Handing the relationship over — a manager's, and for the same reason
   * `customer.assignSalesManager` above is.
   *
   * The test is always whether the act moves NUMBERS. `customer.reassign`
   * moves the sales seat, which decides who is credited for an account's
   * orders and whose target it counts toward, so a manager holding it is a
   * manager moving their own people's figures — that is why it sits in
   * `ACCOUNTS_ONLY`. A handover moves neither: not a rupee of revenue, not a
   * target, not a collections list. What it moves is who runs the account and
   * who can open it, which is line management, and line management is the one
   * thing the accounts desk does not do.
   *
   * It is a real power even so — it grants sight of an account — so it is a
   * capability of its own rather than folded into `customer.write`, and it is
   * checked in the action rather than by hiding a menu item. A server action
   * is a URL.
   */
  "customer.handOver",
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
  /*
   * §12 — appointing a distributor, which is the SECOND step of that chain and
   * not the manager's own recommendation.
   *
   * The specification calls this step "Management", and the distinction it is
   * drawing is the one `order.approve` already draws one level down: a special
   * discount, a credit limit and territory exclusivity are decisions with a
   * cost attached, and the person carrying the target must not be the person
   * allowing them. A sales manager may put a candidate forward — that is
   * `stepIndex` 0 and it needs nothing but their own hat — and may not appoint
   * one. There is no "management" role in MahekOne, and inventing a fifth would
   * mean teaching scope, the console and every switcher about it; admin is who
   * actually holds that seat here.
   */
  "distributor.approve",
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

/* ---------------------------------------------------------------------------
 * A ROLE IS A LEVEL. THE APP IS THE JOB.
 *
 * There used to be four values and they were two ideas in one list: `manager`
 * and `admin` are levels of seniority, `telecaller` and `accounts` were job
 * titles borrowed from two particular apps. So a grant for any THIRD app had
 * no honest word for "ordinary worker" and the Access screen offered the CRM's
 * job title instead — it asked managers to make a field salesman a telecaller,
 * and the seed agreed: mahesh@mahek.in, who has never made a phone call for
 * this company, was stored as one.
 *
 * `telecaller` was already the BASE LEVEL rather than a job. The old `can()`
 * ended with `return !MANAGER_ONLY.has(capability)` — you hold anything not
 * explicitly withheld — which is the definition of an associate and is exactly
 * why a salesman could be given that value and still work correctly.
 *
 * Three levels now, the same three in every app, and the app the grant is held
 * under supplies the job. `app_access` has stored one row per person per app
 * since roles were split off `users.role`, so the pair was always there to be
 * read; only the vocabulary is new.
 * ------------------------------------------------------------------------- */

export type Role = "associate" | "manager" | "admin";

const ROLE_LABELS: Record<Role, string> = {
  associate: "Associate",
  manager: "Manager",
  admin: "Admin",
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

/**
 * A HAT: the level, and the app it is worn in.
 *
 * `app` is null for the account's own role — the fallback a grant with no role
 * of its own resolves to, and what a person carries where no app is named at
 * all (a job, a script, a test). A null-app hat can never carry a capability
 * that belongs to an app, which is the point: holding "manager" on the account
 * is not holding the Accounts desk.
 */
export type Hat = { app: AppId | null; role: Role };

/**
 * Every hat a person wears: one per app they have been granted, plus the
 * account's own. A grant with no role means the account's primary one, which
 * is what every grant meant before roles existed and what `app:grant` writes.
 */
export async function hatsFor(user: {
  id: string;
  role: string;
}): Promise<Hat[]> {
  const rows = await db
    .select({ app: appAccess.app, role: appAccess.role })
    .from(appAccess)
    .where(eq(appAccess.userId, user.id));

  const hats: Hat[] = [{ app: null, role: user.role as Role }];
  for (const r of rows) {
    hats.push({ app: r.app as AppId, role: (r.role ?? user.role) as Role });
  }
  return hats;
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
const ROLE_ORDER: Role[] = ["associate", "manager", "admin"];

/**
 * The narrowest hat first, and an app-specific one before the account's own.
 *
 * A hat naming an app is the more precise answer to "what let this through",
 * so it is preferred where both would do. Within that, level order: an admin
 * holds everything, so asking admin first would stamp "admin" on every action
 * anybody senior took.
 */
function byOrdinariness(a: Hat, b: Hat): number {
  const level = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
  if (level !== 0) return level;
  return (a.app ? 0 : 1) - (b.app ? 0 : 1);
}

export function grantingHat(
  hats: readonly Hat[],
  capability: Capability,
): Hat | null {
  return [...hats].sort(byOrdinariness).find((h) => can(h, capability)) ?? null;
}

/** Holding it under ANY hat is holding it. */
export function canAny(hats: readonly Hat[], capability: Capability): boolean {
  return grantingHat(hats, capability) !== null;
}

/** The union, for a user whose hats have not already been read. */
export async function canFor(
  user: { id: string; role: string },
  capability: Capability,
): Promise<boolean> {
  return canAny(await hatsFor(user), capability);
}

/**
 * THE PRIMARY ROLE IS DERIVED, and it is derived for scope alone.
 *
 * `users.role` decides mine/team/all and is read by thirty-one screens through
 * `isManager`. Rather than teach all of them about a list, it becomes a cache:
 * the widest role somebody holds anywhere. A manager in the CRM sees their
 * team, which is the answer they expect on the day the role is granted.
 *
 * The ordering is by how much a level WIDENS READING, which is the only
 * question this answers. It used to need a fourth entry arguing about where
 * `accounts` sat relative to `telecaller` — neither being senior to the other
 * — and that argument is gone with the job titles: three levels, and each one
 * plainly reads wider than the one below it. The ledger desk's own width is
 * not here at all any more, because it never was a level; it hangs on holding
 * the Accounts app and `scopeForUser` reads it from the hat.
 *
 * IT IS NO LONGER WHAT SCOPE READS. This used to be the whole answer, and the
 * imprecision was named here rather than hidden: an admin in the Admin console
 * was an admin for reading everywhere, the calling book included. `resolveScope`
 * now asks `requestHat` for the hat worn in the app the request is actually
 * in, and only falls back to this where there is no app to ask about — a job, a
 * test, the MBOS API.
 *
 * It stays derived, and it stays the widest, because two things still read it:
 * `isManager` on thirty-one screens deciding whether to DRAW a control, and the
 * fallback above. Both want "is this person a manager anywhere", which is the
 * question this has always answered.
 */
const SCOPE_WIDTH: Role[] = ["associate", "manager", "admin"];

export function widestRole(hats: readonly Hat[]): Role {
  let widest: Role = "associate";
  for (const { role } of hats) {
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

/* ---------------------------------------------------------------------------
 * THE MATRIX, as one table.
 *
 * Every app has the same three levels, and each app says what its own two
 * lower levels carry — `admin` holds everything everywhere and is not listed.
 * The sets above are the vocabulary; this is where they are handed out.
 *
 * THE LEDGER APPS ARE WHY THIS IS PER-APP. `order.approve`, `payment.confirm`,
 * `creditnote.issue` and `customer.reassign` used to hang on a role called
 * `accounts`, which is how they were kept away from managers — "the person
 * chasing a target must not sign off the orders that hit it". With `accounts`
 * gone as a role, the Accounts APP is what carries them, so a CRM manager
 * still cannot approve an order and an Accounts manager can. That is stricter
 * than the old rule rather than looser: an accounts clerk who was also given
 * the CRM used to carry order approval into it.
 *
 * `SHARED` is added to every list at the bottom of this file rather than typed
 * into each one, because a capability every signed-in person holds is not a
 * fact about any one app.
 * ------------------------------------------------------------------------- */

/*
 * The four sets above are the VOCABULARY; the three bundles below are how it
 * is handed out. Derived rather than retyped, because every one of those sets
 * carries the reasoning for why a particular capability sits in it — why
 * approving an order is not a manager's by seniority, why `lead.work` is in
 * none of them, why `sample.approve` had to exist at all — and a hand-typed
 * copy would be a second answer that drifts from the argument that produced
 * it. Tune WHERE a bundle goes in the table below; tune WHAT is in it by
 * moving a capability between the sets, beside the paragraph explaining it.
 */

const restricted = new Set<Capability>([
  ...MANAGER_ONLY,
  ...ACCOUNTS_ONLY,
  ...ACCOUNTS_OR_MANAGER,
  ...ADMIN_ONLY,
  ...SHARED,
]);

/**
 * What anybody who works a book of customers does with it.
 *
 * Everything no set withholds — which is exactly what the old `can()` meant by
 * ending on `return !MANAGER_ONLY.has(capability)`, and is why a field salesman
 * could be stored as a "telecaller" and still work correctly.
 */
const BOOK_WORK: readonly Capability[] = CAPABILITIES.filter(
  (c) => !restricted.has(c),
);

/** What running that book adds, on top of working it. */
const BOOK_MANAGEMENT: readonly Capability[] = [
  ...MANAGER_ONLY,
  ...ACCOUNTS_OR_MANAGER,
];

/**
 * Reading the book from the ledger side.
 *
 * A statement, an outstanding list and an approval queue are all made of
 * customers, so the desk cannot work without this. `payment.record` is not
 * here because it is SHARED — writing down that a customer says they paid is
 * not a privilege, and what separates the levels is whether it is BELIEVED.
 */
const LEDGER_WORK = ["customer.read"] as const satisfies readonly Capability[];

/**
 * The decisions that move money, and the seat that reassigns the accounts the
 * money comes from. Deliberately the Accounts MANAGER's and nobody else's: an
 * associate at that desk records and reads, and somebody senior decides that a
 * payment really arrived.
 */
const LEDGER_DECISIONS: readonly Capability[] = [
  ...ACCOUNTS_ONLY,
  ...ACCOUNTS_OR_MANAGER,
];

type AppMatrix = { associate: readonly Capability[]; manager: readonly Capability[] };

const MATRIX: Record<AppId, AppMatrix> = {
  /* The calling book. */
  crm: { associate: BOOK_WORK, manager: [...BOOK_WORK, ...BOOK_MANAGEMENT] },
  /* MBOS. A salesman works the same book from a handset — this is the grant
     that used to be spelled "telecaller" on a man who has never made a call. */
  field: { associate: BOOK_WORK, manager: [...BOOK_WORK, ...BOOK_MANAGEMENT] },
  /* The Sales Dashboard reads that book and sets targets against it. */
  sales: { associate: BOOK_WORK, manager: [...BOOK_WORK, ...BOOK_MANAGEMENT] },
  /* The desk. An associate records and reads; the manager decides. */
  accounts: { associate: LEDGER_WORK, manager: [...LEDGER_WORK, ...LEDGER_DECISIONS] },
  /* Reading screens. Nothing here writes, so neither level carries a write. */
  reports: { associate: [], manager: ["team.report"] },
  founder: { associate: [], manager: ["team.report"] },
  /* Salaries and home addresses. Reading is the grant; there is no capability
     inside it yet, and inventing one nothing checks would be worse. */
  hrms: { associate: [], manager: [] },
  people: { associate: [], manager: [] },
  /* The console. Its own screens are gated by holding the app; `config.write`
     is what separates reading the settings from changing them. */
  admin: { associate: [], manager: ["config.write"] },
};

/**
 * Whether ONE hat carries a capability.
 *
 * `admin` is answered before the table because it is a level rather than a
 * job: an administrator is an administrator in every app, including one whose
 * row says nothing. A hat with no app carries only what every signed-in person
 * carries — the account's own role is not a grant, and treating it as one is
 * how somebody with a `manager` account but no apps would have quietly held
 * every manager capability in the building.
 */
export function can(hat: Hat, capability: Capability): boolean {
  if (SHARED.has(capability)) return true;
  if (hat.role === "admin") return true;
  if (!hat.app) return false;

  const app = MATRIX[hat.app];
  if (!app) return false;

  const held = hat.role === "manager" ? app.manager : app.associate;
  return held.includes(capability);
}

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
          ? `That is an administrator's action. "${capability}" requires the admin level.`
          : `That is ${found.role === "manager" ? "a manager's" : "an associate's"} action${where}. "${capability}" requires the ${found.role} level${where || " of an app you hold"}.`,
    );
    this.name = "NotPermittedError";
    this.capability = capability;
    this.requiredRole = found?.role ?? "admin";
    this.requiredApp = found?.app ?? null;
  }
}

/** The app's own name, so a refusal reads "in Accounts" and not "in accounts". */
function appLabel(app: AppId): string {
  return getApp(app)?.name ?? app;
}

function requirementFor(capability: Capability): Hat | null {
  for (const role of ["associate", "manager"] as const) {
    const apps = (Object.keys(MATRIX) as AppId[]).filter((app) =>
      can({ app, role }, capability),
    );
    /* One app: name it. Several: the level is the whole of the honest answer. */
    if (apps.length === 1) return { app: apps[0], role };
    if (apps.length > 1) return { app: null, role };
  }
  return { app: null, role: "admin" };
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
  const granting = grantingHat(hats, capability);
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
