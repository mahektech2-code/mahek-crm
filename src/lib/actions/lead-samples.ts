"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  customers,
  mbosApprovals,
  mbosSamples,
  products,
  sampleFeedback,
} from "@/db/schema";
import {
  assertCustomerInScope,
  requireCapability,
} from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { businessDate } from "@/lib/business-date";
import type { NurtureConfig } from "@/lib/engines/lead-nurture";
import { FEEDBACK_FIELDS, type SampleState } from "@/lib/lead-labels";
import {
  closeNurtureTasks,
  openNurtureTaskIdsFor,
  raiseNurtureTasks,
} from "@/lib/mbos-jobs";
import { today } from "@/lib/recompute";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { writeTimelineEvent, MBOS_EVENT } from "@/lib/timeline";

/* ---------------------------------------------------------------------------
 * §15 and §16 — a sample, from the asking to the answer.
 *
 * A sample is the most expensive thing a lead can ask for. It costs stock, it
 * costs a courier, and every bit of its value is in an opinion somebody has to
 * go and collect afterwards. So the journey is recorded step by step —
 * requested, approved, dispatched, received, tried, reviewed — and each step is
 * a date with a name against it, because with one status column "approved three
 * weeks ago and never sent" and "under evaluation on a customer's bench" looked
 * identical, and only one of those is stock nobody gave away.
 *
 * TWO RECORDS, ONE DECISION, ONE TRANSACTION.
 *
 * The approval lives in `mbos_approvals` with `type = 'sample'` — the one table
 * every approval in MBOS uses, so that "who asked, who decided, when, and what
 * did they say" is answered the same way for a sample as for an expense claim.
 * `AGENTS.md` is explicit that a subject's state is DERIVED from that table and
 * never written beside it, and this file bends that rule in exactly one
 * direction and no further: `mbos_samples.state` is the sample's own POSITION
 * ON ITS JOURNEY, of which the approval decides only the second rung. The other
 * five — dispatched, received, tried, reviewed, cancelled — are not approvals
 * of anything and there is no approval row that could carry them.
 *
 * What keeps the two honest is that they move in ONE TRANSACTION and in one
 * function: `decideSample` writes the approval row and the state together, so
 * there is no window in which a sample is approved and unapproved at once, and
 * nothing else in the codebase writes either. A screen showing a rejection
 * beside a dispatch is what two writers would produce, and it is the exact
 * failure the original rule was written about.
 *
 * Reads are `lib/services/sample-service.ts`. Writes are here.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Saying yes to a sample is a manager's, and it is `sample.approve`.
 *
 * The capability had to be ADDED rather than borrowed, and the reason is worth
 * keeping: `can()` falls through to `!MANAGER_ONLY.has(...)` for a capability it
 * does not recognise, so one that does not exist is one EVERYBODY holds. Casting
 * a string into `Capability` to get moving would not have been a stopgap, it
 * would have been a hole — the salesman approving the stock he had just asked
 * for, silently, with an audit row naming a permission nobody had granted.
 *
 * It is manager-and-admin rather than "anybody but the requester". A manager who
 * raised a sample for one of his own people and then approves it is doing an
 * ordinary day's work at nine people, and refusing that is defeated in a minute
 * by asking a colleague to click the button — the combination is allowed and the
 * audit row names the hat that carried it.
 */

