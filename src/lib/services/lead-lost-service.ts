import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { LEGACY_SALES_TYPE, UNASSIGNED, splitFilter, type FilterOption } from "../lead-filters";
import { stageLabel, type LeadSalesType, type LeadStage } from "../lead-labels";
import { startOfMonth, startOfWeek, type BusinessDate } from "../business-date";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * LEAD MANAGEMENT → LOST — the central record of every lead closed lost,
 * whatever rung it was lost from.
 *
 * §26 already models a loss as a terminal stage on the SAME `customers` row
 * (`lead_stage = 'lost'`), with the reason on `lead_lost_reason` and the full
 * audit trail in `lead_stage_transitions` — see the long note on `evaluate-
 * LeadStageMove` and `applyLeadStageMove` in `lead-service.ts`. Nothing here
 * writes any of that or duplicates the lead record; this is a read of the same
 * rows, filtered to the ones that closed lost, with the one fact §26 does not
 * carry on the customer row itself: WHICH RUNG it was lost from.
 *
 * That fact only exists in the transition table — the row where
 * `to_stage = 'lost'` — so every read here joins the CLOSING transition
 * (`to_stage = 'lost'`, newest first, per lead) rather than trusting a column
 * that was never written. A lead with no such row — raised and lost before the
 * transitions table existed — shows "Not recorded" rather than a guessed
 * stage: AGENTS.md's own rule for every derived figure in this codebase is
 * that a legacy gap is said in words, never invented.
 *
 * SCOPED LIKE EVERY OTHER LEAD LIST. `managerScope` and `leadsVisible` are the
 * same narrowing `leadsPage` and `leadTileCounts` run through, so a lead
 * nobody may see on the working list cannot be seen here either — a view can
 * only remove rows from what that already allows, never add to it.
 *
 * IN RAW SQL, QUALIFY EVERY COLUMN OF THE OUTER TABLE, for the reason
 * `lead-views-service.ts` states at length: Drizzle renders a bare `"id"` for
 * `${customers.id}`, and inside the correlated/lateral join below that binds
 * to the WRONG table and silently makes the condition false. Every reference
 * is spelled `c.` or `lt.` for that reason.
 * ------------------------------------------------------------------------- */

export type LostLeadRow = {
  id: string;
  name: string;
  companyName: string | null;
  mobile: string | null;
  city: string | null;
  area: string | null;
  salesType: LeadSalesType | null;
  ownerId: string | null;
  ownerName: string | null;
  /** A code from `LOST_REASONS` — see `lib/lead-labels.ts`. */
  lostReason: string | null;
  /**
   * The day the lead reached `lost` — `lead_stage_since`, the same column
   * `lost30` already ages by, and for the same reason: it is the day the lead
   * arrived at the rung it is on, which for a lost lead is the day it closed.
   * Null on a legacy row this column predates.
   */
  lostDate: string | null;
  /**
   * §— STAGE AT LOSS: the rung this lead was on the moment before it closed,
   * read off the closing transition's `from_stage`. Null where no such
   * transition exists — a legacy lead raised and lost before the transitions
   * table did, and shown as "Not recorded" rather than guessed.
   */
  fromStage: LeadStage | null;
  /** Who moved it to `lost`. Null where the closing transition names nobody. */
  lostByName: string | null;
  lastActivityDate: string | null;
};

export type LostLeadFilters = {
  /** Matched across the name, the shop, the phone, the town and the owner. */
  search?: string;
  owner?: string;
  /** §3.2's three ladders, and the fourth answer that is not one — see `lead-filters.ts`. */
  salesType?: string;
  /** The rung it was lost FROM, `,`-separated `LeadStage` values. */
  fromStage?: string;
  /** `,`-separated codes from `LOST_REASONS`. */
  reason?: string;
  /** `lead_stage_since >=`, inclusive. */
  lostFrom?: string;
  /** `lead_stage_since <=`, inclusive. */
  lostTo?: string;
};

export function anyLostFilterSet(f: LostLeadFilters): boolean {
  const { search, lostFrom, lostTo, ...ticked } = f;
  if (search?.trim()) return true;
  if (lostFrom || lostTo) return true;
  return Object.values(ticked).some((v) => splitFilter(v).length > 0);
}

/** Fifteen, matching `LEADS_PER_PAGE` — the rest are for a wide monitor. */
export const LOST_LEADS_PER_PAGE = 15;
const LOST_LEADS_PER_PAGE_MAX = 200;

