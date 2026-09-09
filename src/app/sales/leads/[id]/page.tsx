import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { today } from "@/lib/recompute";
import { ladderVerdicts, mustDecideSuspect } from "@/lib/engines/lead-gates";
import {
  canLead,
  gateInputFor,
  handoverCandidates,
  leadCommunications,
  leadOrders,
  leadReceipts,
  leadRecord,
  leadTimeline,
  leadTransitions,
  managerCalls,
  nurtureSchedule,
  publishedDocuments,
} from "@/lib/services/lead-console-service";
import { LeadRecordScreen } from "./lead-record-screen";

export const metadata = { title: "Lead — Sales Dashboard — MahekOne" };

/**
 * One lead, whole.
 *
 * The console had a table and a row that expanded, and everything the funnel
 * added needed somewhere to live: the ladder with a verdict on every rung, the
 * twelve verification answers, the eleven communication buttons, the nurture
 * schedule, the appointment, the sample and the money. None of those is a
 * column, and putting them in an expanding row would have given a manager a
 * six-inch drawer to read a lead's whole life through.
 *
 * **The gates are evaluated HERE, on the server, and passed down.** They are
 * pure and they could run in the browser — but the input they take is half the
 * database, and shipping it to draw a checklist is how a record page comes to
 * carry a customer's whole ledger in its payload. The screen receives verdicts.
 *
 * **The clock is read once, here.** The React Compiler rules are on and a
 * client component may not read `Date.now()` during render — a value that
 * changes between renders makes an elapsed count jump about.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const day = await today();
  const user = await requireUser();

  const record = await leadRecord(id, day);

  /* Null covers both "no such lead" and "not in this manager's territory", and
     the two are deliberately the same answer: a 404 that distinguished them
     would make the URL a way to find out whose book an id belongs to. */
  if (!record) notFound();

  const [
    transitions,
    calls,
    timeline,
    communications,
    orders,
    receipts,
    documents,
    nurture,
    handover,
    config,
  ] = await Promise.all([
    leadTransitions(id),
    managerCalls(id),
    leadTimeline(id),
    leadCommunications(id),
    leadOrders(id),
    leadReceipts(id),
    publishedDocuments(),
    nurtureSchedule(day, { customerId: id }),
    handoverCandidates(),
    getConfig(),
  ]);

  const gateInput = gateInputFor(record);

  return (
    <LeadRecordScreen
      record={record}
      verdicts={ladderVerdicts(gateInput)}
      mustDecide={mustDecideSuspect(gateInput, config["leads.suspectMaxVisits"])}
      transitions={transitions}
      calls={calls}
      timeline={timeline.rows}
      timelineTotal={timeline.total}
      communications={communications}
      orders={orders}
      receipts={receipts}
      documents={documents}
      nurture={nurture}
      handover={handover}
      canVerify={canLead(user.role, "lead.verify")}
      canWork={canLead(user.role, "lead.work")}
      /* §22 — naming the relationship owner is a customer reassignment, and
         `customer.reassign` is accounts' and admin's on purpose: whose book an
         account sits in decides whose targets it counts toward, so a manager
         doing it is a manager moving numbers between their own people. The
         control is drawn for everybody and refused by the capability, in the
         action as well as here. */
      canReassign={canLead(user.role, "customer.reassign")}
      canOverride={canLead(user.role, "lead.override") && config["leads.allowManagerOverride"]}
      overrideAllowed={config["leads.allowManagerOverride"]}
      nowMs={nowMs()}
    />
  );
}
