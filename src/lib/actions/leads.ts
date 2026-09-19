"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  customers,
  mbosDocuments,
  leadVerificationCorrections,
  mbosLeadValidations,
  mbosTasks,
  notifications,
  users,
} from "@/db/schema";
import {
  assertCustomerInScope,
  canAny,
  requireCapability,
  hatsFor,
} from "@/lib/access-control";
import { today } from "@/lib/recompute";
import { getConfig } from "@/lib/config/store";
import { writeTimelineEvent, MBOS_EVENT } from "@/lib/timeline";
import { err, fromThrown, ok, type FieldError, type Result } from "@/lib/result";
import {
  COMMUNICATION_ACTIONS,
  FIRST_ORDER_QUESTIONS,
  isVerificationFinding,
  findingLabel as verificationFindingLabel,
  REASON_CODE_NEEDING_REMARKS,
  salesTypeIsOffered,
  salesTypeLabel,
  stageLabel,
  VERIFICATION_COLUMNS,
  VERIFICATION_QUESTIONS,
  verificationVerdictFor,
  type LeadSalesType,
  type VerificationOutcome,
  VERIFICATION_FAILED_CODE,
  type LeadStage,
} from "@/lib/lead-labels";
import { checklistFor } from "@/lib/engines/lead-gates";
import { commitmentGap, commitmentState } from "@/lib/lead-commitment";
import { isParked, ladderFor, rungOf } from "@/lib/engines/lead-ladder";
import {
  applyLeadStageMove,
  evaluateLeadStageMove,
  leadGateInput,
  leadManagerCandidates,
  leadRow,
  type LeadRow,
} from "@/lib/services/lead-service";
import { LEAD_BULK_CAP } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * Every write the lead funnel makes from a browser.
 *
 * The centrepiece is `advanceLeadStage`, and everything else in this file
 * exists to feed it: the eight prospect answers, the twelve qualification
 * ticks, the next action, the manager's verification call. §28's rule is that
 * no lead moves forward only because somebody pressed a button, so the
 * interesting work here is not the moving — it is that the things a gate reads
 * have somewhere honest to be written down.
 *
 * The gate itself, and the transition it produces, are in
 * `lib/services/lead-service.ts`. A stage move arrives from a console button
 * and from a salesman's outbox, authenticated two completely different ways,
 * and it is ONE act — so the two callers share the reading and the write and
 * differ only in how they establish who is asking. That file's own header says
 * why it cannot live here.
 *
 * `lead.work` throughout, which every telecaller and every field salesman
 * holds: a funnel only a manager can advance is a funnel nobody updates.
 * Passing a shut gate and recording the verification call are `lead.override`
 * and `lead.verify`, and both are checked in the action rather than by hiding a
 * control — a server action is a URL.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

