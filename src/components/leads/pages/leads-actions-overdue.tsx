import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead } from "@/lib/services/lead-console-service";
import {
  nextActionOwnerCandidates,
  nextActionsDue,
  nextActionsOverdue,
  overdueAnsweredCount,
} from "@/lib/services/lead-actions-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { OverdueScreen } from "@/components/leads/actions/overdue-screen";


/**
 * The same read as the Due tab, one day earlier and never answered.
 *
 * It is a route of its own rather than a filter on the one beside it because
 * the two are different jobs: due today is a morning's work and this is a
 * manager's exception list, and a screen that is both is one where the second
 * is a chip nobody clicks.
 *
 * `overdueAnsweredCount` is fetched beside the rows and is not on them. It is
 * what lets an empty table say which kind of empty it is — a team closing these
 * and a team that has never promised anybody anything both draw no rows, and
 * only one of those is the rule working.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ owner?: string }>;
}) {
  const [user, params, day, config] = await Promise.all([
    requireUser(),
    searchParams,
    today(),
    getConfig(),
  ]);

  const [overdue, due, answered, candidates, canWork] = await Promise.all([
    nextActionsOverdue(day, { ownerId: params.owner }),
    nextActionsDue(day, { limit: 1 }),
    overdueAnsweredCount(day),
    nextActionOwnerCandidates(),
    canLead(user, "lead.work"),
  ]);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace}
        counts={{
          [leadHref(workspace, "leads/actions")]: due.total,
          [leadHref(workspace, "leads/actions/overdue")]: overdue.total,
        }}
      />
      <OverdueScreen workspace={workspace}
        day={day}
        rows={overdue.rows}
        total={overdue.total}
        incomplete={overdue.incomplete}
        owners={overdue.owners}
        ownerId={params.owner}
        answered={answered}
        candidates={candidates}
        canWork={canWork}
        requireNextAction={config["leads.requireNextAction"]}
      />
    </div>
  );
}
