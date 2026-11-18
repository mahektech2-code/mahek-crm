import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { deadFactsOf, deadRequestsOfLead } from "@/lib/services/lead-dead-service";
import { DeadRecordBarView } from "./dead-record-bar-view";

/**
 * WHAT A LEAD'S RECORD SAYS ABOUT BEING DEAD, drawn above every record screen.
 *
 * One server component mounted on each of the lead record pages (the general
 * record, the Calling desk's, and both Sales Manager ones), so the four cannot
 * come to say different things. It draws nothing for a lead that is neither
 * Lost nor Dead nor pending. It is a READ: every decision it offers goes
 * through `decideDeadRequest` / `requestDeadLead`, which ask their own
 * questions again.
 */
export async function DeadRecordBar({ leadId }: { leadId: string }) {
  const user = await requireUser();
  /* The name and the rung are read here rather than passed in, so the four
     pages that mount this need to know nothing about each other's record
     shapes. A lead the reader may not see never reaches this component: the
     page it is mounted on has already refused it. */
  const [lead] = await db
    .select({ name: customers.name, stage: customers.leadStage })
    .from(customers)
    .where(eq(customers.id, leadId))
    .limit(1);
  if (!lead) return null;
  const leadName = lead.name;
  const stage: string | null = lead.stage;
  const [facts, history, canWork] = await Promise.all([
    deadFactsOf(leadId),
    deadRequestsOfLead(leadId),
    canFor(user, "lead.work"),
  ]);
  if (stage !== "lost" && !facts.deadAt && !history.length) return null;

  const pending = history.find((r) => r.state === "pending") ?? null;
  const approved = history.find((r) => r.state === "approved") ?? null;

  return (
    <DeadRecordBarView
      lead={{ id: leadId, name: leadName }}
      dead={Boolean(facts.deadAt)}
      lost={stage === "lost"}
      canWork={canWork}
      pending={
        pending
          ? {
              id: pending.id,
              leadName,
              requestedByName: pending.requestedByName,
              approverName: pending.approverName,
              reasonCode: pending.reasonCode,
              note: pending.note,
              lostReasonAtRequest: pending.lostReasonAtRequest,
              requestedAt: pending.requestedAt,
              mine: pending.approverId === user.id,
              askedByMe: pending.requestedById === user.id,
            }
          : null
      }
      approvedAt={approved?.decidedAt ?? null}
      approvedByName={approved?.decidedByName ?? null}
      history={history.map((r) => ({
        id: r.id,
        state: r.state,
        requestedByName: r.requestedByName,
        requestedAt: r.requestedAt,
        approverName: r.approverName,
        decidedByName: r.decidedByName,
        decidedAt: r.decidedAt,
        reasonCode: r.reasonCode,
        note: r.note,
        decisionNote: r.decisionNote,
      }))}
    />
  );
}
