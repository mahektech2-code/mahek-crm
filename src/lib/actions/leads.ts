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
  mbosLeadValidations,
  mbosTasks,
  notifications,
  users,
} from "@/db/schema";
import {
  assertCustomerInScope,
  canAny,
  requireCapability,
  rolesFor,
} from "@/lib/access-control";
import { today } from "@/lib/recompute";
import { writeTimelineEvent, MBOS_EVENT } from "@/lib/timeline";
import { err, fromThrown, ok, type FieldError, type Result } from "@/lib/result";
import {
  COMMUNICATION_ACTIONS,
  FIRST_ORDER_QUESTIONS,
  stageLabel,
  VERIFICATION_COLUMNS,
  VERIFICATION_QUESTIONS,
  type LeadSalesType,
  type LeadStage,
} from "@/lib/lead-labels";
import { checklistFor } from "@/lib/engines/lead-gates";
import { ladderFor, rungOf } from "@/lib/engines/lead-ladder";
import {
  applyLeadStageMove,
  evaluateLeadStageMove,
  leadGateInput,
  leadManagerCandidates,
  leadRow,
  type LeadRow,
} from "@/lib/services/lead-service";

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
  return canAny(await rolesFor(user), "lead.override");
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
    if (!ladderFor(lead.leadSalesType as LeadSalesType | null).includes(to) && to !== "lost") {
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
    const authorisedBy =
      decision.kind === "overridden" || decision.kind === "reverted"
        ? (await requireCapability("lead.override")).authorisedBy
        : ctx.authorisedBy;

    const result = await applyLeadStageMove(
      { userId: ctx.user.id, role: authorisedBy, sourceApp: "crm" },
      lead,
      to,
      {
        decision,
        reasonCode: p.reasonCode ?? p.override?.reasonCode ?? null,
        note: p.note ?? p.override?.note ?? null,
        nextAction: p.nextAction ?? null,
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
      if (!m || !m.active || m.role === "telecaller") {
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
 * `verified: false` closes NOTHING. It is a follow-up required — the salesman
 * gets a task with the manager's own words on it, because a notification can be
 * missed and a task on the list cannot — and the lead stays exactly where it is.
 * The answers are kept whichever way the verdict went: "which competitor did he
 * say he was using" is what somebody needs before the negotiation call, and it
 * does not stop being useful because the visit could not be confirmed.
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
  call: { answers: Record<string, string>; verified: boolean; followUpNote?: string },
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        answers: z.record(z.string(), z.string().trim().max(1000)),
        verified: z.boolean(),
        followUpNote: z.string().trim().max(2000).optional(),
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

    if (!c.verified && !c.followUpNote?.trim()) {
      return err(
        "A call that could not confirm the visit has to say what the salesman should do about it — that sentence is what lands on his list.",
        "validation",
      );
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
         * `pending` rather than `not_qualified` on a failed verification, and
         * the difference matters: §8 failing means the VISIT could not be
         * confirmed, which raises a follow-up and closes nothing. Calling the
         * lead not qualified would be the office turning down a shop on the
         * strength of not having reached its own salesman.
         */
        verdict: c.verified ? "confirmed" : "pending",
        verdictReason: c.followUpNote ?? null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });

      const set: Partial<typeof customers.$inferInsert> = {
        leadLastActivityDate: day,
        updatedAt: new Date(),
      };
      if (c.verified) {
        set.leadVerifiedAt = new Date();
        set.leadVerifiedById = ctx.user.id;
      }
      await tx.update(customers).set(set).where(eq(customers.id, customerId));

      if (!c.verified) {
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
        summary: c.verified
          ? `Sales manager verified ${lead.name} by phone.`
          : `Sales manager could not verify ${lead.name} — follow-up raised.`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.verify",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        afterState: { callId, verified: c.verified, answered: Object.keys(answers).length },
      });
    });

    refresh(customerId);
    return ok(null, 
      c.verified ? "Verified." : "Recorded, and the follow-up is on the salesman's list.",
    );
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

    const eventId = gen("lcm");

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
 * it is a DATE and a value, which is what §18's gate on `first_order` reads —
 * so this is the action that opens that rung, and a manager who rang and wrote
 * "keen" has opened nothing.
 *
 * The expected VALUE is optional and the date is not. A customer who will not
 * name a number will still name a week, and refusing the whole record for want
 * of the figure loses the date as well.
 */
export async function askForFirstOrder(
  customerId: string,
  input: {
    answers: Record<string, string>;
    expectedDate: string;
    expectedValuePaise?: number;
  },
): Promise<Result<null>> {
  try {
    const parsed = z
      .object({
        answers: z.record(z.string(), z.string().trim().max(1000)),
        expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day as a date."),
        expectedValuePaise: z.number().int().nonnegative().optional(),
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

    /* The first two are the report. Without how much and which product, this is
       the "customer interested" the specification is explicit about refusing —
       and it would set an expected order date behind nothing. */
    const owed = ["quantity", "product"].filter((id) => !answers[id]);
    if (owed.length) {
      return {
        ok: false,
        error: "How much, and which product. Those two are what makes this a report rather than a feeling.",
        code: "validation",
        fieldErrors: owed.map<FieldError>((id) => ({
          field: id,
          message: FIRST_ORDER_QUESTIONS.find((q) => q.id === id)!.ask,
        })),
      };
    }

    const eventId = gen("lfo");

    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadExpectedOrderDate: p.expectedDate,
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
        summary: `Asked ${lead.name} for the first order — ${answers.quantity} of ${answers.product}, expected ${p.expectedDate}.`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.firstOrder.ask",
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        afterState: { answers, expectedDate: p.expectedDate, expectedValuePaise: p.expectedValuePaise ?? null },
      });
    });

    refresh(customerId);
    return ok(null, "Recorded. The first-order rung is open once the order arrives.");
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
