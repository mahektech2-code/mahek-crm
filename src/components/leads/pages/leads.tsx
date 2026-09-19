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
import {
  appointmentQueue,
  canLead,
  leadsWithoutNextAction,
  verificationQueue,
} from "@/lib/services/lead-console-service";
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
  const showArchived = params.view === "archived";

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
  const [page, config, team, archivedCount, verification, exceptions, appointments, options] =
    await Promise.all([
      leadsPage(day, {
        archived: showArchived,
        filters,
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
      desks={{
        verification: verification.total,
        verificationMine: verification.mine,
        noNextAction: exceptions.total,
        appointments: appointments.length,
      }}
    />
  );
}
