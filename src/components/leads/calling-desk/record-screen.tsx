"use client";

import * as React from "react";
import Link from "next/link";
import { useToast } from "@/components/ui/toast";
import { Badge, Button, Card, Callout, Progress, SectionLabel, cx } from "@/components/ui/primitives";
import { money, shortDate, stamp } from "@/lib/format";
import { NO_ANSWER_REASONS } from "@/lib/call-outcomes";
import {
  DESK_FIELDS,
  MAX_QUALIFICATION_CALLS,
  OUTCOME_LABEL,
  answeredCount,
  isAnswered,
  isPending,
  isWorking,
  nextActionTypeLabel,
  nextCallNumber,
  questionsForCall,
  requiredProgress,
  type DeskFieldKey,
} from "@/lib/engines/lead-calling-desk";
import {
  LADDER_LABEL,
  MESSAGE_KINDS,
  daysBetween,
  displayAnswer,
  messageLabel,
  shortDay,
  stageStatus,
} from "@/lib/calling-desk-labels";
import type { DeskLeadRecord } from "@/lib/services/lead-calling-desk-service";
import {
  CallMeter,
  DeskIcon,
  KvRow,
  LeadStatusBadges,
  MetaItem,
  SectionCard,
} from "./desk-parts";
import {
  LogCallDialog,
  LostDialog,
  MessageDialog,
  NextActionDialog,
  RequestDialog,
} from "./dialogs";

type Coded = { code: string; label: string };
type Tab = "overview" | "calls" | "comms" | "timeline";
type DialogState = { kind: "call" | "message" | "next" | "request" | "lost"; preset?: string | null } | null;

/* ---------------------------------------------------------------------------
 * The Telecaller's lead record — Version 6, drawn from the real lead.
 *
 * Banners, the header card, the 3-call tracker, the next-action panel, the
 * relationship chain, the twelve-rung ladder, the required-answer progress, the
 * four tabs, the twelve-answer Opportunity grid with the manager's marks, the
 * verification card, the read-only Qualification / Sample / Order cards, and the
 * "Move this lead forward" card.
 *
 * It DECIDES NOTHING. Which phase a lead is in, which call is owed and which
 * questions are still open come out of the engine; every button here opens a
 * dialog whose write is a server action that checks the rule again. The tab is
 * the only state held on this screen.
 * ------------------------------------------------------------------------- */

