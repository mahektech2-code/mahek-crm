"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { downloadCsv, toCsv } from "@/lib/csv";
import { money, shortDate, stamp } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  archiveLead,
  bulkArchiveLeads,
  bulkChaseLeadOwners,
  bulkReassignLeads,
  bulkRestoreLeads,
  chaseLeadOwner,
  exportLeads,
  leadIdsForSelection,
  reassignLead,
  restoreLead,
} from "@/lib/actions/sales";
import { bulkAdvanceLeadStage } from "@/lib/actions/leads";
import { healthView } from "@/lib/customer-health";
import type { LeadFilters, LeadRow } from "@/lib/services/sales-service";
import {
  ALL_LEAD_STAGES,
  SALES_TYPES,
  stageLabel,
  type LeadStage,
} from "@/lib/lead-labels";
import {
  Button,
  Cell,
  HeadCell,
  Pager,
  Pill,
  ReasonModal,
  Row,
  RowMenu,
  ScreenHeader,
  Table,
  plural,
} from "../parts";

/**
 * THE LEADS WORKLIST.
 *
 * What this screen is for is finding a handful of leads out of thousands and
 * doing something to them, and for a long time it was shaped like a report
 * instead: a counted funnel across the top, four desk tiles above that, three
 * paragraphs of explanation, and then a table of every row the server would
 * part with, with no search, no filter and no pager. Three things follow from
 * the rebuild, and they are worth stating because each of them is a rule rather
 * than a preference.
 *
 * **THE FIGURES ARE THE FILTERS.** The funnel's four bands are the four chips
 * under the search box. A count that cannot be clicked is a number a manager
 * reads and then has to go and reproduce by hand; the same count as a chip
 * answers "how many" and "which ones" in one gesture and costs one line instead
 * of a screenful. What is left above the table is one sentence — how many leads,
 * how many stale, how many nobody owns — because those three are the ones that
 * make somebody act, and a row of tiles teaches people to skip the row.
 *
 * **NARROWING HAPPENS IN SQL, AND THE URL IS WHERE IT LIVES.** Every filter,
 * the sort, the page and the page size are query parameters, so a filtered
 * view is a thing somebody sends to somebody else, and so the table, the
 * pager, the chip counts and the export are all reading one clause on the
 * server and cannot disagree about which leads they describe. The search box's
 * own keystrokes are the one exception and they are debounced before they reach
 * the URL, because a round trip per character is a page that flashes while
 * somebody types a shop name.
 *
 * **A SELECTION CROSSES PAGES, AND THE GATE STILL APPLIES.** Multi-select
 * reaches beyond the fifteen rows on screen — "everything Rakesh has" is ten
 * pages — and every bulk action is a batch of the same act the row menu
 * performs, not a shortcut past it. A bulk stage move runs each lead through
 * §28's gate and comes back naming the ones it refused and why; there is no
 * second path that writes a stage without asking.
 */

type Acting =
  | { kind: "reassign"; lead: LeadRow }
  | { kind: "archive"; lead: LeadRow }
  | { kind: "restore"; lead: LeadRow };

type Bulk = "reassign" | "stage" | "archive" | "restore" | "chase";

/** The band chips, in funnel order, with the three that have left it after. */
const BANDS: Array<{ key: string; label: string }> = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "negotiation", label: "Negotiation" },
  { key: "on_hold", label: "On hold" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  /* `bandOf` answers null for `customer` and `active_distributor` too. Without
     a chip of their own they sat in the list, in no band, reachable by nothing
     — and their count went missing from the row, so the chips added up to less
     than the total four lines above them. */
  { key: "converted", label: "On the book" },
];

const SORTS: Array<{ key: string; label: string }> = [
  { key: "next", label: "Next follow-up" },
  { key: "quiet", label: "Quietest first" },
  { key: "newest", label: "Newest" },
  { key: "potential", label: "Biggest potential" },
  { key: "name", label: "Name" },
];

