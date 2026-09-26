import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { canFor } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE } from "@/lib/business-date";
import { gateAction } from "@/lib/engines/lead-gate-action";
import { gateForNext, gateTo, mustDecideSuspect, checklistFor } from "@/lib/engines/lead-gates";
import { isParked } from "@/lib/engines/lead-ladder";
import { stampDate } from "@/lib/format";
import {
  COMMUNICATION_ACTIONS,
  VERIFICATION_FAILED_CODE,
  findingLabel as verificationFindingLabel,
  stageLabel,
  verificationAnswers,
} from "@/lib/lead-labels";
import { isConfirmedCommitment } from "@/lib/lead-commitment";
import { retiredLadderNote, type LeadView } from "@/lib/lead-views";
import {
  gateInputFor,
  leadCommunications,
  leadOrders,
  leadRecord,
  leadTransitions,
  managerCalls,
  publishedDocuments,
  sampleDesk,
  verificationQueue,
  type LeadOrderRow,
  type LeadRecord,
  type LeadTransition,
  type ManagerCall,
} from "@/lib/services/lead-console-service";
import { commitments, negotiationDesk } from "@/lib/services/lead-commercial-service";
import { funnelByRung, type RungFunnel } from "@/lib/services/lead-funnel-service";
import { nextActionOwnerCandidates } from "@/lib/services/lead-actions-service";
import {
  distributorProfileFor,
  leadApprovalChain,
  leadSamplesFor,
  leadTimelinePage,
  type ApprovalStep,
  type LeadSampleRow,
  type TimelineCursor,
} from "@/lib/services/lead-record-service";
import { leadTileCounts } from "@/lib/services/lead-views-service";
import { fieldTeam, leadsPage, leadsVisible, managerScope } from "@/lib/services/sales-service";

import { STAGE_LABEL, ladderFor } from "./reference";
import type {
  ApprovalStepView,
  BookTiles,
  Caps,
  Coded,
  DashboardData,
  DistributorProfile,
  FunnelBar,
  GateAction,
  Lead,
  ListData,
  ManagerKpis,
  PipelineFunnelData,
  PipelineRefs,
  PipelineRow,
  Priority,
  QualItem,
  Sample,
  SalesType,
  Stage,
  TimelineEntry,
  Verification,
  VerificationCorrection,
} from "./types";

/* ---------------------------------------------------------------------------
 * THE ONE PLACE A `customers` ROW, A SAMPLE, A VERIFICATION CALL AND A TIMELINE
 * BECOME THE `Lead` THE SALES MANAGER SCREENS DRAW.
 *
 * Nothing in here is a second opinion about a rule. Every count comes from a
 * function the real Lead Management screens already read (`leadTileCounts`,
 * `funnelByRung`, `verificationQueue`, `commitments` ...), every gate is the
 * gate engine's own verdict, and every read is narrowed by `managerScope()` +
 * `leadsVisible` exactly as `/sales/leads` narrows it — so a lead this screen
 * draws is a lead that screen would draw, and a URL is not a way past it.
 *
 * WHAT IS COMPUTED HERE AND NOT IN THE BROWSER: which button to draw and
 * whether it is enabled. The prototype derived both from the stage NAME, which
 * is exactly the copy-of-a-rule that drifts. `gateAction` (what a rung's work
 * IS) and `gateTo` (whether it MAY be done) are the two functions the record
 * page and the handset already ask; the action behind the button asks them
 * again, because a button is not a permission.
 * ------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

function clean(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function paiseToNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const SALES_TYPES = new Set(["direct", "third_party", "distributor"]);
function salesTypeOf(value: string | null | undefined): SalesType | null {
  return value && SALES_TYPES.has(value) ? (value as SalesType) : null;
}

function priorityOf(value: string | null | undefined): Priority {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

/* ═══════════════════════════════════════════════════════════════ references */

/**
 * The lists a dialog offers — configuration and the real user tables, read on
 * the server. A manager rewording a lost reason changes it here without a
 * deploy, which is why none of it is typed into a screen any more.
 */
export async function pipelineRefs(): Promise<PipelineRefs> {
  const [user, config, team, owners] = await Promise.all([
    requireUser(),
    getConfig(),
    fieldTeam(),
    nextActionOwnerCandidates(),
  ]);

  const coded = (list: { code: string; label: string }[]): Coded[] =>
    list.map((r) => ({ code: r.code, label: r.label }));

  return {
    lostReasons: coded(config["leads.lostReasons"]),
    failureReasons: coded(config["leads.verificationFailureReasons"]),
    prospectReasons: coded(config["leads.prospectReasons"]),
    sampleReasons: coded(config["leads.sampleReasons"]),
    orderBlockers: coded(config["leads.orderBlockers"]),
    /* Only people who can actually be given a book: an ACTIVE account holding
       the Salesman App. `reassignLead` refuses anybody else, so offering them
       would put the refusal after the choice. */
    salesmen: team.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
    actionOwners: owners.map((o) => ({ id: o.id, name: o.name })),
    me: { id: user.id, name: user.name },
  };
}

/* ═════════════════════════════════════════════════════════════ dashboard */

const BAND_TO_DIRECT: Partial<Record<string, Stage>> = {
  /* The legacy six-rung ladder, read as the rung it stands for. The tiles above
     the funnel already fold these the same way (`suspect,new`, `prospect,
     contacted`), so a legacy lead is counted at one rung on the bar and on the
     tile beside it. */
  new: "suspect",
  contacted: "prospect",
  qualified: "qualification",
  won: "customer",
};

