"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { ExportButton } from "@/app/reports/export-button";
import {
  archiveLead,
  chaseLeadOwner,
  reassignLead,
  restoreLead,
} from "@/lib/actions/sales";
import type { LeadRow } from "@/lib/services/sales-service";
import {
  Button,
  Cell,
  Empty,
  HeadCell,
  Pill,
  ReasonModal,
  Row,
  RowMenu,
  ScreenHeader,
  Table,
  plural,
} from "../parts";

/**
 * The qualification ladder, in the order it is climbed. The FUNNEL only
 * counts the first four — `won` and `lost` are terminal, not pipeline, and
 * folding them in is how a funnel bar comes to include the deals that are no
 * longer in it. The table below still lists every stage.
 */
const FUNNEL_STAGES = ["new", "contacted", "qualified", "negotiation"] as const;

type Acting =
  | { kind: "reassign"; lead: LeadRow }
  | { kind: "archive"; lead: LeadRow }
  | { kind: "restore"; lead: LeadRow };

/**
 * The interactive half of the Leads screen: the funnel and the table are
 * server-rendered in `page.tsx`, and this is everything a manager can DO from
 * it — reassign a lead, chase whoever owns it, and file it away or bring it
 * back. Split out because a server component cannot hold the click and modal
 * state this needs.
 *
 * From `MBOS Manager Console.dc.html`'s Leads screen: "Reassign the lead" and
 * "Chase the owner" fire on the spot (Chase is a one-line nudge, not a form —
 * there is nothing here worth a modal for), and "Archive it" is the design's
 * `askReason(...)` pattern — a required sentence, because a lead vanishing off
 * a salesman's list with no explanation is exactly the failure this whole app
 * exists to avoid.
 */
