import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import {
  archivedLeadsCount,
  archivedLeadsList,
  fieldTeam,
  leadsList,
} from "@/lib/services/sales-service";
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
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const showArchived = view === "archived";

  const day = await today();
  const [leads, config, team, archivedCount, funnel, verification, exceptions, appointments] =
    await Promise.all([
      showArchived ? archivedLeadsList(day) : leadsList(day),
      getConfig(),
      fieldTeam(),
      archivedLeadsCount(),
      leadFunnel(),
      verificationQueue(day, { limit: 1 }),
      leadsWithoutNextAction(day, { limit: 1 }),
      appointmentQueue(),
    ]);

  return (
    <LeadsScreen
      leads={leads}
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
