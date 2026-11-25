import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireIncentivePlans, hireOffers, users, type HireOffer, type HireOfferComponent } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { getConfig } from "@/lib/config/store";
import { notifyUsers } from "@/lib/notify";
import { renderLetter, rupees, slabLines } from "@/app/hire/_onboard/letter";
import type { HireContext } from "../access";
import { incentiveApplies, isOnboardingFlow } from "../blueprint-types";
import { basicDelta, needsApproval } from "../engines/onboarding";
import { advanceIfPassed, hireTrail, getApplication, hid, recordMessage, type AppBundle } from "./core";

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
export function letterFor(
  b: Pick<AppBundle, "def" | "blueprint" | "candidate">,
  o: Pick<HireOffer, "gradeLabel" | "grade" | "basicPaise" | "ctcPaise" | "incentive" | "joiningDate" | "expiryDate" | "growth"> & Partial<Pick<HireOffer, "incentiveApplicable" | "components" | "effectiveDate">>,
  datedOn?: Date | null,
  slabs?: string[] | null,
): string {
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
    incentiveApplicable: o.incentiveApplicable ?? true,
    incentiveSlabs: slabs ?? null,
    components: o.components ?? [],
    effectiveDate: o.effectiveDate ?? null,
  });
}

async function planSlabs(planId: string | null | undefined): Promise<string[] | null> {
  if (!planId) return null;
  const [p] = await db.select().from(hireIncentivePlans).where(eq(hireIncentivePlans.id, planId)).limit(1);
  return p ? slabLines(p) : null;
}

/* ------------------------------------------------------------------ writes */

export type OfferComponentInput = { key: string; label: string; amountRupees: number; per: "month" | "year" | "one_time" };

export type OfferInput = {
  grade: string;
  basicRupees: number;
  ctcRupees?: number | null;
  incentive?: string;
  joiningDate?: string;
  expiryDate?: string;
  /** PRD §6. Absent keeps what the role says. */
  incentiveApplicable?: boolean;
  incentivePlanId?: string | null;
  components?: OfferComponentInput[];
  effectiveDate?: string;
  /** Why the figures moved — required once an offer has been issued and is renegotiated. */
  changeReason?: string;
};

type Valid = { basicPaise: number; ctcPaise: number | null; gradeLabel: string; incentiveApplicable: boolean; planId: string | null; planTitle: string | null; components: HireOfferComponent[] };

async function validate(b: AppBundle, input: OfferInput): Promise<Result<Valid>> {
  const g = b.def.offer.grades.find((x) => x.key === input.grade);
  if (!g) return { ok: false, error: "Pick a grade from the role’s offer model.", code: "validation", fieldErrors: [{ field: "grade", message: "Required" }] };
  if (!Number.isFinite(input.basicRupees) || input.basicRupees <= 0) return { ok: false, error: "Enter the basic salary.", code: "validation", fieldErrors: [{ field: "basic", message: "Required" }] };
  const basicPaise = Math.round(input.basicRupees * 100);
  if (basicPaise < g.basicMinPaise || basicPaise > g.basicMaxPaise)
    return { ok: false, error: `${g.label} pays ${rupees(g.basicMinPaise)}–${rupees(g.basicMaxPaise)} a month. Pick another grade, or change the band in the blueprint.`, code: "validation", fieldErrors: [{ field: "basic", message: "Outside the grade’s band" }] };
  const ctcPaise = input.ctcRupees ? Math.round(input.ctcRupees * 100) : null;
  if (ctcPaise != null && ctcPaise < basicPaise * 12) return { ok: false, error: "The yearly CTC cannot be below twelve months of basic.", code: "validation", fieldErrors: [{ field: "ctc", message: "Below 12 × basic" }] };
  if (input.joiningDate && input.expiryDate && input.expiryDate > input.joiningDate) return { ok: false, error: "The offer must expire on or before the joining date.", code: "validation", fieldErrors: [{ field: "expiryDate", message: "After joining" }] };
  const incentiveApplicable = input.incentiveApplicable ?? incentiveApplies(b.def.offer);
  let planId: string | null = null;
  let planTitle: string | null = null;
  if (incentiveApplicable && input.incentivePlanId) {
    const [p] = await db.select().from(hireIncentivePlans).where(eq(hireIncentivePlans.id, input.incentivePlanId)).limit(1);
    if (!p || p.status !== "published") return { ok: false, error: "That incentive plan is not published.", code: "validation", fieldErrors: [{ field: "plan", message: "Pick a published plan" }] };
    const allowed = b.def.offer.incentivePlanKeys ?? [];
    if (allowed.length && !allowed.includes(p.key)) return { ok: false, error: `This role’s offers use ${allowed.join(", ")} — not ${p.title}.`, code: "validation", fieldErrors: [{ field: "plan", message: "Not this role’s plan" }] };
    planId = p.id;
    planTitle = p.title;
  }
  if (incentiveApplicable && !planId && (b.def.offer.incentivePlanKeys ?? []).length) return { ok: false, error: "Pick the incentive plan, or set Incentive applicable to No.", code: "validation", fieldErrors: [{ field: "plan", message: "Required" }] };
  const components: HireOfferComponent[] = [];
  for (const c of input.components ?? []) {
    if (!c.label.trim()) continue;
    if (!Number.isFinite(c.amountRupees) || c.amountRupees <= 0) return { ok: false, error: `Give an amount for ${c.label.trim()}.`, code: "validation", fieldErrors: [{ field: `component:${c.key}`, message: "Required" }] };
    components.push({ key: c.key || c.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: c.label.trim(), amountPaise: Math.round(c.amountRupees * 100), per: c.per === "year" || c.per === "one_time" ? c.per : "month" });
  }
  return ok({ basicPaise, ctcPaise, gradeLabel: g.label, incentiveApplicable, planId, planTitle, components });
}