export function LeadsScreen({
  leads,
  showArchived,
  archivedCount,
  staleDays,
  healthAtRiskBelow,
  team,
}: {
  leads: LeadRow[];
  showArchived: boolean;
  archivedCount: number;
  staleDays: number;
  /** Below this, a customer's health score reads as at risk. */
  healthAtRiskBelow: number;
  team: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();

  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [acting, setActing] = React.useState<Acting | null>(null);
  const [salesmanId, setSalesmanId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function begin(lead: LeadRow, kind: Acting["kind"]) {
    setActing({ lead, kind } as Acting);
    setSalesmanId(team.find((t) => t.id !== lead.salesmanId)?.id ?? "");
    setReason("");
    setError(null);
  }

  async function chase(lead: LeadRow) {
    const result = await chaseLeadOwner({ leadId: lead.id });
    if (!result.ok) {
      toast.push(result.error);
      return;
    }
    toast.push(result.message ?? "Nudged.");
    router.refresh();
  }

  async function submit() {
    if (!acting) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        acting.kind === "reassign"
          ? await reassignLead({ leadId: acting.lead.id, salesmanId })
          : acting.kind === "archive"
            ? await archiveLead({ leadId: acting.lead.id, reason })
            : await restoreLead({ leadId: acting.lead.id });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setActing(null);
      toast.push(result.message ?? "Done.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const working = leads.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const stale = working.filter((l) => l.quietDays >= staleDays);

  const funnel = FUNNEL_STAGES.map((stage) => {
    const at = leads.filter((l) => l.stage === stage);
    return {
      stage,
      count: at.length,
      potential: at.reduce((n, l) => n + Number(l.estimatedPotentialPaise ?? 0), 0),
    };
  });
  const widest = Math.max(1, ...funnel.map((f) => f.count));

  const exportRows = [
    [
      "Lead",
      "Company",
      "City",
      "Owner",
      "Source",
      "Potential (₹)",
      "Stage",
      "Next follow-up",
      "Age (days)",
      "Notes",
    ],
    ...leads.map((l) => [
      l.name,
      l.companyName ?? "",
      l.city ?? "",
      l.salesmanName ?? "Nobody",
      l.source.replace(/_/g, " "),
      Number(l.estimatedPotentialPaise) ? Math.round(Number(l.estimatedPotentialPaise) / 100) : "",
      l.stage,
      l.nextFollowUpDate ?? "",
      l.ageDays,
      l.notes ?? "",
    ]),
  ];

  return (
    <div className="p-6">
      <ScreenHeader
        title={showArchived ? "Archived leads" : "Leads"}
        subtitle={
          showArchived
            ? "Filed out of the way, newest first. Nothing here is deleted — restore one to put it back on the working list."
            : "Prospects each salesman is working. Anything untouched for 30 days is tagged stale."
        }
        actions={
          showArchived ? (
            <Link
              href="/sales/leads"
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ← Back to leads
            </Link>
          ) : (
            <div className="flex items-center gap-2">
              <ExportButton name="leads" rows={exportRows} />
              {archivedCount > 0 ? (
                <Link
                  href="/sales/leads?view=archived"
                  className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
                >
                  {plural(archivedCount, "archived lead")}
                </Link>
              ) : null}
            </div>
          )
        }
      />

      {leads.length === 0 ? (
        <Empty
          title={showArchived ? "Nothing archived" : "No leads"}
          body={
            showArchived
              ? "Nobody has filed a lead away — archiving is a manager's own call, on top of what the nightly sweep already does for anything left untouched."
              : "A lead is a shop that is not on the book yet. They are raised on the handset, and the duplicate check reads customers as well as leads — the number somebody is about to type is quite often already an account."
          }
        />
      ) : (
        <>
          {!showArchived ? (
            <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
              <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                The funnel
              </div>
              <div className="grid grid-cols-4 gap-5">
                {funnel.map((f) => (
                  <span key={f.stage} className="block min-w-0">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[14px] text-body capitalize">{f.stage}</span>
                      <span className="text-[18px] font-semibold text-ink">{f.count}</span>
                    </span>
                    <span className="mt-1.5 block h-1.5 overflow-hidden rounded-[3px] bg-canvas">
                      <span
                        className="block h-full rounded-[3px] bg-brand"
                        style={{ width: `${Math.round((f.count / widest) * 100)}%` }}
                      />
                    </span>
                    <span className="mt-1 block text-[12px] text-muted">
                      {f.potential ? money(f.potential) : "—"} potential
                    </span>
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {!showArchived && stale.length ? (
            <div className="mb-4 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-4 py-3">
              <div className="text-sm font-semibold text-ink">
                {plural(stale.length, "lead")} nobody has touched in {plural(staleDays, "day")}
              </div>
              <div className="mt-0.5 text-[13px] text-body">
                {stale
                  .slice(0, 4)
                  .map((l) => `${l.name} (${l.quietDays}d)`)
                  .join(" · ")}
                {stale.length > 4 ? ` and ${stale.length - 4} more` : ""}
              </div>
            </div>
          ) : null}

          <Table
            minWidth={1274}
            head={
              <>
                <HeadCell width={230}>Lead</HeadCell>
                <HeadCell width={160}>Owner</HeadCell>
                <HeadCell width={120}>Source</HeadCell>
                <HeadCell align="right" width={140}>Potential</HeadCell>
                <HeadCell width={130}>Stage</HeadCell>
                <HeadCell width={130}>Next</HeadCell>
                <HeadCell width={130}>Age</HeadCell>
                <HeadCell width={190}>Health &amp; metrics</HeadCell>
                <HeadCell width={44} />
              </>
            }
          >
            {leads.map((l, i) => {
              const isOpen = expanded.has(l.id);
              const isWorking = l.stage !== "won" && l.stage !== "lost";
              const isStale = isWorking && l.quietDays >= staleDays;
              const hasDetail = Boolean(l.notes) || l.hasGps || Boolean(l.convertedCustomerId);
              return (
                <React.Fragment key={l.id}>
                  <Row striped={i % 2 === 1} onClick={() => toggleExpanded(l.id)}>
                    <Cell truncate={230}>
                      <span className="font-medium text-ink">{l.name}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {[l.companyName, l.city].filter(Boolean).join(" · ") || l.mobile || "—"}
                      </span>
                    </Cell>
                    <Cell truncate={160}>
                      {l.salesmanId ? (
                        <Link
                          href={`/sales/people/${l.salesmanId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="no-underline"
                        >
                          {l.salesmanName}
                        </Link>
                      ) : (
                        <span className="text-warn-ink" title="Nobody is working this lead.">
                          Nobody
                        </span>
                      )}
                    </Cell>
                    <Cell className="capitalize">{l.source.replace(/_/g, " ")}</Cell>
                    <Cell align="right">
                      {Number(l.estimatedPotentialPaise) ? (
                        money(Number(l.estimatedPotentialPaise))
                      ) : (
                        <span className="text-muted">Not estimated</span>
                      )}
                    </Cell>
                    <Cell>
                      <Pill
                        tone={
                          l.stage === "won" ? "success" : l.stage === "lost" ? "danger" : "brand"
                        }
                      >
                        {l.stage}
                      </Pill>
                    </Cell>
                    <Cell>
                      {l.nextFollowUpDate ? (
                        shortDate(l.nextFollowUpDate)
                      ) : (
                        <span className="text-muted">None promised</span>
                      )}
                    </Cell>
                    <Cell>
                      {plural(l.ageDays, "day")} old
                      {isStale ? (
                        <span className="block text-[12px] text-warn-ink">
                          Stale — no activity in {staleDays} days
                        </span>
                      ) : null}
                    </Cell>
                    <Cell truncate={190}>
                      <HealthCell lead={l} atRiskBelow={healthAtRiskBelow} />
                    </Cell>
                    <Cell align="right" onClick={(e) => e.stopPropagation()}>
                      {showArchived ? (
                        <RowMenu items={[{ label: "Restore it", run: () => begin(l, "restore") }]} />
                      ) : (
                        <RowMenu
                          items={[
                            { label: "Reassign the lead", run: () => begin(l, "reassign") },
                            {
                              label: "Chase the owner",
                              run: () => void chase(l),
                              disabled: !l.salesmanId,
                              title: l.salesmanId
                                ? undefined
                                : "Nobody is working this lead — reassign it first.",
                            },
                            { label: "Archive it", danger: true, run: () => begin(l, "archive") },
                          ]}
                        />
                      )}
                    </Cell>
                  </Row>
                  {isOpen ? (
                    <tr
                      className={i % 2 === 1 ? "bg-canvas" : "bg-surface"}
                      onClick={() => toggleExpanded(l.id)}
                    >
                      <td colSpan={9} className="cursor-pointer border-b border-divider px-4 pb-3.5">
                        <DetailPanel lead={l} hasDetail={hasDetail} />
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </Table>
        </>
      )}

      <ReasonModal
        open={acting?.kind === "archive"}
        onClose={() => setActing(null)}
        title="Archive this lead"
        subject={acting?.lead.name}
        subjectDetail={
          acting
            ? [acting.lead.companyName, acting.lead.city].filter(Boolean).join(" · ") || undefined
            : undefined
        }
        fieldLabel="Why · required"
        reason={reason}
        onReasonChange={setReason}
        confirmLabel="Archive"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
      />

      <Modal
        open={acting?.kind === "reassign" || acting?.kind === "restore"}
        onClose={() => setActing(null)}
        title={acting?.kind === "reassign" ? "Reassign the lead" : "Restore this lead"}
        width={460}
      >
        {acting && acting.kind !== "archive" ? (
          <>
            <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              <div className="font-medium text-ink">{acting.lead.name}</div>
              <div className="text-muted">
                {[acting.lead.companyName, acting.lead.city].filter(Boolean).join(" · ") || "—"}
              </div>
            </div>

            {acting.kind === "reassign" ? (
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">Move it to</span>
                <select
                  value={salesmanId}
                  onChange={(e) => setSalesmanId(e.target.value)}
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                >
                  {team
                    .filter((t) => t.id !== acting.lead.salesmanId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
                <span className="mt-1 block text-[12px] text-muted">
                  Both sides are told — {acting.lead.salesmanName ?? "whoever has it now"} that it
                  moved, and the new owner that it is theirs.
                </span>
              </label>
            ) : (
              <p className="text-[13px] text-body">
                It goes back to {acting.lead.salesmanName ?? "its owner"}&rsquo;s working list.
              </p>
            )}

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={busy || (acting.kind === "reassign" && !salesmanId)}
                onClick={() => void submit()}
              >
                {busy ? "Saving…" : acting.kind === "reassign" ? "Reassign" : "Restore"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

/**
 * What "health" means for a row here.
 *
 * A lead that has never ordered is in NO health band — inventing one would be
 * the same mistake the owner dashboard's four bands exist to avoid for a
 * customer with no order history. Only a WON lead has a linked customer, and
 * only that customer has a real score (`customers.health_score`, computed by
 * `recomputeHealthScore` from actual orders, visits, bills and complaints —
 * never typed), so everything else says plainly that there is nothing to
 * show yet and why.
 */
function HealthCell({ lead, atRiskBelow }: { lead: LeadRow; atRiskBelow: number }) {
  if (!lead.convertedCustomerId) {
    return (
      <span
        className="text-[12px] text-muted"
        title="Health is computed from order history. This shop has never ordered, so there is nothing to score yet."
      >
        Not a customer yet
      </span>
    );
  }
  if (lead.customerHealthScore == null) {
    return <span className="text-[12px] text-muted">Converted — not scored yet</span>;
  }

  const atRisk = lead.customerHealthScore < atRiskBelow;
  return (
    <span className="block">
      <span className="flex items-center gap-1.5">
        <Pill tone={atRisk ? "warn" : "success"}>{lead.customerHealthScore} · {atRisk ? "At risk" : "Healthy"}</Pill>
      </span>
      <span className="mt-0.5 block truncate text-[12px] text-muted">
        {lead.customerLastOrderDate
          ? `Last order ${shortDate(lead.customerLastOrderDate)}`
          : "Never ordered since"}
        {Number(lead.customerOutstandingPaise)
          ? ` · ${money(Number(lead.customerOutstandingPaise))} owing`
          : ""}
      </span>
    </span>
  );
}

function DetailPanel({ lead, hasDetail }: { lead: LeadRow; hasDetail: boolean }) {
  if (!hasDetail) {
    return (
      <p className="pt-1 text-[13px] text-muted">
        Nothing more recorded — no notes, no pin, and this shop has not converted.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-x-8 gap-y-2 pt-1 text-[13px]">
      <div>
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Contact
        </div>
        <div className="text-body">{lead.mobile ?? "Not recorded"}</div>
        <div className="text-muted">
          {[lead.area, lead.city].filter(Boolean).join(", ") || "No area recorded"}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Raised
        </div>
        <div className="text-body">{stamp(lead.createdAt)}</div>
        <div className="text-muted">
          {lead.lastActivityDate ? `Last worked ${shortDate(lead.lastActivityDate)}` : "Never worked"}
          {" · "}
          {lead.hasGps ? "has a map pin" : "no pin recorded"}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Notes
        </div>
        <div className="text-pretty text-body">{lead.notes || "None."}</div>
      </div>
      {lead.stage === "lost" && lead.lostReason ? (
        <div className="col-span-3">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Why it was lost
          </div>
          <div className="text-body">{lead.lostReason}</div>
        </div>
      ) : null}
      {lead.convertedCustomerId && lead.convertedAt ? (
        <div className="col-span-3 text-[12px] text-muted">
          Converted {stamp(lead.convertedAt)}.
        </div>
      ) : null}
    </div>
  );
}
