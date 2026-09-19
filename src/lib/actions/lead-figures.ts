"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * §5.3 — SOMEBODY SAYS THE FOUR CONVERSION FIGURES STILL HOLD.
 *
 * The monthly requirement, the potential, the product they need and the
 * competitor they use are captured once, at Suspect → Prospect, and the
 * qualification checklist deliberately stops re-asking them — that is the
 * specification's own first principle, that a fact established by whoever stood
 * in the shop is not re-certified later by another role. Mahek accepted it AND
 * asked for the gap it leaves to be closed: a sample must not go out on a
 * requirement that was true in March.
 *
 * `lead-gates.ts` closes it by refusing `sample_trial` while `figuresStale`,
 * and `figuresAreStale` answers that from `lead_figures_confirmed_at` against
 * `leads.figuresFreshDays`. WHAT DID NOT EXIST WAS ANYTHING THAT WROTE THAT
 * COLUMN. Nothing, anywhere — no action, no job, no sync handler — so the date
 * was null on every lead in the book, null reads as never confirmed, never
 * confirmed reads as stale, and the gate refused every sample on every lead
 * with no act in the product capable of satisfying it. A gate nobody can pass
 * is not a gate, it is a stop: the whole funnel would have halted at
 * Qualification on the day this deployed, with the refusal naming a condition
 * that pointed at no screen and no button.
 *
 * THIS IS ONE ACT AND NOT FOUR FIELDS RETYPED, which is the rule the schema
 * comment on the column states and the reason this file writes a date rather
 * than a figure. Asking for the four again would be a second copy of them,
 * free to drift from the columns the gates and the verification call actually
 * read, and it would be the re-asking the checklist was cut from twelve
 * questions to eight to avoid. What is being recorded is somebody's word that
 * they looked at what is already on the record and it is still true. Correcting
 * a figure is a different act, on the qualification screen, and it is the right
 * thing to do when the answer is that it no longer holds.
 *
 * A SEPARATE FILE from `actions/leads.ts`, for the same reason `lead-gst.ts`
 * and `lead-priority.ts` are separate: that file holds the writes that move a
 * lead along the LADDER. This one moves no rung, passes no gate and raises no
 * task — it refreshes a date a gate then reads for itself.
 * ------------------------------------------------------------------------- */

const schema = z.object({
  customerId: z.string().min(1),
});

/**
 * Confirm that the four conversion figures on a lead still hold.
 *
 * WHO MAY: whoever may work the lead — `lead.work`, the same capability that
 * moves a lead up a rung and closes it. The alternative considered was the
 * manager's `lead.verify`, and it is wrong here for the reason the
 * specification gives the four figures to the salesman in the first place: the
 * person who can say whether a shop still uses four hundred litres a month is
 * the person who was in the shop last week, not the manager who has never been.
 * Making it a manager's would also put a queue in front of every sample, which
 * is precisely the shape that makes a team record the work after the event.
 *
 * Checked HERE and not only by the control being drawn — a server action is a
 * URL — and the scope check above it is what stops anybody confirming figures
 * on a lead they may not see.
 */
export async function confirmLeadFigures(
  input: z.infer<typeof schema>,
): Promise<Result<null>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err("Say which lead.", "validation");
    const { customerId } = parsed.data;

    const user = await requireUser();
    const row = await db.query.customers.findFirst({
      where: eq(customers.id, customerId),
      columns: {
        id: true,
        name: true,
        kind: true,
        ownerId: true,
        salesAmId: true,
        backOfficeAmId: true,
        leadStage: true,
        leadMonthlyVolumeLitres: true,
        leadEstimatedPotentialPaise: true,
        leadRequiredProductId: true,
        leadCompetitor: true,
        leadFiguresConfirmedAt: true,
      },
    });
    if (!row) return err("That lead is not here.", "not_found");

    /* Seeing it at all is the ordinary scope question, asked before the
       capability so a refusal cannot be used to find out whether a row
       exists. */
    await assertCustomerInScope(row);

    /*
     * THERE HAS TO BE A LEAD TO CONFIRM FIGURES ON.
     *
     * `lead_stage is not null` is what the whole funnel reads as "this has ever
     * been a lead", and deliberately not `kind = 'lead'`, which stops being
     * true the moment the first order lands on the same row. The four figures
     * are the funnel's own, so on an account that was never in it there is
     * nothing here to stand behind.
     */
    if (!row.leadStage) {
      return err(
        "This account has never been a lead, so there are no conversion figures to stand behind. What a customer buys is answered by their order history.",
        "validation",
      );
    }

    /* The hat that allowed it, recorded on the audit row exactly as every other
       audited write here records one — with several hats per person, "was he
       allowed to do this" is not answerable from the person alone. */
    const { authorisedBy, authorisedIn } = await requireCapability("lead.work");

    /*
     * A CONFIRMATION THAT NOTHING IS STILL TRUE IS A LIE, so an empty lead is
     * refused — and the test is ALL FOUR EMPTY rather than ANY ONE empty, which
     * is the part worth explaining.
     *
     * All four are `PROSPECT_CONDITIONS`, so a lead that climbed to Prospect
     * honestly carries every one of them and never reaches this branch. The
     * population that can is leads a manager pushed past a shut gate with
     * `lead.override`, which the product allows on purpose. Refusing them on
     * ANY missing figure would strand exactly those leads in the way this whole
     * file exists to undo: the gate would demand a confirmation, and the
     * confirmation would refuse itself, with no screen in the building able to
     * break the loop. Refusing only where there is nothing whatsoever to have
     * looked at keeps the statement honest without ever becoming a second
     * unsatisfiable gate — filling in any one of the four is work the
     * qualification screen already asks for and can do today.
     *
     * The FIGURES ARE NOT REQUIRED TO BE COMPLETE by this act, in other words;
     * what is required is that the act can be about something.
     */
    const anyFigure =
      row.leadMonthlyVolumeLitres != null ||
      row.leadEstimatedPotentialPaise != null ||
      Boolean(row.leadRequiredProductId) ||
      Boolean(row.leadCompetitor?.trim());
    if (!anyFigure) {
      return err(
        "Nothing has been recorded about what this shop uses — no monthly requirement, no potential, no product and no competitor. There is nothing here to say still holds. Answer them on the qualification screen first.",
        "validation",
      );
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadFiguresConfirmedAt: now,
          leadFiguresConfirmedById: user.id,
          updatedAt: now,
        })
        .where(eq(customers.id, customerId));

      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: user.id,
        action: "lead.figuresConfirmed",
        entityType: "customer",
        entityId: customerId,
        actorRole: authorisedBy,
        actorApp: authorisedIn,
        beforeState: { leadFiguresConfirmedAt: row.leadFiguresConfirmedAt ?? null },
        afterState: { leadFiguresConfirmedAt: now.toISOString() },
      });
    });

    /*
     * NO TIMELINE ROW, and that is a decision rather than an omission.
     *
     * `lib/timeline.ts` is the customer's shared history — what was said to them
     * and what was done for them — and every kind in it names a source record
     * that is the actual truth. Nobody rang this shop and nothing was done for
     * them: somebody in our office read four numbers already on the record and
     * said they still look right. The audit row above answers "who stood behind
     * these, and when", which is the only question anybody asks of it, and the
     * date itself is drawn on the lead record where the figures are.
     */

    revalidatePath(`/sales/leads/${customerId}`);
    revalidatePath(`/crm/leads/${customerId}`);
    return ok(
      null,
      `Noted — the figures on ${row.name} stand as they are, as of today.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
