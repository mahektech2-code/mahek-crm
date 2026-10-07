import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireOffers, type HireOffer } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { renderLetter, rupees } from "@/app/hire/_onboard/letter";
import type { HireContext } from "../access";
import { audit, getApplication, hid, recordMessage, type AppBundle } from "./core";

/* ---------------------------------------------------------------------------
 * OFFERS (spec §2.8, design §7.9).
 *
 * Every figure on an offer comes from the blueprint's offer model: the grade,
 * the band the basic must sit in, the incentive, and the growth ladder. The
 * letter is a TEMPLATE over those figures — nothing is restated by a model —
 * and the ladder on the letter is the same `growth` definition the briefing
 * reads, which is the whole of the fix for D12: they cannot disagree because
 * there is only one of them.
 *
 * A draft is edited in place (nothing has been promised to anybody). Once
 * ISSUED an offer is a record: a negotiation is a NEW offer superseding it,
 * with `negotiated_from_id` pointing back.
 * ------------------------------------------------------------------------- */

export const COURIER = ["not_sent", "sent", "received", "received_by_staff"] as const;
export const COURIER_LABEL: Record<string, string> = { not_sent: "Not sent", sent: "Sent", received: "Received by candidate", received_by_staff: "Received by staff" };
export const BG_CHECK = ["needed", "not_necessary", "in_progress", "clear", "flagged"] as const;
export const BG_LABEL: Record<string, string> = { needed: "Needed", not_necessary: "Not necessary", in_progress: "In progress", clear: "Clear", flagged: "Flagged — a person reviews it" };
export const CONFIRM = ["agree", "disagree", "may_be"] as const;
export const CONFIRM_LABEL: Record<string, string> = { agree: "Agree", disagree: "Disagree", may_be: "May be" };

/** Courier has arrived — what the Documents stage waits for (spec §7.1). */
export const courierArrived = (o: Pick<HireOffer, "courierStatus"> | null | undefined) => o?.courierStatus === "received" || o?.courierStatus === "received_by_staff";

export async function currentOffer(applicationId: string): Promise<HireOffer | null> {
  const [o] = await db
    .select()
    .from(hireOffers)
    .where(and(eq(hireOffers.applicationId, applicationId), isNull(hireOffers.supersededById)))
    .orderBy(desc(hireOffers.createdAt))
    .limit(1);
  return o ?? null;
}

export async function offerHistory(applicationId: string): Promise<HireOffer[]> {
  return db.select().from(hireOffers).where(eq(hireOffers.applicationId, applicationId)).orderBy(desc(hireOffers.createdAt));
}

/* --------------------------------------------------------------- rendering */

/** The letter for a stored offer, through the one pure renderer the preview uses. */
export function letterFor(b: Pick<AppBundle, "def" | "blueprint" | "candidate">, o: Pick<HireOffer, "gradeLabel" | "grade" | "basicPaise" | "ctcPaise" | "incentive" | "joiningDate" | "expiryDate" | "growth">, datedOn?: Date | null): string {
  return renderLetter({
    def: b.def,
    roleTitle: b.blueprint.title,
    candidateName: b.candidate.fullName,
    location: b.candidate.location,
    grade: o.grade,
    gradeLabel: o.gradeLabel,
    basicPaise: o.basicPaise,
    ctcPaise: o.ctcPaise,
    incentive: o.incentive,
    joiningDate: o.joiningDate,
    expiryDate: o.expiryDate,
    growth: o.growth,
    datedOn: datedOn ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(datedOn) : null,
  });
}

/* ------------------------------------------------------------------ writes */

export type OfferInput = { grade: string; basicRupees: number; ctcRupees?: number | null; incentive?: string; joiningDate?: string; expiryDate?: string };

