"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  attachments,
  auditLog,
  customers,
  mbosApprovals,
  mbosCourses,
  mbosDeletions,
  mbosDocuments,
  mbosExpenses,
  mbosHolidays,
  mbosHolidayAssignments,
  mbosLeaveRequests,
  mbosUserTerritories,
  mbosJourneyPlans,
  mbosJourneyStops,
  mbosTaskCampaigns,
  mbosTasks,
  mbosTravelLegs,
  mbosVisits,
  users,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import {
  assertCustomerInScope,
  isPlatformAdmin,
  levelInApp,
  requireCapability,
} from "@/lib/access-control";
import { salesGateRefusal, scopeCovers } from "@/lib/sales-gate";
import { inCrmSalesManagerWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { getConfig, updateSettings } from "@/lib/config/store";
import { bindAttachments } from "@/lib/services/attachment-service";
import { APP_TIMEZONE } from "@/lib/business-date";
import {
  LEAD_BULK_CAP,
  leadIdsMatching,
  leadsInScope,
  leadsPage,
  fieldTeam,
  managerScope,
  onlyMine,
} from "@/lib/services/sales-service";
import type { LeadFilters } from "@/lib/lead-filters";
import { salesTypeLabel } from "@/lib/lead-labels";
import { leadOwed, owedWord } from "@/lib/lead-owed";
import type { LeadView } from "@/lib/lead-views";
import { today } from "@/lib/recompute";
import type { DocumentCategory } from "@/lib/mbos/library-labels";
import { err, fromThrown, ok, okVoid, type Result } from "@/lib/result";
import { releaseHandsetBinding } from "@/lib/services/handset-release";
import {
  PARENT_KIND,
  setWorkingTerritories,
  territoriesFor,
  territoryClause,
  TERRITORY_KINDS,
  type Territory,
  type TerritoryKind,
} from "@/lib/services/territory-service";
import { bookIdsIgnoringTerritory } from "@/lib/services/mbos-service";
import { repriceDay, rescoreLeg } from "@/lib/services/expense-submit-service";
import { notifyUsers } from "../notify";
import { announce } from "@/lib/services/announcement-service";
import { mirrorToHrms, removeEverywhere } from "@/lib/services/holiday-calendar";
import {
  previewAudience,
  rebuildHolidayMembers,
  searchPlaces,
  syncHolidayToHrms,
  type HolidayPlace,
} from "@/lib/services/holiday-service";
import { HOLIDAY_CATEGORIES, isHolidayLevel, placeKindFor } from "@/lib/engines/holiday-audience";
import { holidayAppliesSql } from "@/lib/holiday-sql";
import {
  placeNames,
  searchShopsForTask,
  shopsForTarget,
  taskPlaceOptions,
  type AudienceShopRow,
} from "@/lib/services/task-campaign-service";
import type { PlaceFilterOptions, PlaceFilterValues } from "@/lib/place-filters";
import {
  expandTaskAudience,
  MAX_TASKS_PER_ASSIGNMENT,
  taskAudienceProblem,
  taskAudienceSentence,
  type TaskAudience,
} from "@/lib/task-audience";
import {
  formHasLinks,
  linkedTaskComplete,
  MAX_TASK_FIELDS,
  MAX_TASK_OPTIONS,
  TASK_FIELD_TYPES,
  TASK_LINK_TARGET_KEYS,
  taskFormProblems,
  tidyTaskForm,
  type TaskField,
  type TaskLinkTarget,
} from "@/lib/task-form";
import { linkContexts } from "@/lib/services/task-link-service";
import { taskCampaign } from "@/lib/services/task-campaign-service";
import {
  draftTask,
  suggestLinks,
  summariseCampaign,
  type LinkSuggestion,
  type TaskDraft,
  type TaskSummary,
} from "@/lib/services/task-ai-service";

/** Count, noun and verb agree at every value. */
function plural(n: number, noun: string, pl?: string): string {
  return `${n} ${n === 1 ? noun : (pl ?? `${noun}s`)}`;
}

/* ---------------------------------------------------------------------------
 * Every write the Sales Dashboard makes.
 *
 * **Holding the app USED to be the permission**, and it is not any more. The
 * grant is asked first, then — for a decision — the LEVEL held on that grant,
 * then the module the act belongs to; see `requireSalesAccess`. The grant
 * alone let an associate given the app to read the team's day decide
 * anything on it, and let a module withheld on the Access screen stay
 * writable by URL. Where a write lands on a PERSON or a LEAD it is also asked
 * whether that person or lead is in the caller's own scope — the same
 * narrowing the screen ran — because the lists were narrowed and the writes
 * behind them were not. All of it is checked in the action and not merely by
 * the layout, because a server action is a URL.
 *
 * **One decision this app deliberately does NOT make.** An `order` approval is
 * accounts', by an explicit rule in AGENTS.md: the person chasing the target
 * must not sign off the orders that hit it. Those rows are shown here — a
 * manager needs to know one of their people is stuck — and the decision is
 * refused with a sentence saying where it lives. Everything else about a
 * salesman's day is this screen's.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

/**
 * The Sales Dashboard's lead door (`requireSalesAccess` on the lead modules),
 * or — inside the CRM Sales Manager workspace only — the module that
 * workspace answers to.
 *
 * Reassigning a lead is a Sales Manager action, and the CRM's Sales Manager
 * holds `crm.sales-manager`, not the Sales Dashboard.
 */
async function requireSalesOrCrmSalesManager() {
  if (!(await inCrmSalesManagerWorkspace())) return requireSalesAccess({ modules: LEAD_MODULES });
  const user = await requireUser();
  if (!(await canOpenModule(user.id, "crm.sales-manager"))) {
    throw Object.assign(new Error("The CRM Sales Manager workspace has not been granted to you."), {
      name: "NotPermittedError",
    });
  }
  return user;
}

/* ---------------------------------------------------------------------------
 * THE GRANT IS NOT THE WHOLE PERMISSION, and these are the rest of it.
 *
 * The grant answers "were you given the Sales Dashboard", and for most of
 * this file's life that was the only question asked. It is the wrong one for a
 * decision: an associate given the app to read the team's day could approve
 * leave, release a handset, redraw a manager's patch or publish a document to
 * every phone in the field. And the MODULE was asked by the layout alone —
 * unticking Holidays took the screen away and left the action that writes a
 * holiday one POST away for anybody holding the app.
 *
 * `requireSalesAccess` asks all three: the grant, the LEVEL in the Sales
 * Dashboard where the act is a decision (`levelInApp`, the level ON THE GRANT,
 * never the widest one held anywhere), and the module the act belongs to. The
 * rule itself is `salesGateRefusal` in `sales-gate.ts`, pure and tested; this
 * is where it is wired to the session.
 *
 * WHAT IS A DECISION: answering a request, territory, handsets, holidays, leave
 * entitlements, publishing to the field, tasks, journeys, lead batches,
 * verdicts on visits and evidence, and messages to the field. What is NOT:
 * reading, and the single-lead moves whose own scope check already limits an
 * associate to the leads in their own book.
 * ------------------------------------------------------------------------- */

type SalesGate = {
  /** Any ONE of these opens it. Empty asks no module — for a check that has
      to read the record before it knows which screen the record belongs to. */
  modules: readonly string[];
  /** A manager or administrator of the Sales Dashboard. */
  manager?: boolean;
};

function notPermitted(message: string) {
  return Object.assign(new Error(message), { name: "NotPermittedError" });
}

async function requireSalesAccess(gate: SalesGate) {
  const user = await requireUser();
  const [level, platformAdmin, held] = await Promise.all([
    levelInApp(user, "sales"),
    isPlatformAdmin(user),
    Promise.all(gate.modules.map((k) => canOpenModule(user.id, k))),
  ]);
  const refusal = salesGateRefusal({
    level,
    platformAdmin,
    needManager: gate.manager === true,
    modulesAsked: gate.modules,
    modulesHeld: gate.modules.filter((_, i) => held[i]),
  });
  if (refusal) throw notPermitted(refusal);
  return user;
}

/** Shorthand for the commonest shape: a manager's act on one screen. */
const SALES_MANAGER = (...modules: string[]): SalesGate => ({ modules, manager: true });

/**
 * IS THIS PERSON IN MY TEAM — asked of the person a write lands on.
 *
 * The lists are narrowed by `managerScope` and the writes behind them were
 * not: a regional manager could plan a route for, set the leave of, or move the
 * patch of a salesman in another region by posting his id, because nothing
 * between the screen and the table asked whether he was theirs. It is the same
 * narrowing the screen ran, read through `scopeCovers` so the CRM Sales
 * Manager seat's null is never taken for "everybody".
 */
async function salesmanOutsideScope(salesmanId: string): Promise<boolean> {
  return !scopeCovers(await managerScope(), salesmanId);
}

const NOT_YOUR_TEAM = "That person is not in your team, so this is not yours to change.";

/**
 * ONE LEAD, ASKED THE QUESTION A BATCH ALREADY ASKS.
 *
 * The bulk actions read their ids through `leadsInScope` — "WHAT MAY BE TOUCHED
 * IS ASKED OF THE DATABASE, never taken from the payload" — and the single-lead
 * versions beside them asked nothing at all, so a regional manager could
 * archive, restore, chase or reassign any lead in the company one id at a time.
 * Same narrowing, one id.
 */
async function leadOutsideScope(leadId: string): Promise<boolean> {
  return (await leadsInScope([leadId])).length === 0;
}

/** The screens a lead is worked from — either one opens a lead action. */
const LEAD_MODULES = ["sales.leads", "sales.lead-pipeline"] as const;

function refresh() {
  try {
    revalidatePath("/crm/leads/sales-manager", "layout");
    revalidatePath("/sales");
    revalidatePath("/sales/approvals");
    revalidatePath("/sales/journeys");
    revalidatePath("/sales/holidays");
    revalidatePath("/sales/people");
    revalidatePath("/sales/documents");
    revalidatePath("/sales/knowledge");
    revalidatePath("/sales/tasks");
    revalidatePath("/sales/leads");
    revalidatePath("/sales/notify");
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
async function tell(userId: string, title: string, body: string, mbosHref: string | null) {
  /* The row and the push are one act, and `notifyUsers` is where that act
     lives now — this function used to do its own device lookup, which is
     exactly the copy fourteen other callers never made.

     WHERE A TAP LANDS IS THE CALLER'S TO SAY. This used to hard-code
     `/rejections` for every caller, so "a task was assigned to you" and "your
     route for Tuesday" both opened the handset's list of records the office
     REFUSED — a screen that by construction cannot contain either. Null is the
     honest default and falls through to `/notifications`. */
  await notifyUsers([{ userId, title, body, mbosHref }]).catch(() => {});
}

/** The handset screen an approval's decision is about. */
function approvalHref(type: string): string | null {
  switch (type) {
    case "leave":
      return "/leave";
    case "expense_claim":
      return "/expenses";
    case "sample":
      return "/samples";
    case "order":
      return "/orders";
    case "tour":
      return "/journeys";
    case "attendance_regularisation":
      return "/attendance";
    default:
      return null;
  }
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
    /* A manager's act, before anything is read: an associate is not told
       whether the id exists. The screen is asked once the type is known. */
    const user = await requireSalesAccess({ modules: [], manager: true });

    const [approval] = await db
      .select()
      .from(mbosApprovals)
      .where(eq(mbosApprovals.id, input.approvalId))
      .limit(1);

    if (!approval) return err("That request no longer exists.", "not_found");

    /*
     * THREE KINDS HAVE A DESK OF THEIR OWN, and answering them here skipped it.
     *
     * A sample, a distributor appointment and a priced expense day each carry
     * rules this generic answer knows nothing about — the sample machine and
     * its `sample.approve`, the two-step chain whose second step is
     * management's `distributor.approve`, and the expense day's partial
     * amounts and escalations under `order.approve`. Deciding one here wrote
     * `approved` on the row and went round every one of those rules, so the
     * cheapest door to each was this one. Refused, with the way to the right
     * door, rather than decided badly.
     */
    if (approval.type === "sample") {
      return err(
        "A sample is decided on the samples desk, where the approval checks the stock and the lead — Lead Management → Samples & trials.",
        "not_permitted",
      );
    }
    if (approval.type === "distributor_appointment") {
      return err(
        "Appointing a distributor is a two-step decision with its own screen — Lead Management → Distributor appointments.",
        "not_permitted",
      );
    }
    if (approval.subjectType === "mbos_expense_days") {
      return err(
        "A day's expenses are priced and decided on Expenses & claims, where the policy and the part amounts are.",
        "not_permitted",
      );
    }

    /* The screen this kind belongs to, or the Approvals queue that collects
       them all. Withholding Leave from somebody must also withhold deciding it. */
    const owning: Record<string, string> = {
      leave: "sales.leave",
      expense_claim: "sales.expenses",
      tour: "sales.expenses",
      attendance_regularisation: "sales.attendance",
      territory: "sales.territory",
    };
    await requireSalesAccess({
      modules: owning[approval.type] ? ["sales.approvals", owning[approval.type]] : ["sales.approvals"],
      manager: true,
    });

    /* NOBODY ANSWERS THEIR OWN REQUEST. A manager who also carries a handset
       raises leave and expenses like anybody else, and the queue he decides is
       the one his own requests land in. */
    if (approval.requestedByUserId === user.id) {
      return err(
        "This is your own request. Somebody else has to answer it — that is what makes it an approval.",
        "not_permitted",
      );
    }

    /* And only for their own team, the same narrowing `pendingApprovals` ran
       to draw the row. A queue is a screen and a screen is not a permission. */
    if (await salesmanOutsideScope(approval.requestedByUserId)) {
      return err("That request is from somebody outside your team.", "not_permitted");
    }

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

    /* A request the person took back is not a request.
     *
     * Withdrawing marks `cancelled_at` on the leave and leaves the approval
     * `pending`, so it sat in this queue looking like work — and approving it
     * debited the balance and told the salesman his leave was approved, for
     * days he had already said he no longer wanted. The queue filters these out
     * now; this is the same rule where it actually binds, because a queue is a
     * screen and a screen is not a permission. */
    if (approval.type === "leave") {
      const [subject] = await db
        .select({ cancelledAt: mbosLeaveRequests.cancelledAt })
        .from(mbosLeaveRequests)
        .where(eq(mbosLeaveRequests.id, approval.subjectId))
        .limit(1);

      if (subject?.cancelledAt) {
        return err(
          "This leave was withdrawn by the person who asked for it, so there is nothing to decide. It has already left their calendar.",
          "conflict",
        );
      }
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

    /* Nothing debits a balance here, and that is the fix rather than an
     * omission.
     *
     * This used to increment `mbos_leave_balances.used_days` — creating the row
     * at ZERO days entitled if it was missing, which it always was, so a
     * person's first approved leave gave them a balance reading "-2 of 0 left".
     * Nothing decremented it either: a decision reversed, or leave withdrawn
     * after it was granted, left the figure permanently short with no way to
     * notice and no way to rebuild it.
     *
     * What somebody has spent is DERIVED from the approved requests now, in
     * `leaveBalances` — the same shape as outstanding and the buying cycle, and
     * for the same reason. `mbos_leave_balances` is the entitlement OVERRIDE
     * table now: a row means this person is on different terms, deliberately.
     * `used_days` is no longer read or written by anything. */

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
      approvalHref(approval.type),
    );

    refresh();
    return okVoid(`Answered — ${approval.type.replace(/_/g, " ")} ${words}.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════════════ one expense */

/**
 * Whether this viewer may decide expenses — read by the Expenses screen to draw
 * the buttons. The SAME gate `decideApproval` applies when the button is
 * pressed, so a control is never drawn for somebody the action would refuse.
 */
export async function canDecideExpenseLines(): Promise<boolean> {
  try {
    await requireSalesAccess({ modules: ["sales.approvals", "sales.expenses"], manager: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Answer one expense a salesman logged.
 *
 * Every expense is its own decision now, from the moment he logs it — there is
 * no day to close and nothing waits for one. This finds the expense's own
 * approval and answers it through `decideApproval`, so the gate, the team
 * scope, "nobody answers their own", the reason a refusal needs, the audit row
 * and the message to the salesman are all the ones every other request gets.
 *
 * Two things are added because they are about MONEY:
 *  - A part approval has to be LESS than he logged and more than nothing. At
 *    or above the amount it is a yes, and is recorded as one.
 *  - An expense whose approval has not reached the office yet — the handset
 *    sends it as its own record right behind the expense — gets one here, so a
 *    manager looking at the expense is never told there is nothing to decide.
 *
 * An allowance is never decided: it is his by the work log, and is refused here.
 */
export async function decideExpense(input: {
  expenseId: string;
  decision: ApprovalDecision;
  note?: string;
  approvedAmountPaise?: number;
}): Promise<Result> {
  try {
    await requireSalesAccess({ modules: ["sales.approvals", "sales.expenses"], manager: true });

    const [line] = await db
      .select({
        id: mbosExpenses.id,
        userId: mbosExpenses.userId,
        amountPaise: mbosExpenses.amountPaise,
        sourceType: mbosExpenses.sourceType,
        remarks: mbosExpenses.remarks,
      })
      .from(mbosExpenses)
      .where(eq(mbosExpenses.id, input.expenseId))
      .limit(1);
    if (!line) return err("That expense no longer exists.", "not_found");
    if (line.sourceType === "travel_leg" || line.sourceType === "expense_day") {
      return err(
        "This is an allowance, worked out from his punch times and trips. There is nothing to approve — it is his by the work log.",
        "conflict",
      );
    }

    let decision = input.decision;
    if (decision === "partially_approved") {
      const amount = input.approvedAmountPaise ?? 0;
      if (!Number.isInteger(amount) || amount <= 0) {
        return err("Say how much you are allowing. It has to be more than ₹0.", "validation");
      }
      if (amount >= Number(line.amountPaise)) decision = "approved";
    }

    const [existing] = await db
      .select({ id: mbosApprovals.id, state: mbosApprovals.state })
      .from(mbosApprovals)
      .where(and(eq(mbosApprovals.subjectType, "expense"), eq(mbosApprovals.subjectId, line.id)))
      .orderBy(sql`${mbosApprovals.stepIndex} desc, ${mbosApprovals.requestedAt} desc`)
      .limit(1);

    let approvalId = existing?.id ?? null;
    if (!approvalId) {
      approvalId = gen("mbappr");
      await db
        .insert(mbosApprovals)
        .values({
          id: approvalId,
          type: "expense_claim",
          requestedByUserId: line.userId,
          subjectType: "expense",
          subjectId: line.id,
          reason: line.remarks ?? null,
          createdById: line.userId,
          updatedById: line.userId,
        })
        .onConflictDoNothing();
    }

    const out = await decideApproval({
      approvalId,
      decision,
      note: input.note,
      approvedAmountPaise: decision === "partially_approved" ? input.approvedAmountPaise : undefined,
    });
    try {
      revalidatePath("/sales/expenses");
    } catch {
      /* no request context */
    }
    return out;
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
  /**
   * The city the office chose before picking the shops. Saved onto the day so
   * every screen, the handset included, says where it is — a day arranged with
   * no city read "No city named" above shops plainly in one town. Absent leaves
   * whatever city the day already carries.
   */
  city?: string | null;
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
    const user = await requireSalesAccess(SALES_MANAGER("sales.journeys"));
    if (await salesmanOutsideScope(input.salesmanId)) return err(NOT_YOUR_TEAM, "not_permitted");

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
          const gone = await tx
            .delete(mbosJourneyStops)
            .where(eq(mbosJourneyStops.planId, existing.id))
            .returning({ id: mbosJourneyStops.id });
          await tombstoneStops(tx, gone, input.salesmanId);
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
              ...(day.city?.trim() ? { city: day.city.trim() } : {}),
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
            city: day.city?.trim() || null,
            status: "active",
            estimatedTravelMinutes: perStop * Math.max(0, day.customerIds.length - 1),
            createdById: user.id,
            updatedById: user.id,
          });
        }

        const replaced = await tx
          .delete(mbosJourneyStops)
          .where(
            and(
              eq(mbosJourneyStops.planId, planId),
              sql`${mbosJourneyStops.status} = 'planned'`,
            ),
          )
          .returning({ id: mbosJourneyStops.id });
        await tombstoneStops(tx, replaced, input.salesmanId);

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
      "/journey",
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
    const user = await requireSalesAccess(SALES_MANAGER("sales.journeys"));
    if (await salesmanOutsideScope(input.salesmanId)) return err(NOT_YOUR_TEAM, "not_permitted");

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
        "/journey",
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
    const user = await requireSalesAccess(SALES_MANAGER("sales.journeys"));

    const [plan] = await db
      .select()
      .from(mbosJourneyPlans)
      .where(eq(mbosJourneyPlans.id, input.planId))
      .limit(1);
    if (!plan) return err("That day is no longer on the plan.", "not_found");
    if (await salesmanOutsideScope(plan.userId)) return err(NOT_YOUR_TEAM, "not_permitted");
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
      "/journey",
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
 * A day nobody is expected to work — or nobody in one state, one district,
 * one city, one area, or a few named people (`lib/engines/holiday-audience.ts`
 * says who).
 *
 * Load-bearing in more places than it looks: attendance reads as absent
 * otherwise, leave is measured in working days, a journey plan will route
 * somebody into a shut market — and the handset reads all of it through the
 * pull, so a holiday saved here is on the salesman's phone at its next sync
 * without anybody updating the app.
 *
 * The places are PICKED from the reviewed tree rather than typed, which is
 * what lets a state holiday reach exactly the people allocated that state.
 */
export type HolidayInput = {
  id?: string | null;
  onDate: string;
  name: string;
  category: string;
  level: string;
  placeIds: string[];
  /** Given the day whatever the place says. */
  include: string[];
  /** Not given it whatever the place says. */
  exclude: string[];
  note?: string | null;
  /** Ring the bell on the phones of the people it reaches (default on). */
  notify?: boolean;
};

export async function saveHoliday(input: HolidayInput): Promise<Result<{ id: string; reaches: number }>> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.holidays"));

    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.onDate)) return err("That is not a date.", "validation");
    const name = input.name.trim();
    if (!name) return err("Give it a name — a date on its own tells nobody why they are off.", "validation");
    if (name.length > 120) return err("Keep the name under 120 characters.", "validation");
    if (!isHolidayLevel(input.level)) return err("Say who the holiday is for.", "validation");
    const level = input.level;
    const category = (HOLIDAY_CATEGORIES as readonly string[]).includes(input.category) ? input.category : "Festival";
    const include = [...new Set(input.include)];
    const exclude = [...new Set(input.exclude)].filter((id) => !include.includes(id));
    const note = input.note?.trim() || null;

    const kind = placeKindFor(level);
    let placeIds: string[] = [];
    if (kind) {
      placeIds = [...new Set(input.placeIds)];
      if (!placeIds.length) return err(`Pick at least one ${kind} — a ${kind} holiday has to say which.`, "validation");
      const found = await db.execute<{ id: string }>(sql`
        select id from places where kind = ${kind}
           and id in (${sql.join(placeIds.map((id) => sql`${id}`), sql`, `)})
      `);
      if (found.length !== placeIds.length)
        return err(`One of those is not a ${kind} on the place tree any more. Pick again.`, "validation");
    }
    if (level === "people" && !include.length)
      return err("Name at least one person — a holiday for named people with nobody named is nobody's.", "validation");

    const people = [...include, ...exclude];
    if (people.length) {
      const known = await db.execute<{ id: string }>(sql`
        select id from users where id in (${sql.join(people.map((id) => sql`${id}`), sql`, `)})
      `);
      if (known.length !== people.length) return err("One of the people named is not on MahekOne.", "validation");
    }

    const [clash] = (await db.execute<{ id: string; name: string }>(sql`
      select id, name from mbos_holidays
       where on_date = ${input.onDate}::date and lower(name) = lower(${name})
         and id <> ${input.id ?? ""}
       limit 1
    `)) as unknown as { id: string; name: string }[];
    if (clash)
      return err(`${clash.name} is already on the calendar for that day. Edit that one instead — two entries are two answers to who is off.`, "duplicate");

    let before: Record<string, unknown> | null = null;
    if (input.id) {
      const [row] = await db.select().from(mbosHolidays).where(eq(mbosHolidays.id, input.id)).limit(1);
      if (!row) return err("That day is no longer on the calendar.", "not_found");
      before = { name: row.name, onDate: row.onDate, level: row.level, placeIds: row.placeIds, category: row.category };
    }

    /* Who it reaches BEFORE the write, so only people newly given the day are told. */
    const reachedBefore = input.id
      ? new Set(
          ((await db.execute<{ id: string }>(sql`
            select u.id from users u join app_access a on a.user_id = u.id and a.app = 'field'
             where exists (select 1 from mbos_holidays h where h.id = ${input.id}
                             and h.on_date = ${input.onDate}::date
                             and ${holidayAppliesSql("h", sql`u.id`)})
          `)) as unknown as { id: string }[]).map((r) => r.id),
        )
      : new Set<string>();

    const holidayId = input.id ?? gen("mbos_hol");
    await db.transaction(async (tx) => {
      if (input.id) {
        await tx
          .update(mbosHolidays)
          .set({ onDate: input.onDate, name, category, level, placeIds, note, updatedById: user.id, updatedAt: new Date() })
          .where(eq(mbosHolidays.id, holidayId));
      } else {
        await tx.insert(mbosHolidays).values({
          id: holidayId,
          onDate: input.onDate,
          name,
          category,
          level,
          placeIds,
          note,
          createdById: user.id,
          updatedById: user.id,
        });
        /* One calendar: the day goes on HRMS's too, under the same id. Who it
           is for there is kept current by the rebuild below. */
        await mirrorToHrms(tx, { id: holidayId, onDate: input.onDate, name, scope: level === "company" ? null : "Sales Dashboard" }, user);
      }
      await tx.delete(mbosHolidayAssignments).where(eq(mbosHolidayAssignments.holidayId, holidayId));
      for (const [mode, ids] of [["include", include], ["exclude", exclude]] as const)
        for (const userId of ids)
          await tx.insert(mbosHolidayAssignments).values({ id: gen("hola"), holidayId, userId, mode, createdById: user.id });
    });

    await rebuildHolidayMembers();
    await syncHolidayToHrms(holidayId);

    const reaches = (await db.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from users u join app_access a on a.user_id = u.id and a.app = 'field'
       where u.active and exists (select 1 from mbos_holidays h where h.id = ${holidayId}
                                    and ${holidayAppliesSql("h", sql`u.id`)})
    `)) as unknown as { id: string; name: string }[];

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: input.id ? "mbos.holiday.edit" : "mbos.holiday.add",
      entityType: "mbos_holiday",
      entityId: holidayId,
      beforeState: before as never,
      afterState: { name, onDate: input.onDate, level, category, placeIds, include, exclude, reaches: reaches.length } as never,
    });

    const day = await today();
    if (input.notify !== false && input.onDate >= day) {
      const newly = reaches.filter((r) => !reachedBefore.has(r.id));
      await notifyUsers(
        newly.map((r) => ({
          userId: r.id,
          title: `Holiday: ${name}`,
          body: `${shortDay(input.onDate)} is a holiday for you${note ? ` — ${note}` : ""}. No punch-in is expected that day.`,
          kind: "info" as const,
          href: null,
          mbosHref: null,
        })),
      );
    }

    refresh();
    return ok(
      { id: holidayId, reaches: reaches.length },
      `${name} ${input.id ? "saved" : "recorded"} — it reaches ${reaches.length} ${reaches.length === 1 ? "person" : "people"} in the field.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** Kept for anything still posting the old three-field form: a company-wide day. */
export async function addHoliday(input: { onDate: string; name: string; scope?: string | null }): Promise<Result> {
  const r = await saveHoliday({ onDate: input.onDate, name: input.name, category: "Festival", level: "company", placeIds: [], include: [], exclude: [], note: input.scope ?? null });
  return r.ok ? okVoid(r.message) : r;
}

/**
 * ONE PERSON, ONE HOLIDAY: allocate it to him, take it from him, or put him
 * back on whatever the holiday's level says. The By-employee view's switch.
 */
export async function setHolidayPerson(input: {
  holidayId: string;
  userId: string;
  mode: "include" | "exclude" | "clear";
  reason?: string | null;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.holidays"));
    const [h] = await db.select().from(mbosHolidays).where(eq(mbosHolidays.id, input.holidayId)).limit(1);
    if (!h) return err("That day is no longer on the calendar.", "not_found");
    const [person] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!person) return err("That account is not on MahekOne.", "not_found");
    const reason = input.reason?.trim() || null;
    if (input.mode === "exclude" && !reason)
      return err(`Say why ${person.name} is not getting ${h.name} — he will ask, and so will whoever reads his attendance.`, "validation");

    await db.transaction(async (tx) => {
      await tx
        .delete(mbosHolidayAssignments)
        .where(and(eq(mbosHolidayAssignments.holidayId, h.id), eq(mbosHolidayAssignments.userId, person.id)));
      if (input.mode !== "clear")
        await tx.insert(mbosHolidayAssignments).values({ id: gen("hola"), holidayId: h.id, userId: person.id, mode: input.mode, reason, createdById: user.id });
      /* The phone hears it on the next pull even where the rebuild finds the
         member set unchanged — a company-wide exclude lists nobody there. */
      await tx.update(mbosHolidays).set({ updatedAt: new Date(), updatedById: user.id }).where(eq(mbosHolidays.id, h.id));
    });
    await rebuildHolidayMembers();
    await syncHolidayToHrms(h.id);

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: input.mode === "include" ? "mbos.holiday.allocate" : input.mode === "exclude" ? "mbos.holiday.deallocate" : "mbos.holiday.reset",
      entityType: "mbos_holiday",
      entityId: h.id,
      afterState: { name: h.name, onDate: h.onDate, person: person.name, personId: person.id, reason } as never,
    });

    if (h.onDate >= (await today()) && input.mode !== "clear")
      await notifyUsers([
        {
          userId: person.id,
          title: input.mode === "include" ? `Holiday: ${h.name}` : `${h.name} is a working day for you`,
          body:
            input.mode === "include"
              ? `${shortDay(h.onDate)} is a holiday for you${reason ? ` — ${reason}` : ""}.`
              : `${shortDay(h.onDate)} is not a holiday for you: ${reason}. Punch in as usual.`,
          kind: input.mode === "include" ? "info" : "warn",
          href: null,
          mbosHref: null,
        },
      ]);

    refresh();
    return okVoid(
      input.mode === "include"
        ? `${h.name} given to ${person.name}.`
        : input.mode === "exclude"
          ? `${h.name} taken from ${person.name}.`
          : `${person.name} is back on the usual rule for ${h.name}.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** Who a holiday would reach, for the dialog — before anything is saved. */
export async function previewHolidayAudience(input: {
  level: string;
  placeIds: string[];
  include: string[];
  exclude: string[];
}): Promise<Result<{ id: string; name: string; reasons: string[] }[]>> {
  try {
    await requireSalesAccess(SALES_MANAGER("sales.holidays"));
    if (!isHolidayLevel(input.level)) return ok([]);
    const team = (await fieldTeam()).map((p) => p.id);
    return ok(await previewAudience({ level: input.level, placeIds: input.placeIds, include: input.include, exclude: input.exclude }, team));
  } catch (e) {
    return fromThrown(e);
  }
}

/** Places of one kind for the picker, searched on the server — the tree is thousands. */
export async function searchHolidayPlaces(kind: string, query: string): Promise<Result<HolidayPlace[]>> {
  try {
    await requireSalesAccess(SALES_MANAGER("sales.holidays"));
    if (!["state", "district", "city", "area"].includes(kind)) return ok([]);
    return ok(await searchPlaces(kind, query));
  } catch (e) {
    return fromThrown(e);
  }
}

function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** Taking a day back off the calendar. */
export async function removeHoliday(id: string): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.holidays"));

    const [row] = await db
      .select()
      .from(mbosHolidays)
      .where(eq(mbosHolidays.id, id))
      .limit(1);
    if (!row) return err("That day is no longer on the calendar.", "not_found");

    /* Reference data, gone — from HRMS's calendar as well, and tombstoned:
       without one the deleted row simply has no `updated_at` for the delta to
       notice, and every phone that already pulled it keeps treating that date
       as a day off for good. */
    await db.transaction((tx) => removeEverywhere(tx, id));

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

/* ═══════════════════════════════════════════════════ telling the field */

/**
 * A notification the office writes by hand, rather than one the system
 * derives.
 *
 * Everything else in `notifications` is produced by an event — an approval
 * decided, a request answered — with `tell()` above as the one place that
 * happens. This is the exception, and deliberately narrow: a manager saying
 * something to their own team, or the whole field, that nothing in the
 * system already says on its own. It rides the same channel and the same
 * push a decision does, because a salesman's phone should not have to learn
 * two different things mean the same kind of ping.
 */
export async function sendFieldNotification(input: {
  audience: "all" | "ids";
  userIds?: string[];
  title: string;
  body: string;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.notify"));

    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) return err("Give it a title — that is what shows first.", "validation");
    if (!body) return err("Say what you actually mean. A title alone is a notification about nothing.", "validation");

    const scope = await managerScope();
    const targets =
      input.audience === "ids"
        ? await (async () => {
            const ids = (input.userIds ?? []).filter(Boolean);
            if (!ids.length) return [];
            const rows = await db
              .select({ id: users.id })
              .from(users)
              .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "field")))
              .where(and(inArray(users.id, ids), eq(users.active, true)));
            /* Picked people are narrowed exactly as "everybody" is. The picker
               offered only this manager's team, and a POST naming somebody
               else's salesman must not reach his phone with this manager's
               name on it. */
            return rows.map((r) => r.id).filter((id) => scopeCovers(scope, id));
          })()
        : await (async () => {
            const mine = (col: string) => onlyMine(scope, col);
            const rows = await db.execute<{ id: string }>(sql`
              select u.id
                from users u
                join app_access a on a.user_id = u.id and a.app = 'field'
               where u.active ${mine("u.id")}
            `);
            return rows.map((r) => r.id);
          })();

    if (!targets.length) {
      return err(
        input.audience === "ids"
          ? "Nobody was picked, or none of them hold the field app anymore."
          : "There is nobody in your team holding the field app to send this to.",
        "validation",
      );
    }

    /* The same sender HRMS's Announcements uses, so the message is on record
       beside the office's, with exactly who it went to, and the bell is its
       only read state (lib/services/announcement-service.ts). */
    const { id: announcementId } = await announce({
      senderUserId: user.id,
      fromName: user.name,
      toLabel: input.audience === "all" ? "The field team" : plural(targets.length, "person in the field team", "people in the field team"),
      title,
      text: body,
      recipients: targets,
      source: "sales",
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.notification.send",
      entityType: "notification_broadcast",
      entityId: announcementId,
      afterState: { title, body, audience: input.audience, recipientCount: targets.length } as never,
    });

    refresh();
    return okVoid(`Sent to ${plural(targets.length, "person", "people")}.`);
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
/**
 * Where a salesman WORKS — the cities and beats his book narrows to.
 *
 * A different act from `setManagerTerritories` below, and deliberately its own
 * action rather than a mode of it. That one sets a manager's oversight patch,
 * which decides which SALESMEN a console shows; this narrows which CUSTOMERS a
 * handset shows. One function behind one capability doing two jobs is how the
 * more generous answer ends up applying to both.
 *
 * `people.manage` rather than a new capability: deciding where somebody works
 * is the same kind of act as deciding who they report to, and it is already the
 * gate on this screen.
 */