const DIRECT_BARS: Stage[] = [
  "suspect",
  "prospect",
  "qualification",
  "sample_trial",
  "sample_received",
  "sample_review",
  "negotiation",
  "first_order",
  "customer",
];

function foldDirect(funnels: RungFunnel[]): FunnelBar[] {
  const counts = new Map<Stage, number>();
  const add = (stage: string, n: number) => {
    const at = (BAND_TO_DIRECT[stage] ?? stage) as Stage;
    counts.set(at, (counts.get(at) ?? 0) + n);
  };
  for (const f of funnels) {
    if (f.salesType === "distributor") continue;
    for (const r of f.rungs) add(r.stage, r.count);
    for (const [stage, cell] of Object.entries(f.arrivedByStage)) {
      /* `customer` / `won` are top rungs already listed in `rungs` for a ladder
         that has them; `arrivedByStage` is where the engine keeps the ones it
         separates. Counted once, by which map holds them. */
      if (cell && !f.rungs.some((r) => r.stage === stage)) add(stage, cell.count);
    }
  }
  return DIRECT_BARS.map((stage) => ({ stage, label: STAGE_LABEL[stage], count: counts.get(stage) ?? 0 }));
}

function distributorBars(funnels: RungFunnel[]): FunnelBar[] {
  const d = funnels.find((f) => f.salesType === "distributor");
  const ladder = ladderFor("distributor");
  return ladder.map((stage) => {
    const rung = d?.rungs.find((r) => r.stage === stage);
    const arrived = d?.arrivedByStage[stage];
    return { stage, label: STAGE_LABEL[stage], count: (rung ?? arrived)?.count ?? 0 };
  });
}

type RowExtra = {
  id: string;
  nextAction: string | null;
  nextActionOwner: string | null;
  contact: string | null;
  verified: boolean;
  desk: boolean;
};

/** The three columns a list row needs that `LeadRow` does not carry, for the ids on ONE page. */
async function rowExtras(ids: string[]): Promise<Map<string, RowExtra>> {
  if (!ids.length) return new Map();
  const rows = (await db.execute(sql`
    select c.id, c.lead_next_action as "nextAction", na.name as "nextActionOwner",
           c.contact_person as contact,
           (c.lead_verified_at is not null) as verified,
           (c.prospect_request_state in ('awaiting', 'followup')) as desk
      from customers c
      left join users na on na.id = c.lead_next_action_owner_id
     where c.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `)) as unknown as RowExtra[];
  return new Map(rows.map((r) => [r.id, r]));
}

type PageRow = Awaited<ReturnType<typeof leadsPage>>["rows"][number];

/**
 * A SHORT label for what the lead is waiting on, for a focus list that draws
 * forty of them. It is the real `gateAction` engine's verb wherever a row's own
 * columns are enough to ask it, and a plain word where they are not (which
 * sample state, for one, takes a per-lead read a list does not pay for). The
 * record page draws the full, gate-checked control; this only says where to look.
 */
function focusLabel(r: PageRow, extra: RowExtra | undefined): string | undefined {
  if (r.stage === "lost") return undefined;
  const stage = r.stage as Stage;
  if (stage === "sample_trial") return r.sampleAwaitingDispatch ? "Mark the sample dispatched" : "Follow the sample";
  if ((stage === "new" || stage === "suspect") && extra?.desk) return "Verify the calling desk's request";
  if ((stage === "prospect" || stage === "contacted") && extra?.verified) return "Move to Qualification";
  return gateAction({
    stage,
    salesType: salesTypeOf(r.salesType),
    mustDecide: false,
    hasCommitment: r.hasCommitment,
    hasOrder: r.hasOrder,
    sampleState: null,
  }).label;
}

function toRow(r: PageRow, extra: RowExtra | undefined): PipelineRow {
  const lost = r.stage === "lost";
  const due = r.nextActionDate ?? r.nextFollowUpDate ?? r.holdResumeDate ?? undefined;
  return {
    id: r.id,
    name: r.name,
    city: clean(r.city),
    contact: clean(extra?.contact),
    salesType: salesTypeOf(r.salesType),
    stage: lost ? null : (r.stage as Stage),
    lost,
    priority: priorityOf(r.priority),
    owner: r.salesmanName ?? "",
    product: clean(r.requiredProductName),
    monthlyLitres: r.monthlyVolumeLitres ?? undefined,
    potentialPaise: paiseToNumber(r.estimatedPotentialPaise),
    nextAction: clean(extra?.nextAction) ?? (r.nextFollowUpDate ? "Follow-up" : undefined),
    nextActionDate: due,
    nextActionResp: clean(extra?.nextActionOwner) ?? clean(r.leadManagerName),
    gateLabel: focusLabel(r, extra),
  };
}

async function rowsFor(page: Awaited<ReturnType<typeof leadsPage>>): Promise<PipelineRow[]> {
  const extras = await rowExtras(page.rows.map((r) => r.id));
  return page.rows.map((r) => toRow(r, extras.get(r.id)));
}

/**
 * VERIFIED PROSPECTS and VERIFICATION FAILED, which no existing screen counts
 * under either name. They are two `count(*)` filters over the ONE scoped
 * population every other figure reads, with the SAME window `lost30` uses for
 * the second — a verification that failed is the lead closing with the fixed
 * `verification_failed` reason, so it is the persisted outcome and never a
 * flag somebody could set on the screen.
 */
