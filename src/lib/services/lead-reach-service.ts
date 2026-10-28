import { canOpenModule } from "@/lib/access";
import { assertCustomerInScope } from "@/lib/access-control";
import { inCrmSalesManagerWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { leadsInScope } from "@/lib/services/sales-service";
import { leadRow } from "@/lib/services/lead-service";

type Lead = NonNullable<Awaited<ReturnType<typeof leadRow>>>;

/**
 * ONE REACH RULE for the call, the visit, the history and the list of people a
 * lead can be handed to.
 *
 * The lead has to be in this person's scope — `assertCustomerInScope`, the same
 * question every other write on a lead asks (inside the Sales Manager workspace,
 * the seat-or-owner rule). One carve-out, for the one screen whose scope is not
 * per person: somebody who holds the Sales Manager screen (`sales.lead-pipeline`,
 * granted by name) is judged by the territory narrowing that screen drew the
 * lead with, so a lead they can see there is a lead they can act on. It does not
 * apply to anyone who merely holds the Sales app, and it is not asked in the
 * CRM, where a Telecaller's reach stays her own book.
 *
 * Throws where `assertCustomerInScope` does — a lead the caller may not see must
 * not be described back to them.
 */
export async function reachLead(lead: Lead, userId: string): Promise<void> {
  try {
    await assertCustomerInScope({
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
      salesManagerId: lead.salesManagerId,
    });
  } catch (e) {
    if (
      !(await inCrmSalesManagerWorkspace()) &&
      (await canOpenModule(userId, "sales.lead-pipeline")) &&
      (await leadsInScope([lead.id])).length > 0
    ) {
      return;
    }
    throw e;
  }
}

/**
 * Which of these leads this person may work — the same rule `reachLead` applies
 * to a single write, asked once for a page of rows so the list can draw Call,
 * Visit and History enabled or disabled. It narrows nothing the list shows: it
 * only decides which buttons are live. An archived lead is never workable.
 */
export async function workableLeadIds(ids: string[], userId: string): Promise<string[]> {
  const out: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const lead = await leadRow(id);
      if (!lead || lead.kind !== "lead" || lead.leadArchived) return;
      try {
        await reachLead(lead, userId);
        out.push(id);
      } catch {
        /* out of reach: the button stays disabled and says why */
      }
    }),
  );
  return out;
}