const offerStageOpen = (b: AppBundle) => {
  if (b.app.status === "hired") return "They are already hired.";
  if (b.app.status !== "in_progress" && b.app.status !== "on_hold") return `The application is ${b.app.status.replace("_", " ")}.`;
  const at = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
  const offerType = isOnboardingFlow(b.def) ? "compensation" : "document_collection";
  const doc = b.def.stages.findIndex((s) => s.type === offerType);
  if (doc >= 0 && at < doc) return `An offer is made after the decision gate — this candidate is not at ${b.def.stages[doc].name} yet.`;
  return null;
};

/** Whether this offer's basic needs an approver, from the configured line. */
export async function approvalNeeded(proposedBasicPaise: number | null, basicPaise: number): Promise<boolean> {
  const pct = (await getConfig())["hire.compensation.approvalAbovePercent"];
  return needsApproval(proposedBasicPaise, basicPaise, pct);
}

export async function saveOffer(ctx: HireContext, applicationId: string, input: OfferInput): Promise<Result<{ offerId: string }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const closed = offerStageOpen(b);
  if (closed) return err(closed, "rule_violation");
  const v = await validate(b, input);
  if (!v.ok) return v;
  const cur = await currentOffer(applicationId);
  if (cur && (cur.status === "issued" || cur.status === "accepted")) return err("This offer has been issued. Record the candidate’s response — a negotiation starts a new offer.", "rule_violation");
  const proposed = cur?.proposedBasicPaise ?? v.data.basicPaise;
  const reason = input.changeReason?.trim() || null;
  if (cur?.negotiatedFromId && cur.basicPaise !== v.data.basicPaise && (!reason || reason.length < 10))
    return { ok: false, error: "Say why the figure changed — it is kept beside it.", code: "validation", fieldErrors: [{ field: "reason", message: "At least 10 characters" }] };
  const needs = await approvalNeeded(proposed, v.data.basicPaise);
  const figuresMoved = !cur || cur.basicPaise !== v.data.basicPaise || cur.grade !== input.grade;
  /* An approval covers the figure it was given for; a new figure asks again. */
  const approvalStatus = !needs ? "not_needed" : cur?.approvalStatus === "approved" && !figuresMoved ? "approved" : "pending";
  const now = new Date();
  const values = {
    grade: input.grade,
    gradeLabel: v.data.gradeLabel,
    basicPaise: v.data.basicPaise,
    currency: "INR",
    ctcPaise: v.data.ctcPaise,
    incentive: v.data.incentiveApplicable ? (v.data.planTitle ?? (input.incentive?.trim() || b.def.offer.incentive)) : "Not applicable",
    incentiveApplicable: v.data.incentiveApplicable,
    incentivePlanId: v.data.planId,
    components: v.data.components,
    effectiveDate: input.effectiveDate || input.joiningDate || null,
    growth: b.def.offer.growth,
    joiningDate: input.joiningDate || null,
    expiryDate: input.expiryDate || null,
    proposedBasicPaise: proposed,
    approvalStatus,
    ...(approvalStatus === "pending" && cur?.approvalStatus !== "pending" ? { approvalRequestedAt: now, approvalRequestedById: ctx.user.id, approvedById: null, approvedAt: null, approvalNote: null } : {}),
    changeReason: reason ?? cur?.changeReason ?? null,
    updatedAt: now,
    updatedById: ctx.user.id,
  };
  const slabs = await planSlabs(v.data.planId);
  const figures = (o: { basicPaise: number; ctcPaise: number | null; grade: string; incentivePlanId: string | null; incentiveApplicable: boolean; components: HireOfferComponent[] }) => ({ grade: o.grade, basicPaise: o.basicPaise, ctcPaise: o.ctcPaise, incentiveApplicable: o.incentiveApplicable, incentivePlanId: o.incentivePlanId, components: o.components });
  let offerId: string;
  if (cur && cur.status === "draft") {
    offerId = cur.id;
    await db.update(hireOffers).set({ ...values, letter: letterFor(b, { ...cur, ...values }, null, slabs) }).where(eq(hireOffers.id, cur.id));
    const before = figures(cur);
    const after = figures(values);
    if (JSON.stringify(before) !== JSON.stringify(after))
      await hireTrail(ctx, {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "offer",
        entityId: cur.id,
        event: "compensation_changed",
        summary: `Compensation changed${before.basicPaise !== after.basicPaise ? ` · basic ${rupees(before.basicPaise)} → ${rupees(after.basicPaise)}` : ""}${before.ctcPaise !== after.ctcPaise ? ` · CTC ${before.ctcPaise ? rupees(before.ctcPaise) : "—"} → ${after.ctcPaise ? rupees(after.ctcPaise) : "—"}` : ""}${reason ? ` · “${reason}”` : ""}`,
        before,
        after,
      });
  } else {
    offerId = hid("hof");
    await db.insert(hireOffers).values({ id: offerId, applicationId, status: "draft", ...values, letter: letterFor(b, { ...values }, null, slabs), createdById: ctx.user.id });
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: offerId, event: "offer_drafted", summary: `Offer drafted · ${v.data.gradeLabel} · ${rupees(v.data.basicPaise)} a month (INR)`, after: figures(values) });
  }
  if (approvalStatus === "pending" && cur?.approvalStatus !== "pending") {
    const d = basicDelta(proposed, v.data.basicPaise);
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: offerId, event: "compensation_approval_requested", summary: `Approval asked for ${rupees(v.data.basicPaise)} — ${d ? `+${rupees(d.paise)} (+${d.percent}%)` : ""} over the ${rupees(proposed)} first proposed` });
    const tell = [b.app.hiringManagerId].filter((x): x is string => Boolean(x) && x !== ctx.user.id);
    if (tell.length) await notifyUsers(tell.map((u) => ({ userId: u, title: `Approve ${b.candidate.fullName}’s offer`, body: `${b.blueprint.title} · ${rupees(v.data.basicPaise)} a month, ${d ? `+${d.percent}%` : ""} over the first proposal.`, href: `/hire/offers?app=${applicationId}` }))).catch(() => []);
  }
  return ok({ offerId }, approvalStatus === "pending" ? "Draft saved. It waits for approval before it can be issued." : "Draft saved.");
}