async function verificationCounts(day: string): Promise<{ verified: number; failed: number }> {
  const scope = await managerScope();
  const [row] = await db.execute<{ verified: number; failed: number }>(sql`
    select count(*) filter (
             where c.lead_stage::text in ('prospect', 'contacted')
               and c.lead_verified_at is not null
           )::int as verified,
           count(*) filter (
             where c.lead_stage = 'lost'
               and c.lead_lost_reason = ${VERIFICATION_FAILED_CODE}
               and c.lead_stage_since is not null
               and c.lead_stage_since >= ${day}::date - 30::int
           )::int as failed
      from customers c
     where c.lead_stage is not null
       and c.lead_archived = false
       ${leadsVisible(scope)}
  `);
  return { verified: Number(row?.verified ?? 0), failed: Number(row?.failed ?? 0) };
}

export async function pipelineTiles(day: string): Promise<BookTiles> {
  const t = await leadTileCounts(day);
  return {
    mine: t.mine,
    today: t.today,
    overdue: t.overdue,
    suspects: t.suspects,
    prospects: t.prospects,
    sample: t.sample,
    negotiation: t.negotiation,
    expected: t.expected,
    lost30: t.lost30,
  };
}

/** "Good morning, Vikram" — read off the business zone's clock, on the server, so no client ever reads one during render. */
function greetingFor(name: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: APP_TIMEZONE }).format(new Date()),
  );
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const first = name.trim().split(/\s+/)[0] || "there";
  return `Good ${part}, ${first}`;
}

export async function pipelineDashboard(day: string): Promise<DashboardData> {
  const user = await requireUser();

  const [book, queue, negotiations, board, samples, verification, funnels, overdue, dueToday, focus] =
    await Promise.all([
      pipelineTiles(day),
      verificationQueue(day, { limit: 1 }),
      negotiationDesk(day, { limit: 1 }),
      commitments(day, "open", { limit: 1 }),
      sampleDesk(day, { limit: 200 }),
      verificationCounts(day),
      funnelByRung(day),
      leadsPage(day, { view: "overdue", perPage: 6 }),
      leadsPage(day, { view: "today", perPage: 6 }),
      leadsPage(day, { view: "mine", perPage: 7 }),
    ]);

  /* Overdue first, then what is due today, capped at six — the shape the
     prototype's attention list had, drawn from the same windows the two tiles
     count. A lead in both would be listed twice, so the second list drops what
     the first already has. */
  const seen = new Set(overdue.rows.map((r) => r.id));
  const attentionRows = [...overdue.rows, ...dueToday.rows.filter((r) => !seen.has(r.id))].slice(0, 6);
  const extras = await rowExtras([...new Set([...attentionRows, ...focus.rows].map((r) => r.id))]);

  const manager: ManagerKpis = {
    pendingVerification: queue.total,
    verifiedProspects: verification.verified,
    verificationFailed: verification.failed,
    /* A sample the shop has and nobody has written a verdict on. `sampleDesk`
       is worst-first, so the received-without-feedback rows sort ahead of the
       ordinary queue and the cap does not clip them until there are two
       hundred of them. */
    sampleReviewsPending: samples.filter(
      (s) => (s.state === "received" || s.state === "trial_done") && !s.feedbackRecorded,
    ).length,
    negotiationsPending: negotiations.total,
    /* A promise is a forecast until an order arrives: still to come plus
       already slipped. `due` is a subset of `open`, so it is not added. */
    awaitingActualOrder: board.counts.open + board.counts.slipped,
    expectedThisWeek: board.counts.due,
  };

  return {
    today: day,
    greeting: greetingFor(user.name),
    book,
    manager,
    funnel: foldDirect(funnels),
    attention: attentionRows.map((r) => toRow(r, extras.get(r.id))),
    focus: focus.rows.map((r) => toRow(r, extras.get(r.id))),
  };
}

export async function pipelineFunnel(day: string): Promise<PipelineFunnelData & { retiredNote: string | null }> {
  const funnels = await funnelByRung(day);
  return {
    direct: foldDirect(funnels),
    distributor: distributorBars(funnels),
    retiredNote: retiredLadderNote(),
  };
}

/* ══════════════════════════════════════════════════════════════════ list */

const VIEWS = new Set<LeadView>(["all", "mine", "today", "overdue", "expected", "lost30"]);

export type ListParams = {
  q?: string;
  stage?: string;
  view?: string;
  due?: string;
  page?: number;
  perPage?: number;
};

export async function pipelineList(day: string, params: ListParams): Promise<ListData> {
  /* `due=today|overdue` is the prototype's own URL and a view under a
     different name; `view` is the real one. Anything unrecognised is `all`, so
     a hand-typed URL narrows to nothing rather than to something surprising. */
  const wanted = (params.view ?? params.due ?? "all") as LeadView;
  const view: LeadView = VIEWS.has(wanted) ? wanted : "all";

  const [page, book] = await Promise.all([
    leadsPage(day, {
      view,
      page: params.page,
      perPage: params.perPage ?? 25,
      filters: {
        search: clean(params.q),
        stage: clean(params.stage),
      },
    }),
    pipelineTiles(day),
  ]);

  return {
    rows: await rowsFor(page),
    total: page.total,
    listTotal: page.listTotal,
    page: page.page,
    pageCount: page.pageCount,
    perPage: page.perPage,
    book,
  };
}

