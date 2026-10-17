import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, users } from "@/db/schema";
import { canAny, hatsFor } from "@/lib/access-control";
import { notifyUser } from "@/lib/notify";
import { today } from "@/lib/recompute";
import { stampDate } from "@/lib/format";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { ladderFor } from "@/lib/engines/lead-ladder";
import { qualificationReadyForReview } from "@/lib/engines/lead-gates";
import { reviewVoidPatch, type ReviewVoid } from "@/lib/lead-review-void";
import type { LeadSalesType } from "@/lib/lead-labels";
import {
  applyLeadStageMove,
  evaluateLeadStageMove,
  leadGateInput,
  leadRow,
  StageAlreadyMoved,
  type LeadMoveActor,
  type LeadRow,
} from "./lead-service";
import { nextWorkingDate } from "./lead-qualification-service";
import { approverFor } from "./lead-verifier";

/* ---------------------------------------------------------------------------
 * THE QUALIFICATION WORKFLOW, in one place.
 *
 * Prospect → Sales Manager verification → Qualification by the Salesman who
 * owns the lead → Sales Manager validates the GST number and reviews →
 * Sample / Trial. (The earlier steps — a Suspect becoming a Prospect — are the
 * Calling Desk's and are unchanged.)
 *
 * Three doors verify a Prospect (the console's verification screen, the Sales
 * Manager pipeline, and a handset) and four screens write Qualification data.
 * What follows is what those seven have to agree on, so it is written once:
 *
 *   openQualificationAfterVerification  — the moment a verification succeeds
 *   settleQualificationState            — after any Qualification write, who owes what
 *   handBackAfterReview                 — after the manager's verdict
 *   recordReviewVoid                    — the history of a review an edit took away
 *
 * NONE OF IT AUTHORISES ANYTHING. Every caller asks its own question first —
 * `lead.verify` to verify, `lead.work` to write — and passes the answer in the
 * actor it hands over. That is deliberate and it is the difference between a
 * shared helper and a back door: this file re-reads the lead from the database
 * for everything it acts on (`lead_verified_at` above all, never a caller's
 * claim), asks the SAME gate every other move asks with no override, and cannot
 * be pointed at a lead that has not been verified.
 *
 * NOTHING HERE CHANGES `owner_id`. The Telecaller who worked the lead as a
 * Suspect is the one who completes its Qualification, and a manager verifying it
 * does not become its owner — the next action names who owes what, the seat
 * names who runs it, and the owner stays who it was.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * The sentence on a next action, as this workflow writes it.
 *
 * Constants because they are also how the workflow RECOGNISES its own work: a
 * next action reading "Review qualification" owed by the lead manager is the
 * review having been asked for, and a second pass must not ask again. A literal
 * that drifted by one character would put a second bell on the manager's phone
 * every time somebody saved a checklist.
 */
export const QUAL_NEXT = {
  verify: "Sales Manager verification call",
  complete: "Complete the qualification",
  review: "Review qualification",
  answer: "Answer the Sales Manager's note",
  sample: "Request the sample",
  gst: "Correct the GST number",
  assign: "Assign a Salesman to complete the qualification",
} as const;

/** Whether this person holds the manager's own judgement (`lead.verify`). */
export async function isReviewer(user: { id: string; role: string }): Promise<boolean> {
  return canAny(await hatsFor(user), "lead.verify");
}

async function nameOf(userId: string | null | undefined): Promise<string> {
  if (!userId) return "Somebody";
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.name ?? "Somebody";
}

/**
 * WHO COLLECTS THE ANSWERS. The lead's owner — except on a lead its Sales Manager
 * raised herself where somebody else is designated to approve it: there she
 * collects (the owner, or the seat holder where nobody owns it), and the
 * approvals are theirs.
 */
async function collectorOf(lead: LeadRow): Promise<string | null> {
  const owner = await activeUser(lead.ownerId);
  if (await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId })) {
    return owner ?? (await activeUser(lead.salesManagerId));
  }
  return owner;
}

async function activeUser(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.active ? u.id : null;
}

/* ------------------------------------------------------------ next action */

type NextAction = { action: string; date: string; ownerId: string; outcome?: string | null };

/**
 * Set the §24 next action as the workflow's own act, and say so in the audit log.
 *
 * The four columns are written together, as everywhere else — an owner or an
 * outcome left behind describes a promise that no longer exists. The audit row
 * carries both sides, because "who was asked to do what, and who was asked
 * before" is the whole content of a hand-off.
 */
