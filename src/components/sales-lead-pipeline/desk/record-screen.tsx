"use client";

import * as React from "react";
import Link from "next/link";

import { cx } from "@/components/ui/primitives";
import { disabledReasons } from "@/lib/sales-lead-pipeline/desk";
import { STAGE_LABEL, ladderFor, personName } from "@/lib/sales-lead-pipeline/reference";
import type { Lead } from "@/lib/sales-lead-pipeline/types";
import {
  ApprovalTab,
  DistributorProfileTab,
  GateActionCard,
  NegotiationTab,
  SampleTab,
  SuspectVisitTracker,
  VerificationSummary,
  tabsFor,
  type Tab,
} from "../lead-record-screen";
import { useLeadPipeline } from "../provider";
import {
  ProtoComms,
  ProtoNextAction,
  ProtoOpportunityGrid,
  ProtoOrderTab,
  ProtoRecordHeader,
  ProtoRelationship,
  ProtoStanding,
  ProtoTabs,
  ProtoTimeline,
} from "../proto/record-parts";
import { PBadge, PCard, PPage, PSectionLabel } from "../proto/ui";

/* ---------------------------------------------------------------------------
 * The Sales Manager's lead record — the Telecaller desk record's shape (what
 * the lead needs now, who owes it, the ladder, the cards, the tabs), over the
 * SAME lead the salesman works.
 *
 * ONE RECORD. Nothing here is a copy: `useLeadPipeline().lead` is whatever the
 * server rendered for this customer id, every button is one of the existing
 * Sales Manager actions behind the provider, and every dialog is `LeadModals`.
 *
 * WHAT IS NEW is the framing: the salesman's side of the lead is drawn on its
 * own card (visits, requirement, notes, what he has done and what he owes),
 * and an action the signed-in manager's account cannot take is SAID to be off,
 * with the permission that would switch it on — `disabledReasons` — rather than
 * left for the server to refuse. The permissions themselves are not touched.
 * ------------------------------------------------------------------------- */

export type TimelinePaging = { total: number; nextHref: string | null; newestHref: string | null };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-divider py-2 text-[13px] last:border-0">
      <span className="text-muted">{k}</span>
      <span className="text-right font-medium text-ink">{v || "—"}</span>
    </div>
  );
}

