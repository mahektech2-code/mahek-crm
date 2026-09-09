import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { auditLog, customers, orders } from "@/db/schema";
import { assignedUserId } from "@/lib/access-control";
import { orderCountsSql } from "@/lib/order-status";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import type { db } from "@/db";

/* ---------------------------------------------------------------------------
 * A LEAD BECOMES A CUSTOMER ON ITS SECOND ORDER, and it is decided here for
 * both apps.
 *
 * IT WAS THE FIRST, and the client has corrected us. The reasoning for the
 * first was that between order one and order two the account has been billed,
 * owes money and has a buying cycle, and a lead carries none of that
 * machinery — which is true, and is not what the word is being asked to mean.
 * A first order from a shop that has just finished a trial is a few cans to
 * try in their own booth. It is the last step of the trial rather than the
 * first step of a relationship, and it routinely does not repeat. Calling that
 * shop a customer inflates every conversion figure in the business with
 * accounts that ordered once and were never heard from again, which is exactly
 * the number §Q exists to measure honestly.
 *
 * `promotesToCustomerAt` in `lib/engines/lead-ladder.ts` has said
 * `second_order` all along; this file is what stopped agreeing with it.
 *
 * WHAT COUNTS AS AN ORDER is `lib/order-status.ts` and nothing else. A
 * `pending_approval` row is the customer saying yes and not the business, and
 * a `declined` one is the business saying no — promoting an account on the
 * strength of an order accounts turned down would be the worst version of
 * this. `status <> 'cancelled'` is the spelling that counts both, and it is
 * why that phrase is banned here.
 *
 * The order being placed is EXCLUDED from the count by id and the rule is
 * "has this account ordered before". Counting it in would make the answer
 * depend on the status the caller happened to write the row with — the CRM and
 * the handset both write `pending_approval` today, so an inclusive count would
 * simply never reach two, and the first path to write `captured` would
 * silently start converting on the first order again.
 *
 * ONE DEFINITION, TWO CALLERS: the CRM's interaction save and the handset's
 * order handler. Two copies of "what happens when a lead orders" would drift
 * within a release, and the half that drifts is whichever nobody is looking
 * at, which on this team is the handset.
 * ------------------------------------------------------------------------- */

/** Anything that can write: `db` itself, or a transaction handle. */
type Writer = Pick<typeof db, "update" | "insert">;

/** Anything that can read, for the count behind the rule. */
type Reader = Pick<typeof db, "select">;

/**
 * HAS THIS ACCOUNT ORDERED BEFORE — the whole of the second-order rule.
 *
 * `excludeOrderId` is the order being placed right now, which both callers
 * have already written into the transaction by the time they ask. Without it
 * the answer would include the row being decided about.
 */
export async function hasOrderedBefore(
  reader: Reader,
  customerId: string,
  excludeOrderId: string | null,
): Promise<boolean> {
  const [row] = await reader
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        orderCountsSql("orders"),
        excludeOrderId ? ne(orders.id, excludeOrderId) : undefined,
      ),
    );
  return (row?.n ?? 0) >= 1;
}

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
 * statement and must not issue a second one. PURE: whether to convert is
 * `hasOrderedBefore`, asked separately, because this is spread into an update
 * that is being assembled synchronously.
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
 * The MBOS order handler's case: it has already written the order and needs
 * the account to be a customer if this was the second one.
 *
 * The update is guarded on `kind = 'lead'` so two orders arriving together
 * convert once — the second finds nothing to change, and `recordConversion`'s
 * timeline write is idempotent on its natural key besides.
 */
/**
 * THE OTHER MOMENT AN ACCOUNT CAN CROSS THE THRESHOLD: an order being APPROVED.
 *
 * Conversion is asked when an order is SAVED, and what counts as an order is
 * `lib/order-status.ts` — an approved one. Those two facts together leave a hole
 * the second-order rule opened and the first-order rule never had: a lead whose
 * first order is still `pending_approval` when its second arrives has nothing to
 * have "ordered before", so neither order converts it — and nothing looked
 * again when accounts approved the first. The shop then sat as a lead until a
 * THIRD order, on a book where the telecaller's list and the owner's funnel both
 * read `kind`.
 *
 * So approval asks the same question the save does. It is cheap — one count on
 * an indexed column, only where the row is still a lead — and it is idempotent:
 * `convertLeadOnSecondOrder` refuses a row that is already a customer, so a
 * re-approval or a double-click converts nothing twice.
 *
 * `orderedOn` is the day the ORDER is for, not today, for the same reason the
 * save path passes it: a salesman may state a past date, and the account began
 * when it began.
 */
export async function convertIfNowQualified(
  tx: Writer & Reader,
  customerId: string,
  orderedOn: string,
  actorId: string,
  how: string,
  approvedOrderId: string,
): Promise<boolean> {
  const [lead] = await tx
    .select({
      id: customers.id,
      kind: customers.kind,
      ownerId: customers.ownerId,
      salesAmId: customers.salesAmId,
      leadSource: customers.leadSource,
      leadStage: customers.leadStage,
    })
    .from(customers)
    .where(eq(customers.id, customerId));

  /* Not a lead any more, or never on a funnel — nothing to promote. */
  if (!lead || lead.kind !== "lead") return false;

  return convertLeadOnSecondOrder(
    tx,
    {
      id: lead.id,
      kind: "lead",
      ownerId: lead.ownerId ?? null,
      salesAmId: lead.salesAmId ?? null,
      leadSource: lead.leadSource ?? null,
    },
    orderedOn,
    actorId,
    how,
    /* Excluded by id so the question stays "has it ordered BEFORE" — the order
       just approved is the one being counted FOR, not against. */
    approvedOrderId,
  );
}

export async function convertLeadOnSecondOrder(
  tx: Writer & Reader,
  lead: ConvertibleLead,
  orderedOn: string,
  actorId: string,
  how: string,
  placedOrderId: string | null = null,
): Promise<boolean> {
  if (lead.kind !== "lead") return false;
  /* The second order is the one that converts. A first is the tail of the
     trial, and an account promoted on it is a conversion figure counting shops
     that ordered once and were never heard from again. */
  if (!(await hasOrderedBefore(tx, lead.id, placedOrderId))) return false;

  const columns = conversionColumns(lead, orderedOn);
  await tx
    .update(customers)
    .set({ ...columns, updatedAt: new Date() })
    .where(eq(customers.id, lead.id));

  await recordConversion(tx, lead, actorId, columns.salesAmId ?? null, how);
  return true;
}