async function setNextAction(
  lead: LeadRow,
  next: NextAction,
  actorId: string,
  why: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(customers)
      .set({
        leadNextAction: next.action,
        leadNextActionDate: next.date,
        leadNextActionOwnerId: next.ownerId,
        leadNextActionOutcome: next.outcome ?? null,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, lead.id));
    await tx.insert(auditLog).values({
      id: gen("aud"),
      actorId,
      action: "lead.nextAction.workflow",
      entityType: "customer",
      entityId: lead.id,
      beforeState: {
        action: lead.leadNextAction,
        ownerId: lead.leadNextActionOwnerId,
        date: lead.leadNextActionDate,
      },
      afterState: { action: next.action, ownerId: next.ownerId, date: next.date, why },
    });
  });
}

/* ---------------------------------------------------- a review that stopped */

/**
 * Write down that a verified review no longer stands.
 *
 * Called by a writer in the SAME transaction as the material change that voided
 * it. The verdict itself is cleared by the writer's own UPDATE (`reviewVoidPatch`
 * gives it the columns); what this adds is the history — who verified it, when,
 * what they wrote, and what changed — so that nulling the columns destroys
 * nothing. It is the audit log's `beforeState` that a "restore" would read.
 */
export async function recordReviewVoid(
  tx: Pick<typeof db, "insert">,
  o: { lead: LeadRow; voided: ReviewVoid; actorId: string; actorRole?: string | null; actorApp?: string | null },
): Promise<void> {
  const now = new Date();
  await writeTimelineEvent(tx as never, {
    customerId: o.lead.id,
    eventType: MBOS_EVENT.qualificationReview,
    sourceApp: "crm",
    /* The moment goes in the source id: one lead is voided more than once, and
       the bare id would collapse the second onto the first. */
    sourceRecordId: `${o.lead.id}:review-void:${now.toISOString()}`,
    occurredAt: now,
    actorUserId: o.actorId,
    summary:
      o.lead.leadQualificationReview === "verified"
        ? `The sales manager's verification of ${o.lead.name}'s qualification no longer stands — ${o.voided.fields.join(", ")} changed. It has to be reviewed again.`
        : `${o.voided.fields.join(", ")} changed after the sales manager's note on ${o.lead.name}'s qualification (${o.lead.leadQualificationReview}). The note is kept in the history; it goes back for review.`,
  });
  await tx.insert(auditLog).values({
    id: gen("aud"),
    actorId: o.actorId,
    action: "lead.qualificationReview.void",
    entityType: "customer",
    entityId: o.lead.id,
    beforeState: {
      leadQualificationReview: o.lead.leadQualificationReview,
      leadQualificationReviewNote: o.lead.leadQualificationReviewNote,
      leadQualificationReviewedAt: o.lead.leadQualificationReviewedAt
        ? new Date(o.lead.leadQualificationReviewedAt).toISOString()
        : null,
      leadQualificationReviewedById: o.lead.leadQualificationReviewedById,
    },
    afterState: { leadQualificationReview: null, changed: o.voided.fields },
  } as never);
}

/* ------------------------------------------------- who owes what, in flight */

/**
 * After any Qualification write: work out whose turn it is, and say so once.
 *
 * COMPLETION IS DERIVED, never stored — `qualificationComplete` asks the gate
 * with the review conditions left out, so it cannot disagree with what the gate
 * refuses on, and there is no "submit" button to forget. When every condition
 * the Telecaller owns is met and the manager has not verified, the next action
 * goes to the lead manager as "Review qualification" and they are told, once. If
 * something is un-answered afterwards it goes back to the Telecaller.
 *
 * IDEMPOTENT by the next action itself: it is the guard, exactly as the lead
 * manager seat is the guard on `qualifyLead`. Saving a checklist four times does
 * not ring the manager four times.
 *
 * Best-effort on top of a completed write. It never throws into the save that
 * called it — a bell that could not be written must not lose somebody's answers.
 */
