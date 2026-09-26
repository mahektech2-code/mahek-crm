import "server-only";
import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, mbosLeadValidations } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { notifyUser } from "@/lib/notify";
import { today } from "@/lib/recompute";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { advanceLeadStage } from "@/lib/actions/leads";
import { leadRow } from "./lead-service";

/* ---------------------------------------------------------------------------
 * The sales manager's half of a calling-desk request: what a verification call
 * does to the request it was about.
 *
 * A SERVICE AND NOT AN ACTION, deliberately. It is called from
 * `recordLeadValidationCall` and by nothing else, and a function in a
 * `"use server"` file is a URL anybody can post to. This one takes a lead and
 * an outcome and would otherwise be a door for saying "verified" about a lead
 * nobody had verified — so it lives where nothing can post to it, and asks for
 * `lead.verify` and the lead's own state itself anyway.
 *
 * It reads `advanceLeadStage` from the actions file, and that file loads this
 * one lazily for the same reason: a static import each way would be a cycle.
 * ------------------------------------------------------------------------- */

/** The request columns, which `leadRow` does not carry. */
export async function requestOf(customerId: string) {
  const [r] = await db
    .select({
      state: customers.prospectRequestState,
      at: customers.prospectRequestedAt,
      byId: customers.prospectRequestedById,
      reason: customers.prospectRequestReason,
      note: customers.prospectRequestNote,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return r;
}

function refresh(customerId: string) {
  try {
    revalidatePath("/crm/leads/calling-desk");
    revalidatePath(`/crm/leads/calling-desk/${customerId}`);
    revalidatePath(`/crm/leads/${customerId}/verify`);
    revalidatePath("/crm/leads/qualify/verification");
    revalidatePath("/sales/leads");
    revalidatePath(`/sales/leads/${customerId}`);
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/**
 * After a verification call, settle the desk's request that it was about.
 *
 * It takes no identity and no verdict on trust: it asks for `lead.verify`
 * itself, reads the lead's own pending state, and checks the LATEST verification
 * row on the record says what the caller claims — so it cannot be used to
 * promote a lead nobody has verified.
 *
 *   verified   the lead goes to Prospect through `advanceLeadStage`, the same
 *              gated move, under the manager's own hat and with the desk's
 *              reason. The request state clears, and the manager holds the seat.
 *   follow_up  the request stays with the manager as `followup`; the existing
 *              follow-up task on the desk's list already says what is wanted.
 *   not_qualified is the existing closure and is left entirely to it.
 *
 * A lead with no pending request is none of this file's business and is
 * returned untouched — which is every lead the salesman path raises.
 */
export async function settleProspectRequest(
  customerId: string,
  outcome: "verified" | "follow_up" | "not_qualified",
): Promise<Result<{ promoted: boolean }>> {
  try {
    const ctx = await requireCapability("lead.verify");
    const lead = await leadRow(customerId);
    if (!lead) return err("That lead is not on MahekOne.", "not_found");
    await assertCustomerInScope({
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
    });
    const req = await requestOf(customerId);
    if (req.state !== "awaiting" && req.state !== "followup") return ok({ promoted: false });
    if (outcome === "not_qualified") return ok({ promoted: false });

    const [latest] = await db
      .select({ verdict: mbosLeadValidations.verdict })
      .from(mbosLeadValidations)
      .where(eq(mbosLeadValidations.customerId, customerId))
      .orderBy(desc(mbosLeadValidations.calledAt))
      .limit(1);
    /* `verificationVerdictFor`: a successful verification is stored as "confirmed". */
    const expected = outcome === "verified" ? "confirmed" : "pending";
    if (!latest || latest.verdict !== expected) {
      return err("The latest verification on this lead does not say that.", "rule_violation");
    }

    if (outcome === "follow_up") {
      await db
        .update(customers)
        .set({ prospectRequestState: "followup", updatedAt: new Date() })
        .where(eq(customers.id, customerId));
      refresh(customerId);
      return ok({ promoted: false }, "The request is on hold with you until the follow-up is done.");
    }

    const day = await today();
    const moved = await advanceLeadStage({
      customerId,
      to: "prospect",
      reasonCode: req.reason ?? undefined,
      note: req.note ?? undefined,
      nextAction: {
        action: "Start qualification",
        date: day,
        ownerId: ctx.user.id,
        outcome: "Open qualification and take the eight conditions to done",
      },
    });
    if (!moved.ok) {
      return err(
        `The verification is recorded, but the lead could not be made a Prospect: ${moved.error}`,
        "rule_violation",
      );
    }

    await db
      .update(customers)
      .set({
        prospectRequestState: null,
        /* The manager who verified it holds the seat from here — filled only
           where nobody does, and `lead_manager_decided_at` left alone. */
        ...(lead.leadManagerId ? {} : { leadManagerId: ctx.user.id }),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, customerId));

    if (req.byId && req.byId !== ctx.user.id) {
      await notifyUser({
        userId: req.byId,
        title: `${lead.name} is a Prospect`,
        body: `${ctx.user.name} verified your request and confirmed ${lead.name} as a Prospect. It is with them for qualification now.`,
        kind: "info",
        href: `/crm/leads/calling-desk/${customerId}`,
      });
    }

    refresh(customerId);
    return ok({ promoted: true }, "Verified — the lead is now a confirmed Prospect.");
  } catch (e) {
    return fromThrown(e);
  }
}
