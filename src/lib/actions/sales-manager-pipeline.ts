"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { customers } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import {
  advanceLeadStage,
  decideSuspect,
  recordLeadValidationCall,
  saveProspectFields,
} from "@/lib/actions/leads";
import {
  confirmSampleReceived,
  recordSampleFeedback,
  requestSample,
} from "@/lib/actions/lead-samples";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { today } from "@/lib/recompute";
import { requireUser } from "@/lib/auth";
import { VERIFICATION_QUESTIONS, isVerificationFinding } from "@/lib/lead-labels";

/* ---------------------------------------------------------------------------
 * TWO THIN ORCHESTRATIONS AND ONE ROUTER, and nothing else.
 *
 * Every rule the Sales Manager screens depend on already lives in an action
 * that the CRM's own Lead Management calls — the gates, the reasons, the
 * capability checks, the transitions, the timeline rows. What the prototype's
 * dialogs do is press TWO of those in a row (Convert = save the fields, then
 * move the rung; Verify = record the call, then open Qualification), and a
 * screen that made two server round trips would leave a half-done state if the
 * second one never left the browser. So each pair is one action here.
 *
 * NONE OF THEM DECIDES ANYTHING. Each one calls the real action, hands its
 * refusal straight back, and adds no permission of its own — the gate engine
 * and `requireCapability` inside the actions it calls are the authority, and a
 * dialog that offered something they would refuse gets THEIR sentence.
 *
 * WHAT IS NOT HERE, on purpose: the sample, order, distributor, next-action,
 * reassignment, communication and qualification dialogs call the existing
 * actions directly. A wrapper that only forwarded would be a second copy of a
 * signature, and the half that drifts is the one that is not type-checked.
 * ------------------------------------------------------------------------- */

const PIPELINE_PATH = "/sales-lead-pipeline";

