"use server";

import { assertLeadInScope } from "@/lib/services/lead-scope";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, calls, customers, users } from "@/db/schema";
import { canAny, hatsFor, requireCapability } from "@/lib/access-control";
import { approverFor, holdsLeadSeat } from "@/lib/services/lead-verifier";
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
  prospectProgress,
  spoke,
  type CallOutcome,
  type DeskFieldKey,
  type DeskValues,
} from "@/lib/engines/lead-calling-desk";
import { gateTo } from "@/lib/engines/lead-gates";
import { ladderFor } from "@/lib/engines/lead-ladder";
import { leadGateInput, leadManagerCandidatesFor, leadRow } from "@/lib/services/lead-service";
import { QUAL_NEXT } from "@/lib/services/lead-qualification-flow-service";
import { requestOf } from "@/lib/services/lead-prospect-request-service";
import { latestReopen, lostFromOf, reopenLostLead, reopenedAtOf } from "@/lib/services/lead-reopen-service";
import { stageLabel, type LeadSalesType } from "@/lib/lead-labels";
import { reopenTarget } from "@/lib/engines/lead-reopen";
import { advanceLeadStage, setLeadNextAction } from "@/lib/actions/leads";
import { canOpenModule } from "@/lib/access";
import { closeRemindersOnEvidence } from "@/lib/services/worklist-services";

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

const CUSTOMER_TYPES = ["dealer", "manufacturer", "distributor", "retailer", "private_limited_user"] as const;

/** Every answer optional: a call captures whatever the customer gave. A key not
    listed here — the retired "expected monthly sales" among them — is dropped. */
