import { type LeadWorkspace } from "@/lib/lead-workspace";
import { getConfig } from "@/lib/config/store";
import { overrideLog } from "@/lib/services/lead-oversight-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { OverridesScreen } from "@/components/leads/oversight/overrides-screen";


/**
 * §28 read backwards: every shut gate somebody passed.
 *
 * The module layout is the guard — `sales.lead-oversight`, checked on the
 * route rather than by not drawing a link, because a link that is not drawn is
 * a statement to the browser and the browser is not where authority lives.
 * There is no capability check here and no control to gate: this screen writes
 * nothing, and `lead.override` is what the ACT costs, enforced in the action
 * that performs it.
 *
 * The reason words come from configuration and the condition words come from
 * the gate engine, and neither is typed into the screen. A manager rewords a
 * reason without a deploy, and a stored label would stop resolving the moment
 * they did — which is the whole argument for storing the code.
 */
export async function Body({
  workspace,
}: {
  workspace: LeadWorkspace;
}) {
  const [log, config] = await Promise.all([overrideLog(), getConfig()]);

  return (
    <>
      <LeadTabs workspace={workspace} />
      <OverridesScreen workspace={workspace}
        rows={log.rows}
        counts={log.counts}
        total={log.total}
        reasons={config["leads.overrideReasons"]}
        overrideAllowed={config["leads.allowManagerOverride"]}
      />
    </>
  );
}
