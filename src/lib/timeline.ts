import "server-only";
import { randomUUID } from "node:crypto";
import { timelineEvents } from "@/db/schema";
import type { db } from "@/db";

/* ---------------------------------------------------------------------------
 * The shared stream, §1.1.
 *
 * `timeline_events` is what makes a salesman walking into a shop able to see
 * that a telecaller rang yesterday, and a telecaller able to see that somebody
 * stood in the shop this morning. It only works if BOTH apps write it — a
 * stream one app fills and the other reads is that app's own log wearing a
 * shared name, and the salesman standing in the shop learns nothing from it.
 *
 * It is a PROJECTION. Every row points back at the record that is the actual
 * truth through `sourceRecordId`, nothing is derived from this table that is
 * not already derivable from its sources, and a write happens in the SAME
 * transaction as the record it describes — a timeline entry for a call that
 * rolled back is a call that never happened, on a screen somebody believes.
 *
 * One helper, called from the few places that write, rather than an insert
 * scattered at each of them: the id shape, the conflict target and the
 * summary style are all things twenty call sites would each get slightly
 * differently.
 * ------------------------------------------------------------------------- */

/** Anything that can insert: `db` itself, or a transaction handle. */
export type TimelineWriter = { insert: typeof db.insert };

export type TimelineEventInput = {
  customerId: string;
  /** `call`, `visit`, `order`, `payment`, `complaint`, `sample`… */
  eventType: string;
  sourceApp: "crm" | "mbos";
  /** The row this describes, in whichever table owns it. */
  sourceRecordId: string | null;
  /** When it HAPPENED, not when it was projected. */
  occurredAt: Date;
  actorUserId?: string | null;
  summary: string;
};

const newId = () => `tl_${randomUUID().slice(0, 12)}`;

/**
 * Write one event, or do nothing if this source row already has one.
 *
 * The conflict target is the natural key — app, kind, source row — so a
 * re-run of a backfill and a retried sync both land on the same single row.
 * Doing nothing rather than updating is deliberate: the summary is a sentence
 * about what happened at the time, and rewriting it later would quietly
 * change what the reader was told.
 */
export async function writeTimelineEvent(
  tx: TimelineWriter,
  event: TimelineEventInput,
): Promise<void> {
  await writeTimelineEvents(tx, [event]);
}

/**
 * The same, in one statement, for a backfill that has thousands of them.
 *
 * Returns how many rows were actually WRITTEN, which is not how many were
 * offered: the ones already there are the whole point of the conflict clause,
 * and a backfill that reported the offered count would claim to have done work
 * on every re-run.
 */
export async function writeTimelineEvents(
  tx: TimelineWriter,
  events: TimelineEventInput[],
): Promise<number> {
  if (!events.length) return 0;
  const written = await tx
    .insert(timelineEvents)
    .values(
      events.map((event) => ({
        id: newId(),
        customerId: event.customerId,
        eventType: event.eventType,
        sourceApp: event.sourceApp,
        sourceRecordId: event.sourceRecordId,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId ?? null,
        summary: event.summary,
      })),
    )
    .onConflictDoNothing({
      target: [
        timelineEvents.sourceApp,
        timelineEvents.eventType,
        timelineEvents.sourceRecordId,
      ],
    })
    .returning({ id: timelineEvents.id });
  return written.length;
}

/* --------------------------------------------------------------- sentences */

/**
 * The event types the CRM writes. Named here rather than typed at each call
 * site, because the natural key is built from this string and a typo makes a
 * second, silently duplicated stream.
 */
export const CRM_EVENT = {
  call: "telecaller_call",
  order: "order",
  payment: "payment",
  /**
   * §R — whose account this is, changing.
   *
   * `crm` rather than `mbos` because that is where reassignment happens: the
   * capability is accounts' and admin's and the screen is the customer list, so
   * the app that wrote it is the CRM whoever pressed the button was in.
   */
  ownerChange: "owner_change",
} as const;

/**
 * The event types MBOS writes, named here beside the CRM's for the same reason.
 *
 * The natural key is built from this string, so a typo makes a second, silently
 * duplicated stream — and worse, one nothing will ever deduplicate, because the
 * conflict target will never match. Five of these existed as literals at their
 * call sites before §R was worked through; the rest are new, and all of them
 * live here now so the set can be read in one place and compared against what
 * the brief asks for.
 *
 * §R asks for twenty-three kinds. `quotation` is deliberately absent: there is
 * no quotation record in MahekOne to project FROM, and a timeline entry with no
 * source row is not a projection of anything — it is a sentence somebody typed,
 * in a table whose whole discipline is that every row points back at the record
 * that is the actual truth.
 */
export const MBOS_EVENT = {
  /* Already written before §R was completed. */
  visit: "visit",
  order: "order",
  payment: "payment",
  complaint: "complaint",
  sample: "sample",

  /* The lead's own life. */
  leadCreated: "lead_created",
  leadAssigned: "lead_assigned",
  leadConverted: "lead_converted",
  ownerChange: "owner_change",
  /**
   * §Q — the relationship passing to whoever runs the account from here.
   *
   * Its own kind rather than a second use of `ownerChange`, which the CRM
   * already writes when an account MANAGER moves. The two would read
   * identically on a customer's history and mean different things: one is the
   * sales or back-office seat moving, the other is the moment a lead somebody
   * won in the field became somebody else's account to run. Reading a history
   * to find out when that happened is the whole reason the marker exists.
   */
  relationshipHandover: "relationship_handover",

  /* What was learnt, and from whom. */
  requirement: "requirement",
  competitor: "competitor",
  validation: "validation_call",
  internalNote: "internal_note",

  /* The sample, at each point somebody's word changes. */
  sampleDispatched: "sample_dispatched",
  sampleReceived: "sample_received",
  sampleReview: "sample_review",

  /* The commercial half. */
  negotiation: "negotiation",
  delivery: "delivery",

  /** Where a shop actually is, recorded the first time somebody stood in it. */
  gps: "gps",
} as const;

/**
 * What each outcome is called on a screen. There is no other label map for
 * these — the stored enum is not a label, and `no_order` reaching a salesman's
 * handset unchanged is the sort of thing that makes a shared stream read like
 * a database dump.
 */
const OUTCOME_LABELS: Record<string, string> = {
  order_taken: "Order taken",
  no_order: "No order",
  no_answer: "No answer",
  payment_promised: "Payment promised",
  follow_up: "Follow-up agreed",
  not_interested: "Not interested",
  complaint: "Complaint raised",
  transport_follow_up: "Transport follow-up",
  casual_talk: "General conversation",
};

const TYPE_LABELS: Record<string, string> = {
  outbound_call: "Telecaller called",
  inbound_call: "Customer called in",
  order_received: "Order received without a call",
};

/** One line, and short enough to sit in a list on a handset. */
function trim(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The sentence a salesman reads. Built from the outcome and the note, because
 * those two together are what the call actually was — a line saying only
 * "call" tells somebody standing in the shop nothing they did not know.
 */
export function callTimelineSummary(call: {
  interactionType: string;
  outcome: string | null;
  notes: string | null;
}): string {
  const head = TYPE_LABELS[call.interactionType] ?? "Telecaller called";
  const outcome = call.outcome ? OUTCOME_LABELS[call.outcome] : null;
  const opening = outcome ? `${head} — ${outcome}` : head;
  const note = call.notes?.trim();
  return trim(note ? `${opening}: ${note}` : opening);
}
