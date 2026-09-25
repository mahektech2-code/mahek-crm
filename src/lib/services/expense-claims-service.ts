import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { managerScope, onlyMine } from "./sales-service";

/* ---------------------------------------------------------------------------
 * A submitted day as the person deciding it sees it.
 *
 * One row per day rather than per line, because a day is what is submitted,
 * what is locked and what `mbos_approvals` now names — and because deciding
 * line by line is what requirement 45 exists to stop. The lines are still
 * there and still readable; they are just not the unit of the decision.
 * ------------------------------------------------------------------------- */

export type ClaimDayRow = {
  dayId: string;
  userId: string;
  userName: string;
  day: string;
  submittedAt: Date | null;
  lockedAt: Date | null;
  reopenedAt: Date | null;
  claimedPaise: number;
  eligiblePaise: number;
  excessPaise: number;
  travelPaise: number;
  foodPaise: number;
  lodgingPaise: number;
  otherPaise: number;
  metres: number;
  legCount: number;
  /** The state of the HIGHEST step — see the note on `mbos_approvals`. */
  approvalState: string | null;
  approvedAmountPaise: number | null;
  decisionNote: string | null;
  decidedByName: string | null;
  routeReason: string | null;
  stepCount: number;
  pendingSteps: number;
  openExceptions: number;
  worstSeverity: string | null;
  /** Month-to-date claimed by this person, so a cap means something. */
  monthToDatePaise: number;
};

export async function claimDays(opts: { from: string; to: string }): Promise<ClaimDayRow[]> {
  const scope = await managerScope();
  return db.execute<ClaimDayRow>(sql`
    select d.id as "dayId", d.user_id as "userId", u.name as "userName",
           d.day::text as day,
           d.submitted_at as "submittedAt", d.locked_at as "lockedAt",
           d.reopened_at as "reopenedAt",

           coalesce((select sum(e.amount_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.superseded_by_id is null), 0)
             as "claimedPaise",
           coalesce((select sum(e.eligible_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.superseded_by_id is null), 0)
             as "eligiblePaise",
           coalesce((select sum(e.excess_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.superseded_by_id is null), 0)
             as "excessPaise",
           coalesce((select sum(e.eligible_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.kind = 'travel'
                        and e.superseded_by_id is null), 0) as "travelPaise",
           coalesce((select sum(e.eligible_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.kind = 'food'
                        and e.superseded_by_id is null), 0) as "foodPaise",
           coalesce((select sum(e.eligible_paise) from mbos_expenses e
                      where e.expense_day_id = d.id and e.kind = 'lodging'
                        and e.superseded_by_id is null), 0) as "lodgingPaise",
           coalesce((select sum(e.eligible_paise) from mbos_expenses e
                      where e.expense_day_id = d.id
                        and e.kind not in ('travel', 'food', 'lodging')
                        and e.superseded_by_id is null), 0) as "otherPaise",

           coalesce((select sum(l.chosen_metres)::int from mbos_travel_legs l
                      where l.expense_day_id = d.id), 0) as metres,
           (select count(*)::int from mbos_travel_legs l where l.expense_day_id = d.id)
             as "legCount",

           /* The HIGHEST step decides the day. Reading step 0 would call a day
              approved while the escalation above it is still waiting. */
           top.state::text as "approvalState",
           top.approved_amount_paise as "approvedAmountPaise",
           top.decision_note as "decisionNote",
           top.route_reason as "routeReason",
           dec.name as "decidedByName",
           coalesce(steps.total, 0) as "stepCount",
           coalesce(steps.pending, 0) as "pendingSteps",

           (select count(*)::int from mbos_expense_exceptions x
             where x.expense_day_id = d.id and x.resolved_at is null) as "openExceptions",
           (select min(case x.severity when 'block_route' then 'block_route'
                                        when 'warn' then 'warn' else 'info' end)
              from mbos_expense_exceptions x
             where x.expense_day_id = d.id and x.resolved_at is null) as "worstSeverity",

           coalesce((select sum(e2.amount_paise)
                       from mbos_expenses e2
                      where e2.user_id = d.user_id
                        and e2.superseded_by_id is null
                        and date_trunc('month', e2.expense_date)
                            = date_trunc('month', d.day)), 0) as "monthToDatePaise"

      from mbos_expense_days d
      join users u on u.id = d.user_id
      left join lateral (
        select a.state, a.approved_amount_paise, a.decision_note, a.route_reason,
               a.approver_user_id
          from mbos_approvals a
         where a.subject_type = 'mbos_expense_days' and a.subject_id = d.id
         order by a.step_index desc
         limit 1
      ) top on true
      left join lateral (
        select count(*)::int as total,
               count(*) filter (where a.state = 'pending')::int as pending
          from mbos_approvals a
         where a.subject_type = 'mbos_expense_days' and a.subject_id = d.id
      ) steps on true
      left join users dec on dec.id = top.approver_user_id
     where d.submitted_at is not null
       and d.day between ${opts.from}::date and ${opts.to}::date
       ${onlyMine(scope, "d.user_id")}
     order by d.day desc, u.name asc
  `);
}

