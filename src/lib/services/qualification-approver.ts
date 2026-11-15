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
 * THE ORG CHART COMES FIRST, here and nowhere else. Whoever COLLECTED the
 * answers is the starting point and the nearest eligible person above them on
 * the Org Chart reviews (`orgChartVerifierFor`, the same walk that names a
 * Prospect's verifier). Only where the chart cannot answer do the three seats
 * below decide. This used to be split: the review action read the chart and
 * this function read the seats, so where the two named different people each
 * was refused by the other's rule and the lead could never be reviewed. Now
 * the hand-off (`settleQualificationState`), the verdict and the screens all
 * read this one answer.
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

  /* The collector: the owner, or — on a lead its Sales Manager raised herself
     with somebody designated to approve it — her, where nobody owns it. The
     same rule `collectorOf` in the hand-off follows. */
  const collector = lead.ownerId ?? (designated ? lead.salesManagerId : null);
  if (collector) {
    const { orgChartVerifierFor } = await import("./org-verifier-resolver");
    const org = await orgChartVerifierFor(collector);
    if (org.ok) {
      const person = await activeUser(org.id);
      if (person) return person;
    }
  }

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

/**
 * MAY THIS PERSON ACT AS THE QUALIFICATION REVIEWER OF THIS LEAD — the screens'
 * form of the authority the review's verdict asks, as a boolean.
 *
 * Exactly the person `reviewLeadQualification` lets decide: the designated
 * reviewer (`assertDesignatedQualificationApprover`), never the lead's owner.
 * It is asked by anything that draws a control only the reviewer may use, so
 * what is drawn and what the action allows cannot differ. It grants nothing
 * and reads no level: an Associate the chart or the seat names is the
 * reviewer, and a manager who is not the designated person is not.
 */
export async function canActAsQualificationApprover(
  user: { id: string; role: string },
  customerId: string,
): Promise<boolean> {
  /* The designated reviewer, and nobody else — whatever else they hold. The
     Org Chart can name somebody who carries the Sales Manager screens but not
     `lead.verify`, so the capability is not asked first. The owner collected
     the answers and never reviews them. */
  if (!(await assertDesignatedQualificationApprover(customerId, user.id)).ok) return false;
  return !(await ownsLead(customerId, user.id));
}

async function ownsLead(customerId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ ownerId: customers.ownerId }).from(customers).where(eq(customers.id, customerId)).limit(1);
  return row?.ownerId === userId;
}
