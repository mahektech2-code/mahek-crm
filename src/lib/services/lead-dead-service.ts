import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  auditLog,
  customers,
  employeeReporting,
  employees,
  leadDeadRequests,
  notifications,
  users,
} from "@/db/schema";
import { getConfig } from "../config/store";
import { canOpen } from "../access";
import type { Hat } from "../access-control";
import { decideApprover, type ApproverDecision } from "../engines/dead-lead-approver";
import { deadRequestEligibility, type DeadRequestState } from "../lead-dead";
import { REASON_CODE_NEEDING_REMARKS } from "../lead-labels";
import { err, ok, type Result } from "../result";
import { MBOS_EVENT, writeTimelineEvent } from "../timeline";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * DEAD LEADS — the one implementation behind the request, the decision and
 * every list.
 *
 * Dead is a permanent subset of Lost. Nothing here moves a stage: approval sets
 * `customers.lead_dead_at` and the database (migration 0189) refuses every
 * later change to the row. This file is where the RULES are written in words;
 * the triggers are the net under them.
 *
 * THE APPROVER IS THE REPORTING MANAGER FROM THE ORG CHART, resolved and stored
 * when the request is raised — `users.employee_id` → `employee_reporting` →
 * that employee's linked user. If that cannot be resolved the request is not
 * written and the person is told an administrator has to correct the Org
 * Chart. Nobody else is ever asked instead, and nobody is broadcast to.
 * ------------------------------------------------------------------------- */

const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

/** Thrown inside a transaction so the whole write rolls back and the caller answers in words. */
class DeadRefusal extends Error {
  constructor(public readonly result: ReturnType<typeof err>) {
    super(result.error);
  }
}

/* ------------------------------------------------------------ the Org Chart */

export async function resolveDeadApprover(requesterUserId: string): Promise<ApproverDecision> {
  const [requester] = await db
    .select({ id: users.id, employeeId: users.employeeId })
    .from(users)
    .where(eq(users.id, requesterUserId))
    .limit(1);

  const requesterEmployeeId = requester?.employeeId ?? null;
  let managerEmployeeId: string | null = null;
  if (requesterEmployeeId) {
    const [link] = await db
      .select({ managerId: employeeReporting.managerId })
      .from(employeeReporting)
      .where(eq(employeeReporting.employeeId, requesterEmployeeId))
      .limit(1);
    managerEmployeeId = link?.managerId ?? null;
  }

  let managerEmployee: { id: string; name: string; active: boolean } | null = null;
  let managerUsers: Array<{ id: string; name: string; active: boolean; canDecide: boolean }> = [];
  if (managerEmployeeId) {
    const [m] = await db
      .select({
        id: employees.id,
        name: employees.name,
        status: employees.status,
        sheetStatus: employees.sheetStatus,
      })
      .from(employees)
      .where(eq(employees.id, managerEmployeeId))
      .limit(1);
    if (m) {
      managerEmployee = {
        id: m.id,
        name: m.name,
        /* The Org Chart's own definition of somebody still here. */
        active: m.status !== "inactive" && m.sheetStatus === "present",
      };
      const linked = await db
        .select({ id: users.id, name: users.name, active: users.active })
        .from(users)
        .where(eq(users.employeeId, m.id));
      managerUsers = await Promise.all(
        linked.map(async (u) => ({
          ...u,
          /* Able to decide means able to OPEN the CRM where the decision is
             made. It is the assignment that makes them the approver, not a
             capability: asking for a particular capability here would block
             requests for a reporting manager who is plainly the right person. */
          canDecide: await canOpen(u.id, "crm"),
        })),
      );
    }
  }

  return decideApprover({
    requesterUserId,
    requesterEmployeeId,
    managerEmployeeId,
    managerEmployee,
    managerUsers,
  });
}

/* ----------------------------------------------------------------- the facts */

export type DeadFactRow = {
  deadAt: Date | null;
  pendingRequestId: string | null;
};

