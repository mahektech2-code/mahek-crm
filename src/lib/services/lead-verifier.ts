import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { customers } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { canFor, levelInApp, requireCapability, resolveScope } from "@/lib/access-control";

/**
 * WHO MAY VERIFY A LEAD: whoever holds `lead.verify`, OR the Sales Manager the
 * lead is under.
 *
 * Verification is the responsible Sales Manager's act. `lead.verify` is a
 * manager-LEVEL capability, and the Sales Manager on this team holds the CRM at
 * associate level — so a lead raised under her seat was one she could read,
 * search and work and could not verify. Making her a manager would have handed
 * her every other manager capability to fix one button; the seat is the
 * narrower and truer fact.
 *
 * The rule is `lead.sales_manager_id = me` AND the Sales Manager module. It is
 * ADDITIVE: it removes nothing from anybody who holds `lead.verify` today, and
 * it grants nothing on any lead that is not under the seat. The creator never
 * enters into it — a Salesman's lead and a Sales Manager's own lead are
 * verified by the same person, the one whose seat it is. A Salesman holds
 * neither the capability nor the module, so he can still never verify.
 */
export const SALES_MANAGER_MODULE = "crm.sales-manager";

/** Is this person the Sales Manager the lead sits under, and allowed in that workspace? */
export async function holdsLeadSeat(
  user: { id: string },
  salesManagerId: string | null | undefined,
): Promise<boolean> {
  if (!salesManagerId || salesManagerId !== user.id) return false;
  return canOpenModule(user.id, SALES_MANAGER_MODULE);
}

/** The screens' form of the rule — the same one the server enforces below. */
export async function canVerifyLead(
  user: { id: string; role: string },
  salesManagerId: string | null | undefined,
): Promise<boolean> {
  if (await canFor(user, "lead.verify")) return true;
  return holdsLeadSeat(user, salesManagerId);
}

/**
 * The server's form: the same context `requireCapability("lead.verify")` hands
 * back, so every audit row downstream records a hat the same way. Where the
 * person holds the capability that is exactly what is returned. Where they hold
 * only the seat, the hat recorded is the one they actually wear in the CRM —
 * "associate in the CRM verified this" is the true sentence.
 */
export async function requireLeadVerifier(customerId: string) {
  const ctx = await resolveScope();
  if (!(await canFor(ctx.user, "lead.verify"))) {
    const [row] = await db
      .select({ salesManagerId: customers.salesManagerId })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (await holdsLeadSeat(ctx.user, row?.salesManagerId)) {
      const level = (await levelInApp(ctx.user, "crm")) ?? "associate";
      return { ...ctx, authorisedBy: level, authorisedIn: "crm" as const };
    }
    /* Falls through to the capability check so a refusal is audited and worded
       exactly as it always was. */
    return requireCapability("lead.verify");
  }
  return requireCapability("lead.verify");
}

/** The same rule by lead id, for the screens that load the lead separately. */
export async function canVerifyLeadById(
  user: { id: string; role: string },
  customerId: string,
): Promise<boolean> {
  if (await canFor(user, "lead.verify")) return true;
  const [row] = await db
    .select({ salesManagerId: customers.salesManagerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return holdsLeadSeat(user, row?.salesManagerId);
}

/** The seat alone, by lead id. */
export async function holdsLeadSeatById(
  user: { id: string },
  customerId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ salesManagerId: customers.salesManagerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return holdsLeadSeat(user, row?.salesManagerId);
}

/* ---------------------------------------------------------------------------
 * QUALIFICATION: A SALESMAN COLLECTS, THE RESPONSIBLE SALES MANAGER APPROVES.
 *
 * Three rules, each one sentence a person can act on when it refuses:
 *
 *   1. The lead's Sales Manager does not fill in its Qualification. A Sales
 *      Manager raising her own lead names a Salesman as its owner and he
 *      collects the answers; otherwise she would be approving her own work.
 *   2. Whoever owns the lead (and so collected the answers) cannot approve them
 *      or validate the GST number they entered.
 *   3. Where a lead has a Sales Manager, a DIFFERENT Sales Manager does not
 *      become its reviewer just because their level carries `lead.verify`. A
 *      platform administrator is not a "different Sales Manager" and keeps the
 *      reach they have always had, as does a manager who is not seated as a
 *      Sales Manager at all (the global workflow, unchanged).
 * ------------------------------------------------------------------------- */

type LeadSeats = {
  ownerId: string | null;
  salesManagerId: string | null;
  leadStage?: string | null;
};

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

export type ApproverCheck =
  | { ok: true; ctx: Awaited<ReturnType<typeof requireLeadVerifier>> }
  | { ok: false; message: string };

/**
 * Who may APPROVE a lead's Qualification — give the review verdict. The
 * verification rule first (`lead.verify` or the seat), then the three rules
 * above. A refusal for a capability the person never held still throws exactly
 * as it always did; the two ownership refusals come back as sentences.
 */
export async function requireQualificationApprover(customerId: string): Promise<ApproverCheck> {
  const ctx = await requireLeadVerifier(customerId);
  const seats = await seatsOf(customerId);
  if (!seats) return { ok: true, ctx };
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
 * whoever holds `lead.verify`. The lead's owner never.
 */
export async function gstValidatorRefusal(
  user: { id: string; role: string },
  lead: LeadSeats,
): Promise<string | null> {
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
