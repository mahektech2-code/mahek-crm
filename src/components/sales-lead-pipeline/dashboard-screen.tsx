"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Card, MetricStrip, PageHeader, SectionLabel, type Tone } from "@/components/ui/primitives";
import { daysUntil } from "@/lib/sales-lead-pipeline/engine";
import { LeadStatusBadges } from "./badges";
import { personName } from "@/lib/sales-lead-pipeline/reference";
import { Icon } from "@/components/shell/icons";
import type { DashboardData, PipelineRow } from "@/lib/sales-lead-pipeline/types";

const BASE = "/sales-lead-pipeline";

/** Maps the verb on a focus row onto the CRM's own existing badge tones. */
function toneForLabel(label: string | undefined): Tone {
  if (!label) return "muted";
  if (/verif|confirm|payment|dispatch/i.test(label)) return "danger";
  if (/qualif|sample|negotiat|commit|order|move/i.test(label)) return "warn";
  if (/convert|visit/i.test(label)) return "brand";
  return "muted";
}

/**
 * The Sales Manager's morning, drawn from figures the SERVER counted.
 *
 * Every number here is a `count(*)` over the same scoped book the lead list
 * uses (`leadTileCounts`, `verificationQueue`, `commitments`, `funnelByRung`),
 * and every list is one page of `leadsPage` — so a tile and the list it opens
 * cannot disagree, and nothing here loads the book into the browser.
 */