/* ═════════════════════════════════════════════════════════════════ record */

type Extra = {
  createdAt: string;
  address: string | null;
  notes: string | null;
  prospectRequestState: string | null;
  holdReason: string | null;
};

/**
 * THE FIVE §5.2 ANSWERS `managerCalls` DOES NOT CARRY.
 *
 * `managerCalls` maps twelve columns of `mbos_lead_validations` back into the
 * question ids, and `0157` added five (the credit and competitor objections and
 * the three readiness answers) which that mapping was never extended for — so
 * the shared record page has never been able to show them. It is not this
 * feature's to change, so they are read here, off the same newest call, and
 * merged into the answers the summary draws from. `verificationAnswers` is the
 * mapping the write side uses; asking it for these five is exactly asking the
 * same question the form asked.
 */
async function newestCallExtras(id: string): Promise<Record<string, string>> {
  const rows = (await db.execute(sql`
    select k.credit_concern, k.competitor_concern, k.ready_for_trial,
           k.ready_for_commercial, k.ready_for_order
      from mbos_lead_validations k
     where k.customer_id = ${id}
     order by k.called_at desc, k.id desc
     limit 1
  `)) as unknown as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return {};
  return verificationAnswers({
    creditConcern: r.credit_concern,
    competitorConcern: r.competitor_concern,
    readyForTrial: r.ready_for_trial,
    readyForCommercial: r.ready_for_commercial,
    readyForOrder: r.ready_for_order,
  });
}

async function recordExtras(id: string): Promise<Extra | null> {
  const rows = (await db.execute(sql`
    select c.created_at as "createdAt", c.address, c.lead_notes as notes,
           c.prospect_request_state as "prospectRequestState",
           c.lead_hold_reason as "holdReason"
      from customers c
     where c.id = ${id}
     limit 1
  `)) as unknown as Extra[];
  return rows[0] ?? null;
}

const CONDITION_TICKABLE = new Set(["price_discussed", "delivery_discussed", "agrees_to_test", "next_step_agreed", "buyer_confirmed"]);

/** The eight (or, on a distributor, thirty) conditions the REAL gate reads, each with whether it is met. */
function qualItemsFor(record: LeadRecord, missingIds: Set<string>): QualItem[] {
  return checklistFor(record.salesType, "qualification").map((c) => ({
    id: c.id,
    says: c.says,
    done: !missingIds.has(c.id),
    /* A buyer NAMED on the record satisfies `buyer_confirmed` by value, so a tick beside it would be a box that changes nothing. */
    tickable:
      record.salesType !== "distributor" &&
      CONDITION_TICKABLE.has(c.id) &&
      !(c.id === "buyer_confirmed" && Boolean(record.buyer)),
  }));
}

function answerYes(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return /^\s*(yes|y|true)\b/i.test(v);
}

/** A concern answer: "No", "None" and "No concern" all say there is not one. */
function concern(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return !/^\s*(no|none|nil|n\/a)\b/i.test(v);
}

function verificationOf(record: LeadRecord, calls: ManagerCall[], extraAnswers: Record<string, string>): {
  verification: Verification;
  corrections: VerificationCorrection[];
} {
  const newest = calls[0];
  const done = Boolean(record.verifiedAt);
  const failed = record.stage === "lost" && record.lostReason === VERIFICATION_FAILED_CODE;

  if (!newest) {
    return { verification: { done, result: failed ? "verification_failed" : null }, corrections: [] };
  }

  const a = { ...newest.answers, ...extraAnswers };
  const corrected = newest.corrections.filter((c) => c.verdict === "corrected");
  const result: Verification["result"] = failed
    ? "verification_failed"
    : newest.verified === true
      ? corrected.length
        ? "verified_with_corrections"
        : "verified"
      : newest.verified === false
        ? "verification_failed"
        : "followup_required";

  return {
    verification: {
      done,
      result,
      visitedConfirmed: answerYes(a.visited),
      explainedWell: answerYes(a.explained),
      currentProduct: clean(a.current_product),
      competitor: clean(a.competitor),
      impression: clean(a.impression),
      genuineInterest: answerYes(a.genuine_interest),
      priceConcern: concern(a.price_issue),
      qualityConcern: concern(a.quality_issue),
      creditConcern: concern(a.credit_concern),
      serviceConcern: concern(a.service_issue),
      competitorConcern: concern(a.competitor_concern),
      readyForTrial: answerYes(a.ready_for_trial),
      readyForCommercial: answerYes(a.ready_for_commercial),
      readyForOrder: answerYes(a.ready_for_order),
      by: clean(newest.managerName),
      at: stampDate(newest.calledAt),
      followUpNote: clean(newest.followUpNote),
    },
    corrections: corrected.map((c) => ({
      field: verificationFindingLabel(c.field),
      original: c.original ?? "",
      corrected: c.corrected ?? "",
      reason: c.reason ?? "",
      changedBy: clean(c.changedByName),
      at: stampDate(c.changedAt),
    })),
  };
}