export const APPROVAL_NOTE_MIN = 20;

/** Approve or refuse the negotiated figure. The approver is not whoever asked. */
export async function decideApproval(ctx: HireContext, applicationId: string, decision: "approved" | "refused", note: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const o = await currentOffer(applicationId);
  if (!o || o.status !== "draft" || o.approvalStatus !== "pending") return err("There is no figure waiting for approval.", "rule_violation");
  if (o.approvalRequestedById === ctx.user.id && ctx.role !== "admin" && ctx.role !== "hr_head") return err("You asked for this approval — somebody else gives it.", "not_permitted");
  const n = note.trim();
  if (n.length < APPROVAL_NOTE_MIN) return { ok: false, error: `Say why — at least ${APPROVAL_NOTE_MIN} characters. It is kept on the record.`, code: "validation", fieldErrors: [{ field: "note", message: "Required" }] };
  const now = new Date();
  await db.update(hireOffers).set({ approvalStatus: decision, approvedById: ctx.user.id, approvedAt: now, approvalNote: n, updatedAt: now, updatedById: ctx.user.id }).where(and(eq(hireOffers.id, o.id), eq(hireOffers.approvalStatus, "pending")));
  await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: o.id, event: `compensation_${decision}`, summary: `${decision === "approved" ? "Approved" : "Refused"} ${rupees(o.basicPaise)} a month · “${n}”`, after: { approvalStatus: decision } });
  if (o.approvalRequestedById && o.approvalRequestedById !== ctx.user.id)
    await notifyUsers([{ userId: o.approvalRequestedById, title: `${b.candidate.fullName}’s offer ${decision}`, body: `${rupees(o.basicPaise)} a month · ${n}`, href: `/hire/offers?app=${applicationId}` }]).catch(() => []);
  return ok(undefined, decision === "approved" ? "Approved. The offer can be issued." : "Refused. Revise the figure and it asks again.");
}

