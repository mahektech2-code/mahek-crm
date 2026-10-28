"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { auditLog, calls, customers, mbosVisits } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { reachLead } from "@/lib/services/lead-reach-service";
import { managedSalesmen } from "@/lib/services/managed-salesmen-service";
import {
  GENERAL_CALL,
  GENERAL_CALL_OUTCOMES,
  VISIT_OUTCOMES,
  WEB_VISIT_UNVERIFIED,
  crmOutcomeForGeneral,
  visitOutcomeLabel,
  type ActivityRow,
} from "@/lib/lead-activity";
import { today } from "@/lib/recompute";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { CRM_EVENT, MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { leadActivityHistory } from "@/lib/services/lead-activity-service";
import { leadRow } from "@/lib/services/lead-service";

/* ---------------------------------------------------------------------------
 * LOGGING A CALL OR A VISIT BY HAND, from the same place for everybody.
 *
 * `lead.work` and the lead's scope — nothing more and nothing less. A Telecaller
 * and a Sales Manager both hold the first, and the second is the same question
 * `assertCustomerInScope` answers everywhere (inside the Sales Manager
 * workspace it is the seat-or-owner rule, elsewhere the person's own book and
 * their reports'), so the two get one set of rules and one set of refusals
 * rather than a manager variant. Seeing a lead is not enough on its own: the
 * capability is asked first.
 *
 * WHAT THESE ARE NOT:
 *   • not the qualification call. Call 1/2/3, its answers, its cap and its
 *     stage gate are `logQualificationCall`'s and are untouched — a general
 *     call is marked `outcome_detail.activity` instead of `qualCall`, so it can
 *     never be counted as one of the three or hide that one is still owed.
 *   • not the handset's visit. That is `handleVisit`, with a device, a fix and
 *     a verdict. A visit logged here has none of those, is never `verified`,
 *     and says so on its row.
 *   • not telephony or GPS. Nothing is dialled and nothing is located; these
 *     record that somebody did something, and when, and what came of it.
 *
 * ONE KEY PER OPENING OF THE DIALOG. Both writes take a `clientKey` minted when
 * the dialog opens and derive the row's identity from it, so a double-click or
 * a retried request lands once. Without it a slow network is two calls on the
 * record, and the history reads as the person having rung twice.
 *
 * A FOLLOW-UP IS ONLY WRITTEN ONTO THE LEAD'S NEXT ACTION WHERE IT IS FREE.
 * The next action is the §24 promise of one named person; a Telecaller's
 * "ring again Friday" must not silently replace the Sales Manager's
 * "verification call" that the lead is waiting on. So the follow-up is always
 * kept on the activity itself, and is set as the lead's next action only when
 * nobody else owes it — said in the result when it was not.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the day as a date.");
const clientKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Missing request key.");

function refresh(customerId: string) {
  try {
    revalidatePath("/crm/leads");
    revalidatePath(`/crm/leads/${customerId}`);
    revalidatePath("/crm/leads/calling-desk");
    revalidatePath(`/crm/leads/calling-desk/${customerId}`);
    revalidatePath("/crm/leads/sales-manager");
    revalidatePath(`/crm/leads/sales-manager/${customerId}`);
    revalidatePath("/sales-lead-pipeline");
    revalidatePath(`/sales-lead-pipeline/${customerId}`);
    revalidatePath(`/sales/leads/${customerId}`);
  } catch {
    /* no request context — a job or a test, where nothing is cached */
  }
}

/** The lead, checked for scope — or the refusal to hand back. Throws where scope does. */
async function reachable(customerId: string, userId: string) {
  const lead = await leadRow(customerId);
  if (!lead || lead.kind !== "lead") {
    return { ok: false as const, refusal: err("That lead is not on MahekOne.", "not_found") };
  }
  await reachLead(lead, userId);
  if (lead.leadArchived) {
    return {
      ok: false as const,
      refusal: err("That lead is archived. Restore it before logging anything against it.", "validation"),
    };
  }
  return { ok: true as const, lead };
}

