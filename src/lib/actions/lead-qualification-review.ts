"use server";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { notifyUser } from "@/lib/notify";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * §5.3 — THE MANAGER'S VERDICT ON A QUALIFICATION CHECKLIST, AND THE WRITE
 * THAT WAS MISSING UNDER IT.
 *
 * `lead-gates.ts` refuses `sample_trial` where `customers.lead_qualification_
 * review` reads `incomplete` or `clarification`. That gate shipped reading a
 * column NOTHING WROTE: there was no action and no control, so the block could
 * never be set and — far worse if one had ever arrived from a backfill — never
 * be cleared. A gate over an unwritable column is a rule that cannot be
 * exercised at all, which is the one kind of rule nobody can find by reading a
 * screen: everything looks finished and nothing happens.
 *
 * THE DECISION BEING IMPLEMENTED IS A REVERSAL. The review used to be recorded
 * and change nothing — the checklist alone decided, so a sales manager could
 * write "this is not finished, go back and ask him about the credit terms" and
 * watch the lead move on to a sample regardless. Mahek's instruction is that
 * the two negative verdicts HOLD the lead at qualification. A verdict nobody
 * has to answer is a comment, and people stop writing comments nobody answers.
 *
 * A SEPARATE FILE from `actions/leads.ts`, for the reason `lead-priority.ts`
 * and `lead-gst.ts` are each one: that file is the writes ON the ladder — the
 * moves, the gates, the overrides — and this is a judgement recorded BESIDE the
 * lead which happens to be read by a gate. Folding it in would put a write that
 * moves no rung inside the file whose entire subject is rungs.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * The three verdicts, spelled exactly as `leadQualificationReviewEnum` spells
 * them rather than derived from it: the enum is a database object and this is a
 * form schema, and a `z.enum` built off a pgEnum's values would quietly widen
 * the day somebody added a fourth verdict the screens do not draw.
 */
const VERDICTS = ["verified", "incomplete", "clarification"] as const;

const schema = z.object({
  customerId: z.string().min(1),
  verdict: z.enum(VERDICTS),
  /**
   * Required on the two negatives, optional on `verified`, and the asymmetry is
   * the whole point of the field.
   *
   * A refusal with no sentence teaches the salesman nothing — he is standing
   * in front of a lead that has stopped moving with no idea what to go and fix,
   * which is exactly what the blocking version of this must not become. The
   * same discipline a lost lead, an On Hold and a rejected sample all keep, and
   * for the same reason: the next attempt goes out identical otherwise.
   *
   * `verified` needs none, because the verdict is the whole message. Demanding
   * a sentence to agree with somebody is how a manager learns to type "ok".
   */
  note: z.string().trim().max(2000).optional(),
});

/**
 * Record — or clear — the sales manager's verdict on a lead's qualification
 * checklist.
 *
 * WHY `lead.verify`. It is the existing MANAGER_ONLY capability that already
 * means "the sales manager's own judgement about a lead, recorded on the lead,
 * which the salesman working it may not make about his own work". That is this
 * act exactly, and the seat is the same seat: §8's verification call is the
 * manager establishing that the visit happened and the opportunity is real, and
 * this is the manager saying whether the answers the salesman wrote down stand
 * up. A salesman marking his own checklist verified would be the precise thing
 * `lead.verify` exists to stop — a check somebody performs on their own work is
 * not a check.
 *
 * The two it was weighed against are `lead.work`, which is in none of the
 * capability sets and is therefore EVERYBODY's — the salesman would hold it —
 * and `lead.override`, which is the escape hatch for passing a shut gate and
 * demands a reason code and a record of what was missing; an audit row reading
 * `lead.override` for an act that overrode nothing would make that log
 * unreadable. Inventing a new name was the other option and it is the dangerous
 * one: `can()` ends with `!MANAGER_ONLY.has(capability)`, so a capability
 * nobody added to the matrix FAILS OPEN and hands this write to every
 * telecaller and every field salesman.
 *
 * CHECKED HERE AND NOT ONLY ON THE SCREEN. A server action is a URL, and a
 * control drawn for managers alone is a fact about a component rather than
 * about the system.
 */
