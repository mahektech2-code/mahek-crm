"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { SalesmanLink } from "@/components/leads/salesman-link";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { ExportButton } from "@/app/reports/export-button";
import {
  archiveLead,
  bulkArchiveLeads,
  bulkChaseLeadOwners,
  bulkReassignLeads,
  bulkRestoreLeads,
  chaseLeadOwner,
  exportLeadRows,
  leadIdsForSelection,
  reassignLead,
  restoreLead,
} from "@/lib/actions/sales";
import { bulkAdvanceLeadStage } from "@/lib/actions/leads";
import { healthView } from "@/lib/customer-health";
import { MultiSelect } from "@/components/ui/multi-select";
import { cx } from "@/components/ui/primitives";
import { pinnedCell, pinnedHead } from "@/components/ui/pinned";
import {
  VIEW_CHIPS,
  VIEW_TEXT,
  retiredLadderNote,
  type LeadTileId,
  type LeadView,
} from "@/lib/lead-views";
import { TileStrip } from "@/components/leads/tile-strip";
import {
  AGE_BUCKETS,
  HEALTH_BUCKETS,
  NEXT_BUCKETS,
  POTENTIAL_BUCKETS,
  PRIORITY_BUCKETS,
  SALES_TYPE_BUCKETS,
  type FilterOption,
} from "@/lib/lead-filters";
import {
  LEAD_PRIORITIES,
  priorityLabel,
  prioritySentence,
  priorityTone,
  type LeadPriority,
} from "@/lib/lead-priority";
import { setLeadPriority } from "@/lib/actions/lead-priority";
import type { LeadRow } from "@/lib/services/sales-service";
import {
  ALL_LEAD_STAGES,
  stageLabel,
  type LeadSalesType,
  type LeadStage,
} from "@/lib/lead-labels";
import {
  isOnQueueFor,
  roleAction,
  type LeadAction,
  type LeadActionFacts,
  type LeadVantage,
} from "@/lib/engines/lead-role-action";
import {
  LEAD_VANTAGES,
  primaryVantage,
  vantageAsYou,
  vantagesFor,
  vantageLabel,
  type VantageViewer,
} from "@/lib/lead-vantage";
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
} from "@/components/console/parts";

/**
 * THE EIGHT COLUMNS THAT CAN BE NARROWED, in the order they appear in the
 * table — so the filter bar reads left to right exactly like the header under
 * it, and "which control filters which column" is never a question.
 *
 * Declared once and iterated: the URL parameter, the ticked state, the clear
 * action and the bar itself all walk this list, which is what stops a ninth
 * filter being added to the bar and quietly not being cleared by "Clear all".
 */
const FILTER_COLUMNS = [
  "owner",
  "source",
  "potential",
  /* §4.1 — the manager's own judgement, sitting immediately after the
     salesman's estimate because the pair is only readable together: the whole
     point of the field is that a shop can be worth a great deal and still not
     be this fortnight's work. */
  "priority",
  "stage",
  "next",
  "age",
  "health",
] as const;
type FilterColumn = (typeof FILTER_COLUMNS)[number];

/** Fifteen by default — see `LEADS_PER_PAGE`. The rest are for a wide monitor. */
const PER_PAGE = [15, 25, 50, 100] as const;

type Acting =
  | { kind: "reassign"; lead: LeadRow }
  | { kind: "archive"; lead: LeadRow }
  | { kind: "restore"; lead: LeadRow }
  /* §4.1 — setting the priority from the list, which is where a manager is
     actually standing when they form the judgement: fifteen leads in front of
     them, with the potential, the stage and the age of each one on the row.
     Offering it only on the record would mean opening four hundred records to
     use the field once, which is how a field nobody fills in happens. */
  | { kind: "priority"; lead: LeadRow };

