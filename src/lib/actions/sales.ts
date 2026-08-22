"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  customers,
  mbosApprovals,
  mbosCourses,
  mbosDeletions,
  mbosDevices,
  mbosDocuments,
  mbosHolidays,
  mbosManagerTerritories,
  mbosJourneyPlans,
  mbosJourneyStops,
  notifications,
  users,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { updateSettings } from "@/lib/config/store";
import { bindAttachments, createAttachment } from "@/lib/services/attachment-service";
import type { DocumentCategory } from "@/lib/mbos/library-labels";
import { err, fromThrown, ok, okVoid, type Result } from "@/lib/result";

/** Count, noun and verb agree at every value. */
function plural(n: number, noun: string, pl?: string): string {
  return `${n} ${n === 1 ? noun : (pl ?? `${noun}s`)}`;
}

/* ---------------------------------------------------------------------------
 * Every write the Sales Dashboard makes.
 *
 * **Holding the app is the permission.** That is this app's own rule and not
 * the capability matrix's: `access-control.ts` answers questions about roles,
 * and what a sales manager may do here was decided as "whoever is given the
 * Sales Dashboard", so the guard is the grant. It is checked in every action
 * and not merely by the layout, because a server action is a URL.
 *
 * **One decision this app deliberately does NOT make.** An `order` approval is
 * accounts', by an explicit rule in AGENTS.md: the person chasing the target
 * must not sign off the orders that hit it. Those rows are shown here — a
 * manager needs to know one of their people is stuck — and the decision is
 * refused with a sentence saying where it lives. Everything else about a
 * salesman's day is this screen's.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

/** Whoever holds the app. Checked here, not only in the layout. */
async function requireSales() {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("sales")) {
    throw Object.assign(new Error("The Sales Dashboard has not been granted to you."), {
      name: "NotPermittedError",
    });
  }
  return user;
}

function refresh() {
  try {
    revalidatePath("/sales");
    revalidatePath("/sales/approvals");
    revalidatePath("/sales/journeys");
    revalidatePath("/sales/holidays");
    revalidatePath("/sales/people");
    revalidatePath("/sales/documents");
    revalidatePath("/sales/knowledge");
    revalidatePath("/apps");
  } catch {
    /* no request context — nothing cached to invalidate */
  }
}

/**
 * Telling somebody the answer.
 *
 * A decision nobody receives is not a decision. The salesman's handset reads
 * `notifications` on every pull, so this is the channel that carries it — and
 * the href points at MBOS's own approvals screen rather than at a MahekOne
 * route he cannot open.
 */
async function tell(userId: string, title: string, body: string) {
  await db
    .insert(notifications)
    .values({ id: gen("ntf"), userId, title, body, kind: "info" })
    .catch(() => {});
}

/* ══════════════════════════════════════════════════════════ the decisions */

export type ApprovalDecision = "approved" | "rejected" | "partially_approved";

/**
 * Answering one request.
 *
 * Three rules, and each of them exists because of what the answer costs the
 * person waiting:
 *
 *  - **A refusal needs a reason.** A salesman told "declined" with nothing
 *    after it has to ring somebody to find out what to do next, and the
 *    customer is still standing there.
 *  - **A partial approval needs an amount**, which is what
 *    `approvedAmountPaise` is for — an expense allowed at less than it asked
 *    for is a different answer from either yes or no, and recording it as "yes"
 *    loses the difference on payday.
 *  - **A decision is made once.** Deciding an already-decided approval is
 *    refused rather than overwritten: the first answer is the one somebody
 *    acted on, and the second would erase the record of it.
 */