/**
 * When it happened, from a day and a time typed in India. Built with an
 * explicit +05:30 rather than `new Date("…")`, which reads a bare string in the
 * zone of whichever machine is asking — the bug this codebase has met four
 * times. Never in the future, and not older than the window below: a call
 * logged six months late is a different kind of record.
 */
const BACKDATE_DAYS = 60;
function instantOf(date: string | undefined, time: string | undefined): Date | { error: string } {
  if (!date) return new Date();
  const t = time && /^\d{2}:\d{2}$/.test(time) ? time : "12:00";
  const at = new Date(`${date}T${t}:00+05:30`);
  if (Number.isNaN(at.getTime())) return { error: "That date and time do not make sense." };
  const now = Date.now();
  if (at.getTime() > now + 5 * 60_000) return { error: "That is in the future — log it once it has happened." };
  if (at.getTime() < now - BACKDATE_DAYS * 86_400_000) {
    return { error: `Too far back — activity older than ${BACKDATE_DAYS} days cannot be logged here.` };
  }
  return at;
}

/* ------------------------------------------------------------------- a call */

const callSchema = z.object({
  customerId: z.string().min(1),
  clientKey,
  outcome: z.enum(["spoke", "callback", "no_answer", "not_interested"]),
  notes: z.string().trim().max(2000).optional(),
  /** When the call was made. Defaults to now. */
  onDate: day.optional(),
  atTime: z.string().optional(),
  followUpDate: day.optional(),
  followUpText: z.string().trim().max(300).optional(),
});

export type LogLeadCallResult = { callId: string; followUpSetAsNextAction: boolean };

