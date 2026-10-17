"use server";

import { assertLeadInScope } from "@/lib/services/lead-scope";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customerDistributors, customers } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { qualificationAccess } from "@/lib/lead-qualification-access";
import { reviewVoidPatch } from "@/lib/lead-review-void";
import { leadRow } from "@/lib/services/lead-service";
import { checkDistributors } from "@/lib/services/distributor-service";
import {
  isReviewer,
  recordReviewVoid,
  settleQualificationState,
} from "@/lib/services/lead-qualification-flow-service";

/* ---------------------------------------------------------------------------
 * THE TELECALLER NAMES WHO INVOICES A THIRD-PARTY SHOP — and nothing more.
 *
 * A third-party lead is one somebody else bills, and the Sample/Trial gate will
 * not open until a distributor is on record (`distributor_named`). Qualification
 * belongs to the Telecaller, so the Telecaller has to be able to satisfy that
 * condition. The existing door, `addDistributor`, needs `customer.classify` —
 * which is managers' and accounts', and which ALSO converts an account to and
 * from third-party status (taking it off the Call Log's prospecting), edits and
 * removes arrangements, and moves the mark. Handing that to a Telecaller to let
 * them type one name would be a far bigger grant than the job.
 *
 * So this is the narrow one, and it is deliberately smaller than what it
 * borrows from:
 *
 *   • `lead.work`, the capability the whole funnel is worked under, and the
 *     lead in the caller's scope — the same two questions every Qualification
 *     write asks;
 *   • the lead is AT Qualification (`qualificationAccess`), so it cannot be used
 *     to name somebody against a Prospect nobody has verified;
 *   • the lead's sales type is `third_party` — the applicability the gate reads;
 *   • it ADDS a link. It does not edit one, remove one, set the mark or revert
 *     it: those stay `customer.classify`'s, and a Telecaller who named the wrong
 *     account asks a manager to correct it.
 *
 * WHO MAY BE NAMED is `checkDistributors`, the same function `addDistributor`
 * calls — an account we invoice, not itself a third-party shop, not
 * deactivated. One definition, so the Telecaller cannot name an account the
 * manager could not.
 *
 * A link is a material Qualification answer, so it takes a manager's earlier
 * `verified` review away in the same transaction (unless the caller is the
 * reviewer himself), and tells the manager the review is wanted again.
 * ------------------------------------------------------------------------- */

const schema = z.object({
  customerId: z.string().min(1),
  distributorId: z.string().min(1, "Pick a distributor."),
  note: z.string().trim().max(500).optional(),
});

export async function nameLeadDistributor(
  input: z.input<typeof schema>,
): Promise<Result<{ id: string }>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Pick a distributor.", "validation");
    const { customerId, distributorId, note } = parsed.data;

    const ctx = await requireCapability("lead.work");

    const lead = await leadRow(customerId);
    if (!lead || lead.leadStage === null) return err("That lead is not on MahekOne.", "not_found");
    await assertLeadInScope(customerId, {
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
    });

    const access = qualificationAccess(lead.leadStage);
    if (!access.writable) return err(access.reason, "rule_violation");

    if (lead.leadSalesType !== "third_party") {
      return err(
        "Only a third-party lead names a distributor here — that is a shop somebody else invoices.",
        "rule_violation",
      );
    }

    const problem = await checkDistributors([distributorId], [customerId]);
    if (problem) return err(problem, "rule_violation");

    const existing = await db
      .select({ id: customerDistributors.id })
      .from(customerDistributors)
      .where(eq(customerDistributors.customerId, customerId));
    const already = await db
      .select({ id: customerDistributors.id })
      .from(customerDistributors)
      .where(
        and(
          eq(customerDistributors.customerId, customerId),
          eq(customerDistributors.distributorCustomerId, distributorId),
        ),
      );
    if (already.length) return err("That distributor is already named for this shop.", "duplicate");

    const linkId = `cd_${randomUUID().slice(0, 12)}`;
    const voided = reviewVoidPatch(lead, {}, { reviewer: await isReviewer(ctx.user), extra: ["distributor"] });

    await db.transaction(async (tx) => {
      await tx.insert(customerDistributors).values({
        id: linkId,
        customerId,
        distributorCustomerId: distributorId,
        /* The first one named is the one that usually serves the shop; a second
           is an addition, and moving the badge is the manager's edit. */
        isPrimary: existing.length === 0,
        note: note ?? null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "lead.nameDistributor",
        entityType: "customer",
        entityId: customerId,
        afterState: { distributorId, isPrimary: existing.length === 0 },
      });
      if (voided) {
        await tx
          .update(customers)
          .set({ ...voided.set, updatedAt: new Date() })
          .where(eq(customers.id, customerId));
        await recordReviewVoid(tx, {
          lead,
          voided,
          actorId: ctx.user.id,
          actorRole: ctx.authorisedBy,
          actorApp: ctx.authorisedIn,
        });
      }
    });

    await settleQualificationState(customerId, ctx.user.id, { voided: Boolean(voided) });
    try {
      revalidatePath("/crm/leads");
      revalidatePath(`/crm/leads/${customerId}`);
      revalidatePath(`/crm/leads/${customerId}/qualify`);
      revalidatePath(`/sales/leads/${customerId}`);
    } catch {
      /* no request context — a job or a test */
    }
    return ok({ id: linkId }, "Distributor named.");
  } catch (e) {
    return fromThrown(e);
  }
}
