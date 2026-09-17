import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead } from "@/lib/services/lead-console-service";
import { overriddenMoves, qualificationDesk } from "@/lib/services/lead-qualify-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { ChecklistScreen } from "@/components/leads/qualify/checklist/checklist-screen";


/**
 * §28 — the screen a manager has never had.
 *
 * Every lead at Qualification with its checklist state, and on the Blocked view
 * what each one is stuck behind IN WORDS. That list comes from `checklistFor`
 * and `gateForNext`, the same two functions the handset draws its disabled next
 * rung from and the same two `advanceLeadStage` refuses on. A refusal that does
 * not say what it wants teaches a salesman to press the button again rather
 * than to do the work — and a second copy of the conditions typed into a screen
 * would drift inside one release, with the screen the half somebody is reading.
 *
 * FOUR VIEWS, ONE READ. In qualification, Blocked, Ready to advance and
 * Overridden are filters over `qualificationDesk()` — except the last, which is
 * a read over `lead_stage_transitions` rather than over the desk, because an
 * override is most worth seeing on a lead that has since moved on. That is the
 * one nobody would otherwise go back and look at.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const chosen =
    view === "blocked" || view === "ready" || view === "overridden" ? view : "all";

  const day = await today();
  const [user, desk, overrides, config] = await Promise.all([
    requireUser(),
    qualificationDesk(day),
    overriddenMoves(day),
    getConfig(),
  ]);

  const [canWork, canOverride] = await Promise.all([
    canLead(user, "lead.work"),
    canLead(user, "lead.override"),
  ]);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />
      <ChecklistScreen workspace={workspace}
        rows={desk.rows}
        total={desk.total}
        capped={desk.capped}
        overrides={overrides.rows}
        overrideTotal={overrides.total}
        byCondition={overrides.byCondition}
        overrideDays={overrides.days}
        view={chosen}
        overrideOffered={config["leads.allowManagerOverride"]}
        overrideReasons={config["leads.overrideReasons"]}
        canWork={canWork}
        canOverride={canOverride}
      />
    </div>
  );
}
