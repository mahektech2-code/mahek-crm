import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { customers, users } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { canFor, levelInApp, requireCapability, resolveScope } from "@/lib/access-control";
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
  return row ?? null;
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
