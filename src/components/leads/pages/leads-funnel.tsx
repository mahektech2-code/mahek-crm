import { type LeadWorkspace } from "@/lib/lead-workspace";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { isReportPeriod, reportRange, type ReportPeriod } from "@/lib/business-date";
import { funnelByRung, leadCohort } from "@/lib/services/lead-funnel-service";
import { FunnelScreen } from "@/components/leads/funnel/funnel-screen";


/**
 * Screen 2 — the three ladders, counted per rung.
 *
 * `leadFunnel()` already draws four BANDS on the Leads screen and this is
 * deliberately not that read. Bands answer "is there a pipeline"; rungs answer
 * "where does it stop moving", and they are the same table asked two
 * questions. `bandOf` is not restated here and is not reached for — the ladder
 * array from the engine IS the ordering, and the one mapping from rung to band
 * stays where the test that walks every enum value through it can see it.
 *
 * The cohort below the funnels is the other half of the screen and reads a
 * different population: the funnels count where leads are STANDING today, the
 * cohort counts what became of the leads RAISED in a window. Putting them on
 * one screen is the point — a funnel with a healthy shape and a conversion
 * rate of four percent is a book that generates leads and closes none, and
 * neither figure says so alone.
 *
 * The guard is `funnel/layout.tsx`, which holds `sales.lead-funnel`. Nothing
 * in here re-checks it: one gate per route, in the layout the route sits under.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  /* The window is a URL parameter rather than component state, like every
     other filter on the Sales Dashboard: a cohort somebody has narrowed to
     last quarter is a thing they want to send to whoever asked. */
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: asked } = await searchParams;
  const period: ReportPeriod = isReportPeriod(asked) ? asked : "quarter";

  /*
   * THE CLOCK IS READ ONCE, HERE. Every "days on this rung" figure and the
   * cohort's own window are measured against the same business date — read in
   * a server component and passed down, because reading it during render is
   * impure and because two figures on one screen measured against two
   * different days is a bug nobody can reproduce.
   */
  const day = await today();
  const config = await getConfig();
  const range = reportRange(day, period);

  const [funnels, cohort] = await Promise.all([
    funnelByRung(day),
    leadCohort(range, config["owner.conversionWindowDays"], day),
  ]);

  return <FunnelScreen workspace={workspace} funnels={funnels} cohort={cohort} period={period} day={day} />;
}