function sampleOf(row: LeadSampleRow | undefined, chase: number[], reviewChaseCount: number): Sample | undefined {
  if (!row) return undefined;
  const outcome = row.trialOutcome as Sample["trialOutcome"];
  const feedbackText = row.feedback
    ? Object.entries(row.feedback)
        .map(([k, v]) => `${k === "competitorComparison" ? "Against what they use now" : k === "priceFeedback" ? "Price" : k === "otherComments" ? "Other" : k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`)
        .join(". ")
    : undefined;
  return {
    id: row.id,
    state: row.state as Sample["state"],
    quantity: row.quantityCans ? `${row.quantityCans} can${row.quantityCans === 1 ? "" : "s"}` : undefined,
    reason: clean(row.reasonCode),
    courier: clean(row.courierName),
    docket: clean(row.trackingNumber),
    promisedDeliveryAt: row.expectedDeliveryDate ?? undefined,
    requestedAt: row.requestedDate ?? undefined,
    dispatchedAt: row.dispatchedAt ? stampDate(row.dispatchedAt) : undefined,
    receivedAt: row.receivedAt ? stampDate(row.receivedAt) : undefined,
    feedbackRecorded: Boolean(row.feedbackAt),
    feedback: feedbackText,
    trialOutcome: outcome,
    /* The chase is a real sequence — `leads.sampleReviewChaseDays` from receipt
       — and how many times it has been asked is the row's own count. Days the
       schedule would fall on are derived, never stored, and only shown once the
       shop has the parcel. */
    chase:
      row.receivedAt && !row.feedbackAt
        ? chase.map((d, i) => ({
            label: `Review chase ${i + 1}`,
            d: stampDate(new Date(new Date(row.receivedAt as Date).getTime() + d * DAY_MS)),
            done: i < reviewChaseCount,
          }))
        : [],
  };
}

function approvalSteps(chain: ApprovalStep[]): ApprovalStepView[] {
  return chain.map((s) => ({
    id: s.id,
    stepIndex: s.stepIndex,
    state: s.state,
    routeReason: clean(s.routeReason),
    requestedBy: clean(s.requestedByName),
    requestedAt: stampDate(s.requestedAt),
    approver: clean(s.approverName),
    decidedAt: s.decidedAt ? stampDate(s.decidedAt) : undefined,
    note: clean(s.decisionNote),
  }));
}

function orderOf(o: LeadOrderRow): Lead["orders"][number] {
  return {
    id: o.id,
    orderNo: clean(o.orderNo),
    amountPaise: Number(o.totalAmountPaise),
    orderedAt: stampDate(o.orderedAt),
    status: o.status,
    billNo: clean(o.billNo),
  };
}

function kindOfEvent(t: { actorName: string | null; sourceApp: string }): TimelineEntry["kind"] {
  if (!t.actorName) return "system";
  return t.sourceApp === "mbos" ? "salesman" : "sales_manager";
}

function isPending(state: string): boolean {
  return state === "pending";
}

const NOTHING_LEFT = new Set(["won", "customer", "active_distributor"]);

/** The appointment step somebody is being asked to decide, disabled for whoever the step is not theirs. */
function decideStepFor(caps: Caps) {
  return (step: ApprovalStep, label: string): GateAction => ({
    kind: "decideDistributor",
    label,
    /* Step 0 is the sales manager's and step 1 is management's — and the action
       re-checks the capability for whichever it is. */
    disabled: step.stepIndex === 0 ? !caps.canDistributorTerms : !caps.canApproveDistributor,
    note:
      step.stepIndex === 0
        ? undefined
        : "The second step is management's. A sales manager may recommend an appointment and may not make it.",
  });
}

type GateArgs = {
  record: LeadRecord;
  caps: Caps;
  deskRequest: boolean;
  mustDecide: boolean;
  freshDays: number;
  steps: ApprovalStep[];
};

/**
 * WHAT TO DRAW, decided from the real state and the real engines.
 *
 * `gateAction` says what a rung's work is; `gateForNext` / `gateTo` say whether
 * it may be done and what is missing. A shut gate draws the same control
 * DISABLED with the engine's own missing list under it — the button never
 * offers something the action would refuse without saying why.
 */
