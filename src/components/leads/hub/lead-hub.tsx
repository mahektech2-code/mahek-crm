import { requireUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";
import { today } from "@/lib/recompute";
import { hubFor, type HubCountKey } from "@/lib/lead-hub";
import { leadSidebarCounts } from "@/lib/services/lead-sidebar-service";
import { verificationQueue } from "@/lib/services/lead-console-service";
import { qualificationDesk } from "@/lib/services/lead-qualify-service";
import { commitments, negotiationDesk } from "@/lib/services/lead-commercial-service";
import { sampleDeskCounts } from "@/lib/services/sample-service";
import { LeadHubFrame } from "./lead-hub-frame";

/**
 * The CRM's Leads frame, around every lead screen and every sample screen.
 *
 * It decides nothing about access — each module folder below still carries
 * its own guard — it only draws the doors this person holds, with the counts
 * those doors open onto. Every count is the same function the screen behind
 * it reads, so the badge and the list cannot disagree.
 */
export async function LeadHub({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [day, modules] = await Promise.all([today(), listUserModules(user.id, "crm")]);
  const held = new Set(modules.map((m) => m.key));
  const areas = hubFor(held);

  const has = (k: string) => held.has(k);
  const none = Promise.resolve(null);
  const [sidebar, verify, checklists, samples, negotiation, slipped] = await Promise.all([
    has("crm.leads") || has("crm.lead-actions") ? leadSidebarCounts(day) : none,
    has("crm.lead-qualify") ? verificationQueue(day, { limit: 0 }) : none,
    has("crm.lead-qualify") ? qualificationDesk(day, { limit: 0 }) : none,
    has("crm.samples") ? sampleDeskCounts() : none,
    has("crm.lead-commercial") ? negotiationDesk(day, { limit: 0 }) : none,
    has("crm.lead-commercial") ? commitments(day, "slipped", { limit: 0 }) : none,
  ]);

  const counts: Partial<Record<HubCountKey, number>> = {};
  if (sidebar) {
    counts.dueToday = sidebar.dueToday;
    counts.overdue = sidebar.overdue;
    counts.attention = sidebar.overdue + sidebar.dueToday;
  }
  if (verify) counts.verify = verify.total;
  if (checklists) counts.checklists = checklists.total;
  if (samples) counts.trials = samples.awaitingReview;
  if (negotiation) counts.negotiation = negotiation.total;
  if (slipped) counts.slipped = slipped.counts.slipped;

  return (
    <LeadHubFrame
      areas={areas}
      counts={counts}
      overdue={sidebar?.overdue ?? 0}
      canSearch={held.has("crm.leads")}
      canAdd={held.has("crm.lead-intake")}
    >
      {children}
    </LeadHubFrame>
  );
}
