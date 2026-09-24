"use client";

import * as React from "react";
import Link from "next/link";
import { Badge, Button, Callout, Card, cx, type Tone } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { useLeadPipeline } from "./provider";
import { LeadStatusBadges } from "./badges";
import { gateActionFor } from "@/lib/sales-lead-pipeline/engine";
import {
  COMMS_ACTIONS,
  LOST_REASONS,
  STAGE_LABEL,
  VERIFICATION_RESULT_LABEL,
  ladderFor,
  personName,
} from "@/lib/sales-lead-pipeline/reference";
import type { Lead, ModalKind, TrialOutcome } from "@/lib/sales-lead-pipeline/types";

const money = (paise?: number) => (paise ? "₹" + Math.round(paise / 100).toLocaleString("en-IN") : "—");

type Tab = "overview" | "sample" | "negotiation" | "profile" | "approval" | "comms" | "timeline";

function tabsFor(lead: Lead): { key: Tab; label: string }[] {
  const tabs: { key: Tab; label: string }[] = [{ key: "overview", label: "Overview" }];
  if (lead.salesType === "distributor") {
    tabs.push({ key: "profile", label: "Distributor Profile" }, { key: "approval", label: "Management Approval" });
  } else {
    if (["qualification", "sample_trial", "sample_received", "sample_review", "negotiation", "first_order", "delivery", "payment", "second_order", "customer"].includes(lead.stage) || lead.sample) {
      tabs.push({ key: "sample", label: "Sample" });
    }
    if (["negotiation", "first_order", "delivery", "payment", "second_order", "customer"].includes(lead.stage) || lead.negotiation) {
      tabs.push({ key: "negotiation", label: "Negotiation" });
    }
  }
  tabs.push({ key: "comms", label: "Communication" }, { key: "timeline", label: "Timeline" });
  return tabs;
}

