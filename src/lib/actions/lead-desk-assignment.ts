"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { notifyUser } from "@/lib/notify";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { leadRow } from "@/lib/services/lead-service";
import { DESK_MODULE, deskHolders } from "@/lib/services/lead-desk-assignment-service";

/* ---------------------------------------------------------------------------
 * GIVING A LEAD TO A TELECALLER.
 *
 * The owner IS the assignment: `ASSIGNED_TO_SQL` resolves a lead through
 * `owner_id`, so this one write is what puts the lead on the person's calling
 * desk and in every scoped list — there is no second table and nothing else to
 * keep in step.
 *
 * `lead.verify` because handing work out is the manager's judgement, the same
 * capability that sets a lead's priority; an administrator holds it by
 * construction. The receiving person has to hold the desk (asked with the same
 * module check as every other door), because a lead handed to somebody who
 * cannot open the screen would vanish into a book they cannot read — the
 * failure this action exists to prevent.
 *
 * An UNOWNED lead is nobody's, so anybody who may assign may pick it up. One
 * that already has an owner is somebody's book and is checked against scope
 * like every other write on it.
 * ------------------------------------------------------------------------- */
const schema = z.object({
  customerId: z.string().min(1),
  ownerId: z.string().min(1, "Pick who it goes to."),
});

export async function assignDeskLead(
  input: z.input<typeof schema>,
): Promise<Result<{ ownerName: string }>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Pick who it goes to.", "validation");
    const p = parsed.data;

    const ctx = await requireCapability("lead.verify");
    if (!(await canOpenModule(ctx.user.id, DESK_MODULE))) {
      return err("You have not been given the Calling desk.", "not_permitted");
    }

    const lead = await leadRow(p.customerId);
    if (!lead || lead.leadStage === null) return err("That lead is not on MahekOne.", "not_found");
    if (lead.leadArchived) return err("That lead is archived. Restore it before assigning it.", "rule_violation");

    if (lead.ownerId) {
      await assertCustomerInScope({
        kind: lead.kind,
        ownerId: lead.ownerId,
        salesAmId: lead.salesAmId,
        backOfficeAmId: lead.backOfficeAmId,
        leadManagerId: lead.leadManagerId,
      });
    }

    const holders = await deskHolders();
    const target = holders.find((h) => h.id === p.ownerId);
    if (!target) {
      return err(
        "That person cannot open the Calling desk, so a lead given to them would not be on any desk they can see. Grant it on the Access screen first.",
        "rule_violation",
        [{ field: "ownerId", message: "Does not hold the Calling desk." }],
      );
    }
    if (lead.ownerId === target.id) return ok({ ownerName: target.name }, `Already ${target.name}'s.`);

    await db.transaction(async (tx) => {
      await tx.update(customers).set({ ownerId: target.id, updatedAt: new Date() }).where(eq(customers.id, lead.id));
      await writeTimelineEvent(tx, {
        customerId: lead.id,
        eventType: MBOS_EVENT.ownerChange,
        sourceApp: "crm",
        sourceRecordId: `${lead.id}:desk:${randomUUID().slice(0, 8)}`,
        occurredAt: new Date(),
        actorUserId: ctx.user.id,
        summary: `Assigned to ${target.name} on the calling desk`,
      });
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: ctx.user.id,
        action: "lead.deskAssigned",
        entityType: "customer",
        entityId: lead.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { ownerId: lead.ownerId ?? null },
        afterState: { ownerId: target.id },
      });
    });

    /* The person it lands on is told — work has arrived without their asking —
       unless they gave it to themselves. Never able to fail the assignment. */
    if (target.id !== ctx.user.id) {
      await notifyUser({
        userId: target.id,
        title: `A lead was assigned to you: ${lead.name}`,
        body: `${ctx.user.name} put it on your calling desk.`,
        kind: "info",
        href: `/crm/leads/calling-desk/${lead.id}`,
      }).catch(() => {});
    }

    try {
      revalidatePath("/crm/leads/calling-desk");
      revalidatePath(`/crm/leads/calling-desk/${lead.id}`);
    } catch {
      /* no request context */
    }
    return ok({ ownerName: target.name }, `Assigned to ${target.name}.`);
  } catch (e) {
    return fromThrown(e);
  }
}