function gateUi({ record, caps, deskRequest, mustDecide, freshDays, steps }: GateArgs): GateAction {
  const stage = record.stage;
  const input = gateInputFor(record, freshDays);
  const next = gateForNext(input);
  const missingOf = (v: { missing: { says: string }[] }) => v.missing.map((c) => c.says).join("; ") || undefined;
  const engine = gateAction({
    stage,
    salesType: record.salesType,
    mustDecide,
    hasCommitment: isConfirmedCommitment({
      expectedOrderDate: record.expectedOrderDate,
      expectedOrderCans: record.expectedOrderCans,
      expectedOrderValuePaise: record.expectedOrderValuePaise,
    }),
    hasOrder: record.countingOrderCount > 0,
    sampleState: (record.sample?.state as never) ?? null,
  });

  if (stage === "lost") return { kind: "closed", label: engine.says };
  if (isParked(stage)) return { kind: "closed", label: engine.says };
  if (NOTHING_LEFT.has(stage)) return { kind: "none", label: engine.says };

  const canWork = caps.canWork;
  const decideStep = decideStepFor(caps);
  const liveSample: string | null =
    record.sample && record.sample.state !== "rejected" && record.sample.state !== "cancelled"
      ? record.sample.state
      : null;
  const sampleStep = (state: string): GateAction => {
    switch (state) {
      case "requested":
        return caps.canApproveSample
          ? { kind: "approveSample", label: "Approve or refuse the sample request", disabled: false }
          : { kind: "awaitingSampleApproval", label: "Waiting on a manager to approve the sample." };
      case "approved":
        return { kind: "markDispatched", label: "Mark the sample dispatched", disabled: !canWork };
      case "dispatched":
        return { kind: "markReceived", label: "Confirm the shop has it", disabled: !canWork };
      default:
        return {
          kind: "moveOn",
          label: `Move to ${stageLabel(next.to)}`,
          to: next.to as Stage,
          disabled: !canWork || !next.open,
          note: next.open ? undefined : missingOf(next),
        };
    }
  };
  const openStep = [...steps].reverse().find((s) => isPending(s.state));

  switch (stage) {
    case "new":
    case "suspect":
      if (deskRequest) {
        return caps.canVerify
          ? { kind: "verify", label: "Verify the calling desk's request" }
          : { kind: "awaitingVerification", label: "Awaiting manager verification" };
      }
      return { kind: "visit", label: engine.label };

    case "contacted":
    case "prospect": {
      if (!record.verifiedAt) {
        return caps.canVerify
          ? { kind: "verify", label: engine.label }
          : { kind: "awaitingVerification", label: "Awaiting manager verification" };
      }
      /* Verified. The next rung is whatever the ladder says it is, and its gate
         is the engine's — never a stage name compared here. */
      return {
        kind: "moveToQualification",
        label: `Move to ${stageLabel(next.to)}`,
        to: next.to as Stage,
        disabled: !canWork || !next.open,
        note: next.open ? undefined : missingOf(next),
      };
    }

    case "qualified":
    case "qualification": {
      if (record.salesType === "distributor") {
        /* Already put forward: the step waiting on somebody is the control. */
        if (openStep) return decideStep(openStep, engine.label);
        const g = gateTo(input, "management_review");
        return {
          kind: "submitManagement",
          label: engine.label,
          disabled: !canWork || !g.open,
          note: g.open ? undefined : missingOf(g),
        };
      }
      if (!record.salesType) {
        /* A lead raised before the funnel: no sample rung on its ladder, so
           the honest control is the plain move the ladder offers. */
        return {
          kind: "moveOn",
          label: `Move to ${stageLabel(next.to)}`,
          to: next.to as Stage,
          disabled: !canWork || !next.open,
          note: next.open ? undefined : missingOf(next),
        };
      }
      /* A parcel already in flight decides the control, whichever rung the lead
         is standing on: the sample and the rung move separately, and a request
         that is waiting must not be offered a second request. */
      if (liveSample) return sampleStep(liveSample);
      const g = gateTo(input, "sample_trial");
      return g.open
        ? { kind: "requestSample", label: engine.label, disabled: !canWork }
        : { kind: "qualify", label: "Open qualification checklist", note: missingOf(g) };
    }

    case "sample_trial":
      return liveSample ? sampleStep(liveSample) : { kind: "requestSample", label: engine.label, disabled: !canWork };

    case "sample_received":
      /* Reviewed already: what is left is the plain move, not a second review. */
      return record.sample?.feedbackRecorded
        ? {
            kind: "moveOn",
            label: `Move to ${stageLabel(next.to)}`,
            to: next.to as Stage,
            disabled: !canWork || !next.open,
            note: next.open ? undefined : missingOf(next),
          }
        : { kind: "sampleReview", label: engine.label, disabled: !canWork };

    case "sample_review":
      return {
        kind: "moveToNegotiation",
        label: engine.label,
        to: next.to as Stage,
        disabled: !canWork || !next.open,
        note: next.open ? undefined : missingOf(next),
      };

    case "negotiation": {
      if (record.countingOrderCount > 0) {
        return {
          kind: "moveOn",
          label: engine.label,
          to: next.to as Stage,
          disabled: !canWork || !next.open,
          note: next.open ? undefined : missingOf(next),
        };
      }
      const committed = isConfirmedCommitment({
        expectedOrderDate: record.expectedOrderDate,
        expectedOrderCans: record.expectedOrderCans,
        expectedOrderValuePaise: record.expectedOrderValuePaise,
      });
      return committed
        ? {
            kind: "confirmOrder",
            label: engine.label,
            note:
              "This creates a real order at “pending approval” and sends it to Accounts. It counts as a sale only once Accounts accept it — the rung follows their decision, not this button.",
            disabled: !caps.canCaptureOrder,
          }
        : { kind: "askOrder", label: engine.label };
    }

    case "first_order":
    case "delivery":
    case "payment":
    case "second_order":
      return {
        kind: "moveOn",
        label: engine.label,
        to: next.to as Stage,
        disabled: !canWork || !next.open,
        note: next.open ? undefined : missingOf(next),
      };

    case "management_review":
      return openStep ? decideStep(openStep, engine.label) : { kind: "awaitingManagement", label: engine.says };

    case "commercial_discussion":
      if (openStep) return decideStep(openStep, engine.label);
      return record.commercialTermsAgreedAt
        ? { kind: "awaitingManagement", label: "Terms agreed — waiting on management's final approval." }
        : {
            kind: "agreeTerms",
            label: "Record the agreed commercial terms",
            disabled: !caps.canDistributorTerms,
            note: caps.canDistributorTerms ? undefined : "Agreeing terms is the sales manager's own step.",
          };

    case "distributor_approval":
      if (openStep) return decideStep(openStep, engine.label);
      /* Management has said yes: what is left is the paper. `recordDistributorAgreement`
         records it AND moves the rung to the agreement stage, so this is the
         control on the rung BEFORE it. */
      if (!record.distributorApprovalApproved) return { kind: "awaitingManagement", label: engine.says };
      {
        /* Enabled, deliberately: recording that the paper was signed is a fact
           whatever the rung does next. But the rung to the agreement stage is
           gated on the signed agreement being ON FILE, and MahekOne has nowhere
           to file one yet — so the engine's own words go under the button, and
           the message after pressing it says the ladder did not move. */
        const g = gateTo(input, "distributor_agreement");
        return {
          kind: "confirmAgreement",
          label: "Record that the agreement is signed",
          disabled: !canWork,
          note: g.open ? undefined : `The rung will not move until: ${missingOf(g)}`,
        };
      }

    case "distributor_agreement":
      return {
        kind: "moveOn",
        label: engine.label,
        to: next.to as Stage,
        disabled: !canWork || !next.open,
        note: next.open ? undefined : missingOf(next),
      };

    case "initial_stock_order":
      return {
        kind: "recordInitialStock",
        label: engine.label,
        to: "active_distributor",
        disabled: !canWork || !next.open,
        note: next.open ? undefined : missingOf(next),
      };

    default:
      return { kind: "none" };
  }
}

