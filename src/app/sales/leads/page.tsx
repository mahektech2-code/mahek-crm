import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import {
  archivedLeadsCount,
  fieldTeam,
  leadFilterOptions,
  leadsPage,
  type LeadFilters,
} from "@/lib/services/sales-service";
import {
  appointmentQueue,
  leadsWithoutNextAction,
  verificationQueue,
} from "@/lib/services/lead-console-service";
import { LeadsScreen } from "./leads-screen";

export const metadata = { title: "Leads — Sales Dashboard — MahekOne" };

/**
 * Shops that are not on the book yet.
 *
 * **THIS SCREEN IS A WORKLIST, AND IT USED TO BE A REPORT.** It opened on a
 * counted funnel — four bars per sales type, a potential figure under each and
 * three paragraphs explaining what a potential is — above a table of four
 * hundred rows with no search, no filter and no pager. On a real book of three
 * and a half thousand leads that is a page which ships every row it can, stops
 * silently at the limit, and puts the one thing a manager came for, which is
 * "find me Rakesh's stalled leads in Nagpur", below a screenful of arithmetic
 * nobody asked for. The funnel is not gone — it is the four band chips under
 * the search box, where a count doubles as the filter that reaches the rows
 * behind it, which is the only form of a figure a worklist has room for.
 *
 * **Everything that narrows the list is a URL parameter**, because a filtered
 * view is a thing somebody sends to somebody else, and because the narrowing
 * happens in SQL: the table, the pager, the band counts and the export all run
 * `leadFilterClause` and cannot disagree about which leads they are describing.
 * The sole exception is the search box's own keystrokes, which are debounced
 * before they reach the URL — a round trip per character is a page that flashes
 * while somebody types a shop name.
 *
 * The three desk counts stay, as one line of links rather than four tiles: the
 * work the funnel added is a queue, and a queue with no count on the screen
 * people start from is one nobody opens.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const showArchived = one("view") === "archived";
  const day = await today();
  const config = await getConfig();
  const staleDays = config["mbos.leads.staleDays"];

  const filters: LeadFilters = {
    archived: showArchived,
    search: one("q").slice(0, 120),
    band: one("band"),
    ownerId: one("owner"),
    source: one("source"),
    salesType: one("type"),
    stale: one("stale") === "1",
    staleDays,
  };

  const perPage = Math.min(200, Math.max(5, Number(one("per")) || 15));
  const page = Math.max(1, Number(one("page")) || 1);
  const sort = one("sort") || "next";

  const [result, team, archivedCount, options, verification, exceptions, appointments] =
    await Promise.all([
      leadsPage(day, filters, { page, perPage, sort }),
      fieldTeam(),
      archivedLeadsCount(),
      leadFilterOptions(showArchived),
      verificationQueue(day, { limit: 1 }),
      leadsWithoutNextAction(day, { limit: 1 }),
      appointmentQueue(),
    ]);

  return (
    <LeadsScreen
      leads={result.rows}
      total={result.total}
      bandCounts={result.bandCounts}
      bandTotal={result.bandTotal}
      staleCount={result.stale}
      unassignedCount={result.unassigned}
      /* The page the SERVER settled on, not the one the URL asked for — it
         clamps, and rendering the request over clamped rows is a pager reading
         "page 9 of 2". */
      page={result.page}
      perPage={perPage}
      sort={sort}
      filters={filters}
      options={options}
      showArchived={showArchived}
      archivedCount={archivedCount}
      staleDays={staleDays}
      healthAtRiskBelow={config["mbos.health.atRiskBelow"]}
      healthStrongAtOrAbove={config["mbos.health.strongAtOrAbove"]}
      team={team.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name }))}
      desks={{
        verification: verification.total,
        verificationMine: verification.mine,
        noNextAction: exceptions.total,
        appointments: appointments.length,
      }}
    />
  );
}
