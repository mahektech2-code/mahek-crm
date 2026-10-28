import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, leadTrashEvents, mbosTasks } from "@/db/schema";
import { leadsLeftHandsets } from "./lead-trash-sync";
import { TRASHED_TASK_NOTE } from "./lead-trash-service";

/* ---------------------------------------------------------------------------
 * A LEAD WHO SHARES A CUSTOMER'S NAME IS THAT CUSTOMER'S PAST.
 *
 * A customer only ever comes from a lead, so a lead and a customer carrying
 * one name are one shop written down twice — and the lead half is the one
 * doing harm: it sits on the calling list and the field's funnel asking for a
 * first order from a shop we already bill. The order sheet made most of them,
 * by creating a fresh customer beside a lead it had no way to recognise;
 * `projectCustomers` now adopts the lead instead, and this clears what it left
 * behind.
 *
 * The twin goes to the LEAD TRASH, never away. MahekOne cannot merge two
 * `customers` rows, so the lead keeps its visits, calls and notes exactly where
 * they are, the reason names the customer it duplicates, and an administrator
 * can restore it from Admin Console → Trash if a match turns out to be two
 * shops that happen to share a name.
 *
 * "Same name" is the fold every sheet path already uses — case and spacing,
 * nothing looser. A lead that carries ORDERS of its own is reported and left:
 * that is billed history on the lead's side of the pair, and the trash would
 * hide it from every screen; that one is a person's to reconcile.
 *
 * BY HAND, NEVER SCHEDULED: run `--dry-run` first and read the list.
 * ------------------------------------------------------------------------- */

export type LeadTwin = {
  leadId: string;
  leadName: string;
  leadCity: string;
  customerId: string;
  customerName: string;
  customerCity: string;
  /** Orders on the LEAD's row. Non-zero is left for a person. */
  leadOrders: number;
};

export type LeadTwinReport = {
  dryRun: boolean;
  /** Every pair found, including the ones left alone. */
  twins: LeadTwin[];
  /** Moved to the trash (zero on a dry run). */
  trashed: number;
  /** Twins carrying orders of their own, left where they are. */
  keptWithOrders: LeadTwin[];
};

const SYSTEM_NAME = "MahekOne — already a customer";

const reasonOf = (t: LeadTwin) =>
  `Already a customer: ${t.customerName}${t.customerCity ? `, ${t.customerCity}` : ""} (${t.customerId})`;

export async function findLeadTwins(): Promise<LeadTwin[]> {
  const rows = await db.execute(sql`
    with folded as (
      select c.id, c.name, c.city, c.kind, c.created_at,
             upper(btrim(regexp_replace(c.name, '\\s+', ' ', 'g'))) as key
        from customers c
       where c.deleted_at is null
    ),
    cust as (
      select distinct on (f.key) f.key, f.id, f.name, f.city
        from folded f
       where f.kind = 'customer'
       order by f.key, f.created_at asc
    )
    select l.id as "leadId", l.name as "leadName", l.city as "leadCity",
           cust.id as "customerId", cust.name as "customerName", cust.city as "customerCity",
           (select count(*)::int from orders o where o.customer_id = l.id) as "leadOrders"
      from folded l
      join cust on cust.key = l.key
     where l.kind = 'lead'
     order by l.name asc
  `);
  return (rows as unknown as LeadTwin[]).map((r) => ({ ...r, leadOrders: Number(r.leadOrders) }));
}

export async function trashLeadTwins({ dryRun = false }: { dryRun?: boolean } = {}): Promise<LeadTwinReport> {
  const twins = await findLeadTwins();
  const keptWithOrders = twins.filter((t) => t.leadOrders > 0);
  const moving = twins.filter((t) => t.leadOrders === 0);
  if (dryRun || !moving.length) return { dryRun, twins, trashed: 0, keptWithOrders };

  let trashed = 0;
  for (let i = 0; i < moving.length; i += 200) {
    const batch = moving.slice(i, i + 200);
    await db.transaction(async (tx) => {
      const now = new Date();
      const moved: LeadTwin[] = [];
      // Guarded on still being a live lead, so a re-run trashes nothing twice.
      for (const t of batch) {
        const done = await tx
          .update(customers)
          .set({ deletedAt: now, deletedById: null, deletedByName: SYSTEM_NAME, deletedReason: reasonOf(t), updatedAt: now })
          .where(and(eq(customers.id, t.leadId), eq(customers.kind, "lead"), isNull(customers.deletedAt)))
          .returning({ id: customers.id });
        if (done.length) moved.push(t);
      }
      if (!moved.length) return;
      await tx.insert(leadTrashEvents).values(
        moved.map((t) => ({
          id: `ltr_${randomUUID().slice(0, 12)}`,
          customerId: t.leadId,
          action: "trashed",
          reason: reasonOf(t),
          actorId: null,
          actorName: SYSTEM_NAME,
          createdAt: now,
        })),
      );
      await tx.insert(auditLog).values(
        moved.map((t) => ({
          id: `aud_${randomUUID().slice(0, 12)}`,
          actorId: null,
          action: "lead.trashed",
          entityType: "customer",
          entityId: t.leadId,
          beforeState: { name: t.leadName, city: t.leadCity } as never,
          afterState: { reason: reasonOf(t), twinOf: t.customerId } as never,
        })),
      );
      // Off the salesmen's phones too — on the next pull, not the next sign-in.
      await leadsLeftHandsets(tx, moved.map((t) => t.leadId));
      // And off their task lists, exactly as `trashLeads` does, so a restore reopens them.
      await tx
        .update(mbosTasks)
        .set({ status: "cancelled", completionNote: TRASHED_TASK_NOTE, completedAt: now, updatedAt: now })
        .where(and(inArray(mbosTasks.customerId, moved.map((t) => t.leadId)), inArray(mbosTasks.status, ["open", "in_progress"])));
      trashed += moved.length;
    });
  }
  return { dryRun, twins, trashed, keptWithOrders };
}
