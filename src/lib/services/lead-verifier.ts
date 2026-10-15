import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  auditLog,
  customers,
  mbosTasks,
  timelineEvents,
  users,
} from "@/db/schema";
import { chooseVerifierRoute, NO_CREATOR, type CreatorFacts } from "@/lib/engines/lead-verifier-route";
import { ladderFor } from "@/lib/engines/lead-ladder";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { canOpenModule } from "@/lib/access";
import { canAny, canFor, hatsFor, levelInApp, requireCapability, resolveScope } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";

/**
 * WHO MAY VERIFY A LEAD, VALIDATE ITS GST AND REVIEW ITS QUALIFICATION.
 *
 * Whoever holds `lead.verify`; or the Sales Manager the lead is under
 * (`sales_manager_id`, with the Sales Manager module); or — on a lead the Sales
 * Manager raised HERSELF — the one person Mahek designates.
 *
 * The seat exists because `lead.verify` is a manager-LEVEL capability and the
 * Sales Manager on this team holds the CRM at associate level: a lead under her
 * seat was one she could read, search and work and could not verify. Making her
 * a manager would have handed her every other manager capability to fix one
 * button; the seat is the narrower and truer fact.
 *
 * The designated person exists because that same seat would let her approve her
 * own work. A lead she holds the seat on and owns (or that nobody owns) is
 * SELF-RAISED, and where `leads.selfRaisedVerifierEmail` names somebody, the
 * seat holder does not approve it at any step — that person does. She still
 * collects its answers. Unset, or naming nobody active, switches the rule off
 * and everything behaves as it did before it existed.
 *
 * The creator never enters into it: there is no creator column, and a Salesman's
 * lead and a Sales Manager's own lead follow the same rule. A Salesman holds
 * neither the capability nor the module, so he can still never approve.
 */
export const SALES_MANAGER_MODULE = "crm.sales-manager";

export type LeadSeats = {
  /** The lead's id, where the caller has it — the field rule reads who raised it. */
  id?: string;
  ownerId: string | null;
  salesManagerId: string | null;
  leadStage?: string | null;
};

/** Is this person the Sales Manager the lead sits under, and allowed in that workspace? */
export async function holdsLeadSeat(
  user: { id: string },
  salesManagerId: string | null | undefined,
): Promise<boolean> {
  if (!salesManagerId || salesManagerId !== user.id) return false;
  return canOpenModule(user.id, SALES_MANAGER_MODULE);
}

/* ------------------------------------------------- a lead she raised herself */

/**
 * A lead the Sales Manager raised herself: she holds the seat, and she owns it
 * or nobody does. Read off the seats and not off a creator, because the creator
 * is not stored on the lead — and "she is the owner and the seat" is exactly the
 * state in which she would otherwise be approving her own work.
 */
export function isSelfRaised(lead: { ownerId: string | null; salesManagerId: string | null }): boolean {
  return Boolean(lead.salesManagerId) && (lead.ownerId === null || lead.ownerId === lead.salesManagerId);
}

/** The person Mahek designates, by work email — or null where nobody is, or nobody active matches. */
export async function designatedApprover(): Promise<{ id: string; name: string } | null> {
  const email = ((await getConfig())["leads.selfRaisedVerifierEmail"] ?? "").trim().toLowerCase();
  if (!email) return null;
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.active, true)))
    .limit(1);
  return row ?? null;
}

/**
 * The designated approver FOR THIS LEAD: the configured person where the lead is
 * self-raised, otherwise null. Null also where the designated person is the
 * Sales Manager herself — naming her would put the approval straight back where
 * it started.
 */
export async function approverFor(lead: LeadSeats): Promise<{ id: string; name: string } | null> {
  if (!isSelfRaised(lead)) return null;
  const designated = await designatedApprover();
  if (!designated || designated.id === lead.salesManagerId) return null;
  return designated;
}

/* --------------------------------------------- a lead a Telecaller works alone */

const DESK_MODULE = "crm.lead-calling-desk";

/**
 * IS THIS OWNER A CALLING-DESK WORKER - and not a salesman, a manager or a
 * Sales Manager. Asked of the GRANTS, because "a role is a level, the app is
 * the job": a Telecaller and a field salesman are both associates.
 *
 *   - holds the CRM and the Calling desk (`canOpenModule`, which also answers for
 *     an administrator - who is excluded below, so the desk alone proves nothing);
 *   - holds NO `field` grant: a lead a salesman owns is the field's workflow;
 *   - does not hold `lead.verify`: a manager or an administrator is not a desk
 *     worker, whatever they can open;
 *   - has no explicit `crm.sales-manager` module row: that is the Sales Manager.
 *     Explicit, because a whole-CRM grant with no rows "holds" the module without
 *     being one, and reading it as the seat would exclude every Telecaller.
 */