/** Dead-ness and pending-ness of a set of leads, for the lists that draw the badge. */
export async function deadFactsFor(ids: string[]): Promise<Map<string, DeadFactRow>> {
  const out = new Map<string, DeadFactRow>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const rows = await db
    .select({ id: customers.id, deadAt: customers.leadDeadAt })
    .from(customers)
    .where(inArray(customers.id, unique));
  const pending = await db
    .select({ customerId: leadDeadRequests.customerId, id: leadDeadRequests.id })
    .from(leadDeadRequests)
    .where(and(inArray(leadDeadRequests.customerId, unique), eq(leadDeadRequests.state, "pending")));
  const pendingBy = new Map(pending.map((p) => [p.customerId, p.id]));
  for (const r of rows) {
    out.set(r.id, { deadAt: r.deadAt, pendingRequestId: pendingBy.get(r.id) ?? null });
  }
  return out;
}

/** The single-lead form. */
export async function deadFactsOf(id: string): Promise<DeadFactRow> {
  return (await deadFactsFor([id])).get(id) ?? { deadAt: null, pendingRequestId: null };
}

/** Is this lead permanently Dead? */
export async function isLeadDead(customerId: string): Promise<boolean> {
  return Boolean((await deadFactsOf(customerId)).deadAt);
}

/* --------------------------------------------------------------- the request */

export type RequestDeadInput = {
  actorUserId: string;
  /** The hat that carried `lead.work`, for the audit row. */
  hat: Hat | null;
  customerId: string;
  reasonCode: string;
  note?: string | null;
};

export async function requestLeadDead(input: RequestDeadInput): Promise<Result<{ requestId: string; approverName: string }>> {
  const config = await getConfig();
  const reason = config["leads.deadReasons"].find((r) => r.code === input.reasonCode);
  if (!reason) {
    return err("Pick one of the listed reasons for marking this lead Dead.", "validation", [
      { field: "reasonCode", message: "Why is it Dead?" },
    ]);
  }
  const note = input.note?.trim() || null;
  if (input.reasonCode === REASON_CODE_NEEDING_REMARKS && !note) {
    return err("You picked Other — say in words why this lead is Dead.", "validation", [
      { field: "note", message: "Say what it actually is." },
    ]);
  }

  const approver = await resolveDeadApprover(input.actorUserId);
  if (!approver.ok) return err(approver.message, "rule_violation");

  const requestId = newId("ldr");
  try {
    return await db.transaction(async (tx) => {
      /* The lock is what makes eligibility and the duplicate check race-free:
         two people pressing this at once serialise here, and the second reads
         the first's pending request. */
      const [lead] = await tx
        .select({
          name: customers.name,
          stage: customers.leadStage,
          deadAt: customers.leadDeadAt,
          lostReason: customers.leadLostReason,
        })
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .for("update");
      if (!lead) throw new DeadRefusal(err("That lead is not on MahekOne.", "not_found"));

      const [pending] = await tx
        .select({ id: leadDeadRequests.id })
        .from(leadDeadRequests)
        .where(and(eq(leadDeadRequests.customerId, input.customerId), eq(leadDeadRequests.state, "pending")))
        .limit(1);
      const eligibility = deadRequestEligibility({
        stage: lead.stage,
        deadAt: lead.deadAt,
        pending: Boolean(pending),
      });
      if (!eligibility.offer) throw new DeadRefusal(err(eligibility.reason, "rule_violation"));

      /* The rung it was lost from, as the closing transition recorded it. */
      const closing = await tx.execute<{ from_stage: string | null }>(sql`
        select from_stage::text as from_stage
          from lead_stage_transitions
         where customer_id = ${input.customerId} and to_stage = 'lost'
         order by at desc, id desc limit 1
      `);

      const [requesterEmp] = await tx
        .select({ employeeId: users.employeeId, name: users.name })
        .from(users)
        .where(eq(users.id, input.actorUserId))
        .limit(1);

      await tx.insert(leadDeadRequests).values({
        id: requestId,
        customerId: input.customerId,
        requestedById: input.actorUserId,
        reasonCode: input.reasonCode,
        note,
        approverId: approver.approverUserId,
        requesterEmployeeId: requesterEmp?.employeeId ?? null,
        approverEmployeeId: approver.approverEmployeeId,
        lostReasonAtRequest: lead.lostReason,
        lostFromStageAtRequest: closing[0]?.from_stage ?? null,
      });

      /* ONLY the assigned manager is told. */
      await tx.insert(notifications).values({
        id: newId("ntf"),
        userId: approver.approverUserId,
        title: `Dead request: ${lead.name}`,
        body: `${requesterEmp?.name ?? "A colleague"} asked to mark ${lead.name} permanently Dead (${reason.label}). Approving locks the lead for ever.`,
        kind: "warn",
        href: "/crm/leads/dead?tab=queue",
      });

      await tx.insert(auditLog).values({
        id: newId("aud"),
        actorId: input.actorUserId,
        action: "lead.dead.request",
        entityType: "customer",
        entityId: input.customerId,
        actorRole: input.hat?.role ?? null,
        actorApp: input.hat?.app ?? null,
        beforeState: { dead: false } as never,
        afterState: {
          requestId,
          reasonCode: input.reasonCode,
          approverId: approver.approverUserId,
          approverEmployeeId: approver.approverEmployeeId,
        } as never,
      });

      await writeTimelineEvent(tx, {
        customerId: input.customerId,
        eventType: MBOS_EVENT.leadDead,
        sourceApp: "crm",
        sourceRecordId: `${requestId}:requested`,
        occurredAt: new Date(),
        actorUserId: input.actorUserId,
        summary: `Marked Dead requested — ${reason.label}. Waiting on ${approver.approverName}.`,
      });

      return ok({ requestId, approverName: approver.approverName }, `Sent to ${approver.approverName} for approval.`);
    });
  } catch (e) {
    if (e instanceof DeadRefusal) return e.result;
    /* The partial unique index is the guard of last resort for two requests
       that raced past the check above. */
    if (isUniqueViolation(e, "lead_dead_requests_one_pending_key")) {
      return err("A request to mark this lead Dead is already waiting on its manager.", "duplicate");
    }
    throw e;
  }
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const cause = (e as { cause?: { code?: string; constraint_name?: string } })?.cause ?? (e as { code?: string; constraint_name?: string });
  return cause?.code === "23505" && (cause?.constraint_name === constraint || String((e as Error)?.message).includes(constraint));
}

