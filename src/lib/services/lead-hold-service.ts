import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { asDate } from "../business-date";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * THE PARKED BOOK — every lead somebody stopped, and the day it comes back.
 *
 * On Hold is a PAUSE and not a quiet death. That is the whole distinction it
 * exists for: `lost` means nobody rings again and the reason is the only thing
 * the lead is still worth, while a park is a live prospect stopped by something
 * outside the sale — a plant shutdown, a budget quarter, a decision maker
 * abroad — and somebody is going to look again. The rule only holds if
 * somebody actually does, which is what this file is for.
 *
 * **A DATE NOBODY READS IS THE SENTENCE IT REPLACED.** `lead_hold_resume_date`
 * was added because "back after Diwali" written into the reason is a sentence
 * nobody is watching, and a parked lead stayed parked until somebody happened
 * to scroll past it. Stored as a date and read by no screen, it is exactly the
 * same failure in a column — and worse, because a column looks like the problem
 * was solved. `customers_lead_hold_resume_idx` is a partial index over precisely
 * this query; it was built for a reader that did not exist yet.
 *
 * **THE RUNG IT WAS PARKED FROM IS NOT ON THE CUSTOMER ROW.** A lead has ONE
 * stage column and `on_hold` takes it, so once a lead at Qualification is
 * parked the only surviving record that it was ever at Qualification is the
 * `from_stage` of the transition that parked it — see `isParked` in
 * `engines/lead-ladder.ts`, which says so in as many words and is why `bandOf`
 * refuses to guess a band for a parked lead. A manager deciding whether to
 * reopen one needs that rung: coming back is a move to a NAMED rung, and a list
 * that could not say which would be a list of leads nobody can act on. It comes
 * from a LATERAL over `lead_stage_transitions`, newest park first, because a
 * lead is routinely parked, reopened and parked again and it is the LAST park
 * that says where this one stopped.
 *
 * `from_stage` can itself be null — a park recorded with no rung to return to —
 * and that is a different fact from a lead that is not parked at all. The
 * screen draws them differently rather than folding the second into the first.
 *
 * Scope is resolved HERE and never passed in, like every other read in this
 * workspace: a call site that can forget the filter is a filter that will be
 * forgotten, and a forgotten one is silent and shows a regional manager the
 * whole country. Every column of the outer table is qualified, because Drizzle
 * renders a bare column name and a bare name inside the lateral would bind to
 * `lead_stage_transitions` and silently make the correlation false.
 * ------------------------------------------------------------------------- */

export type ParkedLeadRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  /** Free text — what somebody typed when they stopped it. Never a code. */
  holdReason: string | null;
  /** A stored DATE, carried as a string. Null on a park made before the column. */
  resumeDate: string | null;
  /**
   * Days PAST the resume date, and null where it has not arrived. Not negative
   * where it is still ahead: "due in 9 days" and "9 days late" are two
   * different sentences and one signed number renders as neither.
   */
  overdueDays: number | null;
  /** Days until it is due, where it is still ahead. The mirror of the above. */
  dueInDays: number | null;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerName: string | null;
  /** The rung the parking transition came FROM. Null where none was recorded. */
  parkedFrom: LeadStage | null;
  parkedAt: Date | null;
  parkedByName: string | null;
  /** §24's three answers, as they stood when it was parked. */
  nextAction: string | null;
  nextActionDate: string | null;
  nextActionOwnerName: string | null;
};

export type ParkedLeads = {
  rows: ParkedLeadRow[];
  total: number;
  /** Parked leads whose day has come or gone. The point of the screen. */
  due: number;
  /** Parked with no resume date at all — the failure the date column ended. */
  undated: number;
};

/**
 * Every parked lead in scope, worst first.
 *
 * **The ordering is the argument.** A park with NO resume date sorts above
 * everything, because it is not late by any amount somebody can read — it is a
 * lead that was stopped with nothing saying when anybody looks again, which is
 * the precise state the resume date was added to end, and burying it below a
 * lead three days overdue is how it stays buried. Below that it is the resume
 * date ascending, so the longest-overdue is next and the soonest-due last: one
 * sort, reading straight down from "nobody is watching this" through "this was
 * due in March" to "this comes back on Friday".
 *
 * It is NOT capped. Every other worklist here takes a limit because a book of
 * four hundred is a page nobody reads, and this one is a list that should be
 * short by construction: a park is a deliberate act on one lead, and a team
 * that has parked two hundred has a problem the screen should show rather than
 * a page it should truncate.
 */