/**
 * THE SHOPS THAT LEAVE HIS HANDSET when where he works changes.
 *
 * A pull says what exists and only a tombstone says what stopped, so without
 * this a salesman moved from Maharashtra to Gujarat keeps every Maharashtra
 * shop on the phone for ever — and walks to one of them, and nothing anywhere
 * looks wrong.
 *
 * Read as a DIFFERENCE over his own book rather than over `customers`: the
 * whole table would tombstone thousands of shops that were never on the phone,
 * and the deletions channel is a queue somebody else's withdrawn product is
 * also waiting in.
 *
 * THE EMPTY BEFORE IS THE DEPLOY, and it is the case worth spelling out. Under
 * the rule this replaced, nowhere allocated meant the WHOLE book — so a phone
 * that synced before the change holds shops that `territoryClause([])` now says
 * it never had. Diffing against an empty before would tombstone nothing and
 * leave every one of them there, which is precisely the handset the change
 * exists to clear. So an empty before is read as "everything he can see".
 */
async function shopsLeavingTheBook(
  userId: string,
  wanted: Territory[],
): Promise<string[]> {
  const book = await bookIdsIgnoringTerritory(userId);
  if (!book.length) return [];

  const had = (await territoriesFor(userId)).filter((t) => t.kind !== "region");
  const ids = (clause: SQL) =>
    db
      .select({ id: customers.id })
      .from(customers)
      .where(and(inArray(customers.id, book), clause))
      .then((rows) => rows.map((r) => r.id));

  const before = had.length ? await ids(territoryClause(had)) : book;
  if (!before.length) return [];

  const after = new Set(wanted.length ? await ids(territoryClause(wanted)) : []);
  return before.filter((id) => !after.has(id));
}