/* --------------------------------------------------------------- the decision */

export type DecideDeadInput = {
  actorUserId: string;
  hat: Hat | null;
  requestId: string;
  approve: boolean;
  /** Mandatory on a rejection. */
  note?: string | null;
};

export async function decideLeadDead(input: DecideDeadInput): Promise<Result<null>> {
  const note = input.note?.trim() || null;
  if (!input.approve && !note) {
    return err("Say why you are rejecting it — the person who asked is told your reason.", "validation", [
      { field: "note", message: "A rejection needs a reason." },
    ]);
  }

  try {
    return await db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(leadDeadRequests)
        .where(eq(leadDeadRequests.id, input.requestId))
        .for("update");
      if (!request) throw new DeadRefusal(err("That request no longer exists.", "not_found"));
      if (request.state === "withdrawn") {
        throw new DeadRefusal(err("That request was withdrawn by the person who asked, so there is nothing to decide.", "conflict"));
      }
      if (request.state !== "pending") {
        throw new DeadRefusal(err("That request has already been decided.", "conflict"));
      }
      /* ONLY THE ASSIGNED MANAGER. Not an admin, not another manager, not the
         requester — the approver was fixed from the Org Chart when it was
         raised. */
      if (request.approverId !== input.actorUserId) {
        throw new DeadRefusal(err("This request is assigned to another manager, so only they can decide it.", "not_permitted"));
      }
      if (request.requestedById === input.actorUserId) {
        throw new DeadRefusal(err("You cannot decide a request you raised yourself.", "not_permitted"));
      }

      const [lead] = await tx
        .select({
          name: customers.name,
          stage: customers.leadStage,
          deadAt: customers.leadDeadAt,
        })
        .from(customers)
        .where(eq(customers.id, request.customerId))
        .for("update");
      if (!lead) throw new DeadRefusal(err("That lead is no longer on MahekOne.", "not_found"));
      if (input.approve && (lead.stage !== "lost" || lead.deadAt)) {
        throw new DeadRefusal(
          err("This lead is no longer Lost (or is already Dead), so the request cannot be approved.", "conflict"),
        );
      }

      const now = new Date();
      await tx
        .update(leadDeadRequests)
        .set({
          state: input.approve ? "approved" : "rejected",
          decidedById: input.actorUserId,
          decidedAt: now,
          decisionNote: note,
        })
        .where(eq(leadDeadRequests.id, request.id));

      if (input.approve) {
        await tx
          .update(customers)
          .set({
            leadDeadAt: now,
            leadDeadById: input.actorUserId,
            leadDeadRequestId: request.id,
            updatedAt: now,
          })
          .where(eq(customers.id, request.customerId));
      }

      const config = await getConfig();
      const reasonLabel =
        config["leads.deadReasons"].find((r) => r.code === request.reasonCode)?.label ?? request.reasonCode;

      await tx.insert(auditLog).values({
        id: newId("aud"),
        actorId: input.actorUserId,
        action: input.approve ? "lead.dead.approve" : "lead.dead.reject",
        entityType: "customer",
        entityId: request.customerId,
        actorRole: input.hat?.role ?? null,
        actorApp: input.hat?.app ?? null,
        beforeState: { dead: false, requestId: request.id } as never,
        afterState: { dead: input.approve, requestId: request.id, note } as never,
      });

      await writeTimelineEvent(tx, {
        customerId: request.customerId,
        eventType: MBOS_EVENT.leadDead,
        sourceApp: "crm",
        sourceRecordId: `${request.id}:${input.approve ? "approved" : "rejected"}`,
        occurredAt: now,
        actorUserId: input.actorUserId,
        summary: input.approve
          ? `Marked permanently Dead — ${reasonLabel}. Approved by the reporting manager.`
          : `Dead request rejected${note ? `: ${note}` : ""}. The lead stays Lost.`,
      });

      await tx.insert(notifications).values({
        id: newId("ntf"),
        userId: request.requestedById,
        title: input.approve ? `${lead.name} is now Dead` : `Dead request rejected: ${lead.name}`,
        body: input.approve
          ? `Your request was approved. ${lead.name} is permanently Dead and read-only.`
          : `Your request was rejected${note ? `: ${note}` : ""}. ${lead.name} is unchanged — you can ask again.`,
        kind: input.approve ? "info" : "warn",
        href: `/crm/leads/${request.customerId}`,
      });

      return ok(null, input.approve ? "Approved — the lead is now permanently Dead." : "Rejected — the lead is unchanged.");
    });
  } catch (e) {
    if (e instanceof DeadRefusal) return e.result;
    throw e;
  }
}