function refresh(customerId: string) {
  try {
    revalidatePath("/sales/leads");
    revalidatePath(`/sales/leads/${customerId}`);
    revalidatePath("/crm/customers");
    revalidatePath("/crm/customers/[id]", "page");
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/**
 * The lead, checked for scope, or the refusal to hand back.
 *
 * Scope is asked through `assertCustomerInScope` rather than by comparing an
 * owner id, because that function names every seat a person may hold on a
 * record and this file must not become a second, narrower opinion about who may
 * work an account.
 */
async function reachableLead(
  customerId: string,
): Promise<{ ok: true; lead: LeadRow } | { ok: false; refusal: ReturnType<typeof err> }> {
  const lead = await leadRow(customerId);
  if (!lead) {
    return { ok: false, refusal: err("That lead is not on MahekOne.", "not_found") };
  }
  await assertCustomerInScope({
    kind: lead.kind,
    ownerId: lead.ownerId,
    salesAmId: lead.salesAmId,
    backOfficeAmId: lead.backOfficeAmId,
  });
  return { ok: true, lead };
}

/** Which hats this person is wearing, for the two manager-only questions. */
async function holdsOverride(user: { id: string; role: string }): Promise<boolean> {
  return canAny(await hatsFor(user), "lead.override");
}

/* ═══════════════════════════════════════════════════ §28 the move itself */

const nextActionSchema = z.object({
  action: z.string().trim().min(1).max(300),
  /** A stored DATE, so a date string — never a JS `Date` bound into SQL. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day as a date."),
  ownerId: z.string().min(1),
  outcome: z.string().trim().max(500).optional(),
});

const advanceSchema = z.object({
  customerId: z.string().min(1),
  to: z.string().min(1),
  reasonCode: z.string().trim().max(80).optional(),
  note: z.string().trim().max(2000).optional(),
  override: z
    .object({
      reasonCode: z.string().trim().min(1).max(80),
      note: z.string().trim().max(2000).optional(),
    })
    .optional(),
  nextAction: nextActionSchema.optional(),
  /**
   * §— the facts that make On Hold a pause. Demanded below when the move is a
   * park, and meaningless on any other move.
   *
   * **THE REMARKS ARE NO LONGER MANDATORY BY THEMSELVES, and that is Mahek's
   * answer rather than a loosening.** They used to be the only answer to "why
   * has this stopped", so they had to be there or a park said nothing at all.
   * The WHICH has moved onto `reasonCode` — one of six, from
   * `leads.holdReasons`, validated below — and that is what makes "how many
   * genuine opportunities did we park for a plant shutdown this quarter" a
   * question somebody can ask rather than a grep over five hundred characters
   * of free text. The sentence stays, because no list of six says "their buyer
   * is on maternity leave until October" and that is what the person picking
   * the lead up on the resume date actually reads. It becomes mandatory again
   * on `other`: a code meaning "something else" with nothing behind it is the
   * one row in the count nobody can act on and nobody can explain.
   */
  hold: z
    .object({
      reason: z.string().trim().max(500).optional(),
      resumeDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day it should come back as a date."),
    })
    .optional(),
});

/**
 * Move a lead to a rung, or say what is standing in the way.
 *
 * A refusal carries the MISSING CONDITIONS, one per `fieldError`, keyed by the
 * condition id — because a refusal that does not say what is missing teaches a
 * salesman to press the button again rather than to do the work. That is §28's
 * whole point and it is why the gate returns a list rather than a boolean.
 *
 * The next action, where one is supplied, is applied BEFORE the gate is asked.
 * §24 demands that an active lead never sits with nothing owed by anybody, and
 * a screen that made somebody save the next action, watch the move be refused
 * for want of it, and press again would be enforcing the rule by making it
 * annoying rather than by making it happen.
 */
export async function advanceLeadStage(input: {
  customerId: string;
  to: LeadStage;
  reasonCode?: string;
  note?: string;
  override?: { reasonCode: string; note?: string };
  nextAction?: { action: string; date: string; ownerId: string; outcome?: string };
  /**
   * §— the two facts a park demands, beside the next action it also demands.
   *
   * HAND-WRITTEN BESIDE A ZOD SCHEMA THAT ALREADY KNEW, which is the shape of
   * bug worth naming: `advanceSchema` gained `hold` and this parameter type did
   * not, so the runtime demanded a field TypeScript refused to let anybody
   * pass. Nothing was red — the action compiled, its own tests compiled, and
   * the only thing that could not compile was a screen that had not been
   * written yet. The first caller found it and had to cast its way past.
   *
   * The two are written out twice because this signature is deliberately
   * narrower than the schema's inferred type at three points (`to` is a
   * `LeadStage` rather than a string here). That is worth having, and the cost
   * is exactly this: a field added to one and not the other.
   */
  hold?: { reason?: string; resumeDate: string };
}): Promise<Result<{ stage: LeadStage; promoted: boolean }>> {
  try {
    const parsed = advanceSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(p.customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    const to = p.to as LeadStage;
    /*
     * `lost` AND `on_hold` are the two destinations that are not rungs, and
     * leaving the second out of this guard is what made parking impossible from
     * this door for as long as the door existed. A park is a PAUSE — it
     * displaces the rung rather than being one, which is exactly why
     * `lead-ladder.ts` puts `on_hold` on no ladder and why `isParked` exists —
     * so asking whether it is on this lead's ladder is asking the wrong
     * question and getting the wrong answer: every park was refused with "On
     * hold is not a rung on this lead's ladder", which reads as the app being
     * broken because it is. Asked through `isParked` rather than by name, so a
     * second parked-like stage cannot be added to the enum and quietly miss it.
     */
    if (
      !ladderFor(lead.leadSalesType as LeadSalesType | null).includes(to) &&
      to !== "lost" &&
      !isParked(to)
    ) {
      return err(
        `${stageLabel(to)} is not a rung on this lead's ladder.`,
        "rule_violation",
      );
    }

    const gate = await leadGateInput(p.customerId);
    if (!gate) return err("That lead is not on MahekOne.", "not_found");

    /* The supplied next action counts towards §24 immediately, and is written
       below in the same transaction as the move — so the gate is never asked
       about a state the save is not about to create. */
    const withNextAction = p.nextAction
      ? {
          ...gate,
          nextAction: p.nextAction.action,
          nextActionDate: p.nextAction.date,
          nextActionOwnerId: p.nextAction.ownerId,
        }
      : gate;

    /*
     * §— PARKING DEMANDS THREE ANSWERS, AND ONLY FROM THIS DOOR.
     *
     * Mahek's instruction: a lead going On Hold says WHY it stopped, WHEN it
     * comes back, and WHAT happens when it does. The three are one rule —
     * a reason with no date is a lead that sits for six months because "back
     * after Diwali" is a sentence nobody is watching; a date with nothing
     * scheduled is a lead that comes back to nobody.
     *
     * Checked HERE and deliberately not in `evaluateLeadStageMove`, which the
     * HANDSET shares. An APK cannot be recalled, so phones in the field go on
     * parking leads the way the build in somebody's pocket knows how, and
     * refusing those would turn a salesman recording a real plant shutdown
     * into a rejection he can do nothing about. The handset has always
     * demanded its own reason; the other two are asked where they can be.
     *
     * §24 already demands a next action on every upward move, and a park is
     * not one — so it is demanded again, by name, rather than assumed.
     *
     * **THE WHY IS NOW A CODE, and it is validated against CONFIGURATION.**
     * Mahek asked for a controlled list so the parks can be counted: four of
     * the six are the customer's doing and two are ours to chase, and that
     * split is the whole value of counting them. The list is
     * `leads.holdReasons` and it is read from `getConfig()` rather than from
     * `HOLD_REASONS`, for the reason `MarkLost` states one control along — a
     * deployment that has reworded the list would otherwise have its own
     * codes refused here while the picker went on offering them, and the
     * refusal reads as the app being broken rather than as the list having
     * moved.
     *
     * **`other` DEMANDS THE SENTENCE.** It is the only code that answers
     * nothing on its own, so a park carrying it and no remarks is a row in the
     * count that nobody can act on, nobody can explain and nobody can fold
     * back into one of the other five later. Refused by name so the message
     * lands under the remarks box rather than under the list.
     */
    if (to === "on_hold") {
      const missing: FieldError[] = [];
      const holdCodes = (await getConfig())["leads.holdReasons"];
      const code = p.reasonCode ?? "";
      if (!code || !holdCodes.some((r) => r.code === code)) {
        missing.push({ field: "reasonCode", message: "Why is it stopping?" });
      }
      if (code === REASON_CODE_NEEDING_REMARKS && !p.hold?.reason?.trim()) {
        missing.push({
          field: "holdReason",
          message: "You picked Other — say in words what it actually is.",
        });
      }
      if (!p.hold?.resumeDate) {
        missing.push({ field: "holdResumeDate", message: "When should it come back?" });
      }
      if (!p.nextAction) {
        missing.push({ field: "nextAction", message: "What happens when it does?" });
      }
      if (missing.length) {
        return {
          ok: false,
          error:
            "On hold is a pause, not a quiet death. Pick why it stopped, name the day it comes back, and say what happens when it does — otherwise it comes back to nobody.",
          code: "validation",
          fieldErrors: missing,
        };
      }
    }

    const decision = await evaluateLeadStageMove({
      lead,
      gate: withNextAction,
      to,
      reasonCode: p.reasonCode ?? null,
      override: p.override ?? null,
      canOverride: await holdsOverride(ctx.user),
    });

    if (!decision.ok) {
      return {
        ok: false,
        error: decision.message,
        code: decision.code === "gate_shut" ? "rule_violation" : "validation",
        fieldErrors: decision.missing.map<FieldError>((c) => ({
          field: c.id,
          message: c.says,
        })),
      };
    }

    /*
     * An override is a manager's, so it is asked for a SECOND time here — with
     * the capability rather than with the union answer above. `requireCapability`
     * is what writes the denial to the audit log and what returns the narrowest
     * hat that carried it, and stamping the transition with the hat is the
     * whole reason overrides are allowed at all.
     */
    /* Both halves — an override is the one move where WHICH hat allowed it is
       the whole point of recording it at all. */
    const overrode =
      decision.kind === "overridden" || decision.kind === "reverted"
        ? await requireCapability("lead.override")
        : ctx;
    const authorisedBy = { app: overrode.authorisedIn, role: overrode.authorisedBy };

    const result = await applyLeadStageMove(
      { userId: ctx.user.id, hat: authorisedBy, sourceApp: "crm" },
      lead,
      to,
      {
        decision,
        reasonCode: p.reasonCode ?? p.override?.reasonCode ?? null,
        note: p.note ?? p.override?.note ?? null,
        nextAction: p.nextAction ?? null,
        /* Written by the same transaction that moves the rung: a park that
           saved and a reason that failed a moment later would leave a lead
           stopped with nothing saying why. */
        hold: p.hold ?? null,
        day: await today(),
      },
    );

    refresh(p.customerId);
    return ok(
      { stage: to, promoted: result.promoted },
      result.promoted
        ? `${lead.name} is on the book — they are a customer from today.`
        : `Moved to ${stageLabel(to)}.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * MOVING A SELECTION OF LEADS TO ONE RUNG, THROUGH THE GATE EACH TIME.
 *
 * §28's whole point is that no lead moves forward because somebody pressed a
 * button, and a bulk control is the most tempting place in the product to
 * quietly make an exception — twenty leads, one button, one write, and the
 * checklist skipped on every one of them. So there is no second path here:
 * each lead goes through {@link advanceLeadStage}, which asks the gate, refuses
 * where conditions are missing, writes the transition and the timeline row, and
 * demands a manager plus a reason for an override exactly as it does on a
 * record screen.
 *
 * What the batch adds is the ANSWER. A result that only says "12 of 20" is one
 * nobody can act on, so the leads that did not move come back named with the
 * sentence the gate gave — the same sentence the record page would have
 * printed, so a manager reading it knows where to go next.
 *
 * It is SEQUENTIAL rather than parallel deliberately. Each move writes a
 * transition, a timeline row and possibly a promotion to customer, and twenty
 * of those racing through one pool is how a connection limit becomes a partial
 * batch nobody can reconstruct.
 */
export async function bulkAdvanceLeadStage(input: {
  customerIds: string[];
  to: LeadStage;
  reasonCode?: string;
  note?: string;
}): Promise<Result<{ done: number; failed: Array<{ id: string; name: string; why: string }> }>> {
  try {
    /* The cap is the SELECTION'S own, read from the same place the screen
       reads it. Two different numbers means "Select all 200" is followed by a
       button reading "Apply to 200" and a server that moves a hundred, with
       the rest neither moved nor refused — a lead nobody attempted is not a
       refusal, so the answer comes back a clean success. */
    const ids = Array.from(new Set(input.customerIds.filter(Boolean))).slice(0, LEAD_BULK_CAP);
    if (!ids.length) return err("Nothing selected.", "validation");

    /* ASKED BEFORE ANYTHING IS READ. A name lookup in front of the capability
       check answers with the real shop and company name of every id somebody
       cares to guess, and does it from behind a refusal that looks like it is
       working. */
    await requireCapability("lead.work");

    let done = 0;
    const failed: Array<{ id: string; name: string; why: string }> = [];
    for (const id of ids) {
      const result = await advanceLeadStage({
        customerId: id,
        to: input.to,
        reasonCode: input.reasonCode,
        note: input.note,
      });
      if (result.ok) {
        done += 1;
        continue;
      }
      /* A lead this person cannot reach is never NAMED. `reachableLead` throws
         on a scope failure, which is the answer: the refusal still comes back,
         carrying nothing about a record they were not allowed to look at. */
      let name = "A lead";
      try {
        const reach = await reachableLead(id);
        if (reach.ok) name = reach.lead.name;
      } catch {
        /* out of scope — leave it unnamed */
      }
      failed.push({ id, name, why: result.error });
    }

    const head = `${done} ${done === 1 ? "lead" : "leads"} moved to ${stageLabel(input.to)}.`;
    if (!failed.length) return ok({ done, failed }, head);
    const shown = failed
      .slice(0, 3)
      .map((f) => `${f.name} — ${f.why}`)
      .join("; ");
    const more = failed.length > 3 ? ` and ${failed.length - 3} more` : "";
    return ok({ done, failed }, `${head} ${failed.length} did not move: ${shown}${more}`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═════════════════════════════════════════════════════ §2 which ladder */

/**
 * Which of the three ways we are selling to this account.
 *
 * Asked before anything else, because it decides which questions the rest of
 * the form puts and which rungs the lead climbs. Changing it LATER is the
 * interesting case and the reason this is its own action: a lead half way up
 * the distributor ladder does not become a paint shop because somebody tapped a
 * different chip, and thirty answered conditions on `distributor_profiles`
 * suddenly stop being what the gates read.
 *
 * So above `prospect` it takes a manager and a reason. Below it, nothing has
 * been established that the change could throw away — a Suspect is a shop
 * somebody walked into — and demanding a manager for the correction of a
 * first-visit mistake is how salesmen learn to raise a second lead instead.
 *
 * The STAGE is deliberately left alone. `nextStage` answers the FOOT of the new
 * ladder for a lead standing on a rung that is not on it, which is exactly what
 * this state needs and is why the engine was written that way: the record has a
 * button and a sentence rather than no button and no explanation.
 */
export async function setLeadSalesType(
  customerId: string,
  salesType: LeadSalesType,
  reason?: string,
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        customerId: z.string().min(1),
        salesType: z.enum(["direct", "distributor", "third_party"]),
        reason: z.string().trim().max(2000).optional(),
      })
      .safeParse({ customerId, salesType, reason });
    if (!parsed.success) return zodErr(parsed.error);

    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;
    const was = lead.leadSalesType as LeadSalesType | null;
    if (was === salesType) return ok(null, "That is already the sales type.");

    /*
     * A RETIRED LADDER CANNOT BE MOVED ONTO, and this is checked here rather
     * than left to the sheets that no longer draw the chip, because a server
     * action is a URL and a handset in somebody's pocket cannot be recalled —
     * an APK built before Mahek's decision goes on offering Distributor and
     * goes on posting it here.
     *
     * Mahek does not appoint distributors through MahekOne, so a lead started
     * up that nine-rung ladder stalled behind an approval nobody in the
     * building could give; `SALES_TYPES` in `lib/lead-labels.ts` carries the
     * whole of the reasoning and the one line that reverses it.
     *
     * A lead that already IS one is untouched by this. It never reaches here —
     * `was === salesType` has already answered — and every OTHER thing that
     * lead can do, its rung, its gates, its Distributor Profile and its
     * approval chain, is exactly as it was. What is refused is a NEW lead
     * arriving on the ladder, including the far commoner shape of that: a
     * direct lead being moved onto it.
     */
    if (!salesTypeIsOffered(salesType)) {
      return err(
        `${salesTypeLabel(salesType)} is no longer a ladder a lead can be moved onto — Mahek does not appoint distributors through MahekOne. The leads already on it are untouched and still advance.`,
        "rule_violation",
      );
    }

    const stage = lead.leadStage as LeadStage | null;
    const ladder = ladderFor(was);
    const aboveProspect =
      was != null && stage != null && rungOf(stage, was) > ladder.indexOf("prospect");

    if (aboveProspect && stage) {
      if (!(await holdsOverride(ctx.user))) {
        return err(
          `${lead.name} is already at ${stageLabel(stage)}. Changing what kind of sale this is throws away the answers underneath it, so it is a manager's to do.`,
          "not_permitted",
        );
      }
      if (!reason?.trim()) {
        return err(
          "Say why the sales type is changing. A lead this far up its ladder has answers against it that will stop being the ones the gates read.",
          "validation",
        );
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({ leadSalesType: salesType, updatedAt: new Date() })
        .where(eq(customers.id, customerId));

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.salesType.set",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { salesType: was, stage },
        afterState: { salesType, reason: reason ?? null },
      });
    });

    refresh(customerId);
    return ok(null, "Sales type changed.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════ §9 §11 the qualification ticks */

/**
 * The checklist answers, MERGED rather than replaced.
 *
 * Twelve questions are not answered in one sitting — several of them are asked
 * on a second visit, and a form that posted only what was on screen would erase
 * the four somebody established last week. So this takes a patch, and the gate
 * goes on reading the whole object.
 *
 * Ids not on this lead's own checklist are DROPPED and reported as a warning
 * rather than stored. A key no condition reads can never satisfy a gate, so
 * storing it is a tick beside nothing — which is the exact state
 * `lib/engines/lead-gates.ts` exists to make impossible.
 */
export async function saveLeadQualification(
  customerId: string,
  answers: Record<string, boolean | string>,
): Promise<Result<null>> {
  try {
    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    const known = new Set(
      checklistFor(lead.leadSalesType as LeadSalesType | null, "qualification").map((c) => c.id),
    );
    const kept: Record<string, boolean | string> = {};
    const dropped: string[] = [];
    for (const [id, value] of Object.entries(answers ?? {})) {
      if (!known.has(id)) dropped.push(id);
      else if (typeof value === "boolean" || typeof value === "string") kept[id] = value;
    }

    const merged = { ...(lead.leadQualification ?? {}), ...kept };
    const day = await today();

    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({ leadQualification: merged, leadLastActivityDate: day, updatedAt: new Date() })
        .where(eq(customers.id, customerId));

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.qualification.save",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: lead.leadQualification,
        afterState: merged,
      });
    });

    refresh(customerId);
    return {
      ok: true,
      data: null,
      message: "Saved.",
      warnings: dropped.length
        ? [
            `${dropped.length} answer${dropped.length === 1 ? "" : "s"} did not match anything this lead is asked, so ${
              dropped.length === 1 ? "it was" : "they were"
            } not saved: ${dropped.join(", ")}.`,
          ]
        : undefined,
    };
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════ §6 the eight prospect answers */

