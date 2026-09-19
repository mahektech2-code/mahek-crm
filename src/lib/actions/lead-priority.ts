"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { LEAD_PRIORITIES, priorityLabel } from "@/lib/lead-priority";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * §4.1 — THE MANAGER SAYS HOW HARD TO PUSH A LEAD, and nobody else does.
 *
 * Mahek's own decision, and the reason it is a column rather than a sort order
 * the list invents: the answer has to survive being read on another screen, on
 * another day, by the person who did not make it. A ranking derived from the
 * potential, the stage and the age would be a fourth opinion about the same
 * shop, and it would move under somebody's feet every time a visit landed.
 *
 * IT IS DELIBERATELY NOT `customers.potential`, though the words are the same
 * three. `lib/lead-priority.ts` carries that argument in full: potential is
 * what the shop could spend and it is the salesman's, taken standing in the
 * shop; this is whether the team should be spending this fortnight on it and
 * it is the manager's. A shop can honestly be high on one and low on the
 * other, which is exactly when a manager most needs to say so.
 *
 * A SEPARATE FILE from `actions/leads.ts`, for the same reason `lead-gst.ts`
 * is one: that file is the salesman's and the manager's writes on the LADDER,
 * and this write is not on the ladder at all. It moves no rung, passes no
 * gate, raises no task and notifies nobody — it records a judgement beside the
 * lead. Folding it in would put a write that cannot fail a gate inside the
 * file whose whole subject is gates.
 * ------------------------------------------------------------------------- */

const schema = z.object({
  customerId: z.string().min(1),
  /**
   * NULL IS A REAL ANSWER AND IT IS NOT `low`.
   *
   * Taking the priority back off a lead has to be possible, because a manager
   * who cannot undo a judgement is a manager who stops making them: the first
   * one typed in error would stand for ever, and the column would end up
   * reading as a field people are afraid of. Null says nobody has judged this
   * lead — which is what every row in the book says the day the column ships —
   * and `low` says somebody looked and it can wait. Collapsing the two would
   * destroy the one question this field lets a manager ask, which is how much
   * of their book nobody has been through.
   */
  priority: z.enum(LEAD_PRIORITIES).nullable(),
});

/**
 * Set — or clear — the manager's priority on one lead.
 *
 * WHY `lead.verify` AND NOT A NEW CAPABILITY. `can()` falls through to
 * `!MANAGER_ONLY.has(capability)` for anything it does not recognise, so an
 * invented name that nobody added to the matrix would fail OPEN and hand this
 * write to every telecaller and every field salesman — the trap `sample.approve`
 * carries its own paragraph about. Among the capabilities that DO exist,
 * `lead.verify` is the one that already means "the sales manager's own
 * judgement about a lead, recorded on the lead, which the salesman working it
 * may not make about his own work". That is this act exactly. The seat is the
 * same seat: the manager who rings the customer to establish the opportunity
 * is the one person in the building who can say whether it is worth the
 * fortnight, and he is the one already holding this.
 *
 * The two it was weighed against are `lead.override`, which is the escape
 * hatch for passing a SHUT GATE and demands a reason code and a record of what
 * was missing — an audit row reading `lead.override` for an act that overrode
 * nothing would make that log unreadable — and `lead.work`, which is in none
 * of the sets and is therefore everybody's, which is the opposite of what
 * Mahek asked for.
 *
 * CHECKED HERE AND NOT ONLY ON THE SCREEN. A server action is a URL, and the
 * control being absent for a telecaller is a fact about a component rather
 * than about the system.
 */
export async function setLeadPriority(
  input: z.infer<typeof schema>,
): Promise<Result<null>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err("Say which priority.", "validation");
    const { customerId, priority } = parsed.data;

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
        leadPriority: true,
      },
    });
    if (!row) return err("That lead is not here.", "not_found");

    /* Seeing it at all is the ordinary scope question, asked before the
       capability so a refusal cannot be used to find out whether a row
       exists. */
    await assertCustomerInScope(row);

    /*
     * A PRIORITY IS A THING TO SAY ABOUT A LEAD, so there has to be one.
     *
     * `lead_stage is not null` is what the whole funnel reads as "this has
     * ever been a lead" — deliberately not `kind = 'lead'`, which stops being
     * true the moment the first order lands on the same row. An ordinary
     * customer has a buying cycle and a collections stage telling everybody
     * how hard to push it; a priority typed onto one would be a manager's word
     * on a screen that never draws it.
     */
    if (!row.leadStage) {
      return err(
        "This account has never been a lead, so there is no lead to prioritise. What to do about a customer is answered by their buying cycle and what they owe.",
        "validation",
      );
    }

    /* The hat that allowed it, recorded on the audit row exactly as every
       other audited write here records one — with several hats per person,
       "was he allowed to do this" is not answerable from the person alone. */
    const { authorisedBy, authorisedIn } = await requireCapability("lead.verify");

    /* Nothing to write, and nothing to audit. The same discipline a
       reassignment that changes nothing follows: a log full of rows where the
       before and the after are identical is a log nobody reads. */
    if ((row.leadPriority ?? null) === priority) {
      return ok(null, `Already ${priorityLabel(priority).toLowerCase()}.`);
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({ leadPriority: priority, updatedAt: now })
        .where(eq(customers.id, customerId));

      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: user.id,
        action: "lead.priority",
        entityType: "customer",
        entityId: customerId,
        actorRole: authorisedBy,
        actorApp: authorisedIn,
        beforeState: { leadPriority: row.leadPriority ?? null },
        afterState: { leadPriority: priority },
      });
    });

    /*
     * NO TIMELINE ROW, and that is a decision rather than an omission.
     *
     * `lib/timeline.ts` is a customer's shared history — what was said to them
     * and what was done for them — and every kind in it is a CONSTANT naming a
     * source record that is the actual truth. How hard we intend to push a
     * shop is an internal note about our own week; it is not something that
     * happened to the customer, and a salesman reading a record would find a
     * row telling him his manager thinks his lead can wait. The audit row above
     * is where "who decided this, and when" lives, which is the question
     * anybody actually asks of it.
     */

    revalidatePath("/sales/leads");
    revalidatePath(`/sales/leads/${customerId}`);
    revalidatePath("/crm/leads");
    revalidatePath(`/crm/leads/${customerId}`);
    return ok(
      null,
      priority
        ? `${row.name} is ${priorityLabel(priority).toLowerCase()} priority.`
        : `Priority cleared — ${row.name} is back to unjudged.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
