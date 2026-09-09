"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  customers,
  distributorProfiles,
  distributorSalesmen,
  mbosApprovals,
  notifications,
} from "@/db/schema";
import {
  assertCustomerInScope,
  requireCapability,
} from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { approvalRouteReason } from "@/lib/engines/lead-gates";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { writeTimelineEvent, MBOS_EVENT } from "@/lib/timeline";
import { advanceLeadStage } from "@/lib/actions/leads";

/* ---------------------------------------------------------------------------
 * §11, §12 and §23 — appointing a distributor.
 *
 * A distributor is not a bigger customer. They buy from us, hold the invoice,
 * and sell the goods on through their own network and their own men, so the
 * thirty questions §11 asks are about a BUSINESS rather than about a shop:
 * whether they have a warehouse, how many dealers they carry, what they can
 * fund, and whether anybody is already serving that territory. None of it is
 * true of a paint shop, which is why it lives in `distributor_profiles` rather
 * than as thirty always-null columns on five thousand customers.
 *
 * TWO APPROVAL STEPS, AND THE SECOND ONE IS THE POINT.
 *
 * `stepIndex` 0 is the sales manager putting a candidate forward. That is
 * ordinary work and it stops there for an ordinary appointment. `stepIndex` 1
 * exists because §12's three commercial terms — a special discount, a credit
 * limit, territory exclusivity — are decisions with a price attached, and the
 * person carrying the sales target must not be the person allowing them. It is
 * the same reasoning that keeps `order.approve` away from managers entirely,
 * one level up.
 *
 * WHICH of them forces the second step is not decided here: `approvalRouteReason`
 * in `lib/engines/lead-gates.ts` answers it, pure, from the numbers on the
 * profile and the two thresholds in configuration. The handset, the console and
 * this action all read that one function, so a screen can say "this will go to
 * management" before anybody presses anything and be right.
 *
 * Reads are `lib/services/distributor-service.ts`. Writes are here.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** The table the approval's subject lives in. Written once, read three times. */
const SUBJECT_TYPE = "customers";

