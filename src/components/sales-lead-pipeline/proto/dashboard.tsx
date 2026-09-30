import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import { daysUntil } from "@/lib/sales-lead-pipeline/engine";
import { personName, STAGE_LABEL } from "@/lib/sales-lead-pipeline/reference";
import type { DashboardData, PipelineRow } from "@/lib/sales-lead-pipeline/types";
import { pipelineLinks } from "@/lib/sales-lead-pipeline/workspace";
import {
  PBadge,
  PCard,
  PEmpty,
  PFunnel,
  PMetricStrip,
  PPage,
  PPageHead,
  PPriorityBadge,
  PSectionLabel,
  PStageBadge,
  fmtDay,
  managerAction,
  pbtn,
  stageFilter,
} from "./ui";

/**
 * The Sales Manager's morning, drawn the way the prototype draws it: a header,
 * two connected metric strips, then attention + pipeline on the left and the
 * focus card on the right.
 *
 * Nothing here counts anything. Every figure is the one `pipelineDashboard`
 * already computed in SQL over the CRM Sales Manager's book; this file only
 * decides how it looks. A server component — every tile and bar is a link.
 */
export function ProtoDashboard({ data }: { data: DashboardData }) {
  const links = pipelineLinks("crm");
  const BASE = links.base;
  const { book, manager: mgr, funnel, attention, focus } = data;
  const today = new Date(`${data.today}T00:00:00`);
  const list = (qs: string) => `${BASE}/list?${qs}`;

  return (
    <PPage>
      <PPageHead
        eyebrow="Sales Manager workspace"
        title={data.greeting}
        sub="Verification, nurturing and negotiation across the whole territory's funnel."
        actions={
          <>
            <Link href={`${BASE}/pipeline`} className={pbtn("secondary")}>
              <Icon name="chart" size={15} /> View pipeline
            </Link>
            <Link href={links.intake} className={pbtn("primary")}>
              <Icon name="plus" size={15} /> New lead
            </Link>
          </>
        }
      />

      <PMetricStrip
        metrics={[
          { label: "My leads", value: String(book.mine), sub: "active", href: `${BASE}/mine` },
          { label: "Today's actions", value: String(book.today), sub: "due today", href: `${BASE}/today` },
          { label: "Overdue", value: String(book.overdue), sub: "need a next action", tone: book.overdue ? "danger" : undefined, href: `${BASE}/overdue` },
          { label: "New suspects", value: String(book.suspects), href: list("stage=suspect,new") },
          { label: "Prospects", value: String(book.prospects), href: list("stage=prospect,contacted") },
          { label: "In sample", value: String(book.sample), tone: "warn", href: list("stage=sample_trial,sample_received,sample_review") },
          { label: "Negotiations", value: String(book.negotiation), href: list("stage=negotiation") },
          { label: "Expected orders", value: String(book.expected), tone: "success", href: list("view=expected") },
          { label: "Lost (30d)", value: String(book.lost30), href: list("view=lost30") },
        ]}
      />

      <PSectionLabel className="mt-1">Sales Manager — verification &amp; nurturing</PSectionLabel>
      <PMetricStrip
        metrics={[
          { label: "Prospects Pending Verification", value: String(mgr.pendingVerification), tone: mgr.pendingVerification ? "warn" : undefined, href: list("stage=prospect,contacted") },
          { label: "Verified Prospects", value: String(mgr.verifiedProspects), tone: "success" },
          { label: "Verification Failed", value: String(mgr.verificationFailed), tone: mgr.verificationFailed ? "danger" : undefined },
          { label: "Sample Reviews Pending", value: String(mgr.sampleReviewsPending), tone: mgr.sampleReviewsPending ? "warn" : undefined },
          { label: "Negotiations Pending", value: String(mgr.negotiationsPending), href: list("stage=negotiation") },
          { label: "Awaiting Actual Order Confirmation", value: String(mgr.awaitingActualOrder), tone: mgr.awaitingActualOrder ? "warn" : undefined, sub: "forecast only, not yet a sale" },
          { label: "Expected Orders This Week", value: String(mgr.expectedThisWeek), tone: "success", sub: "forecast dates due soon" },
        ]}
      />
      <p className="mb-4 text-[12px] leading-4 text-muted">
        The Salesman collects and develops; the Sales Manager verifies, nurtures and confirms — never re-asking a customer for something the CRM already has.
      </p>

      <div className="grid items-start gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div>
          <PSectionLabel>Needs your attention</PSectionLabel>
          <PCard className="mb-4">
            {attention.length === 0 ? (
              <PEmpty title="Nothing overdue" body="Every active lead in your book has a next action on or ahead of schedule." />
            ) : (
              attention.map((l) => <AttentionRow key={l.id} lead={l} today={today} base={BASE} />)
            )}
          </PCard>
          {book.overdue + book.today > attention.length ? (
            <div className="-mt-2 mb-4 text-right text-[12.5px]">
              <Link href={`${BASE}/overdue`} className="font-medium text-brand hover:text-brand-hover">
                See all {book.overdue} overdue →
              </Link>
            </div>
          ) : null}

          <PSectionLabel>Pipeline at a glance</PSectionLabel>
          <PCard className="px-[18px] pt-[18px] pb-1.5">
            <PFunnel
              height={44}
              bars={funnel.map((f) => ({ stage: f.stage, label: f.label, count: f.count, href: `${BASE}/list?stage=${stageFilter(f.stage)}` }))}
            />
          </PCard>
        </div>

        <div>
          <PSectionLabel>Sales Manager focus</PSectionLabel>
          <PCard>
            {focus.length === 0 ? (
              <PEmpty title="No lead carries your seat yet" />
            ) : (
              focus.map((lead) => {
                const ra = managerAction(lead.stage, lead.hasCommitment);
                return (
                  <Link
                    key={lead.id}
                    href={`${BASE}/${lead.id}`}
                    className="flex items-center gap-2.5 border-b border-divider px-4 py-3 last:border-b-0 hover:bg-canvas"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">{lead.name}</span>
                      <span className="block text-[12px] text-muted">{lead.stage ? STAGE_LABEL[lead.stage] : "Lost"}</span>
                    </span>
                    <PBadge tone={ra.tone} className="flex-none">
                      {ra.label}
                    </PBadge>
                  </Link>
                );
              })
            )}
          </PCard>
          {book.mine > focus.length ? (
            <div className="mt-1.5 text-right text-[12.5px]">
              <Link href={`${BASE}/mine`} className="font-medium text-brand hover:text-brand-hover">
                See all {book.mine} →
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </PPage>
  );
}

function AttentionRow({ lead: l, today, base }: { lead: PipelineRow; today: Date; base: string }) {
  const d = daysUntil(l.nextActionDate, today);
  const overdue = d !== null && d < 0;
  return (
    <Link href={`${base}/${l.id}`} className="flex items-center gap-2.5 border-b border-divider px-4 py-3 last:border-b-0 hover:bg-canvas">
      <span className={`mr-1 w-1.5 flex-none self-stretch rounded-[3px] ${overdue ? "bg-danger" : "bg-warn"}`} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">{l.name}</span>
          <PStageBadge stage={l.stage} />
          <PPriorityBadge priority={l.priority} />
        </span>
        <span className="block truncate text-[12px] text-muted">
          {l.nextAction ?? "—"} · {personName(l.nextActionResp)}
        </span>
      </span>
      <span className="flex-none text-right">
        <span className={`block text-[12.5px] font-[650] ${overdue ? "text-danger" : "text-warn-ink"}`}>
          {d === null ? "—" : overdue ? `${Math.abs(d)}d overdue` : d === 0 ? "Today" : `in ${d}d`}
        </span>
        <span className="block text-[11px] text-muted">{fmtDay(l.nextActionDate)}</span>
      </span>
    </Link>
  );
}
