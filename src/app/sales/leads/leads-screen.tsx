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
import { healthView } from "@/lib/customer-health";
import type { LeadRow } from "@/lib/services/sales-service";
import type { FunnelByType } from "@/lib/services/lead-console-service";
import { salesTypeLabel, stageLabel, type LeadStage } from "@/lib/lead-labels";
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
 * What the four bands are CALLED on this screen.
 *
 * The bands themselves are `bandOf`'s, counted in SQL and banded on the
 * server — this is only the wording, because "New" reads better over a bar
 * than the enum value that produced it and a distributor's `management_review`
 * folds into "Qualified" without either word appearing.
 */
const BAND_LABEL: Record<"new" | "contacted" | "qualified" | "negotiation", string> = {
  new: "New / Suspect",
  contacted: "Contacted / Prospect",
  qualified: "Qualified",
  negotiation: "Negotiation & beyond",
};

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
  healthStrongAtOrAbove,
  team,
  funnel,
  desks,
}: {
  leads: LeadRow[];
  showArchived: boolean;
  archivedCount: number;
  staleDays: number;
  /** Below this, a customer's health score reads as at risk. */
  healthAtRiskBelow: number;
  /** At or above this a score reads as strong. */
  healthStrongAtOrAbove: number;
  team: Array<{ id: string; name: string }>;
  /** One funnel per sales type, counted in SQL and banded by the engine. */
  funnel: FunnelByType[];
  /** What is waiting on the three desks this screen is the way in to. */
  desks: {
    verification: number;
    verificationMine: number;
    noNextAction: number;
    appointments: number;
  };
}) {
  const router = useRouter();
  const toast = useToast();

  /* The type filter is local state rather than a URL parameter, unlike the
     archived view beside it. Archived is a different LIST and worth sending to
     somebody; which of three funnels you are looking at is a glance, and a
     round trip to the server to redraw four counted bars is a page flash for
     nothing. */
  const [funnelType, setFunnelType] = React.useState<string>("all");
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

  const funnelKey = (t: FunnelByType["salesType"]) => t ?? "legacy";
  const shownFunnels =
    funnelType === "all" ? funnel : funnel.filter((f) => funnelKey(f.salesType) === funnelType);
  /* One scale across every funnel drawn, so two bars of the same length mean
     the same number. Scaling each funnel to its own widest band would make a
     ladder with four leads on it look exactly like one with four hundred. */
  const widest = Math.max(
    1,
    ...shownFunnels.flatMap((f) => f.bands.map((b) => b.count)),
  );

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
            <>
              <DeskStrip desks={desks} />

              <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                      The funnel
                    </div>
                    <p className="mt-0.5 max-w-[640px] text-[12px] text-pretty text-muted">
                      Counted by sales type, because they are three different climbs. Folding them
                      into one bar puts a distributor appointment in a paint shop&rsquo;s pipeline
                      and calls both of them &ldquo;negotiation&rdquo;.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <TypeChip
                      on={funnelType === "all"}
                      label="All"
                      onPick={() => setFunnelType("all")}
                    />
                    {funnel.map((f) => (
                      <TypeChip
                        key={funnelKey(f.salesType)}
                        on={funnelType === funnelKey(f.salesType)}
                        label={f.salesType ? salesTypeLabel(f.salesType) : "Original ladder"}
                        count={f.inFunnel}
                        onPick={() => setFunnelType(funnelKey(f.salesType))}
                      />
                    ))}
                  </div>
                </div>

                {shownFunnels.length === 0 ? (
                  <p className="text-[13px] text-muted">Nothing on this ladder yet.</p>
                ) : (
                  shownFunnels.map((f) => (
                    <div key={funnelKey(f.salesType)} className="mt-3 first:mt-1">
                      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                        <span className="text-[13px] font-medium text-ink">
                          {f.salesType ? salesTypeLabel(f.salesType) : "Raised before the funnel"}
                        </span>
                        <span className="text-[12px] text-muted">
                          {f.inFunnel} in it
                          {f.inFunnelPotentialPaise
                            ? ` · ${money(f.inFunnelPotentialPaise)} potential`
                            : ""}
                          {f.won ? ` · ${f.won} arrived` : ""}
                          {f.lost ? ` · ${f.lost} lost` : ""}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
                        {f.bands.map((b) => (
                          <span key={b.band} className="block min-w-0">
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-[13px] text-body">
                                {BAND_LABEL[b.band]}
                              </span>
                              <span className="text-[18px] font-semibold text-ink">{b.count}</span>
                            </span>
                            <span className="mt-1.5 block h-1.5 overflow-hidden rounded-[3px] bg-canvas">
                              <span
                                className="block h-full rounded-[3px] bg-brand"
                                style={{ width: `${Math.round((b.count / widest) * 100)}%` }}
                              />
                            </span>
                            <span className="mt-1 block text-[12px] text-muted">
                              {b.potentialPaise ? money(b.potentialPaise) : "—"} potential
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
                <p className="mt-3 text-[12px] text-muted">
                  Potential is an estimate somebody typed, not a price — the product master carries
                  none, so nothing here can value an order. Won, lost and appointed are counted
                  beside the funnel rather than inside it: a funnel that includes the business it
                  already did only ever grows.
                </p>
              </section>
            </>
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
                <HeadCell width={140}>Source</HeadCell>
                <HeadCell align="right" width={130}>Potential</HeadCell>
                <HeadCell width={110}>Stage</HeadCell>
                <HeadCell width={130}>Next</HeadCell>
                <HeadCell width={110}>Age</HeadCell>
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
                      {/* The name is the door to the record. The row itself
                          still expands, so the one-line summary is a click and
                          the whole climb is a click — the two questions a
                          manager asks of a list are "which of these" and "what
                          is this one waiting on", and they deserve different
                          gestures. */}
                      <Link
                        href={`/sales/leads/${l.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium no-underline"
                      >
                        {l.name}
                      </Link>
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
                        {stageLabel(l.stage as LeadStage)}
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
                      <HealthCell lead={l} atRiskBelow={healthAtRiskBelow} strongAtOrAbove={healthStrongAtOrAbove} />
                    </Cell>
                    <Cell align="right" onClick={(e) => e.stopPropagation()}>
                      {showArchived ? (
                        <RowMenu items={[{ label: "Restore it", run: () => begin(l, "restore") }]} />
                      ) : (
                        <RowMenu
                          items={[
                            { label: "Open the record", href: `/sales/leads/${l.id}` },
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
function HealthCell({
  lead,
  atRiskBelow,
  strongAtOrAbove,
}: {
  lead: LeadRow;
  atRiskBelow: number;
  strongAtOrAbove: number;
}) {
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

  /*
   * B3-16 — THE BAND OWNS THE WORD, and this cell is where it did not.
   *
   * It read `score < 40` and printed "At risk", which is the phrase the
   * owner's retention report uses for a customer 1.25 of their own cycles
   * overdue. Two questions, one phrase, two screens a manager and an owner
   * both read. A shop ordering every week that owes money scored 30 here and
   * was called at risk of leaving; it was at risk of nothing of the kind.
   */
  const view = healthView(
    {
      band: lead.customerHealthBand,
      score: lead.customerHealthScore,
      components: null,
    },
    { watchBelow: atRiskBelow, strongAtOrAbove: strongAtOrAbove },
  );
  return (
    <span className="block">
      <span className="flex items-center gap-1.5">
        {/* The retention answer. */}
        <Pill tone={view.bandTone === "danger" ? "danger" : view.bandTone === "warn" ? "warn" : "success"}>
          {view.bandLabel}
        </Pill>
        {/* And the score beside it, saying only what a score can say. */}
        <span
          className={
            view.scoreTone === "danger"
              ? "text-[12px] font-medium text-danger"
              : view.scoreTone === "warn"
                ? "text-[12px] font-medium text-warn-ink"
                : "text-[12px] font-medium text-muted"
          }
          title={
            view.watch
              ? "Below the score worth watching. That is about payments, complaints and visits — not about whether they have stopped buying, which is what the band beside it answers."
              : undefined
          }
        >
          {view.score}
          {view.watch ? " · watch" : ""}
        </span>
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

/**
 * The three desks, counted, above the funnel.
 *
 * They are the work the funnel added and none of it is a column on this table:
 * a call somebody owes, a lead nobody is working, a distributor waiting on a
 * signature. A queue with no count on the screen people start from is a queue
 * nobody opens — which is how the nurture sequence and the verification call
 * would both have shipped invisible.
 */
function DeskStrip({
  desks,
}: {
  desks: {
    verification: number;
    verificationMine: number;
    noNextAction: number;
    appointments: number;
  };
}) {
  const items = [
    {
      href: "/sales/leads/verification",
      label: "Verification queue",
      value: desks.verificationMine,
      sub:
        desks.verification === desks.verificationMine
          ? "prospects waiting on your call"
          : `yours, of ${desks.verification} waiting on anybody`,
      warn: desks.verificationMine > 0,
    },
    {
      href: "/sales/leads/no-next-action",
      label: "Nobody is working these",
      value: desks.noNextAction,
      sub: "no plan, or a plan whose day has gone",
      warn: desks.noNextAction > 0,
    },
    {
      href: "/sales/leads/appointments",
      label: "Distributor appointments",
      value: desks.appointments,
      sub: "waiting on a signature",
      warn: false,
    },
    {
      href: "/sales/leads/nurture",
      label: "Nurture schedule",
      value: null as number | null,
      sub: "what the sequence has raised",
      warn: false,
    },
  ];

  return (
    <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className="block rounded-[6px] border border-line bg-surface px-4 py-3 no-underline hover:bg-canvas hover:no-underline"
        >
          <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            {it.label}
          </span>
          {it.value != null ? (
            <span
              className={
                it.warn
                  ? "block text-[22px] leading-7 font-semibold tabular-nums text-warn-ink"
                  : "block text-[22px] leading-7 font-semibold tabular-nums text-ink"
              }
            >
              {it.value}
            </span>
          ) : (
            <span className="block text-[15px] leading-7 font-medium text-body">Open it</span>
          )}
          <span className="block text-xs text-muted">{it.sub}</span>
        </Link>
      ))}
    </div>
  );
}

function TypeChip({
  on,
  label,
  count,
  onPick,
}: {
  on: boolean;
  label: string;
  count?: number;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={
        on
          ? "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border border-brand bg-brand-soft px-3 text-[13px] font-medium whitespace-nowrap text-[#5223E0]"
          : "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-surface px-3 text-[13px] whitespace-nowrap text-body hover:bg-canvas"
      }
    >
      {label}
      {count != null ? <span className={on ? "tabular-nums" : "tabular-nums text-muted"}>{count}</span> : null}
    </button>
  );
}
