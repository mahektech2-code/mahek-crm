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
  leadFunnel,
  leadsWithoutNextAction,
  verificationQueue,
} from "@/lib/services/lead-console-service";
import { LeadsScreen } from "./leads-screen";

export const metadata = { title: "Leads — Sales Dashboard — MahekOne" };

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
 * **The funnel is counted in SQL and banded by the engine, per sales type.**
 * It used to be four counts taken over whatever rows the table happened to
 * hold, across one ladder — which was right while there was one ladder and
 * stopped being right the moment a distributor appointment could sit in it.
 * "Negotiation" then means "talking about quantity" for a shop and "management
 * has appointed them" for a distributor, and one bar cannot say which. The
 * mapping is `bandOf` and is never restated here.
 *
 * The three desk counts across the top are the reason this screen is a way IN
 * rather than the whole feature: the work the funnel added is a queue, and a
 * queue with no count on the screen somebody starts from is one nobody opens.
 */
export default async function Page({
  searchParams,
}: {
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
   * `/sales/leads/layout.tsx` used to carry it, back when everything beneath
   * this path was one module. It is now nine separately-grantable ones, so a
   * guard up there would refuse somebody holding Qualification on the strength
   * of a module they were deliberately not given. The book itself is still
   * `sales.leads`, and this is the only place left to say so — `[id]` and
   * `board` are folders and keep theirs in a layout, as usual.
   */
  const user = await requireUser();
  await requireModule(user.id, "sales.leads");

  const params = await searchParams;
  const showArchived = params.view === "archived";

  const filters: LeadFilters = {
    owner: params.owner,
    source: params.source,
    stage: params.stage,
    potential: params.potential,
    next: params.next,
    age: params.age,
    health: params.health,
  };

  const day = await today();
  const [page, config, team, archivedCount, funnel, verification, exceptions, appointments, options] =
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
      leadFunnel(),
      verificationQueue(day, { limit: 1 }),
      leadsWithoutNextAction(day, { limit: 1 }),
      appointmentQueue(),
      leadFilterOptions(showArchived),
    ]);

  return (
    <LeadsScreen
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
      funnel={funnel}
      desks={{
        verification: verification.total,
        verificationMine: verification.mine,
        noNextAction: exceptions.total,
        appointments: appointments.length,
      }}
    />
  );
}