async function ownerWorksTheDesk(ownerId: string): Promise<boolean> {
  const [owner] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner) return false;
  const hats = await hatsFor(owner);
  if (!hats.some((h) => h.app === "crm")) return false;
  if (hats.some((h) => h.app === "field")) return false;
  if (canAny(hats, "lead.verify")) return false;
  const [seat] = await db
    .select({ id: appModuleAccess.id })
    .from(appModuleAccess)
    .where(and(eq(appModuleAccess.userId, ownerId), eq(appModuleAccess.module, SALES_MANAGER_MODULE)))
    .limit(1);
  if (seat) return false;
  return canOpenModule(ownerId, DESK_MODULE);
}

/**
 * A lead a TELECALLER works: owned by a calling-desk worker (or by nobody), and
 * not entered into a workflow that belongs to somebody else.
 *
 * It does NOT read `sales_manager_id` being empty. The nightly org-chart pass
 * (`recomputeSalesManagers`) fills that seat for any lead whose owner is on the
 * chart, so a seat existing says nothing about whether a Sales Manager is
 * involved. What says so is a PERSON having set it - `sales_manager_decided_at`,
 * which only a Sales Manager raising a lead and `assignSalesManager` write.
 *
 * Read off the seats and the owner's grants and never off a creator, which is not
 * stored. The two workflows that belong to others are kept out explicitly:
 *   - a Sales Manager's own lead: the owner is her (explicit module row, so not a
 *     desk worker) and her seat is decided; `isSelfRaised` also routes it first.
 *   - a salesman's lead: the owner holds `field`.
 * Somebody who CHOSE the lead manager made a decision, and a rule that runs by
 * itself does not undo one.
 */
export async function isTelecallerHandled(lead: {
  ownerId: string | null;
  salesManagerDecidedAt?: Date | null;
  leadManagerDecidedAt?: Date | null;
}): Promise<boolean> {
  if (lead.salesManagerDecidedAt) return false;
  if (lead.leadManagerDecidedAt) return false;
  if (!lead.ownerId) return true;
  return ownerWorksTheDesk(lead.ownerId);
}

/**
 * The person Mahek designates to verify what a Telecaller converts, by work
 * email - null where nothing is configured, or nobody ACTIVE matches.
 *
 * Its own setting, `leads.telecallerVerifierEmail`, and not
 * `leads.selfRaisedVerifierEmail`: that one is the approver of a lead a Sales
 * Manager raised herself, this one is the verifier of a lead a Telecaller works,
 * and they are different jobs that happen to be held by one person today.
 */
export async function telecallerApprover(): Promise<{ id: string; name: string; role: string } | null> {
  const email = ((await getConfig())["leads.telecallerVerifierEmail"] ?? "").trim().toLowerCase();
  if (!email) return null;
  const [row] = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, eq(users.active, true)))
    .limit(1);
  return row ?? null;
}

export type TelecallerRoute =
  | { kind: "off" }
  | { kind: "verifier"; id: string; name: string }
  | { kind: "refuse"; message: string };

/**
 * HOW THIS LEAD'S VERIFICATION IS ROUTED when a Telecaller converts it.
 *
 *   off       nothing configured, or not a Telecaller's lead: the ordinary routing
 *             answers, exactly as it did before this existed.
 *   verifier  the designated person. STRICT: it wins over an org-chart-derived
 *             Sales Manager seat and there is no regional coverage requirement.
 *   refuse    a Telecaller's lead WITH a setting that cannot be honoured - the
 *             named person is missing, inactive, cannot verify, or is the person
 *             converting. Refused in words and the lead stays a Suspect: quietly
 *             routing it elsewhere would defeat the one thing the setting says.
 */
export async function telecallerRouteFor(
  lead: { ownerId: string | null; salesManagerDecidedAt?: Date | null; leadManagerDecidedAt?: Date | null },
  converterId: string,
): Promise<TelecallerRoute> {
  const configured = ((await getConfig())["leads.telecallerVerifierEmail"] ?? "").trim();
  if (!configured) return { kind: "off" };
  if (!(await isTelecallerHandled(lead))) return { kind: "off" };

  const designated = await telecallerApprover();
  if (!designated) {
    return {
      kind: "refuse",
      message: `Nobody can verify this lead yet: the person set to verify leads a Telecaller converts (${configured}) has no active account. Ask an administrator to correct that setting - the lead stays a Suspect until then.`,
    };
  }
  if (designated.id === converterId) {
    return {
      kind: "refuse",
      message:
        "You are the person who verifies leads a Telecaller converts, so you cannot also convert this one. Ask another desk worker to convert it.",
    };
  }
  if (!(await canFor({ id: designated.id, role: designated.role }, "lead.verify"))) {
    return {
      kind: "refuse",
      message: `Nobody can verify this lead yet: ${designated.name}, who is set to verify leads a Telecaller converts, does not hold the verification permission. Ask an administrator to fix that - the lead stays a Suspect until then.`,
    };
  }
  return { kind: "verifier", id: designated.id, name: designated.name };
}