export function LeadRecordScreen({ leadId }: { leadId: string }) {
  const { getLead, openModal, today } = useLeadPipeline();
  const toast = useToast();
  const lead = getLead(leadId);
  const [tab, setTab] = React.useState<Tab>("overview");

  if (!lead) {
    return (
      <div className="p-6">
        <Card className="px-6 py-10 text-center text-sm text-muted">Lead not found.</Card>
      </div>
    );
  }

  const ladder = ladderFor(lead.salesType);
  const currentIdx = ladder.indexOf(lead.stage);
  const availableTabs = tabsFor(lead);
  const activeTab = availableTabs.some((t) => t.key === tab) ? tab : "overview";

  return (
    <div className="p-6">
      <div className="mb-2.5 text-[12.5px] text-muted">
        <Link href="/sales-lead-pipeline/list" className="hover:text-brand">All Leads</Link> / {lead.name}
      </div>

      {lead.lost ? (
        <Callout tone="danger" className="mb-4">
          <div>
            <b>This lead is marked Lost.</b> Reason: {LOST_REASONS.find((r) => r.code === lead.lost!.reason)?.label} · by{" "}
            {personName(lead.lost.by)} on {lead.lost.date}. The record and its full timeline remain, unchanged, for reference.
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
              {lead.id} · created {lead.createdAt} · source: {lead.source ?? "—"}
            </div>
          </div>
          <div className="flex flex-none gap-2">
            <Button size="sm" variant="ghost" onClick={() => openModal("reassign", lead.id)}>Reassign</Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => toast.push("Edit form omitted from this design pass.")}
            >
              Edit
            </Button>
            {!lead.lost ? (
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

      {!lead.lost ? <NextActionPanel lead={lead} today={today} onEdit={() => openModal("nextaction", lead.id)} /> : null}
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
        {activeTab === "timeline" ? <TimelineTab lead={lead} /> : null}
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

function NextActionPanel({ lead, today, onEdit }: { lead: Lead; today: Date; onEdit: () => void }) {
  if (!lead.nextAction) {
    return (
      <Card className="mb-4 flex items-center gap-4 border-l-[3px] border-l-warn px-5 py-3.5">
        <div className="flex-1">
          <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">No next action set</div>
          <div className="text-sm font-medium text-ink">This active lead has nothing scheduled</div>
          <div className="text-[12.5px] text-muted">Every active lead needs a next action — this is a gap.</div>
        </div>
        <Button size="sm" variant="primary" onClick={onEdit}>Set next action</Button>
      </Card>
    );
  }
  const overdue = new Date(lead.nextActionDate + "T00:00:00").getTime() < new Date(today.toDateString()).getTime();
  return (
    <Card className={cx("mb-4 flex flex-wrap items-center gap-6 px-5 py-3.5", overdue ? "border-l-[3px] border-l-danger" : "border-l-[3px] border-l-brand")}>
      <MetaItem label="Next action" value={lead.nextAction} />
      <MetaItem label={overdue ? "Overdue since" : "Due"} value={lead.nextActionDate} />
      <MetaItem label="Responsible" value={personName(lead.nextActionResp)} />
      <MetaItem label="Expected outcome" value={lead.expectedOutcome} />
      <Button size="sm" variant="secondary" className="ml-auto" onClick={onEdit}>Update</Button>
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
        <RelNode role="Distributor" name={lead.distributor ?? "—"} sub="Bills this account" />
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

function GateActionCard({ lead, onOpenModal }: { lead: Lead; onOpenModal: (k: NonNullable<ModalKind>, id: string) => void }) {
  const gate = gateActionFor(lead);
  return (
    <Card className="px-5 py-4">
      {gate.kind === "none" && (
        <div className="text-sm text-muted">Actual order confirmed — see 1st Order.</div>
      )}
      {gate.kind === "closed" && <div className="text-sm text-muted">{gate.label}</div>}
      {gate.kind === "visit" && <div className="text-sm text-muted">{gate.label}</div>}
      {gate.kind === "verify" && <Button variant="primary" onClick={() => onOpenModal("verify", lead.id)}>Verify prospect</Button>}
      {gate.kind === "awaitingVerification" && <Button variant="secondary" disabled>Awaiting manager verification</Button>}
      {gate.kind === "qualify" && <Button variant="primary" onClick={() => onOpenModal("qualify", lead.id)}>Open qualification checklist</Button>}
      {gate.kind === "requestSample" && (
        <>
          {gate.note ? <div className="mb-2.5 text-sm text-muted">{gate.note}</div> : null}
          <div className="flex gap-2">
            <Button variant="primary" disabled={gate.disabled} onClick={() => onOpenModal("requestSample", lead.id)}>
              Proceed to Sample / Trial
            </Button>
            <Button variant="ghost" onClick={() => onOpenModal("qualify", lead.id)}>Review checklist</Button>
          </div>
        </>
      )}
      {(gate.kind === "markDispatched" || gate.kind === "markReceived") && <MarkSampleButton lead={lead} label={gate.label} />}
      {gate.kind === "sampleReview" && <Button variant="primary" onClick={() => onOpenModal("sampleReview", lead.id)}>Record trial review</Button>}
      {gate.kind === "moveToNegotiation" && <MoveToNegotiationButton lead={lead} disabled={gate.disabled} note={gate.note} />}
      {gate.kind === "askOrder" && <Button variant="primary" onClick={() => onOpenModal("askOrder", lead.id)}>Record Commitment / Expected Order</Button>}
      {gate.kind === "confirmOrder" && (
        <>
          <Callout tone="warn" className="mb-3">{gate.note}</Callout>
          <Button variant="primary" onClick={() => onOpenModal("confirmOrder", lead.id)}>Confirm Actual Order</Button>
        </>
      )}
      {gate.kind === "awaitingManagement" && <div className="text-sm text-muted">{gate.label}</div>}
      {gate.kind === "confirmAgreement" && <ConfirmAgreementButton lead={lead} label={gate.label} />}
      {gate.kind === "recordInitialStock" && <RecordInitialStockButton lead={lead} label={gate.label} />}
    </Card>
  );
}

function ConfirmAgreementButton({ lead, label }: { lead: Lead; label: string }) {
  const { doConfirmAgreement } = useLeadPipeline();
  return <Button variant="primary" onClick={() => doConfirmAgreement(lead.id)}>{label}</Button>;
}
function RecordInitialStockButton({ lead, label }: { lead: Lead; label: string }) {
  const { doRecordInitialStock } = useLeadPipeline();
  return <Button variant="primary" onClick={() => doRecordInitialStock(lead.id)}>{label}</Button>;
}

function MarkSampleButton({ lead, label }: { lead: Lead; label: string }) {
  const { doMarkSampleDispatched, doMarkSampleReceived } = useLeadPipeline();
  const dispatched = lead.sample?.state === "dispatched";
  return (
    <Button variant="primary" onClick={() => (dispatched ? doMarkSampleReceived(lead.id) : doMarkSampleDispatched(lead.id))}>
      {label}
    </Button>
  );
}
function MoveToNegotiationButton({ lead, disabled, note }: { lead: Lead; disabled: boolean; note?: string }) {
  const { doMoveToNegotiation } = useLeadPipeline();
  return (
    <>
      <Button variant="primary" disabled={disabled} onClick={() => doMoveToNegotiation(lead.id)}>Move to Negotiation</Button>
      {note ? <div className="mt-2 text-[12.5px] text-muted">{note}</div> : null}
    </>
  );
}

/**
 * The prototype's own layout: a wide left column (opportunity facts, then
 * either the Suspect visit tracker or the verification summary) beside a
 * narrower right column carrying nothing but "Move this lead forward" — the
 * gate action lives HERE, scoped to this tab, not floating above every tab.
 */
function OverviewTab({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
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
            <MetaItem label="Email" value={lead.email} />
            <MetaItem label="Visits so far" value={String(lead.visits || 0)} />
          </div>
          <p className="mt-3 text-[12.5px] text-muted">
            Collected by the Salesman across the Suspect visits and Prospect conversion. The Sales Manager
            verifies and nurtures this — it is never re-collected from the customer.
          </p>
        </Card>

        {lead.stage === "suspect" ? <SuspectVisitTracker lead={lead} /> : <VerificationSummary lead={lead} />}
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Move this lead forward</div>
        <GateActionCard lead={lead} onOpenModal={openModal} />
      </div>
    </div>
  );
}

/** The prototype's `tabSuspect()`: up to 3 visit chips, a cap-reached warning, and the conversion decision. */
function SuspectVisitTracker({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
  const cap = 3;
  return (
    <Card className="mt-4 p-5">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        Suspect visits (maximum {cap} before a decision is forced)
      </div>
      <div className="flex gap-2">
        {[1, 2, 3].map((i) => {
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
      {lead.visits >= cap ? (
        <Callout tone="warn" className="mt-3.5">
          Third visit complete. A decision is required — this can no longer sit as a Suspect.
        </Callout>
      ) : null}
      <div className="mt-3.5 flex gap-2">
        <Button variant="primary" onClick={() => openModal("convert", lead.id)}>Convert to Prospect</Button>
        <Button variant="secondary" onClick={() => openModal("lost", lead.id)}>Not a Prospect</Button>
      </div>
    </Card>
  );
}

const OBJECTION_LABELS: [key: keyof Lead["verification"], label: string][] = [
  ["priceConcern", "Price"],
  ["qualityConcern", "Quality"],
  ["creditConcern", "Credit"],
  ["deliveryConcern", "Delivery"],
  ["serviceConcern", "Service"],
  ["competitorConcern", "Competitor"],
];

/** The prototype's `renderVerificationSummary()` — pending/failed callout with an inline action, or the full 6-row summary once done. */
function VerificationSummary({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
  const v = lead.verification;

  if (!v.done) {
    const priorResult = v.result ? VERIFICATION_RESULT_LABEL[v.result] : null;
    return (
      <Callout tone={v.result === "verification_failed" ? "danger" : "warn"} className="mt-4">
        <div>
          {priorResult ? <b>{priorResult}. </b> : <b>Manager verification pending. </b>}
          A prospect is nurtured only after the sales manager confirms the visit was real and the interest is
          genuine.
          <div className="mt-2">
            <Button size="sm" variant="primary" onClick={() => openModal("verify", lead.id)}>
              {priorResult ? "Re-verify" : "Verify now"}
            </Button>
          </div>
        </div>
      </Callout>
    );
  }

  const objections = OBJECTION_LABELS.filter(([key]) => v[key]).map(([, label]) => label);
  const readiness = [
    v.readyForTrial && "Trial",
    v.readyForCommercial && "Commercial discussion",
    v.readyForOrder && "Order discussion",
  ].filter(Boolean) as string[];

  return (
    <Card className="mt-4">
      <div className="flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
        <div className="text-[15px] font-semibold text-ink">Manager verification</div>
        <Badge tone="success">{VERIFICATION_RESULT_LABEL[v.result ?? ""] ?? "Verified"}</Badge>
      </div>
      <div className="px-5 py-4">
        <KvRow k="Salesman visited & explained Mahek properly" v={v.explainedWell ? "Yes" : "No"} />
        <KvRow k="Customer's current product" v={v.currentProduct || "—"} />
        <KvRow k="Impression of salesman's visit" v={v.impression || "—"} />
        <KvRow k="Objections raised" v={objections.length ? objections.join(", ") : "None raised"} />
        <KvRow k="Readiness" v={readiness.length ? readiness.join(", ") : "—"} last={!lead.verificationCorrections?.length} />
        <KvRow k="Genuine interest" v={v.genuineInterest ? "Yes" : "No"} last={!lead.verificationCorrections?.length} />
      </div>
      {lead.verificationCorrections?.length ? (
        <div className="border-t border-divider px-5 py-4">
          <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Corrections to salesman findings</div>
          {lead.verificationCorrections.map((c) => (
            <KvRow
              key={c.field}
              k={c.field}
              v={
                <>
                  {c.original} → <b>{c.corrected}</b> <span className="font-normal text-muted">({c.reason})</span>
                </>
              }
            />
          ))}
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
  return (
    <div className="space-y-4">
      <Card className="p-5">
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
      </Card>
      <Card className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
        <MetaItem label="Product" value={lead.product} />
        <MetaItem label="Quantity" value={s.quantity} />
        <MetaItem label="Application" value={lead.application} />
        <MetaItem label="Courier / logistics" value={s.courier} />
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
      ) : (
        <Callout tone="warn">Trial feedback not recorded yet.</Callout>
      )}
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
  const n = lead.negotiation;
  const c = lead.commitment;
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Negotiation</div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
          <MetaItem label="Quantity under discussion" value={n?.quantity ?? "Not Yet Confirmed"} />
          <MetaItem label="Salesman visit completed" value={n?.visitDone ? "Yes" : "Pending"} />
          <MetaItem label="Blockers raised" value={n?.blockers.length ? n.blockers.map((b) => LOST_REASONS.find((r) => r.code === b)?.label ?? b).join(", ") : "None"} />
          <MetaItem label="Customer's objection" value={n?.objection ?? "Not Yet Confirmed"} />
        </div>
      </Card>
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Commitment — forecast, not a sale
          {c ? <span className="rounded-[3px] bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn-ink normal-case">Forecast</span> : null}
        </div>
        {c ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
            <MetaItem label="Expected quantity" value={c.quantity} />
            <MetaItem label="Expected order date" value={c.expectedOrderDate} />
            <MetaItem label="Recorded by" value={`${personName(c.recordedBy)}, ${c.recordedAt}`} />
          </div>
        ) : (
          <p className="text-sm text-muted">No commitment recorded yet — an Expected Order Date only counts once it&rsquo;s on file here, and it is still a forecast until the order actually arrives.</p>
        )}
      </Card>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => openModal("askOrder", lead.id)}>{c ? "Update Commitment" : "Record Commitment / Expected Order"}</Button>
        {c && !lead.order ? <Button variant="secondary" onClick={() => openModal("confirmOrder", lead.id)}>Confirm Actual Order</Button> : null}
      </div>
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
          Requested commercial terms
          <span className="rounded-[3px] bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold text-warn-ink normal-case">Needs management sign-off</span>
        </div>
        <MetaItem label="Territorial exclusivity" value={p.exclusivityRequested ? "Requested" : "Not requested"} />
        <div className="mt-2 grid grid-cols-2 gap-4">
          <MetaItem label="Discount" value={p.discountRequested} />
          <MetaItem label="Credit limit requested" value={money(p.creditLimitRequestedPaise)} />
        </div>
      </Card>
    </div>
  );
}

function ApprovalTab({ lead }: { lead: Lead }) {
  const p = lead.distributorProfile;
  const steps = [
    { label: "Sales manager recommends", done: true },
    { label: "Management reviews", done: ["distributor_agreement", "initial_stock_order", "active_distributor"].includes(lead.stage), current: ["management_review", "commercial_discussion", "distributor_approval"].includes(lead.stage) },
    { label: "Appointed", done: lead.stage === "active_distributor" },
  ];
  const reasons = [
    p?.exclusivityRequested && "exclusivity requested",
    p?.discountRequested && "discount above the sales-manager limit",
    p?.creditLimitRequestedPaise && p.creditLimitRequestedPaise > 30000000 && "credit limit above the sales-manager limit",
  ].filter(Boolean);
  return (
    <Card className="p-5">
      <div className="mb-4 text-xs font-medium tracking-[0.04em] text-muted uppercase">Two-step management approval</div>
      <div className="mb-4 flex items-center gap-2">
        {steps.map((s, i) => (
          <React.Fragment key={s.label}>
            {i > 0 ? <span className={cx("h-px flex-1", s.done ? "bg-brand" : "bg-line")} /> : null}
            <div className="flex flex-col items-center gap-1">
              <span
                className={cx(
                  "flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-semibold",
                  s.done ? "bg-brand text-white" : s.current ? "border-2 border-brand text-brand-hover" : "border border-line-strong text-muted",
                )}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className="w-20 text-center text-[10.5px] leading-tight text-muted">{s.label}</span>
            </div>
          </React.Fragment>
        ))}
      </div>
      <Callout tone={reasons.length ? "warn" : "brand"}>
        Escalated to a second approval because: {reasons.length ? reasons.join(", ") : "standard review"}.
      </Callout>
      <p className="mt-3 text-[13px] text-muted">This step is Management&rsquo;s to decide — not implemented in the Sales Manager view.</p>
    </Card>
  );
}

function CommsTab({ lead }: { lead: Lead }) {
  return (
    <Card className="p-5">
      <div className="mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">Communication actions</div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {COMMS_ACTIONS.map((a) => {
          const done = !!lead.comms[a.code];
          return (
            <div
              key={a.code}
              className={cx(
                "flex flex-col items-start gap-1.5 rounded-[7px] border px-3 py-3 text-left text-[12.5px] font-medium",
                done ? "border-brand-softer bg-brand-soft text-brand-hover" : "border-line bg-surface text-ink",
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
                {done ? <span className="ml-1.5 text-[11px] font-semibold text-brand-hover">✓ done</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const ACTOR_LABEL: Record<string, string> = {
  system: "System",
  sales_manager: "Sales Manager",
  salesman: "Salesman",
};
const ACTOR_TONE: Record<string, Tone> = {
  system: "neutral",
  sales_manager: "warn",
  salesman: "brand",
};

function TimelineTab({ lead }: { lead: Lead }) {
  const entries = lead.timeline; // oldest first, in the order events actually happened
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
    </Card>
  );
}