export async function setSalesmanTerritories(input: {
  salesmanId: string;
  territories: { kind: string; value: string; parent?: string }[];
}): Promise<Result<void>> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.people", "sales.territory"));
    /* His book is redrawn by this, so he has to be somebody this manager
       oversees — the same narrowing the Salesmen list ran to offer him. */
    if (await salesmanOutsideScope(input.salesmanId)) return err(NOT_YOUR_TEAM, "not_permitted");

    const [person] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, input.salesmanId))
      .limit(1);
    if (!person) return err("That account is not on MahekOne.", "not_found");

    /* Only the kinds this screen owns. A `region` arriving here would clear a
       manager's patch as a side effect of allocating a salesman a city — see
       `setWorkingTerritories`, which refuses them for the same reason. */
    const asked = input.territories
      .filter((t) => t.kind !== "region" && t.value.trim())
      .map((t) => ({
        kind: t.kind as TerritoryKind,
        value: t.value.trim(),
        parent: t.parent?.trim() ?? "",
      }));

    const bad = asked.filter(
      (t) => !(TERRITORY_KINDS as readonly string[]).includes(t.kind),
    );
    if (bad.length) {
      return err(`Not a kind of place: ${bad.map((b) => b.kind).join(", ")}.`, "validation");
    }

    /*
     * A CITY WITHOUT ITS STATE IS NOT AN ALLOCATION, and the action says so
     * rather than trusting the dialog to have asked in the right order. A
     * server action is a URL: the screen that nests these is not the only
     * thing that can post to it, and a bare "Pune" is genuinely ambiguous —
     * there is an Aurangabad in Maharashtra and another in Bihar.
     */
    const orphan = asked.filter((t) => PARENT_KIND[t.kind] && !t.parent);
    if (orphan.length) {
      return err(
        `Pick the ${PARENT_KIND[orphan[0].kind]} first — ${orphan
          .map((o) => o.value)
          .join(", ")} needs to sit inside one.`,
        "validation",
      );
    }

    /*
     * THE NARROWEST PICK IN A BRANCH IS THE ALLOCATION, and the wider ones
     * above it are the path to it rather than a second grant.
     *
     * Maharashtra plus Pune inside it has to mean Pune. Stored as both, the
     * clause would OR them and hand him the whole state — the opposite of what
     * somebody who took the trouble to pick a city meant, and invisible on
     * every screen afterwards because "Maharashtra, Pune" reads like a
     * narrowing. So a state with cities under it is dropped, and a city with
     * beats under it is dropped, and what is stored is the leaves.
     */
    const parents = new Set(asked.map((t) => t.parent).filter(Boolean));
    const wanted = asked.filter((t) => !parents.has(t.value));

    const before = await territoriesFor(input.salesmanId);
    const key = (t: { kind: string; value: string; parent?: string }) =>
      `${t.kind}:${(t.parent ?? "").toLowerCase()}:${t.value.toLowerCase()}`;
    const had = before.filter((t) => t.kind !== "region").map(key).sort();
    const now = wanted.map(key).sort();
    if (JSON.stringify(had) === JSON.stringify(now)) return okVoid("Nothing changed.");

    /* The shops that leave his book, read BEFORE the change — afterwards they
       are simply not his and there is nothing left to name. See `tombstone`:
       a pull says what exists, and only a tombstone says what stopped, so
       without this the shops he no longer works stay on the phone for ever. */
    const leaving = await shopsLeavingTheBook(input.salesmanId, wanted);

    await setWorkingTerritories(input.salesmanId, wanted, user.id);

    for (const id of leaving) {
      await tombstone("customers", id, "territory", input.salesmanId);
    }

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.salesman.territories",
      entityType: "user",
      entityId: input.salesmanId,
      beforeState: { territories: had } as never,
      afterState: { territories: now } as never,
    });

    /*
     * His book changes under him, and a book that shrinks silently reads as a
     * broken sync — which is the report the office gets rather than a question
     * about territory.
     */
    await tell(
      input.salesmanId,
      wanted.length ? "Where you work has changed" : "Your handset has no area set",
      wanted.length
        ? `Your handset now shows your customers in ${wanted.map((t) => t.value).join(", ")}. Everything else is still yours — it is just not on this list.`
        : "No area is set for you, so your customer list will be empty until the office sets one. Nothing of yours is lost.",
      "/customers",
    );

    revalidatePath("/sales/people");
    return okVoid(
      wanted.length
        ? `${person.name} works ${wanted.map((t) => t.value).join(", ")}.`
        : `${person.name} has no area set, so their handset shows no customers at all.`,
    );
  } catch (e) {
    return err(
      e instanceof Error ? e.message : "That could not be saved.",
      "validation",
    );
  }
}

