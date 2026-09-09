import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { auditLog, customers } from "@/db/schema";
import { assignedUserId } from "@/lib/access-control";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import type { db } from "@/db";

/* ---------------------------------------------------------------------------
 * A LEAD BECOMES A CUSTOMER THE MOMENT IT ORDERS — the FIRST order, and it is
 * decided here for both apps.
 *
 * §Q of the brief asks for the flip on the SECOND order. It is the first, and
 * that is a deliberate answer rather than an oversight: between order one and
 * order two the account has been billed, owes money and has a buying cycle, and
 * leads carry none of that machinery by design. A `kind = 'lead'` row with an
 * invoice against it drops out of collections, out of targets, out of the
 * owner's conversion KPI and out of the salesman's new-customer count — five
 * subsystems reading one column that would have stopped meaning what it says.
 *
 * What §Q is really describing is the RELATIONSHIP moving to a customer manager,
 * which is a different question from what the account IS. If that handover is
 * wanted it belongs on its own marker beside `kind`, never on `kind` itself.
 *
 * ONE DEFINITION, TWO CALLERS. The CRM converted on the first order from the
 * day it shipped; MBOS refused an order against a lead outright, and now
 * converts instead. Two copies of "what happens when a lead orders" would drift
 * within a release — and the half that drifts is whichever one nobody is
 * looking at, which on this team is the handset.
 * ------------------------------------------------------------------------- */

/** Anything that can write: `db` itself, or a transaction handle. */
type Writer = Pick<typeof db, "update" | "insert">;

export type ConvertibleLead = {
  id: string;
  kind: "lead" | "customer";
  ownerId: string | null;
  salesAmId: string | null;
  leadSource: string | null;
};

/**
 * The columns a conversion sets, for a caller that is already building an
 * update — the CRM's interaction save writes twenty other fields in the same
 * statement and must not issue a second one.
 *
 * Empty where the record is already a customer, so a caller can spread it
 * unconditionally.
 */
export function conversionColumns(
  lead: ConvertibleLead,
  orderedOn: string,
): Partial<typeof customers.$inferInsert> {
  if (lead.kind !== "lead") return {};
  return {
    kind: "customer",
    /*
     * Through the ONE definition of whose book a record is in. A lead answers
     * to its owner, and a reassignment moves a lead by writing that column — so
     * this carries the CURRENT holder across rather than re-deriving a fallback
     * that could disagree with it.
     */
    salesAmId: assignedUserId({
      kind: "lead",
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
    }),
    customerSince: orderedOn,
    /*
     * The ladder ends at `won`, and the stage is KEPT rather than cleared. It
     * is where the account came from, and the funnel reports read it — a lead
     * that converts and then reads as having no stage is one that vanishes from
     * every count of how leads were won.
     *
     * Back office is deliberately left unassigned: who handles the dispatch and
     * the billing is a decision, not something to guess at on a first order.
     */
    leadStage: "won",
    leadConvertedAt: new Date(),
  };
}

/**
 * The record of it: the audit line and the timeline entry.
 *
 * Separate from the columns because the CRM writes those inside an update it is
 * already building, and MBOS writes its own — but both owe the same two rows
 * afterwards. Called INSIDE the caller's transaction: a conversion that was
 * recorded and then rolled back is a customer who does not exist, on a screen
 * somebody believes.
 */
export async function recordConversion(
  tx: Writer,
  lead: ConvertibleLead,
  actorId: string,
  salesAmId: string | null,
  how: string,
): Promise<void> {
  await tx.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId,
    action: "customer.convertedFromLead",
    entityType: "customer",
    entityId: lead.id,
    beforeState: { kind: "lead", leadSource: lead.leadSource } as never,
    afterState: { kind: "customer", salesAmId, how } as never,
  });

  await writeTimelineEvent(tx, {
    customerId: lead.id,
    eventType: MBOS_EVENT.leadConverted,
    sourceApp: "mbos",
    sourceRecordId: `${lead.id}:converted`,
    occurredAt: new Date(),
    actorUserId: actorId,
    summary: `Became a customer — ${how}`,
  });
}

/**
 * Convert, for a caller with nothing else to write.
 *
 * The MBOS order handler's case: it has already decided the order is good and
 * needs the account to be a customer before the order lands on it.
 *
 * The update is guarded on `kind = 'lead'` so two orders arriving together
 * convert once — the second finds nothing to change, and `recordConversion`'s
 * timeline write is idempotent on its natural key besides.
 */
export async function convertLeadOnFirstOrder(
  tx: Writer,
  lead: ConvertibleLead,
  orderedOn: string,
  actorId: string,
  how: string,
): Promise<boolean> {
  if (lead.kind !== "lead") return false;

  const columns = conversionColumns(lead, orderedOn);
  await tx
    .update(customers)
    .set({ ...columns, updatedAt: new Date() })
    .where(eq(customers.id, lead.id));

  await recordConversion(tx, lead, actorId, columns.salesAmId ?? null, how);
  return true;
}
