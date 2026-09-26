"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, calls, customers, users } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { NO_ANSWER_REASONS } from "@/lib/call-outcomes";
import { addDays, nextWorkingDay, type BusinessDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { notifyUser } from "@/lib/notify";
import { today } from "@/lib/recompute";
import { err, fromThrown, ok, type FieldError, type Result } from "@/lib/result";
import { CRM_EVENT, MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { messageLabel, MESSAGE_KINDS, shortDay } from "@/lib/calling-desk-labels";
import {
  CALL_MARK,
  DESK_LOST_REASONS,
  MAX_QUALIFICATION_CALLS,
  OUTCOME_LABEL,
  afterCall,
  crmOutcomeFor,
  deskField,
  deskLostFiledAs,
  isAnswered,
  isCallOutcome,
  isRequestState,
  isWorkingStage,
  lostCodeForCause,
  lostNote,
  nextActionKindOf,
  nextActionText,
  requiredProgress,
  spoke,
  type CallOutcome,
  type DeskFieldKey,
  type DeskValues,
} from "@/lib/engines/lead-calling-desk";
import { gateTo } from "@/lib/engines/lead-gates";
import { ladderFor } from "@/lib/engines/lead-ladder";
import { leadGateInput, leadManagerCandidatesFor, leadRow } from "@/lib/services/lead-service";
import { requestOf } from "@/lib/services/lead-prospect-request-service";
import { advanceLeadStage, setLeadNextAction } from "@/lib/actions/leads";
import { canOpenModule } from "@/lib/access";

/** The module the desk's screens and writes are granted under — see `lib/modules.ts`. */
const DESK_MODULE = "crm.lead-calling-desk";

/**
 * THE DESK'S OWN GRANT, asked by every write it makes.
 *
 * `lead.work` is held by every associate, so on its own it would let any CRM
 * user post to these actions by URL after the route guard had already turned
 * them away from the screen. The screen guard is a courtesy and this is the
 * door. It is the module and not a new capability, for the reason the module
 * exists: who works the desk is decided per person on the Access screen, and a
 * capability is decided per level. Null means allowed.
 */
async function deskRefusal(userId: string): Promise<ReturnType<typeof err> | null> {
  if (await canOpenModule(userId, DESK_MODULE)) return null;
  return err("You have not been given the Calling desk. Ask whoever manages access to grant it.", "not_permitted");
}

/* ---------------------------------------------------------------------------
 * The calling desk's writes: a qualification call, the request for a Prospect,
 * a message, a next action and a loss — plus the one thing the SALES MANAGER
 * does to a request that no verification outcome covers: send it back.
 * (Settling a request after a verification call — promoting it or holding it —
 * is `services/lead-prospect-request-service.ts`, which is deliberately not an
 * action, because a function here is a URL anybody can post to.)
 *
 * `lead.work` throughout the desk's own — the capability the whole funnel is
 * worked under, held by every associate. Naming a new capability here would be
 * the dangerous choice: `can()` ends with `!MANAGER_ONLY.has(capability)`, so a
 * capability nobody added to the matrix FAILS OPEN. The manager's is
 * `lead.verify`, the sales manager's own judgement about a lead. The scope
 * check is `assertCustomerInScope`, which names every seat somebody may hold on
 * a record, and a server action is a URL — so both are asked here and not only
 * by the screen that draws the button.
 *
 * Nothing here invents a mechanism. A call is a row in `calls`, the answers are
 * the columns `saveProspectFields` already writes, a loss is `advanceLeadStage`,
 * and the promotion after a verification is that same gated move.
 *
 * A REQUEST IS NOT A PROSPECT. It is `customers.prospect_request_state`, beside
 * the stage, and the lead stays a Suspect until the manager's verification
 * succeeds. That is the one thing this feature had to add to the schema.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const CUSTOMER_TYPES = ["dealer", "manufacturer", "distributor", "retailer"] as const;

/** Every answer optional: a call captures whatever the customer gave. */
const answersSchema = z.object({
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  decisionMaker: z.string().trim().max(200).optional(),
  buyer: z.string().trim().max(200).optional(),
  gstin: z.string().trim().max(20).optional(),
  monthlyLitres: z.number().int().positive().max(10_000_000).optional(),
  potentialPaise: z.number().int().positive().max(1_000_000_000_000).optional(),
  creditDaysWanted: z.number().int().min(0).max(365).optional(),
  requiredProductId: z.string().trim().min(1).optional(),
  competitor: z.string().trim().max(200).optional(),
  application: z.string().trim().max(500).optional(),
  address: z.string().trim().max(500).optional(),
  email: z.string().trim().max(200).optional(),
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day as a date.");

const callSchema = z.object({
  customerId: z.string().min(1),
  outcome: z.string(),
  noAnswerReason: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
  answers: answersSchema.default({}),
  /** What happens next, where this call does not end the lead. Defaulted where omitted. */
  next: z
    .object({
      kind: z.enum(["call", "message"]),
      text: z.string().trim().max(300),
      date: dateSchema,
    })
    .optional(),
  /** The desk's own reason code, where the call ends the lead. */
  lostReasonCode: z.string().trim().max(40).optional(),
  lostNote: z.string().trim().max(1000).optional(),
});

export type LogQualificationCallInput = z.input<typeof callSchema>;

export type LogQualificationCallResult = {
  callNumber: number;
  /** What the call did to the lead. */
  result: "next" | "ready" | "lost";
  /** Set when the call was saved but closing the lead failed — it can be closed from the record. */
  closeFailed?: string;
};

function zodErr(error: z.ZodError): ReturnType<typeof err> {
  const fieldErrors = error.issues.map<FieldError>((i) => ({
    field: i.path.join(".") || "form",
    message: i.message,
  }));
  return err(fieldErrors[0]?.message ?? "That is not valid.", "validation", fieldErrors);
}

/** Column on `customers` for each answer — the same ones `saveProspectFields` writes. */
const COLUMN_FOR: Record<DeskFieldKey, keyof typeof customers.$inferInsert> = {
  customerType: "customerType",
  decisionMaker: "leadDecisionMaker",
  buyer: "leadBuyer",
  gstin: "gstin",
  monthlyLitres: "leadMonthlyVolumeLitres",
  potentialPaise: "leadEstimatedPotentialPaise",
  creditDaysWanted: "leadCreditDaysWanted",
  requiredProductId: "leadRequiredProductId",
  competitor: "leadCompetitor",
  application: "leadApplication",
  address: "address",
  email: "email",
};

function refresh(customerId: string) {
  try {
    revalidatePath("/crm/leads/calling-desk");
    revalidatePath(`/crm/leads/calling-desk/${customerId}`);
    revalidatePath(`/crm/leads/${customerId}/verify`);
    revalidatePath("/crm/leads/qualify/verification");
    revalidatePath("/sales/leads");
    revalidatePath(`/sales/leads/${customerId}`);
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/** A refusal raised inside a transaction, so the whole write rolls back with it. */
class Refusal extends Error {
  constructor(readonly result: ReturnType<typeof err>) {
    super(result.error);
  }
}

/** The lead, checked for scope, or the refusal to hand back. */
async function reachable(customerId: string) {
  const lead = await leadRow(customerId);
  if (!lead) return { ok: false as const, refusal: err("That lead is not on MahekOne.", "not_found") };
  await assertCustomerInScope({
    kind: lead.kind,
    ownerId: lead.ownerId,
    salesAmId: lead.salesAmId,
    backOfficeAmId: lead.backOfficeAmId,
    /* The manager a request is addressed to holds this seat, and the read has to
       name it as the list does — see `assertCustomerInScope`. */
    leadManagerId: lead.leadManagerId,
  });
  return { ok: true as const, lead };
}

/** How many of the three calls have been made. */
async function callsMade(customerId: string): Promise<number> {
  const [made] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(
      and(
        eq(calls.customerId, customerId),
        sql`${calls.outcomeDetail}->>${sql.raw(`'${CALL_MARK}'`)} is not null`,
      ),
    );
  return made?.n ?? 0;
}

/* ══════════════════════════════════════════════════ a qualification call */

/**
 * Record one of the three qualification calls.
 *
 * ONE TRANSACTION, on a locked row: the call, whatever it captured, the next
 * action and the timeline entry land together or not at all — half a call would
 * leave a lead describing a conversation that never happened, and the count of
 * calls is what decides whether a Call 3 is owed. The row is locked because
 * that count is read inside it, and two people saving "Call 2" at once must
 * produce one Call 2 and one refusal, not two of them and a Call 4.
 *
 * WHAT IT DECIDES IS THE ENGINE'S, not this function's: `afterCall` says
 * whether the lead is ready, owed another call, or finished. This function
 * writes that answer down.
 *
 * ANSWERS ALREADY ON THE RECORD ARE NOT OVERWRITTEN. The form does not offer
 * them, so anything arriving for one came from somewhere else — and a call that
 * quietly replaced last week's figure would destroy the very thing the
 * verification call is read against. They are dropped and reported.
 *
 * A LEAD THE MANAGER HAS, OR HAS SENT BACK, IS NOT RUNG AGAIN. Once it has been
 * put forward the desk's calling is over; the customer must not be asked a
 * second time, and a returned lead is resubmitted or closed rather than rung.
 */
export async function logQualificationCall(
  input: LogQualificationCallInput,
): Promise<Result<LogQualificationCallResult>> {
  try {
    const parsed = callSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    if (!isCallOutcome(p.outcome)) return err("Pick what came of the call.", "validation");
    const outcome: CallOutcome = p.outcome;

    const ctx = await requireCapability("lead.work");
    const barred = await deskRefusal(ctx.user.id);
    if (barred) return barred;
    const found = await reachable(p.customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    if (!isWorkingStage(lead.leadStage)) {
      return err(
        "This lead is no longer at the Suspect stage, so the three qualification calls are over.",
        "rule_violation",
      );
    }

    if (outcome === "no_answer") {
      const codes = NO_ANSWER_REASONS.map((r) => r.code as string);
      if (!p.noAnswerReason || !codes.includes(p.noAnswerReason)) {
        return err("Say what kind of no answer it was.", "validation", [
          { field: "noAnswerReason", message: "Why was there no answer?" },
        ]);
      }
    }

    const day = await today();
    const config = await getConfig();
    const now = new Date();
    const callId = gen("cal");
    const outcomeText = OUTCOME_LABEL[outcome];

    let disposition!: ReturnType<typeof afterCall>;
    let callNumber = 0;
    const appliedKeys: DeskFieldKey[] = [];
    const skippedKeys: DeskFieldKey[] = [];
    let nextDate: string | null = null;
    let lostCode: string | null = null;

    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          customerType: customers.customerType,
          decisionMaker: customers.leadDecisionMaker,
          buyer: customers.leadBuyer,
          gstin: customers.gstin,
          monthlyLitres: customers.leadMonthlyVolumeLitres,
          potentialPaise: customers.leadEstimatedPotentialPaise,
          creditDaysWanted: customers.leadCreditDaysWanted,
          requiredProductId: customers.leadRequiredProductId,
          competitor: customers.leadCompetitor,
          application: customers.leadApplication,
          address: customers.address,
          email: customers.email,
          stage: customers.leadStage,
          requestState: customers.prospectRequestState,
        })
        .from(customers)
        .where(eq(customers.id, p.customerId))
        .for("update");
      if (!row) throw new Refusal(err("That lead is not on MahekOne.", "not_found"));
      if (!isWorkingStage(row.stage)) {
        throw new Refusal(
          err(
            "This lead is no longer at the Suspect stage, so the three qualification calls are over.",
            "rule_violation",
          ),
        );
      }
      if (isRequestState(row.requestState)) {
        throw new Refusal(
          err(
            row.requestState === "returned"
              ? "The Sales Manager sent this lead back. Read their note, then resubmit it or close it — do not ring the customer again."
              : "This lead has been put forward to the Sales Manager. Do not ring the customer again to re-ask what is already on file.",
            "rule_violation",
          ),
        );
      }

      const values: DeskValues = {
        customerType: row.customerType,
        decisionMaker: row.decisionMaker,
        buyer: row.buyer,
        gstin: row.gstin,
        monthlyLitres: row.monthlyLitres,
        potentialPaise: row.potentialPaise,
        creditDaysWanted: row.creditDaysWanted,
        requiredProductId: row.requiredProductId,
        competitor: row.competitor,
        application: row.application,
        address: row.address,
        email: row.email,
      };

      const prior = await tx
        .select({ detail: calls.outcomeDetail })
        .from(calls)
        .where(
          and(
            eq(calls.customerId, p.customerId),
            sql`${calls.outcomeDetail}->>${sql.raw(`'${CALL_MARK}'`)} is not null`,
          ),
        );
      const priorOutcomes = prior
        .map((r) => (r.detail as Record<string, string> | null)?.qualOutcome)
        .filter(isCallOutcome);

      /* THERE IS NO CALL 4. Refused by the count rather than trusted to the
         screen, which stops offering the button but is not the rule. */
      if (prior.length >= MAX_QUALIFICATION_CALLS) {
        throw new Refusal(
          err(
            `Three calls have already been made on this lead. There is no Call ${MAX_QUALIFICATION_CALLS + 1} — close it as lost, or request Prospect if the answers are in.`,
            "rule_violation",
          ),
        );
      }
      if (requiredProgress(values).complete) {
        throw new Refusal(
          err(
            "Every required answer is already in, so no further call is needed. Request Prospect.",
            "rule_violation",
          ),
        );
      }
      callNumber = prior.length + 1;

      /* Which answers this call actually adds. Filled ones are dropped. */
      const applied: DeskValues = {};
      const set: Partial<typeof customers.$inferInsert> = {};
      for (const [key, value] of Object.entries(p.answers) as [DeskFieldKey, unknown][]) {
        if (value === undefined || value === "") continue;
        if (isAnswered(key, values[key])) {
          skippedKeys.push(key);
          continue;
        }
        applied[key] = value as string | number;
        (set as Record<string, unknown>)[COLUMN_FOR[key]] = value;
        appliedKeys.push(key);
      }

      if (!spoke(outcome) && appliedKeys.length) {
        throw new Refusal(
          err(
            `${outcomeText} cannot have captured answers. Change the outcome, or take the answers out.`,
            "validation",
          ),
        );
      }
      if (outcome === "spoke_collected" && appliedKeys.length === 0) {
        throw new Refusal(
          err(
            "You said information was collected but no new answer is filled in. If they only asked for a call back, pick that instead.",
            "validation",
            [{ field: "outcome", message: "Nothing new was captured." }],
          ),
        );
      }

      const merged: DeskValues = { ...values, ...applied };
      disposition = afterCall({ callNumber, outcome, merged, priorOutcomes });

      let nextText: string | null = null;
      if (disposition.kind === "next") {
        const kind = p.next?.kind ?? "call";
        nextText = nextActionText(kind, disposition.callNumber, p.next?.text ?? "");
        nextDate = p.next?.date ?? addDays(day as BusinessDate, 2);
        if (nextDate < day) {
          throw new Refusal(
            err("The follow-up date cannot be in the past.", "validation", [
              { field: "next.date", message: "Pick today or a later day." },
            ]),
          );
        }
      }
      if (disposition.kind === "lost") {
        lostCode =
          p.lostReasonCode && DESK_LOST_REASONS.some((r) => r.code === p.lostReasonCode)
            ? p.lostReasonCode
            : lostCodeForCause(disposition.cause);
      }
      const finalText =
        disposition.kind === "ready"
          ? "All required answers in — ready for Prospect"
          : disposition.kind === "lost"
            ? `${DESK_LOST_REASONS.find((r) => r.code === lostCode)?.label ?? "Closed"} — Lost`
            : null;

      await tx.insert(calls).values({
        id: callId,
        customerId: p.customerId,
        userId: ctx.user.id,
        direction: "outbound",
        interactionType: "outbound_call",
        outcome: crmOutcomeFor(outcome),
        startedAt: now,
        notes: p.notes || null,
        sourceModule: "customer_record",
        /* What separates one of the three from any other call at this customer,
           the precise outcome the coarse column above cannot say, and what was
           decided at the end of it. Strings only — the column is
           `Record<string, string>`. */
        outcomeDetail: {
          [CALL_MARK]: String(callNumber),
          qualOutcome: outcome,
          ...(outcome === "no_answer" && p.noAnswerReason ? { noAnswerReason: p.noAnswerReason } : {}),
          ...(appliedKeys.length ? { answered: appliedKeys.join(",") } : {}),
          ...(nextText ? { nextAction: nextText } : {}),
          ...(nextDate ? { nextDate } : {}),
          ...(finalText ? { final: finalText } : {}),
        },
        /* The second lock after the row lock: a duplicate submit of the same
           call number cannot land even if the count were somehow read stale. */
        idempotencyKey: `qualcall:${p.customerId}:${callNumber}`,
        createdById: ctx.user.id,
      });

      const next: Partial<typeof customers.$inferInsert> =
        disposition.kind === "next"
          ? {
              leadNextAction: nextText,
              leadNextActionDate: nextDate,
              leadNextActionOwnerId: ctx.user.id,
              leadNextActionOutcome: null,
            }
          : disposition.kind === "ready"
            ? {
                leadNextAction: "Request Prospect",
                leadNextActionDate: day,
                leadNextActionOwnerId: ctx.user.id,
                leadNextActionOutcome: "All required answers are in",
              }
            : {};

      await tx
        .update(customers)
        .set({ ...set, ...next, leadLastActivityDate: day, updatedAt: now })
        .where(eq(customers.id, p.customerId));

      await writeTimelineEvent(tx, {
        customerId: p.customerId,
        eventType: CRM_EVENT.call,
        sourceApp: "crm",
        sourceRecordId: callId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary:
          `Qualification call ${callNumber} of ${MAX_QUALIFICATION_CALLS} — ${outcomeText}` +
          (appliedKeys.length ? ` · ${appliedKeys.map((k) => deskField(k).label).join(", ")}` : "") +
          (p.notes ? ` · ${p.notes}` : ""),
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.callingDesk.call",
        entityType: "customer",
        entityId: p.customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { callsMade: callNumber - 1 },
        afterState: { callNumber, outcome, answered: appliedKeys, disposition: disposition.kind },
      });
    });

    /* A loss is an ordinary stage move, and goes through the one door every loss
       goes through: the reason is validated against the configured list, the
       transition row is appended and the timeline is written. It is after the
       transaction because that door is its own, and the call is worth keeping
       even if the close fails — `exhausted` then reads on the record and the
       lead can be closed by hand. */
    let closeFailed: string | undefined;
    if (disposition.kind === "lost" && lostCode) {
      const configured = config["leads.lostReasons"].map((r) => r.code);
      const filed = deskLostFiledAs(lostCode) ?? "other";
      const reasonCode = configured.includes(filed) ? filed : (configured[0] ?? filed);
      const label = DESK_LOST_REASONS.find((r) => r.code === lostCode)?.label ?? lostNote(disposition.cause);
      const closed = await advanceLeadStage({
        customerId: p.customerId,
        to: "lost",
        reasonCode,
        note: [label, p.lostNote || lostNote(disposition.cause)].filter(Boolean).join(" — "),
      });
      if (!closed.ok) closeFailed = closed.error;
    }

    refresh(p.customerId);

    const warnings = skippedKeys.length
      ? [
          `${skippedKeys.map((k) => deskField(k).label).join(", ")} ${
            skippedKeys.length === 1 ? "was" : "were"
          } already on the record and ${skippedKeys.length === 1 ? "was" : "were"} not changed.`,
        ]
      : undefined;

    /* V6's own wording: the count out of three, then what is owed and when. */
    const lostLabel =
      DESK_LOST_REASONS.find((r) => r.code === lostCode)?.label ??
      (disposition.kind === "lost" ? lostNote(disposition.cause) : "");
    const message =
      disposition.kind === "ready"
        ? `Call ${callNumber} / ${MAX_QUALIFICATION_CALLS} saved. All required answers collected — Ready for Prospect.`
        : disposition.kind === "lost"
          ? closeFailed
            ? `Call ${callNumber} / ${MAX_QUALIFICATION_CALLS} saved, but the lead could not be closed: ${closeFailed}`
            : `${lostLabel} — lead marked Lost.`
          : `Call ${callNumber} / ${MAX_QUALIFICATION_CALLS} saved. ${
              (p.next?.kind ?? "call") === "call" ? `Call ${disposition.callNumber}` : "Message"
            } due ${shortDay(nextDate)}.`;

    return ok(
      { callNumber, result: disposition.kind, ...(closeFailed ? { closeFailed } : {}) },
      message,
      warnings,
    );
  } catch (e) {
    if (e instanceof Refusal) return e.result;
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════ asking for a Prospect */

const requestSchema = z.object({
  customerId: z.string().min(1),
  /** §5's coded reason, from `leads.prospectReasons`. Validated against it below. */
  reasonCode: z.string().trim().min(1, "Say why this is worth pursuing."),
  note: z.string().trim().max(2000).optional(),
  /* The two things the Prospect gate wants that are not among the five. Asked
     here, once, if the record does not already hold them. */
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  contactPerson: z.string().trim().max(200).optional(),
  /* Asked only where the lead has not been told how it will be sold. Never
     defaulted: which ladder a lead climbs decides which gates apply. */
  salesType: z.enum(["direct", "third_party"]).optional(),
});

/**
 * Ask for a ready lead to be put forward as a Prospect — or resubmit one the
 * manager sent back.
 *
 * IT DOES NOT MOVE THE LEAD. The lead stays a Suspect and
 * `prospect_request_state` becomes `awaiting`; the sales manager verifies it on
 * the screen that already exists, and only a successful verification promotes
 * it (see `settleProspectRequest`). That is the whole of the rule: a request is
 * not a conversion, and the desk must never be able to make one.
 *
 * WHAT IS CHECKED HERE IS WHAT THE PROMOTION WILL NEED. The five answers, the
 * sales type (the Prospect rung sits on the three ladders and not the legacy
 * one) and the coded reason are checked, and then the Prospect gate itself is
 * asked as a dry run with the request's own inputs — so a request that is
 * accepted cannot later be refused at promotion for something the desk was
 * never asked. What the five do not cover, the kind of business and who to ask
 * for, is asked in the same act if the record lacks it.
 *
 * THE FIVE ARE CHECKED HERE AND NOT ONLY BY THE BUTTON, because a button is
 * drawn from a phase and a phase is a reading; this is the write.
 */
export async function requestProspect(
  input: z.input<typeof requestSchema>,
): Promise<Result<{ managerNotified: boolean; resubmitted: boolean }>> {
  try {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const barred = await deskRefusal(ctx.user.id);
    if (barred) return barred;
    const found = await reachable(p.customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;
    const req = await requestOf(p.customerId);

    if (lead.leadStage === "prospect") {
      return err("This lead is already a Prospect.", "rule_violation");
    }
    if (!isWorkingStage(lead.leadStage)) {
      return err("Only a Suspect can be put forward as a Prospect.", "rule_violation");
    }
    if (req.state === "awaiting" || req.state === "followup") {
      return err(
        "This lead is already with the Sales Manager. It is not a Prospect until they verify it.",
        "rule_violation",
      );
    }
    const resubmitted = req.state === "returned";

    const values: DeskValues = {
      decisionMaker: lead.leadDecisionMaker,
      monthlyLitres: lead.leadMonthlyVolumeLitres,
      potentialPaise: lead.leadEstimatedPotentialPaise,
      requiredProductId: lead.leadRequiredProductId,
      competitor: lead.leadCompetitor,
    };
    const progress = requiredProgress(values);
    if (!progress.complete) {
      return err(
        `Not ready for Prospect yet. Still needed: ${progress.missing.map((f) => f.label).join(", ")}.`,
        "rule_violation",
        progress.missing.map<FieldError>((f) => ({ field: f.key, message: `${f.label} is still needed` })),
      );
    }

    /* THE SALES TYPE IS NEVER DEFAULTED. A lead nobody has said how it will be
       sold is drawn on the Direct ladder, but drawing is not deciding: the ladder
       chooses the gates, so the desk names one here, in the same act. */
    const setsSalesType = lead.leadSalesType == null;
    const salesType = lead.leadSalesType ?? p.salesType ?? null;
    if (!salesType) {
      return err(
        "Choose how this lead will be sold — Direct customer or Third Party Customer — before requesting a Prospect.",
        "validation",
        [{ field: "salesType", message: "Choose a sales type." }],
      );
    }
    if (!ladderFor(salesType).includes("prospect")) {
      return err(
        "This lead is on a ladder that has no Prospect rung, so it cannot be requested as one.",
        "rule_violation",
      );
    }

    const config = await getConfig();
    if (!config["leads.prospectReasons"].some((r) => r.code === p.reasonCode)) {
      return err("Pick one of the listed reasons.", "validation", [
        { field: "reasonCode", message: "Say why this is worth pursuing." },
      ]);
    }

    const day = await today();
    const due = nextWorkingDay(day as BusinessDate, {
      timezone: config["workingDay.timezone"],
      dayBoundaryHour: config["workingDay.dayBoundaryHour"],
      workingDays: config["workingDay.workingDays"],
    });

    /* The person the verification is owed to: whoever already holds the lead
       manager seat, otherwise the one the region defaults to. */
    const candidates = lead.leadManagerId ? [] : await leadManagerCandidatesFor(p.customerId);
    const managerId = lead.leadManagerId ?? candidates[0]?.id ?? null;

    /* THE DRY RUN. The same gate the promotion will be asked, with what this
       request supplies. Anything still missing is named, so the desk can fix it
       now rather than the manager finding out after they have rung the customer. */
    const gate = await leadGateInput(p.customerId);
    if (gate) {
      const verdict = gateTo(
        {
          ...gate,
          salesType,
          customerType: gate.customerType || p.customerType || null,
          contactPerson: gate.contactPerson?.trim() ? gate.contactPerson : (p.contactPerson ?? null),
          prospectReasonRecorded: true,
          nextAction: "Sales manager verification",
          nextActionDate: due,
          nextActionOwnerId: managerId ?? ctx.user.id,
        },
        "prospect",
      );
      if (!verdict.open) {
        return err(
          `Not ready to put forward: ${verdict.missing.map((c) => c.says).join("; ")}.`,
          "rule_violation",
          verdict.missing.map<FieldError>((c) => ({ field: c.id, message: c.says })),
        );
      }
    }

    const now = new Date();
    const requestId = gen("prq");
    await db.transaction(async (tx) => {
      const set: Partial<typeof customers.$inferInsert> = {
        prospectRequestState: "awaiting",
        prospectRequestedAt: now,
        prospectRequestedById: ctx.user.id,
        prospectRequestReason: p.reasonCode,
        prospectRequestNote: p.note || null,
        /* The verification is the manager's next action, so it lands on their
           list and not on the desk's. */
        leadNextAction: "Sales manager verification",
        leadNextActionDate: due,
        leadNextActionOwnerId: managerId ?? ctx.user.id,
        leadNextActionOutcome: "Verify what the calling desk collected, then confirm the Prospect",
        leadLastActivityDate: day,
        updatedAt: now,
      };
      /* Only what the record is missing is written, so a request never
         overwrites a business type or a contact somebody already gave. */
      if (setsSalesType) set.leadSalesType = salesType;
      if (!lead.customerType && p.customerType) set.customerType = p.customerType;
      if (!lead.contactPerson?.trim() && p.contactPerson) set.contactPerson = p.contactPerson;
      /* The seat is FILLED, never moved, and `lead_manager_decided_at` is left
         alone: nobody chose this person, the region did. */
      if (!lead.leadManagerId && managerId) set.leadManagerId = managerId;

      await tx.update(customers).set(set).where(eq(customers.id, p.customerId));

      await writeTimelineEvent(tx, {
        customerId: p.customerId,
        eventType: MBOS_EVENT.prospectRequested,
        sourceApp: "crm",
        sourceRecordId: requestId,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `${resubmitted ? "Resubmitted for verification" : "Prospect requested — sent to the Sales Manager"}: ${
          config["leads.prospectReasons"].find((r) => r.code === p.reasonCode)?.label ?? p.reasonCode
        }${p.note ? ` · ${p.note}` : ""}. Not a Prospect until the Sales Manager confirms.`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: resubmitted ? "lead.prospectRequest.resubmit" : "lead.prospectRequest",
        entityType: "customer",
        entityId: p.customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { prospectRequestState: req.state ?? null },
        afterState: { prospectRequestState: "awaiting", reason: p.reasonCode },
      });

      if (setsSalesType) {
        await tx.insert(auditLog).values({
          id: gen("aud"),
          actorId: ctx.user.id,
          action: "lead.salesType.set",
          entityType: "customer",
          entityId: p.customerId,
          actorRole: ctx.authorisedBy,
          actorApp: ctx.authorisedIn,
          beforeState: { salesType: null, stage: lead.leadStage },
          afterState: { salesType, reason: "Chosen by the calling desk when the Prospect was requested" },
        });
      }
    });

    /* A bell, after the write and never able to fail it. */
    let managerNotified = false;
    if (managerId && managerId !== ctx.user.id) {
      await notifyUser({
        userId: managerId,
        title: `${lead.name} is ready to verify`,
        body: `${ctx.user.name} ${resubmitted ? "resubmitted" : "asked for"} ${lead.name} to be put forward as a Prospect after qualifying it by phone. It is not a Prospect until you verify it.`,
        kind: "info",
        href: `/crm/leads/${p.customerId}/verify`,
      }).then(() => {
        managerNotified = true;
      });
    }

    refresh(p.customerId);
    const [manager] = managerId
      ? await db.select({ name: users.name }).from(users).where(eq(users.id, managerId)).limit(1)
      : [];
    return ok(
      { managerNotified, resubmitted },
      manager
        ? `${resubmitted ? "Resubmitted" : "Prospect requested"}. ${manager.name} verifies it — it is not a Prospect until they confirm.`
        : `${resubmitted ? "Resubmitted" : "Requested"}, but no sales manager covers this lead yet — assign one on the record so the verification has an owner.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════ a message, no call used */

const messageSchema = z.object({
  customerId: z.string().min(1),
  code: z.string().trim().min(1).max(60),
  note: z.string().trim().max(2000).optional(),
});

/**
 * Log something sent to the customer — a profile, a brochure, a price list.
 *
 * IT USES NO CALL, which is the point: sending information is part of the same
 * conversation and the three are for asking. It writes the same timeline kind
 * and the same `<id>:<code>` source id that `recordCommunication` writes, so
 * the Communication screens count these too. What it does not do is name a
 * library document — that action refuses a send with none, and the desk's log
 * is "I sent the brochure", which is a fact whether or not the file was picked
 * from the library.
 *
 * A follow-up that was waiting on the message becomes the next call, a day out.
 */
export async function logDeskMessage(
  input: z.input<typeof messageSchema>,
): Promise<Result<null>> {
  try {
    const parsed = messageSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;
    if (!MESSAGE_KINDS.some((k) => k.code === p.code)) {
      return err("MahekOne does not know that kind of message.", "validation");
    }

    const ctx = await requireCapability("lead.work");
    const barred = await deskRefusal(ctx.user.id);
    if (barred) return barred;
    const found = await reachable(p.customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;
    if (!isWorkingStage(lead.leadStage)) {
      return err("Messages are logged on a Suspect, before the Sales Manager has it.", "rule_violation");
    }

    const day = await today();
    const now = new Date();
    const upcoming = (await callsMade(p.customerId)) + 1;

    await db.transaction(async (tx) => {
      const set: Partial<typeof customers.$inferInsert> = { leadLastActivityDate: day, updatedAt: now };
      /* A next action that was a message is answered by this one. */
      if (nextActionKindOf(lead.leadNextAction) === "message" && upcoming <= MAX_QUALIFICATION_CALLS) {
        set.leadNextAction = `Call ${upcoming} — after the message`;
        set.leadNextActionDate = addDays(day as BusinessDate, 1);
        set.leadNextActionOwnerId = ctx.user.id;
      }
      await tx.update(customers).set(set).where(eq(customers.id, p.customerId));

      await writeTimelineEvent(tx, {
        customerId: p.customerId,
        eventType: MBOS_EVENT.leadCommunication,
        sourceApp: "crm",
        sourceRecordId: `${gen("lcm")}:${p.code}`,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `${messageLabel(p.code)}${p.note ? `: ${p.note}` : ""}`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.communication",
        entityType: "customer",
        entityId: p.customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        afterState: { actionCode: p.code, documentId: null, source: "calling_desk" },
      });
    });

    refresh(p.customerId);
    return ok(null, "Message logged — no call attempt used.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════════════════ the next action */

const nextSchema = z.object({
  customerId: z.string().min(1),
  kind: z.enum(["call", "message"]),
  text: z.string().trim().max(300),
  date: dateSchema,
  outcome: z.string().trim().max(500).optional(),
});

/**
 * Set what happens next, and on what day.
 *
 * A thin layer over `setLeadNextAction`, which owns the capability, the scope
 * and the rule that somebody who can sign in owes it. What this adds is the
 * TYPE: the schema holds a sentence, a day and an owner and no call-or-message,
 * so the type is written into the sentence ("Call 2 — …") and read back from it
 * by `nextActionKindOf`. The person setting it owes it — the desk's own next
 * step is the desk's.
 */
export async function setDeskNextAction(input: z.input<typeof nextSchema>): Promise<Result<null>> {
  try {
    const parsed = nextSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const barred = await deskRefusal(ctx.user.id);
    if (barred) return barred;
    const found = await reachable(p.customerId);
    if (!found.ok) return found.refusal;
    if (!isWorkingStage(found.lead.leadStage)) {
      return err("The desk's next action is set while the lead is still a Suspect.", "rule_violation");
    }
    const upcoming = Math.min((await callsMade(p.customerId)) + 1, MAX_QUALIFICATION_CALLS);
    const result = await setLeadNextAction(p.customerId, {
      action: nextActionText(p.kind, upcoming, p.text),
      date: p.date,
      ownerId: ctx.user.id,
      outcome: p.outcome || undefined,
    });
    if (result.ok) refresh(p.customerId);
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═════════════════════════════════════════════════════════════ a loss */

const lostSchema = z.object({
  customerId: z.string().min(1),
  /** One of the desk's six. Filed under a configured code below. */
  reasonCode: z.string().trim().min(1).max(40),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Close a lead the desk has finished with.
 *
 * The reason is the desk's own sentence, FILED UNDER a code that already exists
 * in `leads.lostReasons`, with the sentence written onto the transition. It is
 * not offered while the request is with the manager — a lead they hold is
 * theirs to close, and the desk closing it under them would hide a verification
 * in progress.
 */
export async function markDeskLost(input: z.input<typeof lostSchema>): Promise<Result<null>> {
  try {
    const parsed = lostSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const barred = await deskRefusal(ctx.user.id);
    if (barred) return barred;
    const found = await reachable(p.customerId);
    if (!found.ok) return found.refusal;
    const req = await requestOf(p.customerId);
    if (req.state === "awaiting" || req.state === "followup") {
      return err(
        "This lead is with the Sales Manager. It is theirs to close or send back — not the desk's.",
        "rule_violation",
      );
    }

    const desk = DESK_LOST_REASONS.find((r) => r.code === p.reasonCode);
    if (!desk) return err("Pick one of the listed reasons.", "validation");
    const config = await getConfig();
    const configured = config["leads.lostReasons"].map((r) => r.code);
    const reasonCode = configured.includes(desk.filedAs) ? desk.filedAs : (configured[0] ?? desk.filedAs);

    const moved = await advanceLeadStage({
      customerId: p.customerId,
      to: "lost",
      reasonCode,
      note: [desk.label, p.note].filter(Boolean).join(" — "),
    });
    if (!moved.ok) return moved;

    refresh(p.customerId);
    return ok(null, "Lead marked Lost. The record and its history are kept.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ════════════════════════════════ the sales manager's half of a request */

const returnSchema = z.object({
  customerId: z.string().min(1),
  note: z.string().trim().min(1, "Say what is wrong — the desk reads this.").max(2000),
});

/**
 * Send a request back to the desk.
 *
 * Its own act and not a fourth verification outcome, because the existing three
 * already mean things — `not_qualified` closes the lead, and a verification that
 * fails must not be quietly re-read as "returned". The note is mandatory for the
 * reason a lost lead's and a follow-up's are: the desk has to be able to act on
 * it, and "returned" with nothing behind it is a lead they cannot fix.
 *
 * The lead stays a Suspect throughout. The desk sees `returned` and can correct
 * the answers and resubmit, or close it.
 */
export async function returnProspectRequest(
  input: z.input<typeof returnSchema>,
): Promise<Result<null>> {
  try {
    const parsed = returnSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.verify");
    const found = await reachable(p.customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;
    const req = await requestOf(p.customerId);
    if (req.state !== "awaiting" && req.state !== "followup") {
      return err("There is no pending Prospect request on this lead to send back.", "rule_violation");
    }

    const day = await today();
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          prospectRequestState: "returned",
          leadNextAction: "Resubmit or close — returned by the Sales Manager",
          leadNextActionDate: day,
          leadNextActionOwnerId: req.byId ?? lead.ownerId,
          leadNextActionOutcome: null,
          leadLastActivityDate: day,
          updatedAt: now,
        })
        .where(eq(customers.id, p.customerId));

      await writeTimelineEvent(tx, {
        customerId: p.customerId,
        eventType: MBOS_EVENT.prospectReturned,
        sourceApp: "crm",
        sourceRecordId: `${p.customerId}:returned:${now.toISOString()}`,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `Sales Manager returned the Prospect request to the desk: ${p.note}`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.prospectRequest.return",
        entityType: "customer",
        entityId: p.customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { prospectRequestState: req.state },
        afterState: { prospectRequestState: "returned", note: p.note },
      });
    });

    const to = req.byId ?? lead.ownerId;
    if (to && to !== ctx.user.id) {
      await notifyUser({
        userId: to,
        title: `${lead.name}: returned by the Sales Manager`,
        body: `${p.note} — correct what is wrong and resubmit it, or close the lead.`,
        kind: "warn",
        href: `/crm/leads/calling-desk/${p.customerId}`,
      });
    }

    refresh(p.customerId);
    return ok(null, "Sent back to the desk. It is not a Prospect.");
  } catch (e) {
    return fromThrown(e);
  }
}
