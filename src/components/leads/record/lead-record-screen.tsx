"use client";

import { ParkLead } from "@/components/leads/record/park-lead";
import { OutsideLeadHub, useInLeadHub } from "@/components/leads/hub/hub-context";
import type { ActionOwnerCandidate } from "@/lib/services/lead-actions-service";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { DeleteLead } from "./delete-lead";
import * as React from "react";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import {
  FEEDBACK_FIELDS,
  VERIFICATION_QUESTIONS,
  findingLabel,
  labelOf,
  LOST_REASONS,
  OVERRIDE_REASONS,
  PROSPECT_REASONS,
  SAMPLE_REASONS,
  salesTypeLabel,
  sampleStateLabel,
  stageLabel,
  type LeadStage,
  type SampleState,
} from "@/lib/lead-labels";
import { checklistFor, type GateVerdict } from "@/lib/engines/lead-gates";
import type {
  HandoverCandidate,
  LeadOrderRow,
  LeadReceiptRow,
  LeadRecord,
  LeadCommunications,
  LeadCorrection,
  LeadTransition,
  ManagerCall,
  NurtureSchedule,
  PublishedDocument,
} from "@/lib/services/lead-console-service";
import type {
  ApprovalStep,
  DistributorProfile,
  LeadPanelCounts,
  LeadSampleRow,
  LeadVisitRow,
  ParkDetail,
  TimelinePage,
} from "@/lib/services/lead-record-service";
import { Banner, Button, Cell, HeadCell, Pill, Row, Table } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { RequestSample } from "@/components/samples/request-sample";
import { CommunicationPanel } from "../communication-panel";
import { FirstOrderPanel } from "../first-order-panel";
import { VerificationForm } from "../verification-form";
import { AdvanceStage } from "./advance-stage";
import { MarkLost } from "./mark-lost";
import { MigrateDistributor } from "./migrate-distributor";
import { LeadPriorityControl } from "./lead-priority";
import { HandoverPanel } from "./handover-panel";
import { ConfirmFigures } from "./confirm-figures";
import { ValidateGst } from "./validate-gst";
import { SetSalesType } from "./set-sales-type";
import { AssignLeadManager, type LeadManagerCandidate } from "./assign-lead-manager";
import { ReassignLead, type Assignee } from "./reassign-lead";
import { WhosUp } from "./where-it-stands";
import { CardGrid } from "@/components/ui/card-grid";
import {
  DIRECT_LADDER,
  DISTRIBUTOR_LADDER,
  LEGACY_LADDER,
  THIRD_PARTY_LADDER,
} from "@/lib/engines/lead-ladder";
import {
  Card,
  CallsVisitsCard,
  GateCard,
  KV,
  LadderStepper,
  MenuDanger,
  MoreMenu,
  NextStepCard,
  PeopleCard,
  type CallBox,
} from "./record-chrome";
import { priorityLabel, priorityTone } from "@/lib/lead-priority";
import type { DeskLeadRecord } from "@/lib/services/lead-calling-desk-service";
import { isWorkingStage, nextCallNumber, type CallOutcome } from "@/lib/engines/lead-calling-desk";
import { LogCallDialog } from "@/components/leads/calling-desk/dialogs";
import { timelineActor, type TimelineActorKind } from "./timeline-actor";
import { RelationshipChain } from "./relationship-chain";
import type { LeadActionFacts } from "@/lib/engines/lead-role-action";
import type { LeadGateActionFacts } from "@/lib/engines/lead-gate-action";
import { PrimaryGateAction } from "./move-forward";
import { ConvertButton, ConvertProvider } from "./convert-to-prospect";
import type { VantageViewer } from "@/lib/lead-vantage";

/**
 * One lead's whole record, in the order somebody reads it.
 *
 * Header — who they are and where they stand. A RIGHT RAIL that does not move
 * between tabs: the ladder with a verdict on every rung, and at the top of it
 * the one question a manager opens this page to ask, which is what the next
 * rung is waiting on. Then the tabs, each a module's worth of this record.
 *
 * **IT IS A FIXED-LENGTH PAGE, however old the account is.** Every panel is the
 * same height and scrolls inside itself, every read behind them is capped, and
 * every capped list says what it is a slice of with the count from SQL. The
 * CRM's customer record is where that rule was learned: 3,504 timeline entries
 * were serialised into the page and rendered into the DOM, so the orders, the
 * bills, the payments and the arrangement sat a hundred screens below the fold.
 * The accounts with the most history are the ones somebody most needs to read
 * before ringing, and they were the ones whose record you could reach the least
 * of.
 *
 * **It draws the verdict the engine gave it and never its own.** `ladderFor`
 * decides which rungs, `ladderVerdicts` decides what is open on each,
 * `gateForNext` decides what happens next, and all three ran on the server. A
 * screen that decided for itself which rungs a distributor climbs would be a
 * second copy inside a week, and the half that drifts is always the half
 * somebody is reading.
 *
 * **Every disabled control says why.** A capability withheld and a gate shut
 * are different refusals, and the title says which — "you cannot do this" and
 * "this cannot be done yet" send somebody to two different places.
 */

/* ---------------------------------------------------------------------------
 * The tabs.
 *
 * Nine of them, and a DISTRIBUTOR gets a different nine. A distributor is
 * appointed rather than sold to: there is no trial in the middle of it and no
 * first-order conversation either, so Samples and Commercial are replaced by
 * the thirty answers and the two-step approval chain that stand in their place.
 * Swapping rather than adding, because a Samples tab on a distributor lead is a
 * tab that can only ever be empty, and an empty tab reads as a thing nobody has
 * done rather than a thing that does not apply.
 *
 * `?tab=` is RESOLVED against this list rather than trusted: a URL is not a
 * promise, so `?tab=nonsense` has to land somewhere real, and `?tab=samples` on
 * a distributor lead names a tab that does not exist on it. The resolution is
 * here rather than in the page because a "use client" module's exports reach a
 * server component as client references rather than as the values themselves —
 * a list read on both sides would be a list read wrongly on one of them, and
 * the page needs the tab for nothing: every read behind these tabs is capped
 * and fetched whichever one is showing.
 * ------------------------------------------------------------------------- */

export type RecordTab =
  | "overview"
  | "qualification"
  | "verification"
  | "samples"
  | "commercial"
  | "profile"
  | "approval"
  | "communication"
  | "nurture"
  | "transitions"
  | "timeline";

export const RECORD_TABS: ReadonlyArray<{
  id: RecordTab;
  label: string;
  shop: boolean;
  distributor: boolean;
  /** One line on what this tab answers, on hover. */
  hint: string;
}> = [
  {
    id: "overview",
    label: "Overview",
    shop: true,
    distributor: true,
    hint: "Who has this lead, where it came from, and its visits.",
  },
  {
    id: "qualification",
    label: "Qualification",
    shop: true,
    distributor: true,
    hint: "The Qualification questions and which are answered.",
  },
  {
    id: "verification",
    label: "Verification",
    shop: true,
    distributor: true,
    hint: "The Sales Manager's check call and what the shop said.",
  },
  {
    id: "samples",
    label: "Samples",
    shop: true,
    distributor: false,
    hint: "Every sample sent and what the customer thought.",
  },
  {
    id: "commercial",
    label: "Orders & money",
    shop: true,
    distributor: false,
    hint: "Orders, bills and payments for this lead.",
  },
  {
    id: "profile",
    label: "Distributor profile",
    shop: false,
    distributor: true,
    hint: "Everything asked about the distributor candidate.",
  },
  {
    id: "approval",
    label: "Approval",
    shop: false,
    distributor: true,
    hint: "The approval steps and who decided each.",
  },
  {
    id: "communication",
    label: "Messages",
    shop: true,
    distributor: true,
    hint: "What we have sent this lead.",
  },
  {
    id: "nurture",
    label: "Follow-ups",
    shop: true,
    distributor: true,
    hint: "Follow-up tasks raised for this lead.",
  },
  {
    id: "transitions",
    label: "Stage history",
    shop: true,
    distributor: true,
    hint: "Every stage change, who made it and why.",
  },
  {
    id: "timeline",
    label: "Timeline",
    shop: true,
    distributor: true,
    hint: "Everything that has happened to this account, from every app.",
  },
];

/**
 * The rungs on which "Mark lost" is not a sentence anybody could mean.
 *
 * `lost` itself, and the three ends of a ladder — a lead standing on any of
 * those has bought something. The action would refuse a second loss on its own
 * (`same_stage`), and would accept the other three without complaint, which is
 * why they are withheld here rather than left to be refused: a control that is
 * offered and then refuses is one people press twice.
 */
const CLOSED_STAGES = new Set<LeadStage>(["lost", "won", "customer", "active_distributor"]);

/** Which of the four ladders this is, said in words rather than implied. */
function ladderName(salesType: LeadRecord["salesType"]): string {
  switch (salesType) {
    case "direct":
      return `Direct customer — ${DIRECT_LADDER.length} stages`;
    case "third_party":
      return `Third-party customer — ${THIRD_PARTY_LADDER.length} stages`;
    case "distributor":
      return `Distributor — ${DISTRIBUTOR_LADDER.length} stages`;
    default:
      return `Older lead — ${LEGACY_LADDER.length} stages`;
  }
}

