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
  levelInApp,
  requireCapability,
  type Role,
} from "@/lib/access-control";
import type { AppId } from "@/lib/apps";
import { requireUser } from "@/lib/auth";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { writeTimelineEvent, MBOS_EVENT } from "@/lib/timeline";
import { reviewVoidPatch } from "@/lib/lead-review-void";
import { leadRow } from "@/lib/services/lead-service";
import {
  handBackAfterGstRefusal,
  recordReviewVoid,
  settleQualificationState,
} from "@/lib/services/lead-qualification-flow-service";
import { gstValidatorRefusal } from "@/lib/services/lead-verifier";

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
 * WHAT A REFUSAL DOES, as Mahek asked for it: it BLOCKS, and it is reversible
 * without anybody undoing anything.
 *
 * A refused GSTIN sets the column false with the date and the name on it, and
 * the qualification gate refuses `sample_trial` while it stands — so no sample
 * goes out to a business we could not confirm we may invoice. It is not a
 * warning, because a warning on this one is a sample already dispatched by the
 * time somebody reads it.
 *
 * Lifting it needs no separate act. The gate reads the column on every
 * evaluation rather than caching a verdict anywhere, so the moment somebody
 * validates the corrected number the lead is unblocked and carries on from the
 * rung it was already on. Nothing has to be re-ticked, no transition is
 * rewritten, and the refusal stays in the audit log and on the timeline as the
 * record of what happened in between — which is the point of storing the
 * refusal rather than simply leaving the flag false.
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
 * WHO MAY DO IT is decided by which APP somebody holds, not by how senior they
 * are — Mahek's own instruction, and the reason `lead.gstValidate` sits in no
 * seniority set. Anybody with the Sales Dashboard, the CRM or the Accounts desk
 * may check a GSTIN, at either level: a clerk checking a number is doing the
 * job rather than making a decision above their station. The person named in
 * `back_office_am_id` on the row may too, capability or not — where a team does
 * name somebody to that seat, requiring them to also hold a grant would mean
 * the named person could not do the one thing the seat is for.
 *
 * WHO MAY NOT is the point of the whole exercise, and it is enforced twice.
 * The handset is the one book app absent from the grant, so the field salesman
 * who collected the number cannot certify it. And the lead's own OWNER is
 * refused here outright, whatever hat he holds — a man who works the field and
 * also holds the CRM would otherwise walk straight round the first rule on his
 * own leads. A check performed by the person who did the work is not a check;
 * it is the same reasoning that keeps `lead.verify` off the salesman and that
 * makes the expense policy demand a second pair of eyes.
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
        "A refused GST number has to say what is wrong with it — the Salesman has to go back and ask, and cannot ask better without knowing what failed.",
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
        salesManagerId: true,
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
        "There is no GST number on this lead yet. Enter it first; this only says whether it checks out.",
        "validation",
      );
    }

    /*
     * THE RESPONSIBLE SALES MANAGER VALIDATES, for a lead on the funnel.
     *
     * This used to be anybody holding `lead.gstValidate` (the Sales Dashboard,
     * the CRM or the Accounts desk) or the back-office seat. Mahek's decision is
     * that the Sales Manager the lead is under validates the number, as part of
     * her review of the Qualification — so for a lead that is on the funnel the
     * rule is `gstValidatorRefusal`: the seat holder, an administrator, or, where
     * nobody holds the seat, a `lead.verify` holder; and never the lead's owner,
     * who entered the number. `lead.gstValidate` and the back-office seat are
     * not removed — they are simply no longer how a funnel lead's GST is
     * validated, and an account that was never a lead keeps exactly the old rule
     * below. Validations already on record are untouched.
     */
    const lead = await leadRow(customerId);
    let authorisedBy: Role | null = null;
    let authorisedIn: AppId | null = null;
    if (lead?.leadStage) {
      const refusal = await gstValidatorRefusal(user, {
        ownerId: row.ownerId,
        salesManagerId: lead.salesManagerId,
      });
      if (refusal) return err(refusal, "not_permitted");
      const level = await levelInApp(user, "crm");
      if (level) {
        authorisedBy = level;
        authorisedIn = "crm";
      } else {
        const hats = await hatsFor(user);
        authorisedBy = hats[0]?.role ?? null;
        authorisedIn = hats[0]?.app ?? null;
      }
    } else {
      /* The seat holder, or the capability. Asked in that order because the seat
         is what the specification names and the capability is the fall-through
         for a team with nobody sitting in it. */
      const isSeatHolder = row.backOfficeAmId === user.id;
      if (!isSeatHolder) {
        const ctx = await requireCapability("lead.gstValidate");
        authorisedBy = ctx.authorisedBy;
        authorisedIn = ctx.authorisedIn;
      } else {
        const hats = await hatsFor(user);
        authorisedBy = hats[0]?.role ?? null;
        authorisedIn = hats[0]?.app ?? null;
      }
    }

    /*
     * THE TELECALLER WHO ENTERED THE NUMBER MAY ALSO VALIDATE IT.
     *
     * This used to refuse the lead's owner ("a check somebody performs on their
     * own work is not a check"), on the reasoning that the person who typed the
     * number in must not be the person who certifies it. Mahek's answer is that
     * in this workflow the Telecaller owns GST end to end — enters it and checks
     * it — and the capability that carries it, `lead.gstValidate`, is unchanged
     * and still asked above. What the record keeps is WHO did it and when
     * (`gst_verified_by_id`, the timeline row and the audit row), so it still
     * says which person asserted the number checks out.
     *
     * What makes that safe is the other half of the same discipline: a
     * validation belongs to the number it was made against. Changing the GSTIN
     * clears it (`gstinChangeClear`), so a validation cannot outlive the number
     * it certified.
     */
    /* GST is a QUALIFICATION answer, so it is validated at Qualification — not
       against a Prospect nobody has verified yet. A customer that was never a
       lead has no such rung and is unaffected. */
    if (lead?.leadStage && ["suspect", "new", "prospect", "contacted"].includes(lead.leadStage)) {
      return err(
        "Waiting for the Sales Manager to verify this Prospect. GST is validated once Qualification opens.",
        "rule_violation",
      );
    }

    /* A validation that CHANGES the stored answer takes a manager's earlier
       `verified` away when a Telecaller makes it (not when a manager validates it
       himself); an identical re-validation changes nothing. */
    const voided = lead
      ? reviewVoidPatch(lead, { gstVerified: valid }, { reviewer: false })
      : null;

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
          ...(voided?.set ?? {}),
        })
        .where(eq(customers.id, customerId));
      if (voided && lead) {
        await recordReviewVoid(tx, {
          lead,
          voided,
          actorId: user.id,
          actorRole: authorisedBy,
          actorApp: authorisedIn,
        });
      }

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

    if (voided) await settleQualificationState(customerId, user.id, { voided: true });
    else await settleQualificationState(customerId, user.id);
    /* A refused number goes straight back to the Salesman with the reason in it. */
    if (!valid && lead?.leadStage) await handBackAfterGstRefusal(customerId, note?.trim() ?? "", user.id);
    try {
      revalidatePath(`/crm/leads/${customerId}`);
      revalidatePath(`/sales/leads/${customerId}`);
    } catch {
      /* no request context - a job or a test, where nothing is cached */
    }
    return ok(
      null,
      valid
        ? "Validated. Qualification can go ahead."
        : "Refused — the Salesman has been told what to correct.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}
