"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { ExportButton } from "@/app/reports/export-button";
import {
  archiveLead,
  chaseLeadOwner,
  exportLeadRows,
  reassignLead,
  restoreLead,
} from "@/lib/actions/sales";
import { healthView } from "@/lib/customer-health";
import { MultiSelect } from "@/components/ui/multi-select";
import { pinnedCell, pinnedHead } from "@/components/ui/pinned";
import {
  AGE_BUCKETS,
  HEALTH_BUCKETS,
  NEXT_BUCKETS,
  POTENTIAL_BUCKETS,
  type FilterOption,
} from "@/lib/lead-filters";
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
/**
 * THE SEVEN COLUMNS THAT CAN BE NARROWED, in the order they appear in the
 * table — so the filter bar reads left to right exactly like the header under
 * it, and "which control filters which column" is never a question.
 *
 * Declared once and iterated: the URL parameter, the ticked state, the clear
 * action and the bar itself all walk this list, which is what stops an eighth
 * filter being added to the bar and quietly not being cleared by "Clear all".
 */
const FILTER_COLUMNS = [
  "owner",
  "source",
  "potential",
  "stage",
  "next",
  "age",
  "health",
] as const;
type FilterColumn = (typeof FILTER_COLUMNS)[number];

/** Ten by default — see `LEADS_PER_PAGE`. The rest are for a wide monitor. */
const PER_PAGE = [10, 25, 50, 100] as const;

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
  pageInfo,
  stale,
  filters,
  options,
  showArchived,
  archivedCount,
  staleDays,
  healthAtRiskBelow,
  healthStrongAtOrAbove,
  team,
  funnel,
  desks,
}: {
  /** ONE PAGE of them. Everything counted around the table comes from SQL. */
  leads: LeadRow[];
  pageInfo: {
    page: number;
    pageCount: number;
    perPage: number;
    /** Matching the filters. */
    total: number;
    /** The whole scoped list, before any filter. */
    listTotal: number;
  };
  /** Over the filtered set, not the page — see `leadsPage`. */
  stale: { count: number; names: string[] };
  /** What is ticked, read off the URL by the page. */
  filters: Record<FilterColumn, string[]>;
  /** What there is to tick: owner, source and stage are read off the book. */
  options: {
    owners: Array<FilterOption & { count: number }>;
    sources: Array<FilterOption & { count: number }>;
    stages: Array<FilterOption & { count: number }>;
  };
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
  const search = useSearchParams();
  const toast = useToast();

  /*
   * One place a filter is written to the URL, like the customers list. Any
   * change to WHAT is being looked at returns to the first page — unless the
   * change is the page — because page 7 of a list you have just narrowed to
   * eleven rows is an empty table that reads as a broken filter.
   */
  const navigate = React.useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "" || v === null) next.delete(k);
        else next.set(k, String(v));
      }
      if (!("page" in patch)) next.delete("page");
      router.push(`?${next.toString()}`, { scroll: false });
    },
    [router, search],
  );

  const anyFilter = FILTER_COLUMNS.some((c) => filters[c].length > 0);
  const clearFilters = () =>
    navigate(Object.fromEntries(FILTER_COLUMNS.map((c) => [c, undefined])));

  /* The count goes on the label rather than the value: "Pritesh Bipin Doshi
     (511)" is what tells a manager which name is worth ticking, and it is the
     one thing a dropdown of twenty names can say that a list of twenty names
     cannot. */
  const withCounts = (rows: Array<FilterOption & { count: number }>) =>
    rows.map((r) => ({ value: r.value, label: `${r.label} (${r.count})` }));

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
              {/* The whole filtered list, fetched on the click — the table
                  holds one page now, and a ten-row file from a list of 3,776
                  is the version of this bug that looks like it worked. */}
              <ExportButton
                name="leads"
                count={pageInfo.total}
                fetchRows={async () => {
                  const res = await exportLeadRows({
                    archived: showArchived,
                    filters: Object.fromEntries(
                      FILTER_COLUMNS.map((c) => [c, filters[c].join(",") || undefined]),
                    ),
                  });
                  if (!res.ok) {
                    toast.push(res.error, "error");
                    return null;
                  }
                  return res.data.rows;
                }}
              />
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

          {/* Counted over the FILTERED list in SQL, not over the ten rows this
              page happens to hold — see `leadsPage`. Before pagination the two
              were the same number; they are not any more, and the one worth
              saying is how many the search found. */}
          {!showArchived && stale.count ? (
            <div className="mb-4 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-4 py-3">
              <div className="text-sm font-semibold text-ink">
                {plural(stale.count, "lead")} nobody has touched in {plural(staleDays, "day")}
              </div>
              <div className="mt-0.5 text-[13px] text-body">
                {stale.names.join(" · ")}
                {stale.count > stale.names.length
                  ? ` and ${stale.count - stale.names.length} more`
                  : ""}
              </div>
            </div>
          ) : null}

          <FilterBar
            filters={filters}
            options={options}
            withCounts={withCounts}
            navigate={navigate}
            anyFilter={anyFilter}
            onClear={clearFilters}
            total={pageInfo.total}
            listTotal={pageInfo.listTotal}
          />

          <Table
            minWidth={1302}
            head={
              <>
                {/* PINNED. The row's name and its actions are the two cells
                    that must survive a sideways scroll — `pinned.ts` carries
                    the argument: scroll the name off and every remaining cell
                    is an orphaned value, scroll the menu off and whether you
                    can act on a row depends on where the table is scrolled. */}
                <HeadCell width={230} className={pinnedHead("left")}>
                  Lead
                </HeadCell>
                <HeadCell width={160}>Owner</HeadCell>
                <HeadCell width={140}>Source</HeadCell>
                <HeadCell align="right" width={130}>Potential</HeadCell>
                <HeadCell width={110}>Stage</HeadCell>
                <HeadCell width={130}>Next</HeadCell>
                <HeadCell width={110}>Age</HeadCell>
                <HeadCell width={190}>Health &amp; metrics</HeadCell>
                {/* Wide enough for the menu trigger AND the cell's own padding: at the
                    44 it was drawn at, the pinned cell clipped its own ⋯ and
                    printed the ellipsis `Cell` adds on overflow, so the column
                    read as a truncated value rather than a control. */}
                <HeadCell width={72} className={pinnedHead("right")} />
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
                    <Cell truncate={230} className={pinnedCell("left", i)}>
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
                    <Cell
                      align="right"
                      className={pinnedCell("right", i)}
                      onClick={(e) => e.stopPropagation()}
                    >
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

          {pageInfo.total > pageInfo.perPage ? (
            <Pager
              page={pageInfo.page}
              pageCount={pageInfo.pageCount}
              perPage={pageInfo.perPage}
              total={pageInfo.total}
              navigate={navigate}
            />
          ) : null}
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

/**
 * The filter bar.
 *
 * Every control is a `MultiSelect` — the same Excel-style checkbox dropdown
 * the customers list uses, which already searches above eight options, scrolls
 * its own list without closing, and portals out of the table's `overflow` so
 * it is not clipped. A second dropdown written here would be a second set of
 * those bugs.
 *
 * OWNER, SOURCE AND STAGE ARE READ OFF THE BOOK and carry their counts;
 * potential, next, age and health are named ranges from `lib/lead-filters.ts`,
 * because a dropdown of four hundred distinct ages is not a filter. The
 * counts are on the labels rather than beside them: `MultiSelect` draws a
 * label, and "Pritesh Bipin Doshi (511)" is what tells somebody which name is
 * worth ticking.
 */
function FilterBar({
  filters,
  options,
  withCounts,
  navigate,
  anyFilter,
  onClear,
  total,
  listTotal,
}: {
  filters: Record<FilterColumn, string[]>;
  options: {
    owners: Array<FilterOption & { count: number }>;
    sources: Array<FilterOption & { count: number }>;
    stages: Array<FilterOption & { count: number }>;
  };
  withCounts: (rows: Array<FilterOption & { count: number }>) => FilterOption[];
  navigate: (patch: Record<string, string | number | undefined>) => void;
  anyFilter: boolean;
  onClear: () => void;
  total: number;
  listTotal: number;
}) {
  const pick = (column: FilterColumn) => (next: string[]) =>
    navigate({ [column]: next.join(",") || undefined });

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <MultiSelect
        label="Owner"
        placeholder="All owners"
        options={withCounts(options.owners)}
        selected={filters.owner}
        onChange={pick("owner")}
        title="Who is working the lead. Nobody is a real answer and is offered as one."
      />
      <MultiSelect
        label="Source"
        placeholder="All sources"
        options={withCounts(options.sources)}
        selected={filters.source}
        onChange={pick("source")}
      />
      <MultiSelect
        label="Potential"
        placeholder="Any potential"
        options={[...POTENTIAL_BUCKETS]}
        selected={filters.potential}
        onChange={pick("potential")}
        title="Somebody's estimate of what the shop could spend in a month. Not estimated is not the same as nothing."
      />
      <MultiSelect
        label="Stage"
        placeholder="All stages"
        options={withCounts(options.stages)}
        selected={filters.stage}
        onChange={pick("stage")}
      />
      <MultiSelect
        label="Next"
        placeholder="Any next step"
        options={[...NEXT_BUCKETS]}
        selected={filters.next}
        onChange={pick("next")}
        title="The follow-up somebody promised. None promised is the one worth looking at."
      />
      <MultiSelect
        label="Age"
        placeholder="Any age"
        options={[...AGE_BUCKETS]}
        selected={filters.age}
        onChange={pick("age")}
      />
      <MultiSelect
        label="Health"
        placeholder="Any health"
        options={[...HEALTH_BUCKETS]}
        selected={filters.health}
        onChange={pick("health")}
        title="What the health column says. A lead that has never ordered is in no band at all — that is an option rather than a gap."
      />

      {anyFilter ? (
        <button
          type="button"
          onClick={onClear}
          className="h-8.5 cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-muted hover:bg-canvas hover:text-body"
        >
          Clear filters
        </button>
      ) : null}

      <span className="flex-1" />
      {/* What the filters found, against what there is. A count that only ever
          showed the page would say "10" on every screen in the product. */}
      <span className="text-[13px] text-muted">
        {anyFilter
          ? `${total.toLocaleString("en-IN")} of ${listTotal.toLocaleString("en-IN")}`
          : `${listTotal.toLocaleString("en-IN")} ${listTotal === 1 ? "lead" : "leads"}`}
      </span>
    </div>
  );
}