export async function settleQualificationState(
  customerId: string,
  actorId: string,
  opts: { voided?: boolean } = {},
): Promise<{ handedTo: "manager" | "owner" | null }> {
  try {
    const lead = await leadRow(customerId);
    if (!lead || lead.leadStage !== "qualification") return { handedTo: null };
    if (!lead.leadSalesType || lead.leadSalesType === "distributor") return { handedTo: null };

    const gate = await leadGateInput(customerId);
    if (!gate) return { handedTo: null };
    const complete = qualificationReadyForReview(gate);
    const review = lead.leadQualificationReview;
    /* THE REVIEWER IS THE SALES MANAGER THE LEAD IS UNDER. The lead-manager seat
       is the fall-through for a lead raised before every lead carried a Sales
       Manager seat; where both exist, the seat the verification was owed to
       comes first. */
    const approver = await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId });
    const manager = approver?.id ?? (await activeUser(lead.salesManagerId)) ?? lead.leadManagerId;
    const owner = await collectorOf(lead);

    /* ONLY WHERE THERE IS NO STANDING VERDICT. A negative review is a note the
       Telecaller has not yet answered: a save that changes nothing must not put
       the lead back in front of the manager while the note is outstanding, and
       an edit that DOES change something has already voided it (so the verdict
       reads null here and the review is asked for). `verified` needs nothing. */
    if (complete && review === null) {
      if (!manager) return { handedTo: null };
      const already =
        lead.leadNextAction === QUAL_NEXT.review && lead.leadNextActionOwnerId === manager;
      if (already) return { handedTo: null };

      await setNextAction(
        lead,
        {
          action: QUAL_NEXT.review,
          date: await today(),
          ownerId: manager,
          outcome: "Read the answers and verify, or say what is missing",
        },
        actorId,
        opts.voided ? "qualification changed after it was verified" : "qualification complete",
      );
      await notifyUser({
        userId: manager,
        title: `${lead.name}: qualification is ready for your review`,
        body: opts.voided
          ? "It was verified before and has changed since, so it needs your review again."
          : "The Salesman has completed the qualification. Validate the GST number and review it; nothing goes to a sample until you verify it.",
        kind: "info",
        href: `/crm/leads/${lead.id}/qualify`,
      }).catch(() => {});
      return { handedTo: "manager" };
    }

    if (!complete && lead.leadNextAction === QUAL_NEXT.review && owner) {
      await setNextAction(
        lead,
        {
          action: QUAL_NEXT.complete,
          date: await nextWorkingDate(),
          ownerId: owner,
          outcome: "Answer every condition, then it goes for review",
        },
        actorId,
        "qualification no longer complete",
      );
      return { handedTo: "owner" };
    }
    return { handedTo: null };
  } catch {
    return { handedTo: null };
  }
}

/**
 * After the manager's verdict: hand the next action back to the Salesman.
 *
 *   verified                  → "Request the sample", and the Telecaller is told
 *   incomplete / clarification → "Answer the Sales Manager's note", with the note
 *                                 in the action, and the Telecaller is told
 *
 * The Telecaller is `owner_id` and the note travels IN the message: it is the
 * whole content of a refusal, and a bell that makes somebody open a screen to
 * find out what it says is one they read later. Never the lead manager, who is
 * usually the person pressing the button.
 */
export async function handBackAfterReview(
  customerId: string,
  verdict: "verified" | "incomplete" | "clarification",
  note: string,
  actorId: string,
): Promise<void> {
  try {
    const lead = await leadRow(customerId);
    if (!lead) return;
    const owner = await collectorOf(lead);
    if (!owner) return;
    const negative = verdict !== "verified";

    await setNextAction(
      lead,
      {
        action: negative ? QUAL_NEXT.answer : QUAL_NEXT.sample,
        date: await nextWorkingDate(),
        ownerId: owner,
        outcome: negative ? note : "Eligible for Sample / Trial",
      },
      actorId,
      `manager review: ${verdict}`,
    );
  } catch {
    /* A courtesy on top of a verdict already standing on the record. */
  }
}

/**
 * The Sales Manager refused the GST number: hand it straight back to the
 * Salesman, with the reason travelling IN the message.
 *
 * A refusal that only sets a flag leaves the Salesman with a lead that has
 * stopped moving and no idea why — the number was typed in the shop, and what
 * is wrong with it is exactly what he can fix from there. So the next action
 * becomes "Correct the GST number" owed by the lead's owner, and he is told.
 * Best-effort on top of a refusal already on the record, like every other
 * hand-back here.
 */
export async function handBackAfterGstRefusal(
  customerId: string,
  note: string,
  actorId: string,
): Promise<void> {
  try {
    const lead = await leadRow(customerId);
    if (!lead) return;
    const owner = await collectorOf(lead);
    if (!owner || owner === actorId) return;
    await setNextAction(
      lead,
      {
        action: QUAL_NEXT.gst,
        date: await nextWorkingDate(),
        ownerId: owner,
        outcome: note,
      },
      actorId,
      "GST number refused",
    );
    await notifyUser({
      userId: owner,
      title: `${lead.name}: the GST number was refused`,
      body: `${note} — correct the number, and your Sales Manager will check it again.`,
      kind: "warn",
      href: `/crm/leads/${lead.id}/qualify`,
    }).catch(() => {});
  } catch {
    /* A courtesy on top of a refusal already standing on the record. */
  }
}

