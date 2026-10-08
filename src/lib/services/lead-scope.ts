import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assertCustomerInScope } from "@/lib/access-control";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * MAY THIS PERSON WORK THIS LEAD — asked the way the lead LISTS ask it.
 *
 * Every lead list, board, count and record page decides what to draw with
 * `leadsVisible(managerScope())`. Every lead action decided whether to act with
 * `assertCustomerInScope`, which reads the CRM's scope instead — your own book
 * and your direct reports. The two are different questions with different
 * answers, and a manager with no territory is national on the first and team on
 * the second: the lead was on their screen, the record opened, and moving its
 * stage was refused with "customer.read requires the associate level of an app
 * you hold" — a sentence about levels for what was a disagreement about scope.
 *
 * So an action now asks the list's question first: if the lead is on your lead
 * list, you may work it, because that is what being on your list means. Where
 * it is not, the old check still answers — it is a separate route in (the
 * calling desk's seats, a handover, a CRM owner), and none of those may be
 * lost. This can only WIDEN what an action allows to what the screen already
 * showed; it never narrows, and it never passes a lead in the trash, which
 * `leadsVisible` itself leaves out. The capability (`lead.work` and the rest)
 * is still asked by every caller before this.
 * ------------------------------------------------------------------------- */

type LeadSeats = Parameters<typeof assertCustomerInScope>[0];

/** True when the lead is on the signed-in person's lead lists. */
export async function leadOnMyList(customerId: string): Promise<boolean> {
  const scope = await managerScope();
  const rows = await db.execute<{ one: number }>(sql`
    select 1 as one from customers c
     where c.id = ${customerId}
       ${leadsVisible(scope)}
     limit 1
  `);
  return rows.length > 0;
}

/**
 * The lead actions' scope check. Throws exactly what `assertCustomerInScope`
 * throws when the lead is neither on the person's list nor reachable through
 * any seat that function names.
 */
export async function assertLeadInScope(customerId: string, lead: LeadSeats): Promise<void> {
  if (lead && !lead.deletedAt && (await leadOnMyList(customerId))) return;
  await assertCustomerInScope(lead);
}