export type LostLeadsPage = {
  rows: LostLeadRow[];
  /** Matching the filters. */
  total: number;
  /** The whole scoped Lost book, before any filter — "of 214". */
  listTotal: number;
  page: number;
  pageCount: number;
  perPage: number;
};

/** `from customers c … lt … la`, shared by the count and the page of rows. */
const LOST_LEAD_JOINS = sql`
    from customers c
    left join users u on u.id = c.owner_id
    left join lateral (
      select t.from_stage, t.actor_id
        from lead_stage_transitions t
       where t.customer_id = c.id and t.to_stage = 'lost'
       order by t.at desc
       limit 1
    ) lt on true
    left join users la on la.id = lt.actor_id
`;

function lostLeadFilterClause(filters: LostLeadFilters): SQL {
  const parts: SQL[] = [];

  /* Six words, the same cap `leadFilterClause` uses and for the same reason:
     past that it is not a search, and an unbounded loop here is an unbounded
     query. Escaped before it is bound, or `%`/`_` typed by a person become
     ILIKE's own wildcards. */
  for (const word of (filters.search ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
    const like = `%${word.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    parts.push(sql`and concat_ws(' ', c.name, c.company_name, c.phone, c.city, c.area,
                                 (select u2.name from users u2 where u2.id = c.owner_id))
                   ilike ${like}`);
  }

  const owners = splitFilter(filters.owner);
  if (owners.length) {
    const ids = owners.filter((o) => o !== UNASSIGNED);
    const clauses: SQL[] = [];
    if (ids.length) {
      clauses.push(sql`c.owner_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    }
    /* "Nobody" is its own clause: `in (…)` never matches NULL, and a lead
       lost with no owner still has to be findable. */
    if (ids.length !== owners.length) clauses.push(sql`c.owner_id is null`);
    parts.push(sql`and (${sql.join(clauses, sql` or `)})`);
  }

  const tracks = splitFilter(filters.salesType);
  if (tracks.length) {
    const named = tracks.filter((t) => t !== LEGACY_SALES_TYPE);
    const clauses: SQL[] = [];
    if (named.length) {
      clauses.push(
        sql`c.lead_sales_type::text in (${sql.join(named.map((v) => sql`${v}`), sql`, `)})`,
      );
    }
    if (named.length !== tracks.length) clauses.push(sql`c.lead_sales_type is null`);
    parts.push(sql`and (${sql.join(clauses, sql` or `)})`);
  }

  const stages = splitFilter(filters.fromStage);
  if (stages.length) {
    parts.push(
      sql`and lt.from_stage::text in (${sql.join(stages.map((v) => sql`${v}`), sql`, `)})`,
    );
  }

  const reasons = splitFilter(filters.reason);
  if (reasons.length) {
    parts.push(sql`and c.lead_lost_reason in (${sql.join(reasons.map((v) => sql`${v}`), sql`, `)})`);
  }

  if (filters.lostFrom) parts.push(sql`and c.lead_stage_since >= ${filters.lostFrom}::date`);
  if (filters.lostTo) parts.push(sql`and c.lead_stage_since <= ${filters.lostTo}::date`);

  return parts.length ? sql.join(parts, sql` `) : sql``;
}

/**
 * ONE PAGE of every lead closed lost — filtered, counted and paged in the
 * database, the same discipline `leadsPage` follows and for the same reason:
 * this book only grows, and rendering all of it in a browser is the mistake
 * that screen was rewritten to stop making.
 *
 * DELIBERATELY NOT FILTERED ON `lead_archived`. Archiving is a manager's own,
 * separate decision to file a record out of the working list; being lost is a
 * fact about the funnel. A lead archived years ago is still a lead this
 * screen exists to explain, and hiding it here would be the "deleted leads
 * page" this feature is explicitly not.
 */