/** The rung a lost lead was standing on, off the transition that closed it. */
function lostFrom(transitions: LeadTransition[]): LeadTransition | undefined {
  return transitions.find((t) => t.toStage === "lost");
}

export type PipelineLead = {
  lead: Lead;
  timeline: { next: TimelineCursor | null; total: number; kind: string | null; kinds: { eventType: string; n: number }[] };
};

export async function pipelineLead(
  id: string,
  day: string,
  options: { before?: TimelineCursor | null; kind?: string | null } = {},
): Promise<PipelineLead | null> {
  const user = await requireUser();

  /* Null covers both "no such lead" and "not in this manager's territory", and
     the two are deliberately the same answer: a 404 that distinguished them
     would make the URL a way to find out whose book an id belongs to. */
  const record = await leadRecord(id, day);
  if (!record) return null;

  const distributor = record.salesType === "distributor";

  const [
    config,
    extra,
    extraAnswers,
    transitions,
    calls,
    timeline,
    comms,
    docs,
    samples,
    orderRows,
    chain,
    profile,
    canWork,
    canVerify,
    canApproveSample,
    canCaptureOrder,
    canDistributorTerms,
    canApproveDistributor,
  ] = await Promise.all([
    getConfig(),
    recordExtras(id),
    newestCallExtras(id),
    leadTransitions(id),
    managerCalls(id),
    leadTimelinePage(id, { limit: 20, before: options.before, kind: options.kind }),
    leadCommunications(id),
    publishedDocuments(),
    leadSamplesFor(id),
    leadOrders(id),
    distributor ? leadApprovalChain(id) : Promise.resolve([] as ApprovalStep[]),
    distributor ? distributorProfileFor(id) : Promise.resolve(null),
    canFor(user, "lead.work"),
    canFor(user, "lead.verify"),
    canFor(user, "sample.approve"),
    canFor(user, "order.capture"),
    canFor(user, "distributor.terms"),
    canFor(user, "distributor.approve"),
  ]);

  const caps: Caps = {
    canWork,
    canVerify,
    canApproveSample,
    canCaptureOrder,
    canDistributorTerms,
    canApproveDistributor,
  };

  const freshDays = config["leads.figuresFreshDays"];
  const input = gateInputFor(record, freshDays);
  const mustDecide = mustDecideSuspect(input, config["leads.suspectMaxVisits"]);
  const deskRequest =
    ["awaiting", "followup"].includes(extra?.prospectRequestState ?? "") &&
    ["new", "suspect", "contacted"].includes(record.stage);

  /* The checklist the gate to the SAMPLE reads: what it says is missing is
     exactly what is unmet, so a tick and the gate cannot disagree. */
  const sampleGate = record.salesType === "distributor" ? gateTo(input, "management_review") : gateTo(input, "sample_trial");
  const missingIds = new Set(sampleGate.missing.map((c) => c.id));

  const lostTransition = record.stage === "lost" ? lostFrom(transitions) : undefined;
  const stage: Stage =
    record.stage === "lost"
      ? ((lostTransition?.fromStage as Stage | null) ?? "suspect")
      : (record.stage as Stage);

  const { verification, corrections } = verificationOf(record, calls, extraAnswers);
  const newestSample = samples[0];

  const conversion = transitions.find((t) => t.toStage === "prospect" && t.reasonCode);

  const p = profile;
  const distributorProfile: DistributorProfile | undefined = p
    ? {
        gstVerified: p.gstVerified === true,
        panVerified: p.panVerified === true,
        addressVerified: p.businessAddressVerified === true,
        businessType: clean(p.businessType),
        yearsInBusiness: p.yearsInBusiness ?? undefined,
        decisionMaker: clean(p.decisionMaker),
        hasDealerNetwork: p.hasDealerNetwork === true,
        activeDealers: p.activeDealerCount ?? undefined,
        territoryCovered: clean(p.territoryCovered),
        salesTeamSize: p.salesTeamSize ?? undefined,
        warehouse: p.hasWarehouse === true,
        storageCapacityLitres: p.storageCapacityLitres ?? undefined,
        exclusivityRequested: p.exclusivityRequested === true,
        creditLimitRequestedPaise: paiseToNumber(p.creditLimitRequiredPaise),
        creditDaysRequired: p.creditDaysRequired ?? undefined,
        proposedTerritory: clean(p.proposedTerritory),
        agreedDiscountPercent: paiseToNumber(p.specialDiscountPercent),
        agreedCreditLimitPaise: paiseToNumber(p.agreedCreditLimitPaise),
        exclusivityGranted: p.exclusivityGranted ?? undefined,
        termsNote: clean(p.commercialTermsNote),
        termsAgreedAt: p.commercialTermsAgreedAt ? stampDate(p.commercialTermsAgreedAt) : undefined,
      }
    : undefined;

  const steps = approvalSteps(chain);
  const open = [...chain].reverse().find((s) => isPending(s.state));

  const link = record.distributorLinks.find((l) => l.isPrimary) ?? record.distributorLinks[0];

  const lead: Lead = {
    id: record.customerId,
    name: record.name,
    city: clean(record.city),
    contact: clean(record.contactPerson),
    phone: clean(record.mobile),
    address: clean(extra?.address),
    source: clean(record.source),
    createdAt: extra ? stampDate(extra.createdAt) : "",
    salesType: salesTypeOf(record.salesType),
    stage,
    priority: priorityOf(record.priority),
    owner: record.salesmanName ?? "",
    ownerId: record.salesmanId,
    manager: record.leadManagerName ?? "",
    managerId: record.leadManagerId,
    productId: record.requiredProductId ?? undefined,
    product: clean(record.requiredProductName),
    application: clean(record.application),
    monthlyLitres: record.monthlyLitres ?? undefined,
    potentialPaise: paiseToNumber(record.potentialPaise),
    competitor: clean(record.competitor),
    decisionMaker: clean(record.decisionMaker),
    customerType: clean(record.customerType),
    gstin: clean(record.gstin),
    gstVerified: record.gstVerified,
    creditDaysWanted: record.creditDaysWanted ?? undefined,
    buyer: clean(record.buyer),
    visits: record.suspectVisitCount,
    suspectCap: config["leads.suspectMaxVisits"],
    mustDecide,
    conversionReason: conversion?.reasonCode ?? undefined,
    verification,
    verificationCorrections: corrections.length ? corrections : undefined,
    qualItems: qualItemsFor(record, missingIds),
    qualReview: record.qualificationReview
      ? {
          verdict: record.qualificationReview,
          note: clean(record.qualificationReviewNote),
          by: clean(record.qualificationReviewedByName),
          at: record.qualificationReviewedAt ? stampDate(record.qualificationReviewedAt) : undefined,
        }
      : undefined,
    sample: sampleOf(newestSample, config["leads.sampleReviewChaseDays"], newestSample?.reviewChaseCount ?? 0),
    commitment: record.expectedOrderDate
      ? {
          expectedOrderDate: record.expectedOrderDate,
          cans: record.expectedOrderCans ?? undefined,
          valuePaise: paiseToNumber(record.expectedOrderValuePaise),
          confirmed: isConfirmedCommitment({
            expectedOrderDate: record.expectedOrderDate,
            expectedOrderCans: record.expectedOrderCans,
            expectedOrderValuePaise: record.expectedOrderValuePaise,
          }),
        }
      : undefined,
    orders: orderRows.map(orderOf),
    salesmanNotes: clean(extra?.notes),
    lost:
      record.stage === "lost"
        ? {
            reason: record.lostReason ?? "",
            reasonLabel:
              config["leads.lostReasons"].find((r) => r.code === record.lostReason)?.label ?? record.lostReason ?? "No reason recorded",
            by: lostTransition?.actorName ?? "",
            date: lostTransition ? stampDate(lostTransition.at) : "",
            note: clean(lostTransition?.note),
          }
        : undefined,
    nextAction: clean(record.nextAction),
    nextActionDate: record.nextActionDate ?? undefined,
    nextActionResp: clean(record.nextActionOwnerName),
    nextActionOwnerId: record.nextActionOwnerId,
    expectedOutcome: clean(record.nextActionOutcome),
    distributorProfile,
    approval: open ? { id: open.id, stepIndex: open.stepIndex, state: open.state, reason: clean(open.routeReason) } : undefined,
    approvalSteps: steps,
    approvalThresholds: distributor
      ? {
          discountPercent: config["leads.distributorDiscountApprovalPercent"],
          creditLimitPaise: config["leads.distributorCreditLimitApprovalPaise"],
        }
      : undefined,
    distributorSalesman: clean(link?.salesmanName),
    distributor: clean(record.distributorNames ?? link?.distributorName),
    comms: comms.countByAction,
    commDocs: Object.fromEntries(
      COMMUNICATION_ACTIONS.flatMap((a) => {
        const doc = a.document ? docs[a.document] : undefined;
        return doc ? [[a.code, { id: doc.id, title: doc.title }]] : [];
      }),
    ),
    timeline: timeline.rows.map((t) => ({
      d: stampDate(t.occurredAt),
      kind: kindOfEvent(t),
      title: t.summary,
      meta: t.actorName ? `by ${t.actorName}` : undefined,
    })),
    deskRequest: deskRequest || undefined,
    gate: gateUi({ record, caps, deskRequest, mustDecide, freshDays, steps: chain }),
    caps,
  };

  return {
    lead,
    timeline: {
      next: timeline.next,
      total: timeline.total,
      kind: options.kind ?? null,
      kinds: timeline.byKind,
    },
  };
}
