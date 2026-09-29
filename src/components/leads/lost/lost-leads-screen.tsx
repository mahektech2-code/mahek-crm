"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { SalesmanLink } from "@/components/leads/salesman-link";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Button,
  Cell,
  Empty,
  HeadCell,
  Pill,
  Row,
  ScreenHeader,
  Table,
  plural,
} from "@/components/console/parts";
import { shortDate } from "@/lib/format";
import { SALES_TYPE_BUCKETS, type FilterOption } from "@/lib/lead-filters";
import {
  ALL_LEAD_STAGES,
  LOST_REASONS,
  labelOf,
  salesTypeLabel,
  stageLabel,
} from "@/lib/lead-labels";
import type { LostLeadRow, LostLeadTiles } from "@/lib/services/lead-lost-service";

/* ---------------------------------------------------------------------------
 * LEAD MANAGEMENT → LOST — a central, searchable record of every lead closed
 * lost, whatever rung it was lost from.
 *
 * READ-ONLY, deliberately. There is no mutation on this screen: a lead is
 * still closed lost from its own record, through the same §26 gate every
 * other stage move runs, and this page's only job is to make that history
 * findable. Nothing here writes anything, so there is no acting state, no
 * modal and no row menu of the kind `leads-screen.tsx` carries — inventing one
 * would be inventing a permission nobody asked for.
 *
 * The row's name is the door to the record, exactly as `EntityLink` argues on
 * every other table here: this screen shows WHERE a lead was lost from, and
 * the full journey that got it there — the qualification answers, the
 * samples, the whole `lead_stage_transitions` timeline — is what opening the
 * record already draws. Nothing is duplicated here.
 * ------------------------------------------------------------------------- */

/** Fifteen by default, matching every other leads list here. */
const PER_PAGE = [15, 25, 50, 100] as const;

const STAGE_AT_LOSS_OPTIONS: FilterOption[] = ALL_LEAD_STAGES.filter((s) => s !== "lost").map(
  (s) => ({ value: s, label: stageLabel(s) }),
);

const LOST_REASON_OPTIONS: FilterOption[] = LOST_REASONS.map((r) => ({
  value: r.code,
  label: r.label,
}));