/* ------------------------------------------------------ what a day is made of */

export type ClaimLineFile = { id: string; filename: string; contentType: string; gone: boolean };

export type ClaimLine = {
  id: string;
  kind: string;
  claimedPaise: number;
  eligiblePaise: number | null;
  remarks: string | null;
  vendorName: string | null;
  billNumber: string | null;
  /** Every file filed under the claim — a bill is often two photographs. */
  files: ClaimLineFile[];
};

/**
 * The claims behind one day, with the bills behind each claim.
 *
 * The Decide dialog used to show a day as two totals and nothing else, so a
 * manager approved or cut a day's money without one bill in front of them —
 * the bills were stored and could not be seen. Scoped by the same
 * `managerScope` the day list is, so an id typed into a request reaches only a
 * day the list would have drawn. Null where it would not.
 */
export async function claimLinesForDay(dayId: string): Promise<ClaimLine[] | null> {
  const scope = await managerScope();
  const [day] = await db.execute<{ userId: string }>(sql`
    select d.user_id as "userId" from mbos_expense_days d where d.id = ${dayId}
  `);
  if (!day) return null;
  if (scope.salesmanIds !== null && !scope.salesmanIds.includes(day.userId)) return null;

  const lines = await db.execute<{
    id: string;
    kind: string;
    claimedPaise: number | string;
    eligiblePaise: number | string | null;
    remarks: string | null;
    vendorName: string | null;
    billNumber: string | null;
  }>(sql`
    select e.id, coalesce(e.kind, e.category::text) as kind,
           e.amount_paise as "claimedPaise", e.eligible_paise as "eligiblePaise",
           e.remarks, e.vendor_name as "vendorName", e.bill_number as "billNumber"
      from mbos_expenses e
     where e.expense_day_id = ${dayId}
       and e.superseded_by_id is null
     order by e.expense_date, e.id
  `);
  if (!lines.length) return [];

  const ids = lines.map((l) => l.id);
  const files = await db.execute<{
    parentId: string;
    id: string;
    filename: string;
    contentType: string;
    status: string;
  }>(sql`
    select a.parent_id as "parentId", a.id, a.filename, a.content_type as "contentType",
           a.status::text as status
      from attachments a
     where a.parent_type = 'mbos_expense'
       and a.parent_id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}
     order by a.created_at, a.id
  `);

  return lines.map((l) => ({
    id: l.id,
    kind: l.kind,
    claimedPaise: Number(l.claimedPaise),
    eligiblePaise: l.eligiblePaise == null ? null : Number(l.eligiblePaise),
    remarks: l.remarks,
    vendorName: l.vendorName,
    billNumber: l.billNumber,
    files: files
      .filter((f) => f.parentId === l.id)
      .map((f) => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        gone: f.status === "removed",
      })),
  }));
}