/* --------------------------------------------------------------- the withdrawal */

export type WithdrawDeadInput = {
  actorUserId: string;
  hat: Hat | null;
  requestId: string;
};

/**
 * THE PERSON WHO ASKED TAKES THE REQUEST BACK, before a decision.
 *
 * Only the requester may; the approver decides, the requester withdraws, and
 * nobody else does either. It runs under the SAME row lock the decision does,
 * so a withdrawal and an approval racing each other serialise: the first closes
 * the request and the second reads it already closed and is told so — a lead is
 * never made Dead by an approval that lost the race to a withdrawal. The lead is
 * left exactly as it was (Lost), the request is kept in the history as
 * `withdrawn`, and only the approver it was routed to is told.
 */
export async function withdrawLeadDead(input: WithdrawDeadInput): Promise<Result<null>> {
  try {
    return await db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(leadDeadRequests)
        .where(eq(leadDeadRequests.id, input.requestId))
        .for("update");
      if (!request) throw new DeadRefusal(err("That request no longer exists.", "not_found"));
      if (request.requestedById !== input.actorUserId) {
        throw new DeadRefusal(err("Only the person who asked can withdraw a Dead request.", "not_permitted"));
      }
      if (request.state !== "pending") {
        throw new DeadRefusal(
          err(
            request.state === "withdrawn"
              ? "You have already withdrawn this request."
              : request.state === "approved"
                ? "The manager approved this request before you withdrew it, so the lead is now permanently Dead."
                : "The manager has already decided this request.",
            "conflict",
          ),
        );
      }

      const [lead] = await tx
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, request.customerId));
      const now = new Date();
      await tx
        .update(leadDeadRequests)
        .set({ state: "withdrawn", decidedById: input.actorUserId, decidedAt: now })
        .where(eq(leadDeadRequests.id, request.id));

      await tx.insert(auditLog).values({
        id: newId("aud"),
        actorId: input.actorUserId,
        action: "lead.dead.withdraw",
        entityType: "customer",
        entityId: request.customerId,
        actorRole: input.hat?.role ?? null,
        actorApp: input.hat?.app ?? null,
        beforeState: { requestId: request.id, state: "pending" } as never,
        afterState: { requestId: request.id, state: "withdrawn" } as never,
      });

      await writeTimelineEvent(tx, {
        customerId: request.customerId,
        eventType: MBOS_EVENT.leadDead,
        sourceApp: "crm",
        sourceRecordId: `${request.id}:withdrawn`,
        occurredAt: now,
        actorUserId: input.actorUserId,
        summary: "Dead request withdrawn by the person who asked. The lead stays Lost.",
      });

      await tx.insert(notifications).values({
        id: newId("ntf"),
        userId: request.approverId,
        title: `Dead request withdrawn: ${lead?.name ?? "a lead"}`,
        body: `The request to mark ${lead?.name ?? "a lead"} Dead was withdrawn, so there is nothing for you to decide.`,
        kind: "info",
        href: "/crm/leads/dead?tab=mine",
      });

      return ok(null, "Request withdrawn — the lead is unchanged.");
    });
  } catch (e) {
    if (e instanceof DeadRefusal) return e.result;
    throw e;
  }
}