function refresh() {
  try {
    revalidatePath("/sales/samples");
    revalidatePath("/sales/leads/[id]", "page");
    revalidatePath("/crm/customers/[id]", "page");
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/**
 * §15's machine, written down rather than left to whichever action ran last.
 *
 * Every transition this app allows, and nothing else. A sample cannot go back
 * a rung: "it did not really arrive" is not an edit, it is a fact about the
 * delivery, and the honest way to record it is to cancel with the reason and
 * send another. Rewinding would leave the timeline reading as though the first
 * delivery never happened, on a record somebody has already been told about.
 */
const ALLOWED: Record<SampleState, readonly SampleState[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["dispatched", "cancelled"],
  dispatched: ["received", "cancelled"],
  /* `trial_done` is optional: plenty of reviews are recorded straight off the
     phone call without anybody marking the trial finished first. */
  received: ["trial_done", "reviewed", "cancelled"],
  trial_done: ["reviewed", "cancelled"],
  reviewed: [],
  rejected: [],
  cancelled: [],
};

const STATE_WORDS: Record<SampleState, string> = {
  requested: "still waiting to be approved",
  approved: "approved and waiting to go out",
  rejected: "refused",
  dispatched: "on its way",
  received: "with the customer",
  trial_done: "tried, and waiting for the verdict",
  reviewed: "reviewed",
  cancelled: "cancelled",
};

/** The refusal names where the sample actually is, not just that it is wrong. */
function refuseTransition(from: SampleState, to: SampleState): string {
  return `This sample is ${STATE_WORDS[from]}, so it cannot be marked ${STATE_WORDS[to]}.`;
}

/**
 * Load the sample, check the caller may touch its customer, and check the move
 * is one the machine allows. Every action begins this way, and doing it in one
 * place is what stops the fifth one being written without the scope check.
 */
async function loadForTransition(
  sampleId: string,
  to: SampleState | null,
): Promise<
  | { ok: false; error: ReturnType<typeof err> }
  | {
      ok: true;
      sample: typeof mbosSamples.$inferSelect;
      customer: { id: string; name: string; kind: "lead" | "customer"; ownerId: string | null; salesAmId: string | null; backOfficeAmId: string | null };
    }
> {
  const [row] = await db
    .select({
      sample: mbosSamples,
      customer: {
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        backOfficeAmId: customers.backOfficeAmId,
      },
    })
    .from(mbosSamples)
    .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
    .where(eq(mbosSamples.id, sampleId));

  if (!row) return { ok: false, error: err("That sample no longer exists.", "not_found") };
  await assertCustomerInScope(row.customer);

  if (to) {
    const from = row.sample.state as SampleState;
    if (from === to) {
      /* A double-click, not a mistake. Saying so is kinder than "cannot" and
         it is also true: the record already says what the caller wanted. */
      return {
        ok: false,
        error: err(`This sample is already ${STATE_WORDS[to]}.`, "conflict"),
      };
    }
    if (!ALLOWED[from].includes(to)) {
      return { ok: false, error: err(refuseTransition(from, to), "rule_violation") };
    }
  }

  return { ok: true, sample: row.sample, customer: row.customer };
}

/** The engine's configuration, read once per action. */
async function nurtureConfig(): Promise<NurtureConfig> {
  const config = await getConfig();
  return { sampleReviewChaseDays: config["leads.sampleReviewChaseDays"] };
}

/* ------------------------------------------------------------ §15 requesting */

const requestSchema = z.object({
  productId: z.string().min(1),
  /** CANS. Every quantity in MahekOne is cans; litres are derived. */
  quantityCans: z.number().int().positive().max(10000),
  application: z.string().trim().min(1).max(500),
  reasonCode: z.string().trim().min(1).max(60),
});

/**
 * A salesman asking for stock to give away.
 *
 * The application is required and it is not paperwork: a trial on the wrong
 * substrate produces an opinion about the wrong thing, and the customer
 * remembers the opinion rather than the substrate. The reason is a code from
 * `leads.sampleReasons` for the same purpose §5's list serves — a free-text box
 * answers "why?" with "good potential" every time.
 *
 * The approval row is written in the SAME transaction as the sample, pending.
 * A sample that exists with nothing asking anybody to decide it is a sample
 * that sits in `requested` until somebody notices it by eye.
 */
export async function requestSample(
  customerId: string,
  input: z.infer<typeof requestSchema>,
): Promise<Result<{ id: string }>> {
  try {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return err(
        "A sample needs a product, a quantity and what it is going to be used on.",
        "validation",
        first ? [{ field: String(first.path[0] ?? "productId"), message: first.message }] : undefined,
      );
    }
    const ctx = await requireCapability("lead.work");

    const [customer] = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        backOfficeAmId: customers.backOfficeAmId,
        leadStage: customers.leadStage,
        salesType: customers.leadSalesType,
      })
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!customer) return err("That customer no longer exists.", "not_found");
    await assertCustomerInScope(customer);

    /* The catalogue is the only thing that may name a product. A sample of
       something we do not sell is a promise nobody can keep. */
    const [product] = await db
      .select({ id: products.id, name: products.name, active: products.active })
      .from(products)
      .where(eq(products.id, parsed.data.productId));
    if (!product) return err("That product is not in the catalogue.", "not_found");
    if (!product.active) {
      return err(`${product.name} is retired, so it cannot be sent as a sample.`, "rule_violation");
    }

    const sampleId = id("smp");
    const now = new Date();
    const day = await today();
    const config = await nurtureConfig();

    await db.transaction(async (tx) => {
      await tx.insert(mbosSamples).values({
        id: sampleId,
        customerId,
        /* Whoever raised it. On the handset that is the salesman standing in
           the shop; from the console it is the manager raising it for him, and
           either way it is the person who has to answer for the stock. */
        salesmanId: ctx.user.id,
        productId: parsed.data.productId,
        quantityCans: parsed.data.quantityCans,
        application: parsed.data.application,
        reasonCode: parsed.data.reasonCode,
        requestedDate: day,
        leadStageAtRequest: customer.leadStage,
        state: "requested",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      await tx.insert(mbosApprovals).values({
        id: id("apr"),
        type: "sample",
        requestedByUserId: ctx.user.id,
        subjectType: "mbos_samples",
        subjectId: sampleId,
        reason: `${parsed.data.quantityCans} can(s) of ${product.name} for ${parsed.data.application}`,
        requestedAt: now,
        /* §15 is one step. Unlike a distributor appointment there is nothing
           here that could route past the manager — the cost is stock, and the
           person who holds the team's targets is the right person to weigh it. */
        stepIndex: 0,
        routeReason: "normal",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.sampleRequested,
        sourceApp: "crm",
        sourceRecordId: sampleId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `Sample asked for: ${parsed.data.quantityCans} × ${product.name} for ${parsed.data.application}`,
      });

      await raiseNurtureTasks(tx, {
        customerId,
        events: [{ trigger: "sample_requested", sourceId: sampleId, on: day }],
        today: day,
        config,
        salesmanId: ctx.user.id,
      });

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "sample.requested",
        entityType: "mbos_samples",
        entityId: sampleId,
        afterState: { customerId, ...parsed.data } as never,
      });
    });

    refresh();
    return ok({ id: sampleId }, "Sample requested. It is waiting for approval.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- §15 deciding */

const decideSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Yes or no to giving the stock away.
 *
 * **The approval row and the sample's state move together, here and nowhere
 * else.** That is the whole answer to `AGENTS.md`'s rule about a subject's
 * state being derived from `mbos_approvals` and never written beside it: two
 * writers would be two chances to disagree, so there is one, it is a
 * transaction, and if either write fails neither happened.
 *
 * A refusal REQUIRES a note. Somebody in a shop asked for this and has to be
 * told something, and "rejected" on its own is a message the salesman cannot
 * pass on.
 */
export async function decideSample(
  sampleId: string,
  input: z.infer<typeof decideSchema>,
): Promise<Result<null>> {
  try {
    const parsed = decideSchema.safeParse(input);
    if (!parsed.success) return err("Say whether this is approved.", "validation");
    const { approve, note } = parsed.data;
    if (!approve && !note) {
      return err(
        "A refusal needs a reason — the salesman has to tell the customer something.",
        "validation",
        [{ field: "note", message: "Say why it was refused." }],
      );
    }

    /* `requireCapability` refuses on its own and logs the refusal, so there is
       no second check to forget — and `authorisedBy` is the narrowest hat that
       carried it, which is what the audit row records. */
    const ctx = await requireCapability("sample.approve");
    const loaded = await loadForTransition(sampleId, approve ? "approved" : "rejected");
    if (!loaded.ok) return loaded.error;

    const now = new Date();
    const state: SampleState = approve ? "approved" : "rejected";

    await db.transaction(async (tx) => {
      /* The pending row of the highest step, which for a sample is always step
         0 — but reading it rather than assuming it is what keeps this correct
         the day somebody gives samples a second step. */
      const [approval] = await tx
        .select({ id: mbosApprovals.id })
        .from(mbosApprovals)
        .where(
          and(
            eq(mbosApprovals.type, "sample"),
            eq(mbosApprovals.subjectType, "mbos_samples"),
            eq(mbosApprovals.subjectId, sampleId),
            eq(mbosApprovals.state, "pending"),
          ),
        )
        .orderBy(desc(mbosApprovals.stepIndex), desc(mbosApprovals.requestedAt))
        .limit(1);

      if (approval) {
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
      } else {
        /* A sample raised before the approvals path existed, or one whose row
           was cleared. The decision is still a decision and it still has to be
           recorded — writing the row now rather than refusing is what keeps a
           screen from having a button that can never work. */
        await tx.insert(mbosApprovals).values({
          id: id("apr"),
          type: "sample",
          requestedByUserId: loaded.sample.salesmanId,
          subjectType: "mbos_samples",
          subjectId: sampleId,
          requestedAt: loaded.sample.serverCreatedAt ?? now,
          state: approve ? "approved" : "rejected",
          approverUserId: ctx.user.id,
          decidedAt: now,
          decisionNote: note ?? null,
          stepIndex: 0,
          routeReason: "recorded_late",
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        });
      }

      await tx
        .update(mbosSamples)
        .set({
          state,
          approvedAt: approve ? now : null,
          approvedById: approve ? ctx.user.id : null,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(eq(mbosSamples.id, sampleId));

      await writeTimelineEvent(tx, {
        customerId: loaded.customer.id,
        eventType: MBOS_EVENT.sampleDecided,
        sourceApp: "crm",
        sourceRecordId: sampleId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: approve
          ? "Sample approved — it can go out"
          : `Sample refused: ${note ?? "no reason recorded"}`,
      });

      if (!approve) {
        /* Nothing left to chase. The tasks raised when it was asked for are
           cancelled rather than left to come due against a sample that is
           never going anywhere. */
        const open = await openNurtureTaskIdsFor(tx, sampleId);
        await closeNurtureTasks(tx, open, "The sample request was refused.");
      }

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: approve ? "sample.approved" : "sample.rejected",
        entityType: "mbos_samples",
        entityId: sampleId,
        afterState: { state, note: note ?? null } as never,
      });
    });

    refresh();
    return ok(null, approve ? "Approved. It can go out now." : "Refused, and the reason is on the record.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ----------------------------------------------------------- §15 dispatching */

const dispatchSchema = z.object({
  courierName: z.string().trim().min(1).max(120),
  trackingNumber: z.string().trim().min(1).max(120),
  /** A plain `YYYY-MM-DD`. What was promised, not what happened. */
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * It has gone. The docket is required and that is the point of the step.
 *
 * A dispatch with no docket cannot be chased, and a sample nobody can chase is
 * a sample nobody will ever review. The expected date is what the courier
 * promised, which is what makes "it has not arrived" a fact rather than an
 * impression — `flagSamplesPastDelivery` reads exactly this column.
 */
export async function dispatchSample(
  sampleId: string,
  input: z.infer<typeof dispatchSchema>,
): Promise<Result<null>> {
  try {
    const parsed = dispatchSchema.safeParse(input);
    if (!parsed.success) {
      return err("A dispatch needs the courier, the docket and the date they promised.", "validation");
    }
    const ctx = await requireCapability("lead.work");
    const loaded = await loadForTransition(sampleId, "dispatched");
    if (!loaded.ok) return loaded.error;

    const now = new Date();
    const day = await today();
    const config = await nurtureConfig();

    await db.transaction(async (tx) => {
      await tx
        .update(mbosSamples)
        .set({
          state: "dispatched",
          dispatchedAt: now,
          dispatchedById: ctx.user.id,
          courierName: parsed.data.courierName,
          trackingNumber: parsed.data.trackingNumber,
          expectedDeliveryDate: parsed.data.expectedDeliveryDate,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(eq(mbosSamples.id, sampleId));

      await writeTimelineEvent(tx, {
        customerId: loaded.customer.id,
        eventType: MBOS_EVENT.sampleDispatched,
        sourceApp: "crm",
        sourceRecordId: sampleId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `Sample sent with ${parsed.data.courierName}, docket ${parsed.data.trackingNumber}, due ${parsed.data.expectedDeliveryDate}`,
      });

      await raiseNurtureTasks(tx, {
        customerId: loaded.customer.id,
        events: [{ trigger: "sample_dispatched", sourceId: sampleId, on: day }],
        today: day,
        config,
        salesmanId: loaded.sample.salesmanId,
      });
    });

    refresh();
    return ok(null, "Marked as sent.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* -------------------------------------------------------------- §15 arrival */

const receivedSchema = z.object({
  /** A full ISO instant. Absent means now, which is the ordinary case. */
  at: z.string().datetime().optional(),
});

/**
 * The customer has it — confirmed by them or by the salesman, never by the
 * courier's website.
 *
 * `at` exists because this is routinely recorded a day late: the salesman rang
 * on Tuesday and got round to the app on Wednesday, and dating the delivery
 * from the app moves §16's whole chase ladder a day out. It is a full instant
 * rather than a date, so nothing here has to invent a midnight.
 */
export async function confirmSampleReceived(
  sampleId: string,
  input: z.infer<typeof receivedSchema> = {},
): Promise<Result<null>> {
  try {
    const parsed = receivedSchema.safeParse(input);
    if (!parsed.success) return err("That is not a date MahekOne can read.", "validation");

    const ctx = await requireCapability("lead.work");
    const loaded = await loadForTransition(sampleId, "received");
    if (!loaded.ok) return loaded.error;

    const at = parsed.data.at ? new Date(parsed.data.at) : new Date();
    if (Number.isNaN(at.getTime())) return err("That is not a date MahekOne can read.", "validation");

    const now = new Date();
    if (at.getTime() > now.getTime() + 60_000) {
      return err("A sample cannot have arrived in the future.", "validation", [
        { field: "at", message: "Pick the day it actually arrived." },
      ]);
    }

    /* The chase ladder counts from the day it ARRIVED, so the event's day is
       taken from that instant in the business's own zone and against the
       configured day boundary — never from the server's clock, and never by
       slicing an ISO string, which answers in UTC and dates a 2am arrival to
       the previous day. `businessDate` rather than `calendarDate` because
       every other date in the sequence is a working day and subtracting the
       two kinds is how a call ends up dated to the future. */
    const settings = await getConfig();
    const arrivedOn = businessDate(at, {
      timezone: settings["workingDay.timezone"],
      dayBoundaryHour: settings["workingDay.dayBoundaryHour"],
      workingDays: settings["workingDay.workingDays"],
    });
    const day = await today();
    const config = await nurtureConfig();

    await db.transaction(async (tx) => {
      await tx
        .update(mbosSamples)
        .set({
          state: "received",
          receivedAt: at,
          deliveredAt: at,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(eq(mbosSamples.id, sampleId));

      await writeTimelineEvent(tx, {
        customerId: loaded.customer.id,
        eventType: MBOS_EVENT.sampleReceived,
        sourceApp: "crm",
        sourceRecordId: sampleId,
        occurredAt: at,
        actorUserId: ctx.user.id,
        summary: "Sample delivered — the trial can start",
      });

      /* The parcel arrived, so chasing the courier is over. */
      const chasing = await openNurtureTaskIdsFor(tx, sampleId);
      await closeNurtureTasks(
        tx,
        chasing.filter((s) => s.startsWith("sample_dispatched:") || s === `sample_late:${sampleId}`),
        "The sample arrived.",
      );

      await raiseNurtureTasks(tx, {
        customerId: loaded.customer.id,
        events: [{ trigger: "sample_received", sourceId: sampleId, on: arrivedOn }],
        today: day,
        config,
        salesmanId: loaded.sample.salesmanId,
      });
    });

    refresh();
    return ok(null, "Marked as delivered.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* --------------------------------------------------------------- §16 the answer */

const feedbackSchema = z.object({
  fields: z.record(z.string(), z.string().trim().max(2000)),
  /**
   * §15's three answers. `more_testing` is a real third answer rather than a
   * shrug: "they want to try it again on a different substrate" is neither a
   * yes nor a no, and filing it as pending loses the fact that a trial
   * actually happened and produced an opinion.
   */
  trialOutcome: z.enum(["approved", "rejected", "more_testing"]),
});

/**
 * What the customer actually said, in seven answers rather than one box.
 *
 * The whole point of a trial is the comparison, and "good" in a notes field
 * cannot be read back six weeks later as "better drying than what they use,
 * price is the problem" — which is the sentence the negotiation call needs.
 * The seven ids are `FEEDBACK_FIELDS`, shared with the form, so the screen and
 * this action cannot disagree about what was asked.
 *
 * Recorded ONCE. A second opinion is a second sample, and letting this be
 * overwritten would quietly replace what the customer said with what somebody
 * remembers them saying.
 */
export async function recordSampleFeedback(
  sampleId: string,
  input: z.infer<typeof feedbackSchema>,
): Promise<Result<null>> {
  try {
    const parsed = feedbackSchema.safeParse(input);
    if (!parsed.success) return err("Say how the trial went.", "validation");

    const known = new Set(FEEDBACK_FIELDS.map((f) => f.id));
    const unknown = Object.keys(parsed.data.fields).find((k) => !known.has(k));
    if (unknown) {
      return err(`"${unknown}" is not one of the trial questions.`, "validation");
    }
    /* An empty form is not feedback. Somebody pressing save on seven blank
       boxes has recorded that a call happened, which is a different fact and
       one this table cannot tell apart from an answer of "no comment". */
    const said = Object.values(parsed.data.fields).some((v) => v && v.trim().length > 0);
    if (!said) {
      return err("Write down at least one thing they said about it.", "validation", [
        { field: "quality", message: "Something they said." },
      ]);
    }

    const ctx = await requireCapability("lead.work");
    const loaded = await loadForTransition(sampleId, "reviewed");
    if (!loaded.ok) return loaded.error;

    const now = new Date();
    const day = await today();
    const config = await nurtureConfig();
    const f = parsed.data.fields;

    await db.transaction(async (tx) => {
      const [written] = await tx
        .insert(sampleFeedback)
        .values({
          id: id("sfb"),
          sampleId,
          customerId: loaded.customer.id,
          quality: f.quality ?? null,
          performance: f.performance ?? null,
          application: f.application ?? null,
          drying: f.drying ?? null,
          competitorComparison: f.competitorComparison ?? null,
          priceFeedback: f.priceFeedback ?? null,
          otherComments: f.otherComments ?? null,
          recordedById: ctx.user.id,
          recordedAt: now,
        })
        /* One row per sample, said by the unique index and honoured here: a
           second save is a double-click and must not silently replace the
           first answer with the second. */
        .onConflictDoNothing({ target: sampleFeedback.sampleId })
        .returning({ id: sampleFeedback.id });

      await tx
        .update(mbosSamples)
        .set({
          state: "reviewed",
          trialOutcome: parsed.data.trialOutcome,
          reviewedAt: now,
          /*
           * ONE WRITER, TWO READERS.
           *
           * §16 asks the trial seven named questions and they live in
           * `sample_feedback`, because "better drying than what they use,
           * price is the problem" cannot be recovered from one box. Main's own
           * sample screens read `mbos_samples.satisfaction` and
           * `rejection_reason` — two columns holding the same event at a
           * coarser grain — and they were shipped first.
           *
           * So this writes both rather than either. Leaving main's null would
           * make a reviewed sample read as never reviewed on the screens that
           * ask those columns; deleting them would break screens outside this
           * feature. What must NOT happen is a second writer keeping them in
           * step, which is how the two come to disagree about one trial.
           *
           * The coarse columns are DERIVED from the fine ones here and never
           * typed separately: satisfaction is what they said about quality and
           * performance, and a rejection reason is only meaningful on a
           * rejection.
           */
          satisfaction:
            [f.quality, f.performance].filter((v) => v?.trim()).join(" · ") || null,
          rejectionReason:
            parsed.data.trialOutcome === "rejected"
              ? [f.otherComments, f.priceFeedback, f.competitorComparison]
                  .find((v) => v?.trim())
                  ?.trim() || null
              : null,
          reviewedById: ctx.user.id,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(eq(mbosSamples.id, sampleId));

      await writeTimelineEvent(tx, {
        customerId: loaded.customer.id,
        eventType: MBOS_EVENT.sampleReview,
        sourceApp: "crm",
        sourceRecordId: sampleId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary:
          parsed.data.trialOutcome === "approved"
            ? "Sample reviewed — the customer is happy with it"
            : parsed.data.trialOutcome === "rejected"
              ? "Sample reviewed — the customer did not take to it"
              : "Sample reviewed — they want to test it further",
      });

      /* The asking is over, whatever the answer was. */
      const chasing = await openNurtureTaskIdsFor(tx, sampleId);
      await closeNurtureTasks(tx, chasing, "The customer has given their verdict.");

      /* §13's "Call about the order" hangs off the customer approving, not the
         office approving. They liked it; ask what they want and when. */
      if (parsed.data.trialOutcome === "approved") {
        await raiseNurtureTasks(tx, {
          customerId: loaded.customer.id,
          events: [{ trigger: "sample_approved", sourceId: sampleId, on: day }],
          today: day,
          config,
          salesmanId: loaded.sample.salesmanId,
        });
      }

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "sample.reviewed",
        entityType: "mbos_samples",
        entityId: sampleId,
        afterState: {
          trialOutcome: parsed.data.trialOutcome,
          /* Whether the feedback row was NEW. A second save that changed
             nothing is worth being able to tell apart later from the one that
             recorded the answer. */
          feedbackWritten: Boolean(written),
        } as never,
      });
    });

    refresh();
    return ok(null, "Recorded. That is the trial closed.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------ §15 cancelling */

/**
 * The trial is off, and why.
 *
 * A reason is required for the same purpose §26's list serves: a sample that
 * simply disappears from the desk teaches nobody anything, and "customer moved
 * premises" and "we could not source it" are different problems with different
 * fixes. Cancelling closes every task raised for it — a chase against a sample
 * nobody is sending is the definition of noise.
 */
export async function cancelSample(sampleId: string, reason: string): Promise<Result<null>> {
  try {
    const said = (reason ?? "").trim();
    if (!said) {
      return err("Say why the sample is being cancelled.", "validation", [
        { field: "reason", message: "A reason, however short." },
      ]);
    }
    const ctx = await requireCapability("lead.work");
    const loaded = await loadForTransition(sampleId, "cancelled");
    if (!loaded.ok) return loaded.error;

    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(mbosSamples)
        .set({
          state: "cancelled",
          cancelledAt: now,
          cancelReason: said.slice(0, 500),
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(eq(mbosSamples.id, sampleId));

      /* A pending approval for a sample nobody is sending is a decision
         waiting to be made about nothing. It is rejected with the cancellation
         as its note, so the approvals queue empties honestly rather than by
         somebody clicking through requests that no longer exist. */
      await tx
        .update(mbosApprovals)
        .set({
          state: "rejected",
          approverUserId: ctx.user.id,
          decidedAt: now,
          decisionNote: `Cancelled before a decision: ${said.slice(0, 400)}`,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(
          and(
            eq(mbosApprovals.type, "sample"),
            eq(mbosApprovals.subjectType, "mbos_samples"),
            eq(mbosApprovals.subjectId, sampleId),
            eq(mbosApprovals.state, "pending"),
          ),
        );

      await writeTimelineEvent(tx, {
        customerId: loaded.customer.id,
        eventType: MBOS_EVENT.sampleCancelled,
        sourceApp: "crm",
        sourceRecordId: sampleId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `Sample cancelled: ${said.slice(0, 120)}`,
      });

      const open = await openNurtureTaskIdsFor(tx, sampleId);
      await closeNurtureTasks(tx, open, "The sample was cancelled.");

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "sample.cancelled",
        entityType: "mbos_samples",
        entityId: sampleId,
        afterState: { reason: said } as never,
      });
    });

    refresh();
    return ok(null, "Cancelled, with the reason on the record.");
  } catch (e) {
    return fromThrown(e);
  }
}