const answersSchema = z.object({
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  decisionMaker: z.string().trim().max(200).optional(),
  buyer: z.string().trim().max(200).optional(),
  gstin: z.string().trim().max(20).optional(),
  monthlyLitres: z.number().int().positive().max(10_000_000).optional(),
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
  result: "next" | "ready" | "lost" | "exhausted";
  /** Set when the call was saved but closing the lead failed — it can be closed from the record. */
  closeFailed?: string;
  /** Due reminders on this lead the call settled — see `closeRemindersOnEvidence`. */
  remindersClosed: number;
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
    revalidatePath("/crm/leads/lost");
    revalidatePath("/sales/leads");
    revalidatePath(`/sales/leads/${customerId}`);
    /* A desk call can close a reminder, and both lists read reminders. */
    revalidatePath("/crm/reminders");
    revalidatePath("/crm/call-log");
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
  await assertLeadInScope(customerId, {
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
  /* Counted since the lead was last reopened — earlier calls stay on the
     record, they just are not this round's three. See `reopenedAtSql`. */
  const [made] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(
      and(
        eq(calls.customerId, customerId),
        sql`${calls.outcomeDetail}->>${sql.raw(`'${CALL_MARK}'`)} is not null`,
        sql`${calls.startedAt} >= ${reopenedAtOf(customerId)}`,
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
    /** What a Prospect still lacks, in words — "not yet captured", never an error. */
    let notCaptured = "";
    let remindersClosed = 0;

    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          customerType: customers.customerType,
          decisionMaker: customers.leadDecisionMaker,
          buyer: customers.leadBuyer,
          gstin: customers.gstin,
          monthlyLitres: customers.leadMonthlyVolumeLitres,
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
        creditDaysWanted: row.creditDaysWanted,
        requiredProductId: row.requiredProductId,
        competitor: row.competitor,
        application: row.application,
        address: row.address,
        email: row.email,
      };

      /* THIS ROUND'S CALLS. A lead reopened from Lost starts its three calls
         again; the earlier ones are never deleted or renumbered, they simply
         belong to the round before the reopen. */
      const reopen = await latestReopen(p.customerId, tx);
      const prior = await tx
        .select({ detail: calls.outcomeDetail })
        .from(calls)
        .where(
          and(
            eq(calls.customerId, p.customerId),
            sql`${calls.outcomeDetail}->>${sql.raw(`'${CALL_MARK}'`)} is not null`,
            sql`${calls.startedAt} >= ${reopenedAtOf(p.customerId)}`,
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
      if (prospectProgress(values).complete) {
        throw new Refusal(
          err(
            "Everything a Prospect needs is already in, so no further call is needed. Request Prospect.",
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
      /* Blank answers are "not yet captured" — named, never refused. */
      notCaptured = prospectProgress(merged)
        .missing.map((f) => f.label)
        .join(", ");
      const finalText =
        disposition.kind === "ready"
          ? "Everything a Prospect needs is in — ready for Prospect"
          : disposition.kind === "exhausted"
            ? `Three calls made — not yet captured: ${notCaptured}`
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
        /* Call 1 of a reopened round must not collide with Call 1 of the first,
           so a round that follows a reopen carries that reopen in its key. */
        idempotencyKey: reopen
          ? `qualcall:${p.customerId}:${reopen.id}:${callNumber}`
          : `qualcall:${p.customerId}:${callNumber}`,
        createdById: ctx.user.id,
      });

      /*
       * THE PROMISES THIS CALL SETTLES, exactly as a call from the Call Log
       * settles them. The desk wrote its own row into `calls` and never asked,
       * so a reminder on a lead stayed open after the telecaller had rung them
       * from here and had to be ticked off by hand — the one thing the evidence
       * rule exists to make unnecessary. Same function, same transaction, same
       * rule: a call somebody answered closes what is due; a no-answer or a
       * dead number closes nothing, because the conversation is still owed.
       */
      remindersClosed = await closeRemindersOnEvidence(tx, {
        customerId: p.customerId,
        event: { kind: "call", on: day, answered: crmOutcomeFor(outcome) !== "no_answer" },
        sourceId: callId,
        actorId: ctx.user.id,
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
                leadNextActionOutcome: "Everything a Prospect needs is in",
              }
            : disposition.kind === "exhausted"
              ? {
                  /* No Call 4, so the next thing owed is the record itself:
                     fill in what has since come in, or close the lead. */
                  leadNextAction: `Capture what is still missing (${notCaptured}), or close the lead`,
                  leadNextActionDate: day,
                  leadNextActionOwnerId: ctx.user.id,
                  leadNextActionOutcome: "Three calls made",
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
        ? `Call ${callNumber} / ${MAX_QUALIFICATION_CALLS} saved. Everything a Prospect needs is in — Ready for Prospect.`
        : disposition.kind === "exhausted"
          ? `Call ${callNumber} / ${MAX_QUALIFICATION_CALLS} saved. Not yet captured: ${notCaptured}. The lead stays a Suspect — add them on the record when known, or close it.`
          : disposition.kind === "lost"
            ? closeFailed
              ? `Call ${callNumber} / ${MAX_QUALIFICATION_CALLS} saved, but the lead could not be closed: ${closeFailed}`
              : `${lostLabel} — lead marked Lost.`
            : `Call ${callNumber} / ${MAX_QUALIFICATION_CALLS} saved. ${
              (p.next?.kind ?? "call") === "call" ? `Call ${disposition.callNumber}` : "Message"
            } due ${shortDay(nextDate)}.`;

    const closedLine = remindersClosed
      ? ` ${remindersClosed === 1 ? "The reminder due on this lead is" : `${remindersClosed} reminders due on this lead are`} now closed.`
      : "";

    return ok(
      { callNumber, result: disposition.kind, remindersClosed, ...(closeFailed ? { closeFailed } : {}) },
      message + closedLine,
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
  /* The two things the Prospect gate wants that are not desk answers. Asked
     here, once, if the record does not already hold them. */
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  contactPerson: z.string().trim().max(200).optional(),
  /* Asked only where the lead has not been told how it will be sold. Never
     defaulted: which ladder a lead climbs decides which gates apply. */
  salesType: z.enum(["direct", "third_party"]).optional(),
});

/**
 * Everything a Suspect must satisfy before it may become a Prospect —
 * shared between `requestProspect` (the Sales Manager verification path) and
 * `convertLeadToProspect` (the calling desk's own direct promotion).
 *
 * ONE READINESS CONDITION, asked once. The desk answers a Prospect needs
 * (`prospectProgress`, the same engine the "Ready for Prospect" phase and the
 * button's enabled state are drawn from — the decision maker is not among them),
 * the sales type, the coded reason and
 * the §28 Prospect gate itself are all checked here — so neither caller can
 * drift from what the other demands, and a lead accepted by one cannot later
 * be refused by the promotion for something it was never asked. `nextAction`
 * lets each caller quote what THEIR next action will read, since §24 only
 * asks that one exists, not what it says.
 */
async function preparePromotion(
  p: z.infer<typeof requestSchema>,
  ctx: { user: { id: string } },
  nextAction: { action: string; date: string },
): Promise<
  Result<{
    lead: NonNullable<Awaited<ReturnType<typeof leadRow>>>;
    req: Awaited<ReturnType<typeof requestOf>>;
    salesType: "direct" | "third_party";
    setsSalesType: boolean;
    managerId: string;
    /** The Sales Manager the verification is owed to — the same owner the dry run
        above was asked with, so a caller's real write can never name a different one. */
    nextActionOwnerId: string;
    day: string;
  }>
> {
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

  const values: DeskValues = {
    decisionMaker: lead.leadDecisionMaker,
    monthlyLitres: lead.leadMonthlyVolumeLitres,
    requiredProductId: lead.leadRequiredProductId,
    competitor: lead.leadCompetitor,
  };
  const progress = prospectProgress(values);
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

  /* The person the verification — or, on direct promotion, the coordinating
     seat — is owed to: whoever already holds the lead manager seat, otherwise
     the one the region defaults to. */
  /*
   * THE VERIFICATION IS THE SALES MANAGER'S, AND NEVER THE TELECALLER'S.
   *
   * This used to fall back to `ctx.user.id` when nobody covered the lead, which
   * put the verification call on the person being verified: a Prospect whose
   * only possible verifier is the Telecaller who raised it is a Prospect that
   * verifies itself. So there is no fallback. The seat holder is used where
   * there is one (a manager somebody chose, or one who still holds
   * `lead.verify`); otherwise the region's default, filtered to people who can
   * really verify; and where there is nobody the conversion is REFUSED and the
   * lead stays a Suspect — ready, waiting for somebody to be set — rather than
   * becoming a Prospect nobody can verify.
   */
  let managerId: string | null = null;
  /* THE LEAD'S OWN SALES MANAGER COMES FIRST. Verification follows `sales_manager_id`,
     so where the seat is filled and its holder can verify (the capability, or the
     seat itself) the call is owed to them, not to some other `lead.verify` holder
     the region happens to default to. */
  /* A LEAD THE SALES MANAGER RAISED HERSELF IS VERIFIED BY THE PERSON MAHEK
     DESIGNATES, not by her: the verification is the check on her own work. */
  const selfRaisedApprover = await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId });
  if (selfRaisedApprover) managerId = selfRaisedApprover.id;
  if (!managerId && lead.salesManagerId) {
    const [sm] = await db
      .select({ id: users.id, role: users.role, active: users.active })
      .from(users)
      .where(eq(users.id, lead.salesManagerId))
      .limit(1);
    if (
      sm?.active &&
      ((await holdsLeadSeat(sm, lead.salesManagerId)) ||
        canAny(await hatsFor({ id: sm.id, role: sm.role }), "lead.verify"))
    ) {
      managerId = sm.id;
    }
  }
  if (!managerId && lead.leadManagerId) {
    const decided = Boolean(lead.leadManagerDecidedAt);
    const seat = await db
      .select({ id: users.id, role: users.role, active: users.active })
      .from(users)
      .where(eq(users.id, lead.leadManagerId))
      .limit(1);
    const seatHolder = seat[0];
    if (
      seatHolder?.active &&
      (decided || canAny(await hatsFor({ id: seatHolder.id, role: seatHolder.role }), "lead.verify"))
    ) {
      managerId = seatHolder.id;
    }
  }
  if (!managerId) {
    const candidates = await leadManagerCandidatesFor(p.customerId);
    managerId = candidates[0]?.id ?? null;
  }
  if (!managerId) {
    return err(
      "No Sales Manager covers this lead's region. Ask an administrator.",
      "rule_violation",
    );
  }
  const nextActionOwnerId: string = managerId;

  /* THE DRY RUN. The same gate the promotion will be asked, with what this
     request supplies. Anything still missing is named, so the desk can fix it
     now rather than finding out after the fact. */
  const gate = await leadGateInput(p.customerId);
  if (gate) {
    const verdict = gateTo(
      {
        ...gate,
        salesType,
        customerType: gate.customerType || p.customerType || null,
        contactPerson: gate.contactPerson?.trim() ? gate.contactPerson : (p.contactPerson ?? null),
        prospectReasonRecorded: true,
        nextAction: nextAction.action,
        nextActionDate: nextAction.date,
        nextActionOwnerId,
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

  /* Safe: `ladderFor(salesType).includes("prospect")` above already refused a
     `distributor` lead — that ladder carries no Prospect rung — so anything
     reaching here is one of the two this function's callers ever act on. */
  return ok({
    lead,
    req,
    salesType: salesType as "direct" | "third_party",
    setsSalesType,
    managerId,
    nextActionOwnerId,
    day,
  });
}

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
 * This is the path `convertLeadToProspect` falls back to when
 * `leads.callingDeskDirectPromotion` is switched off — the Sales Manager
 * verification architecture stays exactly as it was, ready to be the only
 * path again the day that setting is flipped back.
 *
 * WHAT IS CHECKED HERE IS WHAT THE PROMOTION WILL NEED — see `preparePromotion`.
 * What the desk answers do not cover, the kind of business and who to
 * ask for, is asked in the same act if the record lacks it.
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

    const config = await getConfig();
    const day = await today();
    const due = nextWorkingDay(day as BusinessDate, {
      timezone: config["workingDay.timezone"],
      dayBoundaryHour: config["workingDay.dayBoundaryHour"],
      workingDays: config["workingDay.workingDays"],
    });

    const prepared = await preparePromotion(p, ctx, { action: "Sales manager verification", date: due });
    if (!prepared.ok) return prepared;
    const { lead, req, salesType, setsSalesType, managerId, nextActionOwnerId } = prepared.data;
    const resubmitted = req.state === "returned";

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
        leadNextActionOwnerId: nextActionOwnerId,
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
      if (managerId !== lead.leadManagerId && !lead.leadManagerDecidedAt) set.leadManagerId = managerId;

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

/* ═══════════════════════════════════════ the calling desk's own conversion */

/**
 * Convert a ready Suspect straight to Prospect — the telecaller's own act,
 * with no Sales Manager verification call in between.
 *
 * MAHEK'S OWN REVERSAL OF THE RULE ABOVE `requestProspect` STATES. Where the
 * three qualification calls collect everything a Prospect is asked for, on
 * Call 1, 2 or 3, the telecaller presses this and the lead moves — the same
 * gated move `settleProspectRequest` makes after a verified call, run under the
 * telecaller's own hat instead of the manager's. Nothing here is a second
 * conversion mechanism: it is `advanceLeadStage({ to: "prospect" })`, the one
 * door every promotion in this funnel already goes through.
 *
 * `leads.callingDeskDirectPromotion` is what makes this a REVERSIBLE decision
 * rather than a rewrite. Off, this becomes `requestProspect` outright — the
 * Sales Manager verification queue, untouched, exactly as it stood before this
 * function existed. On (the default), the lead is promoted directly and the
 * queue is never touched: `prospect_request_state` stays `null` throughout,
 * so a lead converted this way was never, even for an instant, "awaiting" or
 * "with the Sales Manager".
 *
 * THE READINESS CHECKED IS `preparePromotion`'S, the same one `requestProspect`
 * checks — the desk answers a Prospect needs, the sales type, the coded reason,
 * and the §28 Prospect gate itself. A malicious or direct call with any of
 * that missing is refused here exactly as it would be there; the button on the
 * record screen is drawn from the same `prospectProgress` reading, so the two
 * can never disagree about when a lead is ready.
 */
export async function convertLeadToProspect(
  input: z.input<typeof requestSchema>,
): Promise<Result<{ promoted: boolean; requested?: boolean }>> {
  try {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const barred = await deskRefusal(ctx.user.id);
    if (barred) return barred;

    const config = await getConfig();
    if (!config["leads.callingDeskDirectPromotion"]) {
      /* THE ARCHITECTURE SWITCHES BACK WHOLE, not halfway. A lead put forward
         under this setting goes to the same verification queue it always did,
         under the same function, so re-enabling verification needs no second
         code path kept alive in parallel — only this one flag. */
      const requested = await requestProspect(input);
      if (!requested.ok) return requested;
      return ok({ promoted: false, requested: true }, requested.message);
    }

    const day = await today();
    const due = addDays(day, config["leads.verificationDueDays"]);
    const prepared = await preparePromotion(p, ctx, { action: QUAL_NEXT.verify, date: due });
    if (!prepared.ok) return prepared;
    const { lead, salesType, setsSalesType, managerId } = prepared.data;

    const now = new Date();
    await db.transaction(async (tx) => {
      /* Only what the record is missing is written, so a conversion never
         overwrites a business type or a contact somebody already gave — the
         same discipline `requestProspect` keeps. */
      const set: Partial<typeof customers.$inferInsert> = { leadLastActivityDate: day, updatedAt: now };
      if (setsSalesType) set.leadSalesType = salesType;
      if (!lead.customerType && p.customerType) set.customerType = p.customerType;
      if (!lead.contactPerson?.trim() && p.contactPerson) set.contactPerson = p.contactPerson;
      /* The seat is FILLED, never moved, and `lead_manager_decided_at` is left
         alone: nobody chose this person, the region did. */
      if (managerId !== lead.leadManagerId && !lead.leadManagerDecidedAt) set.leadManagerId = managerId;
      /* A lead the manager had once RETURNED, then completed on a later call,
         converts here rather than resubmitting — the queue it was in is left
         behind rather than resolved through it. */
      await tx.update(customers).set(set).where(eq(customers.id, p.customerId));

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
          afterState: { salesType, reason: "Chosen by the calling desk when converting to Prospect" },
        });
      }
    });

    /* THE ACTUAL PROMOTION — the same gated move `settleProspectRequest` makes
       after a verified call, so a Prospect made this way and one made after
       verification are indistinguishable on every screen and every report
       downstream of `lead_stage`. It runs its own §28 gate again: the dry run
       above is a courtesy that lets the desk fix what it can before saving,
       never the actual enforcement. */
    const moved = await advanceLeadStage({
      customerId: p.customerId,
      to: "prospect",
      reasonCode: p.reasonCode,
      note: p.note,
      /* THE NEXT STEP IS THE SALES MANAGER'S VERIFICATION, not the Telecaller's
         qualification: Qualification does not open until a manager has verified
         this Prospect. The owner of the lead is untouched. */
      nextAction: {
        action: QUAL_NEXT.verify,
        date: due,
        ownerId: managerId,
        outcome: "Verify the visit and what the desk collected, then Qualification opens",
      },
    });
    if (!moved.ok) {
      return err(`Not converted: ${moved.error}`, "rule_violation");
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: ctx.user.id,
      action: "lead.callingDesk.convertToProspect",
      entityType: "customer",
      entityId: p.customerId,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      beforeState: { leadStage: lead.leadStage },
      afterState: { leadStage: "prospect", reason: p.reasonCode },
    });

    /* The manager is told, because verification is now theirs to do and the
       first they would otherwise know is a lead going overdue against their name. */
    if (managerId !== ctx.user.id) {
      await notifyUser({
        userId: managerId,
        title: `${lead.name} is ready to verify`,
        body: `${ctx.user.name} created a Prospect from ${lead.name}. Qualification opens when you verify it.`,
        kind: "info",
        href: `/crm/leads/${p.customerId}/verify`,
      }).catch(() => {});
    }

    refresh(p.customerId);
    return ok({ promoted: true }, "Prospect created. Waiting for Sales Manager verification.");
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

/* ═════════════════════════════════════════════════════ reversing a loss */

const reopenSchema = z.object({
  customerId: z.string().min(1),
  /** One of `leads.reopenReasons`, validated against configuration by the service. */
  reasonCode: z.string().trim().min(1, "Why is it being reopened?").max(60),
  note: z.string().trim().max(1000).optional(),
  /** Optional: the desk's default is a call, today. */
  nextDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day as a date.")
    .optional(),
});

/**
 * Reverse a Lost lead — the Telecaller's door onto `reopenLostLead`.
 *
 * THIN ON PURPOSE. What reopening means is decided once, in the shared service,
 * and this adds only the desk's own questions: the Calling desk grant, the lead
 * being in this person's scope, and — the one rule that is the desk's — that a
 * loss the Sales Manager closed on a FAILED VERIFICATION is not the desk's to
 * take back. That is the manager's judgement about whether the opportunity was
 * real, and a Telecaller reversing it would be second-guessing a call they did
 * not make.
 *
 * WHAT MAKES IT WORKABLE: the lead returns to the rung it was lost from and its
 * three calls start again. Not by deleting or editing a call — every earlier
 * call stays on the record — but because the desk counts the calls made SINCE
 * the reopen (`reopenedAtSql`). A lead lost at Call 3 therefore comes back owed
 * Call 1, rather than as an `exhausted` lead nobody can ring.
 */
export async function reopenDeskLead(input: z.input<typeof reopenSchema>): Promise<Result<null>> {
  try {
    const parsed = reopenSchema.safeParse(input);
    if (!parsed.success) return zodErr(parsed.error);
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const barred = await deskRefusal(ctx.user.id);
    if (barred) return barred;
    const found = await reachable(p.customerId);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    if (lead.leadStage !== "lost") {
      return err("This lead is not Lost, so there is nothing to reverse.", "rule_violation");
    }

    const target = reopenTarget({
      lostFrom: await lostFromOf(p.customerId),
      salesType: lead.leadSalesType as LeadSalesType | null,
      lostReason: lead.leadLostReason,
    });
    if (target.basis === "verification_failed") {
      return err(
        "This lead was closed because its verification failed. That is the Sales Manager's judgement, so it is theirs to reverse — ask them.",
        "not_permitted",
      );
    }

    const day = await today();
    const working = isWorkingStage(target.stage);
    const moved = await reopenLostLead({
      actor: { userId: ctx.user.id, hat: { app: ctx.authorisedIn, role: ctx.authorisedBy }, sourceApp: "crm" },
      customerId: p.customerId,
      reasonCode: p.reasonCode,
      note: p.note,
      nextAction: {
        action: working
          ? nextActionText("call", 1, "")
          : `Carry on from ${stageLabel(target.stage)} — lead reopened`,
        date: p.nextDate ?? day,
        ownerId: lead.ownerId ?? ctx.user.id,
        outcome: null,
      },
      day,
      seat: "calling_desk",
    });
    if (!moved.ok) return moved;

    refresh(p.customerId);
    return ok(
      null,
      working
        ? `Reopened — back at ${stageLabel(moved.data.stage)} and callable again. The earlier calls are kept.`
        : moved.message,
    );
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