/**
 * The pager, in the shape the customers list already uses: a RANGE rather than
 * a page number, because "26–35 of 3,776" says where you are and "page 3" only
 * does once you know how big a page is.
 */
function Pager({
  page,
  pageCount,
  perPage,
  total,
  navigate,
}: {
  page: number;
  pageCount: number;
  perPage: number;
  total: number;
  navigate: (patch: Record<string, string | number | undefined>) => void;
}) {
  const from = (page - 1) * perPage;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-b-[6px] border-r border-b border-l border-line bg-surface px-4 py-3">
      <span className="text-[13px] text-muted">
        {from + 1}&ndash;{Math.min(from + perPage, total)} of{" "}
        {total.toLocaleString("en-IN")}
      </span>
      <span className="flex items-center gap-2 text-[13px] text-muted">
        <label htmlFor="leads-per-page">Show</label>
        <select
          id="leads-per-page"
          value={perPage}
          onChange={(e) => {
            // Keep the first row of this page in view rather than jumping to
            // the top: a page size is a change of zoom, not of place.
            const next = Number(e.target.value);
            navigate({ per: next, page: Math.floor(from / next) + 1 });
          }}
          className="h-8 cursor-pointer rounded-[4px] border border-line bg-canvas px-2 text-[13px] text-body"
        >
          {PER_PAGE.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-2">
        <Button
          tone="default"
          size="sm"
          disabled={page <= 1}
          title={page <= 1 ? "This is the first page" : undefined}
          onClick={() => navigate({ page: page - 1 })}
        >
          Previous
        </Button>
        <span className="text-[13px] text-body tabular-nums">
          {page} / {pageCount}
        </span>
        <Button
          tone="default"
          size="sm"
          disabled={page >= pageCount}
          title={page >= pageCount ? "This is the last page" : undefined}
          onClick={() => navigate({ page: page + 1 })}
        >
          Next
        </Button>
      </span>
    </div>
  );
}