function validate(b: AppBundle, input: OfferInput): Result<{ basicPaise: number; ctcPaise: number | null; gradeLabel: string }> {
  const g = b.def.offer.grades.find((x) => x.key === input.grade);
  if (!g) return { ok: false, error: "Pick a grade from the role’s offer model.", code: "validation", fieldErrors: [{ field: "grade", message: "Required" }] };
  if (!Number.isFinite(input.basicRupees) || input.basicRupees <= 0) return { ok: false, error: "Enter the basic salary.", code: "validation", fieldErrors: [{ field: "basic", message: "Required" }] };
  const basicPaise = Math.round(input.basicRupees * 100);
  if (basicPaise < g.basicMinPaise || basicPaise > g.basicMaxPaise)
    return { ok: false, error: `${g.label} pays ${rupees(g.basicMinPaise)}–${rupees(g.basicMaxPaise)} a month. Pick another grade, or change the band in the blueprint.`, code: "validation", fieldErrors: [{ field: "basic", message: "Outside the grade’s band" }] };
  const ctcPaise = input.ctcRupees ? Math.round(input.ctcRupees * 100) : null;
  if (ctcPaise != null && ctcPaise < basicPaise * 12) return { ok: false, error: "The yearly CTC cannot be below twelve months of basic.", code: "validation", fieldErrors: [{ field: "ctc", message: "Below 12 × basic" }] };
  if (input.joiningDate && input.expiryDate && input.expiryDate > input.joiningDate) return { ok: false, error: "The offer must expire on or before the joining date.", code: "validation", fieldErrors: [{ field: "expiryDate", message: "After joining" }] };
  return ok({ basicPaise, ctcPaise, gradeLabel: g.label });
}

const offerStageOpen = (b: AppBundle) => {
  if (b.app.status === "hired") return "They are already hired.";
  if (b.app.status !== "in_progress" && b.app.status !== "on_hold") return `The application is ${b.app.status.replace("_", " ")}.`;
  const at = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
  const doc = b.def.stages.findIndex((s) => s.type === "document_collection");
  if (doc >= 0 && at < doc) return "An offer is made after the decision gate — this candidate is not at Documents & offer yet.";
  return null;
};

export async function saveOffer(ctx: HireContext, applicationId: string, input: OfferInput): Promise<Result<{ offerId: string }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const closed = offerStageOpen(b);
  if (closed) return err(closed, "rule_violation");
  const v = validate(b, input);
  if (!v.ok) return v;
  const cur = await currentOffer(applicationId);
  const values = {
    grade: input.grade,
    gradeLabel: v.data.gradeLabel,
    basicPaise: v.data.basicPaise,
    currency: "INR",
    ctcPaise: v.data.ctcPaise,
    incentive: input.incentive?.trim() || b.def.offer.incentive,
    growth: b.def.offer.growth,
    joiningDate: input.joiningDate || null,
    expiryDate: input.expiryDate || null,
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  if (cur && cur.status === "draft") {
    await db.update(hireOffers).set({ ...values, letter: letterFor(b, { ...cur, ...values }) }).where(eq(hireOffers.id, cur.id));
    return ok({ offerId: cur.id }, "Draft saved.");
  }
  if (cur && (cur.status === "issued" || cur.status === "accepted")) return err("This offer has been issued. Record the candidate’s response — a negotiation starts a new offer.", "rule_violation");
  const id = hid("hof");
  await db.insert(hireOffers).values({ id, applicationId, status: "draft", ...values, letter: letterFor(b, { ...values }), createdById: ctx.user.id });
  await audit(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: id, eventType: "offer_drafted", summary: `Offer drafted · ${v.data.gradeLabel} · ${rupees(v.data.basicPaise)} a month (INR)` });
  return ok({ offerId: id }, "Draft saved.");
}

export async function issueOffer(ctx: HireContext, applicationId: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const closed = offerStageOpen(b);
  if (closed) return err(closed, "rule_violation");
  const o = await currentOffer(applicationId);
  if (!o || o.status !== "draft") return err("Save a draft offer first.", "rule_violation");
  if (!o.joiningDate || !o.expiryDate) return err("Set the joining date and the date the offer expires before issuing it.", "validation");
  const now = new Date();
  const letter = letterFor(b, o, now);
  await db.update(hireOffers).set({ status: "issued", issuedAt: now, issuedById: ctx.user.id, letter, updatedAt: now, updatedById: ctx.user.id }).where(eq(hireOffers.id, o.id));
  await audit(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: o.id, eventType: "offer_issued", summary: `Offer issued · ${o.gradeLabel} · ${rupees(o.basicPaise)} a month (INR) · joining ${o.joiningDate} · open until ${o.expiryDate}` });
  await recordMessage(ctx, {
    candidateId: b.candidate.id,
    applicationId,
    direction: "out",
    channel: "portal",
    language: "English",
    subject: `Your offer — ${b.blueprint.title}`,
    body: `Your offer letter for ${b.blueprint.title} (${o.gradeLabel}) is ready to review. It is open until ${o.expiryDate}.`,
    status: "logged",
  });
  return ok(undefined, "Offer issued. Record the candidate’s answer when it comes.");
}

export type ResponseInput = { response: "accepted" | "declined" | "negotiating"; growthConfirmation?: string; letterConfirmation?: string; note: string };