export function LostLeadsScreen({
  workspace,
  leads,
  pageInfo,
  filters,
  ownerOptions,
  tiles,
}: {
  workspace: LeadWorkspace;
  leads: LostLeadRow[];
  pageInfo: {
    page: number;
    pageCount: number;
    perPage: number;
    total: number;
    listTotal: number;
  };
  /** What is ticked, read off the URL by the page. */
  filters: {
    owner: string[];
    salesType: string[];
    fromStage: string[];
    reason: string[];
    lostFrom: string;
    lostTo: string;
  };
  ownerOptions: Array<FilterOption & { count: number }>;
  tiles: LostLeadTiles;
}) {
  const router = useRouter();
  const search = useSearchParams();

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

  const urlQ = search.get("q") ?? "";
  const [typed, setTyped] = React.useState(urlQ);
  const [seenQ, setSeenQ] = React.useState(urlQ);
  const [pushedQ, setPushedQ] = React.useState(urlQ);

  if (seenQ !== urlQ) {
    setSeenQ(urlQ);
    if (urlQ !== pushedQ) setTyped(urlQ);
  }

  React.useEffect(() => {
    if (typed === urlQ) return;
    const t = setTimeout(() => {
      setPushedQ(typed);
      navigate({ q: typed || undefined });
    }, 350);
    return () => clearTimeout(t);
  }, [typed, urlQ, navigate]);

  const anyFilter =
    Boolean(urlQ.trim()) ||
    filters.owner.length > 0 ||
    filters.salesType.length > 0 ||
    filters.fromStage.length > 0 ||
    filters.reason.length > 0 ||
    Boolean(filters.lostFrom) ||
    Boolean(filters.lostTo);

  function clearFilters() {
    setTyped("");
    setPushedQ("");
    navigate({
      q: undefined,
      owner: undefined,
      salesType: undefined,
      fromStage: undefined,
      reason: undefined,
      lostFrom: undefined,
      lostTo: undefined,
    });
  }

  return (
    <div className="p-6">
      <ScreenHeader
        title="Lost"
        subtitle="Every lead closed lost, whatever rung it was lost from — the reason, the day, and who decided it. Nothing here can be undone from this screen; open a record to see its whole climb."
      />

      <TileStrip tiles={tiles} />

      {leads.length === 0 && !anyFilter ? (
        <Empty
          title="No lost leads yet"
          body="Nobody has closed a lead lost. When one is, this is where it stays — with the rung it was lost from, the reason and who decided it."
        />
      ) : (
        <div className="rounded-[6px] border border-line bg-surface">
          <FilterRow
            typed={typed}
            onTyped={setTyped}
            filters={filters}
            ownerOptions={ownerOptions}
            navigate={navigate}
            anyFilter={anyFilter}
            onClear={clearFilters}
            total={pageInfo.total}
            listTotal={pageInfo.listTotal}
          />

          {leads.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <div className="text-lg font-semibold text-ink">Nothing matches these filters</div>
              <p className="mx-auto mt-1.5 max-w-[480px] text-[15px] text-pretty text-muted">
                {pageInfo.listTotal
                  ? `${plural(pageInfo.listTotal, "lead")} closed lost in total — none of them fall inside what is ticked above.`
                  : "No lead has been closed lost yet."}
              </p>
            </div>
          ) : (
            <>
              <Table
                chrome={false}
                minWidth={1200}
                head={
                  <>
                    <HeadCell width={240}>Customer</HeadCell>
                    <HeadCell width={150}>Lead type</HeadCell>
                    <HeadCell width={150}>Owner</HeadCell>
                    <HeadCell width={150}>Stage at loss</HeadCell>
                    <HeadCell width={180}>Lost reason</HeadCell>
                    <HeadCell width={120}>Lost date</HeadCell>
                    <HeadCell width={150}>Lost by</HeadCell>
                    <HeadCell width={130}>Last activity</HeadCell>
                  </>
                }
              >
                {leads.map((l, i) => (
                  <Row key={l.id} striped={i % 2 === 1}>
                    <Cell truncate={240}>
                      <Link
                        href={leadHref(workspace, `leads/${l.id}`)}
                        className="font-medium text-ink no-underline decoration-from-font underline-offset-2 hover:text-brand hover:underline"
                      >
                        {l.name}
                      </Link>
                      <span className="block truncate text-[12px] text-muted">
                        {[l.companyName, l.city].filter(Boolean).join(" · ") || l.mobile || "—"}
                      </span>
                    </Cell>
                    <Cell truncate={150}>{salesTypeLabel(l.salesType)}</Cell>
                    <Cell truncate={150}>
                      {l.ownerId ? (
                        <SalesmanLink
                          workspace={workspace}
                          id={l.ownerId}
                          name={l.ownerName}
                          className="no-underline"
                        />
                      ) : (
                        <span className="text-muted">Nobody</span>
                      )}
                    </Cell>
                    <Cell truncate={150}>
                      {l.fromStage ? (
                        <Pill tone="neutral">{stageLabel(l.fromStage)}</Pill>
                      ) : (
                        <span className="text-muted" title="No closing transition is on record for this lead — it predates the transitions table.">
                          Not recorded
                        </span>
                      )}
                    </Cell>
                    <Cell truncate={180}>
                      {l.lostReason ? (
                        labelOf(LOST_REASONS, l.lostReason)
                      ) : (
                        <span className="text-muted">Not recorded</span>
                      )}
                    </Cell>
                    <Cell>{l.lostDate ? shortDate(l.lostDate) : <span className="text-muted">—</span>}</Cell>
                    <Cell truncate={150}>
                      {l.lostByName ?? <span className="text-muted">Not recorded</span>}
                    </Cell>
                    <Cell>
                      {l.lastActivityDate ? shortDate(l.lastActivityDate) : <span className="text-muted">—</span>}
                    </Cell>
                  </Row>
                ))}
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
        </div>
      )}
    </div>
  );
}

/**
 * §7 — three headline counts and the stage-at-loss breakdown, over the WHOLE
 * scoped Lost book. Deliberately not a dashboard: the primary purpose of this
 * screen is the table beneath it, so this is three figures and a row of
 * pills, not nine tiles each opening a differently-cut list.
 */
function TileStrip({ tiles }: { tiles: LostLeadTiles }) {
  return (
    <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-3.5">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3.5">
        <Metric label="Total lost" value={tiles.total} />
        <Metric label="Lost this month" value={tiles.thisMonth} />
        <Metric label="Lost this week" value={tiles.thisWeek} />
      </div>
      {tiles.byStage.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
          <span className="mr-1 text-[12px] text-muted">Lost from</span>
          {tiles.byStage.map((s) => (
            <span
              key={s.stage ?? "unrecorded"}
              className="inline-flex items-center gap-1 rounded-[4px] border border-line bg-canvas px-2 py-1 text-[12px] text-body"
            >
              <span>{s.label}</span>
              <span className="font-medium text-ink tabular-nums">{s.count}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        {label}
      </span>
      <span className="block text-[22px] leading-7 font-semibold whitespace-nowrap tabular-nums text-ink">
        {value.toLocaleString("en-IN")}
      </span>
    </span>
  );
}

function FilterRow({
  typed,
  onTyped,
  filters,
  ownerOptions,
  navigate,
  anyFilter,
  onClear,
  total,
  listTotal,
}: {
  typed: string;
  onTyped: (v: string) => void;
  filters: {
    owner: string[];
    salesType: string[];
    fromStage: string[];
    reason: string[];
    lostFrom: string;
    lostTo: string;
  };
  ownerOptions: Array<FilterOption & { count: number }>;
  navigate: (patch: Record<string, string | number | undefined>) => void;
  anyFilter: boolean;
  onClear: () => void;
  total: number;
  listTotal: number;
}) {
  const ownerChoices = ownerOptions.map((o) => ({
    value: o.value,
    label: `${o.label} (${o.count})`,
  }));

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      <div className="relative">
        <input
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          aria-label="Search lost leads"
          placeholder="Search a shop, a town, a phone number, an owner…"
          className="h-8.5 w-[260px] rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
        />
      </div>

      <MultiSelect
        label="Owner"
        placeholder="All owners"
        options={ownerChoices}
        selected={filters.owner}
        onChange={(next) => navigate({ owner: next.join(",") || undefined })}
      />
      <MultiSelect
        label="Lead type"
        placeholder="All types"
        options={[...SALES_TYPE_BUCKETS]}
        selected={filters.salesType}
        onChange={(next) => navigate({ salesType: next.join(",") || undefined })}
      />
      <MultiSelect
        label="Stage at loss"
        placeholder="Any stage"
        options={STAGE_AT_LOSS_OPTIONS}
        selected={filters.fromStage}
        onChange={(next) => navigate({ fromStage: next.join(",") || undefined })}
      />
      <MultiSelect
        label="Lost reason"
        placeholder="Any reason"
        options={LOST_REASON_OPTIONS}
        selected={filters.reason}
        onChange={(next) => navigate({ reason: next.join(",") || undefined })}
      />

      <label className="flex items-center gap-1.5 text-[13px] text-muted">
        Lost
        <input
          type="date"
          value={filters.lostFrom}
          onChange={(e) => navigate({ lostFrom: e.target.value || undefined })}
          aria-label="Lost on or after"
          className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-brand"
        />
        <span>to</span>
        <input
          type="date"
          value={filters.lostTo}
          onChange={(e) => navigate({ lostTo: e.target.value || undefined })}
          aria-label="Lost on or before"
          className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-brand"
        />
      </label>

      {anyFilter ? (
        <button
          type="button"
          onClick={onClear}
          className="h-8.5 cursor-pointer rounded-[4px] px-2 text-[13px] text-muted underline hover:text-ink"
        >
          Clear filters
        </button>
      ) : null}

      <span className="min-w-2 flex-1" />
      <span className="text-[13px] text-muted">
        {anyFilter
          ? `${total.toLocaleString("en-IN")} of ${listTotal.toLocaleString("en-IN")}`
          : `${listTotal.toLocaleString("en-IN")} ${listTotal === 1 ? "lead" : "leads"}`}
      </span>
    </div>
  );
}

/** The URL-driven pager, matching `leads-screen.tsx`'s own local one. */
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
    <div className="flex flex-wrap items-center gap-3 border-t border-line bg-canvas px-4 py-2.5">
      <span className="text-[13px] text-muted">
        {from + 1}&ndash;{Math.min(from + perPage, total)} of {total.toLocaleString("en-IN")}
      </span>
      <span className="flex items-center gap-2 text-[13px] text-muted">
        <label htmlFor="lost-leads-per-page">Show</label>
        <select
          id="lost-leads-per-page"
          value={perPage}
          onChange={(e) => {
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