export async function setManagerTerritories(input: {
  managerId: string;
  regions: string[];
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.people", "sales.territory"));

    /*
     * NOBODY DRAWS THEIR OWN PATCH. An empty list here means national, so a
     * regional manager allowed to edit his own row could make himself national
     * in one click — every salesman's trail and photographs — and the
     * notification about it would be addressed to himself.
     */
    if (input.managerId === user.id) {
      return err(
        "These are your own regions. Somebody else has to set them — an empty list here is the whole country.",
        "not_permitted",
      );
    }

    /*
     * AND ONLY A NATIONAL MANAGER DRAWS ANYBODY'S. A regional manager setting
     * somebody else's regions could hand them a region he does not cover
     * himself, or — with an empty list — the whole country, which is wider
     * than anything he holds. Allocating oversight is the act of somebody
     * who already oversees everything; a platform administrator is national
     * by construction, so this asks one question for both.
     */
    if (!(await managerScope()).national) {
      return err(
        "Regions are allocated by a manager who covers the whole country. Yours is a regional patch, so this is not yours to change.",
        "not_permitted",
      );
    }

    const [manager] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, input.managerId))
      .limit(1);
    if (!manager) return err("That account is not on MahekOne.", "not_found");

    const wanted = [...new Set(input.regions.map((r) => r.trim()).filter(Boolean))].sort();

    /* REGIONS ONLY. This action sets a manager's oversight patch, and the
       table now also holds a salesman's working cities — deleting by user id
       alone would wipe those as a side effect of editing a region. */
    const before = await db
      .select({ region: mbosUserTerritories.region })
      .from(mbosUserTerritories)
      .where(
        and(
          eq(mbosUserTerritories.userId, input.managerId),
          eq(mbosUserTerritories.kind, "region"),
        ),
      );
    const had = before.map((b) => b.region).sort();

    if (JSON.stringify(had) === JSON.stringify(wanted)) {
      return okVoid("Nothing changed.");
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(mbosUserTerritories)
        .where(
          and(
            eq(mbosUserTerritories.userId, input.managerId),
            eq(mbosUserTerritories.kind, "region"),
          ),
        );
      if (wanted.length) {
        await tx.insert(mbosUserTerritories).values(
          wanted.map((region) => ({
            id: gen("mt"),
            userId: input.managerId,
            kind: "region",
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
      null,
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
    const user = await requireSalesAccess(SALES_MANAGER("sales.people", "sales.logins"));
    /* Releasing signs somebody out mid-day, so it is for their own manager. */
    const result = await releaseHandsetBinding({
      actor: user,
      deviceId: input.deviceId,
      reason: input.reason,
      outsideScope: salesmanOutsideScope,
      refusedOutsideScope: NOT_YOUR_TEAM,
    });
    if (result.ok) refresh();
    return result;
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════════════════════════ the leads */

/**
 * Every write the Leads screen makes.
 *
 * A lead has one owner, `assignedToUserId`, and none of the third-seat or
 * sales-AM machinery a customer carries — it has never ordered, so there is
 * no book to protect from a conflict of interest, only a prospect somebody is
 * or is not working. Reassigning it is therefore this app's own call, checked
 * the same way as everything else here: holding the Sales Dashboard.
 */

/**
 * ONE LEAD, so this reads `customers`.
 *
 * `lead_stage is not null` rather than `kind = 'lead'`: a won lead is a
 * customer row now, and a manager must still be able to archive or reassign
 * one after it converted — filtering on the kind would make the row vanish
 * from every action at the moment it succeeded.
 */
async function requireLead(leadId: string) {
  const [lead] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, leadId), isNotNull(customers.leadStage)))
    .limit(1);
  return lead ?? null;
}

/** A lead's name, for a message somebody reads on a phone. */
function leadLabel(lead: { name: string; companyName: string | null }) {
  return lead.companyName ? `${lead.name} (${lead.companyName})` : lead.name;
}

/**
 * Moving a lead to somebody else.
 *
 * Both sides are told, the same rule a customer's account manager change
 * follows: work has landed on the new owner's list without them asking for
 * it, and the person who lost it would otherwise find out by noticing it is
 * gone. `salesmanId` has to hold the `field` app — a lead assigned to
 * somebody with no handset is a lead nobody will ever see again.
 */
export async function reassignLead(input: {
  leadId: string;
  salesmanId: string;
}): Promise<Result> {
  try {
    const user = await requireSalesOrCrmSalesManager();

    const lead = await requireLead(input.leadId);
    if (!lead) return err("That lead is no longer here.", "not_found");
    /* In the CRM Sales Manager workspace the lead has to be in THEIR book, the
       same rule the list that offered it was drawn from. Elsewhere this is a
       no-op here and the Sales Dashboard's own checks stand. */
    if (await inCrmSalesManagerWorkspace()) {
      await assertCustomerInScope({
        kind: lead.kind,
        ownerId: lead.ownerId,
        salesAmId: lead.salesAmId,
        salesManagerId: lead.salesManagerId,
      });
    } else if (await leadOutsideScope(input.leadId)) {
      /* Everywhere else, the narrowing `bulkReassignLeads` already runs on
         every id it is handed — see `leadOutsideScope`. Answered as missing,
         the same words the batch uses, so an id outside the book says nothing
         about whether it exists. */
      return err("That lead is no longer here, or not yours to change.", "not_found");
    }
    if (lead.leadArchived) {
      return err(
        "That lead is archived. Restore it before moving it to somebody else.",
        "validation",
      );
    }
    if (lead.ownerId === input.salesmanId) {
      return ok(undefined, "Already theirs.");
    }

    const [salesman] = await db
      .select({ id: users.id, name: users.name, active: users.active })
      .from(users)
      .innerJoin(
        appAccess,
        and(eq(appAccess.userId, users.id), eq(appAccess.app, "field")),
      )
      .where(eq(users.id, input.salesmanId))
      .limit(1);
    if (!salesman) {
      return err(
        "That person does not hold the Salesman App, so a lead cannot be put on their handset.",
        "validation",
      );
    }
    if (!salesman.active) {
      return err(`${salesman.name}'s account is closed.`, "validation");
    }

    const [previousOwner] = lead.ownerId
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, lead.ownerId))
          .limit(1)
      : [];

    /* The owner IS the assignment — `ASSIGNED_TO_SQL` resolves a lead through
     * `owner_id`, so one write puts it on the salesman's handset and in the
     * office's scoped lists at the same time. */
    await db
      .update(customers)
      .set({ ownerId: input.salesmanId, updatedAt: new Date() })
      .where(eq(customers.id, input.leadId));

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.lead.reassign",
      entityType: "mbos_lead",
      entityId: input.leadId,
      beforeState: { assignedToUserId: lead.ownerId ?? null } as never,
      afterState: { assignedToUserId: input.salesmanId } as never,
    });

    await tell(
      input.salesmanId,
      `${leadLabel(lead)} is now yours`,
      `${user.name} assigned you this lead${lead.city ? ` in ${lead.city}` : ""}. It is on your handset at the next sync.`,
      `/lead?id=${encodeURIComponent(input.leadId)}`,
    );
    if (previousOwner) {
      await tell(
        previousOwner.id,
        `${leadLabel(lead)} was moved`,
        `${user.name} reassigned it to ${salesman.name}.`,
        null,
      );
    }

    refresh();
    return okVoid(`${leadLabel(lead)} reassigned to ${salesman.name}.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Nudging whoever owns a lead, without waiting for the next 1:1.
 *
 * This is a message, not a decision — nothing on the lead changes, so there
 * is nothing to make a partial-vs-whole distinction over and no audit
 * before/after worth recording beyond the fact that it was sent.
 */
/**
 * EVERY ROW THE FILTERS MATCH, for the spreadsheet — asked for when the button
 * is pressed rather than carried down with the page.
 *
 * The table is ten rows now, and `ExportButton`'s own note says the rows are
 * built on the server so what leaves in the file is what was on the screen.
 * Both halves of that are still true and they no longer mean the same thing:
 * a page is not the list. Exporting what the page holds would hand somebody a
 * ten-row file from a list of 3,776 — the version of this bug that looks like
 * a successful export — and shipping all 3,776 down with every page load to
 * keep the button honest is the waste pagination was added to stop.
 *
 * So the whole filtered set is fetched on the click, which is also the only
 * moment anybody wants it. It reads `leadsPage` with a page size of the total,
 * so the file and the table are the same query with the same scope, the same
 * filters and the same order.
 */
export async function exportLeadRows(input: {
  archived?: boolean;
  filters?: LeadFilters;
  /* §8.4 — WHICH VIEW THE BUTTON WAS PRESSED IN. A file downloaded from
     Overdue that quietly held the whole book is worse than no export: it is
     the capped-list mistake in reverse, and the person who sends it on has no
     way of knowing. The name is resolved server-side by `leadsPage`. */
  view?: LeadView;
}): Promise<Result<{ rows: Array<Array<string | number>> }>> {
  try {
    await requireSalesAccess({ modules: LEAD_MODULES });
    /* A whole filtered book leaving the building in a file is `customer.export`,
       which the matrix keeps at the manager level for exactly this. */
    await requireCapability("customer.export");
    const day = await today();
    const first = await leadsPage(day, {
      archived: input.archived,
      filters: input.filters,
      view: input.view,
      page: 1,
      perPage: 1,
    });
    const all = await leadsPage(day, {
      archived: input.archived,
      filters: input.filters,
      view: input.view,
      page: 1,
      // The cap is `leadsPage`'s own, so a book that outgrows it is cut in one
      // place rather than two — and the count beside the button is the total,
      // so a truncated file is visible rather than silent.
      perPage: Math.max(first.total, 1),
    });

    /* Rupees from paise, the way this file has always written them — and blank
       rather than a nought where there is no figure at all, because a column of
       zeroes in a spreadsheet reads as "nothing expected" on exactly the rows
       where the honest answer is that nobody has asked. */
    const rupees = (paise: number | null) =>
      Number(paise) ? Math.round(Number(paise) / 100) : "";

    return ok({
      rows: [
        [
          "Lead",
          "Company",
          "City",
          "Owner",
          "Source",
          "Sales type",
          "Stage",
          "Wants",
          "Monthly requirement (litres)",
          "Potential (₹)",
          "Expected order (₹)",
          "Expected order (cans)",
          "Expected order by",
          /* Two columns for one cell, because the screen's Next column is a
             date with the promise it came from named underneath it, and a
             spreadsheet row has nowhere to put a second line. */
          "Next due",
          "What that day is",
          "Age (days)",
          "Notes",
        ],
        ...all.rows.map((l) => {
          /*
           * THE SAME DAY THE SCREEN DREW, from the same function.
           *
           * This column used to be `nextFollowUpDate` alone — the salesman's
           * own diary — while the list has moved to the EARLIEST of three:
           * §24's next action, that diary, and a park read back while the lead
           * is still parked. So a manager who filtered to Overdue and exported
           * it got a file whose dates disagreed with the screen they had just
           * been reading. Its header named the column it read, so it was not
           * lying — and an export is what somebody takes into a meeting, where
           * a date that differs from the one they filtered on is worse than no
           * date at all.
           */
          const owed = leadOwed(l, day);
          return [
            l.name,
            l.companyName ?? "",
            l.city ?? "",
            l.salesmanName ?? "Nobody",
            l.source.replace(/_/g, " "),
            salesTypeLabel(l.salesType),
            l.stage,
            /* The SKU somebody resolved at qualification, not the free-text
               requirement: the requirement describes a job rather than a can,
               and the record is where a sentence belongs. */
            l.requiredProductName ?? "",
            /* LITRES on a lead, and CANS three columns along on a commitment.
               There is no SKU at capture, so nothing converts between them and
               nothing here adds them up — each column names its own unit. */
            l.monthlyVolumeLitres ?? "",
            rupees(l.estimatedPotentialPaise),
            rupees(l.expectedOrderValuePaise),
            l.expectedOrderCans ?? "",
            l.expectedOrderDate ?? "",
            owed?.date ?? "",
            owed ? owedWord(owed) : "",
            l.ageDays,
            l.notes ?? "",
          ];
        }),
      ],
    });
  } catch (e) {
    return fromThrown(e);
  }
}

export async function chaseLeadOwner(input: {
  leadId: string;
  note?: string;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess({ modules: LEAD_MODULES });

    const lead = await requireLead(input.leadId);
    if (!lead) return err("That lead is no longer here.", "not_found");
    if (await leadOutsideScope(input.leadId)) {
      return err("That lead is no longer here, or not yours to change.", "not_found");
    }
    if (lead.leadArchived) {
      return err("That lead is archived, so there is nobody actively working it.", "validation");
    }
    if (!lead.ownerId) {
      return err("Nobody is working this lead yet — reassign it first.", "validation");
    }

    const note = input.note?.trim();
    await tell(
      lead.ownerId,
      `Chase — ${leadLabel(lead)}`,
      note || `${user.name} asked you to follow up on ${leadLabel(lead)}.`,
      `/lead?id=${encodeURIComponent(lead.id)}`,
    );

    refresh();
    return okVoid(`Nudged. It reaches their handset on the next sync.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Filing a lead out of the way.
 *
 * A manual override of what the nightly sweep does on its own, so it is
 * reversible the same way: `archived` is a flag, never a delete, and
 * {@link restoreLead} is the way back. A reason IS required, per the design's
 * own `askReason(...)` on this exact action — the owner's copy of this lead
 * is about to stop being chased, and a manager who cannot say why in a
 * sentence is usually acting on a hunch rather than a decision.
 */
export async function archiveLead(input: { leadId: string; reason: string }): Promise<Result> {
  try {
    const user = await requireSalesAccess({ modules: LEAD_MODULES });

    const reason = input.reason.trim();
    if (!reason) {
      return err("Say why — this is what a manager reads later.", "validation");
    }

    const lead = await requireLead(input.leadId);
    if (!lead) return err("That lead is no longer here.", "not_found");
    if (await leadOutsideScope(input.leadId)) {
      return err("That lead is no longer here, or not yours to change.", "not_found");
    }
    if (lead.leadArchived) return ok(undefined, "Already archived.");

    await db
      .update(customers)
      .set({ leadArchived: true, leadArchivedAt: new Date(), updatedAt: new Date() })
      .where(eq(customers.id, input.leadId));

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.lead.archive",
      entityType: "mbos_lead",
      entityId: input.leadId,
      beforeState: { archived: false } as never,
      afterState: { archived: true, reason } as never,
    });

    /* A lead vanishing off the working list with no explanation is exactly
     * the failure this whole app is built to avoid — the owner is told why,
     * not just that it happened. */
    if (lead.ownerId) {
      await tell(
        lead.ownerId,
        `${leadLabel(lead)} was archived`,
        `${user.name} filed it away — ${reason}`,
        null,
      );
    }

    refresh();
    return okVoid(`${leadLabel(lead)} archived.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/** The way back. */
export async function restoreLead(input: { leadId: string }): Promise<Result> {
  try {
    const user = await requireSalesAccess({ modules: LEAD_MODULES });

    const lead = await requireLead(input.leadId);
    if (!lead) return err("That lead is no longer here.", "not_found");
    if (await leadOutsideScope(input.leadId)) {
      return err("That lead is no longer here, or not yours to change.", "not_found");
    }
    if (!lead.leadArchived) return ok(undefined, "Not archived.");

    await db
      .update(customers)
      .set({ leadArchived: false, leadArchivedAt: null, updatedAt: new Date() })
      .where(eq(customers.id, input.leadId));

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.lead.restore",
      entityType: "mbos_lead",
      entityId: input.leadId,
      beforeState: { archived: true } as never,
      afterState: { archived: false } as never,
    });

    refresh();
    return okVoid(`${leadLabel(lead)} restored.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ────────────────────────────────────────────── the same four, in a batch */

/**
 * WHY BULK IS ITS OWN SET OF ACTIONS RATHER THAN A LOOP IN THE SCREEN.
 *
 * A browser looping a server action once per row is a hundred round trips, a
 * hundred audit writes, a hundred revalidations and a hundred notifications —
 * and, worse, a partial result nobody can read: the toast says "done" while
 * eleven of them failed silently somewhere in the middle. These do the
 * permission check and the lookups ONCE, write in one statement where the
 * write is one statement, and answer with what actually happened to each —
 * how many moved, and the ones that did not, named, with the reason.
 *
 * Notifications are grouped PER PERSON and never per lead, the rule a customer
 * reassignment already follows: a salesman handed forty leads gets one message
 * saying forty, not forty messages.
 *
 * WHAT MAY BE TOUCHED IS ASKED OF THE DATABASE, never taken from the payload.
 * The grant answers "do you hold the Sales Dashboard", which every
 * regional manager does — it is not the same question as "may you move this
 * lead". `leadsInScope` runs `leadsVisible`, the same narrowing the list that
 * offered the selection ran, so a batch can only reach what the screen could
 * show. Ids outside it are simply absent, and every caller reports them rather
 * than succeeding quietly.
 */

/** Every bulk answer has the same shape, so every screen reads it the same way. */
export type BulkOutcome = {
  done: number;
  /**
   * Named AND identified — the name is what a manager reads, the id is what
   * keeps exactly the refused leads ticked afterwards. A batch that clears the
   * selection on a partial success leaves somebody to find the eleven refused
   * leads again by hand, which is the work the batch was supposed to save.
   */
  failed: Array<{ id: string; name: string; why: string }>;
};

type ScopedLead = Awaited<ReturnType<typeof leadsInScope>>[number];

/** The ids a batch will act on: de-duplicated, capped, and nothing else. */
function bulkIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean))).slice(0, LEAD_BULK_CAP);
}

/**
 * Read them once, and say plainly which ids answered nothing.
 *
 * An id that is not a lead, has been deleted, or belongs to a book this person
 * cannot see all come back the same way — unreachable, and deliberately not
 * told apart. Distinguishing them here would answer "does this id exist" to
 * somebody who may not look at it.
 */
async function bulkLeads(
  ids: string[],
): Promise<{ leads: ScopedLead[]; missing: BulkOutcome["failed"] }> {
  const wanted = bulkIds(ids);
  if (!wanted.length) return { leads: [], missing: [] };
  const leads = await leadsInScope(wanted);
  const found = new Set(leads.map((l) => l.id));
  return {
    leads,
    missing: wanted
      .filter((id) => !found.has(id))
      .map((id) => ({ id, name: "A lead", why: "no longer here, or not yours to change" })),
  };
}

function bulkMessage(outcome: BulkOutcome, verb: string): string {
  if (!outcome.failed.length) return `${plural(outcome.done, "lead")} ${verb}.`;
  const named = outcome.failed
    .slice(0, 3)
    .map((f) => `${f.name} — ${f.why}`)
    .join("; ");
  const more = outcome.failed.length > 3 ? ` and ${outcome.failed.length - 3} more` : "";
  return `${plural(outcome.done, "lead")} ${verb}. ${plural(outcome.failed.length, "was", "were")} not: ${named}${more}`;
}

