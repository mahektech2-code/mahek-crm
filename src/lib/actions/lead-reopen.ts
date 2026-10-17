"use server";

import { assertLeadInScope } from "@/lib/services/lead-scope";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireCapability } from "@/lib/access-control";
import { addDays } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { reopenTarget } from "@/lib/engines/lead-reopen";
import { stageLabel, type LeadSalesType } from "@/lib/lead-labels";
import { today } from "@/lib/recompute";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { leadRow } from "@/lib/services/lead-service";
import { lostFromOf, reopenLostLead } from "@/lib/services/lead-reopen-service";

/* ---------------------------------------------------------------------------
 * REVERSE A LOST LEAD — the Sales Manager's door.
 *
 * It is not in `sales-manager-pipeline.ts`, and that is deliberate: that file is
 * held to "thin orchestrations that add no permission of their own"
 * (`sales-manager-pipeline-guards.test.ts`), and this door DOES ask its own
 * question. What it asks is the Sales Manager's: `lead.verify`, not `lead.work`
 * — every associate holds the second, so keying on it would let anybody who can
 * read the Lost list reverse a loss — plus the lead being in this person's
 * scope, named for every seat on the record exactly as `advanceLeadStage` names
 * them.
 *
 * WHAT REOPENING MEANS is not decided here. It is `reopenLostLead`, the one
 * implementation the Telecaller's door (`reopenDeskLead`) calls as well, so the
 * two seats cannot come to hold two different ideas of it.
 *
 * Reversing a lead lost on a failed verification returns it to Prospect with
 * the verification state reset; it is NOT treated as already verified.
 * ------------------------------------------------------------------------- */

const reopenSchema = z.object({
  customerId: z.string().min(1),
  /** One of `leads.reopenReasons`, validated against configuration by the service. */
  reasonCode: z.string().trim().min(1, "Why is it being reopened?").max(60),
  note: z.string().trim().max(1000).optional(),
  /** Optional: defaults to the rung's own next action (a fresh verification call at Prospect). */
  nextAction: z
    .object({
      action: z.string().trim().min(1).max(300),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day as a date."),
    })
    .optional(),
});

export async function reopenSalesManagerLead(
  input: z.input<typeof reopenSchema>,
): Promise<Result<null>> {
  try {
    const parsed = reopenSchema.safeParse(input);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? "Pick why it is being reopened.", "validation");
    }
    const p = parsed.data;

    const ctx = await requireCapability("lead.verify");
    const lead = await leadRow(p.customerId);
    if (!lead) return err("That lead is not on MahekOne.", "not_found");
    await assertLeadInScope(p.customerId, {
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
      salesManagerId: lead.salesManagerId,
    });
    if (lead.leadStage !== "lost") {
      return err("This lead is not Lost, so there is nothing to reverse.", "rule_violation");
    }

    const [config, day] = await Promise.all([getConfig(), today()]);
    const target = reopenTarget({
      lostFrom: await lostFromOf(p.customerId),
      salesType: lead.leadSalesType as LeadSalesType | null,
      lostReason: lead.leadLostReason,
    });
    const verifying = target.basis === "verification_failed";

    const moved = await reopenLostLead({
      actor: { userId: ctx.user.id, hat: { app: ctx.authorisedIn, role: ctx.authorisedBy }, sourceApp: "crm" },
      customerId: p.customerId,
      reasonCode: p.reasonCode,
      note: p.note,
      nextAction: p.nextAction
        ? { ...p.nextAction, ownerId: lead.leadManagerId ?? lead.ownerId ?? ctx.user.id }
        : verifying
          ? {
              action: "Manager verification call",
              date: addDays(day, config["leads.verificationDueDays"]),
              ownerId: lead.leadManagerId ?? ctx.user.id,
              outcome: "Verify again — the earlier verification failed",
            }
          : {
              action: `Carry on from ${stageLabel(target.stage)} — lead reopened`,
              date: addDays(day, 2),
              ownerId: lead.ownerId ?? lead.leadManagerId ?? ctx.user.id,
              outcome: null,
            },
      day,
      seat: "sales_manager",
    });

    try {
      for (const path of ["/sales-lead-pipeline", "/crm/leads/sales-manager", "/crm/leads/lost"]) {
        revalidatePath(path, "layout");
      }
    } catch {
      /* no request context — a job or a test, where nothing is cached */
    }
    return moved.ok ? ok(null, moved.message) : moved;
  } catch (e) {
    return fromThrown(e);
  }
}