/* ------------------------------------------------ opening Qualification */

export type OpenQualificationOutcome = {
  opened: boolean;
  reason?:
    | "not_found"
    | "not_prospect"
    | "not_verified"
    | "no_such_rung"
    | "gate_shut"
    | "already_open";
  message: string;
};

/**
 * A verification has succeeded — open Qualification for the Telecaller.
 *
 * One rule for every door. Verifying a Prospect and opening Qualification used
 * to be two acts: only the Sales Manager pipeline did the second, so a manager
 * who verified from the lead's own screen or from a phone left the lead at
 * Prospect reading "your sales manager has to verify this customer first" over a
 * call that had been made.
 *
 * WHAT IT ASKS, in order: is the lead standing at `prospect`, does its ladder
 * have a Qualification rung, and — read from the database, never taken on trust
 * — has `lead_verified_at` been stamped. Then the ordinary gate, with no
 * override, so anything else that stands in the way (there is nothing else
 * today, but §24 is asked) is a refusal rather than a bypass.
 *
 * THE NEXT ACTION goes to the Telecaller — `owner_id`, who worked the lead — as
 * "Complete the qualification", due the next working day. Where the lead has no
 * active owner the verifier holds it, and says so in the message: unassigned
 * work is the failure this whole file exists to prevent, and a lead nobody owns
 * is the one that most needs somebody told.
 *
 * NEVER FAILS THE VERIFICATION. The call is evidence of a conversation that
 * happened; a gate that would not open, or a lead somebody else moved a moment
 * earlier, comes back as `opened: false` with the reason in words, and the
 * manual "Open Qualification" on the record is the way through.
 *
 * `expectFrom: "prospect"` makes it happen once. Two verifications arriving
 * together (the console and a phone) would otherwise both read `prospect` and
 * write two transitions; the second now finds the lead already moved.
 */
export async function openQualificationAfterVerification(
  actor: LeadMoveActor,
  customerId: string,
): Promise<OpenQualificationOutcome> {
  const lead = await leadRow(customerId);
  if (!lead) return { opened: false, reason: "not_found", message: "That lead is not on MahekOne." };
  if (lead.leadStage !== "prospect") {
    return {
      opened: false,
      reason: lead.leadStage === "qualification" ? "already_open" : "not_prospect",
      message:
        lead.leadStage === "qualification"
          ? "Qualification is already open."
          : "Only a Prospect can be opened for Qualification.",
    };
  }
  if (!ladderFor(lead.leadSalesType as LeadSalesType | null).includes("qualification")) {
    return { opened: false, reason: "no_such_rung", message: "This lead's ladder has no Qualification rung." };
  }
  if (!lead.leadVerifiedAt) {
    return { opened: false, reason: "not_verified", message: "The Sales Manager has not verified this Prospect." };
  }

  const gate = await leadGateInput(customerId);
  if (!gate) return { opened: false, reason: "not_found", message: "That lead is not on MahekOne." };

  /* THE SALESMAN WHO OWNS THE LEAD COLLECTS THE ANSWERS, and it cannot be the
     Sales Manager it is reviewed by: a lead she raised herself carries her as
     owner or nobody, and neither can complete it. So there the next action is
     hers to ASSIGN — name a Salesman — rather than a job she is handed. */
  const collector = await collectorOf(lead);
  const selfRaisedWithApprover = Boolean(
    await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId }),
  );
  const telecaller = collector && (collector !== lead.salesManagerId || selfRaisedWithApprover) ? collector : null;
  const owed = telecaller ?? actor.userId;
  const next = {
    action: telecaller ? QUAL_NEXT.complete : QUAL_NEXT.assign,
    date: await nextWorkingDate(),
    ownerId: owed,
    outcome: "Answer the eight questions, then it goes to the Sales Manager for review",
  };

  const decision = await evaluateLeadStageMove({
    lead,
    gate: {
      ...gate,
      nextAction: next.action,
      nextActionDate: next.date,
      nextActionOwnerId: next.ownerId,
    },
    to: "qualification",
    override: null,
    canOverride: false,
  });
  if (!decision.ok) {
    return { opened: false, reason: "gate_shut", message: decision.message };
  }

  try {
    await applyLeadStageMove(actor, lead, "qualification", {
      decision,
      reasonCode: null,
      note: null,
      nextAction: next,
      day: await today(),
      expectFrom: "prospect",
    });
  } catch (e) {
    if (e instanceof StageAlreadyMoved) {
      return { opened: false, reason: "already_open", message: "Qualification is already open." };
    }
    throw e;
  }

  const verifier = await nameOf(lead.leadVerifiedById ?? actor.userId);
  const sentence = `Verified by ${verifier} on ${stampDate(lead.leadVerifiedAt)}. Qualification is now ready for you.`;
  if (telecaller && telecaller !== actor.userId) {
    await notifyUser({
      userId: telecaller,
      title: `${lead.name}: qualification is ready for you`,
      body: sentence,
      kind: "info",
      href: `/crm/leads/${lead.id}/qualify`,
    }).catch(() => {});
  }

  return {
    opened: true,
    message: telecaller
      ? "Verified — Qualification is open and the Salesman has been told."
      : "Verified — Qualification is open. Name a Salesman as this lead's owner; he completes it and you review it.",
  };
}

