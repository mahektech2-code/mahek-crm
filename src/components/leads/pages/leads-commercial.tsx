import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead, handoverCandidates } from "@/lib/services/lead-console-service";
import { negotiationDesk } from "@/lib/services/lead-commercial-service";
import { NegotiationScreen } from "@/components/leads/commercial/negotiation-screen";


/**
 * 16 — every lead at `negotiation`, and what is blocking each one.
 *
 * THERE IS NO NEGOTIATION TABLE AND THIS SCREEN DOES NOT ADD ONE. What a
 * negotiation IS, in this product, is a lead standing on a rung with a reason
 * on its newest transition, a credit-days ask against the standard term, and a
 * commitment or the conspicuous absence of one. All four of those already have
 * a home, and a fifth place for them would be the one that drifts.
 *
 * The reason CODES are resolved from configuration rather than from the static
 * lists in `lead-labels.ts`: a manager may reword one, and a stored label stops
 * resolving the moment they do — which is why only the code is ever stored.
 * The map is built here, on the server, because the screen is a client
 * component and `getConfig` is async.
 */
export async function Body({
  workspace,
}: {
  workspace: LeadWorkspace;
}) {
  const day = await today();
  const [user, desk, config, people] = await Promise.all([
    requireUser(),
    negotiationDesk(day),
    getConfig(),
    handoverCandidates(),
  ]);

  const reasonLabels: Record<string, string> = {};
  for (const list of [
    config["leads.prospectReasons"],
    config["leads.sampleReasons"],
    config["leads.lostReasons"],
    config["leads.overrideReasons"],
  ]) {
    for (const option of list ?? []) reasonLabels[option.code] = option.label;
  }

  return (
    <NegotiationScreen workspace={workspace}
      rows={desk.rows}
      total={desk.total}
      stalled={desk.stalled}
      noCommitment={desk.noCommitment}
      day={day}
      standardTermDays={config["bills.defaultCreditDays"]}
      reasonLabels={reasonLabels}
      people={people}
      canWork={await canLead(user, "lead.work")}
    />
  );
}
