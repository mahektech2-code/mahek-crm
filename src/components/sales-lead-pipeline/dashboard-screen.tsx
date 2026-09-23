"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Card, MetricStrip, PageHeader, SectionLabel, type Tone } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { useLeadPipeline } from "./provider";
import { daysUntil, funnelCounts, type GateAction, gateActionFor, isDueToday, isOverdue, managerKpis, personalBookCounts } from "@/lib/sales-lead-pipeline/engine";
import { LeadStatusBadges } from "./badges";
import { personName } from "@/lib/sales-lead-pipeline/reference";
import { Icon } from "@/components/shell/icons";

/** Maps a gate action's urgency onto the CRM's own existing badge tones. */
function toneForGate(kind: GateAction["kind"]): Tone {
  switch (kind) {
    case "verify":
    case "confirmOrder":
      return "danger";
    case "qualify":
    case "requestSample":
    case "sampleReview":
    case "moveToNegotiation":
    case "askOrder":
      return "warn";
    case "visit":
      return "brand";
    case "none":
    case "closed":
    case "awaitingVerification":
    case "awaitingManagement":
    default:
      return "muted";
  }
}

export function DashboardScreen() {
  const { leads, today } = useLeadPipeline();
  const router = useRouter();
  const toast = useToast();
  const book = personalBookCounts(leads);
  const mgr = managerKpis(leads, today);
  const funnel = funnelCounts(leads);
  const maxCount = Math.max(1, ...funnel.map((f) => f.count));

  const active = leads.filter((l) => !l.lost);
  const overdue = active.filter((l) => isOverdue(l, today));
  const dueToday = active.filter((l) => isDueToday(l, today) && !overdue.includes(l));
  const attention = [...overdue, ...dueToday].slice(0, 6);

  const focus = active
    .filter((l) => l.manager === "amit")
    .slice(0, 7)
    .map((l) => ({ lead: l, action: gateActionFor(l) }));

  const goto = (href: string) => router.push(href);

  return (
    <div className="p-6">
      <div className="text-[10.5px] font-semibold tracking-[0.06em] text-muted uppercase">Sales Manager workspace</div>
      <PageHeader
        title="Good morning, Amit"
        subtitle="Verification, nurturing and negotiation across the whole territory's funnel."
        actions={
          <>
            <Link
              href="/sales-lead-pipeline/pipeline"
              className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
            >
              <Icon name="chart" size={15} />
              View pipeline
            </Link>
            <button
              type="button"
              onClick={() =>
                toast.push("New-lead capture is a salesman/telecaller field form — not part of this design pass.")
              }
              className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover hover:border-brand-hover"
            >
              <Icon name="plus" size={15} />
              New lead
            </button>
          </>
        }
      />

      <MetricStrip
        metrics={[
          { label: "My leads", value: String(book.mine), sub: "active", onClick: () => goto("/sales-lead-pipeline/list") },
          { label: "Today's actions", value: String(dueToday.length), sub: "due today", onClick: () => goto("/sales-lead-pipeline/list?due=today") },
          { label: "Overdue", value: String(overdue.length), tone: overdue.length ? "danger" : "ink", sub: "need a next action", onClick: () => goto("/sales-lead-pipeline/list?due=overdue") },
          { label: "New suspects", value: String(book.suspects), onClick: () => goto("/sales-lead-pipeline/list?stage=suspect") },
          { label: "Prospects", value: String(book.prospects), onClick: () => goto("/sales-lead-pipeline/list?stage=prospect") },
          { label: "In sample", value: String(book.inSample), onClick: () => goto("/sales-lead-pipeline/list") },
          { label: "Negotiations", value: String(book.negotiations), onClick: () => goto("/sales-lead-pipeline/list?stage=negotiation") },
          { label: "Expected orders", value: String(book.expectedOrders), tone: "success" },
          { label: "Lost (30d)", value: String(book.lost) },
        ]}
      />

      <SectionLabel>Sales Manager — verification &amp; nurturing</SectionLabel>
      <MetricStrip
        metrics={[
          { label: "Prospects Pending Verification", value: String(mgr.pendingVerification), tone: mgr.pendingVerification ? undefined : "ink", onClick: () => goto("/sales-lead-pipeline/list?stage=prospect") },
          { label: "Verified Prospects", value: String(mgr.verifiedProspects), tone: "success" },
          { label: "Verification Failed", value: String(mgr.verificationFailed), tone: mgr.verificationFailed ? "danger" : "ink" },
          { label: "Sample Reviews Pending", value: String(mgr.sampleReviewsPending) },
          { label: "Negotiations Pending", value: String(mgr.negotiationsPending), onClick: () => goto("/sales-lead-pipeline/list?stage=negotiation") },
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
                attention.map((l) => {
                  const d = daysUntil(l.nextActionDate, today);
                  const overdueRow = isOverdue(l, today);
                  return (
                    <Link
                      key={l.id}
                      href={`/sales-lead-pipeline/${l.id}`}
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
                          {overdueRow ? `${Math.abs(d ?? 0)}d overdue` : d === 0 ? "Today" : `in ${d}d`}
                        </span>
                        <span className="block text-[11px] text-muted">{l.nextActionDate}</span>
                      </span>
                    </Link>
                  );
                })
              )}
            </Card>
          </div>

          <div>
            <SectionLabel>Pipeline at a glance</SectionLabel>
            <Link href="/sales-lead-pipeline/pipeline">
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
              <div className="px-5 py-8 text-center text-sm text-muted">Nothing in your book yet.</div>
            ) : (
              focus.map(({ lead, action }) => (
                <Link
                  key={lead.id}
                  href={`/sales-lead-pipeline/${lead.id}`}
                  className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 last:border-0 hover:bg-canvas"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-ink">{lead.name}</span>
                  <Badge tone={toneForGate(action.kind)} className="flex-none">
                    {"label" in action ? action.label : "Monitor"}
                  </Badge>
                </Link>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