/** `NotPermittedError`'s name, so `fromThrown` answers `not_permitted`, with a sentence of our own. */
class ApprovalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPermittedError";
  }
}

async function seatsOf(customerId: string): Promise<LeadSeats | null> {
  const [row] = await db
    .select({
      ownerId: customers.ownerId,
      salesManagerId: customers.salesManagerId,
      leadStage: customers.leadStage,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return row ? { id: customerId, ...row } : null;
}

type ApprovalRoute = "capability" | "seat" | "designated";

/**
 * HOW this person may approve this lead — or null where they may not.
 *
 * The designated person always may. Where the lead is self-raised and somebody
 * is designated, the seat holder may NOT, whatever else she holds: that is the
 * rule. Everybody else is judged exactly as before — the capability, then the
 * seat.
 */
async function approvalRoute(
  user: { id: string; role: string },
  seats: LeadSeats | null,
): Promise<ApprovalRoute | null> {
  const designated = seats ? await approverFor(seats) : null;
  if (designated) {
    if (designated.id === user.id) return "designated";
    if (seats!.salesManagerId === user.id && user.role !== "admin") return null;
  }
  /* THE FIELD VERIFIER DOES NOT VERIFY A LEAD SHE RAISED, by the seat or by a
     capability she may also hold. An administrator keeps the reach they have
     always had. Costs one cached config read while the rule is off. */
  if (seats?.id && user.role !== "admin" && (await raisedByFieldVerifier(user.id, seats.id))) return null;
  if (await canFor(user, "lead.verify")) return "capability";
  if (seats && (await holdsLeadSeat(user, seats.salesManagerId))) return "seat";
  return null;
}

/**
 * The server's form: the same context `requireCapability("lead.verify")` hands
 * back, so every audit row downstream records a hat the same way. Where the
 * person holds the capability that is exactly what is returned. Where they hold
 * only the seat, or are the designated approver, the hat recorded is the one
 * they actually wear in the CRM — "associate in the CRM verified this" is the
 * true sentence.
 */
export async function requireLeadVerifier(customerId: string) {
  const ctx = await resolveScope();
  const seats = await seatsOf(customerId);
  const route = await approvalRoute(ctx.user, seats);

  if (route === "capability") return requireCapability("lead.verify");
  if (route === "seat" || route === "designated") {
    const level = (await levelInApp(ctx.user, "crm")) ?? "associate";
    return { ...ctx, authorisedBy: level, authorisedIn: "crm" as const };
  }

  if (seats?.id && ctx.user.role !== "admin" && (await raisedByFieldVerifier(ctx.user.id, seats.id))) {
    const desk = await deskApprover();
    throw new ApprovalRefused(
      `You raised this lead yourself, so ${desk?.name ?? "the person set to verify leads a Telecaller converts"} verifies it. You collect the answers.`,
    );
  }
  const designated = seats ? await approverFor(seats) : null;
  if (designated && seats?.salesManagerId === ctx.user.id) {
    throw new ApprovalRefused(
      `You raised this lead yourself, so ${designated.name} verifies it, validates its GST number and reviews its Qualification. You collect the answers.`,
    );
  }
  /* Falls through to the capability check so a refusal is audited and worded
     exactly as it always was. */
  return requireCapability("lead.verify");
}

/** The screens' form of the rule, by lead id — the same one the server enforces. */
export async function canVerifyLeadById(
  user: { id: string; role: string },
  customerId: string,
): Promise<boolean> {
  return (await approvalRoute(user, await seatsOf(customerId))) !== null;
}

/** Who approves this lead on the Sales Manager's behalf, by name, for a screen to say so. */
export async function approverNameFor(customerId: string): Promise<string | null> {
  const seats = await seatsOf(customerId);
  return seats ? ((await approverFor(seats))?.name ?? null) : null;
}

/* ---------------------------------------------------------------------------
 * QUALIFICATION: A COLLECTOR COLLECTS, AN APPROVER APPROVES.
 *
 * Three rules, each one sentence a person can act on when it refuses:
 *
 *   1. The lead's Sales Manager does not fill in its Qualification — unless the
 *      lead is self-raised and somebody is designated to approve it, in which
 *      case she collects and they approve.
 *   2. Whoever owns the lead (and so collected the answers) cannot approve them
 *      or validate the GST number they entered.
 *   3. Where a lead has a Sales Manager, a DIFFERENT Sales Manager does not
 *      become its reviewer just because their level carries `lead.verify`. A
 *      platform administrator is not a "different Sales Manager" and keeps the
 *      reach they have always had, as does a manager who is not seated as a
 *      Sales Manager at all (the global workflow, unchanged). The designated
 *      approver is the lead's approver, not a "different" one.
 * ------------------------------------------------------------------------- */

/** Qualification is being worked at these rungs; see `qualificationAccess`. */
const WORKING_RUNGS = ["qualification", "qualified"];

/**
 * Null where this person may write the lead's Qualification answers, otherwise
 * the sentence to refuse with. Only the lead's own Sales Manager is refused —
 * the Salesman who owns it, and any other writer the existing scope allows,
 * are untouched — and only while Qualification is the live job.
 */
export async function qualificationCollectorRefusal(
  user: { id: string; role: string },
  lead: LeadSeats,
): Promise<string | null> {
  if (!lead.leadStage || !WORKING_RUNGS.includes(lead.leadStage)) return null;
  if (user.role === "admin") return null;
  if (!(await holdsLeadSeat(user, lead.salesManagerId))) return null;
  /* Her own lead, with somebody else to approve it: she collects it. */
  if (await approverFor(lead)) return null;
  return "The Salesman who owns this lead completes its Qualification, and you review it. If nobody owns it yet, name a Salesman as its owner first.";
}

/** Whether `user` is a Sales Manager seated on some OTHER lead's seat, and not an administrator. */
async function isOtherSalesManager(
  user: { id: string; role: string },
  lead: LeadSeats,
): Promise<boolean> {
  if (!lead.salesManagerId || lead.salesManagerId === user.id) return false;
  if (user.role === "admin") return false;
  return canOpenModule(user.id, SALES_MANAGER_MODULE);
}

export type ApproverCheck =
  | { ok: true; ctx: Awaited<ReturnType<typeof requireLeadVerifier>> }
  | { ok: false; message: string };

/**
 * Who may APPROVE a lead's Qualification — give the review verdict. The
 * verification rule first, then the rules above. A refusal for a capability the
 * person never held still throws exactly as it always did; the ownership
 * refusals come back as sentences.
 */
export async function requireQualificationApprover(customerId: string): Promise<ApproverCheck> {
  const ctx = await requireLeadVerifier(customerId);
  const seats = await seatsOf(customerId);
  if (!seats) return { ok: true, ctx };
  const designated = await approverFor(seats);
  if (designated && designated.id === ctx.user.id) return { ok: true, ctx };
  if (seats.ownerId && seats.ownerId === ctx.user.id) {
    return {
      ok: false,
      message:
        "You own this lead, so you collected its Qualification and cannot approve it. The Salesman who owns a lead collects; its Sales Manager reviews.",
    };
  }
  if (await isOtherSalesManager(ctx.user, seats)) {
    return {
      ok: false,
      message: "This lead is under a different Sales Manager. Only its own Sales Manager reviews its Qualification.",
    };
  }
  return { ok: true, ctx };
}

/**
 * Null where this person may validate (or refuse) the GST number on a lead,
 * otherwise the sentence to refuse with. The responsible Sales Manager only:
 * the seat holder, an administrator, and — where nobody holds the seat at all —
 * whoever holds `lead.verify`. The lead's owner never. On a self-raised lead
 * with a designated approver, that person and an administrator only.
 */
export async function gstValidatorRefusal(
  user: { id: string; role: string },
  lead: LeadSeats,
): Promise<string | null> {
  const designated = await approverFor(lead);
  if (designated) {
    if (designated.id === user.id || user.role === "admin") return null;
    return `You raised this lead yourself, so ${designated.name} validates its GST number.`;
  }
  if (lead.ownerId && lead.ownerId === user.id) {
    return "You own this lead, so you entered its GST number and cannot validate it. Its Sales Manager does that when reviewing.";
  }
  if (user.role === "admin") return null;
  if (await holdsLeadSeat(user, lead.salesManagerId)) return null;
  if (!lead.salesManagerId && (await canFor(user, "lead.verify"))) return null;
  return lead.salesManagerId
    ? "Only this lead's own Sales Manager validates its GST number."
    : "This lead has no Sales Manager yet. Ask for one to be named; they validate its GST number.";
}

/** The screens' form of `gstValidatorRefusal`: may this person validate GST on this lead? */
export async function canValidateGstById(
  user: { id: string; role: string },
  customerId: string,
): Promise<boolean> {
  const seats = await seatsOf(customerId);
  if (!seats) return false;
  return (await gstValidatorRefusal(user, seats)) === null;
}

/** The screens' form of `qualificationCollectorRefusal`: the sentence, or null where they may write. */
export async function qualificationCollectorRefusalById(
  user: { id: string; role: string },
  customerId: string,
): Promise<string | null> {
  const seats = await seatsOf(customerId);
  if (!seats) return null;
  return qualificationCollectorRefusal(user, seats);
}

/* ===========================================================================
 * THE FIELD VERIFIER — a lead a Salesman raised, or a Salesman now holds.
 *
 * Added on top of the two designations above and touching neither: a lead a
 * Telecaller works is still `leads.telecallerVerifierEmail`'s, and a Sales
 * Manager's own lead is still `leads.selfRaisedVerifierEmail`'s. What this adds is
 * the third person, `leads.fieldVerifierEmail`, and the precedence between them
 * (see `engines/lead-verifier-route.ts`): current Salesman assignment overrides
 * the creator, the field verifier's own lead is never hers, and an unknown
 * creator falls back to the desk verifier.
 *
 * IT USES THE SEAT THIS PRODUCT ALREADY HAS. Routing a lead to the field
 * verifier means she is its Sales Manager (`customers.sales_manager_id`), filled
 * the way the org chart fills it — so the seat-based permission
 * (`holdsLeadSeat` + the `crm.sales-manager` module), the Sales Manager
 * workspace, the verification queue, scope and notifications all reach it with
 * no second rule, and nobody's app level is raised.
 *
 * AND IT NEVER TOUCHES FOLLOW-UP OWNERSHIP. `owner_id` is who works the lead.
 * Nothing in here writes it; the seat, the verification call and the next action
 * are the verifier's, and the owner stays exactly who it was.
 *
 * Blank `leads.fieldVerifierEmail` switches all of it off: routing is exactly as
 * it was.
 * ========================================================================= */

export const FIELD_VERIFIER_KEY = "leads.fieldVerifierEmail" as const;

export type Reader = Pick<typeof db, "select">;
export type Writer = Pick<typeof db, "select" | "insert" | "update">;

type Person = { id: string; name: string; role: string };

async function activeUserByEmail(email: string, exec: Reader = db): Promise<Person | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  const [row] = await exec
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${wanted}`, eq(users.active, true)))
    .limit(1);
  return row ?? null;
}

async function configuredEmail(key: "leads.fieldVerifierEmail" | "leads.telecallerVerifierEmail" | "leads.selfRaisedVerifierEmail") {
  return (((await getConfig())[key] as string | undefined) ?? "").trim();
}

/** The field verifier, by work email — null where nothing is set or nobody ACTIVE matches. */
export async function fieldApprover(exec: Reader = db): Promise<Person | null> {
  return activeUserByEmail(await configuredEmail(FIELD_VERIFIER_KEY), exec);
}

/** The desk verifier: the Telecaller verifier, else the self-raised approver. */
export async function deskApprover(exec: Reader = db): Promise<Person | null> {
  const telecaller = await activeUserByEmail(await configuredEmail("leads.telecallerVerifierEmail"), exec);
  if (telecaller) return telecaller;
  return activeUserByEmail(await configuredEmail("leads.selfRaisedVerifierEmail"), exec);
}

/** Is the whole rule switched on? Blank means everything is exactly as it was. */
export async function fieldRoutingOn(): Promise<boolean> {
  return Boolean(await configuredEmail(FIELD_VERIFIER_KEY));
}

/* --------------------------------------------------- what was written at raising */

/** Who raised one lead, from the append-only `lead_created` event and the level the handset held. */
export async function creatorFactsFor(customerId: string, exec: Reader = db): Promise<CreatorFacts> {
  return (await creatorFactsForMany([customerId], exec)).get(customerId) ?? NO_CREATOR;
}

/** The same for many leads in two queries — for the nightly pass and a bulk move. */
export async function creatorFactsForMany(
  customerIds: string[],
  exec: Reader = db,
): Promise<Map<string, CreatorFacts>> {
  const out = new Map<string, CreatorFacts>();
  const ids = [...new Set(customerIds)];
  if (!ids.length) return out;

  const events = await exec
    .select({
      customerId: timelineEvents.customerId,
      actorUserId: timelineEvents.actorUserId,
      sourceApp: timelineEvents.sourceApp,
    })
    .from(timelineEvents)
    .where(and(inArray(timelineEvents.customerId, ids), eq(timelineEvents.eventType, MBOS_EVENT.leadCreated)))
    .orderBy(asc(timelineEvents.occurredAt), asc(timelineEvents.createdAt));
  for (const e of events) {
    if (!out.has(e.customerId)) {
      out.set(e.customerId, { actorUserId: e.actorUserId, eventSourceApp: e.sourceApp, capturedAsRole: null });
    }
  }

  const handset = [...out.entries()].filter(([, f]) => f.eventSourceApp === "mbos").map(([id]) => id);
  if (handset.length) {
    const audits = await exec
      .select({ entityId: auditLog.entityId, role: auditLog.actorRole })
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.entityId, handset),
          eq(auditLog.entityType, "customer"),
          eq(auditLog.action, "lead.captured"),
          eq(auditLog.actorApp, "field"),
        ),
      )
      .orderBy(asc(auditLog.at));
    const seen = new Set<string>();
    for (const a of audits) {
      if (!a.entityId || seen.has(a.entityId)) continue;
      seen.add(a.entityId);
      const f = out.get(a.entityId);
      if (f) f.capturedAsRole = a.role ?? null;
    }
  }
  return out;
}

/**
 * WHICH OF THESE OWNERS IS A SALESMAN: holds the Salesman App at the associate
 * level — the people a lead is put on a handset for. A manager who also holds
 * the field app coordinates and does not walk the beat. Whether the account is
 * still open is not asked: a Salesman whose account closed left the lead
 * assigned to a Salesman, and changing its verifier on that would be a change
 * nobody made.
 */
export async function salesmenAmong(userIds: string[], exec: Reader = db): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const rows = await exec
    .select({ userId: appAccess.userId })
    .from(appAccess)
    .where(and(inArray(appAccess.userId, ids), eq(appAccess.app, "field"), eq(appAccess.role, "associate")));
  return new Set(rows.map((r) => r.userId));
}

/* ------------------------------------------------------------ the route itself */

export type FieldRoute =
  /** Not configured, or nothing to add: every existing step answers exactly as before. */
  | { kind: "off" }
  /** A lead the desk steps handle (Telecaller's, Sales Manager's own): nothing new to say. */
  | { kind: "desk" }
  /** A named verifier that WINS over every step below it. */
  | { kind: "verifier"; id: string; name: string; reason: "assigned" | "salesman_created" | "own_lead" }
  /** The creator is unknown: the desk verifier, but only once no seat has answered. */
  | { kind: "fallback"; id: string; name: string }
  /** Configured but unusable — said in words, never quietly routed elsewhere. */
  | { kind: "refuse"; message: string };

/** Can this person actually verify: the capability, or the seat + module the Sales Manager holds. */
async function canActAsVerifier(p: Person): Promise<boolean> {
  if (await canFor({ id: p.id, role: p.role }, "lead.verify")) return true;
  return canOpenModule(p.id, SALES_MANAGER_MODULE);
}

/**
 * HOW THIS LEAD'S VERIFICATION IS ROUTED by the field rule.
 *
 * `lead` is `{ id, ownerId }` and the OWNER is read from the argument, so a caller
 * that is about to write a new owner can ask about the lead as it WILL be.
 */
export async function fieldRouteFor(
  lead: { id: string; ownerId: string | null },
  converterId?: string,
  exec: Reader = db,
): Promise<FieldRoute> {
  const email = await configuredEmail(FIELD_VERIFIER_KEY);
  if (!email) return { kind: "off" };

  const field = await activeUserByEmail(email, exec);
  const creator = await creatorFactsFor(lead.id, exec);
  const assigned = lead.ownerId ? (await salesmenAmong([lead.ownerId], exec)).has(lead.ownerId) : false;
  const r = chooseVerifierRoute({ creator, assignedToSalesman: assigned, fieldVerifierId: field?.id ?? null });

  if (r.route === "field") {
    if (!field) {
      return {
        kind: "refuse",
        message: `Nobody can verify this lead yet: the person set to verify leads a Salesman raised or holds (${email}) has no active account. Ask an administrator to correct that setting - the lead stays where it is until then.`,
      };
    }
    if (converterId && field.id === converterId) {
      return {
        kind: "refuse",
        message:
          "You are the person who verifies leads a Salesman raised or holds, so you cannot also convert this one. Ask somebody else to convert it.",
      };
    }
    if (!(await canActAsVerifier(field))) {
      return {
        kind: "refuse",
        message: `Nobody can verify this lead yet: ${field.name}, who is set to verify leads a Salesman raised or holds, has neither the verification permission nor the Sales Manager seat. Ask an administrator to fix that - the lead stays where it is until then.`,
      };
    }
    return {
      kind: "verifier",
      id: field.id,
      name: field.name,
      reason: r.viaAssignment ? "assigned" : "salesman_created",
    };
  }

  /* The desk route. Only two cases need an answer from here: the field verifier's
     own lead (which the self-raised step below would miss once a Salesman holds
     it), and an unknown creator (the fallback). Anything else is the existing
     steps' to answer. */
  if (!r.creatorIsFieldVerifier && !r.fallback) return { kind: "desk" };

  const desk = await deskApprover(exec);
  if (!desk) {
    /* Nothing is designated for the desk: with no fallback configured an unknown
       creator behaves exactly as it did, and the own-lead case has nobody else. */
    return r.creatorIsFieldVerifier
      ? {
          kind: "refuse",
          message:
            "You raised this lead yourself, so you cannot verify it, and nobody is set to verify leads a Telecaller converts or a Sales Manager raised. Ask an administrator to set one.",
        }
      : { kind: "off" };
  }
  if (converterId && desk.id === converterId) {
    return {
      kind: "refuse",
      message: "You are the person who verifies this lead, so you cannot also convert it. Ask another desk worker to convert it.",
    };
  }
  if (!(await canFor({ id: desk.id, role: desk.role }, "lead.verify"))) {
    return {
      kind: "refuse",
      message: `Nobody can verify this lead yet: ${desk.name}, who is set to verify leads whose creator is not known, does not hold the verification permission. Ask an administrator to fix that - the lead stays where it is until then.`,
    };
  }
  return r.creatorIsFieldVerifier
    ? { kind: "verifier", id: desk.id, name: desk.name, reason: "own_lead" }
    : { kind: "fallback", id: desk.id, name: desk.name };
}

/**
 * THE FIELD VERIFIER'S SEAT, for many leads at once — which of them she is the
 * Sales Manager of. Used by the nightly org-chart pass and by a bulk move, so the
 * seat the pass would write and the seat a move writes cannot disagree. Empty
 * where the rule is off or nobody active is named.
 */
export async function fieldSeatFor(
  leads: Array<{ id: string; ownerId: string | null }>,
  exec: Reader = db,
): Promise<{ approverId: string | null; seated: Set<string> }> {
  const seated = new Set<string>();
  if (!leads.length || !(await fieldRoutingOn())) return { approverId: null, seated };
  const field = await fieldApprover(exec);
  if (!field) return { approverId: null, seated };

  const creators = await creatorFactsForMany(leads.map((l) => l.id), exec);
  const salesmen = await salesmenAmong(leads.map((l) => l.ownerId ?? ""), exec);
  for (const l of leads) {
    const r = chooseVerifierRoute({
      creator: creators.get(l.id) ?? NO_CREATOR,
      assignedToSalesman: Boolean(l.ownerId && salesmen.has(l.ownerId)),
      fieldVerifierId: field.id,
    });
    if (r.route === "field") seated.add(l.id);
  }
  return { approverId: field.id, seated };
}

/** The lead's seats and creator, for the permission check: is this the field verifier's own lead? */
export async function raisedByFieldVerifier(userId: string, customerId: string): Promise<boolean> {
  if (!(await fieldRoutingOn())) return false;
  const field = await fieldApprover();
  if (!field || field.id !== userId) return false;
  const creator = await creatorFactsFor(customerId);
  return creator.actorUserId === userId;
}

/* ---------------------------------------------- the seat follows an owner change */

export type RealignOutcome = {
  /** Leads whose Sales Manager seat, verification seat, next action or open call moved. */
  moved: string[];
  /** The verifier cannot be used, so the seat was LEFT and nobody else was seated. */
  blocked: { id: string; name: string; message: string }[];
};

const LADDER_OWES_VERIFICATION = (stage: string | null, salesType: string | null): boolean => {
  if (!stage) return false;
  const ladder = ladderFor(salesType as never) as readonly string[];
  const q = ladder.indexOf("qualification");
  const at = ladder.indexOf(stage);
  return q !== -1 && at !== -1 && at < q;
};

/**
 * AN UNVERIFIED LEAD'S VERIFIER CAN CHANGE UNDER IT — it is given to a Salesman,
 * or taken off one — and what follows has to move with it in the SAME COMMIT, or
 * the verification call sits on the list of somebody who can no longer make it:
 *
 *   • the Sales Manager seat (`sales_manager_id`), where nobody DECIDED it —
 *     the field verifier's while a Salesman holds it, the org chart's otherwise;
 *   • the coordinating seat (`lead_manager_id`) where a designation put it there,
 *     the verification next action beside it, and the open validation call.
 *
 * Called by every writer of `owner_id` on a lead INSIDE its transaction (`{ tx }`),
 * so a failure here rolls the owner change back with it. It never opens a nested
 * transaction and it never writes `owner_id`.
 *
 * What it does not do: override a seat a PERSON decided, move a seat that is not
 * one of the designated verifiers', touch a verified lead, or seat anybody
 * where there was no seat. A verifier who cannot be used is returned in
 * `blocked` and nobody else is seated in their place.
 */
export async function realignVerifierSeats(
  customerIds: string[],
  actorId: string,
  hat: { app: string | null; role: string } | null,
  opts: { tx: Writer },
): Promise<RealignOutcome> {
  const out: RealignOutcome = { moved: [], blocked: [] };
  const ids = [...new Set(customerIds)];
  if (!ids.length || !(await fieldRoutingOn())) return out;
  const exec = opts.tx;

  const rows = await exec
    .select({
      id: customers.id,
      name: customers.name,
      ownerId: customers.ownerId,
      stage: customers.leadStage,
      salesType: customers.leadSalesType,
      salesManagerId: customers.salesManagerId,
      salesManagerDecidedAt: customers.salesManagerDecidedAt,
      leadManagerId: customers.leadManagerId,
      leadManagerDecidedAt: customers.leadManagerDecidedAt,
      nextOwner: customers.leadNextActionOwnerId,
      requestState: customers.prospectRequestState,
    })
    .from(customers)
    .where(and(inArray(customers.id, ids), eq(customers.kind, "lead"), isNull(customers.leadVerifiedAt)));
  if (!rows.length) return out;

  const field = await fieldApprover(exec);
  const desk = await deskApprover(exec);
  const designees = new Set([field?.id, desk?.id].filter((v): v is string => Boolean(v)));
  const { seated: fieldSeated, approverId } = await fieldSeatFor(
    rows.map((r) => ({ id: r.id, ownerId: r.ownerId })),
    exec,
  );
  const { salesManagerForOwner } = await import("../recompute");

  for (const lead of rows) {
    let changed = false;

    /* 1. THE SALES MANAGER SEAT, where nobody decided it. */
    if (!lead.salesManagerDecidedAt) {
      let want: { id: string | null; personName: string | null } | null = null;
      if (approverId && fieldSeated.has(lead.id)) want = { id: approverId, personName: null };
      else if (approverId && lead.salesManagerId === approverId) {
        /* Taken off a Salesman: back to whatever the org chart says, which is
           what the nightly pass would write. */
        want = lead.ownerId ? await salesManagerForOwner(lead.ownerId) : { id: null, personName: null };
        want ??= { id: null, personName: null };
      }
      if (want && want.id !== lead.salesManagerId) {
        await exec
          .update(customers)
          .set({ salesManagerId: want.id, salesManagerPersonName: want.personName, updatedAt: new Date() })
          .where(eq(customers.id, lead.id));
        changed = true;
      }
    }

    /* 2. THE COORDINATING SEAT, the next action and the open call — only where a
       designation put them there, and only while verification is still owed. */
    const owed =
      LADDER_OWES_VERIFICATION(lead.stage, lead.salesType) ||
      lead.requestState === "awaiting" ||
      lead.requestState === "followup";
    if (owed && lead.leadManagerId && !lead.leadManagerDecidedAt && designees.has(lead.leadManagerId)) {
      const route = await fieldRouteFor({ id: lead.id, ownerId: lead.ownerId }, undefined, exec);
      let target: string | null = null;
      if (route.kind === "verifier" || route.kind === "fallback") target = route.id;
      else if (route.kind === "desk") {
        const self = await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId });
        target = self?.id ?? desk?.id ?? null;
      } else if (route.kind === "refuse") {
        out.blocked.push({ id: lead.id, name: lead.name, message: route.message });
      }

      if (target && target !== lead.leadManagerId) {
        await exec
          .update(customers)
          .set({
            leadManagerId: target,
            /* The verification call is the seat holder's while verification is
               owed — that is what a next action owed by them IS here, whether it
               was asked for as a request or set by a direct conversion. Where it is
               owed by somebody else (the desk's own follow-up) it stays. */
            ...(lead.nextOwner === lead.leadManagerId ? { leadNextActionOwnerId: target } : {}),
            updatedAt: new Date(),
          })
          .where(eq(customers.id, lead.id));
        await exec
          .update(mbosTasks)
          .set({ assignedToUserId: target, updatedAt: new Date() })
          .where(
            and(
              eq(mbosTasks.customerId, lead.id),
              eq(mbosTasks.sourceType, "lead_validation"),
              eq(mbosTasks.status, "open"),
              eq(mbosTasks.assignedToUserId, lead.leadManagerId),
            ),
          );
        changed = true;
        await writeTimelineEvent(exec as never, {
          customerId: lead.id,
          eventType: MBOS_EVENT.leadAssigned,
          sourceApp: "crm",
          sourceRecordId: `${lead.id}:verifier:${target}`,
          occurredAt: new Date(),
          actorUserId: actorId,
          summary: "The lead's verification moved to its designated verifier",
        });
        await exec.insert(auditLog).values({
          id: `aud_${randomUUID().slice(0, 12)}`,
          actorId,
          action: "lead.verifier.align",
          entityType: "customer",
          entityId: lead.id,
          actorRole: (hat?.role as "associate" | "manager" | "admin" | undefined) ?? null,
          actorApp: (hat?.app as never) ?? null,
          beforeState: { leadManagerId: lead.leadManagerId },
          afterState: { leadManagerId: target, via: "reassignment" },
        });
      }
    }

    if (changed) out.moved.push(lead.id);
  }
  return out;
}

/** One sentence for what a realignment left undone, to append to what the caller is about to say. */
export function realignNotice(out: Pick<RealignOutcome, "blocked">): string | null {
  if (!out.blocked.length) return null;
  const parts = out.blocked.slice(0, 3).map((b) => `${b.name} — ${b.message}`);
  const head =
    out.blocked.length === 1
      ? "Its verification seat was not moved:"
      : `${out.blocked.length} leads' verification seats were not moved:`;
  return `${head} ${parts.join("; ")}${out.blocked.length > 3 ? ` and ${out.blocked.length - 3} more` : ""}`;
}
