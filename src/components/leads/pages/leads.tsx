import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import {
  archivedLeadsCount,
  fieldTeam,
  leadFilterOptions,
  leadsPage,
  LEADS_PER_PAGE,
} from "@/lib/services/sales-service";
import { splitFilter, type LeadFilters } from "@/lib/lead-filters";
import { viewFromParam } from "@/lib/lead-views";
import { leadTileCounts } from "@/lib/services/lead-views-service";
import {
  appointmentQueue,
  canLead,
  leadsWithoutNextAction,
  verificationQueue,
} from "@/lib/services/lead-console-service";
import { vantageViewer } from "@/lib/services/lead-vantage-service";
import { LeadsScreen } from "@/components/leads/leads-screen";


/**
 * Shops that are not on the book yet.
 *
 * The funnel across the top is the design's, and it is counted rather than
 * estimated: each band is how many leads are sitting at that stage and what
 * they are worth if they all came in. That second number is a POTENTIAL, typed
 * by whoever raised the lead, and the screen says so — an estimate presented
 * beside real order values gets read as one.
 *
 * Stale is a measured thing, not a mood: `mbos.leads.staleDays` from
 * configuration, counted from the last activity date. Archiving here is a
 * manager's own decision now, on top of what the nightly sweep already does —
 * see `leads-screen.tsx` for the row actions and `lib/actions/sales.ts` for
 * what each one writes.
 *
 * **THE FUNNEL IS NOT DRAWN HERE ANY MORE.** It has its own screen —
 * leadHref(workspace, `leads/funnel`), three ladders, cohort conversion, a window to read
 * them over and every band linking into the pre-filtered book. A smaller copy
 * above this list was two answers to one question, and the one on this page
 * was the worse of them; what it cost was the worklist starting below the
 * fold on the screen somebody opens to work a list.
 *
 * The three desk counts stay, as one line of links rather than four tiles: the
 * work the funnel added is a queue, and a queue with no count on the screen
 * somebody starts from is one nobody opens. What a queue needs there is a
 * count and a way in, which is a link with a number on it.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  /*
   * EVERY FILTER IS A URL PARAMETER, like the customers list. A filtered view
   * of five hundred leads is the thing a manager wants to send somebody —
   * "these eleven, nobody is working them" — and holding it in component state
   * makes that unsendable and the back button a lie. It is also what lets the
   * filtering and the paging happen in the database rather than in a browser
   * that has been handed the whole book.
   */
  searchParams: Promise<
    {
      view?: string;
      page?: string;
      per?: string;
    } & Record<string, string | undefined>
  >;
}) {
  /*
   * THE GUARD IS HERE RATHER THAN IN THE FOLDER'S LAYOUT, and that is not the
   * pattern slipping.
   *
   * leadHref(workspace, `leads/layout.tsx`) used to carry it, back when everything beneath
   * this path was one module. It is now nine separately-grantable ones, so a
   * guard up there would refuse somebody holding Qualification on the strength
   * of a module they were deliberately not given. The book itself is still
   * `sales.leads`, and this is the only place left to say so — `[id]` and
   * `board` are folders and keep theirs in a layout, as usual.
   */
  const user = await requireUser();
  await requireModule(user.id, `${workspace}.leads`);

  const params = await searchParams;
  /*
   * §8.4 — ONE SCREEN, SEVERAL VIEWS, AND `archived` WAS ALREADY ONE OF THEM.
   *
   * The parameter is not new: `?view=archived` has been the way to the filed
   * book since the list shipped, which is exactly why the rest of §8.4's views
   * are spelled onto the same parameter rather than given one of their own.
   * Two parameters saying which list this is would be two answers the first
   * time somebody sent a link carrying both.
   *
   * `viewFromParam` reads anything it does not recognise as the whole book: a
   * query string is a thing anybody can write, and a screen that refuses to
   * draw over a typo is worse than one that shows them everything.
   */
  const view = viewFromParam(params.view);
  const showArchived = view === "archived";

  const filters: LeadFilters = {
    /* Capped on the way in. A search box is a text field on a URL anybody can
       write, and six words is already more than a search; the clause caps the
       words and this caps the string. */
    search: params.q?.slice(0, 200),
    owner: params.owner,
    source: params.source,
    stage: params.stage,
    potential: params.potential,
    priority: params.priority,
    next: params.next,
    age: params.age,
    health: params.health,
  };

  const day = await today();
  const [
    page,
    config,
    team,
    archivedCount,
    verification,
    exceptions,
    appointments,
    options,
    viewer,
    tiles,
  ] = await Promise.all([
      leadsPage(day, {
        archived: showArchived,
        filters,
        view,
        page: Number(params.page) || 1,
        perPage: Number(params.per) || LEADS_PER_PAGE,
      }),
      getConfig(),
      fieldTeam(),
      archivedLeadsCount(),
      verificationQueue(day, { limit: 1 }),
      leadsWithoutNextAction(day, { limit: 1 }),
      appointmentQueue(),
      leadFilterOptions(showArchived),
      /*
       * §7 — whose job this reader is doing, asked ONCE for the whole page.
       *
       * Two of the five vantages come off seats on the row, so the resolution
       * itself has to happen per row; what does not is reading the person's
       * hats, which is one memoized `app_access` select however many leads are
       * drawn. It rides in the same `Promise.all` as everything else on the
       * screen, so §7 costs this page no round trip of its own.
       */
      vantageViewer(user),
      /*
       * §8.2's nine, counted in SQL over the SAME filters the table ran and
       * deliberately not over the current view — `leadTileCounts` carries the
       * argument. It rides in this `Promise.all`, so a strip that recounts on
       * every filter change costs the screen no round trip of its own.
       *
       * On the archived book it is not asked at all. Every tile is a cut of
       * the WORKING list — "owed today" over leads somebody filed away is a
       * sentence about nothing — and nine zeroes above an archive would read
       * as a strip that had failed to load.
       */
      showArchived
        ? null
        : leadTileCounts(day, { archived: false, filters }),
    ]);

  return (
    <LeadsScreen workspace={workspace}
      leads={page.rows}
      pageInfo={{
        page: page.page,
        pageCount: page.pageCount,
        perPage: page.perPage,
        total: page.total,
        listTotal: page.listTotal,
      }}
      stale={page.stale}
      filters={{
        owner: splitFilter(filters.owner),
        source: splitFilter(filters.source),
        stage: splitFilter(filters.stage),
        potential: splitFilter(filters.potential),
        priority: splitFilter(filters.priority),
        next: splitFilter(filters.next),
        age: splitFilter(filters.age),
        health: splitFilter(filters.health),
      }}
      options={options}
      view={view}
      tiles={tiles}
      showArchived={showArchived}
      archivedCount={archivedCount}
      staleDays={config["mbos.leads.staleDays"]}
      healthAtRiskBelow={config["mbos.health.atRiskBelow"]}
      healthStrongAtOrAbove={config["mbos.health.strongAtOrAbove"]}
      team={team.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name }))}
      /* §4.1 — the manager's priority is a manager's to set, and the same
         capability is checked in `setLeadPriority`. `lead.verify` is asked for
         rather than a capability of its own: it already means "the sales
         manager's own judgement about a lead, which the salesman working it
         may not make about his own work", which is this act exactly — see the
         action for why `lead.override` and `lead.work` were the wrong two. */
      canPrioritise={await canLead(user, "lead.verify")}
      /* WORDS, never rights. See `lib/lead-vantage.ts` — this decides which
         instruction each row prints and nothing whatever about what may be
         done to the lead, which every action goes on checking for itself. */
      viewer={viewer}
      desks={{
        verification: verification.total,
        verificationMine: verification.mine,
        noNextAction: exceptions.total,
        appointments: appointments.length,
      }}
    />
  );
}
