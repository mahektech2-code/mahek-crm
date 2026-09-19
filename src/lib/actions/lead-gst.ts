"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import {
  assertCustomerInScope,
  hatsFor,
  requireCapability,
  type Role,
} from "@/lib/access-control";
import type { AppId } from "@/lib/apps";
import { requireUser } from "@/lib/auth";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { writeTimelineEvent, MBOS_EVENT } from "@/lib/timeline";

/* ---------------------------------------------------------------------------
 * §11.6 — GST IS COLLECTED ONCE AND VALIDATED ONCE, BY TWO DIFFERENT PEOPLE.
 *
 * Taken per the specification, which is explicit about it twice: the salesman
 * records the GSTIN, only the back office validates it, and no other role's
 * screen asks for it again. Qualification condition #1 is worded around that
 * split.
 *
 * WHAT WAS THERE BEFORE was a `gst_verified` tick inside the
 * `lead_qualification` jsonb, saved through `saveLeadQualification`, which
 * requires `lead.work` — a capability the field salesman holds. So the man who
 * typed the number into his handset in the shop was also the man certifying
 * that it was a real business we could invoice, and the gate that read it could
 * not tell the two apart. "Collected once, validated once" was a sentence on a
 * checklist rather than a fact about the account.
 *
 * `customers.gst_verified` is the validation, with `gst_verified_at` and
 * `gst_verified_by_id` beside it, and the qualification gate reads the column
 * now. The old tick is deliberately not read and deliberately not migrated
 * forward: carrying it over would import the self-certification into the very
 * column that exists to end it, and would stamp the salesman's name into
 * `gst_verified_by_id` as the validator.
 *
 * A SEPARATE FILE from `actions/leads.ts`, because this is the back office's
 * one write on the lead ladder and it does not belong inside the file the
 * salesman's and the manager's writes live in. It is also the whole of what a
 * back office person needs in order to unblock a qualification, which makes it
 * the natural thing for their screen to import.
 * ------------------------------------------------------------------------- */

const schema = z.object({
  customerId: z.string().min(1),
  /**
   * TRUE validates, FALSE refuses. Refusing is a real answer and not merely the
   * absence of validating: §14's own open question asks how a rejected GSTIN
   * should surface, and a column that could only ever be set to true would make
   * "we looked and it is wrong" indistinguishable from "nobody has looked yet".
   */
  valid: z.boolean(),
  /**
   * Required on a REFUSAL and optional on a pass, which is the same shape every
   * refusal in this product takes — a lost lead, an On Hold, a rejected sample.
   * The salesman has to be told something he can act on, and "GST rejected"
   * with nothing after it sends him back to the shop to ask the same question
   * the same way.
   */
  note: z.string().trim().max(500).optional(),
});

/**
 * Validate — or refuse — the GSTIN somebody recorded against a lead.
 *
 * WHO MAY DO IT is two answers, and the second is the one that matters.
 *
 * Anybody holding `lead.gstValidate` may, which is the accounts desk and
 * managers (see the capability's own note for why it landed there and not in a
 * back-office set that does not exist). AND the person actually named in
 * `back_office_am_id` on this row may, capability or not — because that is who
 * the specification gives the job to, and requiring them to also hold a
 * capability would mean the named seat holder could not do the one thing the
 * seat is for.
 *
 * WHO MAY NOT is the point of the whole exercise: the lead's own owner, which
 * is the salesman who collected the number. He is refused even where he would
 * otherwise qualify — a manager who also owns the lead is still the collector
 * on this one — because a check performed by the person who did the work is not
 * a check. It is the same rule the expense policy already keeps for
 * verification, and the same reason `lead.verify` is kept off the salesman.
 */
export async function validateGstin(
  input: z.infer<typeof schema>,
): Promise<Result<null>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err("Say whether the number checks out.", "validation");
    const { customerId, valid, note } = parsed.data;

    if (!valid && !note?.trim()) {
      return err(
        "A refused GST number has to say what is wrong with it — the salesman has to go back and ask, and he cannot ask better without knowing what failed.",
        "validation",
        [{ field: "note", message: "What is wrong with it?" }],
      );
    }

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
        gstin: true,
        gstVerified: true,
      },
    });
    if (!row) return err("That customer is not here.", "not_found");

    /* Seeing it at all is the ordinary scope question, asked before anything
       else so a refusal cannot be used to find out whether a row exists. */
    await assertCustomerInScope(row);

    if (!row.gstin?.trim()) {
      return err(
        "There is no GST number on this lead yet. The salesman records it; this screen only says whether it checks out.",
        "validation",
      );
    }

    /* The seat holder, or the capability. Asked in that order because the seat
       is what the specification names and the capability is the fall-through
       for a team with nobody sitting in it. */
    const isSeatHolder = row.backOfficeAmId === user.id;
    /* The hat that allowed it, recorded on the audit row exactly as every
       other audited write here records one — with several hats per person,
       "was he allowed to do this" is not answerable from the person alone. */
    let authorisedBy: Role | null = null;
    let authorisedIn: AppId | null = null;
    if (!isSeatHolder) {
      const ctx = await requireCapability("lead.gstValidate");
      authorisedBy = ctx.authorisedBy;
      authorisedIn = ctx.authorisedIn;
    } else {
      const hats = await hatsFor(user);
      authorisedBy = hats[0]?.role ?? null;
      authorisedIn = hats[0]?.app ?? null;
    }

    /*
     * THE COLLECTOR MAY NOT BE THE CHECKER, and this is the whole point.
     *
     * A lead's owner is the salesman who wrote the number down. Letting him
     * validate it reproduces exactly the state this column was added to end,
     * only with a timestamp and his name on it, which is worse: the record
     * would then assert that somebody checked.
     */
    if (row.ownerId === user.id || row.salesAmId === user.id) {
      return err(
        "You recorded this number, so you cannot be the one who checks it. Ask the back office or accounts to validate it — a check somebody performs on their own work is not a check.",
        "not_permitted",
      );
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          gstVerified: valid,
          /*
           * STAMPED ON A REFUSAL TOO, and the pair is what carries the meaning.
           * `gst_verified = false` with a date and a name on it says somebody
           * looked and it failed; the same false with both null says nobody has
           * looked yet. Those are different facts and the salesman's screen has
           * to be able to tell them apart.
           */
          gstVerifiedAt: now,
          gstVerifiedById: user.id,
          updatedAt: now,
        })
        .where(eq(customers.id, customerId));

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.requirement,
        sourceApp: "crm",
        /* The stage goes in the source id: one account is legitimately checked
           more than once — a shop that corrects its number after a refusal —
           and a bare customer id would collapse the second onto the first. */
        sourceRecordId: `gst:${customerId}:${now.toISOString()}`,
        occurredAt: now,
        actorUserId: user.id,
        summary: valid
          ? `GST number validated for ${row.name}.`
          : `GST number refused for ${row.name}${note ? ` — ${note}` : ""}.`,
      });

      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: user.id,
        action: "lead.gstValidate",
        entityType: "customer",
        entityId: customerId,
        actorRole: authorisedBy,
        actorApp: authorisedIn,
        beforeState: { gstVerified: row.gstVerified },
        afterState: { gstVerified: valid, note: note ?? null },
      });
    });

    revalidatePath(`/crm/leads/${customerId}`);
    revalidatePath(`/sales/leads/${customerId}`);
    return ok(
      null,
      valid
        ? "Validated. Qualification can go ahead."
        : "Refused, and the salesman has been told why.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}