export function LeadsScreen({
  leads,
  total,
  bandCounts,
  bandTotal,
  staleCount,
  unassignedCount,
  page,
  perPage,
  sort,
  filters,
  options,
  showArchived,
  archivedCount,
  staleDays,
  healthAtRiskBelow,
  healthStrongAtOrAbove,
  team,
  desks,
}: {
  /** One page of them. Everything describing the whole set is counted in SQL. */
  leads: LeadRow[];
  total: number;
  bandCounts: Record<string, number>;
  /** What "All" counts: the same set with the band filter dropped. */
  bandTotal: number;
  staleCount: number;
  unassignedCount: number;
  page: number;
  perPage: number;
  sort: string;
  filters: LeadFilters;
  options: {
    owners: Array<{ id: string; name: string; n: number }>;
    unassigned: number;
    sources: Array<{ code: string; n: number }>;
  };
  showArchived: boolean;
  archivedCount: number;
  staleDays: number;
  /** Below this, a customer's health score reads as at risk. */
  healthAtRiskBelow: number;
  /** At or above this a score reads as strong. */
  healthStrongAtOrAbove: number;
  team: Array<{ id: string; name: string }>;
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

  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [acting, setActing] = React.useState<Acting | null>(null);
  const [bulk, setBulk] = React.useState<Bulk | null>(null);
  const [salesmanId, setSalesmanId] = React.useState("");
  const [stage, setStage] = React.useState<LeadStage>("contacted");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /*
   * THE SEARCH BOX IS LOCAL AND THE URL IS WHERE IT LANDS.
   *
   * Typed here, debounced, then pushed — a parameter per keystroke is a server
   * round trip per keystroke, and this table is three and a half thousand rows
   * behind a database.
   *
   * **The timer must not capture the render it was started in.** It did, with
   * `[typed]` as its only dependency and an eslint-disable over the top, and
   * the rule was right: `go` reads every other filter off props, and the
   * cleanup only fires when `typed` itself changes. So pressing Clear filters
   * scheduled a push built from the filters being cleared, the navigation
   * landed, the dependency had not moved, the timer survived — and a third of
   * a second later the band and the owner came back on their own. It read as a
   * button that does not work. The effect depends on everything the timer
   * reads now, so any of them changing cancels it.
   *
   * **And the box is resynced when the URL's `q` changes UNDER it.** Adjusting
   * state during render rather than in an effect, which is the pattern this
   * codebase's React Compiler rules leave open — and guarded on what we last
   * pushed, because the one thing a search box must never do is overwrite
   * characters somebody has typed since with a value we sent ourselves. What
   * it fixes is Back, and the two summary links that drop `q`: search
   * "nashik", click Stale, and the list changed while the box went on saying
   * nashik.
   */
  const [typed, setTyped] = React.useState(filters.search);
  const [seenQ, setSeenQ] = React.useState(filters.search);
  const [pushedQ, setPushedQ] = React.useState(filters.search);

  if (seenQ !== filters.search) {
    setSeenQ(filters.search);
    if (filters.search !== pushedQ) setTyped(filters.search);
  }


  /** One place a URL for this screen is built, from what is on it now. */
  const href = React.useCallback((patch: Record<string, string>) => {
    const params = new URLSearchParams();
    const base: Record<string, string> = {
      view: showArchived ? "archived" : "",
      q: filters.search,
      band: filters.band,
      owner: filters.ownerId,
      source: filters.source,
      type: filters.salesType,
      stale: filters.stale ? "1" : "",
      sort: sort === "next" ? "" : sort,
      per: perPage === 15 ? "" : String(perPage),
      page: page === 1 ? "" : String(page),
      ...patch,
    };
    for (const [k, v] of Object.entries(base)) {
      if (v && !(k === "per" && v === "15") && !(k === "page" && v === "1") && !(k === "sort" && v === "next")) {
        params.set(k, v);
      }
    }
    const q = params.toString();
    return q ? `/sales/leads?${q}` : "/sales/leads";
  }, [showArchived, filters, sort, perPage, page]);

  const go = React.useCallback(
    (patch: Record<string, string>) => {
      /* Replace rather than push: a filter is a refinement of where somebody
         already is, and thirty history entries between them and the screen they
         came from is a Back button that does nothing anybody expects. */
      router.replace(href(patch), { scroll: false });
    },
    [router, href],
  );

  React.useEffect(() => {
    if (typed === filters.search) return;
    const t = setTimeout(() => {
      setPushedQ(typed);
      go({ q: typed, page: "1" });
    }, 350);
    return () => clearTimeout(t);
  }, [typed, filters, sort, page, perPage, showArchived, go]);

  const filtered =
    Boolean(filters.search) ||
    Boolean(filters.band) ||
    Boolean(filters.ownerId) ||
    Boolean(filters.source) ||
    Boolean(filters.salesType) ||
    filters.stale;

  /*
   * Clearing the FILTERS, and only the filters.
   *
   * It used to hard-navigate to /sales/leads, which threw away the sort and the
   * page size along with them — a manager on "Quietest first, 100 rows" was
   * silently returned to "Next follow-up, 15 rows" by a button that says it
   * clears filters. `href` already treats those two as not filters; going
   * through `go` is what makes this one control agree with the other nine.
   */
  function clearFilters() {
    setTyped("");
    setPushedQ("");
    go({ q: "", band: "", owner: "", source: "", type: "", stale: "", page: "1" });
  }

  /* ------------------------------------------------------------ selection */

  const pageIds = leads.map((l) => l.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const someOnPage = pageIds.some((id) => picked.has(id));

  function toggleOne(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setPicked((prev) => {
      const next = new Set(prev);
      if (allOnPage) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }

  async function selectEverything() {
    const result = await leadIdsForSelection({ filters, sort });
    if (!result.ok) {
      toast.push(result.error);
      return;
    }
    setPicked(new Set(result.data.ids));
    if (result.data.capped) {
      toast.push(
        `Selected the first ${result.data.ids.length} — a batch is capped there. Narrow the filter to reach the rest.`,
      );
    }
  }

  /* -------------------------------------------------------------- actions */

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

  function beginBulk(kind: Bulk) {
    setBulk(kind);
    setSalesmanId(team[0]?.id ?? "");
    setStage("contacted");
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

  async function submitBulk() {
    if (!bulk) return;
    const leadIds = Array.from(picked);
    setBusy(true);
    setError(null);
    try {
      const result =
        bulk === "reassign"
          ? await bulkReassignLeads({ leadIds, salesmanId })
          : bulk === "stage"
            ? await bulkAdvanceLeadStage({ customerIds: leadIds, to: stage })
            : bulk === "archive"
              ? await bulkArchiveLeads({ leadIds, reason })
              : bulk === "restore"
                ? await bulkRestoreLeads({ leadIds })
                : await bulkChaseLeadOwners({ leadIds });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBulk(null);
      /* EXACTLY WHAT WAS REFUSED STAYS TICKED.
         A batch that clears the selection on a partial success leaves somebody
         to find the eleven refused leads again by hand, which is the work the
         batch was supposed to save — and a batch that keeps the whole selection
         invites them to press the same button on the ones that already moved. */
      setPicked(new Set(result.data?.failed.map((f) => f.id) ?? []));
      toast.push(result.message ?? "Done.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------------- export */

  const [exporting, setExporting] = React.useState(false);

  async function downloadEverything() {
    setExporting(true);
    try {
      const result = await exportLeads({ filters, sort });
      if (!result.ok) {
        toast.push(result.error);
        return;
      }
      const [headers, ...body] = result.data.rows;
      if (!body.length) {
        toast.push("Nothing to download — no lead matches this filter.");
        return;
      }
      downloadCsv(
        showArchived ? "archived-leads" : "leads",
        toCsv(headers.map(String), body),
        ["leads"],
      );
      toast.push(
        result.data.capped
          ? `Downloaded the first ${body.length.toLocaleString("en-IN")} rows — that is the cap. Filter further for the rest.`
          : `Downloaded ${plural(body.length, "lead")}.`,
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="p-6">
      <ScreenHeader
        title={showArchived ? "Archived leads" : "Leads"}
        subtitle={
          showArchived
            ? "Filed out of the way, newest first. Nothing here is deleted — restore one to put it back on the working list."
            : "Shops that are not on the book yet. Search, filter, and change them in a batch."
        }
        actions={
          <div className="flex items-center gap-2">
            {/*
              THE BUTTON SAYS WHAT LANDS ON THE DISK, AND HOW MUCH.
              It used to read "Export (400)" — a word that means four things in
              an office and a number that was the length of an array the browser
              happened to be holding. With the table paged that number would now
              read 15 while the filter reached three thousand, which is the worst
              version of the bug: a file that looks finished. The count is the
              FILTERED TOTAL and the file is built on the server from the same
              clause the table ran.
            */}
            <button
              type="button"
              disabled={exporting || total === 0}
              onClick={() => void downloadEverything()}
              title={
                total === 0
                  ? "Nothing matches this filter."
                  : `A spreadsheet of all ${total.toLocaleString("en-IN")} leads this filter reaches — not just the page below.`
              }
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body hover:bg-canvas disabled:cursor-default disabled:opacity-50"
            >
              {exporting
                ? "Preparing…"
                : total === 0
                  ? "Download as a spreadsheet"
                  : `Download ${total.toLocaleString("en-IN")} as a spreadsheet`}
            </button>
            {showArchived ? (
              <Link
                href="/sales/leads"
                className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
              >
                ← Back to leads
              </Link>
            ) : archivedCount > 0 ? (
              <Link
                href="/sales/leads?view=archived"
                className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
              >
                {plural(archivedCount, "archived lead")}
              </Link>
            ) : null}
          </div>
        }
      />

      {!showArchived ? <SummaryLine total={total} stale={staleCount} unassigned={unassignedCount} staleDays={staleDays} desks={desks} /> : null}

      <div className="rounded-[6px] border border-line bg-surface">
        <FilterBar
          typed={typed}
          onTyped={setTyped}
          filters={filters}
          bandCounts={bandCounts}
          bandTotal={bandTotal}
          options={options}
          sort={sort}
          filtered={filtered}
          onClear={clearFilters}
          go={go}
        />

        {picked.size ? (
          <BulkBar
            count={picked.size}
            total={total}
            pageCount={leads.length}
            showArchived={showArchived}
            onClear={() => setPicked(new Set())}
            onSelectEverything={() => void selectEverything()}
            onAct={beginBulk}
          />
        ) : null}

        {leads.length === 0 ? (
          /* NOT `Empty`, which draws its own bordered card — nested in this
             panel that is a box inside a box with two rules 24px apart. It is
             the only place in the app where `Empty` would sit inside one. */
          <div className="px-4 py-10 text-center">
            <InlineEmpty
              title={
                filtered
                  ? "Nothing matches"
                  : showArchived
                    ? "Nothing archived"
                    : "No leads"
              }
              body={
                filtered
                  ? "No lead matches what you have filtered to. Clear the filters to see the whole book."
                  : showArchived
                    ? "Nobody has filed a lead away — archiving is a manager's own call, on top of what the nightly sweep already does for anything left untouched."
                    : "A lead is a shop that is not on the book yet. They are raised on the handset, and the duplicate check reads customers as well as leads — the number somebody is about to type is quite often already an account."
              }
            />
          </div>
        ) : (
          <>
            <Table
              chrome={false}
              minWidth={1080}
              head={
                <>
                  <HeadCell width={40}>
                    <input
                      type="checkbox"
                      checked={allOnPage}
                      /* SOME of them is not NONE of them. Unchecked at three of
                         fifteen, the box says "nothing here is selected" and a
                         click then ticks the other twelve — the opposite of what
                         an empty box promises. */
                      ref={(el) => {
                        if (el) el.indeterminate = someOnPage && !allOnPage;
                      }}
                      onChange={togglePage}
                      aria-label="Select every lead on this page"
                      title={
                        allOnPage
                          ? "Clear the leads on this page"
                          : "Select every lead on this page"
                      }
                      className="cursor-pointer align-middle accent-[#5223E0]"
                    />
                  </HeadCell>
                  <HeadCell width={250}>Lead</HeadCell>
                  <HeadCell width={160}>Owner</HeadCell>
                  <HeadCell width={130}>Stage</HeadCell>
                  <HeadCell width={130}>Next</HeadCell>
                  <HeadCell width={150}>Last activity</HeadCell>
                  <HeadCell align="right" width={130}>
                    Potential
                  </HeadCell>
                  <HeadCell width={44} />
                </>
              }
            >
              {leads.map((l, i) => {
                const isOpen = expanded.has(l.id);
                const isWorking = l.stage !== "won" && l.stage !== "lost";
                const isStale = isWorking && l.quietDays >= staleDays;
                return (
                  <React.Fragment key={l.id}>
                    <Row
                      striped={i % 2 === 1}
                      /* Multi-select is the headline of this screen and a ticked
                         row was distinguishable only by a 13px box — across
                         pages, which is where somebody most needs to see what is
                         still held. `Row` already had the token. */
                      selected={picked.has(l.id)}
                      onClick={() => toggleExpanded(l.id)}
                    >
                      <Cell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={picked.has(l.id)}
                          onChange={() => toggleOne(l.id)}
                          aria-label={`Select ${l.name}`}
                          className="cursor-pointer align-middle accent-[#5223E0]"
                        />
                      </Cell>
                      <Cell truncate={250}>
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
                        {l.lastActivityDate ? shortDate(l.lastActivityDate) : (
                          <span className="text-muted">Never worked</span>
                        )}
                        {isStale ? (
                          <span className="block text-[12px] text-warn-ink">
                            Quiet {plural(l.quietDays, "day")}
                          </span>
                        ) : null}
                      </Cell>
                      <Cell align="right">
                        {Number(l.estimatedPotentialPaise) ? (
                          money(Number(l.estimatedPotentialPaise))
                        ) : (
                          <span className="text-muted">Not estimated</span>
                        )}
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
                      /* NO onClick HERE, deliberately. The panel is where the
                         mobile number, the area and the notes live — the values
                         somebody opened the row in order to copy — and with a
                         toggle across the whole of it, click-dragging to select
                         a phone number collapsed the panel on mouseup. The
                         summary row above is the gesture. */
                      <tr className={i % 2 === 1 ? "bg-canvas" : "bg-surface"}>
                        <td colSpan={8} className="border-b border-divider px-4 pb-3.5">
                          <DetailPanel
                            lead={l}
                            atRiskBelow={healthAtRiskBelow}
                            strongAtOrAbove={healthStrongAtOrAbove}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </Table>

            <Pager
              total={total}
              page={page}
              perPage={perPage}
              note={
                filtered ? "the figures above describe everything this filter reaches" : undefined
              }
              onPage={(p) => go({ page: String(p) })}
              onPerPage={(n) => go({ per: String(n), page: "1" })}
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------- one lead */}

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

      {/* ---------------------------------------------------- the selection */}

      <Modal
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={
          bulk === "reassign"
            ? "Change the owner"
            : bulk === "stage"
              ? "Move the stage"
              : bulk === "archive"
                ? "Archive these leads"
                : bulk === "restore"
                  ? "Restore these leads"
                  : "Chase the owners"
        }
        width={480}
      >
        <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px] text-body">
          <span className="font-medium text-ink">{plural(picked.size, "lead")}</span> selected.
        </div>

        {bulk === "reassign" ? (
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">Move them all to</span>
            <select
              value={salesmanId}
              onChange={(e) => setSalesmanId(e.target.value)}
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            >
              {team.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-muted">
              One message each, naming how many — not one per lead. Anything already theirs, and
              anything archived, is left alone and named back to you.
            </span>
          </label>
        ) : null}

        {bulk === "stage" ? (
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">Move them all to</span>
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value as LeadStage)}
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            >
              {ALL_LEAD_STAGES.map((s) => (
                <option key={s} value={s}>
                  {stageLabel(s)}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-muted">
              Each one goes through the same gate the record screen asks. A lead missing a condition
              for that rung, or not on a ladder that has it, does not move — and comes back named,
              with what it is waiting on.
            </span>
          </label>
        ) : null}

        {bulk === "archive" ? (
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">Why · required</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              The same sentence goes to every owner losing a lead here — a lead vanishing off
              somebody&rsquo;s list with no explanation is the failure this whole app exists to
              avoid.
            </span>
          </label>
        ) : null}

        {bulk === "restore" ? (
          <p className="text-[13px] text-body">
            They go back to their owners&rsquo; working lists.
          </p>
        ) : null}

        {bulk === "chase" ? (
          <p className="text-[13px] text-body">
            One nudge per owner, naming how many leads and the first few of them. Anything nobody
            owns is named back to you instead — there is nobody to chase.
          </p>
        ) : null}

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setBulk(null)}>
            Cancel
          </Button>
          <Button
            tone={bulk === "archive" ? "danger" : "primary"}
            disabled={
              busy ||
              (bulk === "reassign" && !salesmanId) ||
              (bulk === "archive" && !reason.trim())
            }
            onClick={() => void submitBulk()}
          >
            {busy ? "Working…" : `Apply to ${picked.size}`}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/**
 * The empty state, WITHOUT a box of its own.
 *
 * `Empty` in `../parts` draws `rounded-[6px] border border-line bg-surface`,
 * which is right on every other Sales screen because it stands alone there.
 * Here the search box, the chips, the rows and the pager are one panel, and a
 * bordered card inside it is two rules 24px apart saying nothing.
 */
function InlineEmpty({ title, body }: { title: string; body: string }) {
  return (
    <>
      <div className="text-sm font-semibold text-ink">{title}</div>
      <p className="mx-auto mt-1 max-w-[520px] text-[13px] text-pretty text-muted">{body}</p>
    </>
  );
}

/* ═════════════════════════════════════════════════════════════ the summary */

/**
 * THREE FIGURES AND FOUR LINKS, ON TWO LINES.
 *
 * What was here was a four-tile desk strip over a funnel drawn per sales type,
 * with a bar and a potential figure on each of twelve bands and two paragraphs
 * of explanation — about four hundred pixels of arithmetic above a worklist.
 * The funnel itself has not been deleted: its counts are the band chips under
 * the search box, where each one reaches the rows behind it. What survives up
 * here is only what makes somebody DO something — how many leads the filter
 * reaches, how many have gone quiet, and how many nobody is working — plus the
 * three desks, which are queues rather than figures and would otherwise be
 * invisible to anybody who does not already know they exist.
 */
function SummaryLine({
  total,
  stale,
  unassigned,
  staleDays,
  desks,
}: {
  total: number;
  stale: number;
  unassigned: number;
  staleDays: number;
  desks: {
    verification: number;
    verificationMine: number;
    noNextAction: number;
    appointments: number;
  };
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
      <span className="text-body">
        <span className="font-semibold tabular-nums text-ink">
          {total.toLocaleString("en-IN")}
        </span>{" "}
        {total === 1 ? "lead" : "leads"}
      </span>
      {stale ? (
        <Link
          href="/sales/leads?stale=1"
          className="text-warn-ink no-underline hover:underline"
          title={`Nobody has touched these in ${staleDays} days.`}
        >
          <span className="font-semibold tabular-nums">{stale.toLocaleString("en-IN")}</span> stale
        </Link>
      ) : null}
      {unassigned ? (
        <Link
          href="/sales/leads?owner=none"
          className="text-warn-ink no-underline hover:underline"
          title="Nobody is working these."
        >
          <span className="font-semibold tabular-nums">{unassigned.toLocaleString("en-IN")}</span>{" "}
          unassigned
        </Link>
      ) : null}

      <span className="h-4 w-px bg-line" />

      <DeskLink
        href="/sales/leads/verification"
        label="Verification"
        value={desks.verificationMine}
        title={
          desks.verification === desks.verificationMine
            ? "Prospects waiting on your call."
            : `Yours, of ${desks.verification} waiting on anybody.`
        }
      />
      <DeskLink
        href="/sales/leads/no-next-action"
        label="No plan"
        value={desks.noNextAction}
        title="No next action, or one whose day has gone."
      />
      <DeskLink
        href="/sales/leads/appointments"
        label="Appointments"
        value={desks.appointments}
        title="Distributor appointments waiting on a signature."
      />
      <DeskLink
        href="/sales/leads/nurture"
        label="Nurture"
        value={null}
        title="What the nurture sequence has raised."
      />
    </div>
  );
}

function DeskLink({
  href,
  label,
  value,
  title,
}: {
  href: string;
  label: string;
  value: number | null;
  title: string;
}) {
  return (
    <Link href={href} title={title} className="text-muted no-underline hover:text-ink hover:underline">
      {label}
      {value != null ? (
        <span
          className={
            value > 0 ? " font-semibold tabular-nums text-warn-ink" : " tabular-nums text-muted"
          }
        >
          {" "}
          {value}
        </span>
      ) : null}
    </Link>
  );
}

/* ══════════════════════════════════════════════════════════════ the filters */

/**
 * EVERYTHING THAT NARROWS THE LIST, INSIDE THE BOX THE LIST IS IN.
 *
 * They sat above the table and outside it — a type chip row belonging to the
 * funnel, four hundred rows below it, and nothing on the screen saying the two
 * were connected. A control that changes a table and is drawn as though it
 * belongs to something else is one people stop associating with the result, and
 * on a list this long the association is the whole thing.
 *
 * The search box is first because it is what somebody reaches for, the band
 * chips are second because they carry the counts, and the three dropdowns are
 * third because they are the refinement you make once you already know roughly
 * where you are.
 */
function FilterBar({
  typed,
  onTyped,
  filters,
  bandCounts,
  bandTotal,
  options,
  sort,
  filtered,
  onClear,
  go,
}: {
  typed: string;
  onTyped: (v: string) => void;
  filters: LeadFilters;
  bandCounts: Record<string, number>;
  bandTotal: number;
  options: {
    owners: Array<{ id: string; name: string; n: number }>;
    unassigned: number;
    sources: Array<{ code: string; n: number }>;
  };
  sort: string;
  filtered: boolean;
  onClear: () => void;
  go: (patch: Record<string, string>) => void;
}) {
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <input
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            placeholder="Search a shop, a company, a phone number, a town, a note, an owner…"
            aria-label="Search leads"
            className="h-9 w-full rounded-[4px] border border-line bg-surface px-3 pr-16 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
          />
          {typed ? (
            <button
              type="button"
              onClick={() => onTyped("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded-[3px] px-1.5 py-0.5 text-[12px] text-muted hover:bg-canvas hover:text-ink"
            >
              Clear
            </button>
          ) : null}
        </div>

        <Select
          label="Sort the leads"
          value={sort}
          onChange={(v) => go({ sort: v, page: "1" })}
          options={SORTS.map((s) => ({ value: s.key, label: `Sort: ${s.label}` }))}
        />

        {filtered ? (
          <button
            type="button"
            onClick={onClear}
            className="h-9 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body hover:bg-canvas"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Chip
          on={!filters.band}
          label="All"
          count={bandTotal}
          onPick={() => go({ band: "", page: "1" })}
        />
        {BANDS.map((b) => (
          <Chip
            key={b.key}
            on={filters.band === b.key}
            label={b.label}
            count={bandCounts[b.key] ?? 0}
            onPick={() => go({ band: filters.band === b.key ? "" : b.key, page: "1" })}
          />
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Select
          label="Filter by owner"
          value={filters.ownerId}
          onChange={(v) => go({ owner: v, page: "1" })}
          options={[
            { value: "", label: "Every owner" },
            ...(options.unassigned
              ? [{ value: "none", label: `Nobody (${options.unassigned})` }]
              : []),
            ...options.owners.map((o) => ({ value: o.id, label: `${o.name} (${o.n})` })),
          ]}
        />
        <Select
          label="Filter by sales ladder"
          value={filters.salesType}
          onChange={(v) => go({ type: v, page: "1" })}
          options={[
            { value: "", label: "Every ladder" },
            ...SALES_TYPES.map((s) => ({ value: s.code, label: s.label })),
            { value: "legacy", label: "Raised before the funnel" },
          ]}
        />
        <Select
          label="Filter by source"
          value={filters.source}
          onChange={(v) => go({ source: v, page: "1" })}
          options={[
            { value: "", label: "Every source" },
            ...options.sources.map((s) => ({
              value: s.code,
              label: `${s.code.replace(/_/g, " ")} (${s.n})`,
            })),
          ]}
        />
        {/* Not offered on the archived view: "nobody has touched this in 30
            days" is not a question anybody asks of a lead somebody filed away
            on purpose. */}
        {filters.archived ? null : (
        <label
          className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body hover:bg-canvas"
          title={`Leads nobody has touched in ${filters.staleDays} days.`}
        >
          <input
            type="checkbox"
            checked={filters.stale}
            onChange={(e) => go({ stale: e.target.checked ? "1" : "", page: "1" })}
            className="cursor-pointer accent-[#5223E0]"
          />
          Stale only
        </label>
        )}
      </div>
    </div>
  );
}

/**
 * A bare select announces its selected OPTION and nothing else, so a screen
 * reader on the owner filter hears "Every owner" with no idea what it narrows.
 * The label is required rather than optional for that reason.
 */
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 max-w-[220px] cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-body outline-none focus:border-brand"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Chip({
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
      /* On and off are a colour otherwise, which is no answer at all to
         somebody who cannot see it. */
      aria-pressed={on}
      onClick={onPick}
      className={
        on
          ? "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border border-brand bg-brand-soft px-3 text-[13px] font-medium whitespace-nowrap text-[#5223E0]"
          : "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-surface px-3 text-[13px] whitespace-nowrap text-body hover:bg-canvas"
      }
    >
      {label}
      {count != null ? (
        <span className={on ? "tabular-nums" : "tabular-nums text-muted"}>{count}</span>
      ) : null}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════ the batch */

/**
 * WHAT IS SELECTED, AND WHAT CAN BE DONE TO IT.
 *
 * It appears only when something is selected and it sits between the filters
 * and the rows, which is where the selection itself is — a bar pinned to the
 * bottom of the window would be the usual answer and it puts the consequence
 * of a tick a screen away from the tick.
 *
 * "Select all NNN" is offered as soon as the page is fully ticked, because
 * that is the moment somebody means the filter rather than the page. It is
 * capped at what a batch accepts and says the number it will reach, so nobody
 * finds out at the review that half their selection was never in it.
 */
function BulkBar({
  count,
  total,
  pageCount,
  showArchived,
  onClear,
  onSelectEverything,
  onAct,
}: {
  count: number;
  total: number;
  pageCount: number;
  showArchived: boolean;
  onClear: () => void;
  onSelectEverything: () => void;
  onAct: (kind: Bulk) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-soft px-4 py-2.5">
      <span className="text-[13px] font-medium text-ink">{plural(count, "lead")} selected</span>
      {count >= pageCount && count < total ? (
        <button
          type="button"
          onClick={onSelectEverything}
          className="cursor-pointer text-[13px] text-[#5223E0] underline"
        >
          Select all {total.toLocaleString("en-IN")} this filter reaches
        </button>
      ) : null}
      <button
        type="button"
        onClick={onClear}
        className="cursor-pointer text-[13px] text-muted underline hover:text-ink"
      >
        Clear
      </button>

      <span className="min-w-2 flex-1" />

      {showArchived ? (
        <BulkButton onClick={() => onAct("restore")}>Restore them</BulkButton>
      ) : (
        <>
          <BulkButton onClick={() => onAct("reassign")}>Change owner</BulkButton>
          <BulkButton onClick={() => onAct("stage")}>Change stage</BulkButton>
          <BulkButton onClick={() => onAct("chase")}>Chase owners</BulkButton>
          <BulkButton onClick={() => onAct("archive")} danger>
            Archive
          </BulkButton>
        </>
      )}
    </div>
  );
}

function BulkButton({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        danger
          ? "h-8 cursor-pointer rounded-[4px] border border-danger bg-surface px-3 text-[13px] font-medium text-danger hover:bg-danger-soft"
          : "h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body hover:bg-canvas"
      }
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════ the detail */

/**
 * WHAT ONE ROW SAYS WHEN IT IS OPENED.
 *
 * Health moved DOWN here from a column of its own, and that is a deletion
 * rather than a relocation of something that was working. A lead is by
 * definition a shop that has never ordered, so the column read "Not a customer
 * yet" on almost every row of every page — a hundred and ninety pixels of the
 * same sentence, repeated, on the widest table in the app. It says something
 * real on exactly the rows that have been won, and those are the rows somebody
 * opens.
 */
function DetailPanel({
  lead,
  atRiskBelow,
  strongAtOrAbove,
}: {
  lead: LeadRow;
  atRiskBelow: number;
  strongAtOrAbove: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-2 pt-1 text-[13px] lg:grid-cols-4">
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
          <span className="capitalize">{lead.source.replace(/_/g, " ")}</span>
          {" · "}
          {lead.hasGps ? "has a map pin" : "no pin recorded"}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Health
        </div>
        <HealthCell lead={lead} atRiskBelow={atRiskBelow} strongAtOrAbove={strongAtOrAbove} />
      </div>
      <div>
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Notes
        </div>
        <div className="text-pretty text-body">{lead.notes || "None."}</div>
      </div>
      {lead.stage === "lost" && lead.lostReason ? (
        <div className="col-span-2 lg:col-span-4">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Why it was lost
          </div>
          <div className="text-body">{lead.lostReason}</div>
        </div>
      ) : null}
      {lead.convertedCustomerId && lead.convertedAt ? (
        <div className="col-span-2 text-[12px] text-muted lg:col-span-4">
          Converted {stamp(lead.convertedAt)}.
        </div>
      ) : null}
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
        <Pill
          tone={
            view.bandTone === "danger" ? "danger" : view.bandTone === "warn" ? "warn" : "success"
          }
        >
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