export function DashboardScreen({ data }: { data: DashboardData }) {
  const router = useRouter();
  const { book, manager: mgr, funnel, attention, focus } = data;
  const today = new Date(`${data.today}T00:00:00`);
  const maxCount = Math.max(1, ...funnel.map((f) => f.count));
  const goto = (href: string) => router.push(href);

  return (
    <div className="p-6">
      <div className="text-[10.5px] font-semibold tracking-[0.06em] text-muted uppercase">Sales Manager workspace</div>
      <PageHeader
        title={data.greeting}
        subtitle="Verification, nurturing and negotiation across the whole territory's funnel."
        actions={
          <>
            <Link
              href={`${BASE}/pipeline`}
              className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
            >
              <Icon name="chart" size={15} />
              View pipeline
            </Link>
            <Link
              href="/sales/leads/intake"
              className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover hover:border-brand-hover"
            >
              <Icon name="plus" size={15} />
              New lead
            </Link>
          </>
        }
      />

      <MetricStrip
        metrics={[
          { label: "My leads", value: String(book.mine), sub: "carrying one of your seats", onClick: () => goto(`${BASE}/list?view=mine`) },
          { label: "Today's actions", value: String(book.today), sub: "due today", onClick: () => goto(`${BASE}/list?view=today`) },
          { label: "Overdue", value: String(book.overdue), tone: book.overdue ? "danger" : "ink", sub: "need a next action", onClick: () => goto(`${BASE}/list?view=overdue`) },
          { label: "New suspects", value: String(book.suspects), onClick: () => goto(`${BASE}/list?stage=suspect,new`) },
          { label: "Prospects", value: String(book.prospects), onClick: () => goto(`${BASE}/list?stage=prospect,contacted`) },
          { label: "In sample", value: String(book.sample), onClick: () => goto(`${BASE}/list?stage=sample_trial,sample_received,sample_review`) },
          { label: "Negotiations", value: String(book.negotiation), onClick: () => goto(`${BASE}/list?stage=negotiation`) },
          { label: "Expected orders", value: String(book.expected), tone: "success", sub: "a day and a size", onClick: () => goto(`${BASE}/list?view=expected`) },
          { label: "Lost (30d)", value: String(book.lost30), onClick: () => goto(`${BASE}/list?view=lost30`) },
        ]}
      />

      <SectionLabel>Sales Manager — verification &amp; nurturing</SectionLabel>
      <MetricStrip
        metrics={[
          { label: "Prospects Pending Verification", value: String(mgr.pendingVerification), tone: mgr.pendingVerification ? undefined : "ink", sub: "incl. calling-desk requests", onClick: () => goto("/sales/leads/qualify") },
          { label: "Verified Prospects", value: String(mgr.verifiedProspects), tone: "success", sub: "verified, not yet qualifying", onClick: () => goto(`${BASE}/list?stage=prospect,contacted`) },
          { label: "Verification Failed", value: String(mgr.verificationFailed), tone: mgr.verificationFailed ? "danger" : "ink", sub: "closed in the last 30 days" },
          { label: "Sample Reviews Pending", value: String(mgr.sampleReviewsPending), sub: "shop has it, no verdict", onClick: () => goto(`${BASE}/list?stage=sample_received,sample_review`) },
          { label: "Negotiations Pending", value: String(mgr.negotiationsPending), onClick: () => goto(`${BASE}/list?stage=negotiation`) },
          { label: "Awaiting Actual Order Confirmation", value: String(mgr.awaitingActualOrder), sub: "forecast only, not yet a sale" },
          { label: "Expected Orders This Week", value: String(mgr.expectedThisWeek), tone: "success", sub: "forecast dates due soon" },
        ]}
      />
      <p className="mb-5 text-[13px] text-muted">
        The Salesman collects and develops; the Sales Manager verifies, nurtures and confirms — never
        re-asking a customer for something the CRM already has.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-4">
          <div>
            <SectionLabel>Needs your attention</SectionLabel>
            <Card className="mt-1.5">
              {attention.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <div className="text-sm font-semibold text-ink">Nothing overdue</div>
                  <div className="mt-1 text-[13px] text-muted">
                    Every active lead in your book has a next action on or ahead of schedule.
                  </div>
                </div>
              ) : (
                attention.map((l) => <AttentionRow key={l.id} lead={l} today={today} />)
              )}
            </Card>
            {book.overdue + book.today > attention.length ? (
              <div className="mt-1.5 text-right text-[12.5px]">
                <Link href={`${BASE}/list?view=overdue`} className="font-medium text-brand hover:text-brand-hover">
                  See all {book.overdue} overdue →
                </Link>
              </div>
            ) : null}
          </div>

          <div>
            <SectionLabel>Pipeline at a glance</SectionLabel>
            <Link href={`${BASE}/pipeline`}>
              <Card className="mt-1.5 px-5 pt-5 pb-2">
                <div className="flex items-end gap-3" style={{ height: 90 }}>
                  {funnel.map((f) => (
                    <div key={f.stage} className="flex flex-1 flex-col items-center justify-end gap-1">
                      <span className="text-[11px] font-semibold text-ink">{f.count}</span>
                      <div
                        className="w-full rounded-t-[3px] bg-brand-soft"
                        style={{ height: Math.max(6, (f.count / maxCount) * 64) }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-3 border-t border-divider pt-2">
                  {funnel.map((f) => (
                    <span key={f.stage} className="flex-1 text-center text-[10px] leading-tight text-muted">
                      {f.label}
                    </span>
                  ))}
                </div>
              </Card>
            </Link>
          </div>
        </div>

        <div>
          <SectionLabel>Sales Manager focus</SectionLabel>
          <Card className="mt-1.5">
            {focus.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted">No lead carries one of your seats yet.</div>
            ) : (
              focus.map((lead) => (
                <Link
                  key={lead.id}
                  href={`${BASE}/${lead.id}`}
                  className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 last:border-0 hover:bg-canvas"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-ink">{lead.name}</span>
                  <Badge tone={toneForLabel(lead.gateLabel)} className="flex-none">
                    {lead.gateLabel ?? "Monitor"}
                  </Badge>
                </Link>
              ))
            )}
          </Card>
          {book.mine > focus.length ? (
            <div className="mt-1.5 text-right text-[12.5px]">
              <Link href={`${BASE}/list?view=mine`} className="font-medium text-brand hover:text-brand-hover">
                See all {book.mine} →
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AttentionRow({ lead: l, today }: { lead: PipelineRow; today: Date }) {
  const d = daysUntil(l.nextActionDate, today);
  const overdueRow = d !== null && d < 0;
  return (
    <Link
      href={`${BASE}/${l.id}`}
      className="flex items-center gap-3 border-b border-divider px-4 py-3 last:border-0 hover:bg-canvas"
    >
      <span className={`h-full w-1 flex-none self-stretch rounded ${overdueRow ? "bg-danger" : "bg-warn"}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{l.name}</span>
          <LeadStatusBadges lead={l} />
        </span>
        <span className="block truncate text-[13px] text-muted">
          {l.nextAction ?? "—"} · {personName(l.nextActionResp)}
        </span>
      </span>
      <span className="flex-none text-right">
        <span className={`block text-[13px] font-semibold ${overdueRow ? "text-danger" : "text-warn-ink"}`}>
          {d === null ? "—" : overdueRow ? `${Math.abs(d)}d overdue` : d === 0 ? "Today" : `in ${d}d`}
        </span>
        <span className="block text-[11px] text-muted">{l.nextActionDate}</span>
      </span>
    </Link>
  );
}
