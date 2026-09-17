import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { isReportPeriod, reportRange, type ReportPeriod } from "@/lib/business-date";
import { canLead } from "@/lib/services/lead-console-service";
import { allLeadSources, leadSources } from "@/lib/services/lead-funnel-service";
import { SourcesScreen } from "@/components/leads/funnel/sources/sources-screen";


/**
 * Screen 6 — where business comes from, and the cleanup tool for the column
 * that answers it.
 *
 * `lead_source` is free text and will stay free text: a fixed list would have
 * to be right about every channel Mahek ever tries, and the day it is not,
 * somebody types the real answer into the notes instead. What makes that
 * survivable is that the report and the tidy-up are the same screen — the
 * person who notices "Web site" beside "Website" is the person looking at the
 * numbers they are spoiling, and a cleanup on another screen is a cleanup
 * nobody opens.
 *
 * The conversion column is the SAME cohort definition the funnel's headline
 * uses, computed from the same read, so a per-source rate can never disagree
 * with the total on the tab next door.
 *
 * `lead.work` is resolved here and passed down as a boolean, and the action
 * checks it again: a server action is a URL and a disabled button is a
 * courtesy, not a permission.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: asked } = await searchParams;
  const period: ReportPeriod = isReportPeriod(asked) ? asked : "quarter";

  const day = await today();
  const config = await getConfig();
  const range = reportRange(day, period);

  const [user, report, everySource] = await Promise.all([
    requireUser(),
    leadSources(range, config["owner.conversionWindowDays"], day),
    allLeadSources(),
  ]);

  return (
    <SourcesScreen workspace={workspace}
      report={report}
      allSources={everySource}
      period={period}
      canWork={await canLead(user, "lead.work")}
    />
  );
}
