import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead } from "@/lib/services/lead-console-service";
import { suspectDecisions } from "@/lib/services/lead-qualify-service";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { SuspectsScreen } from "@/components/leads/qualify/suspects-screen";


/**
 * §4 — the visit cap, as a worklist.
 *
 * **The cap ASKS; it never refuses.** That is the whole shape of §4 and this
 * screen must not invent a block: a salesman whose visit is refused stops
 * recording visits, and the company loses the GPS, the competitor note and the
 * reason in order to stop a number reaching four. What §4 actually wants is
 * that nobody keeps visiting a shop nobody has decided about, and that is
 * bought by demanding an ANSWER — which is what this screen is for.
 *
 * The two thresholds are configuration and are read here rather than typed into
 * the screen, because a manager changing "warn after two visits" to three must
 * not need a deploy — and because the handset is asking the salesman the same
 * question off the same two numbers.
 *
 * The reason lists come from configuration for a harder reason than tidiness:
 * `evaluateLeadStageMove` validates a submitted code against
 * `leads.prospectReasons` and `leads.lostReasons`, so a screen offering the
 * `PROSPECT_REASONS` constant directly would offer codes the action refuses the
 * day somebody curates the list. The constants are those settings' defaults,
 * which is why the two agree out of the box.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ band?: string }>;
}) {
  const { band } = await searchParams;

  const day = await today();
  const [user, decisions, config] = await Promise.all([
    requireUser(),
    suspectDecisions(day),
    getConfig(),
  ]);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />
      <SuspectsScreen workspace={workspace}
        rows={decisions.rows}
        total={decisions.total}
        warnAt={decisions.warnAt}
        decideAt={decisions.decideAt}
        band={band === "warned" || band === "must" || band === "past" ? band : "all"}
        prospectReasons={config["leads.prospectReasons"]}
        lostReasons={config["leads.lostReasons"]}
        canWork={await canLead(user, "lead.work")}
      />
    </div>
  );
}
