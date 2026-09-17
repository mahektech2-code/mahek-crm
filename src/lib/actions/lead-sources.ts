"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * The one write the Sources screen makes.
 *
 * `customers.lead_source` is free text, written by a handset, a spreadsheet
 * import and an office form — three authors and no list — so "Website",
 * "website" and "Web site" are three sources for ever unless somebody can say
 * they are one. This is that somebody's button, and it is the whole reason the
 * screen exists: a report that can only DESCRIBE a mess is a report people
 * read once.
 *
 * It is a rename rather than a mapping table on purpose. A mapping would mean
 * every reader of `lead_source` — this screen, the leads list's filter, the
 * owner's attribution KPI, an export — had to learn to resolve through it, and
 * the one that forgets is the one somebody quotes. Rewriting the column means
 * nothing else has to know this happened.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Merge one spelling of a lead source into another.
 *
 * **Capability-checked here, not by hiding the control.** A server action is a
 * URL, and the merge dialog is a client component that anybody can reach the
 * other end of. `requireCapability` is `canFor`'s enforcing form — the same
 * union over every hat somebody wears — and it is used rather than a bare
 * `canFor` for a second reason: it hands back the hat that allowed it, and
 * `audit_log.actor_role`/`actor_app` are exactly what "who was allowed to do
 * this, wearing what" means now that `associate` names a level rather than a
 * job. A bare boolean would leave both columns null, which reads as *not
 * recorded* rather than as anything.
 *
 * `lead.work` rather than a manager-only capability: it is the same right the
 * funnel's other writes take, and a cleanup that only two people in the
 * building may perform is a cleanup that does not happen.
 *
 * **It is BOOK-WIDE and is not narrowed to the caller's scope.** That is
 * deliberate and is said out loud on the screen before the button is pressed:
 * a rename that touched only the rows one manager can see would leave the old
 * spelling alive on everybody else's, and the screen would go on reporting two
 * sources while claiming they had been merged. A half-done merge is worse than
 * none, because it looks finished.
 */
export async function renameLeadSource(
  from: string,
  to: string,
): Promise<Result<{ moved: number; to: string }>> {
  try {
    const ctx = await requireCapability("lead.work");

    /* Trimmed at the door. A source stored with a trailing space is a
       different string to every `group by` in the product and is invisible on
       every screen that shows it, which is exactly the class of mess this
       action exists to clear rather than to create. */
    const source = from.trim();
    const target = to.trim();

    if (!source) return err("Name the source being merged.", "validation");
    if (!target) return err("Name the source to merge it into.", "validation");
    if (source === target) {
      return err("That is the same source — nothing would move.", "validation");
    }

    /*
     * `returning` rather than a count read beforehand: the number reported back
     * is the number of rows this statement actually changed, so a lead whose
     * source moved between the screen being drawn and the button being pressed
     * is counted once and correctly. A count taken first would be a figure
     * about a moment that has passed.
     */
    const moved = await db
      .update(customers)
      .set({ leadSource: target })
      .where(eq(customers.leadSource, source))
      .returning({ id: customers.id });

    if (moved.length === 0) {
      /* Not an error the caller did anything about, and not a success worth
         auditing either — there is no before state to record. */
      return err(`No lead carries the source “${source}” any more.`, "not_found");
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: ctx.user.id,
      action: "lead.source.rename",
      /* The entity is the SOURCE, not any one customer. A thousand audit rows
         for one decision is a log nobody can read, and the decision was taken
         once about one string. The affected ids are in `afterState` so the
         write can be reconstructed. */
      entityType: "lead_source",
      entityId: source,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      beforeState: { source, leads: moved.length },
      afterState: { source: target, customerIds: moved.map((m) => m.id) },
    });

    try {
      revalidatePath("/sales/leads/funnel/sources");
      revalidatePath("/sales/leads");
    } catch {
      /* no request context — a job or a test, where nothing is cached */
    }

    return ok(
      { moved: moved.length, to: target },
      `${moved.length} lead${moved.length === 1 ? "" : "s"} moved to “${target}”.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
