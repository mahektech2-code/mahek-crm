"use server";

import { assertLeadInScope } from "@/lib/services/lead-scope";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers, users } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { requireCapability } from "@/lib/access-control";
import { notifyUser } from "@/lib/notify";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { leadRow } from "@/lib/services/lead-service";
import { DESK_MODULE, deskHolders } from "@/lib/services/lead-desk-assignment-service";
import { LEAD_BULK_CAP } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * GIVING A LEAD TO A TELECALLER — and moving it to another.
 *
 * The owner IS the assignment: `ASSIGNED_TO_SQL` resolves a lead through
 * `owner_id`, so this one write is what puts the lead on the person's calling
 * desk and in every scoped list — there is no second table and nothing else to
 * keep in step.
 *
 * THIS IS THE REASSIGN. There used to be a second one on the leads list
 * (`reassignLead`, in the Sales Dashboard's actions) that only accepted a
 * person holding the FIELD app — a salesman's handset. In a workflow whose
 * owner is the Telecaller that picker offered nobody who could work the lead
 * and would have put it on a phone the Telecaller does not have, so the record,
 * the list and the pipeline all reassign through here instead.
 *
 * WHAT A REASSIGNMENT CHANGES is `owner_id`, and one thing that follows from it:
 * a next action that was OWED BY THE OLD OWNER moves to the new one. A
 * Telecaller's "Complete the qualification" that stayed with the person the lead
 * was taken from would be a promise to nobody. A next action owed by anybody
 * else — above all the Sales Manager's "verification call" or "Review
 * qualification" — is left exactly where it is: the manager's job does not
 * become the Telecaller's because the lead changed hands, which is the failure
 * the workflow exists to prevent.
 *
 * WHAT IT NEVER CHANGES is who raised the lead. There is no created-by column to
 * touch: the creator is the actor on the append-only `lead_created` timeline
 * event, and a reassignment adds a row to that history rather than editing it.
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
  ownerId: z.string().min(1, "Pick who it goes to.").nullable(),
});

type Actor = Awaited<ReturnType<typeof requireCapability>>;

type AssignResult =
  | { ok: true; changed: boolean; leadName: string }
  | { ok: false; error: string; code: "not_found" | "rule_violation"; leadName?: string };

/**
 * One reassignment, with every check and every write — shared by the single and
 * the bulk door so they cannot come apart.
 *
 * Throws only where `assertCustomerInScope` does, which is the scope answer and
 * is not caught here: a lead the actor may not see must not be named back to
 * them.
 */
/** `null` is UNASSIGNED: the lead goes back to the pool nobody's desk holds. */
type Target = { id: string; name: string } | null;

async function assignOne(
  ctx: Actor,
  customerId: string,
  target: Target,
): Promise<AssignResult> {
  const lead = await leadRow(customerId);
  if (!lead || lead.leadStage === null) {
    return { ok: false, code: "not_found", error: "That lead is not on MahekOne." };
  }
  if (lead.leadArchived) {
    return {
      ok: false,
      code: "rule_violation",
      error: "That lead is archived. Restore it before assigning it.",
      leadName: lead.name,
    };
  }

  if (lead.ownerId) {
    await assertLeadInScope(customerId, {
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
    });
  }
  if ((lead.ownerId ?? null) === (target?.id ?? null)) return { ok: true, changed: false, leadName: lead.name };

  /* A next action owed by the old owner follows the lead; one owed by anybody
     else — the manager's verification, the manager's review — stays with them.
     Matched on the OWNER column, not on the words, so a next action a person
     typed by hand follows the same rule as one the workflow wrote. */
  const followsOwner = Boolean(lead.ownerId) && lead.leadNextActionOwnerId === lead.ownerId;

  const previous = lead.ownerId
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, lead.ownerId)).limit(1))[0]
    : undefined;

  await db.transaction(async (tx) => {
    await tx
      .update(customers)
      .set({
        ownerId: target?.id ?? null,
        ...(followsOwner ? { leadNextActionOwnerId: target?.id ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, lead.id));
    await writeTimelineEvent(tx, {
      customerId: lead.id,
      eventType: MBOS_EVENT.ownerChange,
      sourceApp: "crm",
      sourceRecordId: `${lead.id}:desk:${randomUUID().slice(0, 8)}`,
      occurredAt: new Date(),
      actorUserId: ctx.user.id,
      summary: !target
        ? `Unassigned${previous ? ` from ${previous.name}` : ""}`
        : previous
          ? `Reassigned from ${previous.name} to ${target.name}`
          : `Assigned to ${target.name} on the calling desk`,
    });
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: ctx.user.id,
      action: !target ? "lead.unassigned" : lead.ownerId ? "lead.reassigned" : "lead.deskAssigned",
      entityType: "customer",
      entityId: lead.id,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      beforeState: {
        ownerId: lead.ownerId ?? null,
        nextActionOwnerId: lead.leadNextActionOwnerId ?? null,
      },
      afterState: {
        ownerId: target?.id ?? null,
        nextActionOwnerId: followsOwner ? (target?.id ?? null) : (lead.leadNextActionOwnerId ?? null),
        nextActionFollowed: followsOwner,
      },
    });
  });

  /* The new owner is told, and the old one — a lead that leaves a book silently
     reads as a bug in the list. Never able to fail the assignment. */
  if (target && target.id !== ctx.user.id) {
    await notifyUser({
      userId: target.id,
      title: `A lead was assigned to you: ${lead.name}`,
      body: `${ctx.user.name} put it on your calling desk.`,
      kind: "info",
      href: `/crm/leads/calling-desk/${lead.id}`,
    }).catch(() => {});
  }
  if (lead.ownerId && lead.ownerId !== ctx.user.id && lead.ownerId !== (target?.id ?? null)) {
    await notifyUser({
      userId: lead.ownerId,
      title: `${lead.name} was moved`,
      body: target
        ? `${ctx.user.name} reassigned it to ${target.name}.`
        : `${ctx.user.name} took it off your desk. It is unassigned for now.`,
      kind: "info",
    }).catch(() => {});
  }

  return { ok: true, changed: true, leadName: lead.name };
}

