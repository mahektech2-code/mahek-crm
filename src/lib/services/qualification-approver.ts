import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, users } from "@/db/schema";
import { approverFor } from "./lead-verifier";

/* ---------------------------------------------------------------------------
 * THE ONE PERSON WHO APPROVES A LEAD'S QUALIFICATION.
 *
 * `requireQualificationApprover` answers "may this person approve" with a wide
 * net on purpose — whoever holds `lead.verify`, or the lead's Sales Manager
 * seat — and refuses only the owner and a DIFFERENT Sales Manager. That is the
 * right question for the screens that merely draw a control. It is not the
 * question the DECISION asks: confirming or rejecting a Qualification is one
 * named person's judgement, and holding a capability, or being an
 * administrator, does not make anybody that person.
 *
 * Who that person is is NOT decided here. `settleQualificationState` already
 * decides it — it is whoever the review is handed to, and tells — so this reads
 * the same three answers in the same order and nothing else:
 *
 *   1. `approverFor` — on a lead the Sales Manager raised herself, the person
 *      Mahek designates (`leads.selfRaisedVerifierEmail`);
 *   2. the ACTIVE Sales Manager the lead sits under (`sales_manager_id`);
 *   3. the lead manager seat.
 *
 * No routing rule lives in this file: it adds no setting, reads no org chart and
 * chooses no one. `qualification-approver.test` pins it to the hand-off, so the
 * person told to review and the person allowed to are the same person by test
 * and not by hope.
 *
 * NOBODY IS DESIGNATED is an answer, and it refuses everyone. A lead with no
 * Sales Manager and no lead manager has nobody to be asked, and quietly letting
 * "whoever holds the capability" stand in is the substitution this exists to
 * stop.
 * ------------------------------------------------------------------------- */

export type DesignatedApprover = { id: string; name: string };

async function activeUser(userId: string | null): Promise<DesignatedApprover | null> {
  if (!userId) return null;
  const [u] = await db
    .select({ id: users.id, name: users.name, active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u && u.active ? { id: u.id, name: u.name } : null;
}

/** The person this lead's Qualification review belongs to, or null where nobody is named. */
export async function designatedQualificationApprover(customerId: string): Promise<DesignatedApprover | null> {
  const [lead] = await db
    .select({
      ownerId: customers.ownerId,
      salesManagerId: customers.salesManagerId,
      leadManagerId: customers.leadManagerId,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!lead) return null;

  const designated = await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId });
  if (designated) return designated;

  const seat = await activeUser(lead.salesManagerId);
  if (seat) return seat;

  /* The hand-off falls back to the raw seat without asking whether the account
     is active; this asks, because a closed account cannot be the person who
     decides. Where it is closed nobody is designated, which refuses everyone. */
  return activeUser(lead.leadManagerId);
}

export type ApproverVerdict = { ok: true; approver: DesignatedApprover } | { ok: false; message: string };

/**
 * May THIS person confirm or reject this lead's Qualification? Only the person
 * it is designated to — an administrator is no exception unless the lead is
 * theirs to review.
 */
export async function assertDesignatedQualificationApprover(
  customerId: string,
  userId: string,
): Promise<ApproverVerdict> {
  const approver = await designatedQualificationApprover(customerId);
  if (!approver) {
    return {
      ok: false,
      message:
        "Nobody is designated to approve this lead's Qualification yet — it has no active Sales Manager. Seat a Sales Manager on the lead first.",
    };
  }
  if (approver.id !== userId) {
    return {
      ok: false,
      message: `Only ${approver.name} can confirm or reject this lead's Qualification. Holding the permission, or being an administrator, is not enough.`,
    };
  }
  return { ok: true, approver };
}
