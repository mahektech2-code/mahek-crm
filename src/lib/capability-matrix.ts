import { getApp, type AppId } from "./apps";
import type { Role } from "./role-levels";

/* ---------------------------------------------------------------------------
 * THE CAPABILITY MATRIX — what each (app, level) pair may do.
 *
 * PURE AND CLIENT-SAFE, split out of `access-control.ts` for one reason: the
 * Access screen has to SAY what a level carries before anybody grants it, and
 * that screen runs in a browser while `access-control.ts` reads the database.
 * A sentence typed into the screen beside the matrix would be a second answer
 * to "what does an Accounts associate hold", and the copy that drifts is the
 * one somebody reads at the moment they decide. So the screen reads this file,
 * the server reads this file, and there is one table.
 *
 * `access-control.ts` re-exports everything here, so nothing that imported the
 * matrix from there had to change.
 * ------------------------------------------------------------------------- */

/* -------------------------------------------------------------- permissions */

export const CAPABILITIES = [
  "customer.read",
  "customer.write",
  "customer.export",
  "customer.deactivate",
  /** Moving a lead to the trash — a manager's, like deactivating one. */
  "lead.trash",
  /** Listing the trash and bringing a lead back — the Admin Console's, admin only. */
  "lead.restore",
  "call.log",
  "order.capture",
  "reminder.write",
  /*
   * CLOSING a promise by hand, which is a different act from making one.
   *
   * `reminder.write` is everybody's — setting a callback is the ordinary work
   * of the person on the phone. This one is not, and the reason is that a
   * reminder is the only record of what somebody undertook to do: while
   * anybody could press "Mark done", the overdue pile could be cleared in a
   * minute by the one person it was measuring, and no screen could tell a
   * promise kept from a promise tidied away.
   *
   * What closes one now is the EVIDENCE — a call, an order, a confirmed
   * receipt; see `lib/engines/reminder-closure.ts`. This capability is the
   * escape hatch for the cases evidence cannot reach: the customer settled it
   * on WhatsApp, the shop has shut, the promise was written down twice. It
   * covers dismissing as well as completing, because a reason typed into a
   * dismissal clears the pile exactly as effectively as a tick does.
   *
   * Not a role check on the screen. It is in `MANAGER_ONLY`, so it follows the
   * CRM hat somebody was granted on the Access screen, and moving it to
   * `SHARED` or `ACCOUNTS_OR_MANAGER` later is a one-line change here rather
   * than a hunt through components.
   */
  "reminder.close",
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
  /**
   * §11.6 — VALIDATING A GSTIN, which is not the same act as collecting one.
   *
   * The salesman writes the number down standing in the shop and somebody else
   * checks it is a real business we can invoice. It had no capability because
   * it had no action: the qualification checklist carried a `gst_verified`
   * tick, and that tick was writable by anybody holding `lead.work` — which is
   * the salesman. So the collector certified his own collection, and
   * "validated once" was a sentence on a checklist rather than a fact.
   */
  "lead.gstValidate",
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
  /*
   * PRICE LISTS — two capabilities, because reading a price and setting one
   * are different acts by different people.
   *
   * `pricelist.read` is in no set, which is the deliberate meaning of "every
   * associate holds it": a telecaller pricing an order and a salesman standing
   * in a shop both need the customer's list in front of them, and a price they
   * cannot see is a price they guess. `pricelist.manage` — importing, editing,
   * publishing, scoping, duplicating and deciding a special price — is the
   * PRICE DESK's, below, and nobody else's: see `PRICE_DESK` for who that is
   * and why the CRM and Sales managers who held it at first no longer do.
   */
  "pricelist.read",
  "pricelist.manage",
  /**
   * Switching WhatsApp sending through the API on or off, and deciding which
   * approved Wati template each CRM template goes out as. The FOUNDER'S alone —
   * see `FOUNDER_DESK`.
   */
  "whatsapp.activate",
  /**
   * Changing what somebody can reach — apps, levels, modules, powers, a
   * password, a sign-in. The platform administrator's alone; see
   * `requirePlatformAdminUser`.
   */
  "access.manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** §8's matrix, as data. Telecallers get everything not listed here. */
const MANAGER_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "customer.export",
  "reminder.close",
  "customer.deactivate",
  /*
   * Deleting a lead takes it off every screen in the building, so it sits
   * with deactivating one: a manager decides, a telecaller asks. It is not
   * destructive — the trash keeps it whole — but a lead quietly vanishing from
   * somebody's list is the kind of thing that should need a manager.
   */
  "lead.trash",
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
  "access.manage",
  /*
   * The trash is read and emptied back into the book from the Admin Console
   * and nowhere else, so restoring is the administrator's. One person deciding
   * what comes back is what stops a deleted duplicate being restored by
   * whoever deleted the wrong one of the pair.
   */
  "lead.restore",
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
   *
   * `target.shortfall` used to sit here beside it, and that was the mistake of
   * treating one word as one decision. SETTING a number somebody is measured
   * against and READING why this month is behind are not the same act, and
   * only the first is a decision about anybody. See `BOOK_WORK` for where the
   * read went and why.
   */
  "target.set",
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

/*
 * The type and the words live in `lib/role-levels.ts`, which is PURE and
 * client-safe, like this file; `access-control.ts` is `server-only`, and the screens that NAME a
 * level — the Admin Console's app drawer among them — run in a browser. Two
 * copies of three words is still two copies.
 */

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

/*
 * ADMIN ON THE ACCOUNT MEANS PLATFORM ADMINISTRATOR, AND NOTHING ELSE.
 *
 * Until `0197_admin_is_per_app` this was the plain widest level, so an admin of
 * ONE app — HRMS, say, to hand somebody every HRMS power — put `admin` on the
 * account, and twenty-odd checks that read `user.role === "admin"` as "may do
 * anything" (impersonation, the HRMS and ERP administrator bypass, the national
 * sales scope) handed that person the company. `can()` did the same from the
 * other end, answering yes to everything for any admin hat.
 *
 * Admin of an app is now admin OF THAT APP. The account reads `admin` only for
 * whoever holds the Admin Console at the admin level, which is the one grant
 * that means "the platform"; anybody who runs or administers any other app
 * reads `manager`, which is what `isManager` and the no-app scope fallback
 * have always wanted to know. `people` is ignored: the app is retired and its
 * grants open nothing.
 */
export function isPlatformAdminHat(hat: Hat): boolean {
  return hat.app === "admin" && hat.role === "admin";
}

export function widestRole(hats: readonly Hat[]): Role {
  const granted = hats.filter((h) => h.app !== null && h.app !== "people");
  if (granted.some(isPlatformAdminHat)) return "admin";
  if (granted.some((h) => h.role === "manager" || h.role === "admin")) return "manager";
  return "associate";
}

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

/**
 * PAPERWORK CHECKED AT A DESK — GRANTED BY APP, AND DELIBERATELY NOT BY LEVEL.
 *
 * `lead.gstValidate` is the only member, and the set exists for one reason: to
 * make the capability WITHHELD by default. `can()` withholds only what a set
 * names, so a capability in none of them is one EVERYBODY holds — which handed
 * this straight back to the field salesman who collected the number, the one
 * person it must stay away from. Who actually gets it is named on the apps in
 * the table below.
 *
 * WHO, per Mahek: anybody with the Sales Dashboard, the CRM or the Accounts
 * desk — and explicitly NOT split by level. An associate checking a GSTIN is
 * doing the job rather than making a decision above their station, so both
 * levels of each of those three apps carry it. That instruction is why this is
 * not `MANAGER_ONLY` or `ACCOUNTS_OR_MANAGER`: every existing set encodes a
 * seniority rule, and the answer here was that seniority is not the question.
 *
 * Two earlier attempts were both wrong and both caught by
 * `gst-validation-grant.test.ts` rather than by anybody looking.
 * `ACCOUNTS_OR_MANAGER` spread into `BOOK_MANAGEMENT` and so reached every
 * manager of every book app INCLUDING the handset, while still missing the
 * accounts clerk who does this work all day. Removing it from every set made
 * it universal, salesman included.
 *
 * WHAT IS STILL WITHHELD is the handset, and that is the whole control. MBOS
 * is the field salesman's app and it is the one book app absent from the grant
 * below, so the man who typed the number into his phone standing in the shop
 * cannot be the man who certifies it. The second half of that rule lives in
 * `validateGstin`, which refuses the lead's OWNER outright whatever hat he
 * holds — so somebody who works the field and also holds the CRM cannot come
 * in the side door on his own leads.
 */
const DESK_CHECKS: ReadonlySet<Capability> = new Set<Capability>(["lead.gstValidate"]);

/**
 * THE PRICE DESK — who may change what a shop pays. Granted BY APP, like
 * `DESK_CHECKS`, and at both levels of the two apps named in the matrix.
 *
 * It shipped in `ACCOUNTS_OR_MANAGER`, which spread it into `BOOK_MANAGEMENT`
 * and so handed it to every CRM manager and every Sales Dashboard manager.
 * Mahek's instruction was the opposite: a price list is added, changed and
 * deleted by the accounts team or from the founder's desk, and the two apps
 * that QUOTE prices — the telecaller's CRM and the sales manager's dashboard —
 * read them and never write them. The person chasing a number must not also
 * be the person setting the price that number is measured in, which is the
 * same reasoning that keeps `order.approve` off managers.
 *
 * BOTH levels of Accounts, not only the manager: Mahek said "the accounts
 * team", and the lists are typed up at that desk by whoever holds it. Both
 * levels of Founder, because a founder grant is not split by seniority in any
 * way that means something here.
 *
 * The screens enforce the other half by MOUNT: `/crm/price-lists` and
 * `/sales/price-lists` draw no control that writes, even for somebody who
 * holds this capability through Accounts — see `priceListDoorCanManage`.
 */
const PRICE_DESK: ReadonlySet<Capability> = new Set<Capability>(["pricelist.manage"]);

/**
 * WHETHER WHATSAPP LEAVES THE BUILDING THROUGH THE API — the founder's, and
 * nobody else's. Mahek's instruction: a message goes out through Wati only if
 * the founder has switched the service on, and the switch lives on the
 * Founder Dashboard alone.
 *
 * An administrator holds every capability by construction, so the capability
 * by itself would hand the switch to anybody holding the Admin Console. The
 * actions behind it therefore also demand that the hat which granted it is
 * the FOUNDER app's (`requireFounderDesk` in `whatsapp-switch-service.ts`) —
 * an admin who has been given the Founder Dashboard can use it, and an admin
 * who has not cannot reach it through the side door.
 */
const FOUNDER_DESK: ReadonlySet<Capability> = new Set<Capability>(["whatsapp.activate"]);

const restricted = new Set<Capability>([
  ...MANAGER_ONLY,
  ...ACCOUNTS_ONLY,
  ...ACCOUNTS_OR_MANAGER,
  ...ADMIN_ONLY,
  ...SHARED,
  ...DESK_CHECKS,
  ...PRICE_DESK,
  ...FOUNDER_DESK,
]);

/**
 * What anybody who works a book of customers does with it.
 *
 * Everything no set withholds — which is exactly what the old `can()` meant by
 * ending on `return !MANAGER_ONLY.has(capability)`, and is why a field salesman
 * could be stored as a "telecaller" and still work correctly.
 *
 * `target.shortfall` IS ONE OF THEM, and the day it was not is worth writing
 * down. It was bundled with `target.set` on the strength of sharing a word,
 * so a telecaller opening her own Monthly targets screen was handed a null
 * shortfall — which the screen then drew as two empty groups reading "Nobody
 * in this group", beside its own tab saying 58 customers were behind. A
 * permission rendered as data, and the reading it invites is the false one:
 * that there is no shortfall to work.
 *
 * It is a READ, and it is the read that tells somebody which half of a bad
 * month is theirs to fix — a coverage gap is customers she has not rung often
 * enough, which is her own work, and a customer gap is price, stock or terms,
 * which is not. Withholding it left the person who can actually close the gap
 * as the only person unable to see where it is.
 *
 * It needs no scope of its own to be safe. `targetVisibilityClause` already
 * answers this question one layer down: a non-manager sees the accounts
 * assigned to her, on her back-office seat, or reporting to her, and nothing
 * else. The capability decides whether the section is drawn; the clause
 * decides whose customers are in it, and it always has.
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
 *
 * `target.shortfall` is named EXPLICITLY rather than arriving with the rest of
 * `BOOK_WORK`, because the ledger desk does not get `BOOK_WORK`: an accounts
 * associate holds this list and nothing else. Leaving it implicit would have
 * taken the shortfall breakdown off `/accounts/customer-targets` — the same
 * screen, the other door — on the day it was widened for telecallers, which
 * is a regression dressed up as a widening.
 */
const LEDGER_WORK = [
  "customer.read",
  "target.shortfall",
] as const satisfies readonly Capability[];

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

/** What a senior person standing in a shop decides on the handset. */
const FIELD_MANAGEMENT = [
  "lead.verify",
  "lead.override",
  "sample.approve",
  "distributor.terms",
] as const satisfies readonly Capability[];

export type AppMatrix = { associate: readonly Capability[]; manager: readonly Capability[] };

export const MATRIX: Record<AppId, AppMatrix> = {
  /* The calling book. */
  /*
   * §11.6's GST check is handed out BY NAME, at BOTH levels, on the three
   * apps Mahek named — the CRM here, the Sales Dashboard and Accounts below.
   * See `DESK_CHECKS` for why it is not in any of the seniority sets and why
   * the handset is the one book app left out.
   */
  crm: {
    associate: [...BOOK_WORK, "lead.gstValidate"],
    manager: [...BOOK_WORK, ...BOOK_MANAGEMENT, "lead.gstValidate"],
  },
  /* MBOS. A salesman works the same book from a handset — this is the grant
     that used to be spelled "telecaller" on a man who has never made a call. */
  /* A field MANAGER is somebody senior who walks a beat, and the handset is
     all this grant opens. It used to carry the whole of `BOOK_MANAGEMENT` —
     `config.write`, `sheet.import`, `target.set`, bulk WhatsApp — and because
     capabilities are a union over hats, a man holding nothing but the phone
     app could post the console's settings action or run a sheet job. It now
     carries what a senior person decides on a handset in a shop. Running the
     team is the Sales Dashboard's manager grant, a separate decision. */
  field: { associate: BOOK_WORK, manager: [...BOOK_WORK, ...FIELD_MANAGEMENT] },
  /* The Sales Dashboard reads that book and sets targets against it. */
  sales: {
    associate: [...BOOK_WORK, "lead.gstValidate"],
    manager: [...BOOK_WORK, ...BOOK_MANAGEMENT, "lead.gstValidate"],
  },
  /* The desk. An associate records and reads; the manager decides. */
  /* The Price Desk rides here BY NAME at both levels — see `PRICE_DESK`. */
  accounts: {
    associate: [...LEDGER_WORK, "lead.gstValidate", "pricelist.read", "pricelist.manage"],
    manager: [...LEDGER_WORK, ...LEDGER_DECISIONS, "lead.gstValidate", "pricelist.read", "pricelist.manage"],
  },
  /* Reading screens. Nothing here writes, so neither level carries a write —
     with one exception: the founder's desk may add, change and delete a price
     list, which Mahek named explicitly. See `PRICE_DESK`. */
  reports: { associate: [], manager: ["team.report"] },
  /* `pricelist.read` is named too: it arrives with `BOOK_WORK`, which neither
     of these apps is given, so without it the desk that writes the lists
     could not poll a document it had just uploaded. */
  founder: {
    associate: ["pricelist.read", "pricelist.manage", "whatsapp.activate"],
    manager: ["team.report", "pricelist.read", "pricelist.manage", "whatsapp.activate"],
  },
  /* Salaries and home addresses. Reading is the grant; there is no capability
     inside it yet, and inventing one nothing checks would be worse. */
  hrms: { associate: [], manager: [] },
  people: { associate: [], manager: [] },
  enquiries: { associate: [], manager: [] },
  /* The ERP's decisions are POWERS granted to named people (`lib/erp/powers.ts`),
     not capabilities of a level — the CEO who verifies a test is one person,
     not every ERP manager. Holding the app and its modules is what opens the
     screens; the powers are checked by `lib/erp/access.ts`. */
  erp: { associate: [], manager: [] },
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
  /* The platform administrator, from the Admin Console grant or from the
     account (which `widestRole` derives as `admin` for exactly that person). */
  if (hat.role === "admin" && (hat.app === null || hat.app === "admin")) return true;
  if (!hat.app) return false;

  const app = MATRIX[hat.app];
  if (!app) return false;

  /* Admin of any OTHER app holds that app's manager list and nothing beyond
     it. What else an app administrator gets — every HRMS or ERP power, every
     module — each app's own access file decides, inside that app. */
  const held = hat.role === "associate" ? app.associate : app.manager;
  return held.includes(capability);
}

/** The app's own name, so a refusal reads "in Accounts" and not "in accounts". */
export function appLabel(app: AppId): string {
  return getApp(app)?.name ?? app;
}

export function requirementFor(capability: Capability): Hat | null {
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