/** What the salesman has done on this lead, read off the one record. */
function SalesmanCard({ lead, today }: { lead: Lead; today: Date }) {
  const mine = lead.timeline.filter((t) => t.kind === "salesman").slice(0, 5);
  const owesIt = Boolean(lead.nextAction) && Boolean(lead.ownerId) && lead.nextActionOwnerId === lead.ownerId;
  const days = lead.nextActionDate ? Math.round((new Date(`${lead.nextActionDate}T00:00:00`).getTime() - new Date(today.toDateString()).getTime()) / 86_400_000) : null;
  return (
    <PCard className="mb-4 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10.5px] font-semibold tracking-[0.06em] text-muted uppercase">Salesman</div>
          <div className="text-[15px] font-[650] text-ink">{lead.ownerId ? personName(lead.owner) : "No salesman yet"}</div>
        </div>
        <PBadge tone={owesIt ? (days !== null && days < 0 ? "danger" : "warn") : "muted"}>
          {owesIt ? (days !== null && days < 0 ? "Salesman is overdue" : "Waiting on the salesman") : "Nothing owed by the salesman"}
        </PBadge>
      </div>

      <div className="mt-2">
        <Row
          k="Visits"
          v={`${lead.visits} of ${lead.suspectCap} before a decision${lead.mustDecide ? " — a decision is now due" : ""}`}
        />
        <Row k="Owes next" v={owesIt ? `${lead.nextAction}${lead.nextActionDate ? ` · ${lead.nextActionDate}` : ""}` : undefined} />
        <Row k="Sample" v={lead.sample ? `${lead.sample.state.replace("_", " ")}${lead.sample.trialOutcome !== "pending" ? ` · ${lead.sample.trialOutcome.replace("_", " ")}` : ""}` : undefined} />
        <Row k="Orders" v={lead.orders.length ? `${lead.orders.length} on the account` : lead.commitment ? "Expected order on file" : undefined} />
      </div>

      {lead.salesmanNotes ? (
        <div className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2">
          <div className="text-[10.5px] font-[650] tracking-[0.04em] text-muted uppercase">Salesman&rsquo;s notes</div>
          <p className="mt-0.5 text-[13px] whitespace-pre-line text-body">{lead.salesmanNotes}</p>
        </div>
      ) : null}

      <div className="mt-3">
        <div className="text-[10.5px] font-[650] tracking-[0.04em] text-muted uppercase">Recent salesman activity</div>
        {mine.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-muted">No salesman entries on the timeline yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {mine.map((t, i) => (
              <li key={`${t.d}-${i}`} className="flex gap-2 text-[12.5px]">
                <span className="w-[74px] flex-none text-muted">{t.d}</span>
                <span className="text-body">{t.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PCard>
  );
}

function QualificationCard({ lead }: { lead: Lead }) {
  const { openModal } = useLeadPipeline();
  if (lead.stage !== "qualification" && lead.stage !== "qualified") return null;
  const done = lead.qualItems.filter((i) => i.done).length;
  const verdict = lead.qualReview?.verdict;
  const tone = verdict === "verified" ? "success" : verdict ? "warn" : "muted";
  return (
    <PCard className="mb-4 px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <PSectionLabel className="!mb-0">Qualification review</PSectionLabel>
        <PBadge tone={tone}>
          {verdict === "verified" ? "Verified" : verdict === "incomplete" ? "Marked incomplete" : verdict === "clarification" ? "Clarification asked" : "Not reviewed"}
        </PBadge>
      </div>
      <p className="mt-2 text-[13px] text-body">
        The Telecaller has {done} of {lead.qualItems.length} conditions answered. Only a verified review lets this lead go to Sample / Trial.
      </p>
      {lead.qualReview?.note ? <p className="mt-1 text-[12.5px] text-muted">&ldquo;{lead.qualReview.note}&rdquo;</p> : null}
      <button
        type="button"
        disabled={!lead.caps.canVerify}
        title={lead.caps.canVerify ? undefined : "Needs the lead.verify permission"}
        onClick={() => openModal("qualify", lead.id)}
        className="mt-3 inline-flex h-[34px] items-center rounded-[4px] border border-brand bg-brand px-3.5 text-[13.5px] font-[550] text-white disabled:cursor-not-allowed disabled:opacity-55"
      >
        Open the checklist and review
      </button>
    </PCard>
  );
}

export function SalesManagerRecordScreen({ initialTab, timeline }: { initialTab?: string; timeline: TimelinePaging }) {
  const { lead, openModal, todayDate, links } = useLeadPipeline();
  const [tab, setTab] = React.useState<Tab>((initialTab as Tab) || "overview");

  const ladder = ladderFor(lead.salesType);
  const currentIdx = ladder.indexOf(lead.stage);
  const tabs = tabsFor(lead, true);
  const active = tabs.some((t) => t.key === tab) ? tab : "overview";
  const canWork = lead.caps.canWork;

  const reasons = disabledReasons(lead.caps, {
    stage: lead.stage,
    lost: Boolean(lead.lost),
    deskRequest: Boolean(lead.deskRequest),
    verified: lead.verification.done,
    sampleState: lead.sample?.state ?? null,
    gateKind: lead.gate.kind,
  });

  return (
    <PPage>
      <div className="mb-2.5 text-[12.5px] text-muted">
        <Link href={links.base} className="text-brand">
          Sales Manager desk
        </Link>
        {lead.ownerId ? ` / ${personName(lead.owner)}` : ""} / {lead.name}
      </div>

      {lead.lost ? (
        <div className="mb-4 rounded-lg border border-danger-soft bg-danger-soft px-4 py-3 text-[13px] text-ink">
          <b>This lead is marked Lost.</b> Reason: {lead.lost.reasonLabel}
          {lead.lost.by ? ` · by ${personName(lead.lost.by)}` : ""}
          {lead.lost.date ? ` on ${lead.lost.date}` : ""}.{lead.lost.note ? ` “${lead.lost.note}”` : ""} The record and its full timeline remain for reference.
        </div>
      ) : null}
      {lead.deskRequest && !lead.lost ? (
        <div className="mb-4 rounded-lg border border-brand-softer bg-brand-soft px-4 py-3 text-[13px] text-ink">
          <b>The calling desk has asked for this lead to be put forward as a Prospect.</b> It stays a Suspect until your verification call succeeds.
        </div>
      ) : null}

      <ProtoRecordHeader
        lead={lead}
        canWork={canWork}
        editHref={`${links.base}/${lead.id}/edit`}
        onReassign={() => openModal("reassign", lead.id)}
        onLost={() => openModal("lost", lead.id)}
      />
      {!lead.lost ? <ProtoNextAction lead={lead} today={todayDate} canWork={canWork} onEdit={() => openModal("nextaction", lead.id)} /> : null}
      {lead.salesType === "third_party" ? <ProtoRelationship lead={lead} /> : null}

      {/* The whole ladder, straight under the next-action band — every rung, done / current / upcoming. */}
      <ProtoStanding lead={lead} ladder={ladder} currentIdx={currentIdx} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <SalesmanCard lead={lead} today={todayDate} />
          <PSectionLabel>Opportunity — collected by the salesman</PSectionLabel>
          <ProtoOpportunityGrid lead={lead} />
        </div>
        <div>
          <PSectionLabel>Your action</PSectionLabel>
          <div className="mb-4">
            <GateActionCard lead={lead} />
            {reasons.length ? (
              <ul className={cx("mt-2 space-y-1 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn-ink")}>
                {reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <QualificationCard lead={lead} />
          {lead.stage === "suspect" || lead.stage === "new" ? <SuspectVisitTracker lead={lead} /> : <VerificationSummary lead={lead} />}
        </div>
      </div>

      <ProtoTabs tabs={tabs} active={active} onChange={setTab} />

      <div>
        {active === "overview" ? (
          <p className="text-[13px] text-muted">
            {STAGE_LABEL[lead.stage]} · everything the salesman and the Telecaller have recorded is above. Use the tabs for the sample, the negotiation, the order, the messages sent and the full timeline.
          </p>
        ) : null}
        {active === "sample" ? <SampleTab lead={lead} /> : null}
        {active === "negotiation" ? <NegotiationTab lead={lead} /> : null}
        {active === "profile" ? <DistributorProfileTab lead={lead} /> : null}
        {active === "approval" ? <ApprovalTab lead={lead} /> : null}
        {active === "order" ? <ProtoOrderTab lead={lead} /> : null}
        {active === "comms" ? <ProtoComms lead={lead} /> : null}
        {active === "timeline" ? <ProtoTimeline lead={lead} paging={timeline} /> : null}
      </div>
    </PPage>
  );
}
