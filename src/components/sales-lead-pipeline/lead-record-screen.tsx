"use client";

import * as React from "react";
import Link from "next/link";
import { Badge, Button, Callout, Card, cx, type Tone } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { useLeadPipeline } from "./provider";
import { LeadStatusBadges } from "./badges";
import { COMMS_ACTIONS, STAGE_LABEL, VERIFICATION_RESULT_LABEL, ladderFor, personName } from "@/lib/sales-lead-pipeline/reference";
import type { Lead, TrialOutcome } from "@/lib/sales-lead-pipeline/types";

const BASE = "/sales-lead-pipeline";

const money = (paise?: number) => (paise ? "₹" + Math.round(paise / 100).toLocaleString("en-IN") : "—");

type Tab = "overview" | "sample" | "negotiation" | "profile" | "approval" | "comms" | "timeline";

const SAMPLE_STAGES = ["qualification", "sample_trial", "sample_received", "sample_review", "negotiation", "first_order", "delivery", "payment", "second_order", "customer"];
const NEGOTIATION_STAGES = ["negotiation", "first_order", "delivery", "payment", "second_order", "customer"];

function tabsFor(lead: Lead): { key: Tab; label: string }[] {
  const tabs: { key: Tab; label: string }[] = [{ key: "overview", label: "Overview" }];
  if (lead.salesType === "distributor") {
    tabs.push({ key: "profile", label: "Distributor Profile" }, { key: "approval", label: "Management Approval" });
  } else {
    if (SAMPLE_STAGES.includes(lead.stage) || lead.sample) tabs.push({ key: "sample", label: "Sample" });
    if (NEGOTIATION_STAGES.includes(lead.stage) || lead.commitment || lead.orders.length) {
      tabs.push({ key: "negotiation", label: "Negotiation" });
    }
  }
  tabs.push({ key: "comms", label: "Communication" }, { key: "timeline", label: "Timeline" });
  return tabs;
}

export type TimelinePaging = { total: number; nextHref: string | null; newestHref: string | null };

/**
 * One lead, drawn from what the server rendered. `useLeadPipeline().lead` is a
 * prop that changes when the page refreshes after a save, so nothing here holds
 * a copy of the record — a tick, a stage or a next action shown is one the
 * database holds.
 */