/* ------------------------------------------------------------------ the reads */

export type DeadRequestRow = {
  id: string;
  customerId: string;
  leadName: string;
  companyName: string | null;
  city: string | null;
  requestedById: string;
  requestedByName: string | null;
  requestedAt: string;
  reasonCode: string;
  note: string | null;
  approverId: string;
  approverName: string | null;
  state: DeadRequestState;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  lostReasonAtRequest: string | null;
  lostFromStageAtRequest: string | null;
};

const REQUEST_SELECT = sql`
  select r.id, r.customer_id as "customerId", c.name as "leadName",
         c.company_name as "companyName", c.city,
         r.requested_by_id as "requestedById", rq.name as "requestedByName",
         r.requested_at::text as "requestedAt", r.reason_code as "reasonCode", r.note,
         r.approver_id as "approverId", ap.name as "approverName",
         r.state, dc.name as "decidedByName", r.decided_at::text as "decidedAt",
         r.decision_note as "decisionNote",
         r.lost_reason_at_request as "lostReasonAtRequest",
         r.lost_from_stage_at_request as "lostFromStageAtRequest"
    from lead_dead_requests r
    join customers c on c.id = r.customer_id
    left join users rq on rq.id = r.requested_by_id
    left join users ap on ap.id = r.approver_id
    left join users dc on dc.id = r.decided_by_id
`;

/** Requests waiting on THIS manager — and nobody else's. */
export async function deadQueueFor(userId: string): Promise<DeadRequestRow[]> {
  const rows = await db.execute<DeadRequestRow>(sql`
    ${REQUEST_SELECT}
    where r.approver_id = ${userId} and r.state = 'pending'
    order by r.requested_at asc
  `);
  return rows as unknown as DeadRequestRow[];
}

/** Everything this person is party to — asked by them, or assigned to them — newest first. */
export async function deadRequestHistoryFor(userId: string, limit = 100): Promise<DeadRequestRow[]> {
  const rows = await db.execute<DeadRequestRow>(sql`
    ${REQUEST_SELECT}
    where r.approver_id = ${userId} or r.requested_by_id = ${userId}
    order by r.requested_at desc
    limit ${limit}
  `);
  return rows as unknown as DeadRequestRow[];
}

/** The whole request history of one lead, for its record. */
export async function deadRequestsOfLead(customerId: string): Promise<DeadRequestRow[]> {
  const rows = await db.execute<DeadRequestRow>(sql`
    ${REQUEST_SELECT}
    where r.customer_id = ${customerId}
    order by r.requested_at desc
  `);
  return rows as unknown as DeadRequestRow[];
}