export async function recordResponse(ctx: HireContext, applicationId: string, input: ResponseInput): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const o = await currentOffer(applicationId);
  if (!o || o.status !== "issued") return err("There is no issued offer waiting for an answer.", "rule_violation");
  if (input.response !== "accepted" && input.note.trim().length < 10) return { ok: false, error: "Say what the candidate said — at least a sentence.", code: "validation", fieldErrors: [{ field: "note", message: "Required" }] };
  const now = new Date();
  const gc = input.growthConfirmation && (CONFIRM as readonly string[]).includes(input.growthConfirmation) ? input.growthConfirmation : null;
  const lc = input.letterConfirmation && (CONFIRM as readonly string[]).includes(input.letterConfirmation) ? input.letterConfirmation : null;

  if (input.response === "negotiating") {
    const nid = hid("hof");
    await db.transaction(async (tx) => {
      await tx.insert(hireOffers).values({
        id: nid,
        applicationId,
        status: "draft",
        grade: o.grade,
        gradeLabel: o.gradeLabel,
        basicPaise: o.basicPaise,
        currency: o.currency,
        incentive: o.incentive,
        ctcPaise: o.ctcPaise,
        growth: o.growth,
        joiningDate: o.joiningDate,
        expiryDate: o.expiryDate,
        backgroundCheck: o.backgroundCheck,
        courierStatus: o.courierStatus,
        negotiatedFromId: o.id,
        letter: o.letter,
        createdById: ctx.user.id,
      });
      await tx.update(hireOffers).set({ supersededById: nid, respondedAt: now, response: "negotiating", growthConfirmation: gc, letterConfirmation: lc, updatedAt: now }).where(eq(hireOffers.id, o.id));
      await audit(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: o.id, eventType: "offer_negotiating", summary: `Candidate is negotiating · “${input.note.trim()}” · a revised draft was opened from the issued offer` }, tx);
    });
    return ok(undefined, "A revised draft is open. Change the figures and issue it again.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(hireOffers)
      .set({ status: input.response, respondedAt: now, response: input.response, growthConfirmation: gc, letterConfirmation: lc, updatedAt: now, updatedById: ctx.user.id })
      .where(eq(hireOffers.id, o.id));
    if (input.response === "declined") {
      await tx
        .update(hireApplications)
        .set({ status: "offer_declined", closedAt: now, decisionReason: input.note.trim(), updatedAt: now, updatedById: ctx.user.id })
        .where(eq(hireApplications.id, applicationId));
    }
    await audit(
      ctx,
      {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "offer",
        entityId: o.id,
        eventType: `offer_${input.response}`,
        summary: `Offer ${input.response}${gc ? ` · growth plan: ${CONFIRM_LABEL[gc]}` : ""}${lc ? ` · letter: ${CONFIRM_LABEL[lc]}` : ""}${input.note.trim() ? ` · “${input.note.trim()}”` : ""}`,
      },
      tx,
    );
  });
  return ok(undefined, input.response === "accepted" ? "Accepted. Documents and the courier finish this stage." : "Recorded as declined. The application is closed.");
}

export async function updateTracking(ctx: HireContext, applicationId: string, patch: { courierStatus?: string; backgroundCheck?: string }): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const o = await currentOffer(applicationId);
  if (!o) return err("There is no offer yet.", "rule_violation");
  const set: Partial<typeof hireOffers.$inferInsert> = { updatedAt: new Date(), updatedById: ctx.user.id };
  if (patch.courierStatus) {
    if (!(COURIER as readonly string[]).includes(patch.courierStatus)) return err("Unknown courier status.", "validation");
    set.courierStatus = patch.courierStatus;
  }
  if (patch.backgroundCheck) {
    if (!(BG_CHECK as readonly string[]).includes(patch.backgroundCheck)) return err("Unknown background-check status.", "validation");
    set.backgroundCheck = patch.backgroundCheck;
  }
  await db.update(hireOffers).set(set).where(eq(hireOffers.id, o.id));
  await audit(ctx, {
    applicationId,
    candidateId: b.candidate.id,
    entityType: "offer",
    entityId: o.id,
    eventType: "offer_tracking",
    summary: [patch.courierStatus ? `Courier: ${COURIER_LABEL[patch.courierStatus]}` : "", patch.backgroundCheck ? `Background check: ${BG_LABEL[patch.backgroundCheck]}` : ""].filter(Boolean).join(" · "),
  });
  return ok(undefined, "Saved.");
}

export { rupees };