function refresh() {
  try {
    revalidatePath(PIPELINE_PATH, "layout");
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/* ══════════════════════════════════════════════════════ convert to prospect */

const convertSchema = z.object({
  customerId: z.string().min(1),
  reasonCode: z.string().trim().min(1).max(80),
  fields: z.object({
    customerType: z.enum(["dealer", "manufacturer", "distributor", "retailer"]).nullish(),
    monthlyLitres: z.number().int().nonnegative().nullish(),
    potentialPaise: z.number().int().nonnegative().nullish(),
    competitor: z.string().trim().max(200).nullish(),
    requiredProductId: z.string().min(1).nullish(),
    contactPerson: z.string().trim().max(200).nullish(),
    decisionMaker: z.string().trim().max(200).nullish(),
  }),
});

export type ConvertProspectInput = z.input<typeof convertSchema>;

/**
 * §5.1 — CONVERT A SUSPECT TO A PROSPECT: capture what is still missing, then move.
 *
 * `saveProspectFields` stores the answers the gate reads as COLUMNS; the move is
 * then `advanceLeadStage`, which asks the gate engine for the eight conditions
 * and refuses with the ones still missing. §24's next action is supplied here
 * because the move demands one and the prototype's own promise is that "the
 * next action is set automatically": a manager verification call, dated
 * `leads.verificationDueDays` out, owed by the lead manager (or whoever is
 * converting it, where nobody holds that seat).
 *
 * A REFUSED MOVE DOES NOT UNDO THE SAVE. The figures somebody typed are real
 * information whether or not the lead may go up today, and throwing them away
 * to keep the two steps atomic would lose the one thing the form gave. The
 * message says which half happened.
 */
export async function convertProspect(input: ConvertProspectInput): Promise<Result<null>> {
  try {
    const parsed = convertSchema.safeParse(input);
    if (!parsed.success) {
      return err("Check the figures — one of them is not something MahekOne can read.", "validation");
    }
    const { customerId, reasonCode, fields } = parsed.data;

    const saved = await saveProspectFields(customerId, fields);
    if (!saved.ok) return saved;

    const [config, day, me] = await Promise.all([getConfig(), today(), requireUser()]);
    const [lead] = await db
      .select({ managerId: customers.leadManagerId })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);

    const moved = await advanceLeadStage({
      customerId,
      to: "prospect",
      reasonCode,
      nextAction: {
        action: "Manager verification call",
        date: addDays(day, config["leads.verificationDueDays"]),
        ownerId: lead?.managerId ?? me.id,
        outcome: "Verify the visit and open qualification",
      },
    });
    refresh();
    if (!moved.ok) {
      return {
        ...moved,
        error: `The figures are saved, but the move to Prospect was refused. ${moved.error}`,
      };
    }
    return ok(null, "Converted to Prospect — the verification call is on the manager's list.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════════ manager verification */

const verifySchema = z.object({
  customerId: z.string().min(1),
  outcome: z.enum(["verified", "follow_up", "not_qualified"]),
  /** The dialog's "Verified With Corrections" — only a label over `verified`, and it must be true. */
  expectCorrections: z.boolean().optional(),
  answers: z.record(z.string(), z.string().trim().max(1000)),
  corrections: z
    .array(
      z.object({
        field: z.string().trim().max(80),
        original: z.string().trim().max(1000).nullish(),
        corrected: z.string().trim().min(1).max(1000),
        reason: z.string().trim().min(1).max(1000),
      }),
    )
    .max(40),
  /** Finding labels the shop could not confirm — recorded in the call's own words, never as a correction. */
  unableToVerify: z.array(z.string().trim().max(120)).max(20).optional(),
  followUpNote: z.string().trim().max(2000).optional(),
  failureReasonCode: z.string().trim().max(80).optional(),
});

export type VerifyProspectInput = z.input<typeof verifySchema>;

/**
 * §8 — THE VERIFICATION CALL, and the rung it opens.
 *
 * `recordLeadValidationCall` is the call: it stores the seventeen answers on
 * `mbos_lead_validations`, one row per corrected finding, and — on
 * `not_qualified` — closes the lead through the ordinary door with the fixed
 * `verification_failed` reason. It also settles a calling-desk Prospect
 * REQUEST, which is why this must go through it and never write the verdict
 * itself: a desk request promotes on `verified` and parks on `follow_up`, and
 * that interplay is that action's.
 *
 * WHAT THIS ADDS is the prototype's "verified — qualification opened": once a
 * lead standing at Prospect is verified, the move to Qualification is attempted
 * with no reason and no override. The gate engine decides — if it is shut (no
 * next action, say) the call is still recorded and the message says why the
 * rung did not move, which the button on the record then offers by hand.
 */
export async function verifyProspect(input: VerifyProspectInput): Promise<Result<null>> {
  try {
    const parsed = verifySchema.safeParse(input);
    if (!parsed.success) return err("Check the answers — one of them is not something MahekOne can read.", "validation");
    const p = parsed.data;

    if (p.expectCorrections && p.outcome === "verified" && p.corrections.length === 0) {
      return err(
        "You chose “Verified With Corrections” but no field was corrected. Correct at least one finding, or choose “Verified”.",
        "validation",
      );
    }

    /* Only the DECLARED questions and findings go across — the action drops the
       rest, but saying so here means a refusal is never about a field the
       screen invented. */
    const known = new Set(VERIFICATION_QUESTIONS.map((q) => q.id));
    const answers = Object.fromEntries(Object.entries(p.answers).filter(([id, v]) => known.has(id) && v.trim()));
    const corrections = p.corrections.filter((c) => isVerificationFinding(c.field));

    const unable = p.unableToVerify?.length
      ? `Could not confirm with the shop: ${p.unableToVerify.join(", ")}.`
      : "";
    const note = [p.followUpNote?.trim(), unable].filter(Boolean).join(" ") || undefined;

    const call = await recordLeadValidationCall(p.customerId, {
      answers,
      outcome: p.outcome,
      followUpNote: note,
      failureReasonCode: p.failureReasonCode,
      corrections,
    });
    refresh();
    if (!call.ok || p.outcome !== "verified") return call;

    /* Verified: open Qualification if the lead is standing at Prospect. */
    const [row] = await db
      .select({ stage: customers.leadStage })
      .from(customers)
      .where(eq(customers.id, p.customerId))
      .limit(1);
    if (row?.stage !== "prospect") return call;

    const moved = await advanceLeadStage({ customerId: p.customerId, to: "qualification" });
    refresh();
    return moved.ok
      ? ok(null, "Verified — Qualification is open.")
      : ok(null, `Verified. Qualification did not open yet: ${moved.error}`, [moved.error]);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════════════════ mark lost */

const lostSchema = z.object({
  customerId: z.string().min(1),
  reasonCode: z.string().trim().min(1).max(80),
  note: z.string().trim().max(2000).optional(),
});

/**
 * §26 — CLOSE A LEAD, by the door that matches where it stands.
 *
 * A Suspect answering "Not a Prospect" is `decideSuspect`, because that is the
 * one that stamps `lead_suspect_decided_at` — the mark that stops the lead being
 * turned back into the same question every morning. Anything higher is the
 * plain move to `lost`. Both validate the reason against the CONFIGURED list
 * and both write the transition, so there is no second path to `lost` here.
 */
export async function markLeadLost(input: z.input<typeof lostSchema>): Promise<Result<null>> {
  try {
    const parsed = lostSchema.safeParse(input);
    if (!parsed.success) return err("Pick why it was lost.", "validation");
    const { customerId, reasonCode, note } = parsed.data;

    /* Asked of the lead's own rung, and only to choose a door: whether the lead
       may be touched at all is answered by the action behind it. */
    await requireCapability("lead.work");
    const [row] = await db
      .select({ stage: customers.leadStage })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!row?.stage) return err("That lead is no longer here.", "not_found");

    const result =
      row.stage === "suspect" || row.stage === "new"
        ? await decideSuspect(customerId, { prospect: false, reasonCode, note })
        : await advanceLeadStage({ customerId, to: "lost", reasonCode, note });
    refresh();
    return result.ok ? ok(null, "Marked Lost — the record and its timeline are kept.") : result;
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════════ the sample's three moves */

/**
 * A SAMPLE'S STATE AND THE LEAD'S RUNG ARE TWO THINGS THAT MOVE SEPARATELY, and
 * the prototype moved them together.
 *
 * `requestSample`, `confirmSampleReceived` and `recordSampleFeedback` write the
 * sample; none of them touches `lead_stage`. The rung follows by an ordinary
 * move that the gate engine decides — which is why the record page has a "Move
 * the rung on" control for a lead whose parcel has overtaken it. These three
 * press the action and then that move in one go, so the screen does what the
 * prototype's did: asking for a sample puts the lead at Sample / Trial, and so
 * on down the rungs.
 *
 * THE MOVE IS BEST-EFFORT AND THE GATE DECIDES IT. If the engine refuses, the
 * sample step still stands — it is a real event that happened — and the message
 * names why the rung stayed, which the control on the record then offers by
 * hand. Nothing is forced, and no override is passed.
 */
async function thenMoveTo(
  customerId: string,
  to: "sample_trial" | "sample_received" | "sample_review",
  done: string,
): Promise<Result<null>> {
  const moved = await advanceLeadStage({ customerId, to });
  refresh();
  return moved.ok ? ok(null, done) : ok(null, `${done} The rung did not move yet: ${moved.error}`, [moved.error]);
}

const requestSchema = z.object({
  customerId: z.string().min(1),
  productId: z.string().min(1),
  quantityCans: z.number().int().positive().max(10000),
  application: z.string().trim().min(1).max(500),
  reasonCode: z.string().trim().min(1).max(60),
});

/** §15 — ask for the sample, then put the lead at Sample / Trial if its gate allows it. */
export async function requestSampleForLead(input: z.input<typeof requestSchema>): Promise<Result<null>> {
  try {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return err("A sample needs a product, a quantity and what it is going to be used on.", "validation");
    const { customerId, ...rest } = parsed.data;
    const asked = await requestSample(customerId, rest);
    if (!asked.ok) return asked;
    return thenMoveTo(customerId, "sample_trial", "Sample requested — it now waits for approval.");
  } catch (e) {
    return fromThrown(e);
  }
}

/** §15 — the shop has it. Confirm, then put the lead at Sample Received if its gate allows it. */
export async function receiveSampleForLead(input: { customerId: string; sampleId: string }): Promise<Result<null>> {
  try {
    const got = await confirmSampleReceived(input.sampleId, {});
    if (!got.ok) return got;
    return thenMoveTo(input.customerId, "sample_received", "Receipt recorded.");
  } catch (e) {
    return fromThrown(e);
  }
}

/** §16 — the trial's seven answers and verdict, then Sample Review if the gate allows it. */
export async function reviewSampleForLead(input: {
  customerId: string;
  sampleId: string;
  fields: Record<string, string>;
  trialOutcome: "approved" | "rejected" | "more_testing";
}): Promise<Result<null>> {
  try {
    const reviewed = await recordSampleFeedback(input.sampleId, { fields: input.fields, trialOutcome: input.trialOutcome });
    if (!reviewed.ok) return reviewed;
    return thenMoveTo(input.customerId, "sample_review", "Trial review saved.");
  } catch (e) {
    return fromThrown(e);
  }
}
