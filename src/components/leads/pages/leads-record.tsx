import { type LeadWorkspace } from "@/lib/lead-workspace";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { today } from "@/lib/recompute";
import { gateForNext, ladderVerdicts, mustDecideSuspect } from "@/lib/engines/lead-gates";
import { isParked, rungOf } from "@/lib/engines/lead-ladder";
import {
  canLead,
  gateInputFor,
  handoverCandidates,
  ladderOf,
  leadCommunications,
  leadOrders,
  leadReceipts,
  leadRecord,
  leadTransitions,
  managerCalls,
  nurtureSchedule,
  publishedDocuments,
} from "@/lib/services/lead-console-service";
import {
  distributorProfileFor,
  leadApprovalChain,
  leadPanelCounts,
  leadSamplesFor,
  leadTimelinePage,
  leadVisitsFor,
  parkedFrom,
} from "@/lib/services/lead-record-service";
import { LeadRecordScreen } from "@/components/leads/record/lead-record-screen";


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
 * carry a customer's whole ledger in its payload. The screen receives verdicts
 * and never derives one: `gateForNext` and `ladderVerdicts` are the only
 * producers, the handset and the server action call the same two, and a second
 * copy typed into a screen drifts inside one release.
 *
 * **The clock is read once, here.** The React Compiler rules are on and a
 * client component may not read `Date.now()` during render — a value that
 * changes between renders makes an elapsed count jump about.
 *
 * **THE TAB AND THE TIMELINE CURSOR ARE IN THE URL, not in client state.** A
 * manager reading a stalled lead sends the tab to somebody; more to the point,
 * a keyset cursor held in a browser cannot be re-fetched on the server, so
 * paging it would mean a second read path with its own idea of the sort. One
 * read, one order, one cursor — and every page of it is a URL somebody can
 * reload.
 *
 * **Every read is CAPPED and every capped list knows its total.** The customer
 * record learned this the hard way: 3,504 timeline entries were serialised into
 * the page and rendered into the DOM, so the orders, the bills and the payments
 * sat a hundred screens below the fold — and the accounts with the most history
 * are exactly the ones somebody most needs to read before ringing.
 * `leadPanelCounts` is nine `count(*)`s so each panel can say what it is a
 * slice of, rather than counting what it happened to load and calling that the
 * history.
 */
export async function Body({
  workspace,
  params,
  searchParams,
}: {
  workspace: LeadWorkspace;
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const day = await today();
  const user = await requireUser();

  const record = await leadRecord(id, day);

  /* Null covers both "no such lead" and "not in this manager's territory", and
     the two are deliberately the same answer: a 404 that distinguished them
     would make the URL a way to find out whose book an id belongs to. */
  if (!record) notFound();

  const distributor = record.salesType === "distributor";
  const timelineKind = single(query.tlKind);
  const timelineCursor = cursorFrom(single(query.tl));

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
    counts,
    samples,
    visits,
    approvals,
    profile,
    park,
    config,
  ] = await Promise.all([
    leadTransitions(id),
    managerCalls(id),
    leadTimelinePage(id, { limit: 20, before: timelineCursor, kind: timelineKind }),
    leadCommunications(id),
    leadOrders(id),
    leadReceipts(id),
    publishedDocuments(),
    nurtureSchedule(day, { customerId: id }),
    handoverCandidates(),
    leadPanelCounts(id),
    leadSamplesFor(id),
    leadVisitsFor(id),
    /* Only a distributor has a chain or a profile, and asking for them on a
       shop is two guaranteed-empty reads on every page load. */
    distributor ? leadApprovalChain(id) : Promise.resolve([]),
    distributor ? distributorProfileFor(id) : Promise.resolve(null),
    /* `on_hold` displaces the rung rather than being one, so the rung it was
       parked FROM lives on the transition and nowhere else. Read only when the
       lead is actually parked — on every other lead it is a wasted query with
       a guaranteed null. */
    isParked(record.stage) ? parkedFrom(id) : Promise.resolve(null),
    getConfig(),
  ]);

  const gateInput = gateInputFor(record);
  const ladder = ladderOf(record);

  /*
   * ONE call, and the rung the rail names comes off the verdict itself.
   * `nextStage` would answer with the FOOT of the ladder for a parked lead —
   * `on_hold` is on no ladder — so parking a qualified lead offered to move it
   * back to Suspect. Reading the destination off `gateForNext` instead means
   * the sentence and the button cannot name different rungs, whatever the
   * engine decides next year.
   */
  const next = gateForNext(gateInput);

  return (
    <LeadRecordScreen workspace={workspace}
      record={record}
      tab={single(query.tab)}
      ladder={ladder}
      /* -1 for a lead standing off its own ladder, which is what a parked one
         does. The screen draws that as a park rather than as rung zero. */
      rung={rungOf(record.stage, record.salesType)}
      verdicts={ladderVerdicts(gateInput)}
      /* THE authority for the right rail. It answers `noNextRung` for a
         terminal lead AND for a parked one — `nextStage` would otherwise hand
         back the FOOT of the ladder, which offered to move a parked
         qualification back to Suspect. */
      nextVerdict={next}
      nextRung={next.noNextRung ? null : next.to}
      park={park}
      mustDecide={mustDecideSuspect(gateInput, config["leads.suspectMaxVisits"])}
      transitions={transitions}
      calls={calls}
      timeline={timeline}
      timelineKind={timelineKind}
      communications={communications}
      orders={orders}
      receipts={receipts}
      samples={samples}
      visits={visits}
      approvals={approvals}
      profile={profile}
      counts={counts}
      documents={documents}
      nurture={nurture}
      handover={handover}
      handoverReasons={config["people.amChangeReasons"]}
      discountThresholdPercent={config["leads.distributorDiscountApprovalPercent"]}
      creditLimitThresholdPaise={config["leads.distributorCreditLimitApprovalPaise"]}
      canVerify={await canLead(user, "lead.verify")}
      canWork={await canLead(user, "lead.work")}
      /* §22 — naming who RUNS the relationship, which moves no revenue and no
         target and is therefore a manager's. Moving the sales seat is the
         other act, stays accounts' and admin's under `customer.reassign`, and
         is done on the customer record. Refused by the capability in the
         action as well as here — a server action is a URL. */
      canHandOver={await canLead(user, "customer.handOver")}
      canOverride={(await canLead(user, "lead.override")) && config["leads.allowManagerOverride"]}
      overrideAllowed={config["leads.allowManagerOverride"]}
      nowMs={nowMs()}
    />
  );
}

/* ------------------------------------------------------------------ query */

function single(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * The keyset cursor, as the pair it has to be.
 *
 * `<instant>|<id>`, because a projection lands several events on one instant
 * and an instant alone excludes some of them and repeats others. Anything that
 * does not parse is read as no cursor at all — the first page is a safe answer
 * to a mangled URL, and a thrown error is not.
 */
function cursorFrom(raw: string | null): { at: string; id: string } | null {
  if (!raw) return null;
  const cut = raw.indexOf("|");
  if (cut <= 0) return null;
  const at = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  if (!id || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}