export function RecordScreen({
  lead,
  canWork,
  today,
  defaultNextDate,
  prospectReasons,
  lostReasons,
  sampleReasons,
  orderBlockers,
  base,
}: {
  lead: DeskLeadRecord;
  canWork: boolean;
  /** The business day, resolved on the server — a client may not read the clock while rendering. */
  today: string;
  defaultNextDate: string;
  prospectReasons: Coded[];
  lostReasons: Coded[];
  sampleReasons: Coded[];
  orderBlockers: Coded[];
  /** `/crm/leads/calling-desk`, so the breadcrumb and back links need not spell it. */
  base: string;
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const toast = useToast();

  const phase = lead.phase;
  const working = isWorking(phase);
  const next = nextCallNumber(phase);
  const req = requiredProgress(lead.values);
  const all = answeredCount(lead.values);
  const suspect = lead.ladderIndex === 0;
  const status = stageStatus({
    phase,
    qualDone: lead.qualification?.done ?? 0,
    qualTotal: lead.qualification?.total ?? 8,
    sampleState: lead.sample?.state ?? null,
    trialOutcome: lead.sample?.trialOutcome ?? null,
    commitment: lead.commitment
      ? `${lead.commitment.cans ? `${lead.commitment.cans} cans` : ""}${
          lead.commitment.expectedDate ? ` by ${shortDate(lead.commitment.expectedDate)}` : ""
        }`.trim() || null
      : null,
    managerName: lead.managerName,
    deskName: lead.ownerName,
  });
  const open = (kind: NonNullable<DialogState>["kind"], preset?: string | null) => setDialog({ kind, preset });
  /* The desk's own words where the desk closed it; the configured label it was filed under otherwise. */
  const lostReasonLabel =
    lead.lost?.deskLabel ??
    (lead.lost?.reasonCode
      ? (lostReasons.find((r) => r.code === lead.lost!.reasonCode)?.label ?? lead.lost.reasonCode)
      : null);
  const canCall = canWork && next !== null;
  const canRequest = canWork && (phase === "ready" || phase === "returned");
  const canClose = canWork && (working || phase === "ready" || phase === "returned" || phase === "exhausted");
  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ["calls", "Call history"],
    ["comms", "Communication"],
    ["timeline", "Timeline"],
  ];

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <div className="mb-2.5 text-[12.5px] text-muted">
        <Link href={base} className="hover:text-brand">
          All Leads
        </Link>{" "}
        / {lead.name}
      </div>

      {/* --------------------------------------------------- the banners */}
      {lead.lost ? (
        <Callout tone="danger">
          <div>
            <b>This lead is marked Lost.</b>
            {lostReasonLabel ? ` Reason: ${lostReasonLabel}` : ""}
            {lead.lost.byName ? ` · by ${lead.lost.byName}` : ""}
            {lead.lost.at ? ` on ${shortDay(lead.lost.at)}` : ""}. The record, every answer and the call
            history are kept, unchanged.
            {lead.lost.detail ? (
              <div className="mt-1 text-[12.5px] opacity-90">“{lead.lost.detail}”</div>
            ) : null}
          </div>
        </Callout>
      ) : null}

      {!lead.lost && phase === "ready" ? (
        <Card className="mb-4 flex flex-wrap items-center gap-4 border-l-[3px] border-l-success px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium tracking-[0.04em] text-success uppercase">Ready for Prospect</div>
            <div className="text-sm font-medium text-ink">
              Every required answer is in after {lead.callCount} call{lead.callCount === 1 ? "" : "s"} — no more
              calls needed.
            </div>
            <div className="text-[12.5px] text-muted">
              Requesting a Prospect sends the lead, with everything collected, to the Sales Manager. It becomes a
              Prospect only when they verify it.
            </div>
          </div>
          <Button variant="primary" disabled={!canRequest} onClick={() => open("request")}>
            Request Prospect
          </Button>
        </Card>
      ) : null}

      {!lead.lost && phase === "requested" ? (
        <Callout tone="warn">
          <div>
            <b>Prospect requested</b>
            {lead.requestedAt ? ` on ${shortDay(lead.requestedAt)}` : ""} — awaiting verification by{" "}
            {lead.managerName ?? "the Sales Manager"}. It is not a Prospect yet; the ladder stays on Suspect until
            the Sales Manager confirms it.
          </div>
        </Callout>
      ) : null}
      {!lead.lost && phase === "followup" ? (
        <Callout tone="warn">
          <div>
            <b>Manager follow-up required.</b> {lead.managerNote ?? "Verification is on hold."} Nothing to do here
            until the Sales Manager decides.
          </div>
        </Callout>
      ) : null}
      {!lead.lost && phase === "returned" ? (
        <Callout tone="danger">
          <div>
            <b>Returned — verification failed.</b> {lead.managerNote ?? ""} Resubmit if the position has changed,
            or mark the lead Lost.
          </div>
        </Callout>
      ) : null}
      {!lead.lost && phase === "prospect" ? (
        <Callout tone="brand">
          <div>
            <b>Prospect confirmed</b> by {lead.managerName ?? "the Sales Manager"}
            {lead.stageDates.prospect ? ` on ${shortDate(lead.stageDates.prospect)}` : ""}. It is with the Sales
            Manager now; the Telecaller&rsquo;s part is done.
          </div>
        </Callout>
      ) : null}

      {/* ------------------------------------------------ the header card */}
      <Card className="mb-4 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xl font-semibold text-ink">{lead.name}</span>
              <LeadStatusBadges salesType={lead.salesType} phase={phase} priority={lead.priority} />
            </div>
            <div className="mt-0.5 text-[13px] text-muted">
              {lead.reference} · created {shortDay(lead.createdAt)} · source: {lead.source}
            </div>
          </div>
          <div className="flex flex-none gap-2">
            {working && next ? (
              <Button size="sm" variant="primary" disabled={!canCall} onClick={() => open("call")}>
                <DeskIcon name="phone" size={14} />
                Start call {next} / {MAX_QUALIFICATION_CALLS}
              </Button>
            ) : null}
            {working || phase === "ready" ? (
              <Button size="sm" variant="secondary" disabled={!canWork} onClick={() => open("message")}>
                <DeskIcon name="chat" size={14} />
                Message
              </Button>
            ) : null}
            {/* V6's Edit is a stub too ("Edit form omitted from this design pass"). It must NOT
                navigate: the only place it could go is the Sales Manager's lead screens, which is
                the old record this desk replaces. An answer is corrected by logging a call. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                toast.push("Editing lead details is not built on the desk yet. Correct an answer by logging a call.")
              }
            >
              Edit
            </Button>
            {!lead.lost && canClose ? (
              <Button size="sm" variant="secondary" className="text-danger" onClick={() => open("lost")}>
                Mark Lost
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-divider pt-3 sm:grid-cols-3 lg:grid-cols-7">
          <MetaItem
            label="Stage"
            value={
              lead.lost
                ? `Lost${lead.ladderIndex >= 0 ? ` at ${LADDER_LABEL[lead.ladder[lead.ladderIndex]]}` : ""}`
                : lead.ladderIndex >= 0
                  ? LADDER_LABEL[lead.ladder[lead.ladderIndex]]
                  : "—"
            }
          />
          <MetaItem label="Owner" value={lead.ownerName} />
          <MetaItem label="Sales manager" value={lead.requestedAt ? lead.managerName : "Assigned when requested"} />
          <MetaItem label="City" value={lead.city} />
          <MetaItem label="Contact" value={lead.contactPerson} />
          <MetaItem label="Phone" value={lead.phone} />
          <MetaItem label="Product" value={lead.productName} />
        </div>
      </Card>

      {/* ------------------------------------------------- the 3-call rule */}
      <div className="mb-1.5 flex items-center justify-between">
        <SectionLabel>The 3-call rule</SectionLabel>
        <CallMeter phase={phase} outcomes={lead.calls.map((c) => c.outcome)} size="lg" />
      </div>
      <Card className="mb-4 px-5 py-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[1, 2, 3].map((n) => {
            const call = lead.calls[n - 1];
            const isNext = next === n;
            const finished = !working;
            return (
              <div
                key={n}
                className={cx(
                  "rounded-[6px] border px-4 py-3",
                  call ? "border-line bg-canvas" : isNext ? "border-brand bg-brand-soft" : "border-dashed border-line-strong",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink">
                    Call {n} / {MAX_QUALIFICATION_CALLS}
                  </span>
                  {call ? (
                    <Badge
                      tone={
                        call.outcome === "spoke_collected"
                          ? "success"
                          : call.outcome === "spoke_callback"
                            ? "brand"
                            : call.outcome === "no_answer"
                              ? "warn"
                              : "danger"
                      }
                    >
                      {OUTCOME_LABEL[call.outcome]}
                    </Badge>
                  ) : isNext ? (
                    <Badge tone="brand">Next</Badge>
                  ) : (
                    <Badge tone="muted">{finished ? "Not needed" : "Later"}</Badge>
                  )}
                </div>
                <div className="mt-1 text-[12.5px] text-muted">
                  {call
                    ? `${stamp(call.at)} · ${call.answers.length} new answer${call.answers.length === 1 ? "" : "s"}`
                    : isNext
                      ? lead.nextAction?.date
                        ? `Due ${shortDate(lead.nextAction.date)}`
                        : "Ready to make"
                      : finished
                        ? "Not used"
                        : "Only if the earlier calls do not finish the job"}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 mb-0 text-[12.5px] text-muted">
          At most {MAX_QUALIFICATION_CALLS} calls. All required answers within them →{" "}
          <b className="text-success">Ready for Prospect</b>. Calls used up without them →{" "}
          <b className="text-danger">Lost</b>. Messages do not use a call.
        </p>
      </Card>

      {/* ------------------------------------------------- next action */}
      {!lead.lost ? <NextActionPanel lead={lead} canWork={canWork} today={today} onEdit={() => open("next")} /> : null}

      {/* ------------------------------------------------- relationship */}
      {lead.chain ? (
        <Card className="mb-4 px-5 py-4">
          <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Relationship chain</div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <RelNode role="End customer" name={lead.name} sub={lead.city} />
            <span className="text-muted">→</span>
            <RelNode role="Distributor salesman" name={lead.chain.salesman} />
            <span className="text-muted">→</span>
            <RelNode role="Distributor" name={lead.chain.distributor} sub="Bills this account" />
            <span className="text-muted">→</span>
            <RelNode role="Mahek sales manager" name={lead.managerName} highlight />
          </div>
          <p className="mt-3 mb-0 text-[12.5px] text-muted">
            Commercial authority stays with the distributor — Mahek&rsquo;s role here is coverage and support, not the
            invoice.
          </p>
        </Card>
      ) : null}

      {/* ------------------------------------------------ the ladder */}
      <LadderCard lead={lead} status={status} />

      {/* ------------------------------------ required-answer progress */}
      {suspect ? (
        <>
          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel>Qualification progress</SectionLabel>
          </div>
          <Card className="mb-5 px-5 py-4">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="min-w-[220px] flex-1">
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-sm font-medium text-ink">
                    Required answers {req.done} / {req.total}
                  </span>
                  <span className="text-[12px] text-muted">
                    {all.done} of {all.total} questions answered in all
                  </span>
                </div>
                <Progress value={(req.done / req.total) * 100} tone={req.complete ? "success" : "brand"} />
              </div>
              <div className="text-[12.5px] text-muted">
                {req.complete ? (
                  <span className="font-medium text-success">Complete — nothing left to ask.</span>
                ) : (
                  <>
                    <span className="font-medium text-body">Still needed: </span>
                    {req.missing.map((f) => f.label).join(" · ")}
                  </>
                )}
              </div>
            </div>
          </Card>
        </>
      ) : null}

      {/* -------------------------------------------------- tab strip */}
      <div className="mt-5 flex gap-1 border-b border-line">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cx(
              "cursor-pointer border-b-2 px-3 py-2 text-sm font-medium",
              tab === k ? "border-brand text-brand-hover" : "border-transparent text-muted hover:text-body",
            )}
          >
            {label}
            {k === "calls" ? <span className="ml-1.5 text-[11px] text-muted">{lead.callCount}</span> : null}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "overview" ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
            <div className="flex flex-col gap-4">
              <OpportunityCard lead={lead} />
              <SuspectCallsTracker
                lead={lead}
                canWork={canWork}
                onCall={() => open("call")}
                onRequest={() => open("request")}
                onLost={() => open("lost")}
                onOpenCalls={() => setTab("calls")}
              />
              <VerificationCard lead={lead} prospectReasons={prospectReasons} />
              <QualificationCard lead={lead} />
              <SampleCard lead={lead} sampleReasons={sampleReasons} />
              <OrderCard lead={lead} orderBlockers={orderBlockers} />
            </div>
            <div className="flex flex-col gap-4">
              <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Move this lead forward</div>
              <GateActionCard
                lead={lead}
                canWork={canWork}
                status={status.text}
                onCall={() => open("call")}
                onMessage={() => open("message")}
                onRequest={() => open("request")}
                onLost={() => open("lost")}
              />
            </div>
          </div>
        ) : tab === "calls" ? (
          <CallsTab lead={lead} />
        ) : tab === "comms" ? (
          <CommsTab
            lead={lead}
            canWork={canWork}
            onCall={() => open("call")}
            onMessage={(code) => open("message", code)}
          />
        ) : (
          <TimelineTab lead={lead} />
        )}
      </div>

      {/* ------------------------------------------------------ dialogs */}
      {dialog?.kind === "call" && next ? (
        <LogCallDialog lead={lead} defaultNextDate={defaultNextDate} today={today} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "message" ? (
        <MessageDialog lead={lead} preset={dialog.preset ?? null} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "next" ? <NextActionDialog lead={lead} today={today} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "request" ? (
        <RequestDialog lead={lead} prospectReasons={prospectReasons} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "lost" ? <LostDialog lead={lead} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function RelNode({
  role,
  name,
  sub,
  highlight,
}: {
  role: string;
  name: string | null | undefined;
  sub?: string | null;
  highlight?: boolean;
}) {
  return (
    <span className={cx("rounded-[4px] border px-3 py-2", highlight ? "border-brand-softer bg-brand-soft" : "border-line bg-canvas")}>
      <span className="block text-[10.5px] text-muted uppercase">{role}</span>
      <span className="block text-sm font-medium text-ink">{name || "—"}</span>
      {sub ? <span className="block text-[11px] text-muted">{sub}</span> : null}
    </span>
  );
}

function NextActionPanel({
  lead,
  canWork,
  today,
  onEdit,
}: {
  lead: DeskLeadRecord;
  canWork: boolean;
  /** The business day from the server — a client may not read the clock while rendering. */
  today: string;
  onEdit: () => void;
}) {
  const canEdit = isWorking(lead.phase);
  const na = lead.nextAction;
  if (!na) {
    if (!canEdit) return null;
    return (
      <Card className="mb-4 flex items-center gap-4 border-l-[3px] border-l-warn px-5 py-3.5">
        <div className="flex-1">
          <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">No next action set</div>
          <div className="text-sm font-medium text-ink">This active lead has nothing scheduled</div>
          <div className="text-[12.5px] text-muted">Every active lead needs a next action — this is a gap.</div>
        </div>
        <Button size="sm" variant="primary" disabled={!canWork} onClick={onEdit}>
          Set next action
        </Button>
      </Card>
    );
  }
  const d = na.date ? daysBetween(today, na.date) : null;
  const overdue = d !== null && d < 0;
  const type = nextActionTypeLabel(lead.phase, na.kind);
  return (
    <Card
      className={cx(
        "mb-4 flex flex-wrap items-center gap-6 px-5 py-3.5",
        overdue ? "border-l-[3px] border-l-danger" : "border-l-[3px] border-l-brand",
      )}
    >
      <MetaItem label="Next action" value={na.text} />
      <MetaItem label={overdue ? "Overdue since" : "Due"} value={na.date ? shortDate(na.date) : "—"} />
      <MetaItem label="Responsible" value={na.ownerName ?? lead.ownerName} />
      <MetaItem label="Expected outcome" value={na.outcome} />
      <MetaItem label="Type" value={type} />
      {canEdit ? (
        <Button size="sm" variant="secondary" className="ml-auto" disabled={!canWork} onClick={onEdit}>
          Update
        </Button>
      ) : (
        <span className="ml-auto text-[12px] text-muted">
          {na.ownerName && na.ownerName === lead.ownerName ? "Owned by the Telecaller" : "Owned by the Sales Manager"}
        </span>
      )}
    </Card>
  );
}

function LadderCard({ lead, status }: { lead: DeskLeadRecord; status: { text: string; who: string | null } }) {
  const ladder = lead.ladder;
  const idx = lead.ladderIndex;
  const pendingIdx = isPending(lead.phase) || lead.phase === "returned" ? ladder.indexOf("prospect") : -1;
  return (
    <>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Where this lead stands</div>
        <div className="text-[12px] text-muted">
          {idx >= 0 ? `Stage ${idx + 1} of ${ladder.length} · ` : ""}
          {lead.salesType === "third_party" ? "Third Party Customer ladder" : "Direct customer ladder"}
        </div>
      </div>
      <Card className="mb-5 px-5 pt-4 pb-3">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[4px] border border-line bg-canvas px-3.5 py-2">
          <span className="text-[11px] tracking-[0.03em] text-muted uppercase">Current stage</span>
          <Badge tone={lead.lost ? "danger" : "brand"}>
            {lead.lost ? "Lost" : idx >= 0 ? LADDER_LABEL[ladder[idx]] : "—"}
          </Badge>
          {lead.lost && idx >= 0 ? (
            <span className="text-[12.5px] text-muted">at {LADDER_LABEL[ladder[idx]]}</span>
          ) : null}
          <span className="text-[13px] font-medium text-ink">{status.text}</span>
          {status.who ? <span className="text-[12.5px] text-muted">· with {status.who}</span> : null}
        </div>
        <div className="flex items-start gap-1 overflow-x-auto pb-1">
          {ladder.map((s, i) => {
            const done = i < idx;
            const current = i === idx;
            const pending = i === pendingIdx;
            const on = lead.stageDates[s] ?? null;
            return (
              <div key={s} className="flex min-w-[86px] flex-1 flex-col items-center">
                <div className="flex w-full items-center">
                  {i > 0 ? (
                    <span className={cx("h-px flex-1", done || current ? "bg-brand" : "bg-line")} />
                  ) : (
                    <span className="flex-1" />
                  )}
                  <span
                    className={cx(
                      "flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-semibold",
                      done
                        ? "bg-brand text-white"
                        : current
                          ? "border-2 border-brand text-brand-hover"
                          : pending
                            ? "border-2 border-dashed border-warn text-warn-ink"
                            : "border border-line-strong text-muted",
                    )}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  {i < ladder.length - 1 ? (
                    <span className={cx("h-px flex-1", done ? "bg-brand" : "bg-line")} />
                  ) : (
                    <span className="flex-1" />
                  )}
                </div>
                <span className={cx("mt-1 text-center text-[10.5px] leading-tight", current ? "font-semibold text-ink" : "text-muted")}>
                  {LADDER_LABEL[s]}
                </span>
                {pending ? (
                  <span className="mt-0.5 text-center text-[10px] leading-tight font-medium text-warn-ink">
                    {lead.phase === "returned" ? "Returned" : "Awaiting verification"}
                  </span>
                ) : (done || current) && on ? (
                  <span className="mt-0.5 text-[10px] text-muted">{shortDate(on)}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

/** The twelve answers in the manager's own grid, each carrying what the verification made of it. */
function OpportunityCard({ lead }: { lead: DeskLeadRecord }) {
  const handed = lead.requestedAt !== null;
  const cells = DESK_FIELDS.map((f) => {
    const answered = isAnswered(f.key, lead.values[f.key]);
    const mark = lead.marks[f.key];
    return (
      <div key={f.key} className="bg-surface px-4 py-3">
        <div className="text-[10.5px] font-semibold tracking-[0.04em] text-muted uppercase">{f.label}</div>
        <div className="mt-0.5 text-[13px] font-medium text-ink">
          {answered ? displayAnswer(f.key, lead.values[f.key], lead.productName, lead.gstVerified) : "Not Yet Confirmed"}
        </div>
        {mark?.kind === "confirmed" ? (
          <div className="mt-0.5 text-[11px] font-medium text-success">✓ Verified by Sales Manager</div>
        ) : mark?.kind === "corrected" ? (
          <div className="mt-0.5 text-[11px] font-medium text-brand-hover">
            Corrected by Sales Manager{mark.was ? ` — was ${mark.was}` : ""}
          </div>
        ) : mark?.kind === "unverified" ? (
          <div className="mt-0.5 text-[11px] font-medium text-warn-ink">Unable to verify</div>
        ) : null}
      </div>
    );
  });
  cells.push(
    <div key="calls" className="bg-surface px-4 py-3">
      <div className="text-[10.5px] font-semibold tracking-[0.04em] text-muted uppercase">Calls so far</div>
      <div className="mt-0.5 text-[13px] font-medium text-ink">{lead.callCount}</div>
    </div>,
  );
  const filler = (3 - (cells.length % 3)) % 3;
  return (
    <Card className="p-5">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        Opportunity — collected by the Telecaller
      </div>
      <div className="overflow-hidden rounded-[6px] border border-line">
        <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
          {cells}
          {filler ? <div className={cx("hidden bg-canvas sm:block", filler === 2 ? "col-span-2" : "")} /> : null}
        </div>
      </div>
      <p className="mt-3 mb-0 text-[12.5px] text-muted">
        {handed
          ? "Collected by the Telecaller across the Suspect calls. The Sales Manager verifies it — confirming or correcting each answer — and it is never re-collected from the customer."
          : "Collected by the Telecaller across the Suspect calls. When every required answer is in the Telecaller requests a Prospect and the Sales Manager verifies it."}
      </p>
      {lead.enquiry ? (
        <div className="mt-4 rounded-[4px] border border-line bg-canvas px-3.5 py-2.5">
          <div className="text-[11px] tracking-[0.03em] text-muted uppercase">What the enquiry said</div>
          <div className="mt-0.5 text-[13.5px] text-body">“{lead.enquiry}”</div>
        </div>
      ) : null}
    </Card>
  );
}

function SuspectCallsTracker({
  lead,
  canWork,
  onCall,
  onRequest,
  onLost,
  onOpenCalls,
}: {
  lead: DeskLeadRecord;
  canWork: boolean;
  onCall: () => void;
  onRequest: () => void;
  onLost: () => void;
  onOpenCalls: () => void;
}) {
  const phase = lead.phase;
  const next = nextCallNumber(phase);
  const req = requiredProgress(lead.values);
  const canDecide = phase === "ready";
  const showButtons = isWorking(phase) || phase === "ready";
  return (
    <Card className="p-5">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        Suspect calls (maximum {MAX_QUALIFICATION_CALLS} before a decision is forced)
      </div>
      <div className="flex gap-2">
        {[1, 2, 3].map((i) => {
          const done = i <= lead.callCount;
          const isNext = next === i;
          const cls = cx(
            "flex-1 rounded-[6px] border px-2 py-2.5 text-center text-[12px]",
            done
              ? "border-success bg-success-soft font-medium text-success"
              : isNext
                ? "border-brand bg-brand-soft font-medium text-brand-hover"
                : "border-dashed border-line-strong text-muted",
          );
          const label = `Call ${i}${done ? " ✓" : isNext ? " — next" : ""}`;
          return done ? (
            <button key={i} type="button" onClick={onOpenCalls} className={cx(cls, "cursor-pointer")} title="See what was collected on this call">
              {label}
            </button>
          ) : isNext && canWork ? (
            <button key={i} type="button" onClick={onCall} className={cx(cls, "cursor-pointer")} title={`Start call ${i}`}>
              {label}
            </button>
          ) : (
            <div key={i} className={cls}>
              {label}
            </div>
          );
        })}
      </div>
      {showButtons ? (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!canDecide || !canWork} onClick={onRequest}>
            Request Prospect
          </Button>
          <Button variant="secondary" disabled={!canWork} onClick={onLost}>
            Not a Prospect
          </Button>
          {!canDecide ? (
            <span className="text-[12.5px] text-muted">
              Requesting a Prospect unlocks when every required answer is in ({req.done} of {req.total}).
            </span>
          ) : (
            <span className="text-[12.5px] text-muted">
              The Sales Manager verifies the request before it becomes a Prospect.
            </span>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function VerificationCard({ lead, prospectReasons }: { lead: DeskLeadRecord; prospectReasons: Coded[] }) {
  if (!lead.requestedAt) return null;
  const v = lead.verification;
  const tone = !v
    ? "warn"
    : v.result === "Verified" || v.result === "Verified With Corrections"
      ? "success"
      : v.result === "Follow-Up Required"
        ? "warn"
        : "danger";
  return (
    <SectionCard
      title="Manager verification"
      right={<Badge tone={tone}>{lead.phase === "returned" ? "Returned to the Telecaller" : (v?.result ?? "Not verified yet")}</Badge>}
    >
      <KvRow
        label="Prospect requested by"
        value={`${lead.requestedByName ?? lead.ownerName ?? "—"}${lead.requestedAt ? ` on ${shortDay(lead.requestedAt)}` : ""}`}
      />
      <KvRow
        label="Why it is worth pursuing"
        value={prospectReasons.find((r) => r.code === lead.requestReason)?.label ?? lead.requestReason}
      />
      {lead.requestNote ? <KvRow label="What they said" value={lead.requestNote} /> : null}
      {v ? (
        <>
          <KvRow label={`Verified by (attempt ${v.attempt})`} value={`${v.byName} on ${shortDay(v.at)}`} />
          <KvRow label="Mahek was explained" value={v.explained} />
          <KvRow label="Visited / spoke" value={v.visited} />
          <KvRow label="Genuine interest" value={v.genuineInterest} />
          {v.objections.length ? (
            <KvRow label="Objections" value={v.objections.map((o) => `${o.label}: ${o.value}`).join(" · ")} />
          ) : null}
          {v.readiness.length ? (
            <KvRow label="Readiness" value={v.readiness.map((o) => `${o.label}: ${o.value}`).join(" · ")} />
          ) : null}
          {v.impression ? <KvRow label="Impression of the visit" value={v.impression} /> : null}
          <KvRow
            label="Answers"
            value={`${v.counts.confirmed} verified · ${v.counts.corrected} corrected${
              v.counts.unable ? ` · ${v.counts.unable} unable to verify` : ""
            }`}
          />
          {v.note ? (
            <div className="mt-2 rounded-[4px] border border-line bg-canvas px-3 py-2 text-[13px] text-body">
              <span className="text-muted">Manager&rsquo;s note: </span>
              {v.note}
            </div>
          ) : null}
          {v.corrections.length ? (
            <>
              <div className="mt-3 text-[11px] tracking-[0.03em] text-muted uppercase">Corrections made</div>
              <div className="mt-1 divide-y divide-divider rounded-[4px] border border-line">
                {v.corrections.map((c, i) => (
                  <div key={i} className="px-3 py-1.5 text-[13px]">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-muted">{c.label}</span>
                      <span className="text-right font-medium text-ink">
                        {c.original ?? "—"} → {c.corrected}
                      </span>
                    </div>
                    {c.reason ? <div className="text-[12px] text-muted">{c.reason}</div> : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <div className="mt-2 text-[13px] text-muted">
          The Sales Manager reviews every answer the Telecaller collected — confirms it or corrects it — before the
          Prospect is confirmed.
        </div>
      )}
      {lead.phase === "returned" && lead.managerNote ? (
        <div className="mt-2 rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-body">
          <span className="text-muted">Returned with: </span>
          {lead.managerNote}
        </div>
      ) : null}
    </SectionCard>
  );
}

function QualificationCard({ lead }: { lead: DeskLeadRecord }) {
  const q = lead.qualification;
  if (!q) return null;
  const all = q.done === q.total;
  return (
    <SectionCard title="Qualification checklist" right={<Badge tone={all ? "success" : "warn"}>{q.done} of {q.total} done</Badge>}>
      <div className="flex flex-col gap-2">
        {q.conditions.map((c) => (
          <div key={c.id} className="flex items-start gap-2.5 rounded-[4px] border border-line px-3 py-2 text-sm">
            <span
              className={cx(
                "mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[3px] border text-[12px]",
                c.done ? "border-brand bg-brand text-white" : "border-line-strong bg-surface",
              )}
            >
              {c.done ? "✓" : ""}
            </span>
            <span className={c.done ? "text-body" : "text-ink"}>{c.says}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 mb-0 text-[12.5px] text-muted">
        {all
          ? "All conditions were satisfied before Sample / Trial opened."
          : "Managed by the Sales Manager — read-only for the Telecaller."}
      </p>
    </SectionCard>
  );
}

/** The review, as V6 reads it on one line: only what somebody actually said. */
const REVIEW_LINE: [string, string][] = [
  ["quality", "Quality"],
  ["performance", "Performance"],
  ["drying", "Drying"],
  ["competitorComparison", "Vs current"],
  ["priceFeedback", "Price"],
];

function SampleCard({ lead, sampleReasons }: { lead: DeskLeadRecord; sampleReasons: Coded[] }) {
  const s = lead.sample;
  if (!s) return null;
  const steps = ["Requested", "Dispatched", "Received", "Reviewed"];
  const at =
    s.state === "reviewed" ? 3 : s.state === "received" || s.state === "delivered" ? 2 : s.state === "dispatched" ? 1 : 0;
  const review = REVIEW_LINE.filter(([k]) => s.feedback?.[k]?.trim())
    .map(([k, label]) => `${label}: ${s.feedback![k].trim()}`)
    .join(" · ");
  const reason = s.reasonCode ? (sampleReasons.find((r) => r.code === s.reasonCode)?.label ?? null) : null;
  return (
    <SectionCard
      title="Sample / Trial"
      right={
        s.trialOutcome && s.trialOutcome !== "pending" ? (
          <Badge tone={s.trialOutcome === "approved" ? "success" : s.trialOutcome === "rejected" ? "danger" : "warn"}>
            {s.trialOutcome === "approved" ? "Approved" : s.trialOutcome === "rejected" ? "Rejected" : "More testing required"}
          </Badge>
        ) : null
      }
    >
      <div className="mb-3 flex gap-2">
        {steps.map((t, i) => (
          <div
            key={t}
            className={cx(
              "flex-1 rounded-[6px] border px-2 py-2 text-center text-[12px]",
              i <= at ? "border-success bg-success-soft font-medium text-success" : "border-dashed border-line-strong text-muted",
            )}
          >
            {t}
            {i <= at ? " ✓" : ""}
          </div>
        ))}
      </div>
      <KvRow label="Quantity" value={s.quantityCans ? `${s.quantityCans} cans` : null} />
      <KvRow label="Reason" value={reason} />
      {s.requestedDate ? <KvRow label="Requested" value={shortDay(s.requestedDate)} /> : null}
      {s.dispatchedAt ? <KvRow label="Dispatched" value={shortDay(s.dispatchedAt)} /> : null}
      {s.receivedAt ? <KvRow label="Received, confirmed by the customer" value={shortDay(s.receivedAt)} /> : null}
      {review || s.rejectionReason ? (
        <div className="mt-2 rounded-[4px] border border-line bg-canvas px-3 py-2 text-[13px] text-body">
          <span className="text-muted">Trial review: </span>
          {review || s.rejectionReason}
        </div>
      ) : null}
    </SectionCard>
  );
}

function OrderCard({ lead, orderBlockers }: { lead: DeskLeadRecord; orderBlockers: Coded[] }) {
  const c = lead.commitment;
  const o = lead.order;
  if (!c && !o && lead.phase !== "negotiation") return null;
  const miles: [keyof DeskLeadRecord["milestones"], string][] = [
    ["first_order", "1st Order"],
    ["delivery", "Delivery"],
    ["payment", "Payment"],
    ["second_order", "2nd Order"],
    ["customer", "Customer"],
  ];
  const blocker = c?.blockerCode ? (orderBlockers.find((b) => b.code === c.blockerCode)?.label ?? null) : null;
  return (
    <SectionCard title={o ? "Order and after-sales" : "Commitment"}>
      {c ? (
        <KvRow
          label="Commitment (forecast)"
          value={[
            c.cans ? `${c.cans} cans` : null,
            c.valuePaise ? money(c.valuePaise) : null,
            c.expectedDate ? `expected ${shortDay(c.expectedDate)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ) : (
        <div className="text-[13px] text-muted">No commitment recorded yet.</div>
      )}
      {blocker ? <KvRow label="Blocker" value={blocker} /> : null}
      {o ? (
        <>
          <KvRow label="Product" value={o.product} />
          <KvRow
            label="Quantity"
            value={
              [o.quantityCans ? `${o.quantityCans} cans` : null, o.litres ? `${o.litres.toLocaleString("en-IN")} L` : null]
                .filter(Boolean)
                .join(" · ") || null
            }
          />
          <KvRow label="Order value" value={money(o.amountPaise)} />
          <KvRow label="Reference" value={o.orderNo} />
          <div className="mt-3 flex gap-2">
            {miles.map(([k, label]) => (
              <div
                key={k}
                className={cx(
                  "flex-1 rounded-[6px] border px-2 py-2 text-center text-[12px]",
                  lead.milestones[k] ? "border-success bg-success-soft font-medium text-success" : "border-dashed border-line-strong text-muted",
                )}
              >
                <div>{label}</div>
                <div className="text-[11px] font-normal">{lead.milestones[k] ? shortDay(lead.milestones[k]) : "Pending"}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </SectionCard>
  );
}

function GateActionCard({
  lead,
  canWork,
  status,
  onCall,
  onMessage,
  onRequest,
  onLost,
}: {
  lead: DeskLeadRecord;
  canWork: boolean;
  status: string;
  onCall: () => void;
  onMessage: () => void;
  onRequest: () => void;
  onLost: () => void;
}) {
  const p = lead.phase;
  const next = nextCallNumber(p);
  const note = (t: React.ReactNode) => <Card className="px-5 py-4 text-sm text-muted">{t}</Card>;
  const box = (text: React.ReactNode, buttons: React.ReactNode) => (
    <Card className="px-5 py-4">
      <div className="mb-3 text-sm text-muted">{text}</div>
      <div className="flex flex-wrap gap-2">{buttons}</div>
    </Card>
  );
  if (p === "lost") return note("No further action — this lead is closed. Its history stays for reference.");
  if (p === "ready")
    return box(
      "All required answers are in. Request the Prospect and pick the reason it is worth pursuing. The Sales Manager then verifies what you collected — you are not converting it yourself.",
      <Button variant="primary" disabled={!canWork} onClick={onRequest}>
        Request Prospect
      </Button>,
    );
  if (p === "requested")
    return note(
      `Prospect request sent to ${lead.managerName ?? "the Sales Manager"}${
        lead.requestedAt ? ` on ${shortDay(lead.requestedAt)}` : ""
      }. It is not a Prospect until the Sales Manager verifies it. Nothing more for the Telecaller to do — do not ring the customer again to re-ask.`,
    );
  if (p === "followup")
    return note(
      "The Sales Manager has put verification on hold and is following up. Nothing to do here until they decide — their note is on the Manager verification card.",
    );
  if (p === "returned")
    return box(
      "The Sales Manager could not verify this lead and has returned it. Read their note on the Manager verification card, correct what is wrong on the Edit screen, then resubmit — or close the lead.",
      <>
        <Button variant="primary" disabled={!canWork} onClick={onRequest}>
          Resubmit for verification
        </Button>
        <Button variant="secondary" className="text-danger" disabled={!canWork} onClick={onLost}>
          Mark Lost
        </Button>
      </>,
    );
  if (p === "exhausted")
    return box(
      "Three calls have been made and the required answers are still not in. There is no Call 4 — close the lead, or fill the answers on the Edit screen if they have since come in.",
      <Button variant="secondary" className="text-danger" disabled={!canWork} onClick={onLost}>
        Mark Lost
      </Button>,
    );
  if (isWorking(p)) {
    const { askNow } = questionsForCall(lead.values, next ?? MAX_QUALIFICATION_CALLS);
    const req = requiredProgress(lead.values);
    return (
      <Card className="px-5 py-4">
        {next === MAX_QUALIFICATION_CALLS ? (
          <Callout tone="warn" className="mb-3">
            <div className="text-[13px]">
              <b>Last call.</b> If the required answers are not in by the end of it, the lead is marked Lost.
            </div>
          </Callout>
        ) : null}
        <div className="mb-3 text-sm text-muted">
          {askNow.length} question{askNow.length === 1 ? "" : "s"} worth asking on call {next}.{" "}
          {req.missing.length === 0 ? (
            "Every required answer is already in."
          ) : (
            <b className="text-ink">
              {req.missing.length} required — {req.missing.map((f) => f.label).join(", ")} still missing.
            </b>
          )}{" "}
          Anything already answered is not asked again.
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!canWork} onClick={onCall}>
            <DeskIcon name="phone" size={14} />
            Start call {next} / {MAX_QUALIFICATION_CALLS}
          </Button>
          <Button variant="secondary" disabled={!canWork} onClick={onMessage}>
            Send a message first
          </Button>
        </div>
      </Card>
    );
  }
  return note(
    `With the Sales Manager (${lead.managerName ?? "—"}) — read-only for the Telecaller. ${status}. Everything you collected went with it, so nothing is asked of the customer again.`,
  );
}

function CallsTab({ lead }: { lead: DeskLeadRecord }) {
  const working = isWorking(lead.phase);
  return (
    <div className="flex flex-col gap-4">
      {[1, 2, 3].map((n) => {
        const call = lead.calls[n - 1];
        if (!call) {
          return (
            <Card key={n} className="border-dashed px-5 py-4">
              <div className="text-sm font-semibold text-ink">
                Call {n} / {MAX_QUALIFICATION_CALLS}
              </div>
              <div className="text-[13px] text-muted">
                {!working ? "Not needed — the lead was decided before this call." : "Not made yet."}
              </div>
            </Card>
          );
        }
        const tone =
          call.outcome === "spoke_collected"
            ? "success"
            : call.outcome === "spoke_callback"
              ? "brand"
              : call.outcome === "no_answer"
                ? "warn"
                : "danger";
        return (
          <Card key={n} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-ink">
                  Call {n} / {MAX_QUALIFICATION_CALLS}
                </div>
                <div className="font-mono text-[11px] text-muted">
                  {stamp(call.at)} · {call.byName}
                </div>
              </div>
              <Badge tone={tone}>{OUTCOME_LABEL[call.outcome]}</Badge>
            </div>
            {call.outcome === "no_answer" && call.noAnswerReason ? (
              <div className="mt-2 text-[13px] text-muted">
                {NO_ANSWER_REASONS.find((r) => r.code === call.noAnswerReason)?.label}
              </div>
            ) : null}
            <div className="mt-3 text-[11px] tracking-[0.03em] text-muted uppercase">
              {n === 1 ? "Answers collected" : n === 2 ? "Newly collected" : "Final information"}
            </div>
            {call.answers.length ? (
              <div className="mt-1 divide-y divide-divider rounded-[4px] border border-line">
                {call.answers.map((a) => (
                  <div key={a.key} className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-[13px]">
                    <span className="text-muted">{a.label}</span>
                    <span className="text-right font-medium text-ink">
                      {displayAnswer(a.key as DeskFieldKey, lead.values[a.key as DeskFieldKey], lead.productName, lead.gstVerified)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-1 text-[13px] text-muted">No new answers on this call.</div>
            )}
            {call.notes ? (
              <div className="mt-3">
                <div className="text-[11px] tracking-[0.03em] text-muted uppercase">Notes</div>
                <div className="text-[13.5px] text-body">{call.notes}</div>
              </div>
            ) : null}
            {call.nextAction ? (
              <div className="mt-3 text-[13px]">
                <span className="text-muted">Next action: </span>
                <span className="font-medium text-ink">{call.nextAction}</span>
                {call.nextDate ? <span className="text-muted"> · {shortDay(call.nextDate)}</span> : null}
              </div>
            ) : null}
            {call.finalDisposition ? (
              <div className="mt-3 rounded-[4px] border border-line bg-canvas px-3 py-2 text-[13px]">
                <span className="text-muted">Final disposition: </span>
                <span className="font-medium text-ink">{call.finalDisposition}</span>
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

function CommsTab({
  lead,
  canWork,
  onCall,
  onMessage,
}: {
  lead: DeskLeadRecord;
  canWork: boolean;
  onCall: () => void;
  onMessage: (code: string) => void;
}) {
  const open = canWork && (isWorking(lead.phase) || lead.phase === "ready");
  const canCall = canWork && nextCallNumber(lead.phase) !== null;
  const acts = [
    { code: "call", label: "Call customer", icon: "phone" as const, done: lead.callCount > 0, disabled: !canCall, run: onCall },
    ...MESSAGE_KINDS.map((k) => ({
      code: k.code,
      label: k.code === "whatsapp_followup" ? "WhatsApp follow-up" : `Send ${k.label.toLowerCase()}`,
      icon: k.icon,
      done: lead.messages.some((m) => m.code === k.code),
      disabled: !open,
      run: () => onMessage(k.code),
    })),
  ];
  return (
    <Card className="p-5">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Communication actions</div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {acts.map((a) => (
          <button
            key={a.code}
            type="button"
            disabled={a.disabled}
            onClick={a.run}
            className={cx(
              "flex flex-col items-start gap-1.5 rounded-[7px] border px-3 py-3 text-left text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-60",
              a.disabled ? "" : "cursor-pointer hover:border-line-strong",
              a.done ? "border-brand-softer bg-brand-soft text-brand-hover" : "border-line bg-surface text-ink",
            )}
          >
            <span
              className={cx(
                "flex h-7 w-7 items-center justify-center rounded-[6px]",
                a.done ? "bg-success-soft text-success" : "bg-brand-soft text-brand-hover",
              )}
            >
              <DeskIcon name={a.icon} size={15} />
            </span>
            <span>
              {a.label}
              {a.done ? <span className="ml-1.5 text-[11px] font-semibold text-brand-hover">✓ done</span> : null}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 mb-0 text-[12.5px] text-muted">
        {open
          ? `Sending information is part of the same conversation and does not use one of the ${MAX_QUALIFICATION_CALLS} calls. Calling does.`
          : "Once a Prospect is requested, the Sales Manager leads communication with the customer. The Telecaller's earlier messages stay below."}
      </p>
      <div className="mt-4 mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Messages sent</div>
      {lead.messages.length === 0 ? (
        <div className="rounded-[4px] border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">
          Nothing sent yet.
        </div>
      ) : (
        <div className="divide-y divide-divider rounded-[4px] border border-line">
          {lead.messages.map((m, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4 px-3 py-2 text-[13px]">
              <span>
                <span className="font-medium text-ink">{messageLabel(m.code) === m.code ? m.label : messageLabel(m.code)}</span>
                {m.note ? <span className="text-muted"> — {m.note}</span> : null}
              </span>
              <span className="flex-none font-mono text-[11px] text-muted">{shortDay(m.at)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function TimelineTab({ lead }: { lead: DeskLeadRecord }) {
  const label = { system: "System", desk: `Telecaller`, manager: "Sales Manager", customer: "Customer", other: "Team" } as const;
  const tone = { system: "neutral", desk: "brand", manager: "success", customer: "warn", other: "neutral" } as const;
  const ring = {
    system: "border-line-strong",
    desk: "border-brand",
    manager: "border-success",
    customer: "border-warn",
    other: "border-line-strong",
  } as const;
  return (
    <Card className="p-5">
      {lead.timeline.length === 0 ? (
        <div className="text-[13px] text-muted">Nothing on this lead&rsquo;s history yet.</div>
      ) : (
        <div className="relative pl-6">
          <div className="absolute top-0.5 bottom-0.5 left-[7px] w-px bg-line" />
          {lead.timeline.map((t, i) => (
            <div key={i} className="relative pb-5 last:pb-0">
              <span
                className={cx(
                  "absolute top-0.5 -left-6 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 bg-surface",
                  ring[t.who],
                )}
              />
              <div className="font-mono text-[11px] text-muted">{stamp(t.at)}</div>
              <div className="text-[13.5px] font-medium text-ink">{t.title}</div>
              {t.actor ? <div className="mt-0.5 text-[12.5px] text-muted">{t.actor}</div> : null}
              <Badge tone={tone[t.who]} className="mt-1.5">
                {label[t.who]}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