export async function lostLeadsPage(
  options: {
    filters?: LostLeadFilters;
    page?: number;
    perPage?: number;
  } = {},
): Promise<LostLeadsPage> {
  const scope = await managerScope();
  const filters = options.filters ?? {};
  const perPage = Math.min(Math.max(options.perPage ?? LOST_LEADS_PER_PAGE, 1), LOST_LEADS_PER_PAGE_MAX);

  const scoped = sql`where c.lead_stage = 'lost' ${leadsVisible(scope)}`;
  const narrowed = lostLeadFilterClause(filters);

  const [row] = await db.execute<{ total: number; listTotal: number }>(sql`
    select count(*) filter (where true ${narrowed})::int as total,
           count(*)::int as "listTotal"
    ${LOST_LEAD_JOINS}
    ${scoped}
  `);
  const total = Number(row?.total ?? 0);
  const listTotal = Number(row?.listTotal ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(options.page ?? 1, 1), pageCount);

  const rows = await db.execute<LostLeadRow>(sql`
    select c.id, c.name, c.company_name as "companyName", c.phone as mobile,
           c.city, c.area,
           c.lead_sales_type::text as "salesType",
           c.owner_id as "ownerId", u.name as "ownerName",
           c.lead_lost_reason as "lostReason",
           c.lead_stage_since::text as "lostDate",
           lt.from_stage::text as "fromStage",
           la.name as "lostByName",
           c.lead_last_activity_date::text as "lastActivityDate"
    ${LOST_LEAD_JOINS}
    ${scoped}
    ${narrowed}
     order by c.lead_stage_since desc nulls last, c.id desc
     limit ${perPage} offset ${(page - 1) * perPage}
  `);

  return {
    rows: rows as unknown as LostLeadRow[],
    total,
    listTotal,
    page,
    pageCount,
    perPage,
  };
}

/**
 * Owners, counted over the scoped Lost book — the one filter option here that
 * has to be read off the data rather than offered as a fixed list. Lead type
 * and stage-at-loss are drawn from `SALES_TYPE_BUCKETS` and `ALL_LEAD_STAGES`
 * directly, and Lost reason from `LOST_REASONS`: all three are closed
 * vocabularies already declared in `lib/lead-labels.ts` and `lib/lead-filters.ts`,
 * so offering them again here would be a second list waiting to drift from the
 * first the day a rung or a reason is added.
 */
export async function lostLeadOwnerOptions(): Promise<Array<FilterOption & { count: number }>> {
  const scope = await managerScope();
  const rows = await db.execute<{ value: string | null; label: string | null; count: number }>(sql`
    select c.owner_id as value, u.name as label, count(*)::int as count
      from customers c
      left join users u on u.id = c.owner_id
     where c.lead_stage = 'lost'
       ${leadsVisible(scope)}
     group by c.owner_id, u.name
     order by count(*) desc, u.name asc
  `);
  return rows.map((o) => ({
    value: o.value ?? UNASSIGNED,
    label: o.label ?? "Nobody",
    count: Number(o.count),
  }));
}

export type LostLeadTiles = {
  total: number;
  thisMonth: number;
  thisWeek: number;
  /** Stage-at-loss breakdown, most-populated first. `stage: null` is "Not recorded". */
  byStage: Array<{ stage: LeadStage | null; label: string; count: number }>;
};

/**
 * §7 — the three headline counts, plus the stage-at-loss breakdown, over the
 * WHOLE scoped Lost book — deliberately not over the current filters.
 *
 * Unlike the nine tiles on the funnel's own dashboard, this strip is three
 * numbers and a breakdown, not a set of doors each opening a differently-cut
 * list — the instruction for this screen is explicitly to keep the summary
 * area simple, and a tile that recounted against the filter bar would need
 * the same query run once per filter change for a screen whose entire point
 * is the table beneath it. "Total lost" always means the whole book a person
 * may see; the table is where they narrow it.
 */
export async function lostLeadTiles(day: string): Promise<LostLeadTiles> {
  const scope = await managerScope();
  const monthStart = startOfMonth(day as BusinessDate);
  const weekStart = startOfWeek(day as BusinessDate);
  const scoped = sql`where c.lead_stage = 'lost' ${leadsVisible(scope)}`;

  const [totals] = await db.execute<{ total: number; thisMonth: number; thisWeek: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where c.lead_stage_since >= ${monthStart}::date)::int as "thisMonth",
           count(*) filter (where c.lead_stage_since >= ${weekStart}::date)::int as "thisWeek"
      from customers c
      ${scoped}
  `);

  const stages = await db.execute<{ stage: string | null; count: number }>(sql`
    select lt.from_stage::text as stage, count(*)::int as count
      from customers c
      left join lateral (
        select t.from_stage
          from lead_stage_transitions t
         where t.customer_id = c.id and t.to_stage = 'lost'
         order by t.at desc
         limit 1
      ) lt on true
      ${scoped}
     group by 1
     order by count(*) desc
  `);

  return {
    total: Number(totals?.total ?? 0),
    thisMonth: Number(totals?.thisMonth ?? 0),
    thisWeek: Number(totals?.thisWeek ?? 0),
    byStage: stages.map((s) => ({
      stage: (s.stage as LeadStage | null) ?? null,
      label: s.stage ? stageLabel(s.stage as LeadStage) : "Not recorded",
      count: Number(s.count),
    })),
  };
}
