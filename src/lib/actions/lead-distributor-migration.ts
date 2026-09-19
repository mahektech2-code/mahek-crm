"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers, leadStageTransitions } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { ladderFor, isTerminal } from "@/lib/engines/lead-ladder";
import { salesTypeLabel, stageLabel, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";
import { today } from "@/lib/recompute";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { leadRow } from "@/lib/services/lead-service";
import { writeTimelineEvent, MBOS_EVENT } from "@/lib/timeline";

/* ---------------------------------------------------------------------------
 * MOVING THE LEADS LEFT BEHIND ON THE DISTRIBUTOR LADDER.
 *
 * Mahek does not appoint distributors through MahekOne, so the ladder was
 * retired for NEW leads — and that deliberately left every lead already on it
 * exactly where it was, stalled behind a two-step approval nobody in the
 * building could give. Untouched they are not history, they are work sitting
 * in a queue that will never move, indistinguishable on every list from a live
 * opportunity.
 *
 * Mahek's instruction is that they are not deleted and not marked lost — both
 * of which destroy a real record to tidy a screen — but MOVED onto the ladder
 * that describes how the account is actually being sold to.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT DECIDES WHO IS ELIGIBLE, in Mahek's own words: "Prospective
 * Distributor is a historical lead TYPE; Distributor means formally APPOINTED
 * by Mahek."
 *
 * So reaching Distributor Approval, or Agreement, or Initial Stock Order on the
 * old ladder does not make a company a distributor. Those are rungs somebody
 * climbed, not a decision Mahek took. The one stage that IS the decision is
 * `active_distributor` — the ladder's own terminal, which means the appointment
 * happened — and a lead standing on it is refused by this action and stays
 * classified as a distributor, because it is one.
 *
 * That distinction is the whole of the migration and it is the half that is
 * easy to get backwards. Converting an appointed distributor into a "direct
 * customer at qualification" would take a company Mahek has signed an agreement
 * with and file it as a shop somebody still has to qualify.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT LANDS is `qualification` by default, and the default is the
 * conservative one on purpose.
 *
 * Qualification is the last rung all three ladders share, so it is the highest
 * point a lead can be put down on the new ladder without asserting something
 * nobody established. Everything above it on the old ladder was about
 * appointing a distributor — a management review, a commercial discussion, a
 * stock commitment — and NONE of that is evidence that this shop has had a
 * sample, agreed a price or promised an order, which is what the rungs above
 * qualification mean on the direct ladder. Landing a lead at Negotiation
 * because it once reached Commercial Discussion would put a conversation on
 * the record that never happened.
 *
 * A manager MAY place it higher, which is the other half of Mahek's answer:
 * where there is a genuine order or documented commercial progress, the rung
 * should reflect it. That is a judgement somebody makes after looking, so it is
 * offered and never assumed — and it demands the same reason the rest of this
 * does.
 * ------------------------------------------------------------------------- */

const schema = z.object({
  customerId: z.string().min(1),
  /**
   * DIRECT or THIRD-PARTY, and the manager picks by the real relationship: do
   * we invoice this account, or does a distributor invoice it and we support
   * the shop? Not derivable from anything on the row — the old ladder never
   * asked the question, because on it the answer was going to be "we invoice
   * them" once the appointment went through.
   */
  to: z.enum(["direct", "third_party"]),
  /**
   * Where it lands on the new ladder. Defaulted by the caller rather than here,
   * so the default is visible on the screen that offers it.
   */
  stage: z.string().min(1),
  reason: z.string().trim().min(1, "Say why, and what it is now.").max(2000),
});

export async function migrateProspectiveDistributor(
  input: z.infer<typeof schema>,
): Promise<Result<null>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return err(
        "Say which kind of sale this is now, where it should land, and why.",
        "validation",
      );
    }
    const { customerId, to, stage, reason } = parsed.data;

    /*
     * A MANAGER'S, and `lead.override` is the right one rather than a new name.
     *
     * This moves a lead across ladders and puts it down on a rung its own gates
     * did not open — which is exactly what that capability already means, and
     * what its audit rows already read as. Inventing a capability would also be
     * inventing a fifth thing somebody has to be granted, and `can()` falls
     * through to "held by everybody" for a name no set carries.
     */
    const ctx = await requireCapability("lead.override");

    const lead = await leadRow(customerId);
    if (!lead) return err("That lead is not on MahekOne.", "not_found");
    /* Seeing it is the ordinary scope question, asked before anything is
       decided so a refusal cannot be used to find out a row exists. */
    await assertCustomerInScope({
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
    });

    const was = lead.leadSalesType as LeadSalesType | null;
    const from = lead.leadStage as LeadStage | null;

    if (was !== "distributor") {
      return err(
        `${lead.name} is not on the distributor ladder, so there is nothing to migrate.`,
        "rule_violation",
      );
    }

    /* The one that must not be migrated. See the header: this stage IS the
       appointment, and a company Mahek has appointed is a distributor. */
    if (from === "active_distributor") {
      return err(
        `${lead.name} is an appointed distributor, not a prospective one. Mahek formally appointed it, so it stays classified as a distributor — this action is for the leads that never got that far.`,
        "rule_violation",
      );
    }

    if (from && isTerminal(from)) {
      return err(
        `${lead.name} is already closed at ${stageLabel(from)}. Reopen it first if it should be worked again.`,
        "rule_violation",
      );
    }

    /* The rung has to exist on the ladder it is moving TO, and must not be a
       terminal one: migrating a lead is putting it back to work, and landing it
       on `customer` or `lost` would be closing it under another name. */
    const ladder = ladderFor(to);
    const target = stage as LeadStage;
    if (!ladder.includes(target) || isTerminal(target)) {
      return err(
        `${stageLabel(target)} is not a rung a ${salesTypeLabel(to)} lead can be put down on.`,
        "validation",
        [{ field: "stage", message: "Pick a rung on the new ladder." }],
      );
    }

    const day = await today();
    const now = new Date();

    await db.transaction(async (tx) => {
      /*
       * THE TRANSITION ROW CARRIES THE OLD SALES TYPE, not the new one.
       *
       * `lead_stage_transitions.sales_type` records which ladder the move
       * happened ON, and this move happened on the distributor ladder — it is
       * the last thing that did. Stamping it with the new type would leave the
       * history reading as though the lead had always been a direct one, which
       * is precisely the fact Mahek asked to be preserved.
       *
       * Append-only, like every row in this table: the old rung is in
       * `from_stage` for ever, and a migration recorded wrongly is corrected by
       * a further transition rather than by an edit.
       */
      await tx.insert(leadStageTransitions).values({
        id: `lst_${randomUUID().slice(0, 12)}`,
        customerId,
        fromStage: from,
        toStage: target,
        salesType: was,
        /* Not `passed` — no gate was asked and none opened. This is a manager
           placing a lead by hand, which is what `overridden` already means. */
        kind: "overridden",
        reasonCode: null,
        note: `Migrated off the retired Prospective Distributor ladder to ${salesTypeLabel(to)}${from ? `, from ${stageLabel(from)}` : ""}. ${reason}`,
        overriddenConditions: [],
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
      });

      await tx
        .update(customers)
        .set({
          leadSalesType: to,
          leadStage: target,
          leadStageSince: day,
          leadLastActivityDate: day,
          updatedAt: now,
        })
        .where(eq(customers.id, customerId));

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.leadStage,
        sourceApp: "crm",
        sourceRecordId: `${customerId}:distributor-migration:${now.toISOString()}`,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `Moved off the Prospective Distributor ladder to ${salesTypeLabel(to)} at ${stageLabel(target)}${from ? ` (was ${stageLabel(from)})` : ""}. ${reason}`,
      });

      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: ctx.user.id,
        action: "lead.distributor.migrate",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        /* Both halves of what it WAS, so the original classification survives
           even if somebody later migrates it again. */
        beforeState: { leadSalesType: was, leadStage: from },
        afterState: { leadSalesType: to, leadStage: target, reason },
      });
    });

    revalidatePath(`/crm/leads/${customerId}`);
    revalidatePath(`/sales/leads/${customerId}`);
    return ok(
      null,
      `Moved to ${salesTypeLabel(to)} at ${stageLabel(target)}. The old ladder and rung are on its history.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