/**
 * The ids behind "select all NNN matching", capped at what a batch accepts.
 *
 * A read wearing an action's clothes, which is worth naming because everything
 * else in this file writes. It is here rather than in the service because the
 * screen is a client component and cannot call a `server-only` module, and the
 * selection it feeds is what the four writes below take — so the cap is theirs
 * rather than a number chosen here.
 */
export async function leadIdsForSelection(input: {
  archived?: boolean;
  filters?: LeadFilters;
  /* The view is part of what the screen is showing, so "Select everything"
     has to mean everything on THIS list. Without it the count on the button
     and the set the button selects are two different numbers, and the one
     people trust is the one on the button. */
  view?: LeadView;
}): Promise<Result<{ ids: string[]; capped: boolean }>> {
  try {
    await requireSalesAccess({ modules: LEAD_MODULES });
    const day = await today();
    return ok(
      await leadIdsMatching(day, {
        archived: input.archived,
        filters: input.filters,
        view: input.view,
      }),
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Moving a selection of leads to one salesman.
 *
 * The same rules {@link reassignLead} keeps — the new owner must hold the
 * handset, an archived lead is refused rather than quietly moved, and both
 * sides are told — asked once for the person and once per lead for the lead.
 */
export async function bulkReassignLeads(input: {
  leadIds: string[];
  salesmanId: string;
}): Promise<Result<BulkOutcome>> {
  try {
    const user = await requireSalesAccess({ modules: LEAD_MODULES, manager: true });

    const [salesman] = await db
      .select({ id: users.id, name: users.name, active: users.active })
      .from(users)
      .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "field")))
      .where(eq(users.id, input.salesmanId))
      .limit(1);
    if (!salesman) {
      return err(
        "That person does not hold the Salesman App, so leads cannot be put on their handset.",
        "validation",
      );
    }
    if (!salesman.active) return err(`${salesman.name}'s account is closed.`, "validation");

    const { leads, missing } = await bulkLeads(input.leadIds);
    if (!leads.length && !missing.length) return err("Nothing selected.", "validation");

    const failed = [...missing];
    const moving = leads.filter((l) => {
      if (l.leadArchived) {
        failed.push({ id: l.id, name: leadLabel(l), why: "archived — restore it first" });
        return false;
      }
      if (l.ownerId === input.salesmanId) {
        failed.push({ id: l.id, name: leadLabel(l), why: "already theirs" });
        return false;
      }
      return true;
    });

    if (moving.length) {
      await db
        .update(customers)
        .set({ ownerId: input.salesmanId, updatedAt: new Date() })
        .where(inArray(customers.id, moving.map((l) => l.id)));

      await db.insert(auditLog).values(
        moving.map((l) => ({
          id: gen("aud"),
          actorId: user.id,
          action: "mbos.lead.reassign",
          entityType: "mbos_lead",
          entityId: l.id,
          beforeState: { assignedToUserId: l.ownerId ?? null } as never,
          afterState: { assignedToUserId: input.salesmanId } as never,
        })),
      );

      await tell(
        input.salesmanId,
        `${plural(moving.length, "lead")} ${moving.length === 1 ? "is" : "are"} now yours`,
        `${user.name} assigned them to you. They are on your handset at the next sync.`,
        "/leads",
      );

      /* One message per person who lost work, not one per lead. */
      const lost = new Map<string, number>();
      for (const l of moving) {
        if (l.ownerId) lost.set(l.ownerId, (lost.get(l.ownerId) ?? 0) + 1);
      }
      for (const [ownerId, n] of lost) {
        await tell(
          ownerId,
          `${plural(n, "lead")} moved`,
          `${user.name} reassigned ${n === 1 ? "it" : "them"} to ${salesman.name}.`,
          null,
        );
      }
    }

    refresh();
    const outcome = { done: moving.length, failed };
    return ok(outcome, bulkMessage(outcome, `moved to ${salesman.name}`));
  } catch (e) {
    return fromThrown(e);
  }
}

/** Filing a selection away, with the one reason that covers all of them. */
export async function bulkArchiveLeads(input: {
  leadIds: string[];
  reason: string;
}): Promise<Result<BulkOutcome>> {
  try {
    const user = await requireSalesAccess({ modules: LEAD_MODULES, manager: true });

    const reason = input.reason.trim();
    if (!reason) return err("Say why — this is what a manager reads later.", "validation");

    const { leads, missing } = await bulkLeads(input.leadIds);
    if (!leads.length && !missing.length) return err("Nothing selected.", "validation");

    const failed = [...missing];
    const filing = leads.filter((l) => {
      if (l.leadArchived) {
        failed.push({ id: l.id, name: leadLabel(l), why: "already archived" });
        return false;
      }
      return true;
    });

    if (filing.length) {
      await db
        .update(customers)
        .set({ leadArchived: true, leadArchivedAt: new Date(), updatedAt: new Date() })
        .where(inArray(customers.id, filing.map((l) => l.id)));

      await db.insert(auditLog).values(
        filing.map((l) => ({
          id: gen("aud"),
          actorId: user.id,
          action: "mbos.lead.archive",
          entityType: "mbos_lead",
          entityId: l.id,
          beforeState: { archived: false } as never,
          afterState: { archived: true, reason } as never,
        })),
      );

      /* A lead vanishing off a working list with no explanation is the failure
         this whole app is built to avoid, so the owner gets the sentence and
         not just the fact. */
      const byOwner = new Map<string, number>();
      for (const l of filing) {
        if (l.ownerId) byOwner.set(l.ownerId, (byOwner.get(l.ownerId) ?? 0) + 1);
      }
      for (const [ownerId, n] of byOwner) {
        await tell(
          ownerId,
          `${plural(n, "lead")} archived`,
          `${user.name} filed ${n === 1 ? "it" : "them"} away — ${reason}`,
          null,
        );
      }
    }

    refresh();
    const outcome = { done: filing.length, failed };
    return ok(outcome, bulkMessage(outcome, "archived"));
  } catch (e) {
    return fromThrown(e);
  }
}

/** And the way back for a selection. */
export async function bulkRestoreLeads(input: {
  leadIds: string[];
}): Promise<Result<BulkOutcome>> {
  try {
    const user = await requireSalesAccess({ modules: LEAD_MODULES, manager: true });

    const { leads, missing } = await bulkLeads(input.leadIds);
    if (!leads.length && !missing.length) return err("Nothing selected.", "validation");

    const failed = [...missing];
    const restoring = leads.filter((l) => {
      if (!l.leadArchived) {
        failed.push({ id: l.id, name: leadLabel(l), why: "was not archived" });
        return false;
      }
      return true;
    });

    if (restoring.length) {
      await db
        .update(customers)
        .set({ leadArchived: false, leadArchivedAt: null, updatedAt: new Date() })
        .where(inArray(customers.id, restoring.map((l) => l.id)));

      await db.insert(auditLog).values(
        restoring.map((l) => ({
          id: gen("aud"),
          actorId: user.id,
          action: "mbos.lead.restore",
          entityType: "mbos_lead",
          entityId: l.id,
          beforeState: { archived: true } as never,
          afterState: { archived: false } as never,
        })),
      );
    }

    refresh();
    const outcome = { done: restoring.length, failed };
    return ok(outcome, bulkMessage(outcome, "restored"));
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Nudging everybody who owns something in the selection.
 *
 * One message per owner naming how many, for the reason at the top of this
 * section: forty separate nudges is a notification list somebody stops
 * reading, which defeats the only thing a chase is for.
 */
export async function bulkChaseLeadOwners(input: {
  leadIds: string[];
  note?: string;
}): Promise<Result<BulkOutcome>> {
  try {
    const user = await requireSalesAccess({ modules: LEAD_MODULES, manager: true });

    const { leads, missing } = await bulkLeads(input.leadIds);
    if (!leads.length && !missing.length) return err("Nothing selected.", "validation");

    const failed = [...missing];
    const byOwner = new Map<string, ScopedLead[]>();
    for (const l of leads) {
      if (l.leadArchived) {
        failed.push({ id: l.id, name: leadLabel(l), why: "archived — nobody is working it" });
        continue;
      }
      if (!l.ownerId) {
        failed.push({ id: l.id, name: leadLabel(l), why: "nobody owns it — reassign it first" });
        continue;
      }
      const held = byOwner.get(l.ownerId) ?? [];
      held.push(l);
      byOwner.set(l.ownerId, held);
    }

    const note = input.note?.trim();
    let done = 0;
    for (const [ownerId, held] of byOwner) {
      const names = held.slice(0, 5).map(leadLabel).join(", ");
      const more = held.length > 5 ? ` and ${held.length - 5} more` : "";
      await tell(
        ownerId,
        `Chase — ${plural(held.length, "lead")}`,
        note || `${user.name} asked you to follow up on ${names}${more}.`,
        "/leads",
      );
      done += held.length;
    }

    refresh();
    const outcome = { done, failed };
    return ok(outcome, bulkMessage(outcome, "chased"));
  } catch (e) {
    return fromThrown(e);
  }
}

/* ══════════════════════════════════════════════════════════════ the visits */

/**
 * A manager standing behind a visit the phone could not verify.
 *
 * Nothing about the visit's own record changes except this — the check-in
 * fix, the distance, the reason it read as a mismatch are all left exactly as
 * the handset reported them, because that is the honest account of what the
 * phone measured. `verified` only ever meant "the phone could confirm this
 * from where it was standing," never "this visit is real" — a wrong shop pin
 * or a poor fix says nothing about whether the salesman was there, and a
 * manager who knows better is allowed to say so.
 */
export async function acceptVisit(input: { visitId: string }): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.journeys"));

    const [visit] = await db
      .select({
        id: mbosVisits.id,
        verified: mbosVisits.verified,
        salesmanId: mbosVisits.salesmanId,
      })
      .from(mbosVisits)
      .where(eq(mbosVisits.id, input.visitId))
      .limit(1);
    if (!visit) return err("That visit is no longer here.", "not_found");
    /* Standing behind a visit is a verdict on somebody's day, so it is never
       one's own day and always one's own team's. */
    if (visit.salesmanId === user.id) {
      return err("That is your own visit. Somebody else has to accept it.", "not_permitted");
    }
    if (await salesmanOutsideScope(visit.salesmanId)) return err(NOT_YOUR_TEAM, "not_permitted");
    if (visit.verified) return ok(undefined, "Already verified.");

    await db
      .update(mbosVisits)
      .set({
        verified: true,
        acceptedAt: new Date(),
        acceptedById: user.id,
        updatedById: user.id,
        updatedAt: new Date(),
      })
      .where(eq(mbosVisits.id, input.visitId));

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.visit.accept",
      entityType: "mbos_visit",
      entityId: input.visitId,
      beforeState: { verified: false } as never,
      afterState: { verified: true, acceptedById: user.id } as never,
    });

    refresh();
    return okVoid("Accepted — marked verified.");
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * "The shop's pin is wrong — move it to where I stood."
 *
 * A salesman refused at the door types a sentence, the visit lands unverified
 * carrying it, and he may ask for the shop's own pin to be corrected. This is
 * where that is decided, and the decision belongs to a person for one reason:
 * the handset can already move a pin through `customer_update`, so an override
 * that moved it on its own would mean one override put the pin wherever
 * somebody was standing and the radius would never refuse him there again.
 *
 * NO COORDINATES ARE PASSED IN. What is being accepted is the check-in fix
 * already stored on this visit — taking them from the request would let the
 * screen propose one point and the write land another, and the whole value of
 * the correction is that it is the reading a manager can see on the row.
 *
 * It does NOT touch `verified`. Whether the visit was proved and whether the
 * book was wrong are two questions: accepting the pin says the shop is where
 * he said, and standing behind the visit is `acceptVisit`, one action along.
 * Answering both from one click would move a figure nobody asked about.
 */