function refresh() {
  try {
    revalidatePath("/sales/distributors");
    revalidatePath("/sales/leads/[id]", "page");
    revalidatePath("/crm/customers/[id]", "page");
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/*
 * Two capabilities, two acts, and they are deliberately not one.
 *
 * `distributor.terms` is a manager's: negotiating the discount, the credit limit
 * and the exclusivity. `distributor.approve` is admin's: allowing them. What
 * decides whether the second is needed at all is `approvalRouteReason`, read off
 * the numbers rather than off who typed them — so a manager cannot route around
 * management by agreeing generously.
 *
 * Both had to be ADDED rather than borrowed. `can()` falls through to
 * `!MANAGER_ONLY.has(...)` for anything it does not recognise, so a capability
 * that does not exist is one everybody holds: casting a string into `Capability`
 * would have let a salesman write his own customer a 30% discount, silently.
 */

/**
 * The candidate, and whether the caller may touch it.
 *
 * A lead nobody may see is refused before any of the thirty answers are read —
 * the profile is somebody's business finances, which is not a thing to leak by
 * guessing an id.
 */
async function reachableCandidate(customerId: string) {
  const [row] = await db
    .select({
      id: customers.id,
      name: customers.name,
      kind: customers.kind,
      ownerId: customers.ownerId,
      salesAmId: customers.salesAmId,
      backOfficeAmId: customers.backOfficeAmId,
      salesType: customers.leadSalesType,
      stage: customers.leadStage,
      thirdParty: customers.thirdParty,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!row) return null;
  await assertCustomerInScope(row);
  return row;
}

/* -------------------------------------------------------------- §11 the profile */

/**
 * The thirty answers, all optional, because they arrive over several visits.
 *
 * A form that demanded all thirty in one sitting would be a form filled in with
 * guesses — the salesman finds out about the warehouse on one visit and the
 * dealer count on the next. The GATE is what insists, not the save:
 * `checklistFor` in the gate engine says which are missing before the candidate
 * may move up, and it says it as a list of things to go and ask.
 *
 * §12's three commercial terms are deliberately NOT here. They go through
 * `agreeCommercialTerms`, which is what runs the routing — writing a 30%
 * discount through the profile form would put it on the record with nobody
 * routed to approve it.
 */
const profileSchema = z.object({
  /* business and legal */
  gstVerified: z.boolean().optional(),
  panNumber: z.string().trim().max(20).nullish(),
  panVerified: z.boolean().optional(),
  businessAddressVerified: z.boolean().optional(),
  businessType: z.string().trim().max(80).nullish(),
  yearsInBusiness: z.number().int().min(0).max(200).nullish(),
  decisionMaker: z.string().trim().max(120).nullish(),

  /* distribution capability */
  hasDealerNetwork: z.boolean().optional(),
  activeDealerCount: z.number().int().min(0).nullish(),
  territoryCovered: z.string().trim().max(500).nullish(),
  citiesCovered: z.string().trim().max(500).nullish(),
  salesTeamSize: z.number().int().min(0).nullish(),
  deliveryCapability: z.string().trim().max(500).nullish(),
  hasWarehouse: z.boolean().optional(),
  /** Litres, which is how every capacity in MahekOne is measured. */
  storageCapacityLitres: z.number().int().min(0).nullish(),

  /* commercial capability — every money field is PAISE, integers */
  productPortfolio: z.string().trim().max(1000).nullish(),
  competitorBrands: z.string().trim().max(1000).nullish(),
  monthlyPotentialPaise: z.number().int().min(0).nullish(),
  initialOrderPotentialPaise: z.number().int().min(0).nullish(),
  investmentCapacityPaise: z.number().int().min(0).nullish(),
  expectedMonthlyPurchasePaise: z.number().int().min(0).nullish(),
  creditDaysRequired: z.number().int().min(0).max(365).nullish(),
  creditLimitRequiredPaise: z.number().int().min(0).nullish(),

  /* territory */
  proposedTerritory: z.string().trim().max(500).nullish(),
  existingDistributorChecked: z.boolean().optional(),
  territoryConflict: z.boolean().nullish(),
  territoryConflictNote: z.string().trim().max(1000).nullish(),
  exclusivityRequested: z.boolean().nullish(),

  /* commitment */
  initialStockCommitmentPaise: z.number().int().min(0).nullish(),
  monthlyPurchaseCommitmentPaise: z.number().int().min(0).nullish(),
  dealerDevelopmentCommitment: z.string().trim().max(1000).nullish(),
  expectedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

export type DistributorProfilePatch = z.infer<typeof profileSchema>;

/**
 * Write what we know so far. One row per candidate, for ever.
 *
 * `onConflictDoUpdate` on the customer, not a select-then-insert: two people
 * pressing save on the same candidate a second apart is a double-click and a
 * slow connection, not a second application, and the unique index says so in
 * SQL. Only the keys actually PRESENT in the patch are written — sending the
 * whole shape back would overwrite an answer somebody gave last week with the
 * undefined a half-filled form happens to hold.
 */
export async function saveDistributorProfile(
  customerId: string,
  patch: DistributorProfilePatch,
): Promise<Result<null>> {
  try {
    const parsed = profileSchema.safeParse(patch);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return err(
        "One of those answers is not something MahekOne can store.",
        "validation",
        first ? [{ field: String(first.path[0] ?? "profile"), message: first.message }] : undefined,
      );
    }
    const ctx = await requireCapability("lead.work");
    const candidate = await reachableCandidate(customerId);
    if (!candidate) return err("That candidate no longer exists.", "not_found");
    if (candidate.thirdParty) {
      return err(
        `${candidate.name} is a shop somebody else bills, so it cannot be appointed as a distributor.`,
        "rule_violation",
      );
    }

    /* Undefined means "not answered on this form", null means "answered as
       nothing". They are different facts and only the second may be written. */
    const values = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );
    const now = new Date();

    await db
      .insert(distributorProfiles)
      .values({
        id: id("dpr"),
        customerId,
        ...values,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      })
      .onConflictDoUpdate({
        target: distributorProfiles.customerId,
        set: { ...values, updatedAt: now, updatedById: ctx.user.id },
      });

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      actorRole: ctx.authorisedBy,
      action: "distributor.profile.saved",
      entityType: "distributor_profiles",
      entityId: customerId,
      afterState: values as never,
    });

    refresh();
    return ok(null, "Saved.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* --------------------------------------------------- §12 step 0, the manager */

/**
 * Putting the candidate up for appointment.
 *
 * The row is written PENDING at `stepIndex` 0 and nothing else moves: a
 * submission is a request, and a request that also advanced the lead would be
 * a decision taken by whoever filled in the form.
 *
 * A second submission while one is outstanding is refused rather than stacked.
 * Two pending rows for one candidate would give the queue two identical
 * entries, and whichever one somebody decided would leave the other sitting
 * there for ever looking like an unanswered request.
 */
export async function submitForManagementReview(
  customerId: string,
  note?: string,
): Promise<Result<null>> {
  try {
    const ctx = await requireCapability("lead.work");
    const candidate = await reachableCandidate(customerId);
    if (!candidate) return err("That candidate no longer exists.", "not_found");
    if (candidate.salesType !== "distributor") {
      return err(
        `${candidate.name} is not on the distributor ladder. Set the sales type first — appointing somebody who is being sold to directly is two different arrangements at once.`,
        "rule_violation",
      );
    }

    const [profile] = await db
      .select({ id: distributorProfiles.id })
      .from(distributorProfiles)
      .where(eq(distributorProfiles.customerId, customerId));
    if (!profile) {
      return err(
        "There is nothing to review yet — §11's questions have not been answered for this candidate.",
        "rule_violation",
      );
    }

    const [outstanding] = await db
      .select({ id: mbosApprovals.id })
      .from(mbosApprovals)
      .where(
        and(
          eq(mbosApprovals.type, "distributor_appointment"),
          eq(mbosApprovals.subjectType, SUBJECT_TYPE),
          eq(mbosApprovals.subjectId, customerId),
          eq(mbosApprovals.state, "pending"),
        ),
      );
    if (outstanding) {
      return err("This candidate is already waiting for a decision.", "conflict");
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(mbosApprovals).values({
        id: id("apr"),
        type: "distributor_appointment",
        requestedByUserId: ctx.user.id,
        subjectType: SUBJECT_TYPE,
        subjectId: customerId,
        reason: note?.trim().slice(0, 1000) || null,
        requestedAt: now,
        stepIndex: 0,
        routeReason: "normal",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.distributorSubmitted,
        sourceApp: "crm",
        sourceRecordId: customerId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: "Put forward for appointment as a distributor",
      });
    });

    refresh();
    return ok(null, "Submitted. It is with the sales manager now.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------ §12 the terms, and the routing */

const termsSchema = z.object({
  /** Whole percent. A discount is negotiated in points, never in basis points. */
  discountPercent: z.number().int().min(0).max(100),
  /** PAISE, like every other money column here. */
  creditLimitPaise: z.number().int().min(0),
  exclusivity: z.boolean(),
  note: z.string().trim().max(1000),
});

/**
 * What was actually agreed, and where the appointment goes next because of it.
 *
 * The three numbers are stored and then handed straight to
 * `approvalRouteReason` — the SAME function the screen calls to warn "this will
 * go to management" before anybody presses anything. Deciding the routing here
 * with a second copy of the thresholds is how the warning and the behaviour come
 * to disagree, and the half that drifts is always the half somebody reads.
 *
 * Where it routes, a `stepIndex` 1 row is created BESIDE the step 0 one rather
 * than replacing it: the owner is escalated TO, never substituted for. Skipping
 * the sales manager removes the only person who has actually met the candidate.
 */
export async function agreeCommercialTerms(
  customerId: string,
  input: z.infer<typeof termsSchema>,
): Promise<Result<null>> {
  try {
    const parsed = termsSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return err(
        "The agreed terms need a discount, a credit limit and an answer on exclusivity.",
        "validation",
        first ? [{ field: String(first.path[0] ?? "discountPercent"), message: first.message }] : undefined,
      );
    }
    const ctx = await requireCapability("distributor.terms");
    const candidate = await reachableCandidate(customerId);
    if (!candidate) return err("That candidate no longer exists.", "not_found");

    const config = await getConfig();
    const thresholds = {
      discountPercent: config["leads.distributorDiscountApprovalPercent"],
      creditLimitPaise: config["leads.distributorCreditLimitApprovalPaise"],
    };

    const terms = {
      specialDiscountPercent: parsed.data.discountPercent,
      agreedCreditLimitPaise: parsed.data.creditLimitPaise,
      exclusivityGranted: parsed.data.exclusivity,
      commercialTermsNote: parsed.data.note || null,
    };
    /* Asked of the terms being agreed NOW, not of the row as it stands: the
       write and the routing have to describe the same set of numbers, and
       reading back after the update would answer for whatever a concurrent
       save happened to leave there. */
    const routeReason = approvalRouteReason(terms, thresholds);
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .insert(distributorProfiles)
        .values({
          id: id("dpr"),
          customerId,
          ...terms,
          commercialTermsAgreedAt: now,
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        })
        .onConflictDoUpdate({
          target: distributorProfiles.customerId,
          set: {
            ...terms,
            commercialTermsAgreedAt: now,
            updatedAt: now,
            updatedById: ctx.user.id,
          },
        });

      if (routeReason) {
        const [existing] = await tx
          .select({ id: mbosApprovals.id })
          .from(mbosApprovals)
          .where(
            and(
              eq(mbosApprovals.type, "distributor_appointment"),
              eq(mbosApprovals.subjectType, SUBJECT_TYPE),
              eq(mbosApprovals.subjectId, customerId),
              eq(mbosApprovals.stepIndex, 1),
              eq(mbosApprovals.state, "pending"),
            ),
          );

        if (existing) {
          /* Terms renegotiated while management were still looking at them.
             The row stays — a second one would put the same candidate in the
             queue twice — and its reason is restated, because what management
             are being asked to allow has changed. */
          await tx
            .update(mbosApprovals)
            .set({
              routeReason,
              reason: termsSentence(parsed.data),
              requestedAt: now,
              updatedAt: now,
              updatedById: ctx.user.id,
            })
            .where(eq(mbosApprovals.id, existing.id));
        } else {
          await tx.insert(mbosApprovals).values({
            id: id("apr"),
            type: "distributor_appointment",
            requestedByUserId: ctx.user.id,
            subjectType: SUBJECT_TYPE,
            subjectId: customerId,
            reason: termsSentence(parsed.data),
            requestedAt: now,
            stepIndex: 1,
            routeReason,
            createdById: ctx.user.id,
            updatedById: ctx.user.id,
          });
        }
      }

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.distributorTerms,
        sourceApp: "crm",
        sourceRecordId: customerId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: routeReason
          ? `Terms agreed and sent to management: ${termsSentence(parsed.data)}`
          : `Terms agreed: ${termsSentence(parsed.data)}`,
      });

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        action: "distributor.terms.agreed",
        entityType: "distributor_profiles",
        entityId: customerId,
        afterState: { ...terms, routeReason } as never,
      });
    });

    refresh();
    return ok(
      null,
      routeReason
        ? "Terms recorded. These need management's approval, so it has gone up."
        : "Terms recorded.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** One line an approver reads before deciding. Never parsed by anything. */
function termsSentence(t: z.infer<typeof termsSchema>): string {
  const money = Math.round(t.creditLimitPaise / 100).toLocaleString("en-IN");
  return (
    `${t.discountPercent}% discount, credit limit ₹${money}` +
    (t.exclusivity ? ", territory exclusivity granted" : "")
  );
}

/* -------------------------------------------------- §12 deciding, either step */

const decisionSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * The decision, and WHO may take it depends entirely on which step it is.
 *
 * Step 0 is a manager's; step 1 is `distributor.approve`, which is admin's and
 * is the whole reason the second step exists. A manager deciding step 1 is
 * refused HERE, in the action, rather than by not drawing them a button — a
 * server action is a URL, and the unaudited door always wins in the end. The
 * refusal names the step and who holds it, because "not permitted" with no
 * route out is how somebody ends up granted admin instead.
 *
 * An appointment is approved when its HIGHEST step is, which is what keeps the
 * subject's state derived from this table rather than written beside it. So a
 * step 0 approval on a candidate with an outstanding step 1 advances nothing —
 * it records that the sales manager is content, which is a real fact and not
 * an appointment.
 */
export async function decideDistributorAppointment(
  approvalId: string,
  input: z.infer<typeof decisionSchema>,
): Promise<Result<null>> {
  try {
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) return err("Say whether this is approved.", "validation");
    const { approve, note } = parsed.data;
    if (!approve && !note) {
      return err(
        "A refusal needs a reason — somebody has to go back to the candidate and say something.",
        "validation",
        [{ field: "note", message: "Say why it was refused." }],
      );
    }

    const [approval] = await db
      .select({
        id: mbosApprovals.id,
        subjectId: mbosApprovals.subjectId,
        subjectType: mbosApprovals.subjectType,
        stepIndex: mbosApprovals.stepIndex,
        state: mbosApprovals.state,
        routeReason: mbosApprovals.routeReason,
        requestedByUserId: mbosApprovals.requestedByUserId,
      })
      .from(mbosApprovals)
      .where(
        and(eq(mbosApprovals.id, approvalId), eq(mbosApprovals.type, "distributor_appointment")),
      );
    if (!approval) return err("That request no longer exists.", "not_found");
    if (approval.state !== "pending") {
      return err("Somebody has already decided this one.", "conflict");
    }

    /* The capability is the step's, and the two are not interchangeable. */
    const ctx =
      approval.stepIndex >= 1
        ? await requireCapability("distributor.approve")
        : await requireCapability("distributor.terms");

    const candidate = await reachableCandidate(approval.subjectId);
    if (!candidate) return err("That candidate no longer exists.", "not_found");

    const now = new Date();
    let appointed = false;

    await db.transaction(async (tx) => {
      await tx
        .update(mbosApprovals)
        .set({
          state: approve ? "approved" : "rejected",
          approverUserId: ctx.user.id,
          decidedAt: now,
          decisionNote: note ?? null,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(eq(mbosApprovals.id, approval.id));

      /* Is anything still outstanding? The appointment stands on its highest
         step, so a step 0 yes with management still to answer appoints
         nobody. Read inside the transaction, after the write, so the row just
         decided is counted as decided. */
      const stillPending = await tx
        .select({ id: mbosApprovals.id })
        .from(mbosApprovals)
        .where(
          and(
            eq(mbosApprovals.type, "distributor_appointment"),
            eq(mbosApprovals.subjectType, SUBJECT_TYPE),
            eq(mbosApprovals.subjectId, approval.subjectId),
            eq(mbosApprovals.state, "pending"),
          ),
        );
      appointed = approve && stillPending.length === 0;

      await writeTimelineEvent(tx, {
        customerId: approval.subjectId,
        eventType: `distributor_decision_${approval.stepIndex}`,
        sourceApp: "crm",
        sourceRecordId: approval.id,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: approve
          ? approval.stepIndex >= 1
            ? "Management approved the appointment"
            : "The sales manager put the appointment forward"
          : `Appointment refused: ${note ?? "no reason recorded"}`,
      });

      /* The person who asked is told either way. A request that is simply
         answered somewhere else is a request they go on chasing. */
      if (approval.requestedByUserId) {
        await tx.insert(notifications).values({
          id: id("notif"),
          userId: approval.requestedByUserId,
          title: approve ? "Distributor appointment approved" : "Distributor appointment refused",
          body: approve
            ? `${candidate.name} has been approved at step ${approval.stepIndex + 1}.`
            : `${candidate.name}: ${note ?? "no reason recorded"}`,
          kind: approve ? "success" : "warning",
          href: `/sales/leads/${approval.subjectId}`,
        });
      }

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        action: approve ? "distributor.approved" : "distributor.rejected",
        entityType: "mbos_approvals",
        entityId: approval.id,
        afterState: {
          customerId: approval.subjectId,
          stepIndex: approval.stepIndex,
          routeReason: approval.routeReason,
          note: note ?? null,
        } as never,
      });
    });

    refresh();

    if (!appointed) {
      return ok(
        null,
        approve
          ? "Recorded. It still needs management's approval."
          : "Refused, and the reason is on the record.",
      );
    }

    /*
     * Appointed — and the ladder is moved by the action that owns the ladder.
     *
     * `advanceLeadStage` holds the gate engine, the transition row and the
     * `kind` flip; re-implementing any of that here would be a second copy of
     * §28 that drifts. A refusal from it does NOT undo the decision: the
     * appointment is recorded and true, and the stage is a projection of it —
     * so it comes back as a warning naming what the gate is still waiting on,
     * which is something somebody can act on.
     */
    const moved = await advanceLeadStage({
      customerId: approval.subjectId,
      to: "distributor_approval",
      note: "Appointment approved",
    });

    return moved.ok
      ? ok(null, "Appointed. They are billable from here.")
      : ok(null, "Appointed. The ladder did not move: " + moved.error, [moved.error]);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------ §12 the paperwork */

const agreementSchema = z.object({
  attachmentId: z.string().min(1).optional(),
});

/**
 * The signed agreement is on file.
 *
 * TODO(integration): the signed document itself has nowhere to live yet.
 * `attachments.parent_type` is an enum and it has no `distributor_agreement`
 * value, so a file bound here would either be filed under a parent kind whose
 * READ rules are somebody else's — `canRead` decides who may open a file from
 * the parent kind, and a contract read under the document rules is a contract
 * readable by the field — or left unparented, which is worse: `sweepOrphans`
 * runs nightly and deletes exactly that. A signed distributor agreement
 * vanishing twenty-four hours after it was uploaded, silently, is the single
 * worst outcome available here.
 *
 * So an attachment is REFUSED, in words, rather than accepted and lost. The
 * agreement itself is recorded, because the fact that it was signed is worth
 * having with or without the scan. Adding the enum value is a migration in
 * `src/db/schema.ts`, which this workstream does not own.
 */
export async function recordDistributorAgreement(
  customerId: string,
  input: z.infer<typeof agreementSchema> = {},
): Promise<Result<null>> {
  try {
    const parsed = agreementSchema.safeParse(input);
    if (!parsed.success) return err("That attachment id is not one MahekOne can read.", "validation");

    const ctx = await requireCapability("lead.work");
    const candidate = await reachableCandidate(customerId);
    if (!candidate) return err("That candidate no longer exists.", "not_found");

    if (parsed.data.attachmentId) {
      return err(
        "MahekOne cannot file the signed agreement yet — there is nowhere for it to live, and an unfiled document is deleted by the nightly sweep. Record the agreement without it and keep the paper for now.",
        "rule_violation",
        [{ field: "attachmentId", message: "Not yet supported." }],
      );
    }

    /* Every appointment step is decided before this one. Recording an
       agreement for a candidate nobody appointed would put a signed contract
       on the record of somebody we never said yes to. */
    const [approved] = await db
      .select({ id: mbosApprovals.id })
      .from(mbosApprovals)
      .where(
        and(
          eq(mbosApprovals.type, "distributor_appointment"),
          eq(mbosApprovals.subjectType, SUBJECT_TYPE),
          eq(mbosApprovals.subjectId, customerId),
          eq(mbosApprovals.state, "approved"),
        ),
      )
      .orderBy(desc(mbosApprovals.stepIndex))
      .limit(1);
    if (!approved) {
      return err(
        `${candidate.name} has not been appointed yet, so there is no agreement to record.`,
        "rule_violation",
      );
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.distributorAgreement,
        sourceApp: "crm",
        sourceRecordId: customerId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: "Distributor agreement signed and on file",
      });

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        action: "distributor.agreement.recorded",
        entityType: "customers",
        entityId: customerId,
      });
    });

    const moved = await advanceLeadStage({
      customerId,
      to: "distributor_agreement",
      note: "Agreement signed",
    });

    refresh();
    return moved.ok
      ? ok(null, "Recorded.")
      : ok(null, "Recorded. The ladder did not move: " + moved.error, [moved.error]);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------ §23 the distributor's man */

const salesmanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Ten digits, as everything else in this product stores an Indian mobile. */
  mobile: z.string().trim().max(20).optional(),
  territory: z.string().trim().max(200).optional(),
});

/**
 * §23 — Rahul, who works for the distributor and not for us.
 *
 * He is DELIBERATELY not a `users` row and must never become one. He has no
 * MahekOne login, he will never sign in, and giving him an account would put
 * him in every person picker in the product, in the scope resolution, and in
 * the list of people a target can be set for. He is a fact about how a shop is
 * served — the same kind of fact `sales_person_name` already is — and the shops
 * he serves point at him through `customer_distributors.distributor_salesman_id`.
 *
 * The distributor he belongs to must be an account we BILL, or somebody we have
 * appointed. A shop somebody else invoices has no men of its own to record here,
 * and a lead that has never been appointed does not have a distribution network
 * we know anything about.
 */
export async function createDistributorSalesman(
  distributorCustomerId: string,
  input: z.infer<typeof salesmanSchema>,
): Promise<Result<{ id: string }>> {
  try {
    const parsed = salesmanSchema.safeParse(input);
    if (!parsed.success) {
      return err("A distributor's salesman needs a name.", "validation", [
        { field: "name", message: "His name, as the distributor gives it." },
      ]);
    }
    const ctx = await requireCapability("lead.work");
    const distributor = await reachableCandidate(distributorCustomerId);
    if (!distributor) return err("That distributor no longer exists.", "not_found");

    if (distributor.thirdParty) {
      return err(
        `${distributor.name} is a shop somebody else bills, so it has no salesmen of its own to record.`,
        "rule_violation",
      );
    }
    const appointed =
      distributor.kind === "customer" || distributor.salesType === "distributor";
    if (!appointed) {
      return err(
        `${distributor.name} is not a distributor. Set the sales type, or appoint them, before recording their people.`,
        "rule_violation",
      );
    }

    const salesmanId = id("dsm");
    await db.insert(distributorSalesmen).values({
      id: salesmanId,
      distributorCustomerId,
      name: parsed.data.name,
      mobile: parsed.data.mobile || null,
      territory: parsed.data.territory || null,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    await db.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      actorRole: ctx.authorisedBy,
      action: "distributor.salesman.created",
      entityType: "distributor_salesmen",
      entityId: salesmanId,
      afterState: { distributorCustomerId, ...parsed.data } as never,
    });

    refresh();
    return ok({ id: salesmanId }, `${parsed.data.name} recorded.`);
  } catch (e) {
    return fromThrown(e);
  }
}