/** The five things a selection can be put through. */
type Bulk = "reassign" | "stage" | "archive" | "restore" | "chase";

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
  workspace,
  leads,
  pageInfo,
  stale,
  filters,
  options,
  view,
  tiles,
  showArchived,
  archivedCount,
  staleDays,
  healthAtRiskBelow,
  healthStrongAtOrAbove,
  team,
  desks,
  canPrioritise,
  viewer,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
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
  /**
   * §8.4 — WHICH CUT OF THE BOOK THIS IS, off the URL.
   *
   * One screen parameterised by a view rather than five screens: All Leads, My
   * Leads, Today's Actions, Overdue and the Distributors & Third-Party
   * register are one table, one filter bar, one pager and one set of row
   * actions, and the specification says so in as many words. Five copies of
   * this file would be five places to add a ninth filter to.
   */
  view: LeadView;
  /**
   * §8.2's nine, counted in SQL over the filtered set — null on the archived
   * book, where a cut of the working list means nothing.
   *
   * It is a COUNT PER TILE and not a list of tiles, because what a tile IS
   * lives in `lead-views.ts` where the tone and the destination carry their
   * own reasoning. A service handing down labels would be a second place to
   * reword one.
   */
  tiles: Record<LeadTileId, number> | null;
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
  /**
   * §4.1 — whether this person may say how hard to push a lead.
   *
   * It decides whether the row menu's item is DISABLED WITH A REASON rather
   * than whether it is drawn at all, which is the choice this product makes
   * for a control somebody might reasonably expect to hold: a menu item that
   * is simply missing reads as the screen being broken, and the sentence on
   * the hover is what tells a telecaller whose job it is. The BADGE is drawn
   * for everybody — reading the manager's judgement is the whole point of it,
   * and the person working the lead is who most needs to have read it.
   *
   * The action checks the same capability. A server action is a URL, and a
   * disabled menu item is a fact about a component.
   */
  canPrioritise: boolean;
  /**
   * §7 — WHOSE JOB THIS READER IS DOING, resolved once on the server and
   * applied here per row.
   *
   * Four booleans rather than a vantage, because two of the five are read off
   * SEATS ON THE ROW and there are four hundred rows: the same person is the
   * back office on one lead and the sales manager on the next, and one vantage
   * computed on the server would have to be wrong about one of them. It
   * decides WORDS only — `lib/lead-vantage.ts` carries the argument at length,
   * and every action on this screen goes on checking its own capability.
   */
  viewer: VantageViewer;
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

  /*
   * A TILE'S DESTINATION, AND IT ADDS RATHER THAN REPLACES.
   *
   * The whole point of the strip recounting against the filters is that the
   * tiles are a cut OF WHAT IS IN FRONT OF YOU. A href built from scratch
   * would throw away the search somebody typed the moment they pressed one,
   * and the number on the tile — which was counted with that search applied —
   * would be right about a list they can no longer reach.
   *
   * `view=all` is written as the ABSENCE of the parameter rather than as the
   * word, so the whole book keeps the address it has always had and a link
   * somebody pasted last year still opens the same screen. The page is
   * dropped for the reason `navigate` drops it: page 7 of a list just narrowed
   * to eleven rows is an empty table that reads as a broken filter.
   */
  const hrefFor = React.useCallback(
    (params: Record<string, string>) => {
      const next = new URLSearchParams(search.toString());
      /* A tile carrying `stage` must not leave a different `view` standing
         over it, and a tile carrying `view` must not leave the previous view's
         `stage` — either way the reader would land somewhere neither tile
         counted. The two parameters the tiles write are cleared together and
         then set from the tile alone. */
      next.delete("view");
      next.delete("stage");
      next.delete("page");
      for (const [k, v] of Object.entries(params)) {
        if (v === "all") next.delete(k);
        else next.set(k, v);
      }
      const q = next.toString();
      return q ? `?${q}` : leadHref(workspace, "leads");
    },
    [search, workspace],
  );

  /*
   * THE SEARCH BOX IS LOCAL AND THE URL IS WHERE IT LANDS.
   *
   * Typed here, debounced, then navigated — a parameter per keystroke is a
   * server round trip per keystroke, and this table is thousands of rows behind
   * a database.
   *
   * The effect depends on everything the timer READS, not just on the text.
   * With `[typed]` alone the cleanup only fires when the text changes, so a
   * navigation landing while a timer is in flight does not cancel it — press
   * Clear filters and a third of a second later the timer rebuilds the URL from
   * the render it was started in and puts the filters back. It reads as a
   * button that does not work.
   *
   * And the box is resynced when `q` changes UNDER it — adjusted during render
   * rather than in an effect, guarded on what we last pushed. The guard is the
   * point: the one thing a search box must never do is overwrite characters
   * somebody has typed since with a value we sent ourselves. What it fixes is
   * the back button, and "Clear filters", which drops `q` without remounting.
   */
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


  /* The search is a filter, so it counts towards "is anything narrowed" and is
     cleared by the same button. A "Clear filters" that leaves a search term in
     the box is one people press twice and then stop trusting. */
  const anyFilter = FILTER_COLUMNS.some((c) => filters[c].length > 0) || Boolean(urlQ);
  const clearFilters = () => {
    setTyped("");
    setPushedQ("");
    navigate({ ...Object.fromEntries(FILTER_COLUMNS.map((c) => [c, undefined])), q: undefined });
  };

  /* The count goes on the label rather than the value: "Pritesh Bipin Doshi
     (511)" is what tells a manager which name is worth ticking, and it is the
     one thing a dropdown of twenty names can say that a list of twenty names
     cannot. */
  const withCounts = (rows: Array<FilterOption & { count: number }>) =>
    rows.map((r) => ({ value: r.value, label: `${r.label} (${r.count})` }));

  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [acting, setActing] = React.useState<Acting | null>(null);
  const [bulk, setBulk] = React.useState<Bulk | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [salesmanId, setSalesmanId] = React.useState("");
  const [stage, setStage] = React.useState<LeadStage>("contacted");
  const [reason, setReason] = React.useState("");
  /*
   * §4.1 — what the priority dialog currently has picked, and "" IS an answer.
   *
   * The empty string is null, which is a manager taking a judgement back off a
   * lead rather than the absence of one — null and `low` are different facts
   * and `lead-priority.ts` carries the argument. A select whose empty option
   * meant "leave it alone" would make clearing impossible from the one screen
   * that offers setting.
   */
  const [priority, setPriority] = React.useState<LeadPriority | "">("");
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
    const result = await leadIdsForSelection({
      archived: showArchived,
      /* "Select everything" means everything on THIS list. Without the view
         the button's count and the set it selects are two different numbers,
         and the one people trust is the one on the button. */
      view,
      filters: {
        ...Object.fromEntries(FILTER_COLUMNS.map((c) => [c, filters[c].join(",") || undefined])),
        search: urlQ || undefined,
      },
    });
    if (!result.ok) {
      toast.push(result.error, "error");
      return;
    }
    setPicked(new Set(result.data.ids));
    if (result.data.capped) {
      toast.push(
        `Selected the first ${result.data.ids.length} — a batch is capped there. Narrow the filter to reach the rest.`,
      );
    }
  }

  function beginBulk(kind: Bulk) {
    setBulk(kind);
    setSalesmanId(team[0]?.id ?? "");
    setStage("contacted");
    setReason("");
    setError(null);
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
      /* EXACTLY WHAT WAS REFUSED STAYS TICKED. Clearing the selection on a
         partial success leaves somebody to find the eleven refused leads again
         by hand, which is the work the batch was supposed to save; keeping the
         whole selection invites them to press the same button on the ones that
         already moved. */
      setPicked(new Set(result.data?.failed.map((f) => f.id) ?? []));
      toast.push(result.message ?? "Done.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------------------------------------- one lead */

  function begin(lead: LeadRow, kind: Acting["kind"]) {
    setActing({ lead, kind } as Acting);
    setSalesmanId(team.find((t) => t.id !== lead.salesmanId)?.id ?? "");
    setReason("");
    /* Opened on what the lead ALREADY carries, unlike the lost-reason picker
       beside it which deliberately pre-selects nothing. The difference is what
       a default would assert: there, it would record a coded reason nobody
       chose; here it is the current answer being shown so somebody can change
       it, which is what an edit is. */
    setPriority(lead.priority ?? "");
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
            : acting.kind === "priority"
              ? await setLeadPriority({
                  customerId: acting.lead.id,
                  /* "" is the cleared answer, and it has to reach the server as
                     null rather than as an omitted field — the action treats a
                     missing value as a validation failure precisely so that
                     "unjudged" is something somebody typed rather than
                     something that fell off a form. */
                  priority: priority === "" ? null : priority,
                })
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


  return (
    <div className="p-6">
      {/*
        THE HEADING CHANGES WITH THE VIEW, and it has to.
        A page still calling itself "Leads" over a table of eleven overdue
        promises is one somebody reads as the whole book having collapsed —
        and unlike the eight filters, a view is not something the reader can
        see ticked anywhere. The words are in `lead-views.ts` beside the view
        itself, so the sentence that admits what is being shown cannot drift
        from the clause that shows it.
      */}
      <ScreenHeader
        title={VIEW_TEXT[view].title}
        subtitle={VIEW_TEXT[view].subtitle}
        actions={
          showArchived ? (
            <Link
              href={leadHref(workspace, "leads")}
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
                    /* The file holds the VIEW as well as the filters. A CSV
                       downloaded from Overdue that quietly carried the whole
                       book is the capped-list mistake in reverse, and whoever
                       it is forwarded to has no way of noticing. */
                    view,
                    filters: {
                      ...Object.fromEntries(
                        FILTER_COLUMNS.map((c) => [c, filters[c].join(",") || undefined]),
                      ),
                      /* The search is a filter like any other, and a file that
                         quietly ignored it would hold a different set to the
                         table it was downloaded from. */
                      search: urlQ || undefined,
                    },
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
                  href={`${leadHref(workspace, "leads")}?view=archived`}
                  className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
                >
                  {plural(archivedCount, "archived lead")}
                </Link>
              ) : null}
            </div>
          )
        }
      />

      {/*
        THE VIEW CHIPS AND THE STRIP SIT ABOVE THE EMPTY STATE, deliberately.
        An empty Overdue list with no way back to the whole book is a dead end
        — the reader has to guess that the URL is what put them there — and it
        is the one moment the strip is worth most, because every other tile on
        it still carries a number. Drawn inside the `leads.length` branch they
        would vanish exactly when they are needed.
      */}
      {!showArchived ? (
        <>
          <ViewChips view={view} hrefFor={hrefFor} />
          {tiles ? <TileStrip counts={tiles} view={view} hrefFor={hrefFor} /> : null}
          {view === "register" ? <RegisterNote /> : null}
        </>
      ) : null}

      {leads.length === 0 ? (
        <Empty
          title={showArchived ? "Nothing archived" : emptyTitleFor(view)}
          body={
            showArchived
              ? "Nobody has filed a lead away — archiving is a manager's own call, on top of what the nightly sweep already does for anything left untouched."
              : emptyBodyFor(view)
          }
        />
      ) : (
        <>
          {!showArchived ? <DeskLine workspace={workspace} desks={desks} /> : null}

          {!showArchived ? <NeedsYouLine leads={leads} viewer={viewer} /> : null}

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

          {/*
            EVERYTHING THAT NARROWS THE LIST, INSIDE THE BOX THE LIST IS IN.
            The filters sat above the table and outside it, so a control that
            changes a table was drawn as though it belonged to something else —
            and on a list this long the association between the control and the
            result is the whole thing. One panel: search and dropdowns, then
            what is selected, then the rows, then the pager.
          */}
          <div className="rounded-[6px] border border-line bg-surface">
          <FilterBar
            filters={filters}
            options={options}
            withCounts={withCounts}
            navigate={navigate}
            anyFilter={anyFilter}
            onClear={clearFilters}
            total={pageInfo.total}
            listTotal={pageInfo.listTotal}
            search={typed}
            onSearch={setTyped}
          />

          {picked.size ? (
            <BulkBar
              count={picked.size}
              total={pageInfo.total}
              pageCount={leads.length}
              showArchived={showArchived}
              onClear={() => setPicked(new Set())}
              onSelectEverything={() => void selectEverything()}
              onAct={beginBulk}
            />
          ) : null}

          <Table
            chrome={false}
            minWidth={1636}
            head={
              <>
                {/* PINNED. The row's name and its actions are the two cells
                    that must survive a sideways scroll — `pinned.ts` carries
                    the argument: scroll the name off and every remaining cell
                    is an orphaned value, scroll the menu off and whether you
                    can act on a row depends on where the table is scrolled. */}
                <HeadCell width={264} className={pinnedHead("left")}>
                  {/* THE TICK RIDES IN THE PINNED CELL rather than in a column
                      of its own. `pinnedCell` is `left-0`, so a column in front
                      of it would sit under the name on any sideways scroll —
                      and the tick belongs beside the thing it identifies
                      anyway. */}
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={allOnPage}
                      /* SOME of them is not NONE of them. Unchecked at three of
                         fifteen, the box says "nothing here is selected" and a
                         click then ticks the other twelve — the opposite of
                         what an empty box promises. */
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
                      className="cursor-pointer accent-[#5223E0]"
                    />
                    Lead
                  </span>
                </HeadCell>
                <HeadCell width={160}>Owner</HeadCell>
                <HeadCell width={140}>Source</HeadCell>
                <HeadCell align="right" width={130}>Potential</HeadCell>
                {/* §4.1 — IMMEDIATELY AFTER THE POTENTIAL, because the two are
                    only readable as a pair. "₹3,00,000 · Low" is a manager
                    saying the big shop is not this fortnight's work, which is
                    the sentence the field exists to let them write; the same
                    two facts a column apart is two numbers nobody connects.
                    It also keeps the filter bar and the header in the same
                    left-to-right order, which is the rule FILTER_COLUMNS
                    states above. */}
                <HeadCell width={120}>Priority</HeadCell>
                <HeadCell width={110}>Stage</HeadCell>
                {/* §7 — IMMEDIATELY AFTER THE STAGE, because the stage is
                    where a lead IS and this is what that means for the person
                    reading it. "Negotiation" on its own is a noun somebody has
                    to translate into a morning's work, and the translation is
                    different for each of the five jobs — so the two belong side
                    by side and the verb belongs in the reader's own voice. The
                    header names the vantage rather than saying "Action",
                    because a column of instructions with no subject reads as
                    instructions for everybody.

                    IT IS HEADED "For you" AND NOT WITH A JOB TITLE, though the
                    job is what the cell is answering from. The vantage is
                    resolved per ROW — two of the five come off seats on the
                    lead — so the same person genuinely reads this column as the
                    back office on one line and as the sales manager on the next,
                    and a single title over all of them would be wrong about
                    some. Which job produced a given sentence rides on the
                    cell's own hover, where it is asked rather than asserted. */}
                <HeadCell width={180}>For you</HeadCell>
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
                  <Row
                    striped={i % 2 === 1}
                    /* A ticked row was distinguishable only by a 13px box, and
                       the selection crosses pages — which is exactly where
                       somebody needs to see what is still held. */
                    selected={picked.has(l.id)}
                    onClick={() => toggleExpanded(l.id)}
                  >
                    <Cell truncate={264} className={pinnedCell("left", i, picked.has(l.id))}>
                      <span className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={picked.has(l.id)}
                          onChange={() => toggleOne(l.id)}
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          aria-label={`Select ${l.name}`}
                          className="mt-0.5 cursor-pointer accent-[#5223E0]"
                        />
                        <span className="min-w-0 flex-1">
                          {/* The name is the door to the record. The row itself
                              still expands, so the one-line summary is a click
                              and the whole climb is a click — the two questions
                              a manager asks of a list are "which of these" and
                              "what is this one waiting on", and they deserve
                              different gestures. */}
                          <Link
                            href={leadHref(workspace, `leads/${l.id}`)}
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            className="font-medium no-underline"
                          >
                            {l.name}
                          </Link>
                          <span className="block truncate text-[12px] text-muted">
                            {[l.companyName, l.city].filter(Boolean).join(" · ") || l.mobile || "—"}
                          </span>
                        </span>
                      </span>
                    </Cell>
                    <Cell truncate={160}>
                      {l.salesmanId ? (
                        <span onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                          <SalesmanLink
                            workspace={workspace}
                            id={l.salesmanId}
                            name={l.salesmanName}
                            className="no-underline"
                          />
                        </span>
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
                      {/* UNJUDGED IS SAID IN WORDS, not left as an empty cell.
                          It is most of the book and it is the answer a manager
                          is looking for; a blank reads as data that failed to
                          load. The hover carries what the word means, because
                          "Low" on its own invites being read as "this lead is
                          no good" rather than as "not this fortnight". */}
                      <span title={prioritySentence(l.priority)}>
                        <Pill tone={priorityTone(l.priority)}>{priorityLabel(l.priority)}</Pill>
                      </span>
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
                    <Cell truncate={180}>
                      <ActionCell lead={l} viewer={viewer} />
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
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                      {showArchived ? (
                        <RowMenu items={[{ label: "Restore it", run: () => begin(l, "restore") }]} />
                      ) : (
                        <RowMenu
                          items={[
                            { label: "Open the record", href: leadHref(workspace, `leads/${l.id}`) },
                            { label: "Reassign the lead", run: () => begin(l, "reassign") },
                            {
                              /* Named for what it is rather than "Set the
                                 priority", so the menu says which of the two
                                 high/medium/low fields on this shop is about
                                 to be written — the potential beside it is the
                                 salesman's estimate and is not editable here
                                 at all. */
                              label: "How hard to push it",
                              run: () => begin(l, "priority"),
                              disabled: !canPrioritise,
                              title: canPrioritise
                                ? undefined
                                : "Deciding which leads the team pushes is a manager's. Yours is not one of the hats that carries it.",
                            },
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
                      <td colSpan={11} className="cursor-pointer border-b border-divider px-4 pb-3.5">
                        <DetailPanel lead={l} hasDetail={hasDetail} viewer={viewer} />
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
          </div>
        </>
      )}

      {/* ------------------------------------------------------ the selection */}

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
              {ALL_LEAD_STAGES.map((v) => (
                <option key={v} value={v}>
                  {stageLabel(v)}
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
              busy || (bulk === "reassign" && !salesmanId) || (bulk === "archive" && !reason.trim())
            }
            onClick={() => void submitBulk()}
          >
            {busy ? "Working…" : `Apply to ${picked.size}`}
          </Button>
        </div>
      </Modal>

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
        {/* The two kinds this modal is FOR, named rather than taken as
            "anything that is not an archive" — that shape was already one
            unnamed kind away from drawing the restore sentence over a dialog
            about something else, and the priority dialog below made it two. */}
        {acting && (acting.kind === "reassign" || acting.kind === "restore") ? (
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

      {/* ------------------------------------------------- §4.1 the priority */}

      <Modal
        open={acting?.kind === "priority"}
        onClose={() => setActing(null)}
        title="How hard to push this lead"
        width={460}
      >
        {acting?.kind === "priority" ? (
          <>
            <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              <div className="font-medium text-ink">{acting.lead.name}</div>
              <div className="text-muted">
                {[acting.lead.companyName, acting.lead.city].filter(Boolean).join(" · ") || "—"}
              </div>
              {/* THE POTENTIAL IS QUOTED BACK, because the judgement is made
                  against it and not instead of it. A manager marking a shop
                  worth three lakh as low priority should be looking at the
                  three lakh while they do it — that pairing is the whole
                  reason the two fields are not one. */}
              <div className="mt-1 text-[12px] text-muted">
                {Number(acting.lead.estimatedPotentialPaise)
                  ? `${money(Number(acting.lead.estimatedPotentialPaise))} a month, the salesman reckons`
                  : "Nobody has estimated what this shop could spend"}
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as LeadPriority | "")}
                className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
              >
                {/* FIRST AND ALWAYS OFFERED, because taking the judgement back
                    off has to be as easy as making it — a manager who cannot
                    undo one stops making them. It is not the same answer as
                    Low: this says nobody has judged the lead, which is what
                    every row in the book says until somebody does. */}
                <option value="">{priorityLabel(null)} — nobody has judged it</option>
                {LEAD_PRIORITIES.map((v) => (
                  <option key={v} value={v}>
                    {priorityLabel(v)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[12px] text-muted">
                {prioritySentence(priority === "" ? null : priority)} It says how hard to push this
                one, never what the shop is worth — that is the potential above, and it is the
                salesman&rsquo;s.
              </span>
            </label>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void submit()}>
                {busy ? "Saving…" : "Save"}
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

/* ═══════════════════════════════════════════════════════ §7, on a row */

/**
 * A `LeadRow` read as the five facts the engine asks for.
 *
 * Written once, here, because the row cell and the cross-vantage panel both
 * need it and two readings of "what is true of this lead" is how one screen
 * comes to tell two people different things about one shop. The stage is cast
 * for the same reason every other read of it on this screen is: the column
 * arrives from the database as a plain string and `LeadRow` types it as one.
 */
function factsOf(lead: LeadRow): LeadActionFacts {
  return {
    stage: lead.stage as LeadStage,
    salesType: lead.salesType as LeadSalesType | null,
    hasCommitment: lead.hasCommitment,
    hasOrder: lead.hasOrder,
    sampleAwaitingDispatch: lead.sampleAwaitingDispatch,
  };
}

/** The seats this row carries, as `vantagesFor` wants them. */
function seatsOf(lead: LeadRow) {
  /* `salesmanId` IS `owner_id` — the list names the column for the person
     rather than for the foreign key, which is the right word on a screen and
     the wrong one here, where the seat is what is being matched. */
  return {
    ownerId: lead.salesmanId,
    backOfficeAmId: lead.backOfficeAmId,
    leadManagerId: lead.leadManagerId,
  };
}

/**
 * How the tones the engine returns are drawn.
 *
 * MUTED IS NOT A PILL, and that is the whole of the mapping's judgement.
 * `lead-role-action.ts` says in its own header that "Nothing operational
 * pending" drawn at the weight of "Payment follow-up" would be read as a task,
 * and a pill is exactly that weight — it is the shape this console uses for
 * something worth noticing. So the three live tones get the house pill and the
 * fourth gets plain muted text, which is the absence of one rather than a
 * fourth colour. No new skin, and nothing outside the tokens.
 */
function ActionPill({ action }: { action: LeadAction }) {
  if (action.tone === "muted") {
    return <span className="text-[13px] text-muted">{action.label}</span>;
  }
  return <Pill tone={action.tone}>{action.label}</Pill>;
}

/**
 * §7 for the person reading the screen.
 *
 * The vantage is resolved per row and the FIRST one is what the cell prints —
 * `vantagesFor` orders them most specific first, and the argument for that
 * ordering is in `lib/lead-vantage.ts`. The hover names which job produced the
 * sentence, because the same reader legitimately reads this column as two
 * different people down one page and a sentence with no subject is one nobody
 * can check.
 *
 * NO VANTAGE IS SAID IN WORDS rather than left blank. It is a real answer —
 * somebody holding the leads module through an app that gives them no job on
 * this particular shop — and a blank cell in a column of instructions reads as
 * data that failed to load, which is the rule the priority cell two columns
 * along already follows.
 */
function ActionCell({ lead, viewer }: { lead: LeadRow; viewer: VantageViewer }) {
  const vantage = primaryVantage(viewer, seatsOf(lead));
  if (!vantage) {
    return (
      <span
        className="text-[13px] text-muted"
        title="Nobody has put you on this lead and none of your apps gives you a job on it. Open the row to see what it reads as to the people who do."
      >
        No job on this one
      </span>
    );
  }
  const action = roleAction(factsOf(lead), vantage);
  return (
    <span title={`${vantageAsYou(vantage)}. ${action.label}.`}>
      <ActionPill action={action} />
    </span>
  );
}

/**
 * THE SAME LEAD READ BY ALL FIVE, which is the affordance §7 is actually for.
 *
 * A manager's question about a stuck lead is not "what do I do" — his own verb
 * is already on the row — it is "what is owed, and by whom". Five sentences
 * side by side answer it in one glance: a lead in Negotiation where the
 * manager reads "Confirm actual order" and the salesman reads "Negotiation
 * visit" is a lead where two people are each waiting for the other, and there
 * is nowhere else in the product that fact is visible.
 *
 * It is in the EXPANDED ROW and not on the row itself, because five
 * instructions where one is wanted is how a worklist becomes a report. The row
 * carries the reader's own; opening it asks the second question.
 *
 * The reader's own vantages are MARKED rather than removed from the list. A
 * table with one row quietly missing is one nobody can count against the
 * specification, and "this one is yours" is the useful mark anyway.
 */
function RoleReadings({ lead, viewer }: { lead: LeadRow; viewer: VantageViewer }) {
  /* EVERY vantage the reader holds, not just the one the row printed. A sales
     manager who is also the named back office person on this lead is being
     asked for two different things by two of these five rows, and the panel
     exists precisely to show that. */
  const mine = new Set<LeadVantage>(vantagesFor(viewer, seatsOf(lead)));
  const facts = factsOf(lead);
  return (
    <div className="col-span-3 border-t border-divider pt-2">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        What this lead reads as
      </div>
      {/* Wraps rather than scrolls: five short phrases fit one line on a desk
          and stack on a phone, and a sideways scroll inside an expanded row is
          a thing nobody finds. */}
      <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1.5">
        {LEAD_VANTAGES.map((v) => {
          const action = roleAction(facts, v);
          return (
            <span key={v} className="flex items-baseline gap-1.5 text-[13px]">
              <span className="text-muted">
                {vantageLabel(v)}
                {mine.has(v) ? " · you" : ""}
              </span>
              <ActionPill action={action} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * §8.4's views as a chip strip, which is the one control that says this screen
 * has more than one list in it.
 *
 * Chips rather than tabs, and above the filter bar rather than in it, because
 * a view changes what the list IS while a filter narrows what it already is —
 * the same argument the handset's Everything / Customers / Leads chips carry.
 * A view hidden inside the filter menu is one people misread as a filter they
 * forgot to clear.
 *
 * Every chip is a plain link, so a view survives a bookmark, a refresh and a
 * link pasted into WhatsApp. `hrefFor` keeps the filters, which is the whole
 * point: "everything Rakesh has, and of those the overdue ones" is two clicks
 * and neither undoes the other.
 */
function ViewChips({
  view,
  hrefFor,
}: {
  view: LeadView;
  hrefFor: (params: Record<string, string>) => string;
}) {
  return (
    <nav aria-label="Lead views" className="mb-4 flex flex-wrap items-center gap-1.5">
      {VIEW_CHIPS.map((v) => {
        const active = v === view;
        return (
          <Link
            key={v}
            href={hrefFor({ view: v })}
            aria-current={active ? "page" : undefined}
            title={VIEW_TEXT[v].subtitle}
            className={cx(
              "inline-flex h-8 items-center rounded-[4px] border px-3 text-[13px] no-underline hover:no-underline",
              active
                ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            {VIEW_TEXT[v].title}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * THE REGISTER SAYS THAT HALF OF IT IS NO LONGER BEING FED.
 *
 * A list headed "Distributors & third-party" with a distributor column and no
 * sentence reads as a book somebody is still filling, and the leads on that
 * ladder read as work in progress — which is exactly what they are not. Mahek
 * withdrew the distributor track because nobody in the building had the
 * authority to complete its appointment approval, so the leads on it were
 * parked half way up a ladder with no end, indistinguishable on every screen
 * from leads somebody was working. That is the failure this paragraph exists
 * to stop happening a second time on the one screen that gathers them.
 *
 * The words come from `retiredLadderNote`, which reads the `retired` flag on
 * `SALES_TYPES` rather than asserting anything: deleting that single line
 * turns the ladder back on everywhere at once, and this sentence off with it.
 * A note typed into this file would go on telling people the track was closed
 * for as long as it took somebody to notice.
 */
function RegisterNote() {
  const note = retiredLadderNote();
  if (!note) return null;
  return (
    <div className="mb-4 rounded-[6px] border-l-[3px] border-line-strong bg-canvas px-4 py-3">
      <div className="text-sm font-semibold text-ink">The distributor ladder is closed</div>
      <div className="mt-0.5 text-[13px] text-pretty text-body">{note}</div>
    </div>
  );
}

/**
 * AN EMPTY LIST HAS TO SAY WHICH KIND OF EMPTY IT IS.
 *
 * "No leads" under a view is a sentence about the whole book, and on Overdue
 * it is the opposite of the truth — an empty Overdue list is the rule working,
 * and drawing it as an absence of data is how somebody concludes the screen is
 * broken and stops opening it. The same distinction the Overdue screen already
 * makes with its answered count, made here with words because this view has no
 * second figure to make it with.
 */
function emptyTitleFor(view: LeadView): string {
  switch (view) {
    case "mine": return "Nothing with your name on it";
    case "today": return "Nothing owed today";
    case "overdue": return "Nothing overdue";
    case "expected": return "Nobody has committed to an order";
    case "lost30": return "Nothing lost this month";
    case "register": return "Nobody on this register";
    default: return "No leads";
  }
}

function emptyBodyFor(view: LeadView): string {
  switch (view) {
    case "mine":
      return "No lead here carries your seat — not as its owner, not as its lead manager and not as its back office person. That is a fact about the seats rather than about your work: the For you column says what a lead wants from whoever is reading it.";
    case "today":
      return "No next action falls today and no parked lead comes back today, under these filters. §24 is the rule that stops a lead sitting with nothing owed by anybody — an empty day here is that rule working rather than a screen with nothing in it.";
    case "overdue":
      return "Every promise on this book has either been kept or is still in the future. This is the one list that is supposed to empty itself.";
    case "expected":
      return "§3.4 counts a commitment as a day AND a size. A day on its own is a follow-up somebody has to make and is deliberately not counted here — so an empty list can mean nobody was asked how much, rather than nobody promised anything.";
    case "lost30":
      return "Nothing has been closed as lost in the last thirty days. A lead with no recorded day at the rung it is on is left out rather than dated from a guess.";
    case "register":
      return "No lead is marked as a distributor or as a third-party shop. The third-party mark is what says the goods go here and somebody else holds the invoice; nobody has made that call on this book yet.";
    default:
      return "A lead is a shop that is not on the book yet. They are raised on the handset, and the duplicate check reads customers as well as leads — the number somebody is about to type is quite often already an account.";
  }
}

/**
 * "Four of these fifteen need you" — §7's `isOnQueueFor`, counted.
 *
 * The engine's own header says the actionable flag is what decides whether a
 * lead counts towards somebody's "needs you today", and this is that sentence.
 * It is deliberately NOT a second reading of the ladder: it asks `roleAction`
 * through `isOnQueueFor` and believes the answer, so the count above the table
 * and the verbs in it cannot disagree about one shop.
 *
 * IT SAYS WHAT IT IS A SLICE OF, because it is counted over the PAGE and not
 * over the filtered book. Everything else measured around this table is
 * counted in SQL — the stale strip says so in its own comment — and this one
 * cannot be, because two of the five vantages are read off seats and the
 * arithmetic is per person. A bare "4 need you" over a list of four hundred
 * would be read as four in the whole book, which is the capped-list mistake
 * the timeline's filter pills are a paragraph about. So it names the page.
 *
 * Nothing is drawn where the answer is none: a line reading "0 need you" is
 * furniture on the screen somebody opens to find work, and the table beneath
 * it already says which leads are whose.
 */
function NeedsYouLine({ leads, viewer }: { leads: LeadRow[]; viewer: VantageViewer }) {
  const mine = leads.filter((l) => {
    const vantage = primaryVantage(viewer, seatsOf(l));
    return vantage !== null && isOnQueueFor(factsOf(l), vantage);
  });
  if (mine.length === 0) return null;
  return (
    <div className="mb-3 text-[13px] text-body">
      <span className="font-semibold text-ink">{plural(mine.length, "lead")}</span> on this page{" "}
      {mine.length === 1 ? "is" : "are"} waiting on you — the{" "}
      <span className="text-muted">For you</span> column says what each one wants.
    </div>
  );
}

function DetailPanel({
  lead,
  hasDetail,
  viewer,
}: {
  lead: LeadRow;
  hasDetail: boolean;
  viewer: VantageViewer;
}) {
  if (!hasDetail) {
    /* The five readings are drawn even here. "Nothing more recorded" is about
       what somebody has TYPED on this lead, and §7's instructions are derived
       from where it stands — which is exactly as true of a lead with no notes
       and no pin, and is the only thing an otherwise empty panel has to say. */
    return (
      <div className="grid grid-cols-3 gap-x-8 gap-y-2 pt-1 text-[13px]">
        <p className="col-span-3 text-[13px] text-muted">
          Nothing more recorded — no notes, no pin, and this shop has not converted.
        </p>
        <RoleReadings lead={lead} viewer={viewer} />
      </div>
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
      <RoleReadings lead={lead} viewer={viewer} />
    </div>
  );
}

/**
 * THE THREE DESKS, ON ONE LINE.
 *
 * They were four tiles the width of the screen, above a funnel that was another
 * four hundred pixels — so the worklist this page exists to be started below the
 * fold, and the first thing a manager saw on the screen they open to work a list
 * was a page of arithmetic. The tiles were never the point: the desks are
 * QUEUES, and what a queue needs on the screen people start from is a count and
 * a way in, which is a link with a number on it.
 *
 * The funnel went for a better reason than size. It has had its own screen since
 * the lead spec landed — `<app>/leads/funnel`, three ladders, cohort conversion
 * and a window to read them over, every band linking into the pre-filtered book.
 * Drawing a smaller, dumber copy of that above the list was two answers to one
 * question, and the one on this page was the worse of them.
 *
 * Nothing else moved up here: the counts live on the filter bar, where they
 * describe what the filter found, and the stale strip keeps its own line because
 * it NAMES the leads, which is the half a count cannot give you.
 */
function DeskLine({
  workspace,
  desks,
}: {
  workspace: LeadWorkspace;
  desks: {
    verification: number;
    verificationMine: number;
    noNextAction: number;
    appointments: number;
  };
}) {
  const items = [
    {
      href: leadHref(workspace, "leads/qualify/verification"),
      label: "Verification",
      value: desks.verificationMine,
      title:
        desks.verification === desks.verificationMine
          ? "Prospects waiting on your call."
          : `Yours, of ${desks.verification} waiting on anybody.`,
    },
    {
      href: leadHref(workspace, "leads/actions/none"),
      label: "Nobody is working these",
      value: desks.noNextAction,
      title: "No next action, or one whose day has gone.",
    },
    {
      href: leadHref(workspace, "leads/appointments"),
      label: "Appointments",
      value: desks.appointments,
      title: "Distributor appointments waiting on a signature.",
    },
    {
      href: leadHref(workspace, "leads/actions/nurture"),
      label: "Nurture",
      value: null as number | null,
      title: "What the nurture sequence has raised.",
    },
  ];

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          title={it.title}
          className="text-muted no-underline hover:text-ink hover:underline"
        >
          {it.label}
          {it.value != null ? (
            <span
              className={
                it.value > 0
                  ? " font-semibold tabular-nums text-warn-ink"
                  : " tabular-nums text-muted"
              }
            >
              {" "}
              {it.value}
            </span>
          ) : null}
        </Link>
      ))}
    </div>
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
  search,
  onSearch,
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
  /** What is typed NOW, which is not always what the URL carries — see below. */
  search: string;
  onSearch: (v: string) => void;
}) {
  const pick = (column: FilterColumn) => (next: string[]) =>
    navigate({ [column]: next.join(",") || undefined });

  return (
    /* THE PANEL'S OWN GUTTER, which is what the complaint was about: the bar
       sat on the page margin and the table started on its own, so the first
       control and the first column were on two different left edges and the
       eye had to find the table twice. `px-4` is the cell padding, so the
       search box now lines up with the Lead column beneath it. */
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      {/*
        FIRST, BECAUSE IT IS WHAT SOMEBODY REACHES FOR.
        Seven dropdowns answer "which of these known values"; none of them
        answers "I am looking for Orange City and I know part of the name",
        which is the question a list of three thousand leads is opened with.
        Without it the only way to find one lead was the browser's own find,
        over whatever page happened to be loaded.
      */}
      <SearchBox value={search} onChange={onSearch} />
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
        label="Priority"
        placeholder="Any priority"
        options={[...PRIORITY_BUCKETS]}
        selected={filters.priority}
        onChange={pick("priority")}
        title="How hard a manager has asked for this one to be pushed — not what it is worth. Not set is the one most of the book sits on, and it is a real answer rather than a gap."
      />
      <MultiSelect
        label="Sales type"
        placeholder="All ladders"
        options={[...SALES_TYPE_BUCKETS]}
        selected={filters.salesType}
        onChange={pick("salesType")}
        title="Which of the three ladders this lead climbs, and the fourth answer that is not one. A RUNG is not a track — Suspect is the foot of all three — so narrowing by stage alone answers with every ladder at once."
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

/* ═══════════════════════════════════════════════════════════════ the batch */

/**
 * WHAT IS SELECTED, AND WHAT CAN BE DONE TO IT.
 *
 * It appears only when something is selected, and it sits between the filters
 * and the rows — which is where the selection itself is. A bar pinned to the
 * bottom of the window is the usual answer and it puts the consequence of a
 * tick a screen away from the tick.
 *
 * "Select all NNN" is offered as soon as the page is fully ticked, because that
 * is the moment somebody means the filter rather than the page. It names the
 * number it will actually reach, so nobody finds out at the review that half
 * their selection was never in it.
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

/**
 * The search box.
 *
 * It sits in the filter bar and behaves like the seven dropdowns beside it —
 * the value lands in the URL, so a search is a thing somebody sends to
 * somebody else and the narrowing happens in the database rather than in a
 * browser holding one page. What is different is the DEBOUNCE: a dropdown is
 * one click and one navigation, and a search box is one navigation per
 * keystroke unless something stops it.
 *
 * The placeholder names the fields rather than saying "Search", because what
 * it reaches is not guessable: the owner's name is in there, which is the
 * single most useful thing to be able to type and the last thing anybody would
 * assume a box above a table of shops would match.
 */
function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search leads"
        placeholder="Search a shop, a town, a phone number, an owner…"
        title="Every word has to appear somewhere: the shop, the company, the phone, the town, the area, the notes or the owner's name."
        className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface px-2.5 pr-14 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded-[3px] px-1.5 py-0.5 text-[12px] text-muted hover:bg-canvas hover:text-ink"
        >
          Clear
        </button>
      ) : null}
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
    /* A RULE, not a box. It drew its own three borders and a rounded bottom
       because it used to hang off the foot of the table's own card; inside the
       panel that is a second line a pixel under the first. */
    <div className="flex flex-wrap items-center gap-3 border-t border-line bg-canvas px-4 py-2.5">
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