export async function logLeadCall(
  input: z.input<typeof callSchema>,
): Promise<Result<LogLeadCallResult>> {
  try {
    const parsed = callSchema.safeParse(input);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? "Check the call and try again.", "validation");
    }
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const found = await reachable(p.customerId, ctx.user.id);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    if (p.outcome === "callback" && !p.followUpDate) {
      return err("Say when to call back.", "validation", [
        { field: "followUpDate", message: "Pick the day." },
      ]);
    }
    const when = instantOf(p.onDate, p.atTime);
    if ("error" in when) return err(when.error, "validation", [{ field: "onDate", message: when.error }]);
    const businessDay = await today();
    if (p.followUpDate && p.followUpDate < businessDay) {
      return err("The follow-up date cannot be in the past.", "validation", [
        { field: "followUpDate", message: "Pick today or a later day." },
      ]);
    }

    const label = GENERAL_CALL_OUTCOMES.find((o) => o.code === p.outcome)?.label ?? p.outcome;
    const callId = `cal_act_${p.clientKey}`;
    const followUpText = p.followUpDate ? (p.followUpText || "Call back") : null;

    /* The lead's next action moves only where nobody else is holding it. */
    const nextActionFree =
      !lead.leadNextActionOwnerId || lead.leadNextActionOwnerId === ctx.user.id;
    const setsNextAction = Boolean(p.followUpDate) && nextActionFree;

    let landed = false;
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(calls)
        .values({
          id: callId,
          customerId: p.customerId,
          userId: ctx.user.id,
          direction: "outbound",
          interactionType: "outbound_call",
          outcome: crmOutcomeForGeneral(p.outcome),
          startedAt: when,
          notes: p.notes || null,
          sourceModule: "customer_record",
          outcomeDetail: {
            activity: GENERAL_CALL,
            generalOutcome: p.outcome,
            ...(p.followUpDate ? { nextDate: p.followUpDate, nextAction: followUpText ?? "Call back" } : {}),
          },
          idempotencyKey: `leadact:call:${p.customerId}:${p.clientKey}`,
          createdById: ctx.user.id,
        })
        .onConflictDoNothing()
        .returning({ id: calls.id });
      if (inserted.length === 0) return; // the same dialog, sent twice
      landed = true;

      await tx
        .update(customers)
        .set({
          leadLastActivityDate: businessDay,
          updatedAt: new Date(),
          ...(setsNextAction
            ? {
                leadNextAction: followUpText,
                leadNextActionDate: p.followUpDate,
                leadNextActionOwnerId: ctx.user.id,
                leadNextActionOutcome: null,
              }
            : {}),
        })
        .where(eq(customers.id, p.customerId));

      await writeTimelineEvent(tx, {
        customerId: p.customerId,
        eventType: CRM_EVENT.call,
        sourceApp: "crm",
        sourceRecordId: callId,
        occurredAt: when,
        actorUserId: ctx.user.id,
        summary: `Call — ${label}${p.notes ? ` · ${p.notes.slice(0, 160)}` : ""}`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.activity.call",
        entityType: "customer",
        entityId: p.customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: null,
        afterState: {
          outcome: p.outcome,
          followUpDate: p.followUpDate ?? null,
          followUpSetAsNextAction: setsNextAction,
        },
      });
    });

    refresh(p.customerId);
    const heldBy =
      p.followUpDate && !setsNextAction
        ? " The follow-up is kept on this call; the lead's next action belongs to someone else and was not changed."
        : "";
    return ok(
      { callId, followUpSetAsNextAction: setsNextAction },
      (landed ? "Call logged." : "Already logged.") + heldBy,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------------ a visit */

const visitSchema = z.object({
  customerId: z.string().min(1),
  clientKey,
  outcome: z.enum(VISIT_OUTCOMES.map((o) => o.code) as [string, ...string[]]),
  notes: z.string().trim().max(2000).optional(),
  /** What was talked about — kept with the notes, labelled. */
  discussion: z.string().trim().max(1000).optional(),
  /** The salesman who made the visit, where it is not the person recording it. */
  salesmanId: z.string().min(1).optional(),
  onDate: day.optional(),
  atTime: z.string().optional(),
  followUpDate: day.optional(),
});

/**
 * WHO CAN BE NAMED AS HAVING MADE A VISIT: the person recording it, and the
 * salesmen they manage (`managedSalesmen` — reporting line, Org Chart or Sales
 * Manager seat). Not every holder of the Salesman App. The lead's own scope is
 * asked first, and `logLeadVisit` asks the same question again.
 */
export async function visitSalesmenAction(
  customerId: string,
): Promise<Result<{ meId: string; people: { id: string; name: string }[] }>> {
  try {
    const user = await requireUser();
    const lead = await leadRow(customerId);
    if (!lead || lead.kind !== "lead") return err("That lead is not on MahekOne.", "not_found");
    await reachLead(lead, user.id);
    const team = await managedSalesmen(user);
    const people = [{ id: user.id, name: user.name }];
    for (const f of team) if (!people.some((p) => p.id === f.id)) people.push({ id: f.id, name: f.name });
    people.sort((a, b) => (a.id === user.id ? -1 : b.id === user.id ? 1 : a.name.localeCompare(b.name)));
    return ok({ meId: user.id, people });
  } catch (e) {
    return fromThrown(e);
  }
}

export async function logLeadVisit(
  input: z.input<typeof visitSchema>,
): Promise<Result<{ visitId: string }>> {
  try {
    const parsed = visitSchema.safeParse(input);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? "Check the visit and try again.", "validation");
    }
    const p = parsed.data;

    const ctx = await requireCapability("lead.work");
    const found = await reachable(p.customerId, ctx.user.id);
    if (!found.ok) return found.refusal;
    const lead = found.lead;

    const when = instantOf(p.onDate, p.atTime);
    if ("error" in when) return err(when.error, "validation", [{ field: "onDate", message: when.error }]);
    const businessDay = await today();
    if (p.followUpDate && p.followUpDate < businessDay) {
      return err("The follow-up date cannot be in the past.", "validation", [
        { field: "followUpDate", message: "Pick today or a later day." },
      ]);
    }

    /* WHO MADE THE VISIT. The person recording it, unless they name a salesman — who has to hold
       the Salesman App and be active. The recorder is kept apart on `created_by_id`. */
    let visitBy = ctx.user.id;
    let visitByName = ctx.user.name;
    if (p.salesmanId && p.salesmanId !== ctx.user.id) {
      const s = (await managedSalesmen(ctx.user)).find((m) => m.id === p.salesmanId);
      if (!s) {
        return err(
          "That salesman is not on your team, so a visit cannot be recorded as theirs. Pick one of yours.",
          "not_permitted",
          [{ field: "salesmanId", message: "Not on your team." }],
        );
      }
      visitBy = s.id;
      visitByName = s.name;
    }
    const noteText =
      [p.discussion ? `Discussed: ${p.discussion}` : null, p.notes ? `Notes: ${p.notes}` : null]
        .filter(Boolean)
        .join("\n") || null;

    const visitId = `vis_web_${p.clientKey}`;
    const nextActionFree =
      !lead.leadNextActionOwnerId || lead.leadNextActionOwnerId === ctx.user.id;
    const setsNextAction = Boolean(p.followUpDate) && nextActionFree;
    const whenIso = when.toISOString();

    let landed = false;
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(mbosVisits)
        .values({
          id: visitId,
          customerId: p.customerId,
          salesmanId: visitBy,
          checkInAt: when,
          outcome: p.outcome as (typeof mbosVisits.$inferInsert)["outcome"],
          notes: noteText,
          nextFollowUpDate: p.followUpDate ?? null,
          /* No device and no fix: nothing about where anybody stood was checked,
             and the row says so rather than leaving a manager to infer it. */
          verified: false,
          unverifiedReason: WEB_VISIT_UNVERIFIED,
          clientCreatedAt: new Date(),
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
          deviceId: null,
        })
        .onConflictDoNothing()
        .returning({ id: mbosVisits.id });
      if (inserted.length === 0) return; // the same dialog, sent twice
      landed = true;

      /* The derived cache the handset's own visit moves, with the zone named. */
      await tx.execute(sql`
        update customers
           set last_visit_date = greatest(
                 coalesce(last_visit_date, date '1900-01-01'),
                 (${whenIso}::timestamptz at time zone 'Asia/Kolkata')::date
               ),
               lead_last_activity_date = ${businessDay},
               updated_at = now()
         where id = ${p.customerId}
      `);
      if (setsNextAction) {
        await tx
          .update(customers)
          .set({
            leadNextAction: "Follow up after the visit",
            leadNextActionDate: p.followUpDate,
            leadNextActionOwnerId: ctx.user.id,
            leadNextActionOutcome: null,
          })
          .where(eq(customers.id, p.customerId));
      }

      await writeTimelineEvent(tx, {
        customerId: p.customerId,
        eventType: MBOS_EVENT.visit,
        sourceApp: "crm",
        sourceRecordId: visitId,
        occurredAt: when,
        actorUserId: ctx.user.id,
        summary: `Visit by ${visitByName}, logged by hand — ${visitOutcomeLabel(p.outcome)}${noteText ? ` · ${noteText.replace(/\n/g, " ").slice(0, 160)}` : ""}`,
      });

      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.activity.visit",
        entityType: "customer",
        entityId: p.customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: null,
        afterState: { outcome: p.outcome, salesmanId: visitBy, followUpDate: p.followUpDate ?? null, followUpSetAsNextAction: setsNextAction },
      });
    });

    refresh(p.customerId);
    const heldBy =
      p.followUpDate && !setsNextAction
        ? " The follow-up is kept on this visit; the lead's next action belongs to someone else and was not changed."
        : "";
    return ok({ visitId }, (landed ? "Visit logged." : "Already logged.") + heldBy);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------------ history */

/**
 * Calls and visits on one lead, newest first. The lead's scope is asked here and
 * not left to the screen that calls it: a server action is a URL, and the
 * history carries what people said to the customer.
 */
export async function leadActivityHistoryAction(customerId: string): Promise<Result<ActivityRow[]>> {
  try {
    if (!customerId) return err("That lead is not on MahekOne.", "not_found");
    /* Signed in, and the lead in reach — the same rule the call and the visit
       use. No capability: reading what a lead's own page already shows is the
       scope's question, and a capability that some app's associates simply do not
       hold made this refuse the Sales Manager screen's own people. */
    const user = await requireUser();
    const lead = await leadRow(customerId);
    if (!lead || lead.kind !== "lead") return err("That lead is not on MahekOne.", "not_found");
    await reachLead(lead, user.id);
    return ok(await leadActivityHistory(customerId));
  } catch (e) {
    return fromThrown(e);
  }
}
