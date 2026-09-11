import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { customerAmChanges, customers } from "@/db/schema";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import type { db } from "@/db";

/* ---------------------------------------------------------------------------
 * §Q — THE RELATIONSHIP HANDOVER.
 *
 * The brief asks for one thing and describes two. "On the second order the
 * lead becomes a customer and the relationship moves to a customer manager"
 * is a sentence about what the account IS and a sentence about who RUNS it,
 * joined by an "and" that hides the fact they are independent.
 *
 * The first was answered in `lead-conversion-service.ts`, and answered
 * differently to the brief: `kind` flips on the FIRST order, because between
 * order one and order two the account has been billed, owes money and has a
 * buying cycle, and a lead carries none of that machinery. That answer is
 * settled and this file does not revisit it.
 *
 * This is the second sentence, on its own marker. It moves WHO RUNS THE
 * ACCOUNT and nothing else — no revenue, no target, no collections list, no
 * queue. That is not a limitation, it is the reason the act can be a
 * manager's at all: moving the sales seat moves numbers between a manager's
 * own people, which is why `customer.reassign` is accounts' and admin's.
 *
 * WHETHER A HANDOVER IS OUTSTANDING IS DERIVED. Converted, and `handedOverAt`
 * still null. Not a flag — a flag is a cache, and there is nothing here to
 * rebuild it from that is not simply the two columns it would be caching.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** Anything that can write: `db` itself, or a transaction handle. */
type Writer = Pick<typeof db, "update" | "insert">;

export type HandoverTarget = {
  id: string;
  kind: "lead" | "customer";
  name: string;
  relationshipOwnerId: string | null;
  handedOverAt: Date | null;
};

export type HandoverRefusal = "not_a_customer" | "already_theirs";

/**
 * Why this cannot be handed over, or null where it can.
 *
 * PURE, and separate from the write, so the screen can draw a disabled button
 * with the reason on it and the action can refuse the same thing for the same
 * reason. A rule that lives only in the action produces a button that looks
 * available and fails on click; a rule that lives only in the screen is not a
 * rule at all, because a server action is a URL.
 */
export function handoverRefusal(
  target: Pick<HandoverTarget, "kind" | "relationshipOwnerId">,
  toUserId: string,
): HandoverRefusal | null {
  /*
   * A LEAD CANNOT BE HANDED OVER, and this is the one refusal worth being
   * strict about. The seat means "who runs this account now that it is one" —
   * on a lead that job is `leadManagerId`, a different column with a different
   * meaning, filled from the org chart when the lead qualifies. Allowing both
   * on one record would give a lead two coordinating seats and no rule saying
   * which the notifications should name.
   */
  if (target.kind !== "customer") return "not_a_customer";
  if (target.relationshipOwnerId === toUserId) return "already_theirs";
  return null;
}

export const HANDOVER_REFUSALS: Record<HandoverRefusal, string> = {
  not_a_customer:
    "A lead has no relationship to hand over yet — it is the Lead Manager who runs it until it orders.",
  already_theirs: "They already run this account.",
};

/**
 * The act, inside the caller's transaction.
 *
 * Three writes that have to stand or fall together: the seat, the history row
 * and the timeline entry. A handover recorded on the account with no history
 * behind it cannot answer "who was running this in March", which is the
 * question the marker exists for; a history row with no seat is a record of
 * something that did not happen.
 */
export async function handOverRelationship(
  tx: Writer,
  params: {
    target: HandoverTarget;
    toUserId: string;
    toName: string;
    fromName: string | null;
    reasonCode: string;
    note: string | null;
    actorId: string;
    at?: Date;
  },
): Promise<void> {
  const { target, toUserId, toName, fromName, reasonCode, note, actorId } = params;
  const at = params.at ?? new Date();

  await tx
    .update(customers)
    .set({
      relationshipOwnerId: toUserId,
      /*
       * Moved on every handover, not only the first. It answers "when did this
       * account last change hands", which is what a screen showing one line
       * needs; the full trail is in `customer_am_changes`, which is exactly
       * the split every other seat here already uses.
       */
      handedOverAt: at,
      updatedAt: at,
      updatedById: actorId,
    })
    .where(eq(customers.id, target.id));

  /*
   * No `amDecidedAt`. That mark holds the customer master off the sales and
   * back office seats it keeps restating, and the sheet has never heard of
   * this one — so there is nothing to hold off, and stamping it would freeze
   * the OTHER two seats against a sync as a side effect of naming a
   * relationship manager. The same reasoning, and the same paragraph, as the
   * sales manager seat next door.
   */
  await tx.insert(customerAmChanges).values({
    id: gen("amc"),
    customerId: target.id,
    role: "relationship",
    fromUserId: target.relationshipOwnerId,
    fromName,
    toUserId,
    toName,
    reasonCode,
    note,
    changedById: actorId,
    changedAt: at,
  });

  await writeTimelineEvent(tx, {
    customerId: target.id,
    eventType: MBOS_EVENT.relationshipHandover,
    sourceApp: "crm",
    /*
     * Keyed on the INSTANT, so a second handover is a second entry. The other
     * writers here key on a row id because there is one row per event; a seat
     * has no row of its own, and keying on the customer alone would make every
     * handover after the first silently vanish into the first one's natural
     * key.
     */
    sourceRecordId: `${target.id}:handover:${at.toISOString()}`,
    occurredAt: at,
    actorUserId: actorId,
    summary: target.relationshipOwnerId
      ? `Relationship moved to ${toName}`
      : `Relationship handed over to ${toName}`,
  });
}

/**
 * CONVERTED, AND NOBODY HAS TAKEN IT ON — the worklist, derived.
 *
 * This is the half that stops the marker being decorative. A column somebody
 * has to remember to fill in is a column that stays null, and the failure is
 * silent: the account works perfectly, it simply has nobody's name against it,
 * and the person who would have noticed is the one who never got told.
 *
 * The same shape as the third-party filter that lists shops with no
 * distributor — a list that should be empty and is not. A row nobody can
 * account for is worse than one that says why it is there.
 */
export function pendingHandoverClause(): SQL {
  return and(
    isNotNull(customers.leadConvertedAt),
    isNull(customers.handedOverAt),
  ) as SQL;
}

/** How many are waiting, within whatever scope the caller has already applied. */
export function pendingHandoverCountSql(): SQL<number> {
  return sql<number>`count(*) filter (
    where customers.lead_converted_at is not null
      and customers.handed_over_at is null
  )`;
}
