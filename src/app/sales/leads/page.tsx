import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import {
  archivedLeadsCount,
  archivedLeadsList,
  fieldTeam,
  leadsList,
} from "@/lib/services/sales-service";
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
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const showArchived = view === "archived";

  const day = await today();
  const [leads, config, team, archivedCount] = await Promise.all([
    showArchived ? archivedLeadsList(day) : leadsList(day),
    getConfig(),
    fieldTeam(),
    archivedLeadsCount(),
  ]);

  return (
    <LeadsScreen
      leads={leads}
      showArchived={showArchived}
      archivedCount={archivedCount}
      staleDays={config["mbos.leads.staleDays"]}
      healthAtRiskBelow={config["mbos.health.atRiskBelow"]}
      team={team.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name }))}
    />
  );
}
