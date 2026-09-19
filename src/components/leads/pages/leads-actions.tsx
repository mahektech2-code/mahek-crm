import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead } from "@/lib/services/lead-console-service";
import {
  nextActionOwnerCandidates,
  nextActionsDue,
  nextActionsOverdue,
} from "@/lib/services/lead-actions-service";
import { parkedLeadsDueCount } from "@/lib/services/lead-hold-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { DueScreen } from "@/components/leads/actions/due-screen";


/**
 * §24 — an active lead may not sit with nothing owed by anybody.
 *
 * This is the front of that rule: what falls TODAY, grouped by the person who
 * owes it. The tab beside it is the same read one day earlier and never
 * answered, and the one after that is the rule failing outright — a lead with
 * nothing owed at all.
 *
 * **The day is read here and passed down.** `today()` applies
 * `workingDay.dayBoundaryHour` in Asia/Kolkata, which is the only date this
 * business recognises; a component reading `new Date()` would be reading the
 * browser's zone during a render, which the React Compiler rules forbid for
 * the second reason and this file forbids for the first.
 *
 * The overdue total is fetched for its BADGE and its banner rather than its
 * rows — `limit: 1` costs one row and buys the count, and a tab strip with no
 * number on it is one people stop opening.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  /* The owner filter is a URL parameter, like every other filter in the
     console: "these eleven, nobody has touched them" is a view somebody sends
     to somebody else, and component state makes that unsendable. */
  searchParams: Promise<{ owner?: string }>;
}) {
  const [user, params, day, config] = await Promise.all([
    requireUser(),
    searchParams,
    today(),
    getConfig(),
  ]);

  /* `parked` is fetched for its BADGE alone, the same trade the overdue total
     makes one line up: a parked lead whose day has come is work nobody is
     looking at, and a tab with no number on it is a tab people stop opening.
     It is the DUE count rather than the total, because a team that has parked
     forty leads correctly would otherwise carry a permanent forty. */
  const [due, overdue, parked, candidates, canWork] = await Promise.all([
    nextActionsDue(day, { ownerId: params.owner }),
    nextActionsOverdue(day, { limit: 1 }),
    parkedLeadsDueCount(day),
    nextActionOwnerCandidates(),
    canLead(user, "lead.work"),
  ]);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace}
        counts={{
          [leadHref(workspace, "leads/actions")]: due.total,
          [leadHref(workspace, "leads/actions/overdue")]: overdue.total,
          [leadHref(workspace, "leads/actions/parked")]: parked,
        }}
      />
      <DueScreen workspace={workspace}
        day={day}
        rows={due.rows}
        total={due.total}
        incomplete={due.incomplete}
        owners={due.owners}
        ownerId={params.owner}
        overdueTotal={overdue.total}
        candidates={candidates}
        canWork={canWork}
        requireNextAction={config["leads.requireNextAction"]}
        /* Counted in SQL over the whole window rather than off the rows: the
           list is capped and a banner reading "3 back off hold" computed from
           what happened to be drawn would say three on a morning there were
           forty. */
        parkedBack={due.parkedBack}
        holdReasons={config["leads.holdReasons"]}
      />
    </div>
  );
}
