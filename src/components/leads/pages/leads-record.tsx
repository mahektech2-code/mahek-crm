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
/* §7 — the SAME candidate list `assignLeadManager` defaults from, asked about
   this lead rather than about a region the record does not carry. A picker
   that worked out who covers Vidarbha its own way is the copy that drifts. */
import { leadManagerCandidatesFor } from "@/lib/services/lead-service";
import { LeadRecordScreen } from "@/components/leads/record/lead-record-screen";
/* §7 — the four booleans `vantagesFor` takes, read ONCE off this person's
   hats. It is a read, so it is a service; it decides WORDS and no rights, and
   every control below goes on asking its own capability for itself. */
import { vantageViewer } from "@/lib/services/lead-vantage-service";
import { isConfirmedCommitment } from "@/lib/lead-commitment";
import type { LeadActionFacts } from "@/lib/engines/lead-role-action";
import type { LeadGateActionFacts } from "@/lib/engines/lead-gate-action";
import type { SampleState } from "@/lib/lead-labels";


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
    leadManagers,
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
    leadManagerCandidatesFor(id),
  ]);

  /*
   * §5.3 — THE WINDOW IS PASSED IN, because the gate the action runs computes
   * staleness and the one this page drew did not.
   *
   * `figuresStale` is optional on the engine's input and `undefined` reads as
   * "not stale", so this page used to draw the sample rung OPEN on a lead the
   * server action would refuse the moment somebody pressed the button — a
   * refusal naming a condition the page had never shown. One reading, from
   * `figuresAreStale`, through a required argument.
   */
  const freshDays = config["leads.figuresFreshDays"];
  const gateInput = gateInputFor(record, freshDays);
  const figuresStale = Boolean(gateInput.figuresStale);

  /*
   * §11.6 — WHO MAY ANSWER THE GST CHECK ON THIS LEAD, resolved here because it
   * is the action's rule and the screen must not invent a second one.
   *
   * Two halves, both read straight off `validateGstin`. The capability OR the
   * named back office seat says who may — a team that has put somebody in that
   * seat should not have to also grant them an app for the one thing the seat
   * is for. And the lead's own owner or sales account manager may NOT, whatever
   * else they hold, because the man who wrote the number down cannot be the man
   * who certifies it; that is the entire purpose of the column.
   *
   * The sentence travels with the answer, so the disabled control's hover says
   * the same thing the action would have said.
   */
  const gstSeatOrCapability =
    record.backOfficeAmId === user.id || (await canLead(user, "lead.gstValidate"));
  const gstCollectedByMe = record.salesmanId === user.id || record.salesAmId === user.id;
  const canValidateGst = gstSeatOrCapability && !gstCollectedByMe;
  const gstBlockedReason = gstCollectedByMe
    ? "You recorded this number, so you cannot be the one who checks it. A check somebody performs on their own work is not a check — ask the back office or accounts."
    : gstSeatOrCapability
      ? null
      : "Checking a GST number is the back office's, the CRM's or the accounts desk's. Yours is not one of the hats that carries it.";
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

  /*
   * §7's five facts, resolved HERE because three of them are rules with a
   * single home and none of them is a column.
   *
   * `isConfirmedCommitment` is the pure half of the same rule the leads list
   * asks in SQL through `confirmedCommitmentSql` — one file, two spellings,
   * and a third typed into a screen is how two screens come to disagree about
   * one shop. `hasOrder` is `countingOrderCount`, which is `orderCountsSql`
   * and never a status list. `sampleAwaitingDispatch` is APPROVED and not yet
   * sent, which is the sample desk's own worklist read about one lead: a
   * REQUEST is a salesman asking, and telling the back office to dispatch
   * against one asks them to do the thing the approval step exists to stop.
   *
   * It is read off the samples already loaded rather than as a query of its
   * own. That read is capped at ten and ordered newest first, so a lead
   * carrying more than ten samples of which the only approved one is the
   * eleventh would read as nothing awaiting dispatch — the back office's own
   * worklist is where that lead is caught, and a wrong instruction is worse
   * than a missing one only when it moves stock.
   */
  const actionFacts: LeadActionFacts = {
    stage: record.stage,
    salesType: record.salesType,
    hasCommitment: isConfirmedCommitment(record),
    hasOrder: record.countingOrderCount > 0,
    sampleAwaitingDispatch: samples.some((s) => s.state === "approved"),
  };

  /*
   * §5's facts, which are §7's three plus two.
   *
   * `mustDecideSuspect` is asked ONCE and its answer used twice — by the
   * banner above the record and by the card's verb — because counting visits
   * against a cap in two places is two places for the cap to be read
   * differently. The sample STATE rather than its verdict: which of the three
   * sub-states a parcel is in decides who is being waited on, and what the
   * customer thought of it is the GATE's question, asked one file over.
   */
  const mustDecide = mustDecideSuspect(gateInput, config["leads.suspectMaxVisits"]);
  const gateFacts: LeadGateActionFacts = {
    stage: record.stage,
    salesType: record.salesType,
    mustDecide,
    hasCommitment: actionFacts.hasCommitment,
    hasOrder: actionFacts.hasOrder,
    sampleState: (record.sample?.state as SampleState | undefined) ?? null,
  };

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
      mustDecide={mustDecide}
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
      sampleReasons={config["leads.sampleReasons"]}
      /* §26's ten codes as a MANAGER may have reworded them. The action
         validates what arrives against this same setting, so a picker built
         from the literal list would offer a code the server refuses. */
      lostReasons={config["leads.lostReasons"]}
      holdReasons={config["leads.holdReasons"]}
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
      /* Moving a lead off the retired distributor ladder. `lead.override` on
         its own, and not the line below it: that one is the same capability
         AND `leads.allowManagerOverride`, which is about passing a shut gate.
         This passes none — the ladder was retired underneath these leads and
         nobody in the building can give the approval it ends at — so the
         action does not read that setting and neither does this. */
      canMigrate={await canLead(user, "lead.override")}
      /* §2 — moving a lead onto a different LADDER once it is past Prospect.
         The same capability `holdsOverride` reads inside `setLeadSalesType`,
         and deliberately not `canOverride` below it: that one is the
         capability AND `leads.allowManagerOverride`, which is about passing a
         shut gate. This passes none — it corrects which ladder a lead was
         started on, and the answers underneath it are what the reason the
         action demands is for. Below Prospect the action asks for neither, and
         the control asks for neither either. */
      canChangeLadder={await canLead(user, "lead.override")}
      /* §7 — who covers this lead's region, as the action's own default
         function answered it. The head of this list is the person
         `assignLeadManager` seats when nobody names anybody, so the picker and
         the action cannot disagree about one lead. */
      leadManagers={leadManagers}
      canOverride={(await canLead(user, "lead.override")) && config["leads.allowManagerOverride"]}
      /* §4.1 — how hard to push this lead is the manager's word, and
         `lead.verify` is the capability that already means exactly that: the
         sales manager's own judgement about a lead, which the salesman working
         it may not make about his own work. The action asks for the same one —
         a server action is a URL. See `actions/lead-priority.ts` for why
         `lead.override` and `lead.work` were the wrong two to reach for. */
      canPrioritise={await canLead(user, "lead.verify")}
      /* §11.6 — the answer and the sentence, never the rule itself. */
      canValidateGst={canValidateGst}
      gstBlockedReason={gstBlockedReason}
      /* §5.3 — the SAME boolean the engine was given, so the panel and the
         rail cannot say different things about one lead on one afternoon. */
      figuresStale={figuresStale}
      figuresFreshDays={freshDays}
      overrideAllowed={config["leads.allowManagerOverride"]}
      /* §7 — who is reading and what this lead is, so the record can say what
         it reads as to them and to the other four. Resolved on the server
         because the hats are a read and the screen is a client component. */
      viewer={await vantageViewer(user)}
      actionFacts={actionFacts}
      gateFacts={gateFacts}
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