export function LeadRecordScreen({
  workspace,
  record,
  tab,
  ladder,
  rung,
  verdicts,
  nextVerdict,
  nextRung,
  park,
  mustDecide,
  transitions,
  calls,
  timeline,
  timelineKind,
  communications,
  orders,
  receipts,
  samples,
  visits,
  approvals,
  profile,
  counts,
  documents,
  nurture,
  handover,
  handoverReasons,
  sampleReasons,
  sampleBlocked,
  lostReasons,
  holdReasons,
  day,
  parkCandidates,
  discountThresholdPercent,
  creditLimitThresholdPaise,
  canVerify,
  canWork,
  canHandOver,
  canMigrate,
  canChangeLadder,
  leadManagers,
  assignees,
  canReassign,
  canOverride,
  canPrioritise,
  canTrash,
  canValidateGst,
  gstBlockedReason,
  figuresStale,
  figuresFreshDays,
  overrideAllowed,
  viewer,
  actionFacts,
  gateFacts,
  nowMs,
  photoIds = [],
  requireNextAction,
  desk = null,
  defaultNextDate = null,
  openCall = false,
  prospectReasons = [],
  directPromotion = true,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  /** The shop front photographed on the handset when the lead was raised. */
  photoIds?: string[];
  /** `leads.prospectReasons`: the coded list the conversion's seventh answer is chosen from. */
  prospectReasons?: { code: string; label: string }[];
  /** `leads.callingDeskDirectPromotion`: whether converting promotes now or asks the Sales Manager. */
  directPromotion?: boolean;
  record: LeadRecord;
  /** Raw off the URL. Resolved below, because a URL is not a promise. */
  tab: string | null;
  /** `ladderFor`'s own list, resolved on the server. Never rebuilt here. */
  ladder: readonly LeadStage[];
  /** `rungOf`. -1 where the lead stands off its ladder, which a park does. */
  rung: number;
  verdicts: GateVerdict[];
  /** `gateForNext`. The ONE producer of the answer the right rail draws. */
  nextVerdict: GateVerdict;
  nextRung: LeadStage | null;
  park: ParkDetail | null;
  mustDecide: boolean;
  transitions: LeadTransition[];
  calls: ManagerCall[];
  timeline: TimelinePage;
  timelineKind: string | null;
  communications: LeadCommunications;
  orders: LeadOrderRow[];
  receipts: LeadReceiptRow[];
  samples: LeadSampleRow[];
  visits: LeadVisitRow[];
  approvals: ApprovalStep[];
  profile: DistributorProfile | null;
  counts: LeadPanelCounts;
  documents: Record<string, PublishedDocument>;
  nurture: NurtureSchedule;
  handover: HandoverCandidate[];
  handoverReasons: string[];
  /**
   * §10's configured list — the codes and the words a sample request is raised
   * against. Handed down rather than imported from `lead-labels`, because the
   * constant there is only the DEFAULT: a manager rewording one on the settings
   * screen must not find the form still offering what shipped.
   */
  sampleReasons: { code: string; label: string }[];
  /** Why a sample cannot be asked for yet, from `sampleEligibility`. Null when it can. */
  sampleBlocked: string | null;
  /** `leads.lostReasons`, resolved on the server. Never the literal list. */
  lostReasons: { code: string; label: string }[];
  /** `leads.holdReasons`, the same way and for the same reason. */
  holdReasons: { code: string; label: string }[];
  /** The business date, for the park form's default resume day. */
  day: string;
  /** Who a park's next action may be owed by. */
  parkCandidates: ActionOwnerCandidate[];
  discountThresholdPercent: number;
  creditLimitThresholdPaise: number;
  canVerify: boolean;
  canWork: boolean;
  canHandOver: boolean;
  /**
   * Whether this person may move a lead off the retired distributor ladder.
   *
   * `lead.override` alone, and deliberately NOT `canOverride` below — that one
   * is the same capability AND `leads.allowManagerOverride`, the switch a team
   * throws when it would rather a lead got stuck than got pushed past a shut
   * gate. This passes no gate: the ladder was retired underneath these leads
   * and moving them is the correction Mahek asked for, which is why the action
   * does not read that setting either. Reading it here would leave a team that
   * turned overrides off unable to clear a backlog nobody chose to have.
   */
  canMigrate: boolean;
  /**
   * §2 — whether this person may move a lead that is PAST Prospect onto a
   * different ladder. `holdsOverride` inside `setLeadSalesType` reads exactly
   * this capability, and the control mirrors the condition with the same two
   * engine functions the action runs, so a reason is asked for exactly when
   * the server is about to demand one. Below Prospect neither asks: nothing
   * has been established that the change could throw away, and making a
   * salesman find a manager to correct a first-visit mistake is how people
   * learn to raise a second lead instead.
   */
  canChangeLadder: boolean;
  /**
   * §7 — who covers this lead's region, from `leadManagerCandidatesFor`, which
   * is `assignLeadManager`'s own default function asked about this lead. The
   * head of the list is who the action seats when nobody names anybody. Empty
   * is a real answer — nobody covers this region and there is no national
   * manager — and the dialog says so rather than drawing a picker with nothing
   * in it.
   */
  leadManagers: LeadManagerCandidate[];
  /** Everyone who holds the Calling desk — the only people a lead can be handed to. */
  assignees: Assignee[];
  /** `lead.verify` and the desk, the two questions `assignDeskLead` asks. */
  canReassign: boolean;
  canOverride: boolean;
  /**
   * §4.1 — whether this person may say how hard to push the lead. The control
   * is drawn either way and DISABLED with the reason on the hover where they
   * may not: the value is the manager talking to the salesman working the
   * shop, so withholding the reading would withhold it from the one person it
   * is addressed to.
   */
  canPrioritise: boolean;
  /** May move this lead to the trash (`lead.trash`) — checked again in the action. */
  canTrash: boolean;
  /**
   * §11.6 — whether this person may answer the GST check on THIS lead.
   *
   * Resolved on the server, because it is two rules rather than one: the
   * capability or the named back office seat says who may, and the lead's own
   * owner and sales account manager are refused whatever else they hold. Both
   * halves are `validateGstin`'s, and the screen is handed the answer rather
   * than re-deriving it — a control drawn for somebody the action refuses is
   * worse than no control, because the refusal arrives after the note.
   */
  canValidateGst: boolean;
  /** Why not, in words, for the hover on the disabled control. */
  gstBlockedReason: string | null;
  /**
   * §5.3 — whether the sample gate is refusing on the age of the four figures
   * right now. The same boolean `gateInputFor` puts into the engine, passed
   * down so the panel and the rail cannot say different things about one lead.
   */
  figuresStale: boolean;
  /** `leads.figuresFreshDays`, so the panel can say how long the window is. */
  figuresFreshDays: number;
  overrideAllowed: boolean;
  /**
   * §7 — WHO IS READING, as four booleans off their hats.
   *
   * `vantageViewer` resolves it once on the server, because the hats are a
   * read and this is a client component. It decides WORDS and nothing else:
   * which of the five jobs this person is doing on this lead, and therefore
   * which sentence `roleAction` puts in front of them. Every control on this
   * page goes on asking its own capability — a sentence is not a permission.
   */
  viewer: VantageViewer;
  /**
   * The five facts `roleAction` reads, resolved on the server from the same
   * three rules the leads list resolves them from in SQL. Handed down rather
   * than derived here, because two of them — is there a confirmed commitment,
   * is there an approved sample nobody has sent — are rules with a single
   * home, and a screen re-reading either would be the second copy that drifts.
   */
  actionFacts: LeadActionFacts;
  /**
   * §5 — the five facts `gateAction` reads, to answer which control this
   * rung's work is done through. Two of them are §7's; `mustDecide` is
   * `mustDecideSuspect`'s single answer, shared with the banner above the
   * record so the cap cannot be read two ways on one page.
   */
  gateFacts: LeadGateActionFacts;
  /** The clock, read once on the server. A client may not read it in render. */
  nowMs: number;
  /** `leads.requireNextAction`, for the next-step dialog. */
  requireNextAction: boolean;
  /**
   * The Calling desk's own record of this lead, where the reader works the
   * desk — its three calls, and what the call dialog needs. Null for
   * everybody else, who are shown no Call button.
   */
  desk?: DeskLeadRecord | null;
  /** The call dialog's default next-call day, worked out on the server. */
  defaultNextDate?: string | null;
  /** `?call=1` — open the call dialog on arrival, from My day's Call. */
  openCall?: boolean;
}) {
  const [verifying, setVerifying] = React.useState(false);
  const nextCall = desk ? nextCallNumber(desk.phase) : null;
  const canCall = canWork && nextCall !== null;
  const [calling, setCalling] = React.useState(Boolean(openCall && desk && canCall));
  const deskCalls = desk
    ? {
        calls: desk.calls,
        nextDate: desk.nextAction?.kind === "message" ? null : (desk.nextAction?.date ?? null),
      }
    : null;

  const distributor = record.salesType === "distributor";
  const base = leadHref(workspace, `leads/${record.customerId}`);
  const tabs = RECORD_TABS.filter((t) => (distributor ? t.distributor : t.shop));
  const here: RecordTab = tabs.find((t) => t.id === tab)?.id ?? "overview";
  const closed = CLOSED_STAGES.has(record.stage);

  const detail =
    [record.companyName, record.city].filter(Boolean).join(" · ") || record.mobile || "—";
  const contact = [record.city, record.contactPerson, record.mobile].filter(Boolean).join(" · ");

  /* The calls box: the Calling desk's three attempts where the desk has this
     lead, numbered as the desk numbers them. */
  const callBoxes: CallBox[] = (() => {
    if (!deskCalls) return [];
    const round = deskCalls.calls.filter((c) => !c.earlier);
    const boxes: CallBox[] = [];
    for (let n = 1; n <= Math.max(3, round.length); n++) {
      const made = round.find((c) => c.callNumber === n);
      if (made) {
        boxes.push({
          n,
          state: callOutcomeLabel(made.outcome),
          tone:
            made.outcome === "spoke_collected"
              ? "success"
              : made.outcome === "spoke_callback"
                ? "warn"
                : made.outcome === "no_answer"
                  ? "neutral"
                  : "danger",
          sub: `${shortDate(made.at)} · ${made.byName}`,
        });
      } else if (n === round.length + 1 && !closed) {
        const due = deskCalls.nextDate;
        const late = due ? due < day : false;
        boxes.push({
          n,
          state: due ? (late ? "Late" : "Due") : "Next",
          tone: late ? "danger" : due ? "warn" : "neutral",
          sub: due ? `${shortDate(due)}${late ? " · late" : ""}` : "Not booked",
          hot: late,
        });
      } else {
        boxes.push({
          n,
          state: "Later",
          tone: "neutral",
          sub: n === 3 ? "Last attempt" : "—",
        });
      }
    }
    return boxes;
  })();

  const callsMade = deskCalls ? deskCalls.calls.filter((c) => !c.earlier).length : 0;

  /*
   * CONVERTING A SUSPECT. The move is the Telecaller's, through the Calling
   * desk's own action, so the control is drawn for a Suspect and DISABLED, with
   * the reason on hover, for anybody the action would refuse. Disabled is a
   * courtesy: `convertLeadToProspect` checks the desk, the capability and all
   * seven answers again on the server.
   */
  const showConvert = isWorkingStage(record.stage) && !park && !closed;
  const convertBlocked: string | null = !desk
    ? "Converting a Suspect is the Telecaller's, from the Calling desk. A Sales Manager moves it with Move to Prospect once all seven answers are in."
    : !canWork
      ? "Working a lead is the salesman's and the manager's."
      : desk.requestState === "awaiting" || desk.requestState === "followup"
        ? "This lead is already with the Sales Manager. It is not a Prospect until they verify it."
        : null;

  return (
    <ConvertProvider
      record={{
        customerId: record.customerId,
        name: record.name,
        salesType: record.salesType,
        customerType: record.customerType,
        monthlyLitres: record.monthlyLitres,
        competitor: record.competitor,
        requiredProductId: record.requiredProductId,
        requiredProductName: record.requiredProductName,
        gstin: record.gstin,
        contactPerson: record.contactPerson,
        nextAction: record.nextAction,
        nextActionDate: record.nextActionDate,
      }}
      reasons={prospectReasons}
      directPromotion={directPromotion}
      day={day}
      blocked={showConvert ? convertBlocked : "Only a Suspect is converted."}
    >
    <div className="flex flex-col gap-4 p-6">
      {/* ------------------------------------------------------- header */}
      <header className="flex flex-col gap-3">
        <Link
          href={leadHref(workspace, "leads")}
          className="self-start text-[13px] text-muted no-underline hover:text-ink hover:no-underline"
        >
          ← Leads
        </Link>
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[260px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="m-0 text-[22px] leading-7 font-semibold text-ink">{record.name}</h1>
              <Pill tone="neutral">{salesTypeLabel(record.salesType)}</Pill>
              {park ? (
                <Pill tone="warn">On hold</Pill>
              ) : (
                <Pill tone={record.stage === "lost" ? "danger" : "brand"}>
                  {stageLabel(record.stage)} · {plural(record.stuckDays, "day")}
                </Pill>
              )}
              {record.priority ? (
                <Pill tone={priorityTone(record.priority) === "warn" ? "neutral" : priorityTone(record.priority)}>
                  {priorityLabel(record.priority)}
                </Pill>
              ) : null}
            </div>
            <div className="mt-1 text-[13px] text-muted">{contact || detail}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {desk ? (
              <Button
                tone="default"
                disabled={!canCall}
                title={
                  !canWork
                    ? "Working a lead is the salesman's and the manager's."
                    : nextCall === null
                      ? "No call is due on this lead."
                      : undefined
                }
                onClick={() => setCalling(true)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="mr-1.5">
                  <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
                </svg>
                {nextCall ? `Call ${nextCall} of 3` : `${plural(callsMade, "call")} made`}
              </Button>
            ) : null}
            <Link
              href={`${base}?tab=communication`}
              className="inline-flex h-9 items-center rounded-[6px] border border-line bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas hover:text-ink hover:no-underline"
            >
              Message
            </Link>
            {showConvert ? <ConvertButton /> : null}
            <PrimaryGateAction
              workspace={workspace}
              base={base}
              facts={gateFacts}
              canVerify={canVerify}
            />
            <MoreMenu>
              <ReassignLead
                customerId={record.customerId}
                name={record.name}
                currentId={record.salesmanId}
                currentName={record.salesmanName}
                assignees={assignees}
                canReassign={canReassign}
              />
              {/* §2 — not on a distributor (`MigrateDistributor` is that path)
                  and not on a closed lead, which has no ladder left to climb. */}
              {distributor || closed ? null : (
                <SetSalesType
                  customerId={record.customerId}
                  name={record.name}
                  salesType={record.salesType}
                  stage={record.stage}
                  canWork={canWork}
                  canOverride={canChangeLadder}
                  label={record.salesType ? "Change sales type" : "Set sales type"}
                />
              )}
              {distributor && !closed ? (
                <MigrateDistributor
                  customerId={record.customerId}
                  name={record.name}
                  stage={record.stage}
                  canMigrate={canMigrate}
                />
              ) : null}
              {closed || park ? null : (
                <ParkLead
                  customerId={record.customerId}
                  name={record.name}
                  stage={record.stage}
                  day={day}
                  candidates={parkCandidates}
                  holdReasons={holdReasons}
                  defaultOwnerId={record.salesmanId}
                  canWork={canWork}
                />
              )}
              <HandoverPanel
                menu
                customerId={record.customerId}
                leadName={record.name}
                stage={record.stage}
                salesType={record.salesType}
                convertedAt={record.convertedAt}
                leadManagerName={record.leadManagerName}
                currentOwnerId={record.relationshipOwnerId}
                currentOwnerName={record.relationshipOwnerName}
                candidates={handover}
                reasonCodes={handoverReasons}
                canWork={canWork}
                canHandOver={canHandOver}
              />
              <MenuDanger>
                {/* §5.10 — closed from any active rung; never on a lead that
                    is already lost or that reached the book. */}
                {closed ? null : (
                  <MarkLost
                    customerId={record.customerId}
                    name={record.name}
                    stage={record.stage}
                    lostReasons={lostReasons}
                    canWork={canWork}
                  />
                )}
                {/* Only a lead can be deleted: an account on the book is one
                    the ledger needs. */}
                {record.stage === "customer" || record.stage === "active_distributor" ? null : (
                  <DeleteLead
                    customerId={record.customerId}
                    name={record.name}
                    canTrash={canTrash}
                    backHref={leadHref(workspace, "leads")}
                  />
                )}
              </MenuDanger>
            </MoreMenu>
          </div>
        </div>
        {photoIds.length ? (
          <div className="flex items-center gap-2">
            {photoIds.map((pid) => (
              <a key={pid} href={`/api/attachments/${pid}`} target="_blank" rel="noreferrer" title="Open the full photograph">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/attachments/${pid}`}
                  alt={`${record.name}, photographed in the field`}
                  loading="lazy"
                  className="h-12 w-12 rounded-[6px] border border-line object-cover hover:border-brand"
                />
              </a>
            ))}
          </div>
        ) : null}
      </header>

      {/* ------------------------------------------------------ ladder */}
      <LadderStepper
        ladder={ladder}
        rung={rung}
        parked={Boolean(park)}
        name={ladderName(record.salesType)}
      />

      {/* -------------------------------------------------------- tabs */}
      <nav aria-label="Record" className="flex gap-5 overflow-x-auto border-b border-line">
        {tabs.map((t) => {
          const on = t.id === here;
          const count = countFor(t.id, counts, timeline.total);
          return (
            <Link
              key={t.id}
              href={t.id === "overview" ? base : `${base}?tab=${t.id}`}
              title={t.hint}
              aria-current={on ? "page" : undefined}
              className={cx(
                "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-0.5 text-[13.5px] whitespace-nowrap no-underline hover:no-underline",
                on
                  ? "border-b-brand font-semibold text-ink hover:text-ink"
                  : "border-b-transparent font-medium text-muted hover:text-ink",
              )}
            >
              {t.label}
              {count != null ? (
                <span className="h-[18px] min-w-5 rounded-[9px] bg-divider px-1.5 text-center text-[11px] leading-[18px] font-semibold tabular-nums text-body">
                  {count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {/* ----------------------------------------------------- banners */}
      {park ? (
        <Banner
          tone="warn"
          fact
          title={[
            park.fromStage ? `On hold from ${stageLabel(park.fromStage)}` : "On hold",
            park.resumeDate ? `back on ${shortDate(park.resumeDate)}` : "no day named",
          ].join(" · ")}
          body={[
            park.reasonCode ? labelOf(holdReasons, park.reasonCode) : null,
            park.holdReason,
            park.at ? `${stamp(park.at)} · ${park.actorName ?? "somebody"}` : null,
          ]
            .filter(Boolean)
            .join(" — ") || "No reason was given."}
        />
      ) : null}
      {mustDecide ? (
        <Banner tone="warn" fact title="Out of visits" body="Decide: Prospect, or not." />
      ) : null}
      {record.lostReason ? (
        <Banner tone="danger" title="Lost" body={record.lostReason} fact />
      ) : null}

      {/* ------------------------------------------------- body + rail */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {here === "overview" ? (
            <>
              <NextStepCard
                record={record}
                active={!closed && !park}
                nowMs={nowMs}
                day={day}
                candidates={parkCandidates}
                requireNextAction={requireNextAction}
                canWork={canWork}
              />
              <GateCard
                record={record}
                base={base}
                verdict={nextVerdict}
                nextRung={nextRung}
                parked={Boolean(park)}
                canWork={canWork}
                canOverride={canOverride}
                overrideAllowed={overrideAllowed}
                fixes={FIXED_ON}
              />
              <Card
                title="Opportunity"
                action={
                  closed ? null : <ConfirmFigures customerId={record.customerId} canWork={canWork} stale={figuresStale} />
                }
              >
                <CardGrid min={150} gap="gap-x-5 gap-y-4">
                  <KV k="Customer type" v={record.customerType ?? "Not confirmed"} tone={record.customerType ? undefined : "faint"} />
                  <KV k="Decision maker" v={record.decisionMaker ?? "Not confirmed"} tone={record.decisionMaker ? undefined : "faint"} />
                  <KV k="Buyer" v={record.buyer ?? "Not confirmed"} tone={record.buyer ? undefined : "faint"} />
                  <KV
                    k="GST"
                    v={record.gstin ? (record.gstVerified ? `${record.gstin} · checked` : `${record.gstin} · not checked`) : "Not given"}
                    tone={record.gstin && record.gstVerified ? undefined : "warn"}
                  />
                  <KV k="A month" v={record.monthlyLitres ? `${record.monthlyLitres} L` : "Not confirmed"} tone={record.monthlyLitres ? undefined : "faint"} />
                  <KV k="Potential" v={record.potentialPaise ? `${money(record.potentialPaise)} / month` : "Not estimated"} tone={record.potentialPaise ? undefined : "faint"} />
                  <KV k="Credit days" v={record.creditDaysWanted ?? "Not confirmed"} tone={record.creditDaysWanted != null ? undefined : "faint"} />
                  <KV k="Product" v={record.requiredProductName ?? "Not confirmed"} tone={record.requiredProductName ? undefined : "faint"} />
                  <KV k="Using now" v={record.competitor ?? "Not confirmed"} tone={record.competitor ? undefined : "faint"} />
                  <KV k="Application" v={record.application ?? "Not confirmed"} tone={record.application ? undefined : "faint"} />
                  {record.figuresConfirmedAt ? (
                    <KV k="Figures confirmed" v={`${shortDate(record.figuresConfirmedAt.toString())}${record.figuresConfirmedByName ? ` · ${record.figuresConfirmedByName}` : ""}`} />
                  ) : null}
                </CardGrid>
              </Card>
              <CallsVisitsCard
                calls={callBoxes}
                visits={visits.map((v) => ({ date: v.visitDate, who: v.salesmanName }))}
              />
              {record.thirdParty ? (
                <RelationshipChain
                  shopName={record.name}
                  links={record.distributorLinks}
                  salesManagerName={record.salesManagerName}
                />
              ) : null}
            </>
          ) : null}

          {here === "qualification" ? (
            <>
              <QualificationPanel
                record={record}
                base={base}
                canWork={canWork}
                missing={(verdicts.find((v) => v.to === "sample_trial") ?? verdicts.find((v) => v.to === "management_review"))?.missing.map((m) => m.id) ?? []}
              />
              <FiguresPanel
                record={record}
                base={base}
                canWork={canWork}
                stale={figuresStale}
                freshDays={figuresFreshDays}
                nowMs={nowMs}
              />
              {/* Not on a distributor: its gate reads the GST check off the
                  distributor profile, which the profile tab draws. */}
              {distributor ? null : (
                <GstPanel
                  record={record}
                  canValidateGst={canValidateGst}
                  gstBlockedReason={gstBlockedReason}
                />
              )}
            </>
          ) : null}

          {here === "verification" ? (
            <VerificationPanel
              record={record}
              calls={calls}
              total={counts.calls}
              base={base}
              canVerify={canVerify}
              onStart={() => setVerifying(true)}
            />
          ) : null}

          {here === "samples" ? (
            <SamplesPanel
              workspace={workspace}
              samples={samples}
              total={counts.samples}
              record={record}
              reasons={sampleReasons}
              canWork={canWork}
              blocked={sampleBlocked}
            />
          ) : null}

          {here === "commercial" ? (
            <>
              <FirstOrderPanel
                customerId={record.customerId}
                expectedOrderDate={record.expectedOrderDate}
                expectedOrderCans={record.expectedOrderCans}
                expectedOrderValuePaise={record.expectedOrderValuePaise}
                countingOrderCount={record.countingOrderCount}
                disabled={!canWork}
                disabledReason="Working a lead is the salesman's and the manager's."
              />
              <LedgerPanel record={record} orders={orders} receipts={receipts} counts={counts} />
            </>
          ) : null}

          {here === "profile" ? (
            <DistributorProfilePanel workspace={workspace} profile={profile} record={record} />
          ) : null}

          {here === "approval" ? (
            <ApprovalPanel workspace={workspace}
              approvals={approvals}
              profile={profile}
              record={record}
              discountThresholdPercent={discountThresholdPercent}
              creditLimitThresholdPaise={creditLimitThresholdPaise}
            />
          ) : null}

          {here === "communication" ? (
            <CommunicationPanel
              customerId={record.customerId}
              documents={documents}
              history={communications}
              disabled={!canWork}
              disabledReason="Working a lead is the salesman's and the manager's."
            />
          ) : null}

          {here === "nurture" ? <NurturePanel workspace={workspace} nurture={nurture} total={counts.tasks} /> : null}

          {here === "transitions" ? (
            <HistoryPanel transitions={transitions} total={counts.transitions} base={base} />
          ) : null}

          {here === "timeline" ? (
            <TimelinePanel page={timeline} kind={timelineKind} base={base} />
          ) : null}
        </div>

        {/* ---------------------------------------------------- the rail */}
        <aside className="flex min-w-0 flex-col gap-4">
          <PeopleCard
            rows={[
              {
                k: "Owner",
                v: record.salesmanName,
                none: "Unassigned",
                warnIfNone: true,
                act: (
                  <ReassignLead
                    customerId={record.customerId}
                    name={record.name}
                    currentId={record.salesmanId}
                    currentName={record.salesmanName}
                    assignees={assignees}
                    canReassign={canReassign}
                    label="Change"
                  />
                ),
              },
              { k: "Sales manager", v: record.salesManagerName },
              {
                k: "Lead manager",
                v: record.leadManagerName,
                warnIfNone: !closed,
                act: (
                  <AssignLeadManager
                    customerId={record.customerId}
                    name={record.name}
                    currentId={record.leadManagerId}
                    currentName={record.leadManagerName}
                    candidates={leadManagers}
                    canWork={canWork}
                    label={record.leadManagerId ? "Change" : "Assign"}
                  />
                ),
              },
              { k: "Sales account mgr", v: record.salesAmName },
              { k: "Back office", v: record.backOfficeName },
              {
                k: "Relationship",
                v: record.relationshipOwnerName
                  ? `${record.relationshipOwnerName}${record.handedOverAt ? ` · ${shortDate(record.handedOverAt.toString())}` : ""}`
                  : null,
                none: "Not handed over",
              },
              {
                k: "Billed by",
                v: record.distributorNames ?? (record.thirdParty ? null : "We invoice them"),
                none: "Nobody named",
                warnIfNone: record.thirdParty,
              },
              { k: "Created by", v: record.createdByName, none: "Not recorded" },
            ]}
          />
          <Card title="Who's up">
            <WhosUp
              facts={actionFacts}
              viewer={viewer}
              seats={{
                /* `salesmanId` IS `owner_id` — the seat being matched. */
                ownerId: record.salesmanId,
                backOfficeAmId: record.backOfficeAmId,
                leadManagerId: record.leadManagerId,
                salesManagerId: record.salesManagerId,
              }}
            />
          </Card>
          <Card label="Details">
            <div className="grid grid-cols-2 gap-3.5">
              <KV k="Source" v={record.source} />
              <KV
                k="Raised"
                v={record.createdAt ? shortDate(new Date(record.createdAt).toISOString()) : "—"}
              />
              <KV
                k="Verified"
                v={record.verifiedAt ? shortDate(record.verifiedAt.toString()) : "Not yet"}
              />
              <KV k="Quiet for" v={plural(record.quietDays, "day")} />
              <div className="col-span-2">
                <LeadPriorityControl
                  compact
                  customerId={record.customerId}
                  priority={record.priority}
                  potentialPaise={record.potentialPaise}
                  canPrioritise={canPrioritise}
                />
              </div>
            </div>
          </Card>
          {here === "overview" ? null : (
            <GateRail
              record={record}
              base={base}
              verdict={nextVerdict}
              nextRung={nextRung}
              park={park}
              canWork={canWork}
              canOverride={canOverride}
              overrideAllowed={overrideAllowed}
            />
          )}
        </aside>
      </div>

      {calling && desk && defaultNextDate ? (
        <LogCallDialog
          lead={desk}
          defaultNextDate={defaultNextDate}
          today={day}
          onClose={() => setCalling(false)}
        />
      ) : null}

      {/* Keyed on the lead so the form remounts with fresh state rather than
          having an effect reset it — the React Compiler rules are on. */}
      <VerificationForm
        key={record.customerId}
        customerId={record.customerId}
        customerName={record.name}
        reviewHref={`${base}/review`}
        detail={detail}
        known={[
          record.competitor ? { label: "Using", value: record.competitor } : null,
          record.monthlyLitres
            ? { label: "A month", value: `${record.monthlyLitres} L` }
            : null,
          record.requiredProductName
            ? { label: "Wants", value: record.requiredProductName }
            : null,
          record.salesmanName ? { label: "Visited by", value: record.salesmanName } : null,
        ].filter((k): k is { label: string; value: string } => Boolean(k))}
        open={verifying}
        onClose={() => setVerifying(false)}
      />
    </div>
    </ConvertProvider>
  );
}

/** A call's outcome as the record's call box says it. */
const SHORT_OUTCOME: Record<CallOutcome, string> = {
  spoke_collected: "Spoke",
  spoke_callback: "Call back",
  no_answer: "No answer",
  wrong_number: "Wrong number",
  not_interested: "Not interested",
};
const callOutcomeLabel = (o: CallOutcome) => SHORT_OUTCOME[o] ?? o;

/** What a tab's badge counts, from SQL. Null where a count says nothing. */
function countFor(
  id: RecordTab,
  counts: LeadPanelCounts,
  timelineTotal: number,
): number | null {
  switch (id) {
    case "samples":
      return counts.samples || null;
    case "commercial":
      return counts.orders || null;
    case "approval":
      return null;
    case "communication":
      return counts.communications || null;
    case "nurture":
      return counts.tasks || null;
    case "transitions":
      return counts.transitions || null;
    case "timeline":
      return timelineTotal || null;
    case "verification":
      return counts.calls || null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ parts */

function Fact({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className="block min-w-0">
      <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        {label}
      </span>
      <span className="block text-[15px] font-medium text-ink">{value}</span>
      {sub ? <span className="block text-[12px] text-muted">{sub}</span> : null}
      {children}
    </span>
  );
}

/**
 * A panel, and it is a FIXED HEIGHT that scrolls inside itself.
 *
 * That is the whole rule this page is built on. A lead with two hundred
 * timeline entries and one with none have to draw the same page, or the panels
 * below the long one are unreachable on exactly the accounts whose panels
 * matter most. `slice` is the other half: a capped list that does not say what
 * it is part of prints what it happened to load and calls it the history.
 */
function Panel({
  title,
  hint,
  action,
  slice,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  /** "The newest 20 of 213", built from a `count(*)` and never from a length. */
  slice?: string;
  children: React.ReactNode;
}) {
  const inHub = useInLeadHub();
  return (
    <section className="flex max-h-[560px] min-h-[200px] flex-col rounded-[10px] border border-line bg-surface p-[18px]">
      <div className="mb-1 flex flex-none items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] leading-5 font-semibold text-ink">{title}</h2>
          {hint && !inHub ? (
            <p className="mt-1 max-w-[520px] text-[12px] text-pretty text-muted">{hint}</p>
          ) : null}
          {slice ? <p className="mt-1 text-xs text-muted">{slice}</p> : null}
        </div>
        {action ? <div className="flex-none">{action}</div> : null}
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/**
 * The two conditions that are answered by a CONTROL rather than by the
 * checklist, and the words that lead somebody to it.
 *
 * Two of the three are read off a column somebody else writes — the age of the
 * four conversion figures, and the back office’s check on the GST number — so
 * neither can be ticked on the qualification form, and a manager reading the
 * refusal has no way to guess where the answer is given. Keyed on the engine’s
 * own condition ids so a renamed condition drops its link rather than pointing
 * somewhere wrong.
 *
 * THE THIRD NAMES A DIFFERENT TAB, which is why the value is a pair rather
 * than a word. `sample_sent` is the gate refusing Negotiation because nothing
 * has been given to the customer to try, and the answer to it is not on the
 * qualification checklist at all — it is the request form on the Samples tab.
 * With one hard-coded destination the only way to add it would have been to
 * send somebody to the checklist and let them hunt, which is the failure this
 * map exists to end: a gate that says what it wants and gives no way to do it
 * teaches people the page is broken.
 */
const FIXED_ON: Record<string, { label: string; tab: RecordTab }> = {
  figures_fresh: { label: "Confirm them", tab: "qualification" },
  gst_verified: { label: "Check the GST", tab: "qualification" },
  sample_sent: { label: "Ask for one", tab: "samples" },
};

/**
 * THE ONE QUESTION A MANAGER OPENS THIS PAGE TO ASK.
 *
 * What is next, may it happen, and if not what is in the way — named, in words,
 * as a list of things to go and do. A refusal that does not say what it wants
 * teaches somebody to press the button again rather than to do the work, which
 * is §28's whole argument and the reason `lead-gates.ts` returns the missing
 * conditions rather than a boolean.
 *
 * The verdict is `gateForNext`'s and is computed on the server. This draws it.
 * It does not decide which rung is next, whether the rung is reachable, or
 * whether a parked lead has one — all three are the engine's, and a screen
 * answering any of them for itself is the second copy that drifts.
 */
function GateRail({
  record,
  base,
  verdict,
  nextRung,
  park,
  canWork,
  canOverride,
  overrideAllowed,
}: {
  record: LeadRecord;
  /** Where this lead lives, so a refusal can point at the screen that fixes it. */
  base: string;
  verdict: GateVerdict;
  nextRung: LeadStage | null;
  park: ParkDetail | null;
  canWork: boolean;
  canOverride: boolean;
  overrideAllowed: boolean;
}) {
  /* `noNextRung` is the engine saying the question has no answer rather than a
     negative one — a lead at the top of its ladder, a terminal one, or a parked
     one. Three different sentences, because they send somebody to three
     different places. */
  if (verdict.noNextRung) {
    return (
      <Panel title="Next stage">
        {park ? (
          <p className="text-[13px] text-pretty text-body">
            Nothing until it comes off hold. It goes back to{" "}
            {park.fromStage ? (
              <strong className="font-medium text-ink">{stageLabel(park.fromStage)}</strong>
            ) : (
              "the stage it was at"
            )}
            .
          </p>
        ) : (
          <p className="text-[13px] text-pretty text-body">
            This lead is at {stageLabel(record.stage)}, the last stage. There is nothing further
            to do.
          </p>
        )}
      </Panel>
    );
  }

  return (
    <Panel
      title="Next stage checklist"
      hint="The next stage, and what it still needs."
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium text-ink">
          {nextRung ? stageLabel(nextRung) : stageLabel(verdict.to)}
        </span>
        {verdict.open ? (
          <Pill tone="success">Open</Pill>
        ) : (
          <Pill tone="warn">{plural(verdict.missing.length, "thing")} missing</Pill>
        )}
      </div>

      {verdict.open ? (
        <p className="mb-3 text-[13px] text-pretty text-muted">
          Everything this stage needs is done.
        </p>
      ) : (
        <ul className="m-0 mb-3 list-none p-0">
          {verdict.missing.map((c) => {
            /*
             * A REFUSAL HAS TO REACH THE THING THAT LIFTS IT.
             *
             * §28's argument is that a gate which does not say what it wants
             * teaches people to press the button again; the same argument one
             * step further is that a gate which says what it wants and gives no
             * way to do it teaches them the page is broken. Most of these
             * conditions are answered on the checklist, which the tab already
             * reaches — these two are answered by a column with a control of
             * its own, on a panel somebody would otherwise have to know to go
             * and find. The rest are left as plain text rather than every line
             * being made a link that mostly goes to one place.
             */
            const fix = FIXED_ON[c.id];
            return (
              <li
                key={c.id}
                className="border-b border-divider py-1.5 text-[13px] text-warn-ink last:border-b-0"
              >
                · {c.says}
                {fix ? (
                  <>
                    {" "}
                    <Link href={`${base}?tab=${fix.tab}`} className="whitespace-nowrap underline">
                      {fix.label}
                    </Link>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-3">
        {nextRung === "prospect" ? <ConvertButton label="Convert to Prospect…" size="sm" /> : null}
        <AdvanceStage
          customerId={record.customerId}
          to={nextRung ?? null}
          verdict={verdict}
          canWork={canWork}
          canOverride={canOverride && Boolean(nextRung) && !verdict.open}
          overrideAllowed={overrideAllowed}
        />
      </div>
    </Panel>
  );
}

/**
 * §6 §9 §11 — what the salesman answered, and what is missing.
 *
 * The checklist comes from `checklistFor`, which is the SAME list the gate
 * refuses on. A screen with its own copy is how somebody ticks their way to the
 * bottom of a list and is still refused, which is the failure that makes people
 * stop trusting a checklist at all.
 *
 * Several of the twelve are answered by real columns rather than a tick, so
 * those are drawn with the value rather than a mark: a tick beside an empty
 * field is exactly the state this whole engine exists to stop. Editing them is
 * the full-size screen's job — this one is for reading.
 */
function QualificationPanel({
  record,
  base,
  canWork,
  missing,
}: {
  record: LeadRecord;
  base: string;
  canWork: boolean;
  /**
   * The condition ids the GATE says are still missing, from the server-side
   * verdict. What is DONE is read off this and nothing else: this panel used to
   * keep a map of its own — including a GST row that read "answered" the moment
   * a number existed, validated or not — and a second reading of a rule is a
   * checklist that looks finished while the gate refuses.
   */
  missing: string[];
}) {
  const conditions = checklistFor(record.salesType, "qualification");
  /* What each condition SHOWS beside it. Display only: it decides nothing. */
  const said = (key: string) => {
    const v = record.qualification?.[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const join = (parts: Array<string | null | undefined>) => parts.filter((p) => p && String(p).trim()).join(" · ");
  const shown: Record<string, string | number | null> = {
    gst_verified: record.gstin
      ? `${record.gstin}${record.gstVerified ? " · validated by the Sales Manager" : " · not yet validated"}`
      : null,
    application_understood: record.application,
    trial_plan: join([said("trial_product"), said("trial_pack"), said("trial_quantity"), said("trial_tester"), said("trial_duration")]),
    people_identified: join([
      record.decisionMaker ? `decides: ${record.decisionMaker}` : "",
      record.buyer ? `orders: ${record.buyer}` : said("buyer_name") ? `orders: ${said("buyer_name")}` : said("buyer_same") === "yes" ? "orders: the same person" : "",
      said("payer") ? `pays: ${said("payer")}` : said("payer_same") === "yes" ? "pays: the same person" : "",
    ]),
    price_and_credit: join([
      said("price_range"),
      record.creditDaysWanted != null ? `credit ${record.creditDaysWanted} days` : "",
      said("price_reaction"),
    ]),
    delivery_workable: join([said("delivery_location"), said("delivery_lead_time"), said("delivery_suits") ? `suits them: ${said("delivery_suits")}` : ""]),
    willing_to_test: said("willing_to_test"),
    next_step_dated: join([said("next_step"), said("next_step_date")]),
  };

  if (!conditions.length) {
    return (
      <Panel
        title="Qualification"
        hint="Nothing to qualify on the original ladder — these leads predate the funnel and climb the six rungs they were raised on. Nothing backfills a sales type, because guessing which of three ladders somebody was on is a decision dressed up as a migration."
      >
        <p className="text-[13px] text-muted">No checklist applies.</p>
      </Panel>
    );
  }

  const answered = conditions.filter((c) => !missing.includes(c.id));

  return (
    <Panel
      title="Qualification"
      hint={`What has to be known before anybody gives them a sample. ${answered.length} of ${conditions.length} answered — the same list the gate refuses on, so ticking to the bottom cannot leave you refused.`}
      action={
        <div className="flex flex-col items-end gap-1.5">
          <Link
            href={`${base}/review`}
            title="Every Suspect, Prospect and Qualification answer on one page, with the approver's decision"
            className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Open the review
          </Link>
          <Link
            href={`${base}/qualify`}
            title={
              canWork
                ? "Answer them at full size"
                : "You can view this, but you cannot work this lead."
            }
            className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Open the checklist
          </Link>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">
        {conditions.map((c) => {
          const ok = !missing.includes(c.id);
          const detail = shown[c.id];
          return (
            <div key={c.id} className="flex items-baseline gap-2">
              <span
                className={cx(
                  "mt-[1px] inline-block h-[7px] w-[7px] flex-none rounded-full",
                  ok ? "bg-success" : "bg-warn",
                )}
              />
              <span className="min-w-0">
                <span className="block text-[13px] text-body">{c.says}</span>
                <span className="block truncate text-[12px] text-muted">
                  {ok ? (detail != null && detail !== "" ? String(detail) : "Recorded") : "Not answered"}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/**
 * §5.3 — THE FOUR CONVERSION FIGURES, AND HOW OLD SOMEBODY'S WORD ON THEM IS.
 *
 * These four are not on the checklist above and that is deliberate — the
 * specification took them off it, because a fact established by whoever stood
 * in the shop is not re-certified later by another role. What the gate asks
 * instead is whether anybody has said recently that they still hold, and until
 * this panel existed there was nowhere on any screen to see them, see the age
 * of that word, or give it.
 *
 * **The age is the subject, not the figures.** A requirement of four hundred
 * litres is not interesting on its own; four hundred litres somebody stood
 * behind in March is a number nobody should send stock against. So the date
 * leads, in days, and the figures sit under it as what the date is about.
 *
 * **Where it is blocking, it says so and says what it blocks.** A gate refusing
 * in the rail and a panel saying nothing about it is how somebody concludes the
 * page is broken rather than that there is work to do.
 *
 * **Correcting a figure is a different act and the panel says where.** Somebody
 * who reads these and finds the requirement has doubled must not feel that
 * confirming is the only thing on offer.
 */
function FiguresPanel({
  record,
  base,
  canWork,
  stale,
  freshDays,
  nowMs,
}: {
  record: LeadRecord;
  base: string;
  canWork: boolean;
  stale: boolean;
  freshDays: number;
  /** The clock, read once on the server. A client may not read it in render. */
  nowMs: number;
}) {
  const confirmedAt = record.figuresConfirmedAt ? new Date(record.figuresConfirmedAt) : null;
  const ageDays =
    confirmedAt && !Number.isNaN(confirmedAt.getTime())
      ? Math.max(0, Math.floor((nowMs - confirmedAt.getTime()) / 86_400_000))
      : null;

  const figures: { label: string; value: string }[] = [
    {
      label: "A month",
      value: record.monthlyLitres ? `${record.monthlyLitres} L` : "Not recorded",
    },
    {
      label: "Could be worth",
      value: record.potentialPaise ? `${money(record.potentialPaise)} a month` : "Not estimated",
    },
    { label: "Wants", value: record.requiredProductName ?? "No product named" },
    { label: "Using now", value: record.competitor ?? "No competitor named" },
  ];

  return (
    <Panel
      title="The conversion figures"
      hint={
        freshDays > 0
          ? `What this shop uses, what it could be worth, what it needs and whose product it buys now. Answered once when it became a Prospect and never re-asked - so before a sample goes out, somebody has to say they still hold. They go stale after ${plural(freshDays, "day")}.`
          : "What this shop uses, what it could be worth, what it needs and whose product it buys now. Answered once when it became a Prospect and never re-asked. The staleness check is switched off on this deployment, so nothing here blocks a sample."
      }
      action={<ConfirmFigures customerId={record.customerId} canWork={canWork} stale={stale} />}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {stale ? <Pill tone="warn">Stale</Pill> : null}
        <span className="text-[13px] text-body">
          {ageDays === null ? (
            "Nobody has ever said these still hold."
          ) : (
            <>
              Confirmed {stamp(record.figuresConfirmedAt)}
              {record.figuresConfirmedByName ? ` by ${record.figuresConfirmedByName}` : ""} —{" "}
              {ageDays === 0 ? "today" : `${plural(ageDays, "day")} ago`}.
            </>
          )}
        </span>
      </div>

      {stale ? (
        <OutsideLeadHub>
        <p className="mb-3 text-[13px] text-pretty text-warn-ink">
          This is what is holding the sample. A can must not go out against a requirement that was
          true in March — read the four below, and if they still hold, say so. If one of them has
          moved, correct it on the checklist instead: confirming figures that have changed is worse
          than leaving them stale, because it puts somebody&rsquo;s name to them.
        </p>
        </OutsideLeadHub>
      ) : null}

      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {figures.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {f.label}
            </dt>
            <dd className="m-0 truncate text-[13px] text-body">{f.value}</dd>
          </div>
        ))}
      </dl>

      <OutsideLeadHub>
      <p className="mt-3 text-[12px] text-pretty text-muted">
        Confirming writes a date and a name and never a second copy of these four — a copy would be
        free to drift from the columns every other screen reads.{" "}
        <Link href={`${base}/qualify`} className="text-body underline">
          Change a figure on the checklist
        </Link>{" "}
        if one of them no longer holds.
      </p>
      </OutsideLeadHub>
    </Panel>
  );
}

/**
 * §11.6 — THE GST NUMBER, AND WHETHER ANYBODY HAS CHECKED IT.
 *
 * Three states and they are three different facts, drawn as three different
 * sentences: nobody has looked, somebody looked and it holds, somebody looked
 * and refused it with a reason. A boolean alone cannot tell the first from the
 * third, which is why `gst_verified_at` and `gst_verified_by_id` exist and why
 * this panel prints them — "GST verified: No" was the whole of what a manager
 * could learn about a lead the gate had stopped, and it sent them nowhere.
 *
 * The check is deliberately not the salesman's: he wrote the number down, and a
 * check somebody performs on their own work is not a check. The control is
 * drawn for him and disabled with that reason on the hover, because the person
 * waiting on somebody else is exactly the person who needs to see that they are
 * waiting.
 */
function GstPanel({
  record,
  canValidateGst,
  gstBlockedReason,
}: {
  record: LeadRecord;
  canValidateGst: boolean;
  gstBlockedReason: string | null;
}) {
  const has = Boolean(record.gstin?.trim());
  const looked = Boolean(record.gstVerifiedAt);
  const refused = looked && !record.gstVerified;

  return (
    <Panel
      title="GST"
      hint="Whether we could invoice this business, answered by somebody other than the man who wrote the number down. The qualification gate reads this column, so a sample waits on it."
      action={
        <ValidateGst
          customerId={record.customerId}
          name={record.name}
          gstin={record.gstin}
          verified={record.gstVerified}
          canValidate={canValidateGst}
          blockedReason={gstBlockedReason}
        />
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium text-ink">
          {has ? record.gstin : "No number recorded"}
        </span>
        {record.gstVerified ? (
          <Pill tone="success">Validated</Pill>
        ) : refused ? (
          <Pill tone="danger">Refused</Pill>
        ) : (
          <Pill tone="warn">Nobody has checked it</Pill>
        )}
      </div>

      <p className="text-[13px] text-pretty text-body">
        {!has ? (
          <>
            No GST number yet. The lead&apos;s owner enters it, and no sample can be requested until
            there is one.
          </>
        ) : looked ? (
          <>
            {refused ? "Refused" : "Validated"} {stamp(record.gstVerifiedAt)}
            {record.gstVerifiedByName ? ` by ${record.gstVerifiedByName}` : ""}.
            {refused
              ? " Correct the number and the Sales Manager can check it again. The reason is on the timeline."
              : " A sample can be requested once the Qualification is also verified."}
          </>
        ) : (
          <>
            Not checked yet. The lead&apos;s Sales Manager checks it while reviewing the Qualification;
            whoever entered it may not.
          </>
        )}
      </p>
    </Panel>
  );
}

/** §8 — what the manager asked and what the customer said, kept in full. */
function VerificationPanel({
  record,
  calls,
  total,
  base,
  canVerify,
  onStart,
}: {
  record: LeadRecord;
  calls: ManagerCall[];
  total: number;
  base: string;
  canVerify: boolean;
  onStart: () => void;
}) {
  return (
    <Panel
      title="Verification"
      hint="The verdict is worth little a month later. The answers are the point — which competitor he named is exactly what somebody needs before the negotiation call. Nothing here is written over the salesman's own answers; his stay on the lead and the shop's are stored beside them."
      slice={
        total > calls.length
          ? `The newest ${calls.length} of ${total}.`
          : total
            ? `${plural(total, "call")} in all.`
            : undefined
      }
      action={
        <div className="flex flex-col items-end gap-1.5">
          <Link
            href={`${base}/verify`}
            title={
              canVerify
                ? "The findings and the twelve questions, at full size"
                : "Only a Sales Manager can make the check call."
            }
            className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Full screen
          </Link>
          <Link
            href={`${base}/review`}
            title="Every Suspect, Prospect and Qualification answer on one page"
            className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            See all answers
          </Link>
          <Button
            size="sm"
            tone={record.verifiedAt ? "default" : "primary"}
            disabled={!canVerify}
            title={
              canVerify
                ? undefined
                : "Only a Sales Manager can make the check call."
            }
            onClick={onStart}
          >
            {calls.length ? "Call again" : "Make the call"}
          </Button>
        </div>
      }
    >
      {calls.length === 0 ? (
        <p className="text-[13px] text-muted">Nobody has rung this customer yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {calls.map((c) => (
            <div key={c.id} className="border-b border-divider pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                {c.verified === true ? (
                  <Pill tone="success">Verified</Pill>
                ) : c.verified === false ? (
                  <Pill tone="warn">Follow-up required</Pill>
                ) : (
                  <Pill tone="neutral">In progress</Pill>
                )}
                <span className="text-[12px] text-muted">
                  {stamp(c.calledAt)} · {c.managerName ?? "a manager"}
                </span>
              </div>
              {c.followUpNote ? (
                <p className="mt-1 text-[13px] whitespace-pre-wrap text-pretty text-body">
                  {c.followUpNote}
                </p>
              ) : null}
              <Corrections rows={c.corrections} />
              <dl className="mt-1.5 mb-0 grid grid-cols-1 gap-x-4 gap-y-0.5">
                {VERIFICATION_QUESTIONS.filter((q) => c.answers?.[q.id]).map((q) => (
                  <div key={q.id} className="flex gap-2 text-[12px]">
                    <dt className="flex-none text-muted">{q.ask}</dt>
                    <dd className="m-0 min-w-0 text-body">{c.answers[q.id]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/**
 * WHAT THE CALL CORRECTED, and the sentence saying it corrected nothing on the
 * lead.
 *
 * **A READER MUST NOT TAKE THIS FOR AN EDIT HISTORY.** Every other before/after
 * list in MahekOne — the account manager changes, a target's revisions — is a
 * record of a value that MOVED. This one is not: the lead still carries the
 * salesman's answer, the shop's is stored beside it, and the two disagreeing is
 * the single most useful thing the verification call produces. Drawn as a bare
 * arrow between two values it would read as the office having overwritten his
 * report, which is the one thing §8 must never do — so the words are on the
 * screen rather than left to the reader to infer.
 *
 * The two readings are LABELLED rather than separated by an arrow alone, for
 * the same reason. "Still on the lead" and "the shop says" are four words that
 * cost nothing and remove the whole ambiguity.
 */
function Corrections({ rows }: { rows: LeadCorrection[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-2 rounded-[4px] border border-divider bg-canvas px-3 py-2">
      {/* "CHECKED", not "corrected", since `0155`. The table carried only
          corrections when this panel was written, because on a validation call
          a figure the shop agreed with was not worth a row. A field check made
          in the shop is a row for all three answers, and two of them assert no
          new value — so a heading promising corrections over a confirmation is
          the screen telling somebody their own answer was overruled when it was
          upheld. The three are drawn together on purpose: a confirmation is the
          evidence that somebody asked again and got the same answer, which is
          the whole of what a second visit buys. */}
      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        What was checked
      </div>
      <OutsideLeadHub>
      <p className="mb-2 max-w-[560px] text-[12px] text-pretty text-muted">
        The lead still carries the salesman&rsquo;s own answer. These are what came back when
        somebody asked again, kept beside his rather than written over it &mdash; this is not an
        edit history.
      </p>
      </OutsideLeadHub>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          /* One column on a phone, two once there is room. A before/after side
             by side at 360px is two words a line and unreadable. */
          <div
            key={r.id}
            className={
              r.verdict === "corrected"
                ? "border-l-[3px] border-warn pl-2.5"
                : "border-l-[3px] border-divider pl-2.5"
            }>
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {findingLabel(r.field)}
              {/* The verdict in WORDS beside the field, never carried by the
                  rule's colour alone: only a correction changed anything, and
                  which of the other two it was is the difference between "we
                  asked and it stood up" and "we asked and could not establish
                  it". Those are opposite facts about the same unchanged value. */}
              <span className="ml-1.5 normal-case tracking-normal text-body">
                {r.verdict === "corrected"
                  ? "· corrected"
                  : r.verdict === "confirmed"
                    ? "· confirmed"
                    : "· could not be verified"}
              </span>
            </div>
            <div className="mt-0.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              <div className="min-w-0 text-[12px]">
                <span className="text-muted">Still on the lead: </span>
                <span className="text-body">
                  {r.original ?? <span className="text-muted">he recorded nothing</span>}
                </span>
              </div>
              {/* Only a correction asserts a new value. Drawing an empty "The
                  shop says" under a confirmation would read as the shop having
                  said nothing when it agreed. */}
              {r.verdict === "corrected" ? (
                <div className="min-w-0 text-[12px]">
                  <span className="text-muted">The shop says: </span>
                  <span className="text-ink">{r.corrected}</span>
                </div>
              ) : null}
            </div>
            {r.reason ? (
              <div className="mt-0.5 text-[12px] text-pretty text-body">{r.reason}</div>
            ) : null}
            <div className="mt-0.5 text-[12px] text-muted">
              {r.changedByName ?? "a manager"} · {stamp(r.changedAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * §15 §16 — every trial, not only the newest.
 *
 * **The three dates are kept apart, because three parties assert three things.**
 * Dispatched is us saying it went, delivered is the carrier, received is the
 * SHOP saying it is in their hands — and §J turns entirely on the third, which
 * a single delivery date could never answer. Nothing here defaults one from
 * another.
 *
 * **State and verdict are two questions.** A sample approved three weeks ago and
 * never dispatched is stock nobody gave away; one under evaluation is an
 * opportunity nobody has taken. With one column they looked identical.
 */
function SamplesPanel({
  workspace,
  samples,
  total,
  record,
  reasons,
  canWork,
  blocked,
}: {
  workspace: LeadWorkspace;
  samples: LeadSampleRow[];
  total: number;
  /**
   * The lead itself, for the two answers the request form carries FORWARD
   * rather than asking again — the product it was qualified on and what they
   * said they would use it on. Both are already columns the gate reads, so a
   * lead that has got as far as being offered a trial has answered them, and
   * asking a second time at a desk is the re-asking this product exists to
   * avoid.
   */
  record: LeadRecord;
  reasons: { code: string; label: string }[];
  canWork: boolean;
  blocked: string | null;
}) {
  return (
    <Panel
      title="Samples and trials"
      hint="Every sample, and the customer's feedback on it. We keep asking until there is an answer."
      slice={
        total > samples.length
          ? `The newest ${samples.length} of ${total}.`
          : total
            ? `${plural(total, "sample")} in all.`
            : undefined
      }
      action={
        /*
         * ASKING IS OFFERED HERE, and the desk is one link along.
         *
         * A sample is raised AGAINST a lead, and this is the only screen in the
         * console where the lead is already known — which is what lets the
         * product and the application be carried forward instead of retyped.
         * The desk answers the question after this one, what to do with the
         * requests that exist, and it has no lead in hand to default anything
         * from.
         */
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          <RequestSample
            customerId={record.customerId}
            customerName={record.name}
            defaultProductId={record.requiredProductId}
            defaultProductName={record.requiredProductName}
            defaultApplication={record.application}
            /* The rung and the ladder, so the form can say "Lead not qualified
               — Manager approval required" BEFORE the button rather than after
               it. `record.stage` is this lead's own current rung; the form asks
               `qualifiedForSample` about it and restates no rule of its own. */
            leadStage={record.stage}
            salesType={record.salesType}
            reasons={reasons}
            canWork={canWork}
            blocked={blocked}
          />
          <Link
            href={leadHref(workspace, "samples/desk")}
            className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            The desk
          </Link>
        </span>
      }
    >
      {samples.length === 0 ? (
        <p className="text-[13px] text-pretty text-muted">
          None asked for. A trial is requested on the visit where the customer asked for one — a
          sample nobody wanted is stock given away with nothing to review.
        </p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {samples.map((s) => (
            <div key={s.id} className="border-b border-divider pb-3 last:border-b-0 last:pb-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Pill tone={s.state === "reviewed" ? "success" : "brand"}>
                  {sampleStateLabel(s.state as SampleState)}
                </Pill>
                {s.trialOutcome && s.trialOutcome !== "pending" ? (
                  <Pill
                    tone={
                      s.trialOutcome === "approved"
                        ? "success"
                        : s.trialOutcome === "rejected"
                          ? "danger"
                          : "warn"
                    }
                  >
                    {s.trialOutcome.replace(/_/g, " ")}
                  </Pill>
                ) : null}
                {s.reviewChaseCount > 0 ? (
                  <Pill tone="warn">Asked {plural(s.reviewChaseCount, "time")}</Pill>
                ) : null}
                {s.cancelledAt ? <Pill tone="neutral">Cancelled</Pill> : null}
              </div>

              <div className="text-[13px] text-body">
                {s.quantityCans ? `${plural(s.quantityCans, "can")} of ` : ""}
                {s.productName ?? "a product nobody named"}
                {s.reasonCode ? ` · ${labelOf(SAMPLE_REASONS, s.reasonCode)}` : ""}
              </div>

              {/* Three dates, three parties, and each said as whose word it is. */}
              <dl className="mt-1 mb-0 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-3">
                <DateFact
                  label="We dispatched"
                  at={s.dispatchedAt}
                  absent="Not sent"
                  sub={s.courierName ?? undefined}
                />
                <DateFact label="The carrier delivered" at={s.deliveredAt} absent="No delivery recorded" />
                <DateFact
                  label="The shop has it"
                  at={s.receivedAt}
                  absent="Not confirmed by them"
                />
              </dl>

              <div className="mt-1 text-[12px] text-muted">
                {s.trialStartedAt ? `Trial started ${stamp(s.trialStartedAt)}` : "Trial not started"}
                {" · "}
                {s.trialCompletedAt
                  ? `finished ${stamp(s.trialCompletedAt)}`
                  : "not finished — the commonest way a sample goes quiet"}
              </div>

              {s.rejectionReason ? (
                <p className="mt-1 text-[12px] text-danger">Rejected: {s.rejectionReason}</p>
              ) : null}

              {s.feedback ? (
                <dl className="mt-1.5 mb-0 grid grid-cols-1 gap-x-4 gap-y-0.5">
                  {FEEDBACK_FIELDS.filter((f) => s.feedback?.[f.id]).map((f) => (
                    <div key={f.id} className="flex gap-2 text-[12px]">
                      <dt className="flex-none text-muted">{f.label}</dt>
                      <dd className="m-0 min-w-0 text-body">{s.feedback?.[f.id]}</dd>
                    </div>
                  ))}
                  {s.feedbackAt ? (
                    <div className="mt-0.5 text-[12px] text-muted">
                      {stamp(s.feedbackAt)} · {s.feedbackByName ?? "somebody"}
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="mt-1.5 text-[12px] text-warn-ink">
                  {s.feedbackAt
                    ? `Somebody opened the feedback ${stamp(s.feedbackAt)} and left all ${FEEDBACK_FIELDS.length} answers empty.`
                    : `Nothing recorded about what they thought. The whole point of a trial is the comparison, and ${FEEDBACK_FIELDS.length} answers on the desk is where it goes.`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function DateFact({
  label,
  at,
  absent,
  sub,
}: {
  label: string;
  at: Date | null;
  absent: string;
  sub?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</dt>
      <dd className={cx("m-0 text-[12px]", at ? "text-body" : "text-muted")}>
        {at ? stamp(at) : absent}
        {sub ? ` · ${sub}` : ""}
      </dd>
    </div>
  );
}

/**
 * §11 — the thirty answers, in the specification's own five groups.
 *
 * Read through `distributorProfileFor`, which ALIASES the columns rather than
 * handing over `to_jsonb(dp.*)`: that function keys the object on the physical
 * column names, and a screen reading camelCase off it sees `undefined`
 * everywhere and draws thirty unanswered questions on a profile that is full.
 */
function DistributorProfilePanel({
  workspace,
  profile,
  record,
}: {
  workspace: LeadWorkspace;
  profile: DistributorProfile | null;
  record: LeadRecord;
}) {
  const groups: Array<[string, Array<[string, React.ReactNode]>]> = profile
    ? [
        [
          "Business and legal",
          [
            ["GST verified", yesNo(profile.gstVerified)],
            ["PAN", profile.panNumber ?? "—"],
            ["PAN verified", yesNo(profile.panVerified)],
            ["Address verified", yesNo(profile.businessAddressVerified)],
            ["Business type", profile.businessType ?? "—"],
            ["Years trading", num(profile.yearsInBusiness)],
            ["Decision maker", profile.decisionMaker ?? "—"],
          ],
        ],
        [
          "Distribution capability",
          [
            ["Dealer network", yesNo(profile.hasDealerNetwork)],
            ["Active dealers", num(profile.activeDealerCount)],
            ["Territory covered", profile.territoryCovered ?? "—"],
            ["Cities", profile.citiesCovered ?? "—"],
            ["People selling", num(profile.salesTeamSize)],
            ["Delivery", profile.deliveryCapability ?? "—"],
            ["Godown", yesNo(profile.hasWarehouse)],
            [
              "Storage",
              profile.storageCapacityLitres != null
                ? `${profile.storageCapacityLitres} litres`
                : "—",
            ],
          ],
        ],
        [
          "Commercial capability",
          [
            ["Carries now", profile.productPortfolio ?? "—"],
            ["Competing brands", profile.competitorBrands ?? "—"],
            ["Monthly potential", paise(profile.monthlyPotentialPaise)],
            ["First order", paise(profile.initialOrderPotentialPaise)],
            ["Investment capacity", paise(profile.investmentCapacityPaise)],
            ["Expected monthly purchase", paise(profile.expectedMonthlyPurchasePaise)],
            [
              "Credit wanted",
              profile.creditDaysRequired != null ? `${profile.creditDaysRequired} days` : "—",
            ],
            ["Credit limit wanted", paise(profile.creditLimitRequiredPaise)],
          ],
        ],
        [
          "Territory",
          [
            ["Asking for", profile.proposedTerritory ?? "—"],
            ["Existing distributor checked", yesNo(profile.existingDistributorChecked)],
            ["Clash", yesNo(profile.territoryConflict)],
            ["What the clash is", profile.territoryConflictNote ?? "—"],
            ["Exclusivity requested", yesNo(profile.exclusivityRequested)],
          ],
        ],
        [
          "Commitment",
          [
            ["Initial stock", paise(profile.initialStockCommitmentPaise)],
            ["Monthly commitment", paise(profile.monthlyPurchaseCommitmentPaise)],
            ["Dealer development", profile.dealerDevelopmentCommitment ?? "—"],
            [
              "Would start",
              profile.expectedStartDate ? shortDate(profile.expectedStartDate) : "—",
            ],
          ],
        ],
      ]
    : [];

  return (
    <Panel
      title="Distributor profile"
      hint="§11's thirty, in its own five groups. Every one of them is a column on `distributor_profiles`, so the gate reads the row rather than a checklist — a condition cannot be ticked without the answer that satisfies it."
      action={
        <Link
          href={leadHref(workspace, `leads/${record.customerId}/qualify`)}
          className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
        >
          Answer them
        </Link>
      }
    >
      {!profile ? (
        <p className="text-[13px] text-pretty text-muted">
          Nobody has started one. A distributor is appointed rather than sold to, and the thirty
          answers are what an appointment is made on — until there is a row here, the gate to
          management review has nothing to read and refuses on all thirty.
        </p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {groups.map(([title, rows]) => (
            <div key={title}>
              <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                {title}
              </div>
              <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
                {rows.map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-[12px]">
                    <dt className="flex-none text-muted">{k}</dt>
                    <dd className="m-0 min-w-0 text-body">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Three answers, because "not answered" is not "no". */
function yesNo(v: boolean | null | undefined): React.ReactNode {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return <span className="text-muted">Not answered</span>;
}

function num(v: number | null | undefined): React.ReactNode {
  return v == null ? <span className="text-muted">Not answered</span> : String(v);
}

function paise(v: number | null | undefined): React.ReactNode {
  return v == null ? <span className="text-muted">Not answered</span> : money(v);
}

/**
 * §12 — the two-step chain, with the decider and the note on each.
 *
 * A salesman may never appoint a distributor and a manager may not do it alone.
 * What forces the second step is NAMED rather than judged: exclusivity always,
 * a discount above the configured percentage, a credit limit above the
 * configured figure — and it is stored as a code, so "how many went up on the
 * discount this year" is a question somebody can ask.
 *
 * A step with no row is a step nobody has ASKED for, which is a different thing
 * from one waiting on a signature, and the two are drawn apart.
 */
function ApprovalPanel({
  workspace,
  approvals,
  profile,
  record,
  discountThresholdPercent,
  creditLimitThresholdPaise,
}: {
  workspace: LeadWorkspace;
  approvals: ApprovalStep[];
  profile: DistributorProfile | null;
  record: LeadRecord;
  discountThresholdPercent: number;
  creditLimitThresholdPaise: number;
}) {
  const steps = [
    { index: 0, label: "The sales manager's review", detail: "The person who knows the territory." },
    {
      index: 1,
      label: "Management's appointment",
      detail: "Billable from here.",
    },
  ];

  return (
    <Panel
      title="Appointment"
      hint="Two signatures, and the person carrying the target must not be the person allowing the discount that hits it — the same reasoning that keeps order approval away from managers entirely."
      action={
        <Link
          href={leadHref(workspace, "leads/appointments")}
          className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
        >
          The queue
        </Link>
      }
    >
      <div className="flex flex-col gap-3">
        {steps.map((s) => {
          const rows = approvals.filter((a) => a.stepIndex === s.index);
          const newest = rows[rows.length - 1];
          return (
            <div key={s.index} className="border-b border-divider pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium text-ink">{s.label}</span>
                {!newest ? (
                  <Pill tone="neutral">Not asked for</Pill>
                ) : newest.state === "approved" || newest.state === "partially_approved" ? (
                  <Pill tone="success">{newest.state.replace(/_/g, " ")}</Pill>
                ) : newest.state === "rejected" ? (
                  <Pill tone="danger">Rejected</Pill>
                ) : (
                  <Pill tone="warn">{newest.state.replace(/_/g, " ")}</Pill>
                )}
              </div>
              <p className="mt-0.5 mb-0 text-[12px] text-pretty text-muted">{s.detail}</p>
              {!newest ? (
                <OutsideLeadHub>
                <p className="mt-1 mb-0 text-[12px] text-muted">
                  Nobody has put this step up yet. A step with no row and a step waiting on a
                  signature are different facts, and this is the first.
                </p>
                </OutsideLeadHub>
              ) : (
                <div className="mt-1 text-[12px] text-muted">
                  Asked by {newest.requestedByName ?? "somebody"} on {stamp(newest.requestedAt)}
                  {newest.routeReason ? ` · went up on ${newest.routeReason.replace(/_/g, " ")}` : ""}
                  {newest.decidedAt
                    ? ` · ${newest.approverName ?? "somebody"} decided ${stamp(newest.decidedAt)}`
                    : " · nobody has decided"}
                  {newest.decisionNote ? (
                    <span className="block text-body">{newest.decisionNote}</span>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}

        <div>
          <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            The terms, and whether they force a second signature
          </div>
          {!profile ? (
            <p className="text-[12px] text-muted">
              No profile, so no terms — nothing can be routed anywhere yet.
            </p>
          ) : (
            <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
              <div className="flex gap-2 text-[12px]">
                <dt className="flex-none text-muted">Discount</dt>
                <dd className="m-0 text-body">
                  {profile.specialDiscountPercent != null
                    ? `${profile.specialDiscountPercent}%`
                    : "None"}{" "}
                  <span className="text-muted">
                    (over {discountThresholdPercent}% goes to management)
                  </span>
                </dd>
              </div>
              <div className="flex gap-2 text-[12px]">
                <dt className="flex-none text-muted">Credit limit</dt>
                <dd className="m-0 text-body">
                  {paise(profile.agreedCreditLimitPaise)}{" "}
                  <span className="text-muted">
                    (over {money(creditLimitThresholdPaise)} goes to management)
                  </span>
                </dd>
              </div>
              <div className="flex gap-2 text-[12px]">
                <dt className="flex-none text-muted">Exclusivity</dt>
                <dd className="m-0 text-body">
                  {profile.exclusivityGranted === true
                    ? "Granted — always goes to management"
                    : yesNo(profile.exclusivityGranted)}
                </dd>
              </div>
              <div className="flex gap-2 text-[12px]">
                <dt className="flex-none text-muted">Terms agreed</dt>
                <dd className="m-0 text-body">
                  {profile.commercialTermsAgreedAt ? stamp(profile.commercialTermsAgreedAt) : "Not yet"}
                </dd>
              </div>
            </dl>
          )}
          <p className="mt-1.5 mb-0 text-[12px] text-muted">
            Agreement on file: {record.agreementOnFile ? "yes" : "no signed document against this account"}.
          </p>
        </div>
      </div>
    </Panel>
  );
}

/**
 * §19 §20 — what the ledger says, rendered rather than restated.
 *
 * There is no funnel-owned order status here and there must not be one.
 * `orders.status` is written by the sheet projection and by accounts'
 * approval; a second ladder over it would be overwritten every thirty minutes
 * or fill `sync_conflicts` with a disagreement nobody asked for. And an
 * `unstated` bill is shown as exactly that rather than as a balance: rendering
 * an unknown beside real ones presents it as a debt.
 */
function LedgerPanel({
  record,
  orders,
  receipts,
  counts,
}: {
  record: LeadRecord;
  orders: LeadOrderRow[];
  receipts: LeadReceiptRow[];
  counts: LeadPanelCounts;
}) {
  return (
    <Panel
      title="Orders and money"
      hint="Read off the ledger as it stands. The funnel does not write an order status — accounts and the order sheet do, and a second copy would be overwritten within the half hour."
      slice={
        counts.orders > orders.length || counts.receipts > receipts.length
          ? `The newest ${orders.length} of ${counts.orders} orders and ${receipts.length} of ${counts.receipts} receipts.`
          : `${plural(counts.orders, "order")}, ${plural(counts.receipts, "receipt")}, ${plural(counts.bills, "bill")}.`
      }
    >
      <div className="mb-3 flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
        <Fact label="Counting orders" value={String(record.countingOrderCount)} />
        <Fact label="Dispatched" value={String(record.deliveredOrderCount)} />
        <Fact label="Confirmed receipts" value={String(record.confirmedPaymentCount)} />
        <Fact
          label="Outstanding"
          value={record.outstandingPaise ? money(record.outstandingPaise) : "Nothing owing"}
        />
      </div>

      {orders.length === 0 ? (
        <p className="text-[13px] text-muted">
          No order on this account. Everything above this rung is a plan until there is one.
        </p>
      ) : (
        <Table
          minWidth={820}
          head={
            <>
              <HeadCell width={140}>Order</HeadCell>
              <HeadCell width={120}>Taken</HeadCell>
              <HeadCell align="right" width={120}>Value</HeadCell>
              <HeadCell width={140}>Status</HeadCell>
              <HeadCell width={150}>Bill</HeadCell>
              <HeadCell align="right" width={150}>Balance</HeadCell>
            </>
          }
        >
          {orders.map((o, i) => (
            <Row key={o.id} striped={i % 2 === 1}>
              <Cell truncate={140}>{o.orderNo ?? o.id.slice(0, 8)}</Cell>
              {/* The date alone: a CRM order is stamped 09:00 on the day it is
                  FOR, and printing that clock beside a name reads as a claim
                  about when somebody took the call. */}
              <Cell>{shortDate(o.orderedAt)}</Cell>
              <Cell align="right">{money(o.totalAmountPaise)}</Cell>
              <Cell>
                <Pill
                  tone={
                    o.status === "dispatched"
                      ? "success"
                      : o.status === "declined" || o.status === "cancelled"
                        ? "danger"
                        : o.status === "pending_approval"
                          ? "warn"
                          : "neutral"
                  }
                >
                  {o.status.replace(/_/g, " ")}
                </Pill>
                {o.declineReason ? (
                  <span className="block truncate text-[12px] text-muted">{o.declineReason}</span>
                ) : null}
              </Cell>
              <Cell truncate={150}>
                {o.billNo ?? <span className="text-muted">Not billed</span>}
              </Cell>
              <Cell align="right">
                {o.billAmountPaise == null ? (
                  <span className="text-muted">—</span>
                ) : o.billPaymentPosition === "unstated" ? (
                  <span
                    className="text-muted"
                    title="No payment has been recorded either way. This is not a debt and it is not settled — it is a bill nobody has spoken for."
                  >
                    Not stated
                  </span>
                ) : (
                  money(o.billAmountPaise - (o.billPaidPaise ?? 0))
                )}
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      {receipts.length ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Money against this account
          </div>
          <ul className="m-0 list-none p-0">
            {receipts.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline gap-2 border-b border-divider py-1.5 text-[13px] last:border-b-0"
              >
                <span className="font-medium text-ink">{money(r.amountPaise)}</span>
                <span className="text-muted">{shortDate(r.receivedAt)}</span>
                <span className="text-muted">{r.mode}</span>
                {r.reference ? <span className="text-muted">{r.reference}</span> : null}
                <Pill
                  tone={
                    r.status === "confirmed"
                      ? "success"
                      : r.status === "rejected" || r.status === "reversed"
                        ? "danger"
                        : "warn"
                  }
                >
                  {r.status}
                </Pill>
              </li>
            ))}
          </ul>
          <OutsideLeadHub>
          <p className="mt-1.5 text-[12px] text-muted">
            Only a confirmed receipt is money the business has seen. A reported one stops the
            chasing and moves no figure.
          </p>
          </OutsideLeadHub>
        </div>
      ) : null}
    </Panel>
  );
}

/** §13 — the schedule for this lead alone. */
function NurturePanel({
  workspace,
  nurture,
  total,
}: {
  workspace: LeadWorkspace;
  nurture: NurtureSchedule;
  total: number;
}) {
  const rows = [...nurture.overdue, ...nurture.today, ...nurture.ahead];
  const shown = rows.slice(0, 12);
  /*
   * TWO POPULATIONS, AND THE SENTENCE MAY NOT MIX THEM.
   *
   * `total` is every task ever raised on the account, done ones included; this
   * list is the OUTSTANDING ones and nothing else. "12 of 40" over that pairing
   * reads as twenty-eight open tasks hidden below the fold, which is a worse
   * lie than no sentence — so the cap is measured against the count of the
   * thing actually on the screen. Both figures are `count(*)`s: `nurture.counts`
   * for the open ones, `counts.tasks` for the account.
   */
  const open = nurture.counts.overdue + nurture.counts.today + nurture.counts.ahead;
  return (
    <Panel
      title="Nurture"
      hint="What the sequence has raised against this lead. The owner matters: the salesman and the lead manager are chased for different things about one shop, and a single list would read as one person being nagged twice."
      slice={
        open > shown.length
          ? `${shown.length} of ${plural(open, "outstanding task")}, overdue first — ${plural(total, "task")} raised on this account in all.`
          : total > open
            ? `${plural(open, "outstanding task")} of ${plural(total, "task")} raised on this account.`
            : undefined
      }
      action={
        <Link
          href={leadHref(workspace, "leads/actions/nurture")}
          className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
        >
          All of it
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nothing outstanding against this lead
          {nurture.counts.done ? `, and ${plural(nurture.counts.done, "task")} done` : ""}.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {shown.map((t) => (
            <li key={t.id} className="border-b border-divider py-1.5 last:border-b-0">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] text-body">{t.title}</span>
                {t.dueInDays != null && t.dueInDays < 0 ? (
                  <Pill tone="warn">{plural(-t.dueInDays, "day")} late</Pill>
                ) : t.dueInDays === 0 ? (
                  <Pill tone="brand">Today</Pill>
                ) : null}
              </span>
              <span className="block text-[12px] text-muted">
                {t.assignedToName ?? "unassigned"}
                {t.dueDate ? ` · ${shortDate(t.dueDate)}` : " · no day named"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** §25 — every stage move, and what a manager ignored to make one. */
function HistoryPanel({
  transitions,
  total,
  base,
}: {
  transitions: LeadTransition[];
  total: number;
  base: string;
}) {
  const reasonLists = [PROSPECT_REASONS, SAMPLE_REASONS, LOST_REASONS, OVERRIDE_REASONS];
  function reasonLabel(code: string | null) {
    if (!code) return null;
    for (const list of reasonLists) {
      const hit = list.find((r) => r.code === code);
      if (hit) return hit.label;
    }
    return labelOf(OVERRIDE_REASONS, code);
  }

  return (
    <Panel
      title="Stage history"
      hint="Every move, who made it, and under which hat. Append-only — a transition recorded wrongly is corrected by a further transition and never by an edit, because it records what somebody decided on a day and a rewrite destroys the question rather than answering it."
      slice={
        total > transitions.length
          ? `The newest ${transitions.length} of ${total}.`
          : `${plural(total, "move")} in all.`
      }
      action={
        <Link
          href={`${base}/transitions`}
          className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
        >
          At full depth
        </Link>
      }
    >
      {transitions.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing recorded. The lead is where it was raised.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {transitions.map((t) => (
            <li key={t.id} className="border-b border-divider py-2 last:border-b-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-ink">
                  {t.fromStage ? `${stageLabel(t.fromStage)} → ` : ""}
                  {stageLabel(t.toStage)}
                </span>
                {t.kind === "overridden" ? <Pill tone="warn">Overridden</Pill> : null}
                {t.kind === "reverted" ? <Pill tone="neutral">Reverted</Pill> : null}
              </span>
              <span className="block text-[12px] text-muted">
                {stamp(t.at)} · {t.actorName ?? "somebody"}
                {t.actorRole ? ` as ${t.actorRole}` : ""}
                {reasonLabel(t.reasonCode) ? ` · ${reasonLabel(t.reasonCode)}` : ""}
              </span>
              {t.note ? <span className="block text-[12px] text-body">{t.note}</span> : null}
              {t.overriddenConditions?.length ? (
                <span className="block text-[12px] text-warn-ink">
                  Ignored: {t.overriddenConditions.join(", ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * §8.5 — the three actor marks, in one place rather than a ternary at the row.
 *
 * It is an inset SHADOW and not `border-l`, because the row already carries
 * `border-b border-divider` — a shorthand that sets the colour of all four
 * sides — and a left border would then be two declarations arguing over one
 * property, settled by whichever utility Tailwind happens to emit last. A
 * shadow answers the same question and is nobody else's property.
 *
 * The weights run the way the distinction matters: the field is the brand's own
 * purple, the office a mid grey, and MahekOne's own hand the faintest rule on
 * the list — so system against person, which is the one worth buying, is the
 * one visible from furthest away. None of the three is `success`, `warn` or
 * `danger`: all three mean something else on this very screen, and a green
 * visit would read as a good visit.
 */
const ACTOR_MARK: Record<TimelineActorKind, { rule: string; name: string }> = {
  field: {
    rule: "shadow-[inset_3px_0_0_var(--color-brand)]",
    name: "text-body",
  },
  office: {
    rule: "shadow-[inset_3px_0_0_var(--color-line-strong)]",
    name: "text-body",
  },
  system: {
    rule: "shadow-[inset_3px_0_0_var(--color-divider)]",
    name: "text-muted italic",
  },
};

/**
 * §25 — the shared timeline, paged with a KEYSET and saying what it is a slice
 * of.
 *
 * **The counts are the table's own `count(*)`.** A capped read that counted
 * itself would print "12 entries" against an account with a thousand and
 * nothing on the screen would say so — which is exactly what the CRM's timeline
 * pills did before theirs came from SQL.
 *
 * **The filter asks the SERVER.** Narrowing the twenty rows the browser happens
 * to hold would answer "the orders among the newest twenty events" and print it
 * as the order history.
 *
 * **"Load older" is a LINK carrying a cursor, not an offset.** An offset
 * re-counts the rows it skips on every page and, worse, shifts by one the
 * moment anything is written — so a reader sees one entry twice and another
 * never. The cursor is `(occurred_at, id)`, a position in the sort rather than
 * a distance from the top.
 *
 * **§8.5 — EVERY ROW IS COLOURED BY WHO DID IT.** They were identical: one
 * neutral pill each and the actor as muted text at the end of a line nobody
 * reads, so on a two-hundred-entry account a salesman's visit, the office's
 * call and a nurture task nothing human touched looked the same on the one
 * screen built for reading what happened. `timelineActor` beside this file
 * works out the kind and says what it can and cannot know; see its header for
 * why two thirds of that answer is a proxy and one third is exact.
 */
function TimelinePanel({
  page,
  kind,
  base,
}: {
  page: TimelinePage;
  kind: string | null;
  base: string;
}) {
  const href = (params: Record<string, string | null>) => {
    const q = new URLSearchParams({ tab: "timeline" });
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return `${base}?${q.toString()}`;
  };

  return (
    <Panel
      title="Timeline"
      hint="Visits, calls, orders, money and complaints, from every app that touched this account."
      slice={
        kind
          ? `Showing ${page.rows.length} of the ${page.byKind.find((k) => k.eventType === kind)?.n ?? 0} ${kind} entries, of ${page.total} in all.`
          : `The newest ${page.rows.length} of ${page.total}.`
      }
    >
      <div className="mb-2 flex flex-wrap gap-1.5">
        <Link
          href={href({})}
          className={cx(
            "inline-flex items-center rounded-[9px] px-2 py-[3px] text-[11px] font-medium tracking-[0.03em] uppercase no-underline hover:no-underline",
            kind ? "bg-divider text-body" : "bg-brand-soft text-[#5223E0]",
          )}
        >
          Everything {page.total}
        </Link>
        {page.byKind.map((k) => (
          <Link
            key={k.eventType}
            href={href({ tlKind: k.eventType })}
            className={cx(
              "inline-flex items-center rounded-[9px] px-2 py-[3px] text-[11px] font-medium tracking-[0.03em] uppercase no-underline hover:no-underline",
              kind === k.eventType ? "bg-brand-soft text-[#5223E0]" : "bg-divider text-body",
            )}
          >
            {k.eventType.replace(/_/g, " ")} {k.n}
          </Link>
        ))}
      </div>

      {page.rows.length === 0 ? (
        <p className="text-[13px] text-muted">
          {kind
            ? "Nothing of that kind on this account."
            : "Nothing has happened to this account yet."}
        </p>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {page.rows.map((e) => {
              const who = timelineActor(e);
              const mark = ACTOR_MARK[who.kind];
              return (
                <li
                  key={e.id}
                  className={cx(
                    "border-b border-divider py-1.5 pl-2.5 last:border-b-0",
                    mark.rule,
                  )}
                >
                  <span className="flex flex-wrap items-baseline gap-2">
                    <Pill tone="neutral">{e.eventType.replace(/_/g, " ")}</Pill>
                    <span className="text-[13px] text-body">{e.summary}</span>
                  </span>
                  <span className="block text-[12px] text-muted">
                    {stamp(e.occurredAt)} · <span className={mark.name}>{who.name}</span> ·{" "}
                    {who.what}
                  </span>
                </li>
              );
            })}
          </ul>

          {page.next ? (
            <div className="mt-2">
              <Link
                href={href({
                  tlKind: kind,
                  tl: `${page.next.at}|${page.next.id}`,
                })}
                className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Load older
              </Link>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-muted">That is the whole of it.</p>
          )}
        </>
      )}
    </Panel>
  );
}