export async function decideApproval(input: {
  approvalId: string;
  decision: ApprovalDecision;
  note?: string;
  approvedAmountPaise?: number;
}): Promise<Result> {
  try {
    const user = await requireSales();

    const [approval] = await db
      .select()
      .from(mbosApprovals)
      .where(eq(mbosApprovals.id, input.approvalId))
      .limit(1);

    if (!approval) return err("That request no longer exists.", "not_found");

    if (approval.state !== "pending") {
      return err(
        `This was already ${approval.state.replace(/_/g, " ")}${
          approval.decidedAt ? ` on ${approval.decidedAt.toLocaleDateString("en-GB")}` : ""
        }. A second decision would erase the one somebody has already acted on.`,
        "conflict",
      );
    }

    /* Accounts', and said in words rather than by hiding the button — a
     * manager who cannot see the control assumes the screen is broken. */
    if (approval.type === "order") {
      return err(
        "An order over the credit limit is accounts' decision, not the sales desk's — the person chasing the target does not sign off the orders that hit it. It is waiting in Accounts → Order approvals.",
        "not_permitted",
      );
    }

    const note = input.note?.trim() ?? "";
    if (input.decision !== "approved" && !note) {
      return err(
        "Say why. Whoever asked has to be able to do something differently, and they cannot work it out from the word alone.",
        "validation",
      );
    }

    if (input.decision === "partially_approved") {
      if (!input.approvedAmountPaise || input.approvedAmountPaise <= 0) {
        return err(
          "A partial approval needs the amount you are allowing. Without it this is a yes.",
          "validation",
        );
      }
    }

    await db
      .update(mbosApprovals)
      .set({
        state: input.decision,
        approverUserId: user.id,
        decidedAt: new Date(),
        decisionNote: note || null,
        approvedAmountPaise:
          input.decision === "partially_approved" ? input.approvedAmountPaise : null,
        updatedAt: new Date(),
        updatedById: user.id,
      })
      .where(
        // The state is in the WHERE as well as checked above: two managers on
        // the same queue is an ordinary Tuesday, and the second write must not
        // land on a row the first one has already decided.
        and(eq(mbosApprovals.id, input.approvalId), eq(mbosApprovals.state, "pending")),
      );

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: `mbos.approval.${input.decision}`,
      entityType: "mbos_approval",
      entityId: approval.id,
      beforeState: { state: "pending" } as never,
      afterState: {
        state: input.decision,
        note: note || null,
        approvedAmountPaise: input.approvedAmountPaise ?? null,
      } as never,
    });

    const words =
      input.decision === "approved"
        ? "approved"
        : input.decision === "rejected"
          ? "not approved"
          : "approved in part";

    await tell(
      approval.requestedByUserId,
      `Your ${approval.type.replace(/_/g, " ")} request was ${words}`,
      note || `${user.name} ${words} it.`,
    );

    refresh();
    return okVoid(`Answered — ${approval.type.replace(/_/g, " ")} ${words}.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════════════════════ the journeys */

/**
 * The longest run of days one save may cover.
 *
 * A month is what a beat cycle is planned in, and thirty-one is what a month
 * can be. Beyond that a manager is not planning, they are forecasting — the
 * book moves, people leave, shops close, and a route laid out in March for
 * June is a route somebody will have to redo.
 */
const MAX_PLAN_DAYS = 31;

export type PlannedDay = {
  /** `YYYY-MM-DD`. */
  planDate: string;
  beat?: string | null;
  /** In the order they are to be walked. An empty day CLEARS that day. */
  customerIds: string[];
  startTime?: string;
};

/**
 * A whole period, saved once.
 *
 * A beat plan is a cycle rather than a day: Monday on one beat, Tuesday on the
 * next, repeating for a fortnight or a month. Saving that a day at a time
 * meant thirty round trips and thirty chances to stop half way, which leaves a
 * salesman with a fortnight planned and a fortnight blank and no way to tell
 * from his handset which half was meant.
 *
 * So the whole period is ONE transaction. Every day validates before any day
 * writes, and if the thirtieth is wrong the first twenty-nine do not land —
 * the alternative is a partial plan nobody agreed to, discovered in a market.
 *
 * A day with no shops in it DELETES that day's plan rather than saving an
 * empty one. That is how a manager clears a Sunday, and it is refused where
 * the day has already been walked.
 */
export async function saveJourneyPeriod(input: {
  salesmanId: string;
  days: PlannedDay[];
  minutesPerStop?: number;
}): Promise<Result<{ saved: number; cleared: number; skipped: string[] }>> {
  try {
    const user = await requireSales();

    if (!input.days.length) {
      return err("There are no days in that period.", "validation");
    }
    if (input.days.length > MAX_PLAN_DAYS) {
      return err(
        `That is ${input.days.length} days and a plan covers up to ${MAX_PLAN_DAYS} at a time. Beyond a month a route is a forecast rather than a plan — the book moves under it.`,
        "validation",
      );
    }

    const dates = new Set<string>();
    for (const d of input.days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.planDate)) {
        return err(`"${d.planDate}" is not a date this can plan for.`, "validation");
      }
      if (dates.has(d.planDate)) {
        return err(
          `${d.planDate} appears twice. One salesman has one plan a day — that is what the database enforces, and two rows for one day is a route nobody can read.`,
          "validation",
        );
      }
      dates.add(d.planDate);
    }

    const [salesman] = await db
      .select({ id: users.id, name: users.name, active: users.active })
      .from(users)
      .where(eq(users.id, input.salesmanId))
      .limit(1);
    if (!salesman) return err("That salesman is not on MahekOne.", "not_found");
    if (!salesman.active) {
      return err(
        `${salesman.name}'s account is closed, so there is nobody to walk these plans.`,
        "validation",
      );
    }

    /* Every shop named across the whole period, checked once. Thirty days of
     * the same beat is the same twelve shops asked about thirty times. */
    const named = [...new Set(input.days.flatMap((d) => d.customerIds))];
    if (named.length) {
      const found = await db
        .select({ id: customers.id, name: customers.name, status: customers.status })
        .from(customers)
        .where(inArray(customers.id, named));

      const byId = new Map(found.map((c) => [c.id, c]));
      const missing = named.filter((id) => !byId.has(id));
      if (missing.length) {
        return err(
          `${missing.length} of those shops are no longer on the book. Remove them and save again.`,
          "validation",
        );
      }
      const closed = found.filter((c) => c.status !== "active");
      if (closed.length) {
        return err(
          `${closed.map((c) => c.name).join(", ")} ${closed.length === 1 ? "is" : "are"} not active, so ${closed.length === 1 ? "it" : "they"} cannot be planned into a day.`,
          "validation",
        );
      }
    }

    const perStop =
      input.minutesPerStop && input.minutesPerStop > 0 ? input.minutesPerStop : 75;

    let saved = 0;
    let cleared = 0;
    const skipped: string[] = [];

    await db.transaction(async (tx) => {
      for (const day of input.days) {
        const [existing] = await tx
          .select({ id: mbosJourneyPlans.id })
          .from(mbosJourneyPlans)
          .where(
            and(
              eq(mbosJourneyPlans.userId, input.salesmanId),
              sql`${mbosJourneyPlans.planDate} = ${day.planDate}::date`,
            ),
          )
          .limit(1);

        /* What has already happened is never rewritten. A walked stop is what
         * the visit logged against it points at. */
        const walked = existing
          ? await tx
              .select({ customerId: mbosJourneyStops.customerId })
              .from(mbosJourneyStops)
              .where(
                and(
                  eq(mbosJourneyStops.planId, existing.id),
                  sql`${mbosJourneyStops.status} <> 'planned'`,
                ),
              )
          : [];
        const untouchable = new Set(walked.map((w) => w.customerId));

        /* An empty day means "clear it". Refused where any of it was walked —
         * the day happened, and a plan is the record of what it was. */
        if (day.customerIds.length === 0) {
          if (!existing) continue;
          if (untouchable.size) {
            skipped.push(day.planDate);
            continue;
          }
          await tx.delete(mbosJourneyPlans).where(eq(mbosJourneyPlans.id, existing.id));
          cleared += 1;
          continue;
        }

        const planId = existing?.id ?? gen("mbos_plan");
        const startMinutes = parseClock(day.startTime) ?? 9 * 60 + 30;

        if (existing) {
          await tx
            .update(mbosJourneyPlans)
            .set({
              beat: day.beat ?? null,
              estimatedTravelMinutes: perStop * Math.max(0, day.customerIds.length - 1),
              updatedAt: new Date(),
              updatedById: user.id,
            })
            .where(eq(mbosJourneyPlans.id, planId));
        } else {
          await tx.insert(mbosJourneyPlans).values({
            id: planId,
            userId: input.salesmanId,
            planDate: day.planDate,
            beat: day.beat ?? null,
            status: "active",
            estimatedTravelMinutes: perStop * Math.max(0, day.customerIds.length - 1),
            createdById: user.id,
            updatedById: user.id,
          });
        }

        await tx
          .delete(mbosJourneyStops)
          .where(
            and(
              eq(mbosJourneyStops.planId, planId),
              sql`${mbosJourneyStops.status} = 'planned'`,
            ),
          );

        const fresh = day.customerIds.filter((id) => !untouchable.has(id));
        if (fresh.length) {
          await tx.insert(mbosJourneyStops).values(
            fresh.map((customerId, i) => ({
              id: gen("mbos_stop"),
              planId,
              customerId,
              sequence: untouchable.size + i + 1,
              plannedAt: clockOn(
                day.planDate,
                startMinutes + (untouchable.size + i) * perStop,
              ),
              status: "planned" as const,
              createdById: user.id,
              updatedById: user.id,
            })),
          );
        }
        saved += 1;
      }
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.journey.period",
      entityType: "mbos_journey_plan",
      entityId: input.salesmanId,
      afterState: {
        salesman: salesman.name,
        from: input.days[0]?.planDate,
        to: input.days[input.days.length - 1]?.planDate,
        daysPlanned: saved,
        daysCleared: cleared,
        stops: input.days.reduce((n, d) => n + d.customerIds.length, 0),
      } as never,
    });

    /* One notification for the period, not one per day. Thirty bells for one
     * act of planning is a notification list somebody turns off. */
    const span =
      input.days.length === 1
        ? input.days[0].planDate
        : `${input.days[0].planDate} to ${input.days[input.days.length - 1].planDate}`;
    await tell(
      input.salesmanId,
      `Your route for ${span}`,
      `${user.name} planned ${saved === 1 ? "a day" : `${saved} days`}${
        cleared ? ` and cleared ${cleared}` : ""
      }. It will be on your handset at the next sync.`,
    );

    refresh();
    return ok(
      { saved, cleared, skipped },
      skipped.length
        ? `Saved ${saved === 1 ? "one day" : `${saved} days`}. ${skipped.length === 1 ? "One day was" : `${skipped.length} days were`} left alone — ${skipped.join(", ")} ${skipped.length === 1 ? "has" : "have"} already been walked.`
        : `Saved ${saved === 1 ? "one day" : `${saved} days`}${cleared ? `, cleared ${cleared}` : ""}.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════════ the negotiation */

/**
 * Proposing where somebody works, a day at a time.
 *
 * The manager proposes a CITY and nothing more. The design is explicit about
 * why: only the salesman picks the customers, because he knows the city — and
 * he is also the one who knows that Tumakuru market shuts on a Wednesday, or
 * that Surat and Rajkot back to back is 340 km in a day. Both are real
 * refusals from the design's own fixture, and neither is something an office
 * screen could have worked out.
 *
 * A day already AGREED or PLANNED is left alone. Re-proposing over a day the
 * salesman has already picked shops for would throw away his morning's
 * thinking, and the point of asking him was that his answer is worth more than
 * the manager's guess.
 */
export async function proposeJourneyDays(input: {
  salesmanId: string;
  days: Array<{ planDate: string; city: string }>;
}): Promise<Result<{ proposed: number; leftAlone: string[] }>> {
  try {
    const user = await requireSales();

    if (!input.days.length) return err("There are no days to propose.", "validation");
    if (input.days.length > MAX_PLAN_DAYS) {
      return err(
        `That is ${input.days.length} days and a plan covers up to ${MAX_PLAN_DAYS} at a time.`,
        "validation",
      );
    }

    const [salesman] = await db
      .select({ id: users.id, name: users.name, active: users.active })
      .from(users)
      .where(eq(users.id, input.salesmanId))
      .limit(1);
    if (!salesman) return err("That salesman is not on MahekOne.", "not_found");
    if (!salesman.active) {
      return err(`${salesman.name}'s account is closed.`, "validation");
    }

    let proposed = 0;
    const leftAlone: string[] = [];

    await db.transaction(async (tx) => {
      for (const day of input.days) {
        const city = day.city.trim();
        if (!city) continue;

        const [existing] = await tx
          .select({ id: mbosJourneyPlans.id, dayState: mbosJourneyPlans.dayState })
          .from(mbosJourneyPlans)
          .where(
            and(
              eq(mbosJourneyPlans.userId, input.salesmanId),
              sql`${mbosJourneyPlans.planDate} = ${day.planDate}::date`,
            ),
          )
          .limit(1);

        /* His answer stands. A day he has agreed or picked shops for is not
         * something to overwrite from an office. */
        if (existing && (existing.dayState === "agreed" || existing.dayState === "planned")) {
          leftAlone.push(day.planDate);
          continue;
        }

        if (existing) {
          await tx
            .update(mbosJourneyPlans)
            .set({
              city,
              dayState: "proposed",
              proposedById: user.id,
              proposedAt: new Date(),
              /* A fresh proposal clears the last refusal: the question has
               * changed, so the old answer is no longer an answer to it. */
              refusalReason: null,
              counterCity: null,
              respondedAt: null,
              updatedAt: new Date(),
              updatedById: user.id,
            })
            .where(eq(mbosJourneyPlans.id, existing.id));
        } else {
          await tx.insert(mbosJourneyPlans).values({
            id: gen("mbos_plan"),
            userId: input.salesmanId,
            planDate: day.planDate,
            city,
            status: "draft",
            dayState: "proposed",
            proposedById: user.id,
            proposedAt: new Date(),
            createdById: user.id,
            updatedById: user.id,
          });
        }
        proposed += 1;
      }
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.journey.propose",
      entityType: "mbos_journey_plan",
      entityId: input.salesmanId,
      afterState: {
        salesman: salesman.name,
        days: proposed,
        from: input.days[0]?.planDate,
        to: input.days[input.days.length - 1]?.planDate,
      } as never,
    });

    if (proposed) {
      await tell(
        input.salesmanId,
        `${plural(proposed, "day")} proposed for you`,
        `${user.name} has proposed where you work. Open your plan to agree, or say why a day will not work and what you want instead.`,
      );
    }

    refresh();
    return ok(
      { proposed, leftAlone },
      leftAlone.length
        ? `Proposed ${plural(proposed, "day")}. ${plural(leftAlone.length, "day")} left alone — already agreed or picked.`
        : `Proposed ${plural(proposed, "day")}.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Answering a refusal.
 *
 * Two ways, and the design implies both: take what he asked for, or propose
 * something else. Taking his counter-proposal moves the day straight to
 * `agreed` — he named that city himself, so there is nothing left to agree —
 * and proposing something else puts the question back to him.
 *
 * There is deliberately no way to overrule a refusal into `planned`. A manager
 * who could would be back to issuing routes, and the reason for asking was
 * that his answer is worth more than theirs.
 */
export async function answerRefusal(input: {
  planId: string;
  /** Accept what he asked for, or put a different city back to him. */
  take: "counter" | "other";
  city?: string;
}): Promise<Result> {
  try {
    const user = await requireSales();

    const [plan] = await db
      .select()
      .from(mbosJourneyPlans)
      .where(eq(mbosJourneyPlans.id, input.planId))
      .limit(1);
    if (!plan) return err("That day is no longer on the plan.", "not_found");
    if (plan.dayState !== "refused") {
      return err(
        `That day is ${plan.dayState}, not refused — there is nothing to answer.`,
        "conflict",
      );
    }

    const city =
      input.take === "counter" ? (plan.counterCity ?? "").trim() : (input.city ?? "").trim();

    if (!city) {
      return err(
        input.take === "counter"
          ? "He refused without naming somewhere else, so there is nothing to take. Propose a city instead."
          : "Name the city you are proposing.",
        "validation",
      );
    }

    await db
      .update(mbosJourneyPlans)
      .set({
        city,
        /* His own suggestion needs no further agreement from him. */
        dayState: input.take === "counter" ? "agreed" : "proposed",
        proposedById: user.id,
        proposedAt: new Date(),
        refusalReason: null,
        counterCity: null,
        respondedAt: input.take === "counter" ? new Date() : null,
        updatedAt: new Date(),
        updatedById: user.id,
      })
      .where(eq(mbosJourneyPlans.id, input.planId));

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action:
        input.take === "counter" ? "mbos.journey.took_counter" : "mbos.journey.reproposed",
      entityType: "mbos_journey_plan",
      entityId: plan.id,
      beforeState: {
        city: plan.city,
        refusalReason: plan.refusalReason,
        counterCity: plan.counterCity,
      } as never,
      afterState: { city, planDate: plan.planDate } as never,
    });

    await tell(
      plan.userId,
      input.take === "counter"
        ? `${plan.planDate} is agreed — ${city}`
        : `${plan.planDate} proposed again — ${city}`,
      input.take === "counter"
        ? `${user.name} took your suggestion. Pick the shops when you are ready.`
        : `${user.name} has proposed ${city} instead. Agree, or say why it will not work.`,
    );

    refresh();
    return okVoid(
      input.take === "counter"
        ? `Agreed — ${city}. He picks the shops.`
        : `${city} put back to him.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════════════════════ the holidays */

/**
 * A day nobody is expected to work.
 *
 * Small, and load-bearing in three places: attendance reads as absent for
 * everybody otherwise, leave is measured in working days that nothing else
 * defines, and a journey plan will cheerfully route somebody into a shut
 * market.
 *
 * `scope` is free text — "all beats", "Nagpur East, Nagpur West" — because a
 * holiday is regional in a way the territory model cannot express, and a join
 * table would need maintaining every time a beat is renamed.
 */
export async function addHoliday(input: {
  onDate: string;
  name: string;
  scope?: string | null;
}): Promise<Result> {
  try {
    const user = await requireSales();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.onDate)) {
      return err("That is not a date.", "validation");
    }
    const name = input.name.trim();
    if (!name) {
      return err("Give it a name — a date on its own tells nobody why they are off.", "validation");
    }

    const scope = input.scope?.trim() || null;

    const clash = await db
      .select({ id: mbosHolidays.id, name: mbosHolidays.name })
      .from(mbosHolidays)
      .where(
        and(
          sql`${mbosHolidays.onDate} = ${input.onDate}::date`,
          scope ? eq(mbosHolidays.scope, scope) : sql`${mbosHolidays.scope} is null`,
        ),
      )
      .limit(1);

    if (clash.length) {
      return err(
        `${clash[0].name} is already recorded for that day and scope. Two entries for one day is two answers to whether anybody is working.`,
        "duplicate",
      );
    }

    await db.insert(mbosHolidays).values({
      id: gen("mbos_hol"),
      onDate: input.onDate,
      name,
      scope,
      createdById: user.id,
      updatedById: user.id,
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.holiday.add",
      entityType: "mbos_holiday",
      entityId: input.onDate,
      afterState: { name, scope, onDate: input.onDate } as never,
    });

    refresh();
    return okVoid(`${name} recorded.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/** Taking a day back off the calendar. */
export async function removeHoliday(id: string): Promise<Result> {
  try {
    const user = await requireSales();

    const [row] = await db
      .select()
      .from(mbosHolidays)
      .where(eq(mbosHolidays.id, id))
      .limit(1);
    if (!row) return err("That day is no longer on the calendar.", "not_found");

    await db.delete(mbosHolidays).where(eq(mbosHolidays.id, id));

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.holiday.remove",
      entityType: "mbos_holiday",
      entityId: id,
      beforeState: { name: row.name, onDate: row.onDate, scope: row.scope } as never,
    });

    refresh();
    return okVoid(`${row.name} removed.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════════════ who covers what */

/**
 * Setting a manager's patch.
 *
 * The whole desired picture in one write, the way `setAccess` takes a person's
 * whole access rather than one app at a time: adding and removing a region are
 * the same act — somebody deciding what this manager sees — and doing them
 * separately means two screens neither of which ever shows the answer.
 *
 * **An empty list means national**, and the caller has to mean it. It is the
 * widest scope there is, so it is stated rather than arrived at by unticking
 * the last box without noticing.
 */
export async function setManagerTerritories(input: {
  managerId: string;
  regions: string[];
}): Promise<Result> {
  try {
    const user = await requireSales();

    const [manager] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, input.managerId))
      .limit(1);
    if (!manager) return err("That account is not on MahekOne.", "not_found");

    const wanted = [...new Set(input.regions.map((r) => r.trim()).filter(Boolean))].sort();

    const before = await db
      .select({ region: mbosManagerTerritories.region })
      .from(mbosManagerTerritories)
      .where(eq(mbosManagerTerritories.userId, input.managerId));
    const had = before.map((b) => b.region).sort();

    if (JSON.stringify(had) === JSON.stringify(wanted)) {
      return okVoid("Nothing changed.");
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(mbosManagerTerritories)
        .where(eq(mbosManagerTerritories.userId, input.managerId));
      if (wanted.length) {
        await tx.insert(mbosManagerTerritories).values(
          wanted.map((region) => ({
            id: gen("mt"),
            userId: input.managerId,
            region,
            createdById: user.id,
          })),
        );
      }
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.manager.territories",
      entityType: "user",
      entityId: input.managerId,
      beforeState: { regions: had } as never,
      afterState: { regions: wanted } as never,
    });

    /* Their console changes under them, and nobody likes finding that out by
     * noticing figures have moved. */
    await tell(
      input.managerId,
      wanted.length ? "Your patch has changed" : "You now cover all of India",
      wanted.length
        ? `${user.name} set your regions to ${wanted.join(", ")}. Your console shows those and nothing else.`
        : `${user.name} removed your regional limits. Your console shows the whole country.`,
    );

    refresh();
    return okVoid(
      wanted.length
        ? `${manager.name} now covers ${wanted.join(", ")}.`
        : `${manager.name} now covers all of India.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═════════════════════════════════════════════════════════════ the handsets */

/**
 * Releasing a handset, which is the other half of one-device-per-person.
 *
 * The rule refused a second phone and told the salesman to "ask an admin to
 * release the old one" — and there was nothing anywhere that released one. No
 * screen, no action, no service: `mbos_devices` was written by sign-in and
 * read by this console, and the only way to free somebody was
 * `delete from mbos_devices` against production. A rule whose escape hatch
 * exists only in its own error message is a rule people work around by sharing
 * a login.
 *
 * **Released, not deleted.** `active = false` with the reason and the date is
 * what `checkDeviceBinding` already reads as "this one no longer counts", and
 * `loadPrincipal` already refuses a request from it with `device_released`. So
 * the handset stops syncing on its very next call rather than at token expiry,
 * and the row it leaves behind is the record of which phone that salesman was
 * on until Tuesday. Deleting it would answer the immediate question and
 * destroy the history, which is the trade `mbos_deletions` exists to avoid
 * making anywhere else.
 *
 * **A reason is required by the action and not only by the form.** Somebody
 * reads this months later asking why a salesman was signed out mid-week, and
 * "released" on its own does not answer them.
 */
export async function releaseDevice(input: {
  deviceId: string;
  reason: string;
}): Promise<Result> {
  try {
    const user = await requireSales();

    const reason = input.reason.trim();
    if (reason.length < 3) {
      return err(
        "Say why this handset is being released — somebody reading the row in six months has only this sentence.",
        "validation",
      );
    }

    const [row] = await db
      .select()
      .from(mbosDevices)
      .where(eq(mbosDevices.deviceId, input.deviceId))
      .limit(1);
    if (!row) return err("That handset is not registered to anybody.", "not_found");
    if (!row.active) {
      return err("That handset has already been released.", "validation");
    }

    const [owner] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);

    await db
      .update(mbosDevices)
      .set({
        active: false,
        releasedAt: new Date(),
        releaseReason: reason,
        updatedById: user.id,
        updatedAt: new Date(),
      })
      .where(eq(mbosDevices.id, row.id));

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.device.release",
      entityType: "mbos_device",
      entityId: row.id,
      beforeState: { deviceId: row.deviceId, model: row.model, active: true } as never,
      afterState: { active: false, releaseReason: reason } as never,
    });

    /* The salesman finds out from the handset — it stops syncing on the next
       call — so he is told here as well, with the reason, rather than being
       left to discover it in a market with a phone that has stopped working. */
    await db.insert(notifications).values({
      id: gen("ntf"),
      userId: row.userId,
      kind: "neutral",
      title: "Your handset was released",
      body: `${user.name} released the phone you were signed in on — ${reason}. Sign in again on the handset you are using now.`,
    });

    refresh();
    return okVoid(
      `${owner?.name ?? "That salesman"} can sign in on a new handset now.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ════════════════════════════════════════════════════════════ the settings */

/**
 * The thresholds the handsets read.
 *
 * Written through the same audited store the Admin Console uses, so a change
 * made here carries the same before-and-after row and the same consistency
 * check. Only the `mbos.*` keys may be set from this screen: the sales manager
 * is not being handed the whole of MahekOne's configuration because their app
 * happens to have a settings page.
 */
export async function saveFieldSettings(
  entries: Array<{ key: string; value: unknown }>,
): Promise<Result<{ warnings: string[] }>> {
  try {
    const user = await requireSales();

    const foreign = entries.filter((e) => !e.key.startsWith("mbos."));
    if (foreign.length) {
      return err(
        `${foreign.map((f) => f.key).join(", ")} ${foreign.length === 1 ? "is" : "are"} not a field setting. Those live in the Admin Console.`,
        "not_permitted",
      );
    }

    const result = await updateSettings(entries, user.id);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        code: "validation",
        fieldErrors: result.fields,
      };
    }

    refresh();
    return ok({ warnings: result.warnings }, "Saved. Handsets pick it up on their next sync.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------------ helpers */

/** `09:30` to minutes past midnight, or null where it is not a time. */
function parseClock(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * A wall-clock time on a business date, as an instant.
 *
 * The `+05:30` is written out rather than left to the server's zone. Vercel is
 * UTC and a droplet is whatever it was installed as; a plan built without the
 * offset would put a half-past-nine start at three in the afternoon on the
 * salesman's screen, which is the same mistake `stamp` and `clock` exist to
 * prevent on the way out.
 */
function clockOn(isoDate: string, minutes: number): Date {
  const h = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return new Date(`${isoDate}T${h}:${m}:00+05:30`);
}

/* ------------------------------------------------------- publishing to the field
 *
 * The library and the training centre had tables, a handset screen that read
 * them, and no door between the two — so both were empty because nothing could
 * fill them rather than because nobody had. These are that door.
 *
 * **Publishing is a decision, and withdrawing is the same decision reversed.**
 * Neither deletes: a course somebody has half finished, a policy a salesman
 * quoted to a customer in March, and the record that either was ever published
 * all outlive somebody tidying a screen. `active = false` is what takes it off
 * the handsets, and a tombstone is what tells the handsets it went — a deleted
 * row has no `updated_at` for a delta to notice, so without one a withdrawn
 * price list stays openable on every phone that already had it.
 * ------------------------------------------------------------------------- */

/**
 * The tombstone.
 *
 * `entity` is the HANDSET's own table name, because a pull row is a local row
 * and the delete is applied by name. `userId` null means everybody, which is
 * right for anything published to the field as a whole.
 */
async function tombstone(entity: string, entityId: string, reason: string, userId?: string) {
  await db.insert(mbosDeletions).values({
    id: gen("del"),
    entity,
    entityId,
    userId: userId ?? null,
    reason,
  });
}

const MAX_TITLE = 160;

export async function publishDocument(input: {
  title: string;
  category: DocumentCategory;
  attachmentId?: string | null;
  customerId?: string | null;
  /** Empty means everybody in the field, which is what the handset reads too. */
  visibleToRoles?: string[];
}): Promise<Result<{ id: string }>> {
  try {
    const user = await requireSales();

    const title = input.title.trim();
    if (!title) {
      return err("A document needs a title — it is what the handset lists it by.", "validation", [
        { field: "title", message: "Required." },
      ]);
    }
    if (title.length > MAX_TITLE) {
      return err(`A title is at most ${MAX_TITLE} characters.`, "validation", [
        { field: "title", message: "Too long." },
      ]);
    }

    /* A document with no file is a title, and a title is not something anybody
     * can open. Refused here rather than published empty, because the failure
     * on the handset — a tap that does nothing — says nothing about why. */
    if (!input.attachmentId) {
      return err(
        "Choose the file first. A document with nothing behind it is a row the handset can list and cannot open.",
        "validation",
        [{ field: "file", message: "Required." }],
      );
    }

    const documentId = gen("mdoc");
    await db.insert(mbosDocuments).values({
      id: documentId,
      title,
      category: input.category,
      attachmentId: input.attachmentId,
      customerId: input.customerId ?? null,
      visibleToRoles: input.visibleToRoles ?? [],
      active: true,
      createdById: user.id,
      updatedById: user.id,
    });

    const bound = await bindAttachments([input.attachmentId], "mbos_document", documentId);
    if (!bound.ok || bound.data.bound === 0) {
      /* The row exists and its file does not belong to it, which is the one
       * state that reads as published and opens as nothing. Undo it rather
       * than leave it — nothing has been told about this document yet. */
      await db.delete(mbosDocuments).where(eq(mbosDocuments.id, documentId));
      return err(
        "The file could not be attached, so nothing was published. Try again — a document that lists but will not open is worse than one that is not there.",
        "conflict",
      );
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.document.publish",
      entityType: "mbos_document",
      entityId: documentId,
      afterState: { title, category: input.category } as never,
    });

    refresh();
    return ok(
      { id: documentId },
      `${title} published. Handsets pick it up on their next sync.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Take it back, or put it back.
 *
 * Withdrawing writes the tombstone; republishing does not need one, because the
 * ordinary pull carries a row that exists.
 */
export async function setDocumentPublished(input: {
  documentId: string;
  published: boolean;
}): Promise<Result> {
  try {
    const user = await requireSales();

    const [doc] = await db
      .select({ id: mbosDocuments.id, title: mbosDocuments.title, active: mbosDocuments.active })
      .from(mbosDocuments)
      .where(eq(mbosDocuments.id, input.documentId));
    if (!doc) return err("That document is not here any more.", "not_found");
    if (doc.active === input.published) {
      return ok(undefined, input.published ? "Already published." : "Already withdrawn.");
    }

    await db
      .update(mbosDocuments)
      .set({ active: input.published, updatedById: user.id, updatedAt: new Date() })
      .where(eq(mbosDocuments.id, input.documentId));

    if (!input.published) {
      await tombstone("documents", input.documentId, "withdrawn");
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: input.published ? "mbos.document.publish" : "mbos.document.withdraw",
      entityType: "mbos_document",
      entityId: input.documentId,
      beforeState: { active: doc.active } as never,
      afterState: { active: input.published } as never,
    });

    refresh();
    return ok(
      undefined,
      input.published
        ? `${doc.title} is published again.`
        : `${doc.title} withdrawn. It comes off every handset on its next sync.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* --------------------------------------------------------------- the courses */

export async function publishCourse(input: {
  title: string;
  category?: string | null;
  durationMinutes?: number | null;
  attachmentId?: string | null;
  passMarkPercent?: number | null;
  mandatory: boolean;
  dueDate?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const user = await requireSales();

    const title = input.title.trim();
    if (!title) {
      return err("A course needs a title.", "validation", [
        { field: "title", message: "Required." },
      ]);
    }

    /* A deadline on something nobody has to do is a date with no consequence,
     * and it would be drawn on the handset as though it had one. */
    if (input.dueDate && !input.mandatory) {
      return err(
        "A deadline only means something on a compulsory course. Either make it compulsory or leave the date empty.",
        "validation",
        [{ field: "dueDate", message: "Needs a compulsory course." }],
      );
    }
    if (
      input.passMarkPercent != null &&
      (input.passMarkPercent < 1 || input.passMarkPercent > 100)
    ) {
      return err("A pass mark is a percentage between 1 and 100.", "validation", [
        { field: "passMarkPercent", message: "1 to 100." },
      ]);
    }

    const courseId = gen("mcrs");
    await db.insert(mbosCourses).values({
      id: courseId,
      title,
      category: input.category?.trim() || null,
      durationMinutes: input.durationMinutes ?? null,
      attachmentId: input.attachmentId ?? null,
      passMarkPercent: input.passMarkPercent ?? null,
      mandatory: input.mandatory,
      dueDate: input.dueDate || null,
      active: true,
      createdById: user.id,
      updatedById: user.id,
    });

    /* Unlike a document, a course may legitimately have no file: a briefing
     * somebody delivers in a meeting is still a course to record and to tick
     * off. What it may not have is a file that belongs to something else. */
    if (input.attachmentId) {
      await bindAttachments([input.attachmentId], "mbos_course", courseId);
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.course.publish",
      entityType: "mbos_course",
      entityId: courseId,
      afterState: { title, mandatory: input.mandatory } as never,
    });

    refresh();
    return ok(
      { id: courseId },
      input.mandatory
        ? `${title} published as compulsory. Everybody in the field sees it on their next sync.`
        : `${title} published.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

export async function setCoursePublished(input: {
  courseId: string;
  published: boolean;
}): Promise<Result> {
  try {
    const user = await requireSales();

    const [course] = await db
      .select({ id: mbosCourses.id, title: mbosCourses.title, active: mbosCourses.active })
      .from(mbosCourses)
      .where(eq(mbosCourses.id, input.courseId));
    if (!course) return err("That course is not here any more.", "not_found");
    if (course.active === input.published) {
      return ok(undefined, input.published ? "Already published." : "Already withdrawn.");
    }

    await db
      .update(mbosCourses)
      .set({ active: input.published, updatedById: user.id, updatedAt: new Date() })
      .where(eq(mbosCourses.id, input.courseId));

    if (!input.published) {
      /* The course goes; the progress against it stays. Somebody finished it,
       * and withdrawing the material does not unfinish it. */
      await tombstone("courses", input.courseId, "withdrawn");
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: input.published ? "mbos.course.publish" : "mbos.course.withdraw",
      entityType: "mbos_course",
      entityId: input.courseId,
      beforeState: { active: course.active } as never,
      afterState: { active: input.published } as never,
    });

    refresh();
    return ok(
      undefined,
      input.published
        ? `${course.title} is published again.`
        : `${course.title} withdrawn. Anybody part-way through keeps their record of it.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Store one file, unparented, and hand back its id.
 *
 * §4 — an attachment is created before its parent exists, so the publish form
 * uploads as soon as the file is chosen and binds when it saves. An abandoned
 * form leaves an orphan, which the nightly sweep is for.
 */
export async function uploadPublishFile(form: FormData): Promise<Result<{ id: string; filename: string }>> {
  try {
    await requireSales();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return err("No file arrived.", "validation");
    }
    const created = await createAttachment({
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredType: file.type,
    });
    if (!created.ok) return created;
    return ok({ id: created.data.id, filename: file.name });
  } catch (e) {
    return fromThrown(e);
  }
}