export async function decidePinCorrection(input: {
  visitId: string;
  accept: boolean;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.journeys"));

    const [visit] = await db
      .select({
        id: mbosVisits.id,
        customerId: mbosVisits.customerId,
        salesmanId: mbosVisits.salesmanId,
        pinCorrection: mbosVisits.pinCorrection,
        checkInLat: mbosVisits.checkInLat,
        checkInLng: mbosVisits.checkInLng,
        checkInAccuracyM: mbosVisits.checkInAccuracyM,
      })
      .from(mbosVisits)
      .where(eq(mbosVisits.id, input.visitId))
      .limit(1);
    if (!visit) return err("That visit is no longer here.", "not_found");
    /* Accepting moves the shop's pin to where HE stood, and the radius then
       stops refusing him there — so the man who asked is the one man who may
       not answer. */
    if (visit.salesmanId === user.id) {
      return err("You asked for this pin to be moved. Somebody else has to decide it.", "not_permitted");
    }
    if (await salesmanOutsideScope(visit.salesmanId)) return err(NOT_YOUR_TEAM, "not_permitted");
    if (visit.pinCorrection !== "requested") {
      return err(
        visit.pinCorrection
          ? "Somebody has already answered this one."
          : "Nobody asked for this shop's pin to be moved.",
        "validation",
      );
    }
    if (input.accept && (visit.checkInLat == null || visit.checkInLng == null)) {
      /* A request raised on a check-in with no fix behind it. The handset
         cannot produce one — the pin question is only asked after a refusal,
         and a refusal needs a fix to have been measured — but a payload is
         not a promise, and moving a pin to nowhere is the one outcome worth
         refusing outright. */
      return err(
        "That check-in carried no location, so there is nothing to move the pin to.",
        "validation",
      );
    }

    const decidedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(mbosVisits)
        .set({
          pinCorrection: input.accept ? "accepted" : "rejected",
          pinCorrectionDecidedAt: decidedAt,
          pinCorrectionDecidedById: user.id,
          updatedById: user.id,
          updatedAt: decidedAt,
        })
        .where(eq(mbosVisits.id, input.visitId));

      if (input.accept) {
        /* `gps_captured_at` moves with it, because it is a NEW measurement and
           a screen weighing a pin reads how old it is. Not the geocoded pair:
           those hold a guess, deliberately kept out of visit verification, and
           a measurement written into them would lose the distinction. */
        await tx
          .update(customers)
          .set({
            gpsLat: visit.checkInLat,
            gpsLng: visit.checkInLng,
            gpsAccuracyM: visit.checkInAccuracyM,
            gpsCapturedAt: decidedAt,
            updatedById: user.id,
            updatedAt: decidedAt,
          })
          .where(eq(customers.id, visit.customerId));
      }
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: input.accept ? "mbos.visit.pin.accept" : "mbos.visit.pin.reject",
      entityType: "customer",
      entityId: visit.customerId,
      beforeState: { visitId: input.visitId, pinCorrection: "requested" } as never,
      afterState: {
        visitId: input.visitId,
        pinCorrection: input.accept ? "accepted" : "rejected",
        gpsLat: input.accept ? visit.checkInLat : undefined,
        gpsLng: input.accept ? visit.checkInLng : undefined,
      } as never,
    });

    refresh();
    return okVoid(
      input.accept
        ? "Moved — the shop now sits where he checked in."
        : "Left as it is.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Asking the salesman about a visit, rather than taking the phone's word for
 * it either way. A required reason, same as archiving a lead: the question
 * has to be a question, not a bare summons.
 */
export async function askAboutVisit(input: {
  visitId: string;
  question: string;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.journeys"));

    const question = input.question.trim();
    if (!question) {
      return err("Say what you want to ask.", "validation");
    }

    const [visit] = await db
      .select({ id: mbosVisits.id, salesmanId: mbosVisits.salesmanId })
      .from(mbosVisits)
      .where(eq(mbosVisits.id, input.visitId))
      .limit(1);
    if (!visit) return err("That visit is no longer here.", "not_found");
    if (await salesmanOutsideScope(visit.salesmanId)) return err(NOT_YOUR_TEAM, "not_permitted");

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.visit.ask",
      entityType: "mbos_visit",
      entityId: input.visitId,
      afterState: { question } as never,
    });

    await tell(visit.salesmanId, "A question about a visit", `${user.name} asked: ${question}`, null);

    refresh();
    return okVoid("Asked. It reaches their handset on the next sync.");
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
    const user = await requireSalesAccess({ modules: ["sales.prefs"] });
    /* The SAME capability the Admin Console's settings save asks for. These
       keys change what every handset in the field does, and holding the app —
       which used to be the whole check — is not a licence to reconfigure it. */
    await requireCapability("config.write");

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
 * Stops the office replaced or cleared, said to the handset that holds them.
 *
 * A replan deletes the planned stops and writes new ones under new ids, and a
 * pull only carries rows that EXIST — so without a tombstone each old stop sat
 * on the phone beside its replacement for ever: the day's list doubled, shops
 * somebody had taken off it stayed on it, and "x of N done" counted both.
 */
async function tombstoneStops(
  tx: Pick<typeof db, "insert">,
  stops: { id: string }[],
  salesmanId: string,
): Promise<void> {
  if (!stops.length) return;
  await tx.insert(mbosDeletions).values(
    stops.map((s) => ({
      id: gen("del"),
      entity: "journey_stops",
      entityId: s.id,
      userId: salesmanId,
      reason: "replanned",
    })),
  );
}

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

/* ---------------------------------------------------------------------------
 * WHO A DOCUMENT IS FOR, BY NAME.
 *
 * `visible_to_user_ids` is the people a document is tagged to; empty is
 * everybody in the field. Tagging is a narrowing of the role list, never a way
 * round it, and the people offered are exactly the people `fieldTeam` lists —
 * holding the `field` app IS being in the field, because it is what MBOS
 * sign-in checks.
 * ------------------------------------------------------------------------- */

/** Everybody who could hold a document on a handset — the field grant. */
async function fieldUserIds(): Promise<string[]> {
  const rows = await db
    .select({ id: appAccess.userId })
    .from(appAccess)
    .where(eq(appAccess.app, "field"));
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * The tagged list as it will be stored: de-duplicated, and every id somebody
 * in the field. Asked of the database rather than trusted from the dialog,
 * because a server action is a URL — and an id that names nobody on a handset
 * would make a document that reaches nobody while reading as tagged.
 */
async function taggedPeople(ids: readonly string[] | undefined): Promise<Result<string[]>> {
  const wanted = [...new Set((ids ?? []).map((i) => i.trim()).filter(Boolean))];
  if (!wanted.length) return ok([]);
  const field = new Set(await fieldUserIds());
  const strangers = wanted.filter((i) => !field.has(i));
  if (strangers.length) {
    return err(
      strangers.length === 1
        ? "One of the people tagged is not in the field any more, so a handset could never show it to them. Open Tag employees again and save."
        : `${strangers.length} of the people tagged are not in the field any more. Open Tag employees again and save.`,
      "validation",
      [{ field: "people", message: "Not in the field." }],
    );
  }
  return ok(wanted);
}

/**
 * What moving a document's tags does to the phones.
 *
 * A PULL SAYS WHAT EXISTS AND ONLY A TOMBSTONE SAYS WHAT STOPPED. Untagging a
 * salesman removes the row from what his next pull sends — and leaves the copy
 * he already has on his phone for ever, because nothing tells it to go. So
 * everybody who could see it before and cannot now is written a tombstone of
 * their own (`user_id` set, so nobody else's handset is touched).
 *
 * The other direction has a trap in it. The handset applies a pull's upserts
 * BEFORE its tombstones, so somebody untagged and tagged back between two of
 * his syncs would receive the row and then delete it in the same breath.
 * Re-adding somebody therefore withdraws any tombstone still standing against
 * them for this document, and the `updated_at` bump carries the row back to a
 * handset that had already applied it.
 *
 * Returns who gained it, for the notification.
 */
async function applyTagChange(
  documentId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<string[]> {
  const field = before.length && after.length ? [] : await fieldUserIds();
  const sawBefore = new Set(before.length ? before : field);
  const seesAfter = new Set(after.length ? after : field);

  const lost = [...sawBefore].filter((u) => !seesAfter.has(u));
  const gained = [...seesAfter].filter((u) => !sawBefore.has(u));

  if (lost.length) {
    await db.insert(mbosDeletions).values(
      lost.map((userId) => ({
        id: gen("del"),
        entity: "documents",
        entityId: documentId,
        userId,
        reason: "untagged",
      })),
    );
  }
  if (gained.length) {
    await db
      .delete(mbosDeletions)
      .where(
        and(
          eq(mbosDeletions.entity, "documents"),
          eq(mbosDeletions.entityId, documentId),
          inArray(mbosDeletions.userId, gained),
        ),
      );
  }
  return gained;
}

/**
 * Telling the people a document was tagged TO that it is there.
 *
 * Only named people, and only a published document: "everybody in the field"
 * is the ordinary case and a bell on every phone for every price list is a bell
 * people learn to ignore. A tag is somebody deciding THIS person needs THIS
 * file, which is worth saying. Never fails the write it follows.
 */
async function tellTagged(userIds: readonly string[], title: string) {
  if (!userIds.length) return;
  await notifyUsers(
    userIds.map((userId) => ({
      userId,
      title: "A document was shared with you",
      body: `${title} is in your Documents. It downloads on your next sync.`,
      mbosHref: "/docs",
    })),
  ).catch(() => {});
}

function checkTitle(raw: string): Result<string> {
  const title = raw.trim();
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
  return ok(title);
}

function peopleSentence(n: number): string {
  return n === 0 ? "every handset" : n === 1 ? "the one person tagged" : `the ${n} people tagged`;
}

export async function publishDocument(input: {
  title: string;
  category: DocumentCategory;
  attachmentId?: string | null;
  customerId?: string | null;
  /** Empty means everybody in the field, which is what the handset reads too. */
  visibleToRoles?: string[];
  /** The people it is tagged to. Empty means everybody in the field. */
  visibleToUserIds?: string[];
}): Promise<Result<{ id: string }>> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.documents"));

    const titled = checkTitle(input.title);
    if (!titled.ok) return titled;
    const title = titled.data;

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

    const people = await taggedPeople(input.visibleToUserIds);
    if (!people.ok) return people;

    const documentId = gen("mdoc");
    await db.insert(mbosDocuments).values({
      id: documentId,
      title,
      category: input.category,
      attachmentId: input.attachmentId,
      customerId: input.customerId ?? null,
      visibleToRoles: input.visibleToRoles ?? [],
      visibleToUserIds: people.data,
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
      afterState: { title, category: input.category, visibleToUserIds: people.data } as never,
    });

    await tellTagged(people.data, title);

    refresh();
    return ok(
      { id: documentId },
      `${title} published to ${peopleSentence(people.data.length)}. Handsets pick it up on their next sync.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Who a document is tagged to — the whole list, every time.
 *
 * The WHOLE list rather than a difference, for the reason `plan_stops` is: a
 * shorter list is how somebody is untagged, and a merge could never express
 * that. Adding, removing and clearing are one act with one review.
 */
export async function setDocumentPeople(input: {
  documentId: string;
  /** Empty means everybody in the field. */
  userIds: string[];
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.documents"));

    const [doc] = await db
      .select({
        id: mbosDocuments.id,
        title: mbosDocuments.title,
        active: mbosDocuments.active,
        visibleToUserIds: mbosDocuments.visibleToUserIds,
      })
      .from(mbosDocuments)
      .where(eq(mbosDocuments.id, input.documentId));
    if (!doc) return err("That document is not here any more.", "not_found");

    const people = await taggedPeople(input.userIds);
    if (!people.ok) return people;

    const before = doc.visibleToUserIds ?? [];
    const same =
      before.length === people.data.length && before.every((u) => people.data.includes(u));
    if (same) return okVoid("Nothing changed — the same people are tagged.");

    await db
      .update(mbosDocuments)
      .set({ visibleToUserIds: people.data, updatedById: user.id, updatedAt: new Date() })
      .where(eq(mbosDocuments.id, input.documentId));

    /* A withdrawn document is on nobody's phone, so moving its tags moves
     * nothing there; the list is kept for the day it is published again. */
    const gained = doc.active ? await applyTagChange(doc.id, before, people.data) : [];

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.document.tag",
      entityType: "mbos_document",
      entityId: doc.id,
      beforeState: { visibleToUserIds: before } as never,
      afterState: { visibleToUserIds: people.data } as never,
    });

    if (people.data.length) await tellTagged(gained, doc.title);

    refresh();
    return okVoid(
      people.data.length
        ? `${doc.title} is now for ${peopleSentence(people.data.length)}.${doc.active ? " Their handsets update on the next sync." : ""}`
        : `${doc.title} is now for everybody in the field.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * The title, the kind, and the file behind it.
 *
 * REPLACING THE FILE KEEPS THE DOCUMENT. A price list revised in September is
 * the same entry the field already knows, with the same people tagged to it;
 * withdrawing and publishing a second one would leave two rows on every handset
 * for a day and lose the tags. The old file is marked removed — a status, not a
 * delete, so the retention window still decides when its bytes go — and the
 * handset fetches the new one because its stored copy is named after the file
 * it came from (`heldFile`), not after the document.
 */
export async function updateDocument(input: {
  documentId: string;
  title: string;
  category: DocumentCategory;
  /** A newly uploaded file to put behind it. Absent or the same id keeps the file. */
  attachmentId?: string | null;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.documents"));

    const titled = checkTitle(input.title);
    if (!titled.ok) return titled;
    const title = titled.data;

    const [doc] = await db
      .select({
        id: mbosDocuments.id,
        title: mbosDocuments.title,
        category: mbosDocuments.category,
        attachmentId: mbosDocuments.attachmentId,
      })
      .from(mbosDocuments)
      .where(eq(mbosDocuments.id, input.documentId));
    if (!doc) return err("That document is not here any more.", "not_found");

    const replacing = !!input.attachmentId && input.attachmentId !== doc.attachmentId;
    if (!replacing && title === doc.title && input.category === doc.category) {
      return okVoid("Nothing changed.");
    }

    if (replacing) {
      const [file] = await db
        .select({ id: attachments.id, parentId: attachments.parentId, status: attachments.status })
        .from(attachments)
        .where(eq(attachments.id, input.attachmentId!));
      if (!file || file.parentId || file.status !== "available") {
        return err(
          "That file is not available to attach any more. Choose it again.",
          "conflict",
          [{ field: "file", message: "Choose it again." }],
        );
      }
    }

    await db.transaction(async (tx) => {
      if (replacing) {
        if (doc.attachmentId) {
          await tx
            .update(attachments)
            .set({
              status: "removed",
              parentType: null,
              parentId: null,
              removedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(attachments.id, doc.attachmentId));
        }
        await tx
          .update(attachments)
          .set({ parentType: "mbos_document", parentId: doc.id, updatedAt: new Date() })
          .where(and(eq(attachments.id, input.attachmentId!), isNull(attachments.parentId)));
      }
      await tx
        .update(mbosDocuments)
        .set({
          title,
          category: input.category,
          ...(replacing ? { attachmentId: input.attachmentId! } : {}),
          updatedById: user.id,
          updatedAt: new Date(),
        })
        .where(eq(mbosDocuments.id, doc.id));
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.document.edit",
      entityType: "mbos_document",
      entityId: doc.id,
      beforeState: { title: doc.title, category: doc.category, attachmentId: doc.attachmentId } as never,
      afterState: {
        title,
        category: input.category,
        attachmentId: replacing ? input.attachmentId : doc.attachmentId,
      } as never,
    });

    refresh();
    return okVoid(
      replacing
        ? `${title} saved with its new file. Handsets fetch it on their next sync.`
        : `${title} saved.`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Take it back, or put it back.
 *
 * Withdrawing writes the tombstone; republishing does not need one, because the
 * ordinary pull carries a row that exists. It DOES have to lift the withdrawal's
 * tombstone: a handset applies upserts before tombstones, so one that slept
 * through both would receive the row and delete it in the same pull.
 */
export async function setDocumentPublished(input: {
  documentId: string;
  published: boolean;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.documents"));

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
    } else {
      await db
        .delete(mbosDeletions)
        .where(
          and(
            eq(mbosDeletions.entity, "documents"),
            eq(mbosDeletions.entityId, input.documentId),
            eq(mbosDeletions.reason, "withdrawn"),
          ),
        );
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
    const user = await requireSalesAccess(SALES_MANAGER("sales.knowledge"));

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
    const user = await requireSalesAccess(SALES_MANAGER("sales.knowledge"));

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

/* ═══════════════════════════════════════════════════════════ task allocation */

/**
 * Assigning a task, on the web, to somebody who reads it on a handset.
 *
 * `mbos_tasks` already existed — it is how a rejected order raises "ring back
 * about it" for the salesman who took it — but nothing let a MANAGER write one
 * for somebody else. This is that, and it is deliberately Sales Dashboard's
 * own action: a Sales Dashboard MANAGER holding Tasks (`requireSalesAccess`),
 * not a new capability. Reaching the handset needs `buildPull`'s own `tasks`
 * channel, added alongside this — a task minted here and never pulled would
 * be a manager's word that never left the office.
 */

const TASK_PRIORITIES = ["low", "medium", "high"] as const;
type TaskPriority = (typeof TASK_PRIORITIES)[number];

function validTask(title: string, dueDate: string, priority: string | undefined): string | null {
  if (title.trim().length < 3) {
    return "A task needs a real title — enough that whoever is assigned it knows what to do.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return "Pick a date it is due by.";
  }
  if (priority !== undefined && !TASK_PRIORITIES.includes(priority as TaskPriority)) {
    return "That is not a priority this app knows.";
  }
  return null;
}

/** One task, for one person. */
export async function createTask(input: {
  assignedToUserId: string;
  title: string;
  description?: string;
  customerId?: string | null;
  priority?: TaskPriority;
  dueDate: string;
}): Promise<Result<{ taskId: string }>> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER("sales.tasks"));
    if (await salesmanOutsideScope(input.assignedToUserId)) return err(NOT_YOUR_TEAM, "not_permitted");
    const title = input.title.trim();
    const problem = validTask(title, input.dueDate, input.priority);
    if (problem) return err(problem, "validation");

    const [assignee] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, input.assignedToUserId));
    if (!assignee) return err("No such person.", "not_found");

    const taskId = gen("mbos_task");
    await db.insert(mbosTasks).values({
      id: taskId,
      title,
      description: input.description?.trim() || null,
      assignedToUserId: input.assignedToUserId,
      assignedByUserId: user.id,
      priority: input.priority ?? "medium",
      dueDate: input.dueDate,
      customerId: input.customerId ?? null,
      status: "open",
      createdById: user.id,
      updatedById: user.id,
    });

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.task.created",
      entityType: "mbos_task",
      entityId: taskId,
      beforeState: null as never,
      afterState: { title, assignedToUserId: input.assignedToUserId, dueDate: input.dueDate } as never,
    });

    await tell(
      input.assignedToUserId,
      "A task was assigned to you",
      `${user.name}: ${title} — due ${input.dueDate}`,
      "/tasks",
    );

    refresh();
    return ok({ taskId }, `Assigned to ${assignee.name}.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------- tasks with forms */

/**
 * ONE ASSIGNMENT, MANY ANSWERS.
 *
 * The office picks what to ask (a form of any fields, `lib/task-form.ts`),
 * which shops it is about and who does it (`lib/task-audience.ts`), and this
 * writes one `mbos_task_campaigns` row and one task per (salesman, shop) pair.
 * The handset draws the form on each task; the answers come back on the task
 * and are read side by side on `/sales/tasks/<campaign>`.
 *
 * The preview and the save run the SAME expansion over the SAME reads, and the
 * save refuses when the count has moved since it was reviewed — the shape the
 * bulk tools elsewhere in this product already use, so nothing is written to a
 * set nobody looked at.
 *
 * WHO MAY BE GIVEN WORK is the manager's active field team (`fieldTeam`, which
 * is already narrowed by `managerScope`). A shop's carrier who holds no field
 * app — a telecaller, the importer — would receive a task no screen of theirs
 * can show, so that shop is counted as having nobody to do it.
 */

const TASK_MODULE = "sales.tasks";

function refreshCampaign(campaignId: string) {
  try {
    revalidatePath(`/sales/tasks/${campaignId}`);
  } catch {
    /* Outside a request — a job or a test — there is no cache to clear. */
  }
}

const taskFieldSchema = z.object({
  id: z.string().min(1).max(60),
  type: z.enum(TASK_FIELD_TYPES),
  label: z.string().max(300),
  help: z.string().max(1000).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().max(200)).max(MAX_TASK_OPTIONS + 10).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  unit: z.string().max(40).optional(),
  showIf: z
    .object({
      field: z.string().min(1).max(60),
      op: z.enum(["is", "is_not", "includes", "answered"]),
      value: z.string().max(200).optional(),
    })
    .optional(),
  link: z
    .object({
      target: z.enum(TASK_LINK_TARGET_KEYS as [TaskLinkTarget, ...TaskLinkTarget[]]),
      mode: z.enum(["fill", "update"]),
      scope: z.enum(["primary", "each"]).optional(),
    })
    .optional(),
});

const placesSchema = z.object({
  state: z.string().max(4000).optional(),
  district: z.string().max(4000).optional(),
  city: z.string().max(4000).optional(),
  area: z.string().max(4000).optional(),
});

const audienceSchema = z.object({
  shops: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("list"), customerIds: z.array(z.string().min(1)).max(MAX_TASKS_PER_ASSIGNMENT) }),
    z.object({
      kind: z.literal("filter"),
      places: placesSchema,
      carriedBy: z.array(z.string().min(1)).max(500),
      accountKinds: z.array(z.enum(["customer", "lead"])).max(2),
      missingGpsOnly: z.boolean().optional(),
      search: z.string().max(200).optional(),
    }),
  ]),
  assignees: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("carrier") }),
    z.object({ kind: z.literal("chosen"), salesmanIds: z.array(z.string().min(1)).max(500) }),
  ]),
});

export type TaskAudiencePreview = {
  tasks: number;
  shops: number | null;
  noCarrier: number;
  outsideTeam: number;
  tooMany: boolean;
  /** Shops left out because their record already has everything asked. */
  alreadyComplete: number;
  salesmen: { id: string; name: string; count: number }[];
  sample: string[];
};

/**
 * The expansion both the preview and the save run. A task that only collects
 * customer data (every question a linked FILL question) is not sent to a shop
 * whose record already holds all of it — that visit would ask for nothing.
 */
async function resolveAudience(audience: TaskAudience, form: TaskField[] = []) {
  const [allShops, team] = await Promise.all([shopsForTarget(audience.shops), fieldTeam()]);
  const active = new Map(team.filter((s) => s.active).map((s) => [s.id, s.name]));
  let shops = allShops;
  let alreadyComplete = 0;
  if (shops && shops.length && formHasLinks(form)) {
    const contexts = await linkContexts(shops.map((c) => c.id));
    const before = shops.length;
    shops = shops.filter((c) => !linkedTaskComplete(form, contexts.get(c.id) ?? null));
    alreadyComplete = before - shops.length;
  }
  const expanded = expandTaskAudience(
    shops?.map((c) => ({ id: c.id, carrierId: c.carrierId })) ?? null,
    audience.assignees,
    (id) => active.has(id),
  );
  return { shops, active, alreadyComplete, ...expanded };
}

function previewOf(r: Awaited<ReturnType<typeof resolveAudience>>): TaskAudiencePreview {
  const per = new Map<string, number>();
  for (const p of r.pairs) per.set(p.salesmanId, (per.get(p.salesmanId) ?? 0) + 1);
  return {
    tasks: r.pairs.length,
    shops: r.shops ? Math.min(r.shops.length, MAX_TASKS_PER_ASSIGNMENT) : null,
    noCarrier: r.noCarrier,
    outsideTeam: r.outsideTeam,
    alreadyComplete: r.alreadyComplete,
    tooMany: r.pairs.length > MAX_TASKS_PER_ASSIGNMENT || (r.shops?.length ?? 0) > MAX_TASKS_PER_ASSIGNMENT,
    salesmen: [...per.entries()]
      .map(([id, count]) => ({ id, name: r.active.get(id) ?? "Somebody", count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    sample: (r.shops ?? []).slice(0, 6).map((c) => c.name),
  };
}

/** Who and how many an audience means, before anything is written. */
export async function previewTaskAudience(
  input: TaskAudience,
  formInput: TaskField[] = [],
): Promise<Result<TaskAudiencePreview>> {
  try {
    await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const parsed = audienceSchema.safeParse(input);
    if (!parsed.success) return err("That selection could not be read. Pick it again.", "validation");
    const problem = taskAudienceProblem(parsed.data);
    if (problem) return err(problem, "validation");
    const formParsed = z.array(taskFieldSchema).max(MAX_TASK_FIELDS).safeParse(formInput ?? []);
    const form = formParsed.success ? tidyTaskForm(formParsed.data as TaskField[]) : [];
    return ok(previewOf(await resolveAudience(parsed.data, form)));
  } catch (e) {
    return fromThrown(e);
  }
}

/** The shop picker's search. */
export async function searchTaskShops(query: string): Promise<Result<AudienceShopRow[]>> {
  try {
    await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    return ok(await searchShopsForTask(String(query ?? "").slice(0, 100)));
  } catch (e) {
    return fromThrown(e);
  }
}

/** The four place dropdowns, re-counted as the picks above narrow them. */
export async function loadTaskPlaceOptions(picks: PlaceFilterValues): Promise<Result<PlaceFilterOptions>> {
  try {
    await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const parsed = placesSchema.safeParse(picks ?? {});
    return ok(await taskPlaceOptions(parsed.success ? parsed.data : {}));
  } catch (e) {
    return fromThrown(e);
  }
}

/** Assign a task, with whatever it asks for, to everybody the audience means. */
export async function assignTaskCampaign(input: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate: string;
  form: TaskField[];
  audience: TaskAudience;
  expectedCount: number;
  /** The plain-words description the AI drafted the form from, if it did. */
  aiBrief?: string;
}): Promise<Result<{ campaignId: string; created: number }>> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const title = String(input.title ?? "").trim();
    const problem = validTask(title, input.dueDate, input.priority);
    if (problem) return err(problem, "validation");

    const formParsed = z.array(taskFieldSchema).max(MAX_TASK_FIELDS).safeParse(input.form ?? []);
    if (!formParsed.success) return err("The form could not be read. Check each question.", "validation");
    const form = tidyTaskForm(formParsed.data as TaskField[]);
    const formProblems = taskFormProblems(form);
    if (formProblems.length) return err(formProblems[0], "validation");

    const audParsed = audienceSchema.safeParse(input.audience);
    if (!audParsed.success) return err("Who it goes to could not be read. Pick it again.", "validation");
    const audience = audParsed.data;
    const audProblem = taskAudienceProblem(audience);
    if (audProblem) return err(audProblem, "validation");

    const resolved = await resolveAudience(audience, form);
    const preview = previewOf(resolved);
    if (preview.tooMany) {
      return err(
        `That is more than ${MAX_TASKS_PER_ASSIGNMENT.toLocaleString("en-IN")} tasks in one go. Narrow it by place or by salesman.`,
        "validation",
      );
    }
    if (preview.tasks !== input.expectedCount) {
      return err(
        `This would now create ${preview.tasks} tasks, not the ${input.expectedCount} you reviewed. Check who it goes to again.`,
        "conflict",
      );
    }
    if (!preview.tasks) return err("Nobody would receive this task.", "validation");

    const placeIds =
      audience.shops.kind === "filter"
        ? Object.values(audience.shops.places).flatMap((v) => (v ?? "").split(",")).filter(Boolean)
        : [];
    const places = await placeNames(placeIds);
    const audienceSentence = taskAudienceSentence(audience, {
      salesman: (id) => resolved.active.get(id) ?? "somebody",
      place: (id) => places.get(id) ?? "a place",
    });

    const campaignId = gen("mbos_taskc");
    const description = input.description?.trim() || null;
    const priority = input.priority ?? "medium";
    await db.transaction(async (tx) => {
      await tx.insert(mbosTaskCampaigns).values({
        id: campaignId,
        title,
        description,
        form,
        audience,
        audienceSentence,
        priority,
        dueDate: input.dueDate,
        taskCount: preview.tasks,
        skippedComplete: preview.alreadyComplete,
        aiBrief: input.aiBrief?.trim().slice(0, 4000) || null,
        createdById: user.id,
      });
      for (let i = 0; i < resolved.pairs.length; i += 500) {
        await tx.insert(mbosTasks).values(
          resolved.pairs.slice(i, i + 500).map((p) => ({
            id: gen("mbos_task"),
            title,
            description,
            assignedToUserId: p.salesmanId,
            assignedByUserId: user.id,
            priority,
            dueDate: input.dueDate,
            customerId: p.customerId,
            status: "open" as const,
            campaignId,
            sourceType: "campaign",
            sourceId: campaignId,
            createdById: user.id,
            updatedById: user.id,
          })),
        );
      }
      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: user.id,
        action: "mbos.task.campaignCreated",
        entityType: "mbos_task_campaign",
        entityId: campaignId,
        beforeState: null as never,
        afterState: {
          title,
          dueDate: input.dueDate,
          questions: form.length,
          tasks: preview.tasks,
          audience: audienceSentence,
        } as never,
      });
    });

    const asks = form.filter((f) => f.type !== "info").length;
    for (const s of preview.salesmen) {
      await tell(
        s.id,
        s.count === 1 ? "A task was assigned to you" : `${s.count} tasks were assigned to you`,
        `${user.name}: "${title}"${asks ? ` — ${plural(asks, "question")} to answer` : ""} — due ${input.dueDate}`,
        "/tasks",
      );
    }

    refresh();
    refreshCampaign(campaignId);
    const skipped = preview.noCarrier + preview.outsideTeam;
    return ok(
      { campaignId, created: preview.tasks },
      `${plural(preview.tasks, "task")} assigned to ${plural(preview.salesmen.length, "salesman", "salesmen")}.` +
        (skipped ? ` ${plural(skipped, "shop")} had nobody in your field team to do it and ${skipped === 1 ? "was" : "were"} skipped.` : "") +
        (preview.alreadyComplete ? ` ${plural(preview.alreadyComplete, "shop")} already had everything on the customer record and ${preview.alreadyComplete === 1 ? "was" : "were"} left out.` : ""),
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------- the task brain */

/** Draft a whole task — questions, links and targeting — from a description. */
export async function aiDraftTask(brief: string): Promise<Result<TaskDraft>> {
  try {
    await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const text = String(brief ?? "").trim();
    if (text.length < 8) return err("Say a little more about what you need from the field.", "validation");
    const draft = await draftTask(text);
    if (!draft) return err("The AI could not draft this just now. Build it by hand, or try again.", "rule_violation");
    return ok(draft);
  } catch (e) {
    return fromThrown(e);
  }
}

/** Which questions are really the customer record's own fields. */
export async function aiSuggestLinks(
  formInput: TaskField[],
  title: string,
): Promise<Result<{ suggestions: LinkSuggestion[]; usedAi: boolean }>> {
  try {
    await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const parsed = z.array(taskFieldSchema).max(MAX_TASK_FIELDS).safeParse(formInput ?? []);
    if (!parsed.success) return err("The form could not be read.", "validation");
    return ok(await suggestLinks(tidyTaskForm(parsed.data as TaskField[]), String(title ?? "").slice(0, 200)));
  } catch (e) {
    return fromThrown(e);
  }
}

/** Read everything the field answered, and keep the reading on the assignment. */
export async function aiSummariseCampaign(campaignId: string): Promise<Result<TaskSummary>> {
  try {
    await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const c = await taskCampaign(campaignId, await today());
    if (!c) return err("That assignment is not one of your team's.", "not_found");
    if (!c.tasks.some((t) => t.status === "done")) return err("Nothing has been answered yet.", "validation");
    const summary = await summariseCampaign(c);
    if (!summary) return err("The AI could not read the answers just now. Try again in a minute.", "rule_violation");
    await db
      .update(mbosTaskCampaigns)
      .set({ aiSummary: JSON.stringify(summary), aiSummaryAt: new Date() })
      .where(eq(mbosTaskCampaigns.id, campaignId));
    refreshCampaign(campaignId);
    return ok(summary);
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * Withdraw what is still open. Answered tasks keep their answers — a reply
 * somebody gave is a fact about the shop whatever happens to the question.
 */
export async function closeTaskCampaign(campaignId: string): Promise<Result<{ cancelled: number }>> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const scope = await managerScope();
    const rows = (await db.execute<{ id: string }>(sql`
      update mbos_tasks t
         set status = 'cancelled', updated_at = now(), updated_by_id = ${user.id}
       where t.campaign_id = ${campaignId}
         and t.status in ('open', 'in_progress')
         ${onlyMine(scope, "t.assigned_to_user_id")}
      returning t.id
    `)) as unknown as { id: string }[];
    await db
      .update(mbosTaskCampaigns)
      .set({ closedAt: new Date(), updatedAt: new Date() })
      .where(eq(mbosTaskCampaigns.id, campaignId));
    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: "mbos.task.campaignClosed",
      entityType: "mbos_task_campaign",
      entityId: campaignId,
      beforeState: null as never,
      afterState: { cancelled: rows.length } as never,
    });
    refresh();
    refreshCampaign(campaignId);
    return ok({ cancelled: rows.length }, rows.length ? `${plural(rows.length, "open task")} withdrawn.` : "Nothing was still open.");
  } catch (e) {
    return fromThrown(e);
  }
}

/** Nudge everybody who still owes an answer — one bell each, not one a task. */
export async function remindTaskCampaign(campaignId: string): Promise<Result<{ reminded: number }>> {
  try {
    const user = await requireSalesAccess(SALES_MANAGER(TASK_MODULE));
    const scope = await managerScope();
    const [head] = await db
      .select({ title: mbosTaskCampaigns.title })
      .from(mbosTaskCampaigns)
      .where(eq(mbosTaskCampaigns.id, campaignId));
    if (!head) return err("That assignment no longer exists.", "not_found");
    const rows = (await db.execute<{ userId: string; open: number }>(sql`
      select t.assigned_to_user_id as "userId", count(*)::int as open
        from mbos_tasks t
       where t.campaign_id = ${campaignId}
         and t.status in ('open', 'in_progress')
         ${onlyMine(scope, "t.assigned_to_user_id")}
       group by t.assigned_to_user_id
    `)) as unknown as { userId: string; open: number }[];
    for (const r of rows) {
      await tell(
        r.userId,
        "Reminder: a task is waiting on you",
        `${user.name}: "${head.title}" — ${plural(Number(r.open), "task")} still open`,
        "/tasks",
      );
    }
    return ok({ reminded: rows.length }, rows.length ? `Reminded ${plural(rows.length, "salesman", "salesmen")}.` : "Nobody owes an answer.");
  } catch (e) {
    return fromThrown(e);
  }
}

/* ═══════════════════════════════════════════════ the evidence of a day ═══ */

/**
 * The shape of a verdict's natural key, parsed rather than trusted.
 *
 * A server action is a URL, so the reference that arrives here is a string
 * somebody can type. Every branch below resolves it back to a real row and
 * checks whose it is — the screen's list is not a permission.
 */
type EvidenceRef =
  | { kind: "attendance_selfie"; dayId: string; session: number; mark: "in" | "out" }
  | { kind: "odometer"; legId: string; end: "start" | "end" };

function parseEvidenceRef(ref: string): EvidenceRef | null {
  const att = /^att:([A-Za-z0-9_-]{1,64}):(\d{1,3}):(in|out)$/.exec(ref);
  if (att) {
    return {
      kind: "attendance_selfie",
      dayId: att[1],
      session: Number(att[2]),
      mark: att[3] as "in" | "out",
    };
  }
  const leg = /^leg:([A-Za-z0-9_-]{1,64}):(start|end)$/.exec(ref);
  if (leg) return { kind: "odometer", legId: leg[1], end: leg[2] as "start" | "end" };
  return null;
}

/**
 * A manager answering one photograph.
 *
 * **THE VERDICT AND THE CORRECTION ARE ONE WRITE.** A declined odometer
 * reading is almost always a digit — 41,208 typed for a meter reading 41,280 —
 * and a screen that recorded the disagreement without letting the person
 * holding the photograph say what it actually reads leaves the wrong figure
 * standing in the only place the distance is worked out from. So a decline may
 * carry the reading, the leg is rewritten, the leg is re-measured and the day's
 * lines are re-priced, in that order.
 *
 * **WHAT HE TYPED SURVIVES THE CORRECTION.** `mbos_evidence_reviews.reportedKm`
 * is written on the FIRST verdict and never again, because the leg's own column
 * is overwritten and this is the only place the original lives. A second
 * correction restating it would present the office's first answer as the
 * salesman's.
 *
 * **A DECIDED CLAIM IS NOT RE-PRICED BEHIND SOMEBODY'S SIGNATURE.** Once an
 * approval step on the day has been answered, the numbers under that answer
 * stop moving; the refusal names Reopen, which exists, demands a reason and
 * tells the salesman. The verdict itself is still recordable — noticing that a
 * reading was wrong after the money was allowed is exactly the thing worth
 * writing down.
 *
 * **A CORRECTION ONLY EVER RIDES ON A DECLINE.** Accepting means the
 * photograph shows what he typed; accepting while changing the number would be
 * a record that cannot be read either way.
 *
 * **THE SALESMAN IS TOLD, and the remark travels IN the message.** A decision
 * nobody receives is not a decision — the rule `notify.ts` states and the one
 * an order decline had to learn. No `mbosHref`: there is no handset screen
 * that holds this, and `/rejections` renders the outbox, which is records
 * refused before they were ever stored. A null falls through to
 * `/notifications`, which carries the words.
 */
export async function reviewDayEvidence(input: {
  ref: string;
  verdict: "accepted" | "declined";
  remark?: string | null;
  /** Kilometres the manager reads off the photograph. Declines only. */
  correctedKm?: number | null;
}): Promise<Result> {
  try {
    const user = await requireSalesAccess({ modules: [], manager: true });

    const ref = parseEvidenceRef(String(input.ref ?? ""));
    if (!ref) return err("That is not a photograph this screen knows about.", "validation");

    if (input.verdict !== "accepted" && input.verdict !== "declined") {
      return err("A verdict is accept or decline.", "validation");
    }

    const remark = (input.remark ?? "").trim() || null;
    if (input.verdict === "declined" && !remark) {
      return err(
        "A decline has to say why — the salesman is told this, and a refusal with nothing in it teaches him the office is arbitrary rather than what to do differently.",
        "validation",
        [{ field: "remark", message: "Say why." }],
      );
    }

    const correctedKm =
      input.correctedKm === null || input.correctedKm === undefined
        ? null
        : Math.round(Number(input.correctedKm));
    if (correctedKm !== null && (!Number.isFinite(correctedKm) || correctedKm < 0)) {
      return err("A meter reading is a whole number of kilometres.", "validation", [
        { field: "correctedKm", message: "Read the figure off the photograph." },
      ]);
    }
    if (correctedKm !== null && ref.kind !== "odometer") {
      return err("There is nothing on a selfie to correct.", "validation");
    }
    if (correctedKm !== null && input.verdict !== "declined") {
      return err(
        "Accepting says the photograph shows what he typed. Changing the figure is a decline — it is the same act, and recording it as an acceptance would leave a row nobody can read either way.",
        "validation",
      );
    }

    /* ---- whose day is this, and may this manager answer for it ---- */

    let ownerId: string;
    let day: string;
    let sourceType: "mbos_attendance_days" | "mbos_travel_legs";
    let sourceId: string;
    let reportedKm: number | null = null;
    let legDayId: string | null = null;

    if (ref.kind === "attendance_selfie") {
      const [row] = await db.execute<{ userId: string; day: string }>(sql`
        select d.user_id as "userId", d.day::text as day
          from mbos_attendance_days d where d.id = ${ref.dayId} limit 1
      `);
      if (!row) return err("That day is no longer here.", "not_found");
      ownerId = row.userId;
      day = row.day;
      sourceType = "mbos_attendance_days";
      sourceId = ref.dayId;
    } else {
      const [row] = await db.execute<{
        userId: string;
        day: string;
        expenseDayId: string | null;
        odometerStartKm: number | null;
        odometerEndKm: number | null;
      }>(sql`
        select l.user_id as "userId",
               /* The expense day is the authority where there is one; where
                  there is not, the leg's own clock in Asia/Kolkata. Naming the
                  zone, because a bare cast reads in the session's and a leg
                  that started at 1am would land on the previous day. */
               coalesce(
                 (select e.day::text from mbos_expense_days e where e.id = l.expense_day_id),
                 (l.started_at ${sql.raw(`at time zone '${APP_TIMEZONE}'`)})::date::text
               ) as day,
               l.expense_day_id as "expenseDayId",
               l.odometer_start_km as "odometerStartKm",
               l.odometer_end_km as "odometerEndKm"
          from mbos_travel_legs l where l.id = ${ref.legId} limit 1
      `);
      if (!row) return err("That leg is no longer here.", "not_found");
      if (!row.day) {
        return err(
          "That leg carries no date at all — neither a day of its own nor a time it started — so there is nothing to file a verdict under.",
          "validation",
        );
      }
      ownerId = row.userId;
      day = row.day;
      sourceType = "mbos_travel_legs";
      sourceId = ref.legId;
      legDayId = row.expenseDayId;
      reportedKm = ref.end === "start" ? row.odometerStartKm : row.odometerEndKm;
    }

    /* The SAME narrowing every list on this dashboard runs. A manager may
       answer for his own patch and nobody else's, checked here rather than
       inferred from the fact that the screen drew the row. */
    /* The screen this photograph is shown on: a selfie on Attendance, a meter
       on the Travel ledger or the Expenses desk that prices it. */
    await requireSalesAccess({
      modules: ref.kind === "attendance_selfie" ? ["sales.attendance"] : ["sales.travel", "sales.expenses"],
      manager: true,
    });

    /* A verdict on one's own day is no verdict. */
    if (ownerId === user.id) {
      return err("That is your own day. Somebody else has to review it.", "not_permitted");
    }

    /* `scopeCovers` and not `salesmanIds === null`: the CRM Sales Manager
       seat leaves that null meaning "no list of people", never "everybody". */
    if (!scopeCovers(await managerScope(), ownerId)) {
      return err("That salesman is not in your team.", "not_permitted");
    }

    /* WHAT HE TYPED, and not what the office typed last time.
       The leg's own column has already been overwritten by any earlier
       correction, so reading the original off it on a SECOND pass would quote
       the office's first answer back to the salesman as though it had been
       his — "read as 41,270 rather than the 41,280 you entered", on a leg he
       entered 41,226 on. The stored review is where the original survives and
       it wins wherever there is one. */
    const before = await db.execute<{
      verdict: string;
      remark: string | null;
      reportedKm: number | null;
      correctedKm: number | null;
    }>(sql`
      select r.verdict::text as verdict, r.remark,
             r.reported_km as "reportedKm", r.corrected_km as "correctedKm"
        from mbos_evidence_reviews r where r.source_ref = ${input.ref} limit 1
    `);
    reportedKm = before[0]?.reportedKm ?? reportedKm;

    /* ---- the correction, where there is one ---- */

    let repriced = false;
    if (correctedKm !== null && ref.kind === "odometer") {
      const [claim] = await db.execute<{ id: string; decided: boolean }>(sql`
        select e.id,
               exists (select 1 from mbos_approvals ap
                        where ap.subject_type = 'mbos_expense_days'
                          and ap.subject_id = e.id
                          and ap.state <> 'pending') as decided
          from mbos_expense_days e
         where e.user_id = ${ownerId} and e.day = ${day}::date
         limit 1
      `);
      if (claim?.decided) {
        return err(
          "This day's expense claim has already been decided, so the distance under it cannot be changed here — the figures would move beneath somebody's signature. Reopen the day on the Expenses screen and correct it there; reopening asks for a reason and tells the salesman.",
          "conflict",
        );
      }

      /* Re-read the pair, because a correction to one end has to be checked
         against the other as it stands rather than as the screen last saw it. */
      const [leg] = await db.execute<{
        odometerStartKm: number | null;
        odometerEndKm: number | null;
      }>(sql`
        select l.odometer_start_km as "odometerStartKm",
               l.odometer_end_km as "odometerEndKm"
          from mbos_travel_legs l where l.id = ${ref.legId} limit 1
      `);
      const startKm = ref.end === "start" ? correctedKm : (leg?.odometerStartKm ?? null);
      const endKm = ref.end === "end" ? correctedKm : (leg?.odometerEndKm ?? null);

      /* The two checks the handset makes at the meter, made again here. A
         meter does not run backwards, and a leg longer than the configured
         ceiling is a digit rather than a long day. They are the salesman's
         guards and they are the office's too: a corrected figure is still a
         figure somebody typed. */
      if (startKm !== null && endKm !== null && endKm < startKm) {
        return err(
          `${endKm} km is lower than the ${startKm} km he set off on, and a meter does not run backwards.`,
          "validation",
          [{ field: "correctedKm", message: "Check the reading." }],
        );
      }
      const maxKm = (await getConfig())["mbos.travel.maxLegKilometres"];
      if (startKm !== null && endKm !== null && endKm - startKm > maxKm) {
        return err(
          `That makes the journey ${endKm - startKm} km, past the ${maxKm} km a single leg is allowed. It is nearly always a digit read wrong.`,
          "validation",
          [{ field: "correctedKm", message: "Check the reading." }],
        );
      }

      await db
        .update(mbosTravelLegs)
        .set({
          ...(ref.end === "start" ? { odometerStartKm: correctedKm } : { odometerEndKm: correctedKm }),
          updatedAt: new Date(),
          updatedById: user.id,
        })
        .where(eq(mbosTravelLegs.id, ref.legId));

      /* Measure, then price. `rescoreLeg` rebuilds the odometer distance and
         re-reads the trail; `repriceDay` rewrites what the lines are worth and
         deliberately leaves the submitted totals, the lock and the approval
         exactly where they were. */
      await rescoreLeg(ref.legId);
      if (legDayId) {
        await repriceDay(ownerId, day);
        repriced = true;
      }
    }

    /* ---- the verdict ---- */

    await db.execute(sql`
      insert into mbos_evidence_reviews
        (id, user_id, day, kind, source_ref, source_type, source_id,
         verdict, remark, reported_km, corrected_km, decided_by_id,
         decided_at, created_at, updated_at)
      values
        (${gen("evr")}, ${ownerId}, ${day}::date, ${ref.kind}::mbos_evidence_kind,
         ${input.ref}, ${sourceType}, ${sourceId},
         ${input.verdict}::mbos_evidence_verdict, ${remark}, ${reportedKm}, ${correctedKm},
         ${user.id}, now(), now(), now())
      on conflict (source_ref) do update set
        verdict = excluded.verdict,
        remark = excluded.remark,
        /* WRITTEN ONCE. The leg's own column has been overwritten, so this is
           the only surviving record of what the salesman actually typed, and a
           second correction must not restate the office's first answer as
           his. */
        reported_km = coalesce(mbos_evidence_reviews.reported_km, excluded.reported_km),
        corrected_km = excluded.corrected_km,
        decided_by_id = excluded.decided_by_id,
        decided_at = now(),
        updated_at = now()
    `);

    await db.insert(auditLog).values({
      id: gen("aud"),
      actorId: user.id,
      action: `mbos.evidence.${input.verdict}`,
      entityType: sourceType,
      entityId: sourceId,
      beforeState: (before[0] ?? null) as never,
      afterState: {
        sourceRef: input.ref,
        verdict: input.verdict,
        remark,
        correctedKm,
        repriced,
      } as never,
    });

    /* ---- and he is told ---- */

    if (input.verdict === "declined") {
      const what =
        ref.kind === "attendance_selfie"
          ? "Your attendance photograph was not accepted"
          : "Your odometer reading was not accepted";
      const corrected =
        correctedKm !== null
          ? ` The office has read the meter as ${correctedKm.toLocaleString("en-IN")} km${
              reportedKm !== null ? ` rather than the ${reportedKm.toLocaleString("en-IN")} km entered` : ""
            }, and the distance has been worked out again.`
          : "";
      await notifyUsers([
        {
          userId: ownerId,
          /* `warn` and not `warning`: the bell colours `warn` and `danger`,
             and the several callers spelling it the other way are drawn as
             ordinary notices. */
          kind: "warn",
          title: what,
          body: `${day} — ${remark}${corrected}`,
          href: "/apps",
          mbosHref: null,
        },
      ]);
    }

    refresh();
    try {
      revalidatePath("/sales/attendance");
      revalidatePath("/sales/travel");
      revalidatePath("/sales/expenses");
    } catch {
      /* no request context */
    }

    return okVoid(
      input.verdict === "accepted"
        ? "Accepted."
        : repriced
          ? "Declined — the reading was corrected and the day's travel priced again."
          : correctedKm !== null
            ? "Declined — the reading was corrected."
            : "Declined, and he has been told.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}