/** The compensation story from the trail, newest first — what changed, by whom, and why. */
export async function compensationHistory(applicationId: string) {
  const rows = (await db.execute(sql`
    select a.event_type, a.summary, a.actor_name, a.at from hire_audit a
     where a.application_id = ${applicationId} and a.entity_type = 'offer'
     order by a.at desc limit 40`)) as unknown as { event_type: string; summary: string; actor_name: string; at: string }[];
  return rows.map((r) => ({ event: r.event_type, summary: r.summary, by: r.actor_name, at: new Date(r.at).toISOString() }));
}

export async function approverName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1);
  return u?.name ?? null;
}

export async function issueOffer(ctx: HireContext, applicationId: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const closed = offerStageOpen(b);
  if (closed) return err(closed, "rule_violation");
  const o = await currentOffer(applicationId);
  if (!o || o.status !== "draft") return err("Save a draft offer first.", "rule_violation");
  if (!o.joiningDate || !o.expiryDate) return err("Set the joining date and the date the offer expires before issuing it.", "validation");
  if (o.approvalStatus === "pending") return err("The negotiated figure is waiting for approval.", "rule_violation");
  if (o.approvalStatus === "refused") return err("The figure was refused. Revise it and it asks for approval again.", "rule_violation");
  const now = new Date();
  const letter = letterFor(b, o, now, await planSlabs(o.incentivePlanId));
  await db.update(hireOffers).set({ status: "issued", issuedAt: now, issuedById: ctx.user.id, letter, updatedAt: now, updatedById: ctx.user.id }).where(eq(hireOffers.id, o.id));
  await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: o.id, event: "offer_issued", summary: `Offer issued · ${o.gradeLabel} · ${rupees(o.basicPaise)} a month (INR) · joining ${o.joiningDate} · open until ${o.expiryDate}` });
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
  /* The same gate saving and issuing pass: an answer recorded on a rejected
     or withdrawn application used to overwrite its status, its reason and its
     closedAt — reopening, in effect, something somebody had closed. */
  const closed = offerStageOpen(b);
  if (closed) return err(closed, "rule_violation");
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
        incentiveApplicable: o.incentiveApplicable,
        incentivePlanId: o.incentivePlanId,
        components: o.components,
        effectiveDate: o.effectiveDate,
        proposedBasicPaise: o.proposedBasicPaise ?? o.basicPaise,
        approvalStatus: "not_needed",
        negotiatedFromId: o.id,
        letter: o.letter,
        createdById: ctx.user.id,
      });
      await tx.update(hireOffers).set({ supersededById: nid, respondedAt: now, response: "negotiating", growthConfirmation: gc, letterConfirmation: lc, updatedAt: now }).where(eq(hireOffers.id, o.id));
      await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: o.id, event: "offer_negotiating", summary: `Candidate is negotiating · “${input.note.trim()}” · a revised draft was opened from the issued offer` }, tx);
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
    await hireTrail(
      ctx,
      {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "offer",
        entityId: o.id,
        event: `offer_${input.response}`,
        summary: `Offer ${input.response}${gc ? ` · growth plan: ${CONFIRM_LABEL[gc]}` : ""}${lc ? ` · letter: ${CONFIRM_LABEL[lc]}` : ""}${input.note.trim() ? ` · “${input.note.trim()}”` : ""}`,
      },
      tx,
    );
  });
  if (input.response === "accepted" && isOnboardingFlow(b.def)) await advanceIfPassed(ctx, applicationId);
  return ok(undefined, input.response === "accepted" ? (isOnboardingFlow(b.def) ? "Accepted. Documents and verification come next." : "Accepted. Documents and the courier finish this stage.") : "Recorded as declined. The application is closed.");
}