/* ------------------------------------------------------ sample eligibility */

export type SampleEligibility =
  | { applies: false }
  | { applies: true; eligible: true }
  | { applies: true; eligible: false; message: string; missing: { id: string; says: string }[] };

/**
 * MAY THIS LEAD HAVE A SAMPLE ASKED FOR?
 *
 * The gate on the rung into Sample/Trial has always been enforced where the RUNG
 * moves, and a sample request never moved it — `requestSample` created the row,
 * the approval and the nurture task and left the lead exactly where it was. So a
 * lead with an unreviewed Qualification could be given a sample by anybody who
 * held `lead.work` and posted to that action, with every gate on the ladder
 * shut, and nothing anywhere would say so. The Manager's review is now mandatory
 * for Sample/Trial, which makes that gap a bypass of the review itself.
 *
 * So the request asks the SAME question the rung move asks — the ordinary gate,
 * no override — before it writes anything. Called by `requestSample` and by the
 * handset's sample handover, so a sample cannot be created ahead of the gate
 * from either door, and a refused one leaves no row behind.
 *
 * WHERE IT APPLIES: a lead on a funnel ladder that has a Sample/Trial rung
 * (direct and third-party) and is standing BELOW it. A lead already at Sample /
 * Trial or beyond has been through the gate — a second sample after "more
 * testing" is not asking to enter it again — and a legacy lead (no sales type)
 * or a distributor has no such rung. Their behaviour is unchanged.
 */
export async function sampleEligibility(customerId: string): Promise<SampleEligibility> {
  const lead = await leadRow(customerId);
  if (!lead || !lead.leadStage || !lead.leadSalesType || lead.leadSalesType === "distributor") {
    return { applies: false };
  }
  const ladder = ladderFor(lead.leadSalesType as LeadSalesType);
  const sampleAt = ladder.indexOf("sample_trial");
  if (sampleAt === -1) return { applies: false };
  const here = ladder.indexOf(lead.leadStage as never);
  if (here !== -1 && here >= sampleAt) return { applies: false };

  const gate = await leadGateInput(customerId);
  if (!gate) return { applies: false };
  const decision = await evaluateLeadStageMove({
    lead,
    gate,
    to: "sample_trial",
    override: null,
    canOverride: false,
  });
  if (decision.ok) return { applies: true, eligible: true };

  const missing = decision.missing.map((c) => ({ id: c.id, says: c.says }));
  return {
    applies: true,
    eligible: false,
    missing,
    message: missing.length
      ? `A sample can be asked for once Qualification is complete and the Sales Manager has verified it. Still to do: ${missing.map((m) => m.says).join("; ")}.`
      : decision.message,
  };
}

/* ---------------------------------------------------- a distributor changed */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A distributor link was added, changed or removed on this lead — take a
 * Telecaller's-era `verified` review away, in the SAME transaction as the link.
 *
 * The link is a material Qualification answer for a third-party lead (it is the
 * `distributor_named` condition), and it lives in its own table, so it cannot
 * ride a `customers` UPDATE the way the other writers' void does. Same rule: the
 * reviewer's own edit does not void his own judgement, anybody else's does.
 * Returns whether a review was voided.
 */
export async function voidReviewForDistributorChange(
  tx: Tx,
  customerId: string,
  user: { id: string; role: string },
): Promise<boolean> {
  const lead = await leadRow(customerId);
  if (!lead) return false;
  const voided = reviewVoidPatch(lead, {}, { reviewer: await isReviewer(user), extra: ["distributor"] });
  if (!voided) return false;
  await tx
    .update(customers)
    .set({ ...voided.set, updatedAt: new Date() })
    .where(eq(customers.id, customerId));
  await recordReviewVoid(tx, { lead, voided, actorId: user.id });
  return true;
}