export async function reviewLeadQualification(
  input: z.infer<typeof schema>,
): Promise<Result<null>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err("Say which verdict.", "validation");
    const { customerId, verdict } = parsed.data;
    const note = parsed.data.note?.trim() ?? "";

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
        leadManagerId: true,
        leadQualificationReview: true,
        leadQualificationReviewNote: true,
      },
    });
    if (!row) return err("That lead is not here.", "not_found");

    /* Seeing it at all is the ordinary scope question, asked before the
       capability so a refusal cannot be used to find out whether a row
       exists. */
    await assertCustomerInScope(row);

    /*
     * A CHECKLIST IS A THING A LEAD HAS, so there has to be a lead.
     *
     * `lead_stage is not null` is what the whole funnel reads as "this has ever
     * been a lead" — deliberately not `kind = 'lead'`, which stops being true
     * the moment the first order lands on the same row. A verdict typed onto an
     * ordinary customer would be a manager's word on a column no screen in the
     * product draws for them.
     */
    if (!row.leadStage) {
      return err(
        "This account has never been a lead, so there is no qualification checklist to review.",
        "validation",
      );
    }

    /*
     * The sentence is demanded HERE rather than by a required field on the
     * form, because the form is not the only thing that can post to a server
     * action — and because the two negatives are the whole reason the note
     * exists. The refusal names which verdict it is talking about, since
     * "a note is required" over a screen with three buttons on it sends
     * somebody to look for a field they have already filled in.
     */
    if (verdict !== "verified" && !note) {
      return err(
        verdict === "incomplete"
          ? "Say what is not finished. This holds the lead at qualification, and a refusal with no sentence leaves the salesman with a lead that has stopped moving and nothing to go and fix."
          : "Say what needs clarifying. The salesman answers this note and asks you to look again, so the note is the whole of what he has to work from.",
        "validation",
        [{ field: "note", message: "What does he need to do?" }],
      );
    }

    /* The hat that allowed it, recorded on the audit row exactly as every other
       audited write here records one — with several hats per person, "was he
       allowed to do this" is not answerable from the person alone. */
    const ctx = await requireCapability("lead.verify");

    const before = row.leadQualificationReview ?? null;
    /*
     * A RE-REVIEW THAT SAYS THE SAME THING IS STILL A REVIEW, unlike the
     * priority write next door which returns early on an unchanged value.
     *
     * The two are different kinds of column. A priority is a standing judgement
     * and re-typing it is a no-op; this is a manager LOOKING AGAIN at a
     * checklist a salesman has since answered, and "I have read your answer and
     * it is still not finished" is the most useful thing he can say. Collapsing
     * it into "already incomplete" would swallow the second refusal, leave the
     * old note standing, and tell nobody — which is the shape of the bug this
     * whole feature exists to fix.
     */

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadQualificationReview: verdict,
          /* Null rather than an empty string on a verified checklist with
             nothing typed: the column holds a sentence or it holds nothing, and
             an empty string is a third state every reader would have to know
             about. Clearing it here is also what stops a stale refusal being
             quoted back at a salesman under a verdict that has since agreed
             with him. */
          leadQualificationReviewNote: note || null,
          leadQualificationReviewedAt: now,
          leadQualificationReviewedById: ctx.user.id,
          updatedAt: now,
        })
        .where(eq(customers.id, customerId));

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.qualificationReview,
        sourceApp: "crm",
        /*
         * THE MOMENT GOES IN THE SOURCE ID, because there is no review ROW to
         * name and one lead is reviewed several times.
         *
         * The natural key is (app, kind, source row). The bare customer id
         * would collapse every review this lead ever has onto the first one
         * written — the manager sends it back on Monday, agrees on Thursday,
         * and the record shows only the Monday. It is the same shape as a
         * sample's three dates riding as `<id>:dispatched`, `<id>:received`,
         * `<id>:review`: where one record produces several events, the stage
         * goes in the source id. The timestamp is the one computed above and
         * written to the row, so a retried write lands on the same key and
         * deduplicates rather than writing a second copy.
         */
        sourceRecordId: `${customerId}:review:${now.toISOString()}`,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary:
          verdict === "verified"
            ? `Sales manager verified the qualification checklist for ${row.name}.${note ? ` ${note}` : ""}`.trim()
            : verdict === "incomplete"
              ? `Sales manager marked the qualification checklist for ${row.name} incomplete — it is held at qualification until he looks again. ${note}`.trim()
              : `Sales manager asked for a clarification on the qualification checklist for ${row.name} — it is held at qualification until he looks again. ${note}`.trim(),
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.qualificationReview",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: {
          leadQualificationReview: before,
          leadQualificationReviewNote: row.leadQualificationReviewNote ?? null,
        },
        afterState: { leadQualificationReview: verdict, leadQualificationReviewNote: note || null },
      });
    });

    /*
     * THE SALESMAN IS TOLD, because the lead he is working has just stopped.
     *
     * `lib/notify.ts` says in as many words that a decision nobody receives is
     * not a decision, and this codebase has the scar to go with it: an order
     * decision landed on the customer timeline and stopped there for months, so
     * the telecaller who had promised a customer their order found out when the
     * customer rang. A verdict that blocks a lead is exactly that shape — the
     * lead simply stops moving, and the only place saying why is a column.
     *
     * THE NOTE TRAVELS IN THE BODY, not behind a link. It is the entire content
     * of the refusal — what he has to go and do — and a notification that makes
     * somebody open a screen to find out what it says is one they read later.
     *
     * `warn` and NOT `warning`: the bell colours `warn` and `danger`, and the
     * several callers in this codebase that wrote `warning` are silently drawn
     * as ordinary. It is one character and it is the whole difference between a
     * row somebody notices and a row in a list.
     *
     * It runs AFTER the transaction and can never fail the verdict, exactly as
     * the next-step sentence is a courtesy on top of a completed call. A bell
     * that could not be written must not undo a judgement already standing on
     * the record.
     *
     * Only the NEGATIVES notify. A verified checklist is the lead carrying on
     * as the salesman expected — the gate simply stops refusing and he finds
     * out by the lead moving — and a bell for every agreement is how a person
     * learns to dismiss the ones that matter. The exception is a verdict that
     * LIFTS a block: he was told it stopped, so he is told it has started
     * again, or the notification he did get is left standing as the last word.
     */
    const blockedBefore = before === "incomplete" || before === "clarification";
    const blockedNow = verdict === "incomplete" || verdict === "clarification";
    /* The salesman on the account — the owner of a lead, which is what
       `ASSIGNED_TO_SQL` reads. The sales seat is the fallback for a lead
       already promoted and being reviewed again. Never the lead manager, who
       is usually the person pressing the button. */
    const salesman = row.ownerId ?? row.salesAmId;
    if (salesman && salesman !== ctx.user.id && (blockedNow || blockedBefore)) {
      await notifyUser({
        userId: salesman,
        title: blockedNow
          ? verdict === "incomplete"
            ? `${row.name}: qualification marked incomplete`
            : `${row.name}: a clarification is wanted`
          : `${row.name}: qualification checklist verified`,
        body: blockedNow
          ? `${note} — the lead is held at qualification until your sales manager looks again.`
          : "Your sales manager has verified the checklist. The lead can move on.",
        kind: blockedNow ? "warn" : "info",
        /* The CHECKLIST rather than the record, which is the convention's
           `/crm/customers/<id>` one rung less precise. The note is the point of
           the bell and this is the screen that quotes it — landing him on the
           record would make him find his own way to the thing he was just told
           about. `/crm` because the two lead workspaces draw the same screen
           and a notification has no workspace to ask. */
        href: `/crm/leads/${customerId}/qualify`,
        /*
         * NO `mbosHref`, deliberately. The obvious guess is `/rejections`, and
         * it would be wrong for the same reason a declined order carries none:
         * that screen renders the handset's own OUTBOX — records refused before
         * they were ever stored — and this lead synced perfectly well. A null
         * falls through to `/notifications`, which carries the note in the body
         * and is the honest default.
         */
      });
    }

    revalidatePath("/sales/leads");
    revalidatePath(`/sales/leads/${customerId}`);
    revalidatePath("/crm/leads");
    revalidatePath(`/crm/leads/${customerId}`);

    return ok(
      null,
      verdict === "verified"
        ? blockedBefore
          ? `Verified — ${row.name} is no longer held at qualification.`
          : "Verified."
        : verdict === "incomplete"
          ? `Marked incomplete. ${row.name} is held at qualification and the salesman has been told why.`
          : `Sent back for clarification. ${row.name} is held at qualification and the salesman has been told what is wanted.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}
