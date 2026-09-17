import { getConfig } from "@/lib/config/store";
import { overrideLog } from "@/lib/services/lead-oversight-service";
import { LeadTabs } from "../lead-tabs";
import { OverridesScreen } from "./overrides-screen";

export const metadata = { title: "Override log — Sales Dashboard — MahekOne" };

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
export default async function Page() {
  const [log, config] = await Promise.all([overrideLog(), getConfig()]);

  return (
    <>
      <LeadTabs />
      <OverridesScreen
        rows={log.rows}
        counts={log.counts}
        total={log.total}
        reasons={config["leads.overrideReasons"]}
        overrideAllowed={config["leads.allowManagerOverride"]}
      />
    </>
  );
}