export function LeadRecordScreen({ initialTab, timeline }: { initialTab?: string; timeline: TimelinePaging }) {
  const { lead, openModal, todayDate } = useLeadPipeline();
  const [tab, setTab] = React.useState<Tab>((initialTab as Tab) || "overview");

  const ladder = ladderFor(lead.salesType);
  const currentIdx = ladder.indexOf(lead.stage);
  const availableTabs = tabsFor(lead);
  const activeTab = availableTabs.some((t) => t.key === tab) ? tab : "overview";
  const canWork = lead.caps.canWork;

  return (
    <div className="p-6">
      <div className="mb-2.5 text-[12.5px] text-muted">
        <Link href={`${BASE}/list`} className="hover:text-brand">All Leads</Link> / {lead.name}
      </div>

      {lead.lost ? (
        <Callout tone="danger" className="mb-4">
          <div>
            <b>This lead is marked Lost.</b> Reason: {lead.lost.reasonLabel}
            {lead.lost.by ? ` · by ${personName(lead.lost.by)}` : ""}
            {lead.lost.date ? ` on ${lead.lost.date}` : ""}.
            {lead.lost.note ? ` “${lead.lost.note}”` : ""} The record and its full timeline remain, unchanged, for reference.
          </div>
        </Callout>
      ) : null}

      {lead.deskRequest && !lead.lost ? (
        <Callout tone="brand" className="mb-4">
          <div>
            <b>The calling desk has asked for this lead to be put forward as a Prospect.</b> It stays a Suspect until a verification call succeeds.
          </div>
        </Callout>
      ) : null}

      <Card className="mb-4 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xl font-semibold text-ink">{lead.name}</span>
              <LeadStatusBadges lead={lead} />
            </div>
            <div className="mt-0.5 text-[13px] text-muted">
              created {lead.createdAt || "—"} · source: {lead.source ?? "—"}
            </div>
          </div>
          <div className="flex flex-none gap-2">
            {!lead.lost && canWork ? (
              <Button size="sm" variant="ghost" onClick={() => openModal("reassign", lead.id)}>Reassign</Button>
            ) : null}
            <Link
              href={`/sales/leads/${lead.id}`}
              className="inline-flex h-8 items-center rounded-[4px] px-3 text-sm font-medium text-body hover:bg-canvas"
            >
              Full record
            </Link>
            {!lead.lost && canWork ? (
              <Button size="sm" variant="secondary" className="text-danger" onClick={() => openModal("lost", lead.id)}>
                Mark Lost
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-divider pt-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetaItem label="Owner" value={personName(lead.owner)} />
          <MetaItem label="Sales manager" value={personName(lead.manager)} />
          <MetaItem label="City" value={lead.city} />
          <MetaItem label="Contact" value={lead.contact} />
          <MetaItem label="Phone" value={lead.phone} />
          {lead.salesType !== "distributor" ? <MetaItem label="Product" value={lead.product} /> : null}
        </div>
      </Card>

      {!lead.lost ? <NextActionPanel lead={lead} today={todayDate} canWork={canWork} onEdit={() => openModal("nextaction", lead.id)} /> : null}
      {lead.salesType === "third_party" ? <RelationshipCard lead={lead} /> : null}

      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Where this lead stands</div>
      </div>
      <Card className="mb-5 px-5 pt-4 pb-3">
        <div className="flex items-start gap-1 overflow-x-auto pb-1">
          {ladder.map((s, i) => {
            const done = i < currentIdx;
            const current = i === currentIdx;
            return (
              <div key={s} className="flex min-w-[86px] flex-1 flex-col items-center">
                <div className="flex w-full items-center">
                  {i > 0 ? <span className={cx("h-px flex-1", done || current ? "bg-brand" : "bg-line")} /> : <span className="flex-1" />}
                  <span
                    className={cx(
                      "flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-semibold",
                      done ? "bg-brand text-white" : current ? "border-2 border-brand text-brand-hover" : "border border-line-strong text-muted",
                    )}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  {i < ladder.length - 1 ? <span className={cx("h-px flex-1", done ? "bg-brand" : "bg-line")} /> : <span className="flex-1" />}
                </div>
                <span className={cx("mt-1 text-center text-[10.5px] leading-tight", current ? "font-semibold text-ink" : "text-muted")}>
                  {STAGE_LABEL[s]}
                </span>
              </div>
            );
          })}
        </div>
        {currentIdx === -1 && !lead.lost ? (
          <p className="mt-2 text-[12px] text-muted">
            {STAGE_LABEL[lead.stage]} is not a rung on this lead&rsquo;s ladder — it is parked, and returns to the rung it was paused at.
          </p>
        ) : null}
      </Card>

      <div className="mt-5 flex gap-1 border-b border-line">
        {availableTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cx(
              "border-b-2 px-3 py-2 text-sm font-medium",
              activeTab === t.key ? "border-brand text-brand-hover" : "border-transparent text-muted hover:text-body",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {activeTab === "overview" ? <OverviewTab lead={lead} /> : null}
        {activeTab === "sample" ? <SampleTab lead={lead} /> : null}
        {activeTab === "negotiation" ? <NegotiationTab lead={lead} /> : null}
        {activeTab === "profile" ? <DistributorProfileTab lead={lead} /> : null}
        {activeTab === "approval" ? <ApprovalTab lead={lead} /> : null}
        {activeTab === "comms" ? <CommsTab lead={lead} /> : null}
        {activeTab === "timeline" ? <TimelineTab lead={lead} paging={timeline} /> : null}
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.03em] text-muted uppercase">{label}</div>
      <div className="text-[13px] font-medium text-ink">{value || "—"}</div>
    </div>
  );
}

function NextActionPanel({ lead, today, canWork, onEdit }: { lead: Lead; today: Date; canWork: boolean; onEdit: () => void }) {
  if (!lead.nextAction) {
    return (
      <Card className="mb-4 flex items-center gap-4 border-l-[3px] border-l-warn px-5 py-3.5">
        <div className="flex-1">
          <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">No next action set</div>
          <div className="text-sm font-medium text-ink">This active lead has nothing scheduled</div>
          <div className="text-[12.5px] text-muted">Every active lead needs a next action — this is a gap.</div>
        </div>
        {canWork ? <Button size="sm" variant="primary" onClick={onEdit}>Set next action</Button> : null}
      </Card>
    );
  }
  const overdue = lead.nextActionDate
    ? new Date(lead.nextActionDate + "T00:00:00").getTime() < new Date(today.toDateString()).getTime()
    : false;
  return (
    <Card className={cx("mb-4 flex flex-wrap items-center gap-6 px-5 py-3.5", overdue ? "border-l-[3px] border-l-danger" : "border-l-[3px] border-l-brand")}>
      <MetaItem label="Next action" value={lead.nextAction} />
      <MetaItem label={overdue ? "Overdue since" : "Due"} value={lead.nextActionDate} />
      <MetaItem label="Responsible" value={personName(lead.nextActionResp)} />
      <MetaItem label="Expected outcome" value={lead.expectedOutcome} />
      {canWork ? <Button size="sm" variant="secondary" className="ml-auto" onClick={onEdit}>Update</Button> : null}
    </Card>
  );
}

function RelationshipCard({ lead }: { lead: Lead }) {
  return (
    <Card className="mb-4 px-5 py-4">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Relationship chain</div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <RelNode role="End customer" name={lead.name} sub={lead.city} />
        <span className="text-muted">→</span>
        <RelNode role="Distributor salesman" name={lead.distributorSalesman ?? "—"} />
        <span className="text-muted">→</span>
        <RelNode role="Distributor" name={lead.distributor ?? "Not named yet"} sub="Bills this account" />
        <span className="text-muted">→</span>
        <RelNode role="Mahek sales manager" name={personName(lead.manager)} highlight />
      </div>
      <p className="mt-3 text-[12.5px] text-muted">Commercial authority stays with the distributor — Mahek&rsquo;s role here is coverage and support, not the invoice.</p>
    </Card>
  );
}
function RelNode({ role, name, sub, highlight }: { role: string; name: string; sub?: string; highlight?: boolean }) {
  return (
    <span className={cx("rounded-[4px] border px-3 py-2", highlight ? "border-brand-softer bg-brand-soft" : "border-line bg-canvas")}>
      <span className="block text-[10.5px] text-muted uppercase">{role}</span>
      <span className="block text-sm font-medium text-ink">{name}</span>
      {sub ? <span className="block text-[11px] text-muted">{sub}</span> : null}
    </span>
  );
}

/**
 * "Move this lead forward" — drawn from `lead.gate`, which the SERVER decided
 * from the real gate engine. A shut gate draws the same control disabled with
 * the engine's own missing list beneath it; the action behind the button asks
 * the engine again, because a button is not a permission.
 */
function GateActionCard({ lead }: { lead: Lead }) {
  const { openModal, busy, doMoveTo, doMarkSampleReceived, doSubmitManagement, doConfirmAgreement } = useLeadPipeline();
  const gate = lead.gate;
  const note = (text?: string) => (text ? <div className="mt-2 text-[12.5px] text-muted">{text}</div> : null);

  return (
    <Card className="px-5 py-4">
      {gate.kind === "none" && <div className="text-sm text-muted">{gate.label ?? "Nothing further to press on this lead."}</div>}
      {(gate.kind === "closed" || gate.kind === "visit" || gate.kind === "awaitingManagement" || gate.kind === "awaitingSampleApproval") && (
        <div className="text-sm text-muted">{gate.label}</div>
      )}
      {gate.kind === "verify" && <Button variant="primary" onClick={() => openModal("verify", lead.id)}>{lead.verification.result === "followup_required" ? "Re-verify" : "Verify prospect"}</Button>}
      {gate.kind === "awaitingVerification" && <Button variant="secondary" disabled>{gate.label}</Button>}

      {gate.kind === "moveToQualification" && (
        <>
          <Button variant="primary" disabled={gate.disabled || busy} onClick={() => void doMoveTo(gate.to, `Moved to ${STAGE_LABEL[gate.to]}.`)}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "qualify" && (
        <>
          <Button variant="primary" onClick={() => openModal("qualify", lead.id)}>Open qualification checklist</Button>
          {note(gate.note ? `Still open: ${gate.note}` : undefined)}
        </>
      )}
      {gate.kind === "requestSample" && (
        <>
          <div className="flex gap-2">
            <Button variant="primary" disabled={gate.disabled} onClick={() => openModal("requestSample", lead.id)}>
              Proceed to Sample / Trial
            </Button>
            <Button variant="ghost" onClick={() => openModal("qualify", lead.id)}>Review checklist</Button>
          </div>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "approveSample" && <Button variant="primary" disabled={gate.disabled} onClick={() => openModal("approveSample", lead.id)}>{gate.label}</Button>}
      {gate.kind === "markDispatched" && (
        <>
          <Button variant="primary" disabled={gate.disabled} onClick={() => openModal("dispatchSample", lead.id)}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "markReceived" && (
        <>
          <Button variant="primary" disabled={gate.disabled || busy} onClick={() => void doMarkSampleReceived()}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "sampleReview" && <Button variant="primary" disabled={gate.disabled} onClick={() => openModal("sampleReview", lead.id)}>Record trial review</Button>}
      {(gate.kind === "moveToNegotiation" || gate.kind === "moveOn" || gate.kind === "recordInitialStock") && (
        <>
          <Button variant="primary" disabled={gate.disabled || busy} onClick={() => void doMoveTo(gate.to, `Moved to ${STAGE_LABEL[gate.to]}.`)}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "askOrder" && <Button variant="primary" onClick={() => openModal("askOrder", lead.id)}>Record Commitment / Expected Order</Button>}
      {gate.kind === "confirmOrder" && (
        <>
          <Callout tone="warn" className="mb-3">{gate.note}</Callout>
          <Button variant="primary" disabled={gate.disabled} onClick={() => openModal("confirmOrder", lead.id)}>Confirm Actual Order</Button>
        </>
      )}
      {gate.kind === "submitManagement" && (
        <>
          <Button variant="primary" disabled={gate.disabled || busy} onClick={() => void doSubmitManagement("")}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "agreeTerms" && (
        <>
          <Button variant="primary" disabled={gate.disabled} onClick={() => openModal("distributorTerms", lead.id)}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "decideDistributor" && (
        <>
          <Button variant="primary" disabled={gate.disabled} onClick={() => openModal("distributorDecide", lead.id)}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {gate.kind === "confirmAgreement" && (
        <>
          <Button variant="primary" disabled={gate.disabled || busy} onClick={() => void doConfirmAgreement()}>{gate.label}</Button>
          {note(gate.note)}
        </>
      )}
      {!lead.caps.canWork && gate.kind !== "none" && gate.kind !== "closed" ? (
        <div className="mt-3 text-[12px] text-muted">You can read this lead but working it is not a hat your account holds.</div>
      ) : null}
    </Card>
  );
}

/**
 * The prototype's own layout: a wide left column (opportunity facts, then
 * either the Suspect visit tracker or the verification summary) beside a
 * narrower right column carrying nothing but "Move this lead forward".
 */
function OverviewTab({ lead }: { lead: Lead }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
      <div>
        <Card className="p-5">
          <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Opportunity — collected by the Salesman</div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
            <MetaItem label="Customer type" value={lead.customerType} />
            <MetaItem label="Decision maker" value={lead.decisionMaker} />
            <MetaItem label="Buyer" value={lead.buyer} />
            <MetaItem label="GST" value={lead.gstin ? `${lead.gstin}${lead.gstVerified ? " (Verified)" : " (Awaiting check)"}` : undefined} />
            <MetaItem label="Monthly requirement" value={lead.monthlyLitres ? `${lead.monthlyLitres.toLocaleString("en-IN")} Litres` : undefined} />
            <MetaItem label="Expected monthly sales" value={money(lead.potentialPaise)} />
            <MetaItem label="Credit days" value={lead.creditDaysWanted ? `${lead.creditDaysWanted} days` : undefined} />
            <MetaItem label="Product" value={lead.product} />
            <MetaItem label="Competitor" value={lead.competitor} />
            <MetaItem label="Application" value={lead.application} />
            <MetaItem label="Address" value={lead.address} />
            <MetaItem label="Visits so far" value={String(lead.visits || 0)} />
          </div>
          {lead.salesmanNotes ? (
            <div className="mt-3 border-t border-divider pt-3">
              <div className="text-[11px] tracking-[0.03em] text-muted uppercase">Salesman notes</div>
              <p className="mt-0.5 text-[13px] whitespace-pre-line text-body">{lead.salesmanNotes}</p>
            </div>
          ) : null}
          <p className="mt-3 text-[12.5px] text-muted">
            Collected by the Salesman across the Suspect visits and Prospect conversion. The Sales Manager
            verifies and nurtures this — it is never re-collected from the customer.
          </p>
        </Card>

        {lead.stage === "suspect" || lead.stage === "new" ? <SuspectVisitTracker lead={lead} /> : <VerificationSummary lead={lead} />}
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Move this lead forward</div>
        <GateActionCard lead={lead} />
      </div>
    </div>
  );
}

/** Up to `leads.suspectMaxVisits` visit chips, a cap-reached warning, and the conversion decision. */
function SuspectVisitTracker({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
  const cap = lead.suspectCap;
  const canDecide = lead.caps.canWork && !lead.lost && Boolean(lead.salesType);
  return (
    <Card className="mt-4 p-5">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        Suspect visits (maximum {cap} before a decision is forced)
      </div>
      <div className="flex gap-2">
        {Array.from({ length: cap }, (_, i) => i + 1).map((i) => {
          const done = i <= lead.visits;
          const next = i === lead.visits + 1;
          return (
            <div
              key={i}
              className={cx(
                "flex-1 rounded-[6px] border px-2 py-2.5 text-center text-[12px]",
                done ? "border-success bg-success-soft font-medium text-success" : next ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-dashed border-line-strong text-muted",
              )}
            >
              Visit {i}
              {done ? " ✓" : next ? " — next" : ""}
            </div>
          );
        })}
      </div>
      {lead.mustDecide ? (
        <Callout tone="warn" className="mt-3.5">
          Visit {cap} is complete. A decision is required — this can no longer sit as a Suspect. Nothing is refused: both answers are open.
        </Callout>
      ) : null}
      {!lead.salesType ? (
        <Callout tone="brand" className="mt-3.5">
          This lead was raised before a sales type was chosen, so it climbs the older ladder and cannot be converted to a Prospect from here. Set its sales type on the{" "}
          <Link href={`/sales/leads/${lead.id}`} className="font-medium underline">full record</Link> first.
        </Callout>
      ) : null}
      {canDecide ? (
        <div className="mt-3.5 flex gap-2">
          <Button variant="primary" onClick={() => openModal("convert", lead.id)}>Convert to Prospect</Button>
          <Button variant="secondary" onClick={() => openModal("lost", lead.id)}>Not a Prospect</Button>
        </div>
      ) : null}
    </Card>
  );
}

const OBJECTIONS: [key: "priceConcern" | "qualityConcern" | "creditConcern" | "serviceConcern" | "competitorConcern", label: string][] = [
  ["priceConcern", "Price"],
  ["qualityConcern", "Quality"],
  ["creditConcern", "Credit"],
  ["serviceConcern", "Delivery / service"],
  ["competitorConcern", "Competitor"],
];

/** Pending / failed callout with an inline action, or the full summary once a call has been made. */
function VerificationSummary({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
  const v = lead.verification;
  const canVerifyNow = lead.caps.canVerify && !lead.lost && lead.gate.kind === "verify";

  if (!v.done) {
    const priorResult = v.result ? VERIFICATION_RESULT_LABEL[v.result] : null;
    const notYet = lead.stage === "prospect" || lead.stage === "contacted" || lead.deskRequest;
    if (!notYet && !priorResult) return null;
    return (
      <Callout tone={v.result === "verification_failed" ? "danger" : "warn"} className="mt-4">
        <div>
          {priorResult ? <b>{priorResult}. </b> : <b>Manager verification pending. </b>}
          {v.followUpNote ? <span>“{v.followUpNote}” </span> : null}
          A prospect is nurtured only after the sales manager confirms the visit was real and the interest is genuine.
          {canVerifyNow ? (
            <div className="mt-2">
              <Button size="sm" variant="primary" onClick={() => openModal("verify", lead.id)}>
                {priorResult ? "Re-verify" : "Verify now"}
              </Button>
            </div>
          ) : null}
        </div>
      </Callout>
    );
  }

  const objections = OBJECTIONS.filter(([key]) => v[key]).map(([, label]) => label);
  const readiness = [
    v.readyForTrial && "Trial",
    v.readyForCommercial && "Commercial discussion",
    v.readyForOrder && "Order discussion",
  ].filter(Boolean) as string[];
  const hasCorrections = Boolean(lead.verificationCorrections?.length);

  return (
    <Card className="mt-4">
      <div className="flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
        <div className="text-[15px] font-semibold text-ink">
          Manager verification
          {v.by ? <span className="ml-2 text-[12.5px] font-normal text-muted">by {v.by}{v.at ? ` on ${v.at}` : ""}</span> : null}
        </div>
        <Badge tone="success">{VERIFICATION_RESULT_LABEL[v.result ?? ""] ?? "Verified"}</Badge>
      </div>
      <div className="px-5 py-4">
        <KvRow k="Salesman visited" v={v.visitedConfirmed === undefined ? "—" : v.visitedConfirmed ? "Yes" : "No"} />
        <KvRow k="Explained Mahek properly" v={v.explainedWell === undefined ? "—" : v.explainedWell ? "Yes" : "No"} />
        <KvRow k="Customer's current product" v={v.currentProduct || v.competitor || "—"} />
        <KvRow k="Impression of salesman's visit" v={v.impression || "—"} />
        <KvRow k="Objections raised" v={objections.length ? objections.join(", ") : "None raised"} />
        <KvRow k="Readiness" v={readiness.length ? readiness.join(", ") : "—"} />
        <KvRow k="Genuine interest" v={v.genuineInterest === undefined ? "—" : v.genuineInterest ? "Yes" : "No"} last={!hasCorrections} />
      </div>
      {hasCorrections ? (
        <div className="border-t border-divider px-5 py-4">
          <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Corrections to salesman findings</div>
          {lead.verificationCorrections!.map((c) => (
            <KvRow
              key={c.field}
              k={c.field}
              v={
                <>
                  {c.original || "nothing recorded"} → <b>{c.corrected}</b> <span className="font-normal text-muted">({c.reason})</span>
                </>
              }
            />
          ))}
          <p className="mt-2 text-[12px] text-muted">The lead still carries the salesman&rsquo;s own answer; the shop&rsquo;s is recorded beside it.</p>
        </div>
      ) : null}
    </Card>
  );
}

function KvRow({ k, v, last }: { k: string; v: React.ReactNode; last?: boolean }) {
  return (
    <div className={cx("flex justify-between gap-3 py-1.5 text-[13px]", !last && "border-b border-divider")}>
      <span className="text-muted">{k}</span>
      <span className="text-right font-medium text-ink">{v}</span>
    </div>
  );
}

function SampleTab({ lead }: { lead: Lead }) {
  const s = lead.sample;
  if (!s) {
    return (
      <Card className="px-6 py-10 text-center">
        <div className="text-[15px] font-semibold text-ink">No sample requested yet</div>
        <div className="mt-1 text-sm text-muted">A sample opens once the qualification checklist is complete.</div>
      </Card>
    );
  }
  const steps: { key: string; label: string }[] = [
    { key: "requested", label: "Requested" },
    { key: "approved", label: "Approved" },
    { key: "dispatched", label: "Dispatched" },
    { key: "received", label: "Received" },
    { key: "trial_done", label: "Trial done" },
    { key: "reviewed", label: "Reviewed" },
  ];
  const cur = steps.findIndex((st) => st.key === s.state);
  const stopped = s.state === "rejected" || s.state === "cancelled";
  return (
    <div className="space-y-4">
      <Card className="p-5">
        {stopped ? (
          <Badge tone="danger">{s.state === "rejected" ? "Refused" : "Cancelled"}</Badge>
        ) : (
          <div className="flex items-center gap-1 overflow-x-auto">
            {steps.map((st, i) => (
              <React.Fragment key={st.key}>
                {i > 0 ? <span className={cx("h-px flex-1", i <= cur ? "bg-brand" : "bg-line")} /> : null}
                <span
                  className={cx(
                    "flex h-6 flex-none items-center rounded-full px-2 text-[11px] font-medium",
                    i < cur ? "bg-brand text-white" : i === cur ? "border-2 border-brand text-brand-hover" : "border border-line-strong text-muted",
                  )}
                >
                  {st.label}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}
      </Card>
      <Card className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
        <MetaItem label="Product" value={lead.product} />
        <MetaItem label="Quantity" value={s.quantity} />
        <MetaItem label="Application" value={lead.application} />
        <MetaItem label="Courier / docket" value={[s.courier, s.docket].filter(Boolean).join(" · ") || undefined} />
        <MetaItem label="Promised for" value={s.promisedDeliveryAt} />
        <MetaItem label="Dispatched" value={s.dispatchedAt} />
        <MetaItem label="Received" value={s.receivedAt} />
      </Card>
      {s.feedbackRecorded ? (
        <Card className="p-5">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Customer feedback
            <OutcomeBadge outcome={s.trialOutcome} />
          </div>
          <p className="text-sm text-body">{s.feedback}</p>
        </Card>
      ) : s.receivedAt ? (
        <Callout tone="warn">Trial feedback not recorded yet.</Callout>
      ) : null}
      {s.chase.length ? (
        <Card className="p-5">
          <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Automatic follow-up sequence</div>
          <div className="space-y-1.5">
            {s.chase.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-sm">
                <span className={cx("flex h-4 w-4 items-center justify-center rounded-full text-[10px]", c.done ? "bg-brand text-white" : "border border-line-strong")}>
                  {c.done ? "✓" : ""}
                </span>
                <span className={c.done ? "text-muted line-through" : "text-body"}>{c.label} — {c.d}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
function OutcomeBadge({ outcome }: { outcome: TrialOutcome }) {
  const label = outcome === "approved" ? "Approved" : outcome === "more_testing" ? "More testing required" : outcome === "rejected" ? "Rejected" : "Pending";
  const tone = outcome === "approved" ? "text-success" : outcome === "rejected" ? "text-danger" : "text-warn-ink";
  return <span className={cx("text-[11px] font-semibold normal-case", tone)}>{label}</span>;
}

function NegotiationTab({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
  const c = lead.commitment;
  const counting = lead.orders.some((o) => !["declined", "cancelled"].includes(o.status));
  const canRecord = lead.stage === "negotiation" && lead.caps.canWork && !lead.lost;
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Commitment — forecast, not a sale
          {c ? (
            <span className={cx("rounded-[3px] px-1.5 py-0.5 text-[10px] font-semibold normal-case", c.confirmed ? "bg-warn-soft text-warn-ink" : "bg-canvas text-muted")}>
              {c.confirmed ? "Forecast" : "Expected order — no size given"}
            </span>
          ) : null}
        </div>
        {c ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
            <MetaItem label="Expected order date" value={c.expectedOrderDate} />
            <MetaItem label="Expected cans" value={c.cans ? String(c.cans) : undefined} />
            <MetaItem label="Expected value" value={money(c.valuePaise)} />
            <MetaItem label="Credit days wanted" value={lead.creditDaysWanted ? `${lead.creditDaysWanted} days` : undefined} />
          </div>
        ) : (
          <p className="text-sm text-muted">No commitment recorded yet — an Expected Order Date only counts once a day and a size are on file here, and it is still a forecast until the order actually arrives.</p>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Orders on this account</div>
        {lead.orders.length ? (
          <div>
            {lead.orders.slice(0, 5).map((o) => (
              <KvRow
                key={o.id}
                k={`${o.orderNo ?? "Order"} · ${o.orderedAt}`}
                v={
                  <>
                    {money(o.amountPaise)} <span className="font-normal text-muted">({o.status.replace(/_/g, " ")}{o.billNo ? ` · bill ${o.billNo}` : ""})</span>
                  </>
                }
              />
            ))}
            <p className="mt-2 text-[12px] text-muted">Status is Accounts&rsquo; — an order counts as a sale once they accept it.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">Nobody has ordered yet.</p>
        )}
      </Card>

      {canRecord ? (
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => openModal("askOrder", lead.id)}>{c ? "Update Commitment" : "Record Commitment / Expected Order"}</Button>
          {c?.confirmed && !counting ? (
            <Button variant="secondary" disabled={!lead.caps.canCaptureOrder} onClick={() => openModal("confirmOrder", lead.id)}>Confirm Actual Order</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DistributorProfileTab({ lead }: { lead: Lead }) {
  const p = lead.distributorProfile;
  if (!p) return <Card className="px-6 py-10 text-center text-sm text-muted">No distributor profile on file.</Card>;
  const rows: [string, string][] = [
    ["GST verified", p.gstVerified ? "Yes" : "No"],
    ["PAN verified", p.panVerified ? "Yes" : "No"],
    ["Business address verified", p.addressVerified ? "Yes" : "No"],
    ["Business type", p.businessType ?? "—"],
    ["Years in business", String(p.yearsInBusiness ?? "—")],
    ["Decision maker", p.decisionMaker ?? "—"],
    ["Dealer network", p.hasDealerNetwork ? "Yes" : "No"],
    ["Active dealers", String(p.activeDealers ?? "—")],
    ["Territory covered", p.territoryCovered ?? "—"],
    ["Proposed territory", p.proposedTerritory ?? "—"],
    ["Sales team size", String(p.salesTeamSize ?? "—")],
    ["Warehouse", p.warehouse ? "Yes" : "No"],
    ["Storage capacity", p.storageCapacityLitres ? `${p.storageCapacityLitres.toLocaleString("en-IN")} L` : "—"],
  ];
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Distributor candidate profile</div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between border-b border-divider py-1.5 text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium text-ink">{v}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Commercial terms
          <span className="rounded-[3px] bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn-ink normal-case">Needs management sign-off</span>
        </div>
        <MetaItem label="Territorial exclusivity" value={p.exclusivityRequested ? "Requested" : "Not requested"} />
        <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MetaItem label="Credit limit requested" value={money(p.creditLimitRequestedPaise)} />
          <MetaItem label="Credit days requested" value={p.creditDaysRequired ? `${p.creditDaysRequired} days` : undefined} />
          <MetaItem label="Agreed discount" value={p.agreedDiscountPercent !== undefined ? `${p.agreedDiscountPercent}%` : "Not yet agreed"} />
          <MetaItem label="Agreed credit limit" value={p.agreedCreditLimitPaise !== undefined ? money(p.agreedCreditLimitPaise) : "Not yet agreed"} />
        </div>
        {p.termsAgreedAt ? <p className="mt-3 text-[12.5px] text-muted">Terms agreed {p.termsAgreedAt}{p.termsNote ? ` — ${p.termsNote}` : ""}.</p> : null}
      </Card>
    </div>
  );
}

const STEP_LABEL: Record<number, string> = { 0: "Sales manager recommends", 1: "Management appoints" };
const STATE_TONE: Record<string, Tone> = { pending: "warn", approved: "success", rejected: "danger" };

function ApprovalTab({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
  const t = lead.approvalThresholds;
  const p = lead.distributorProfile;
  const reasons = [
    p?.exclusivityRequested && "exclusivity requested",
    t && p?.agreedDiscountPercent !== undefined && p.agreedDiscountPercent > t.discountPercent && `a discount above ${t.discountPercent}%`,
    t && p?.agreedCreditLimitPaise !== undefined && p.agreedCreditLimitPaise > t.creditLimitPaise && `a credit limit above ${money(t.creditLimitPaise)}`,
  ].filter(Boolean);
  const decidable = lead.gate.kind === "decideDistributor" && !lead.gate.disabled;
  return (
    <Card className="p-5">
      <div className="mb-4 text-xs font-medium tracking-[0.04em] text-muted uppercase">Two-step management approval</div>
      {lead.approvalSteps.length === 0 ? (
        <p className="text-sm text-muted">Not put forward yet. A candidate goes to the sales manager first, then to management.</p>
      ) : (
        <div className="space-y-2.5">
          {lead.approvalSteps.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-line px-3 py-2.5 text-sm">
              <span>
                <span className="font-medium text-ink">Step {s.stepIndex + 1} — {STEP_LABEL[s.stepIndex] ?? "Approval"}</span>
                <span className="block text-[12.5px] text-muted">
                  Requested {s.requestedAt}{s.requestedBy ? ` by ${s.requestedBy}` : ""}
                  {s.approver ? ` · decided by ${s.approver}${s.decidedAt ? ` on ${s.decidedAt}` : ""}` : ""}
                  {s.routeReason ? ` · ${s.routeReason.replace(/_/g, " ")}` : ""}
                </span>
                {s.note ? <span className="block text-[12.5px] text-body">“{s.note}”</span> : null}
              </span>
              <Badge tone={STATE_TONE[s.state] ?? "neutral"}>{s.state}</Badge>
            </div>
          ))}
        </div>
      )}
      <Callout tone={reasons.length ? "warn" : "brand"} className="mt-4">
        Escalated to a second approval because: {reasons.length ? reasons.join(", ") : "standard review — management always sees an appointment"}.
      </Callout>
      {decidable ? (
        <Button variant="primary" onClick={() => openModal("distributorDecide", lead.id)}>{lead.gate.label}</Button>
      ) : (
        <p className="mt-1 text-[13px] text-muted">
          The second step is Management&rsquo;s to decide — a sales manager may recommend an appointment and may not make it.
        </p>
      )}
    </Card>
  );
}

function CommsTab({ lead }: { lead: Lead }) {
  const { doCommunication, busy } = useLeadPipeline();
  const canWork = lead.caps.canWork && !lead.lost;
  return (
    <Card className="p-5">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Communication actions</div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {COMMS_ACTIONS.map((a) => {
          const count = lead.comms[a.code] ?? 0;
          const done = count > 0;
          const doc = lead.commDocs[a.code];
          /* A send names the library document that went. With nothing published
             for its category the button says so instead of failing when pressed. */
          const noDoc = a.kind === "send" && !doc;
          return (
            <button
              key={a.code}
              type="button"
              disabled={!canWork || busy || noDoc}
              title={noDoc ? "Nothing is published in the library for this yet." : doc ? `Records: ${doc.title}` : undefined}
              onClick={() => void doCommunication(a.code, doc?.id)}
              className={cx(
                "flex flex-col items-start gap-1.5 rounded-[7px] border px-3 py-3 text-left text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-60",
                done ? "border-brand-softer bg-brand-soft text-brand-hover" : "border-line bg-surface text-ink hover:bg-canvas",
              )}
            >
              <span
                className={cx(
                  "flex h-7 w-7 items-center justify-center rounded-[6px]",
                  done ? "bg-success-soft text-success" : "bg-brand-soft text-brand-hover",
                )}
              >
                <Icon name={a.icon} size={15} />
              </span>
              <span>
                {a.label}
                {done ? <span className="ml-1.5 text-[11px] font-semibold text-brand-hover">✓ ×{count}</span> : null}
                {noDoc ? <span className="block text-[11px] font-normal text-muted">Nothing published yet</span> : doc ? <span className="block truncate text-[11px] font-normal text-muted">{doc.title}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[12.5px] text-muted">
        Pressing one records it on the timeline — who, and when. It does not move the lead: sending a brochure is not evidence that anything was qualified.
      </p>
    </Card>
  );
}

const ACTOR_LABEL: Record<string, string> = {
  system: "System",
  sales_manager: "Office",
  salesman: "Salesman",
};
const ACTOR_TONE: Record<string, Tone> = {
  system: "neutral",
  sales_manager: "warn",
  salesman: "brand",
};

function TimelineTab({ lead, paging }: { lead: Lead; paging: TimelinePaging }) {
  const entries = lead.timeline; // newest first — the order the page is read in
  if (entries.length === 0) {
    return <Card className="px-6 py-10 text-center text-sm text-muted">Nothing has been recorded on this lead yet.</Card>;
  }
  return (
    <Card className="p-5">
      <div className="relative pl-6">
        <div className="absolute top-0.5 bottom-0.5 left-[7px] w-px bg-line" />
        {entries.map((t, i) => (
          <div key={i} className="relative pb-5 last:pb-0">
            <span
              className={cx(
                "absolute top-0.5 -left-6 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 bg-surface",
                t.kind === "salesman" ? "border-brand" : t.kind === "sales_manager" ? "border-warn" : "border-line-strong",
              )}
            />
            <div className="font-mono text-[11px] text-muted">{t.d}</div>
            <div className="text-[13.5px] font-medium text-ink">{t.title}</div>
            {t.meta ? <div className="mt-0.5 text-[12.5px] text-muted">{t.meta}</div> : null}
            <Badge tone={ACTOR_TONE[t.kind] ?? "neutral"} className="mt-1.5">
              {ACTOR_LABEL[t.kind] ?? t.kind}
            </Badge>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-divider pt-3 text-[12.5px] text-muted">
        <span>Showing {entries.length} of {paging.total.toLocaleString("en-IN")} entries</span>
        <span className="flex gap-4">
          {paging.newestHref ? (
            <Link href={paging.newestHref} scroll={false} className="font-medium text-brand hover:text-brand-hover">
              ← Newest
            </Link>
          ) : null}
          {paging.nextHref ? (
            <Link href={paging.nextHref} scroll={false} className="font-medium text-brand hover:text-brand-hover">
              Load older →
            </Link>
          ) : null}
        </span>
      </div>
    </Card>
  );
}