function refresh(customerId?: string) {
  try {
    revalidatePath("/crm/leads/calling-desk");
    revalidatePath("/crm/leads");
    revalidatePath("/sales/leads");
    if (customerId) {
      revalidatePath(`/crm/leads/calling-desk/${customerId}`);
      revalidatePath(`/crm/leads/${customerId}`);
      revalidatePath(`/sales/leads/${customerId}`);
    }
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

async function requireAssigner(): Promise<{ ctx: Actor } | { refusal: ReturnType<typeof err> }> {
  const ctx = await requireCapability("lead.verify");
  if (!(await canOpenModule(ctx.user.id, DESK_MODULE))) {
    return { refusal: err("You have not been given the Calling desk. Ask whoever manages access to grant it.", "not_permitted") };
  }
  return { ctx };
}

async function desk(ownerId: string) {
  return (await deskHolders()).find((h) => h.id === ownerId) ?? null;
}

const NOT_ON_A_DESK =
  "That person cannot open the Calling desk, so a lead given to them would not be on any desk they can see. Grant it on the Access screen first.";

export async function assignDeskLead(
  input: z.input<typeof schema>,
): Promise<Result<{ ownerName: string }>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Pick who it goes to.", "validation");
    const p = parsed.data;

    const gate = await requireAssigner();
    if ("refusal" in gate) return gate.refusal;

    /* `null` is Unassigned and needs no desk; anybody else must hold one. */
    const target = p.ownerId === null ? null : await desk(p.ownerId);
    if (p.ownerId !== null && !target) {
      return err(NOT_ON_A_DESK, "rule_violation", [{ field: "ownerId", message: "Does not hold the Calling desk." }]);
    }

    const done = await assignOne(gate.ctx, p.customerId, target);
    if (!done.ok) return err(done.error, done.code);
    if (!done.changed) {
      return ok({ ownerName: target?.name ?? "Unassigned" }, target ? `Already ${target.name}'s.` : "Already unassigned.");
    }

    refresh(p.customerId);
    return ok(
      { ownerName: target?.name ?? "Unassigned" },
      target ? `Assigned to ${target.name}.` : "Unassigned — it is on nobody's desk until somebody is given it.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

const bulkSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, "Nothing selected."),
  ownerId: z.string().min(1, "Pick who they go to.").nullable(),
});

/**
 * Change the owner of a selection — the same act as {@link assignDeskLead}, once
 * per lead, sequentially, so a batch cannot come out different from doing them
 * one at a time. What did not move comes back NAMED with the reason, so exactly
 * those leads can stay ticked.
 */
export async function bulkAssignDeskLeads(
  input: z.input<typeof bulkSchema>,
): Promise<Result<{ done: number; failed: Array<{ id: string; name: string; why: string }> }>> {
  try {
    const parsed = bulkSchema.safeParse(input);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Nothing selected.", "validation");

    const gate = await requireAssigner();
    if ("refusal" in gate) return gate.refusal;

    const target = parsed.data.ownerId === null ? null : await desk(parsed.data.ownerId);
    if (parsed.data.ownerId !== null && !target) {
      return err(NOT_ON_A_DESK, "rule_violation", [{ field: "ownerId", message: "Does not hold the Calling desk." }]);
    }

    const ids = Array.from(new Set(parsed.data.leadIds)).slice(0, LEAD_BULK_CAP);
    let done = 0;
    const failed: Array<{ id: string; name: string; why: string }> = [];
    for (const id of ids) {
      try {
        const r = await assignOne(gate.ctx, id, target);
        if (!r.ok) failed.push({ id, name: r.leadName ?? "A lead", why: r.error });
        else if (!r.changed) failed.push({ id, name: r.leadName, why: target ? "already theirs" : "already unassigned" });
        else done += 1;
      } catch {
        /* Out of scope: refused without being named — a lead the caller may not
           see is not described back to them. */
        failed.push({ id, name: "A lead", why: "not in your book" });
      }
    }

    refresh();
    const head = target
      ? `${done} ${done === 1 ? "lead" : "leads"} now ${target.name}'s.`
      : `${done} ${done === 1 ? "lead" : "leads"} now unassigned.`;
    return ok(
      { done, failed },
      failed.length
        ? `${head} ${failed.length} did not move: ${failed
            .slice(0, 3)
            .map((f) => `${f.name} — ${f.why}`)
            .join("; ")}`
        : head,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