const prospectFieldsSchema = z.object({
  customerType: z
    .enum(["dealer", "manufacturer", "distributor", "retailer"])
    .nullish(),
  monthlyLitres: z.number().int().nonnegative().nullish(),
  potentialPaise: z.number().int().nonnegative().nullish(),
  competitor: z.string().trim().max(200).nullish(),
  requiredProductId: z.string().min(1).nullish(),
  contactPerson: z.string().trim().max(200).nullish(),
  decisionMaker: z.string().trim().max(200).nullish(),
  creditDaysWanted: z.number().int().min(0).max(365).nullish(),
  application: z.string().trim().max(500).nullish(),
  gstin: z.string().trim().max(20).nullish(),
  companyName: z.string().trim().max(200).nullish(),
});

/**
 * §6's answers, which are COLUMNS and not checklist ticks.
 *
 * Every one of them is asked about on a list or in a report — "which leads want
 * Nano", "what is the pipeline worth in litres" — and the gate reads the VALUES
 * for exactly that reason: a tick beside an empty field is the state the whole
 * engine exists to stop.
 *
 * A field left out of the patch is UNCHANGED; a field sent as null is cleared.
 * Those are different instructions and a form that could only express the first
 * would leave a competitor named in error on the record for ever.
 */
export async function saveProspectFields(
  customerId: string,
  fields: z.infer<typeof prospectFieldsSchema>,
): Promise<Result<null>> {
  try {
    const parsed = prospectFieldsSchema.safeParse(fields ?? {});
    if (!parsed.success) return zodErr(parsed.error);
    const f = parsed.data;

    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;

    const set: Partial<typeof customers.$inferInsert> = {
      leadLastActivityDate: await today(),
      updatedAt: new Date(),
    };
    if (f.customerType !== undefined) set.customerType = f.customerType;
    if (f.monthlyLitres !== undefined) set.leadMonthlyVolumeLitres = f.monthlyLitres;
    if (f.potentialPaise !== undefined) set.leadEstimatedPotentialPaise = f.potentialPaise;
    if (f.competitor !== undefined) set.leadCompetitor = f.competitor;
    if (f.requiredProductId !== undefined) set.leadRequiredProductId = f.requiredProductId;
    if (f.contactPerson !== undefined) set.contactPerson = f.contactPerson;
    if (f.decisionMaker !== undefined) set.leadDecisionMaker = f.decisionMaker;
    if (f.creditDaysWanted !== undefined) set.leadCreditDaysWanted = f.creditDaysWanted;
    if (f.application !== undefined) set.leadApplication = f.application;
    if (f.gstin !== undefined) set.gstin = f.gstin;
    if (f.companyName !== undefined) set.companyName = f.companyName;

    await db.transaction(async (tx) => {
      await tx.update(customers).set(set).where(eq(customers.id, customerId));
      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.prospectFields.save",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        afterState: f,
      });
    });

    refresh(customerId);
    return ok(null, "Saved.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═════════════════════════════════════════════════════ §24 the next action */

/**
 * What happens next, on what day, and who is doing it.
 *
 * Three answers rather than a date, and that is the whole rule: a date alone is
 * what this had before, and a date alone is how a lead sits for six weeks with
 * everybody assuming somebody else is holding it. The outcome — what that
 * person is expected to come back with — is optional, because a call that has
 * not happened yet does not always have a stated objective and demanding one
 * produces a box people type a full stop into.
 */
export async function setLeadNextAction(
  customerId: string,
  next: { action: string; date: string; ownerId: string; outcome?: string },
): Promise<Result<null>> {
  try {
    const parsed = nextActionSchema.safeParse(next);
    if (!parsed.success) return zodErr(parsed.error);
    const n = parsed.data;

    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;

    const [owner] = await db
      .select({ id: users.id, active: users.active })
      .from(users)
      .where(eq(users.id, n.ownerId))
      .limit(1);
    if (!owner || !owner.active) {
      return err(
        "The next action has to be owed by somebody who can sign in and see it.",
        "validation",
      );
    }

    await db
      .update(customers)
      .set({
        leadNextAction: n.action,
        leadNextActionDate: n.date,
        leadNextActionOwnerId: n.ownerId,
        leadNextActionOutcome: n.outcome ?? null,
        leadLastActivityDate: await today(),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, customerId));

    /* The owner is told, and it is not a courtesy: work has arrived on their
       list without them asking for it, and the first they would otherwise know
       is a lead going overdue against their name. */
    if (n.ownerId !== ctx.user.id) {
      await db.insert(notifications).values({
        id: gen("ntf"),
        userId: n.ownerId,
        title: `Next action on ${found.lead.name}`,
        body: `${n.action} — due ${n.date}.`,
        kind: "info",
        href: `/crm/customers/${customerId}`,
      });
    }

    refresh(customerId);
    return ok(null, "Next action set.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════ §4 Prospect or not */

/**
 * §4 — the Suspect decision, which is a DEMAND rather than a refusal.
 *
 * Two visits to work out whether there is anything here, three at the outside,
 * and then the lead turns into a single question with two answers. Nothing is
 * being blocked at the cap — `mustDecideSuspect` reports it separately from a
 * gate for that reason — and both answers are moves the engine already allows.
 * What this action adds over calling `advanceLeadStage` directly is the MARK:
 * `leadSuspectDecidedAt` is what stops the lead being turned back into that
 * question every morning after it has been answered.
 *
 * The mark is written after the move rather than inside it. If it fails, the
 * lead has still moved and `mustDecideSuspect` only ever fires at `suspect`, so
 * the failure costs nothing — whereas a mark written first on a move that was
 * then refused would silence the question with nothing decided.
 */
export async function decideSuspect(
  customerId: string,
  decision: { prospect: boolean; reasonCode: string; note?: string },
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        prospect: z.boolean(),
        reasonCode: z.string().trim().min(1).max(80),
        note: z.string().trim().max(2000).optional(),
      })
      .safeParse(decision);
    if (!parsed.success) return zodErr(parsed.error);
    const d = parsed.data;

    const moved = await advanceLeadStage({
      customerId,
      to: d.prospect ? "prospect" : "lost",
      reasonCode: d.reasonCode,
      note: d.note,
    });
    if (!moved.ok) return moved;

    await db
      .update(customers)
      .set({ leadSuspectDecidedAt: new Date(), updatedAt: new Date() })
      .where(eq(customers.id, customerId));

    refresh(customerId);
    return ok(null, 
      d.prospect
        ? "Recorded as a prospect."
        : "Closed, with the reason recorded.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * §4's third answer: it is still a Suspect, and here is why.
 *
 * The cap ASKS rather than refuses — that is the whole shape of §4 — so there
 * have always been three answers to it: Prospect, Not a Prospect, and "not yet,
 * because …". `decideSuspect` carries the first two, both of which are moves,
 * and the third was reachable only from a handset: the sole writer of
 * `lead_hold_reason` was the visit path in `actions/mbos.ts`. A manager working
 * the Suspect-decisions queue at a desk could read that a lead was past its cap
 * and could not record the one answer that is usually true.
 *
 * It deliberately does NOT move the stage. A lead nobody has decided about is
 * still a Suspect; parking it at `on_hold` would take it off the queue that
 * exists to keep asking, which is the opposite of what the cap is for.
 * `lead_hold_reason` is the same column that answers "why is this parked",
 * because it is the same question asked at two different rungs.
 *
 * FREE TEXT, not a code, and that is not an oversight. The four coded lists
 * exist so somebody can count an answer later — "how many did we lose on credit
 * terms" — and there is nothing to count here: the useful content is "owner is
 * abroad until Diwali", which is a sentence and a date. It is also what the
 * handset already writes into this column, and two spellings of one column is
 * how a report comes to disagree with itself.
 */
export async function keepAsSuspect(
  customerId: string,
  reason: string,
): Promise<Result<null>> {
  try {
    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    const parsed = z.string().trim().min(3).max(2000).safeParse(reason);
    if (!parsed.success) return zodErr(parsed.error);

    /*
     * Only the two rungs the cap applies to. A qualified prospect visited a
     * fourth time is a negotiation rather than a stall and must never be asked
     * to justify itself — and a lead already past qualification carrying a
     * "still a suspect" note would read on its record as somebody having gone
     * backwards.
     */
    if (lead.leadStage !== "suspect" && lead.leadStage !== "contacted") {
      return err(
        "This lead is past the Suspect rungs, so there is nothing to keep it at. " +
          "Parking a lead that is genuinely stuck is the On hold move on its record.",
      );
    }

    const day = await today();

    /*
     * The previous reason, for the audit's before-state. `reachableLead` does
     * not carry this column, and an audit row that recorded only the new value
     * would not answer the question it exists for: whether somebody replaced a
     * reason, and what it used to say.
     */
    const [previous] = await db
      .select({ holdReason: customers.leadHoldReason })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);

    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadHoldReason: parsed.data,
          leadLastActivityDate: day,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customerId));

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.suspect.kept",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { leadHoldReason: previous?.holdReason ?? null },
        afterState: { leadHoldReason: parsed.data },
      });
    });

    refresh(customerId);
    return ok(null, "Kept as a Suspect, with the reason recorded.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════ §7 the lead manager */

/**
 * Who owes the verification call, the nurture tasks and the files.
 *
 * Defaulted from `mbos_manager_territories` when no id is named, and **no rows
 * for a manager means national** — the rule that table already carries, and the
 * reason it could ship without changing the meaning of a single existing grant.
 * A manager whose territories are all somewhere else is not offered: they cover
 * a different part of the country, and defaulting to them would make the
 * default meaningless.
 *
 * `lead.work` rather than a manager's, and the reasoning is one level along
 * from `customer.assignSalesManager`. That seat could be a manager's because it
 * drives nothing — no queue, no scope, no target. This one drives a WORKLIST
 * and nothing else: no money moves, no book changes hands, and no target counts
 * differently. Holding it back would mean a salesman reaching Prospect on a
 * Saturday has to wait until Monday for somebody to press a button.
 */
export async function assignLeadManager(
  customerId: string,
  managerId?: string,
): Promise<Result<null>> {
  try {
    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    let chosen = managerId ?? null;
    if (!chosen) {
      const candidates = await leadManagerCandidates(lead.territoryRegion);
      chosen = candidates[0]?.id ?? null;
      if (!chosen) {
        return err(
          "Nobody covers this lead's region and there is no national sales manager to fall back on. Set a territory in the console, or name somebody.",
          "not_found",
        );
      }
    } else {
      const [m] = await db
        .select({ id: users.id, role: users.role, active: users.active })
        .from(users)
        .where(eq(users.id, chosen))
        .limit(1);
      if (!m || !m.active || m.role === "associate") {
        return err(
          "A lead manager has to be a sales manager who can sign in and work the list.",
          "validation",
        );
      }
    }

    if (lead.leadManagerId === chosen) return ok(null, "Already theirs.");

    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadManagerId: chosen,
          leadManagerDecidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customerId));

      if (chosen !== ctx.user.id) {
        await tx.insert(notifications).values({
          id: gen("ntf"),
          userId: chosen!,
          title: `${lead.name} is yours to verify`,
          body: `You are the lead manager for ${lead.name}. The verification call is the first thing owed on it.`,
          kind: "info",
          href: `/crm/customers/${customerId}`,
        });
      }

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.manager.assign",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { leadManagerId: lead.leadManagerId },
        afterState: { leadManagerId: chosen, defaulted: !managerId },
      });
    });

    refresh(customerId);
    return ok(null, "Lead manager set.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════ §8 the verification call */

/**
 * The sales manager rings the customer, and writes down the twelve answers.
 *
 * `lead.verify` is a manager's, and two of the twelve are the reason: "did our
 * salesman actually visit" and "did he explain Mahek properly" are questions
 * about the salesman rather than about the sale, and a check somebody performs
 * on their own work is not a check.
 *
 * `follow_up` closes NOTHING. The salesman gets a task with the manager's own
 * words on it, because a notification can be missed and a task on the list
 * cannot — and the lead stays exactly where it is. The answers are kept
 * whichever way the verdict went: "which competitor did he say he was using" is
 * what somebody needs before the negotiation call, and it does not stop being
 * useful because the visit could not be confirmed.
 *
 * `not_qualified` IS A THIRD OUTCOME AND IT IS NOT THE ONE ABOVE IN STRONGER
 * WORDS. This action used to store `pending` on every unsuccessful call, and
 * the comment beside it argued — correctly — that a failed verification means
 * the VISIT could not be confirmed, which is a statement about our own salesman,
 * and that closing the lead on the strength of not reaching him would be the
 * office writing off a customer for an internal failure. That reasoning is
 * untouched and `follow_up` still carries it. What Mahek asked for is the case
 * it never covered: the OPPORTUNITY itself is false — the shop denies any such
 * visit or requirement, the business is not there, the contact was invented, the
 * row was raised in error. There is nothing to work and nobody to ring, so the
 * lead is closed as lost.
 *
 * Three things follow from that, and each of them is the same rule something
 * else in this file already obeys. It DEMANDS A REASON IN WRITING, checked here
 * and not only on the form, exactly as a lost lead, an On Hold and a rejected
 * sample all do, and for the same reason: the next lead from that source goes
 * the same way otherwise. It closes the lead through `advanceLeadStage`, so the
 * §26 reason code is validated against the CONFIGURED list, the transition is
 * appended to `lead_stage_transitions` like every other move, and there is no
 * second path to `lost` for somebody to fix one of later. And it stays
 * `lead.verify`, a manager's — a salesman who could close his own leads as
 * fabrications would be marking his own work, which is the argument the
 * capability exists for in the first place.
 *
 * IT WRITES MAIN'S TABLE, and that is the whole of what changed here. Two
 * teams built §8 at once: this one stored the twelve answers as jsonb on a
 * `lead_manager_calls` table of its own, main stored the same call on
 * `mbos_lead_validations` with named columns and shipped first. One
 * implementation per concept — main's row is where a verification call lives,
 * from the web form and from the handset both, so the two doors onto the same
 * act cannot report different histories for one lead. `VERIFICATION_COLUMNS`
 * in `lib/lead-labels.ts` is the one statement of which answer goes where.
 */
export async function recordLeadValidationCall(
  customerId: string,
  call: {
    answers: Record<string, string>;
    outcome: VerificationOutcome;
    /**
     * What the salesman should do about it, or — on `not_qualified` — what the
     * shop actually said. One field rather than two because it is one sentence
     * going to one column, and a second box for the same paragraph is how half
     * of a manager's words end up in a column nobody reads.
     */
    followUpNote?: string;
    /** §26's code, required by the move rather than by this schema. */
    lostReasonCode?: string;
    /** §8 — what the call FOUND. Required on `not_qualified`; the loss code is
     *  fixed and is never the manager's pick. */
    failureReasonCode?: string;
    /**
     * EVERY FINDING THE SHOP CONTRADICTED, one entry per field.
     *
     * The four that have a column on `mbos_lead_validations` land there as
     * well, and that is not a duplicate: the column holds the shop's ANSWER, in
     * the same shape a confirmation would leave it, and this holds the fact
     * that it differed from the salesman's, what his was, and why. The five
     * with no column had nowhere at all to go but a labelled line inside the
     * call's note, which is a sentence rather than an answer — "how many leads
     * had the wrong contact person" is exactly the question §8 exists to
     * produce and `verdict_reason ilike '%contact%'` is not an answer to it.
     *
     * `original` is what the salesman had, sent by the screen that was
     * displaying it. It is a COPY on purpose — see the schema comment on the
     * table: the lead's own column is live and a later visit legitimately
     * overwrites it, so reading it back to find out what was corrected would
     * answer with whatever the field says today.
     */
    corrections?: {
      field: string;
      original?: string | null;
      corrected: string;
      reason: string;
    }[];
  },
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        answers: z.record(z.string(), z.string().trim().max(1000)),
        outcome: z.enum(["verified", "follow_up", "not_qualified"]),
        followUpNote: z.string().trim().max(2000).optional(),
        lostReasonCode: z.string().trim().max(80).optional(),
        /**
         * §8 — WHAT THE CALL ACTUALLY FOUND, and it is a second question from
         * the loss reason rather than a restatement of it.
         */
        failureReasonCode: z.string().trim().max(80).optional(),
        corrections: z
          .array(
            z.object({
              field: z.string().trim().max(80),
              original: z.string().trim().max(1000).nullish(),
              corrected: z.string().trim().min(1).max(1000),
              /*
               * REQUIRED HERE AND NOT ONLY ON THE FORM. The screen already
               * refuses a correction with no reason, and a server action is a
               * URL: a rule that lives in an interface is not a rule. What it
               * buys is the whole value of the row — a correction with nothing
               * behind it is the manager's word against the salesman's with
               * nothing to settle it, read in March by somebody deciding
               * whether the salesman or the shop was mistaken.
               */
              reason: z.string().trim().min(1).max(1000),
            }),
          )
          .max(40)
          .optional(),
      })
      .safeParse(call);
    if (!parsed.success) return zodErr(parsed.error);
    const c = parsed.data;

    const ctx = await requireCapability("lead.verify");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    /* Only the twelve are stored. A thirteenth arriving from a screen somebody
       edited is dropped rather than saved, because the record is read back
       against `VERIFICATION_QUESTIONS` and an answer to a question nobody can
       see is worse than no answer. */
    const known = new Set(VERIFICATION_QUESTIONS.map((q) => q.id));
    const answers: Record<string, string> = {};
    for (const [id, value] of Object.entries(c.answers)) {
      if (known.has(id) && value.trim()) answers[id] = value.trim();
    }

    /*
     * ONLY THE NINE, AND ONE ROW PER FIELD PER CALL.
     *
     * The same discipline the twelve answers get a few lines above, for the
     * same reason: a tenth field arriving from a screen somebody edited is
     * dropped rather than stored, because the summary reads back through
     * `VERIFICATION_FINDINGS` and a correction to a finding nobody can see is
     * worse than no correction. `isVerificationFinding` is the one validator,
     * so the list the screen draws from and the list the action accepts cannot
     * drift apart.
     *
     * A field arriving twice is the same finding answered twice by a form that
     * should not be able to produce it, and the LAST one wins — the manager's
     * final answer rather than a first draft of it. Two rows for one field on
     * one call would read on the summary as a shop that contradicted itself.
     */
    const corrections = new Map<string, { original: string | null; corrected: string; reason: string }>();
    for (const entry of c.corrections ?? []) {
      if (!isVerificationFinding(entry.field)) continue;
      corrections.set(entry.field, {
        original: entry.original?.trim() || null,
        corrected: entry.corrected,
        reason: entry.reason,
      });
    }

    /* Both unsuccessful outcomes demand a sentence, and they demand it for two
       different reasons — which is why the refusals are two sentences rather
       than one about "a note". A follow-up's words become the salesman's task;
       a failed verification's words are the only record anybody will ever have
       of why a real-looking lead was closed, read months later by whoever is
       asked whether the source that produced it is worth buying from again. */
    if (c.outcome === "follow_up" && !c.followUpNote?.trim()) {
      return err(
        "A call that could not confirm the visit has to say what the salesman should do about it — that sentence is what lands on his list.",
        "validation",
      );
    }
    if (c.outcome === "not_qualified" && !c.followUpNote?.trim()) {
      return err(
        "Closing a lead as a false opportunity has to say what the shop actually said. Without it the record shows a lead somebody killed on a phone call, and the next lead from the same source goes exactly the same way.",
        "validation",
      );
    }

    /*
     * §26's code is checked HERE as well, though `advanceLeadStage` below is
     * the authority on it — and the reason is the order of the two writes. The
     * call lands first and the closure follows it, so a missing or misspelt
     * code refused only by the move would leave a verification call recorded
     * against a lead still sitting where it was, with a manager reading a
     * refusal about a reason list he was never shown. The list is the
     * CONFIGURED one at both ends, never a literal, so a team that reworded its
     * reasons cannot be refused here on one spelling and accepted there on
     * another.
     */
    /*
     * §8 — THE LOSS REASON IS NOT PICKED, IT IS `verification_failed`.
     *
     * Mahek's instruction, and it is a correction of what shipped a moment ago:
     * the manager used to choose from the ordinary loss list, and the answer
     * everybody would reach for is "Wrong lead — should not have been raised".
     * Those are two different situations wearing one word. `wrong_lead` is
     * somebody at Mahek raising something that was never a lead — a duplicate
     * typed twice, a supplier filed as a customer. This is the verification
     * CALL finding that the opportunity the salesman reported is not there.
     * Folded together, neither count means anything.
     *
     * So the code is FIXED rather than offered, and what the manager is asked
     * for instead is the FINDING — which is the half that makes the report
     * useful. "Verification failed: 18" is a number; "customer denied the
     * visit: 6, wrong business: 4, duplicate: 3" is something somebody can act
     * on, and each of those points at a different fix.
     *
     * Both read from CONFIGURATION rather than a literal, so a team that
     * reworded either list is not refused here on one spelling.
     */
    let failureReasonCode: string | null = null;
    if (c.outcome === "not_qualified") {
      const config = await getConfig();

      if (!config["leads.lostReasons"].some((r) => r.code === VERIFICATION_FAILED_CODE)) {
        return err(
          "This deployment has no “Verification failed” loss reason configured, so the lead cannot be closed this way. Add it under Settings → Why a lead was lost.",
          "validation",
        );
      }

      const findings = config["leads.verificationFailureReasons"];
      if (!c.failureReasonCode || !findings.some((r) => r.code === c.failureReasonCode)) {
        return err(
          "Say what the call actually found. A failure with no finding behind it is a number with no breakdown, and the breakdown is the half anybody can act on.",
          "validation",
          [{ field: "failureReasonCode", message: "What did the call find?" }],
        );
      }
      failureReasonCode = c.failureReasonCode;
    }

    const callId = gen("lmc");
    const day = await today();

    /*
     * ALL TWELVE ONTO COLUMNS, through the shared mapping rather than spelled
     * out here — the record page reads it back the same way, so the form and
     * the screen cannot disagree about which column holds the price answer.
     * Seven of the twelve are `0116`'s: they spent an afternoon as labelled
     * lines inside `notes`, which is unqueryable, and the report §8 exists to
     * produce is a count of those answers.
     */
    const columns: Record<string, string | null> = {};
    for (const column of Object.values(VERIFICATION_COLUMNS)) columns[column] = null;
    for (const [id, column] of Object.entries(VERIFICATION_COLUMNS)) {
      columns[column] = answers[id] ?? null;
    }

    await db.transaction(async (tx) => {
      await tx.insert(mbosLeadValidations).values({
        id: callId,
        customerId,
        calledByUserId: ctx.user.id,
        /* The call happened — the form is filled in after it. `reached` is
           false only where nobody picked up, which this form cannot express
           because it has twelve answers on it. */
        reached: true,
        salesmanVisited: columns.salesmanVisited,
        mahekExplained: columns.mahekExplained,
        productUnderstood: columns.productUnderstood,
        currentProduct: columns.currentProduct,
        confirmedCompetitor: columns.confirmedCompetitor,
        confirmedRequirement: columns.confirmedRequirement,
        growthPotential: columns.growthPotential,
        salesmanFeedback: columns.salesmanFeedback,
        priceConcern: columns.priceConcern,
        qualityFeedback: columns.qualityFeedback,
        dispatchFeedback: columns.dispatchFeedback,
        genuineInterest: columns.genuineInterest,
        /*
         * `pending` on a follow-up and `not_qualified` only on the third
         * outcome, and the difference is the whole of why there are three.
         * §8 failing means the VISIT could not be confirmed, which raises a
         * follow-up and closes nothing — writing `not_qualified` there would be
         * the office turning down a shop on the strength of not having reached
         * its own salesman. `not_qualified` is the manager saying the
         * opportunity is false, which is a statement about the shop and is the
         * one that closes the lead. One mapping, in `lead-labels.ts`, because
         * the record page reads this column back through its neighbour and two
         * outcomes stored as one word would draw as one thing on it.
         */
        verdict: verificationVerdictFor(c.outcome),
        verdictReason: c.followUpNote ?? null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      /*
       * THE CORRECTIONS, IN THE CALL'S OWN TRANSACTION.
       *
       * A call that landed and corrections that failed a moment later would
       * leave a verification on the record with the shop's contradictions
       * missing — and nothing on the screen saying so, because a call with no
       * corrections is the ordinary case and reads as a report that checked
       * out. The whole call would then have to be made again to record them,
       * and the second row would be a second conversation on a history nobody
       * had two of.
       *
       * NOTHING HERE TOUCHES A `customers` COLUMN, and that is the rule this
       * table exists to keep rather than to bend. `lead_competitor` is what the
       * salesman was told standing in the shop; this is what the office was
       * told on the phone, and the two disagreeing is the single most useful
       * thing the call produces. Writing the corrected value onto the lead
       * would overwrite the first reading with the second and destroy exactly
       * that — so this is a record OF a correction and never an application of
       * one.
       */
      for (const [field, entry] of corrections) {
        await tx.insert(leadVerificationCorrections).values({
          id: gen("lvc"),
          customerId,
          validationId: callId,
          field,
          original: entry.original,
          corrected: entry.corrected,
          reason: entry.reason,
          changedById: ctx.user.id,
          /* Readable after the account is gone, the same reasoning
             `customer_am_changes` keeps its own name column for. */
          changedByName: ctx.user.name,
        });
      }

      const set: Partial<typeof customers.$inferInsert> = {
        leadLastActivityDate: day,
        updatedAt: new Date(),
      };
      if (c.outcome === "verified") {
        set.leadVerifiedAt = new Date();
        set.leadVerifiedById = ctx.user.id;
      }
      await tx.update(customers).set(set).where(eq(customers.id, customerId));

      /* A task ONLY on a follow-up. The third outcome is about to close the
         lead, and a high-priority task on the salesman's list against a shop
         that no longer exists is work he cannot do and cannot close — the same
         noise `raiseReorderFollowUps` guards against one module over. What he
         is owed on a false lead is being TOLD, which is a notification below —
         `applyLeadStageMove` writes one only on a promotion, so a lost lead
         reaches its salesman as a row that quietly left his board otherwise. */
      if (c.outcome === "follow_up") {
        /* The salesman on the account — the owner of a lead, which is what
           `ASSIGNED_TO_SQL` reads. Falling back to the sales seat covers a lead
           that has already been promoted and is being re-verified. */
        const assignee = lead.ownerId ?? lead.salesAmId;
        if (assignee) {
          await tx.insert(mbosTasks).values({
            id: gen("mbos_task"),
            title: `Verification follow-up: ${lead.name}`,
            description: c.followUpNote ?? null,
            assignedToUserId: assignee,
            assignedByUserId: ctx.user.id,
            priority: "high",
            dueDate: day,
            customerId,
            sourceType: "lead_verification",
            sourceId: callId,
            createdById: ctx.user.id,
            updatedById: ctx.user.id,
          });
        }
      }

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.validation,
        sourceApp: "crm",
        sourceRecordId: callId,
        occurredAt: new Date(),
        actorUserId: ctx.user.id,
        /*
         * THE THIRD SUMMARY HAS TO BE READABLE IN MARCH, and what it has to be
         * readable AGAINST is an ordinary lost lead. The stage move writes its
         * own row saying the lead was closed and why, and a hundred leads a year
         * carry one; this sentence is the only thing on the customer's history
         * that says the closure came out of a verification call and that what
         * was found was a false opportunity rather than a customer who chose
         * somebody else. It names the call, the finding and the manager's own
         * words, because a reader who has to open three records to tell those
         * two apart is a reader who does not bother.
         */
        summary:
          c.outcome === "verified"
            ? `Sales manager verified ${lead.name} by phone.`
            : c.outcome === "follow_up"
              ? `Sales manager could not verify ${lead.name} — follow-up raised.`
              : `Verification call found no opportunity at ${lead.name} — the shop did not stand the lead up. Closed as lost. ${c.followUpNote ?? ""}`.trim(),
      });

      /*
       * ONE ENTRY PER CORRECTED FIELD, and the field rides in the SOURCE ID.
       *
       * The natural key is (app, kind, source row), so every correction from
       * one call naming the bare call id would collapse onto a single row: the
       * first written would win and the other three would never appear on the
       * record at all. `<callId>:correction:<field>` is the same shape a
       * sample's dispatched/received/review dates use, for the same reason.
       *
       * The sentence says BOTH readings, because a history that printed only
       * the corrected value would read as the lead having been edited — which
       * is the one thing this call does not do.
       */
      for (const [field, entry] of corrections) {
        await writeTimelineEvent(tx, {
          customerId,
          eventType: MBOS_EVENT.verificationCorrection,
          sourceApp: "crm",
          sourceRecordId: `${callId}:correction:${field}`,
          occurredAt: new Date(),
          actorUserId: ctx.user.id,
          summary: `Verification call corrected ${verificationFindingLabel(field).toLowerCase()} at ${lead.name}: ${
            entry.original ? `the salesman reported “${entry.original}”` : "the salesman had recorded nothing"
          }, the shop says “${entry.corrected}” — ${entry.reason}. The lead still carries the salesman's own answer.`,
        });
      }

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.verify",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        /* The OUTCOME rather than a boolean: `verified: false` said the same
           word about a follow-up and about a false opportunity, and the audit
           log is exactly where somebody goes to ask which of the two a manager
           actually recorded. */
        afterState: {
          callId,
          outcome: c.outcome,
          answered: Object.keys(answers).length,
          /* WHICH fields rather than how many. "Was anybody told the competitor
             was wrong on this lead" is the question an audit log is opened
             with, and a count cannot answer it. */
          corrected: [...corrections.keys()],
        },
      });
    });

    refresh(customerId);

    if (c.outcome !== "not_qualified") {
      return ok(
        null,
        c.outcome === "verified"
          ? "Verified."
          : "Recorded, and the follow-up is on the salesman's list.",
      );
    }

    /*
     * THE CLOSURE GOES THROUGH THE ORDINARY DOOR, after the call is safe.
     *
     * `advanceLeadStage` is the one path to `lost` — it asks the gate engine,
     * validates the §26 code against the configured list, appends to
     * `lead_stage_transitions` and notifies. Writing `lead_stage = 'lost'` here
     * would be a second path, and the second path is always the one that stops
     * writing the transition the day somebody changes the first.
     *
     * It runs OUTSIDE the transaction above and cannot roll it back, which is
     * deliberate and is the same trade the next-step sentence makes on a call:
     * the verification call is evidence of a conversation that really happened,
     * and losing it because a lead was already closed, or already off the
     * funnel, would destroy the record to protect a consequence of it. Where the
     * move is refused the refusal is handed straight back, naming the call as
     * recorded — a manager told only "could not close" would record the call
     * again to try, and the second row would be a second conversation on a
     * history nobody had two.
     */
    /* The finding's own words, resolved from configuration so a reworded list
       reads back correctly on a closure recorded before it was reworded. */
    const findingLabel = failureReasonCode
      ? ((await getConfig())["leads.verificationFailureReasons"].find(
          (r) => r.code === failureReasonCode,
        )?.label ?? failureReasonCode)
      : null;

    const closed = await advanceLeadStage({
      customerId,
      to: "lost",
      /* Fixed, never the manager's pick — see the note above. The FINDING is
         what he was asked for, and it travels in the note so the closure reads
         as what the call found rather than as a bare code. */
      reasonCode: VERIFICATION_FAILED_CODE,
      note: [findingLabel, c.followUpNote].filter(Boolean).join(" — "),
    });
    if (!closed.ok) {
      return err(
        `The call is recorded and the lead is still open: ${closed.error}`,
        "rule_violation",
      );
    }

    /*
     * THE SALESMAN IS TOLD, because the lead he was working has just gone.
     *
     * `applyLeadStageMove` notifies on a PROMOTION and on nothing else, so a
     * lead closed from a desk leaves its owner's board overnight with nothing
     * anywhere saying why — and this is the one closure he is most likely to
     * want to argue with, since what it says is that the shop denies the visit
     * he recorded. The manager's own words travel IN the message rather than
     * behind a link, the same rule a declined order follows: the reason is the
     * entire content, and a bell that makes somebody open a screen to find out
     * what was said is a bell they read later.
     *
     * It runs after the close, cannot fail it, and is not sent to the manager
     * who just pressed the button — they are looking at the screen that says so.
     */
    const tell = lead.ownerId ?? lead.salesAmId;
    if (tell && tell !== ctx.user.id) {
      try {
        await db.insert(notifications).values({
          id: gen("ntf"),
          userId: tell,
          title: `${lead.name} is closed — the verification call found no opportunity`,
          body: `${lead.name} was rung to verify your visit and the shop did not stand the lead up, so it is closed as lost. ${c.followUpNote ?? ""}`.trim(),
          kind: "warn",
          href: `/crm/customers/${customerId}`,
        });
      } catch {
        /* A courtesy on top of a closure already standing in the ledger. */
      }
    }

    return ok(null, "Recorded. The lead is closed as lost.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════ §14 the communication buttons */

/**
 * One of the eleven things a manager does from the lead page without hunting.
 *
 * The point of the button is that it replaces searching a shared drive for the
 * current price list, so what is RECORDED has to name the document as well as
 * the action — "sent the price list" a month later is unanswerable if nobody
 * knows which price list.
 *
 * It writes a timeline row and nothing else. A communication is not a stage
 * move and must not read as one: sending somebody a brochure is not evidence
 * that anything was qualified, and a funnel that crept upward on the strength
 * of outgoing post would be a funnel measuring our own activity.
 */
export async function recordCommunication(
  customerId: string,
  input: { actionCode: string; documentId?: string; note?: string },
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        actionCode: z.string().trim().min(1).max(80),
        documentId: z.string().min(1).optional(),
        note: z.string().trim().max(2000).optional(),
      })
      .safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    const action = COMMUNICATION_ACTIONS.find((a) => a.code === p.actionCode);
    if (!action) {
      return err("MahekOne does not know that communication action.", "validation");
    }

    let documentTitle: string | null = null;
    if (p.documentId) {
      const [doc] = await db
        .select({ title: mbosDocuments.title, active: mbosDocuments.active })
        .from(mbosDocuments)
        .where(eq(mbosDocuments.id, p.documentId))
        .limit(1);
      if (!doc || !doc.active) {
        return err(
          "That document has been withdrawn from the library, so it cannot be recorded as sent.",
          "not_found",
        );
      }
      documentTitle = doc.title;
    } else if (action.kind === "send") {
      return err(
        `"${action.label}" has to name the document that went, or the record cannot say which one a month from now.`,
        "validation",
      );
    }

    /*
     * THE CODE RIDES IN THE SOURCE ID, so the log can be counted and filtered.
     *
     * This wrote a bare `lcm_…` and put the action code only into the audit
     * row. The timeline carried the SENTENCE, and `timeline_events.summary`
     * says in its own schema comment that it is never parsed — so the two rows
     * were written in one transaction and shared no key, and "how many
     * brochures went out this month" was a question the log could not answer
     * about its own contents. The Communication screen had to say so in words.
     *
     * The natural key is (app, kind, source row) and this id is generated
     * fresh per event, so a suffix costs nothing and collides with nothing.
     * It is the same shape AGENTS.md already describes for a sample, where one
     * record produces several events and the STAGE goes in the source id.
     *
     * Rows written before this carry no suffix, which reads as an unknown code
     * rather than as a wrong one — the screen already draws that bucket.
     */
    const eventId = `${gen("lcm")}:${action.code}`;

    await db.transaction(async (tx) => {
      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.leadCommunication,
        sourceApp: "crm",
        sourceRecordId: eventId,
        occurredAt: new Date(),
        actorUserId: ctx.user.id,
        summary: [
          action.label,
          documentTitle ? `— ${documentTitle}` : null,
          p.note ? `: ${p.note}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      });

      await tx
        .update(customers)
        .set({ leadLastActivityDate: await today(), updatedAt: new Date() })
        .where(eq(customers.id, customerId));

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.communication",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        afterState: { actionCode: action.code, documentId: p.documentId ?? null },
      });
    });

    refresh(customerId);
    return ok(null, `Recorded against ${lead.name}.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════ §18 asking for the first order */

/**
 * The eight questions, because "customer interested" is not a report.
 *
 * Each of them has an answer the customer can give on a phone call, and the
 * last four are the four things that actually stop an order. What comes out of
 * it is a DAY and a SIZE, and §3.4 is explicit that the day alone is not a
 * commitment: the salesman records an expected order date AND an expected
 * quantity or an expected value. `lib/lead-commitment.ts` is the one place
 * that rule lives, and every screen that counts one reads it from there.
 *
 * **A DATE ALONE IS STILL RECORDED, AND THAT IS THE POINT OF THE SHAPE.**
 * Mahek's words are that a customer who says "around the 25th" with no
 * quantity is kept as a follow-up and simply does not count as a confirmed
 * commitment — so this action does not refuse it. It writes what it was given
 * and SAYS which of the two it just recorded, because the alternative is a
 * form that throws away the one answer the salesman did come back with. He
 * would then either type a figure nobody gave him or stop recording the call
 * at all, and both of those are worse than an uncounted forecast.
 *
 * **What it DOES refuse is a size with no day**, which is the one shape that
 * cannot be recorded honestly: "two hundred cans" with nothing saying when is
 * a sentence nobody can chase, no sweep can date a task from and no view can
 * put in a week.
 *
 * **`quantity` stopped being a mandatory ANSWER when the column arrived.** It
 * was one of the two the action demanded, which made "he could not say how
 * much" impossible to record at all — the exact state §3.4 asks us to keep.
 * The question stays in the eight and stays free text, because it is the
 * customer's own words in whatever unit he used ("about five hundred litres",
 * "a drum a month"); `expectedCans` is the countable figure beside it, in
 * cans, and only a number can be added up. `product` is still demanded: which
 * product they want is not a quantity nobody knows, it is the half of the
 * report that makes the rest of it mean anything.
 */
export async function askForFirstOrder(
  customerId: string,
  input: {
    answers: Record<string, string>;
    expectedDate: string;
    /** CANS — the unit the customer speaks in. See the schema. */
    expectedCans?: number;
    expectedValuePaise?: number;
  },
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        answers: z.record(z.string(), z.string().trim().max(1000)),
        /* Allowed to be absent so ONE thing refuses it — see below. A regex
           that rejected the empty string here would answer "give the day as a
           date" to somebody who gave no day at all, and §3.4's sentence about
           what a commitment needs would never be the one anybody read. */
        expectedDate: z
          .string()
          .regex(/^(\d{4}-\d{2}-\d{2})?$/, "Give the day as a date.")
          .optional(),
        /* Positive, because zero is a customer declining rather than
           committing, and a commitment of nothing on the forecast board is
           worse than no commitment at all. */
        expectedCans: z.number().int().positive().optional(),
        expectedValuePaise: z.number().int().positive().optional(),
      })
      .safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const found = await reachableLead(customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    const known = new Set(FIRST_ORDER_QUESTIONS.map((q) => q.id));
    const answers: Record<string, string> = {};
    for (const [id, value] of Object.entries(p.answers)) {
      if (known.has(id) && value.trim()) answers[id] = value.trim();
    }

    /* Which product, and it is the one answer still demanded. Without it this
       is the "customer interested" the specification is explicit about
       refusing, and it would set an expected order date behind nothing. */
    if (!answers.product) {
      return {
        ok: false,
        error: "Which product. That is what makes this a report rather than a feeling.",
        code: "validation",
        fieldErrors: [
          {
            field: "product",
            message: FIRST_ORDER_QUESTIONS.find((q) => q.id === "product")!.ask,
          },
        ],
      };
    }

    /*
     * §3.4 CHECKED HERE AND NOT ONLY IN THE FORM, because a server action is
     * a URL and a disabled button is not a rule. The engine answers with the
     * STATE rather than a yes or no, since two of its three answers are
     * recordable and only the third is not — and the message is the engine's
     * own sentence, so the form and the save cannot phrase one rule two ways.
     */
    const facts = {
      expectedOrderDate: p.expectedDate || null,
      expectedOrderCans: p.expectedCans ?? null,
      expectedOrderValuePaise: p.expectedValuePaise ?? null,
    };
    const state = commitmentState(facts);
    if (state === "none" || !p.expectedDate) {
      return {
        ok: false,
        error: commitmentGap({ ...facts, expectedOrderDate: null })!,
        code: "validation",
        fieldErrors: [{ field: "expectedDate", message: "Ask when they will place it." }],
      };
    }

    const eventId = gen("lfo");

    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadExpectedOrderDate: p.expectedDate,
          /*
           * BOTH HALVES ARE WRITTEN EVERY TIME, including as null. This is
           * what the customer said on THIS call, so a figure he gave last
           * month and did not repeat is not still his commitment — leaving
           * the old one standing would let a lead keep a quantity nobody has
           * confirmed since, and the forecast would go on counting it.
           */
          leadExpectedOrderCans: p.expectedCans ?? null,
          leadExpectedOrderValuePaise: p.expectedValuePaise ?? null,
          leadLastActivityDate: await today(),
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customerId));

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.firstOrderAsk,
        sourceApp: "crm",
        sourceRecordId: eventId,
        occurredAt: new Date(),
        actorUserId: ctx.user.id,
        /* The size in the words it was recorded in, and the state said out
           loud: a record that reads "expected 25 Sep" months later cannot
           tell anybody whether that was a promise or a guess. */
        summary:
          `Asked ${lead.name} for the first order — ` +
          [
            answers.quantity ? `${answers.quantity} of ${answers.product}` : answers.product,
            `expected ${p.expectedDate}`,
            p.expectedCans != null ? `${p.expectedCans} cans` : null,
            p.expectedValuePaise != null
              ? `about ${Math.round(p.expectedValuePaise / 100)} rupees`
              : null,
          ]
            .filter(Boolean)
            .join(", ") +
          (state === "confirmed" ? "." : " — no size given, so not a commitment."),
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.firstOrder.ask",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        afterState: {
          answers,
          expectedDate: p.expectedDate,
          expectedCans: p.expectedCans ?? null,
          expectedValuePaise: p.expectedValuePaise ?? null,
          commitment: state,
        },
      });
    });

    refresh(customerId);
    return ok(
      null,
      state === "confirmed"
        ? "Recorded as a commitment. The first-order rung is open once the order arrives."
        : "Recorded as an expected order. With no quantity or value it is a follow-up rather than a commitment, so it is not counted in the forecast.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------------ zod */

/**
 * A validation message goes under the field it names.
 *
 * These dialogs used to pin whatever the server said to whichever box was
 * nearest, which sends somebody to fix what is not broken — worse than no
 * message at all.
 */
function zodErr(error: z.ZodError): ReturnType<typeof err> {
  const fieldErrors = error.issues.map<FieldError>((i) => ({
    field: i.path.join(".") || "form",
    message: i.message,
  }));
  return err(fieldErrors[0]?.message ?? "That is not valid.", "validation", fieldErrors);
}

/* ---------------------------------------------------------------------------
 * §22 — THE HANDOVER LIVES IN `lib/actions/relationship-handover.ts`.
 *
 * This file grew its own `handOverToRelationshipOwner`, which moved
 * `sales_am_id` and released the lead manager in one act. Main had already
 * shipped the same section as its own marker — `relationship_owner_id` and
 * `handed_over_at`, with an `am_role` of `relationship` — and the two are not
 * two features. They are one, answered twice, and the answers disagreed about
 * the thing that matters most: this one moved the SALES SEAT, which decides
 * who is credited for the account's orders and whose target it counts toward,
 * and so had to be refused to managers under `customer.reassign`. Main's moves
 * nobody's numbers, which is exactly why it can be a manager's under
 * `customer.handOver` — and the handover is a manager's job.
 *
 * Keeping both would have meant two ways to hand an account over, one of them
 * silently reassigning revenue. `HandoverPanel` calls
 * `handOverRelationships`.
 * ------------------------------------------------------------------------- */

/*
 * TODO(integration) — three things this file deliberately does not do.
 *
 * 1. Creating the `distributor_profiles` row when a lead picks the distributor
 *    ladder. `saveDistributorProfile` is workstream B's, in
 *    `lib/actions/distributor-appointment.ts`, and a second writer of that row
 *    would be a second opinion about a table with a one-per-customer index.
 *    Until it lands, a distributor lead's §11 gate refuses with all thirty
 *    conditions missing, which is the honest reading of an empty application.
 * 2. Re-running the derived caches after a promotion — the buying cycle, the
 *    queue and the health score all read `kind`. `lib/recompute.ts` is
 *    workstream E's; the nightly pass rebuilds them meanwhile, so the account is
 *    correct by morning rather than by evening.
 * 3. The nurture tasks §13 asks for on reaching Prospect. `lead-nurture.ts` is
 *    workstream B's engine and `mbos-jobs.ts` is where it is wired.
 */