export async function parkedLeads(day: string): Promise<ParkedLeads> {
  const scope = await managerScope();

  const rows = (await db.execute(sql`
    select c.id as "customerId", c.name, c.company_name as "companyName", c.city,
           c.lead_sales_type::text as "salesType",
           c.lead_hold_reason as "holdReason",
           c.lead_hold_resume_date::text as "resumeDate",
           case when c.lead_hold_resume_date <= ${day}::date
                then (${day}::date - c.lead_hold_resume_date)::int end as "overdueDays",
           case when c.lead_hold_resume_date > ${day}::date
                then (c.lead_hold_resume_date - ${day}::date)::int end as "dueInDays",
           c.owner_id as "salesmanId", u.name as "salesmanName",
           m.name as "leadManagerName",
           p.from_stage as "parkedFrom", p.at as "parkedAt", p.actor_name as "parkedByName",
           c.lead_next_action as "nextAction",
           c.lead_next_action_date::text as "nextActionDate",
           n.name as "nextActionOwnerName"
      from customers c
      left join users u on u.id = c.owner_id
      left join users m on m.id = c.lead_manager_id
      left join users n on n.id = c.lead_next_action_owner_id
      left join lateral (
        select t.from_stage::text as from_stage, t.at, a.name as actor_name
          from lead_stage_transitions t
          left join users a on a.id = t.actor_id
         where t.customer_id = c.id
           and t.to_stage = 'on_hold'
         order by t.at desc, t.id desc
         limit 1
      ) p on true
     where c.lead_stage = 'on_hold'
       and c.lead_archived = false
       ${leadsVisible(scope)}
     order by (c.lead_hold_resume_date is null) desc,
              c.lead_hold_resume_date asc,
              c.id asc
  `)) as unknown as Record<string, unknown>[];

  /* `db.execute` hands back a string where the type says Date — the driver
     reports what the wire carried, not what the column is — so the instant is
     resolved once here rather than in a component that would have to guess. */
  const parked: ParkedLeadRow[] = rows.map((r) => ({
    customerId: String(r.customerId),
    name: String(r.name),
    companyName: (r.companyName as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    salesType: (r.salesType as LeadSalesType | null) ?? null,
    holdReason: (r.holdReason as string | null) ?? null,
    resumeDate: (r.resumeDate as string | null) ?? null,
    overdueDays: r.overdueDays === null || r.overdueDays === undefined ? null : Number(r.overdueDays),
    dueInDays: r.dueInDays === null || r.dueInDays === undefined ? null : Number(r.dueInDays),
    salesmanId: (r.salesmanId as string | null) ?? null,
    salesmanName: (r.salesmanName as string | null) ?? null,
    leadManagerName: (r.leadManagerName as string | null) ?? null,
    parkedFrom: (r.parkedFrom as LeadStage | null) ?? null,
    parkedAt: asDate(r.parkedAt),
    parkedByName: (r.parkedByName as string | null) ?? null,
    nextAction: (r.nextAction as string | null) ?? null,
    nextActionDate: (r.nextActionDate as string | null) ?? null,
    nextActionOwnerName: (r.nextActionOwnerName as string | null) ?? null,
  }));

  return {
    rows: parked,
    total: parked.length,
    due: parked.filter((r) => r.overdueDays !== null).length,
    undated: parked.filter((r) => r.resumeDate === null).length,
  };
}

/**
 * How many parked leads are asking for an answer TODAY, for the tab badge.
 *
 * Deliberately the DUE count rather than the total. A badge is read as "this
 * many things want you", and a team that has parked forty leads correctly, none
 * of them due, would carry a permanent forty on the tab — which is how a badge
 * stops meaning anything. Undated parks are counted in it because nobody can
 * say they are not due.
 */
export async function parkedLeadsDueCount(day: string): Promise<number> {
  const scope = await managerScope();
  const rows = await db.execute<{ due: number }>(sql`
    select count(*)::int as due
      from customers c
     where c.lead_stage = 'on_hold'
       and c.lead_archived = false
       and (c.lead_hold_resume_date is null or c.lead_hold_resume_date <= ${day}::date)
       ${leadsVisible(scope)}
  `);
  return Number(rows[0]?.due ?? 0);
}