/** The least a withdrawal says — Hire's decision reasons are at least this long. */
export const OFFER_WITHDRAW_MIN = 20;

/**
 * RESCIND AN OFFER WE ISSUED — issued, or already accepted.
 *
 * It was not possible: an issued offer could only be answered (accepted,
 * declined, negotiating), so an offer the business had to take back — the
 * role closed, a reference failed, a background check came back flagged —
 * stood on the record as live until somebody closed the whole application,
 * and the candidate was never told on the record.
 *
 * The offer row becomes `withdrawn` (the status the table always allowed);
 * nothing is deleted, because Hire's record is append-only. The candidate is
 * told in the message log. The APPLICATION STAYS OPEN at Documents & offer:
 * withdrawing an offer and rejecting a person are two decisions, and the
 * second is the gate's or the rejection queue's — a new draft can be made, or
 * the candidate closed, as the next step. A hired person is refused: they
 * have joined, and leaving is HRMS's.
 */
export async function withdrawOffer(ctx: HireContext, applicationId: string, reason: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  if (b.app.status === "hired") return err("They have joined. Leaving is recorded in HRMS, not by withdrawing the offer.", "rule_violation");
  if (b.app.status !== "in_progress" && b.app.status !== "on_hold") return err("This application is already closed.", "rule_violation");
  const why = reason.trim();
  if (why.length < OFFER_WITHDRAW_MIN)
    return { ok: false, error: `Say why — at least ${OFFER_WITHDRAW_MIN} characters. It is kept on the record.`, code: "validation", fieldErrors: [{ field: "reason", message: "Required" }] };
  const o = await currentOffer(applicationId);
  if (!o || (o.status !== "issued" && o.status !== "accepted")) return err("There is no issued or accepted offer to withdraw.", "rule_violation");
  const now = new Date();
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(hireOffers)
      .set({ status: "withdrawn", updatedAt: now, updatedById: ctx.user.id })
      .where(and(eq(hireOffers.id, o.id), inArray(hireOffers.status, ["issued", "accepted"])))
      .returning({ id: hireOffers.id });
    if (!moved.length) throw new Error("offer moved");
    await hireTrail(
      ctx,
      {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "offer",
        entityId: o.id,
        event: "offer_withdrawn",
        summary: `Offer withdrawn by us (it was ${o.status}) · ${o.gradeLabel} · ${rupees(o.basicPaise)} a month · “${why}”`,
      },
      tx,
    );
  });
  await recordMessage(ctx, {
    candidateId: b.candidate.id,
    applicationId,
    direction: "out",
    channel: "portal",
    language: "English",
    subject: `Your offer — ${b.blueprint.title}`,
    body: `We have withdrawn the offer for ${b.blueprint.title} (${o.gradeLabel}) made to you${o.issuedAt ? ` on ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(o.issuedAt)}` : ""}. Someone from the team will be in touch.`,
    status: "logged",
  });
  return ok(undefined, "Offer withdrawn. The application stays open — make a new offer, or close it.");
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
  await hireTrail(ctx, {
    applicationId,
    candidateId: b.candidate.id,
    entityType: "offer",
    entityId: o.id,
    event: "offer_tracking",
    summary: [patch.courierStatus ? `Courier: ${COURIER_LABEL[patch.courierStatus]}` : "", patch.backgroundCheck ? `Background check: ${BG_LABEL[patch.backgroundCheck]}` : ""].filter(Boolean).join(" · "),
  });
  return ok(undefined, "Saved.");
}

export { rupees };