/** Does this person appear on any request, as the asker or the approver? */
export async function partyToAnyDeadRequest(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: leadDeadRequests.id })
    .from(leadDeadRequests)
    .where(sql`${leadDeadRequests.requestedById} = ${userId} or ${leadDeadRequests.approverId} = ${userId}`)
    .limit(1);
  return Boolean(row);
}

export type DeadLeadRow = {
  id: string;
  name: string;
  companyName: string | null;
  city: string | null;
  mobile: string | null;
  ownerId: string | null;
  ownerName: string | null;
  deadAt: string;
  deadReasonCode: string | null;
  deadNote: string | null;
  requestedByName: string | null;
  requestedAt: string | null;
  approvedByName: string | null;
  lostReason: string | null;
  lostFromStage: string | null;
};

export const DEAD_LEADS_PER_PAGE = 15;

/** Approved Dead leads only, narrowed exactly like the Lost list is. */
export async function deadLeadsPage(
  options: { search?: string; page?: number; perPage?: number } = {},
): Promise<{ rows: DeadLeadRow[]; total: number; page: number; pageCount: number; perPage: number }> {
  const scope = await managerScope();
  const perPage = Math.min(Math.max(options.perPage ?? DEAD_LEADS_PER_PAGE, 1), 200);

  const words = (options.search ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const narrowed = words.length
    ? sql.join(
        words.map((w) => {
          const like = `%${w.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
          return sql`and concat_ws(' ', c.name, c.company_name, c.phone, c.city, u.name) ilike ${like}`;
        }),
        sql` `,
      )
    : sql``;

  const base = sql`
    from customers c
    join lead_dead_requests r on r.id = c.lead_dead_request_id
    left join users u on u.id = c.owner_id
    left join users rq on rq.id = r.requested_by_id
    left join users ap on ap.id = r.decided_by_id
    where c.lead_dead_at is not null ${leadsVisible(scope)}
  `;

  const [count] = await db.execute<{ total: number }>(sql`select count(*)::int as total ${base} ${narrowed}`);
  const total = Number(count?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(options.page ?? 1, 1), pageCount);

  const rows = await db.execute<DeadLeadRow>(sql`
    select c.id, c.name, c.company_name as "companyName", c.city, c.phone as mobile,
           c.owner_id as "ownerId", u.name as "ownerName",
           c.lead_dead_at::text as "deadAt",
           r.reason_code as "deadReasonCode", r.note as "deadNote",
           rq.name as "requestedByName", r.requested_at::text as "requestedAt",
           ap.name as "approvedByName",
           r.lost_reason_at_request as "lostReason",
           r.lost_from_stage_at_request as "lostFromStage"
    ${base} ${narrowed}
    order by c.lead_dead_at desc, c.id desc
    limit ${perPage} offset ${(page - 1) * perPage}
  `);

  return { rows: rows as unknown as DeadLeadRow[], total, page, pageCount, perPage };
}

/* ----------------------------------------------------------- imports skip it */

/**
 * EVERY PERMANENTLY DEAD LEAD, as a set — what an import asks before it writes.
 *
 * Dead leads are few and the set is read once per run. The database refuses a
 * write to one (migration 0189), and a refusal inside a batch statement fails
 * the whole batch; so an import that could meet one asks first, SKIPS the
 * record, says so, and carries on with the rest.
 */
export async function deadLeadIds(): Promise<Set<string>> {
  const rows = await db.select({ id: customers.id }).from(customers).where(sql`${customers.leadDeadAt} is not null`);
  return new Set(rows.map((r) => r.id));
}

export type DeadSkip = { customerId: string; name?: string | null; what: string };

/**
 * ONE audit row per run saying which records were skipped and why — the
 * "reported clearly" half. The counts also travel in each import's own report
 * (`skipped`, `heldReasons`), which is what the Admin Console prints; this
 * row is the list behind the count, so "which shop was it" has an answer.
 */
export async function recordDeadSkips(source: string, skips: DeadSkip[]): Promise<void> {
  if (!skips.length) return;
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: null,
    action: "lead.import.skipped_dead",
    entityType: "import",
    entityId: source,
    beforeState: null as never,
    afterState: { source, count: skips.length, records: skips.slice(0, 200) } as never,
  });
}

export const DEAD_SKIP_REASON = "matches a permanently Dead lead — left unchanged";
