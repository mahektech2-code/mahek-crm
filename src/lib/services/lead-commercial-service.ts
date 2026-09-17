import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "../business-date";
import { orderCountsSql } from "../order-status";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * Group 5 — the COMMERCIAL end of the funnel, and the three questions it asks.
 *
 * Screens 16, 17 and 18 are one arc read three ways: what is still being
 * argued about, what somebody has PROMISED, and what has actually arrived.
 * They are here rather than in `lead-console-service.ts` for the reason that
 * file gives for existing at all — a desk asks list questions, and a list
 * question and a record question have almost no SQL in common — and they are
 * in their OWN file because everything in them turns on one distinction the
 * rest of the console never has to make: a forecast is not a sale.
 *
 * THREE RULES RUN THROUGH THE WHOLE FILE.
 *
 * **There is no negotiation table and this file does not invent one.** A
 * negotiation is a lead standing on the `negotiation` rung with a reason on
 * its newest transition, a credit-days ask against the standard term, and a
 * commitment or the absence of one. Every one of those already exists. A
 * table would be a fourth place the same facts live, and the one that drifts
 * is always the one somebody is reading.
 *
 * **A commitment is not an order.** `lead_expected_order_date` and
 * `lead_expected_order_value_paise` are what a customer SAID on a phone call.
 * They are named `forecast…` on the way out of here, they are totalled
 * separately from anything real, and no caller may add the two together — see
 * the comment over `forecastValuePaise` in `commitments()`.
 *
 * **Order status is READ and never written** — §20. `orders.status` comes from
 * the sheet projection and from accounts' approval, and what counts as a sale
 * is `PURCHASE_STATUSES` through `orderCountsSql`, never three statuses typed
 * into a query here.
 *
 * And the two inherited from `sales-service.ts`, both load-bearing: scope is
 * resolved INSIDE the service so no call site can forget it, and every column
 * of an outer table is qualified because Drizzle renders `${customers.id}` as
 * a bare `"id"` that binds to the inner table of a correlated subquery.
 * ------------------------------------------------------------------------- */

/**
 * Counting orders on this account, as a correlated subquery.
 *
 * Written once because all three screens ask it and each asks it about the
 * SAME definition of a sale. `orderCountsSql` derives the list from
 * `PURCHASE_STATUSES` rather than restating it, so an order status added to
 * the enum reaches these three screens by existing.
 */
const COUNTING_ORDERS = sql`
  select count(*)::int
    from orders o
   where o.customer_id = customers.id
     and ${orderCountsSql("o")}
`;

/* ══════════════════════════════════════════════════ 16 — the negotiation desk */

export type NegotiationRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerId: string | null;
  leadManagerName: string | null;
  /** The day it reached `negotiation`, and how long it has stood there. */
  stageSince: string | null;
  daysHere: number;
  quietDays: number;
  /**
   * The newest transition's own words. NULL is a real answer and the screen
   * says so rather than drawing a blank: a lead that reached Negotiation
   * before transitions were recorded has no row, which is a different fact
   * from a move somebody made without giving a reason.
   */
  hasTransition: boolean;
  transitionReasonCode: string | null;
  transitionNote: string | null;
  transitionKind: string | null;
  transitionAt: string | null;
  transitionActorName: string | null;
  /** §G's commercial terms: what they asked for against what we give. */
  creditDaysWanted: number | null;
  standingTermDays: number;
  /** The commitment, if anybody has asked. A FORECAST — see `commitments()`. */
  forecastDate: string | null;
  forecastValuePaise: number | null;
  /** §24 — an active lead may not sit with nothing owed by anybody. */
  nextAction: string | null;
  nextActionDate: string | null;
  nextActionOwnerId: string | null;
  nextActionOwnerName: string | null;
  nextActionOverdueDays: number | null;
  /** Read, never written. An order below `negotiation` is what §G refuses. */
  countingOrders: number;
};

/**
 * 16 — every lead at `negotiation`, worst first.
 *
 * THIS QUEUE IS WHAT §G's REFUSAL IS PROTECTING. `handleOrder` refuses an
 * order against a lead below `negotiation`, and that refusal is the one in the
 * field product that loses nothing: the order was never agreed with anybody
 * who could agree it. What it DOES produce is this list — conversations that
 * have to be finished before anybody may sell — and a refusal with no queue
 * behind it is a rule nobody can work.
 *
 * Sorted by how long the lead has stood here rather than by what it is worth.
 * A negotiation is a conversation somebody has to have, and the one that has
 * been waiting a month is the one nobody is having.
 */
export async function negotiationDesk(
  day: string,
  { limit = 200 }: { limit?: number } = {},
): Promise<{ rows: NegotiationRow[]; total: number; stalled: number; noCommitment: number }> {
  const scope = await managerScope();

  const where = sql`
     where customers.lead_stage = 'negotiation'
       and customers.lead_archived = false
       ${leadsVisible(scope, "customers.owner_id")}
  `;

  const [rows, counts] = await Promise.all([
    db.execute<NegotiationRow>(sql`
      select customers.id as "customerId", customers.name,
             customers.company_name as "companyName", customers.city,
             customers.lead_sales_type::text as "salesType",
             customers.lead_stage::text as stage,
             customers.owner_id as "salesmanId", u.name as "salesmanName",
             customers.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
             customers.lead_stage_since::text as "stageSince",
             coalesce(${day}::date - customers.lead_stage_since, 0)::int as "daysHere",
             coalesce(${day}::date - customers.lead_last_activity_date, 0)::int as "quietDays",
             (t.id is not null) as "hasTransition",
             t.reason_code as "transitionReasonCode",
             t.note as "transitionNote",
             t.kind::text as "transitionKind",
             to_char(t.at at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD') as "transitionAt",
             ta.name as "transitionActorName",
             customers.lead_credit_days_wanted as "creditDaysWanted",
             customers.credit_term_days as "standingTermDays",
             customers.lead_expected_order_date::text as "forecastDate",
             customers.lead_expected_order_value_paise as "forecastValuePaise",
             customers.lead_next_action as "nextAction",
             customers.lead_next_action_date::text as "nextActionDate",
             customers.lead_next_action_owner_id as "nextActionOwnerId",
             na.name as "nextActionOwnerName",
             case when customers.lead_next_action_date < ${day}::date
                  then (${day}::date - customers.lead_next_action_date)::int end
               as "nextActionOverdueDays",
             (${COUNTING_ORDERS}) as "countingOrders"
        from customers
        left join users u on u.id = customers.owner_id
        left join users m on m.id = customers.lead_manager_id
        left join users na on na.id = customers.lead_next_action_owner_id
        /* The newest transition INTO this rung, and the reason it carries.
           A lateral rather than a join on the whole table: a lead routinely
           has a dozen transitions and a plain join would multiply the row. */
        left join lateral (
          select x.id, x.reason_code, x.note, x.kind, x.at, x.actor_id
            from lead_stage_transitions x
           where x.customer_id = customers.id
           order by x.at desc, x.id desc
           limit 1
        ) t on true
        left join users ta on ta.id = t.actor_id
        ${where}
       order by customers.lead_stage_since asc nulls first, customers.id asc
       limit ${limit}
    `) as unknown as NegotiationRow[],
    db.execute<{ total: number; stalled: number; noCommitment: number }>(sql`
      select count(*)::int as total,
             count(*) filter (
               where customers.lead_next_action_date is null
                  or customers.lead_next_action_date < ${day}::date
             )::int as stalled,
             count(*) filter (
               where customers.lead_expected_order_date is null
             )::int as "noCommitment"
        from customers
        ${where}
    `),
  ]);

  return {
    rows,
    total: Number(counts[0]?.total ?? 0),
    stalled: Number(counts[0]?.stalled ?? 0),
    noCommitment: Number(counts[0]?.noCommitment ?? 0),
  };
}

/* ═══════════════════════════════════════════════ 17 — commitments & forecast */

/** The four views. Filters over one list, never four routes. */
export type CommitmentView = "open" | "due" | "slipped" | "converted";

export const COMMITMENT_VIEWS: readonly { key: CommitmentView; label: string; hint: string }[] = [
  { key: "open", label: "Open", hint: "A day promised that has not come round yet." },
  { key: "due", label: "Due this week", hint: "Promised inside the next seven days." },
  {
    key: "slipped",
    label: "Slipped",
    hint: "The day came and went with no order. This is the view that earns the screen.",
  },
  { key: "converted", label: "Converted", hint: "A real order arrived on the account." },
];

export type CommitmentRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerName: string | null;
  /**
   * WHAT SOMEBODY WAS TOLD ON A PHONE CALL. Named `forecast…` all the way to
   * the screen so no reader can mistake it for a figure off the ledger, and
   * null on the value is a REAL answer — nothing in MahekOne can price an
   * order, so an estimate nobody gave is not zero.
   */
  forecastDate: string;
  forecastValuePaise: number | null;
  /** Negative once the day has gone past. */
  daysUntil: number;
  /** The ledger's own answer, and the only real money on this screen. */
  countingOrders: number;
  firstOrderDate: string | null;
  firstOrderValuePaise: number | null;
  nextAction: string | null;
  nextActionDate: string | null;
};

/**
 * 17 — the forecast board.
 *
 * A COMMITMENT IS NOT AN ORDER, and this screen exists to keep them apart. It
 * is a day and a figure somebody was given on a phone call: useful, worth
 * chasing, and not a rupee of revenue. Every figure that leaves this function
 * is named `forecast…`, the total is computed here so it can be labelled once
 * rather than assembled on a screen, and no caller may add it to an order
 * value — a pipeline added to a ledger is a book that overstates itself by
 * exactly the amount nobody has bought.
 *
 * `converted` is read off COUNTING ORDERS rather than off the rung, which is
 * the honest answer to "did the commitment produce anything": a lead can be
 * moved up a ladder by a person and can only gain an order by selling. What it
 * cannot answer is WHICH order — there is no column saying when a commitment
 * was made — so a row here says a real order exists and prints its own date
 * beside the promised one for the reader to judge.
 */
export async function commitments(
  day: string,
  view: CommitmentView,
  { limit = 200 }: { limit?: number } = {},
): Promise<{
  rows: CommitmentRow[];
  counts: Record<CommitmentView, number>;
  /**
   * THE TOTAL OF THE VIEW BEING SHOWN, AND IT IS A FORECAST.
   *
   * It may never be added to an order value, a target, an EOD figure or a
   * bill. It is the sum of what customers said they would do, over the rows
   * on this view only, and the screen says so above the number.
   */
  forecastValuePaise: number;
  /** A named gap: commitments with nobody's estimate against them. */
  unvalued: number;
}> {
  const scope = await managerScope();

  /*
   * THE POPULATION, and `STILL_WORKING` is deliberately not reused.
   *
   * That fragment excludes `customer`, which is right for a worklist and
   * wrong here: the Converted view is made entirely of leads that have
   * finished climbing. `lost` is still out — a commitment from a lead nobody
   * will look at again is not a forecast, it is history.
   */
  const population = sql`
      customers.lead_expected_order_date is not null
      and customers.lead_archived = false
      and customers.lead_stage is not null
      and customers.lead_stage <> 'lost'
      ${leadsVisible(scope, "customers.owner_id")}
  `;

  /*
   * ONE DEFINITION OF EACH VIEW, and it is asked of a derived table rather
   * than of `customers` directly.
   *
   * The four views are needed twice — once to draw the rows and once to count
   * every view for the chips — and "has this account ordered" is a correlated
   * subquery. A subquery inside an aggregate's FILTER is the shape that either
   * refuses to plan or quietly costs a scan per row, so the flag is computed
   * ONCE in `base` and both readers ask the same two columns about it. Two
   * hand-written copies of "slipped" would be two answers the day somebody
   * changed one.
   */
  const base = sql`
    select customers.id as cid,
           customers.lead_expected_order_date as expected,
           customers.lead_expected_order_value_paise as forecast,
           (${COUNTING_ORDERS}) > 0 as ordered
      from customers
     where ${population}
  `;

  const viewClause: Record<CommitmentView, SQL> = {
    open: sql`not b.ordered and b.expected >= ${day}::date`,
    due: sql`not b.ordered
             and b.expected >= ${day}::date
             and b.expected < ${day}::date + 7`,
    slipped: sql`not b.ordered and b.expected < ${day}::date`,
    converted: sql`b.ordered`,
  };

  const [rows, counts, totals] = await Promise.all([
    db.execute<CommitmentRow>(sql`
      select customers.id as "customerId", customers.name,
             customers.company_name as "companyName", customers.city,
             customers.lead_sales_type::text as "salesType",
             customers.lead_stage::text as stage,
             customers.owner_id as "salesmanId", u.name as "salesmanName",
             m.name as "leadManagerName",
             customers.lead_expected_order_date::text as "forecastDate",
             customers.lead_expected_order_value_paise as "forecastValuePaise",
             (customers.lead_expected_order_date - ${day}::date)::int as "daysUntil",
             (${COUNTING_ORDERS}) as "countingOrders",
             /* The first counting order on the account, which for a lead is
                the order that converted it. Its date is named in the zone:
                ordered_at is an instant, and a bare cast reads it in the
                session's zone, which puts a 1am order on the day before. */
             (select to_char(min(o.ordered_at at time zone ${APP_TIMEZONE}), 'YYYY-MM-DD')
                from orders o
               where o.customer_id = customers.id
                 and ${orderCountsSql("o")}) as "firstOrderDate",
             (select o.total_amount
                from orders o
               where o.customer_id = customers.id
                 and ${orderCountsSql("o")}
               order by o.ordered_at asc, o.id asc
               limit 1) as "firstOrderValuePaise",
             customers.lead_next_action as "nextAction",
             customers.lead_next_action_date::text as "nextActionDate"
        from (${base}) b
        join customers on customers.id = b.cid
        left join users u on u.id = customers.owner_id
        left join users m on m.id = customers.lead_manager_id
       where ${viewClause[view]}
       /* Slipped reads worst-first and the rest read soonest-first, which is
          the same sort: the oldest promised day at the top either way. The
          tiebreaker is not optional — a hundred commitments share a handful
          of dates, and a sort the planner decides is a row on two pages. */
       order by customers.lead_expected_order_date asc, customers.id asc
       limit ${limit}
    `) as unknown as CommitmentRow[],
    db.execute<Record<CommitmentView, number>>(sql`
      select count(*) filter (where ${viewClause.open})::int as open,
             count(*) filter (where ${viewClause.due})::int as due,
             count(*) filter (where ${viewClause.slipped})::int as slipped,
             count(*) filter (where ${viewClause.converted})::int as converted
        from (${base}) b
    `),
    db.execute<{ forecast: number; unvalued: number }>(sql`
      select coalesce(sum(b.forecast), 0)::bigint as forecast,
             count(*) filter (where b.forecast is null)::int as unvalued
        from (${base}) b
       where ${viewClause[view]}
    `),
  ]);

  return {
    rows,
    counts: {
      open: Number(counts[0]?.open ?? 0),
      due: Number(counts[0]?.due ?? 0),
      slipped: Number(counts[0]?.slipped ?? 0),
      converted: Number(counts[0]?.converted ?? 0),
    },
    forecastValuePaise: Number(totals[0]?.forecast ?? 0),
    unvalued: Number(totals[0]?.unvalued ?? 0),
  };
}

/* ══════════════════════════════════════════ 18 — first order & conversion */

/** The last three rungs plus the one that opens them. */
export const FIRST_ORDER_STAGES: readonly LeadStage[] = [
  "first_order",
  "delivery",
  "payment",
  "second_order",
] as const;

export type FirstOrderRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  stageSince: string | null;
  daysHere: number;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerName: string | null;
  /**
   * THE SENTENCE PEOPLE GET WRONG, as a column.
   *
   * `kind` flips at the FIRST order — `promotesToCustomerAt()` is the one
   * place that is decided — so an account on this screen is already a customer
   * in the ledger while it is still climbing the funnel's last three rungs.
   * It is selected rather than inferred from the rung because the two really
   * can disagree: an order declined by accounts leaves a lead on
   * `first_order` with `kind` still `lead`, and a screen that guessed would
   * say the opposite of the ledger.
   */
  kind: string;
  /** The commitment that was asked for. A forecast; see `commitments()`. */
  forecastDate: string | null;
  forecastValuePaise: number | null;
  /** Whether anybody has ever run the eight questions. */
  asked: boolean;
  /* ---- READ OFF THE LEDGER, and never written by this module (§20) ---- */
  countingOrders: number;
  pendingOrders: number;
  declinedOrders: number;
  latestOrderId: string | null;
  latestOrderNo: string | null;
  latestOrderStatus: string | null;
  latestOrderAt: string | null;
  latestOrderValuePaise: number | null;
  billedPaise: number;
  /** Bills nobody has spoken for: neither paid nor owed. Never a balance. */
  unstatedBills: number;
  confirmedReceiptsPaise: number;
  outstandingPaise: number;
};

/**
 * 18 — the order that converts an account, and everything after it.
 *
 * TWO RULES, BOTH OF THEM THINGS SOMEBODY WOULD OTHERWISE DISCOVER.
 *
 * **This reads order status and never writes it.** §20's ladder — Received,
 * Confirmed, Dispatched, In Transit, Delivered — is `orders.status`, which the
 * sheet projection restates every thirty minutes and accounts' approval
 * decides. A second ladder kept by the funnel would either be overwritten by
 * the projection or would fight it into `sync_conflicts`. What counts as a
 * SALE is `PURCHASE_STATUSES`, read through `orderCountsSql`, and the three
 * counts below are that list and its complement rather than statuses typed out
 * here.
 *
 * **`kind` flipped at the first order, not the second.** §22 asks for the
 * second; this codebase promotes at the first, because about thirty readers of
 * `customers.kind` mean "has never ordered" by it and an account with an
 * order, a bill and a confirmed receipt sitting at `kind = 'lead'` would get
 * every one of them wrong. So the funnel keeps its own `second_order` and
 * `customer` rungs, which say something about the RELATIONSHIP, and the ledger
 * has already moved on. `kind` rides on every row so the screen can say it in
 * words.
 */
export async function firstOrderDesk(
  day: string,
  { limit = 200 }: { limit?: number } = {},
): Promise<{
  rows: FirstOrderRow[];
  total: number;
  byStage: Record<string, number>;
  /** A named gap: on the rung, and the ledger has nothing to show for it. */
  awaitingTheOrder: number;
  /** The other half of it: an order accounts have not decided on yet. */
  awaitingApproval: number;
}> {
  const scope = await managerScope();

  const stages = sql.join(
    FIRST_ORDER_STAGES.map((s) => sql`${s}`),
    sql`, `,
  );

  const where = sql`
     where customers.lead_stage::text in (${stages})
       and customers.lead_archived = false
       ${leadsVisible(scope, "customers.owner_id")}
  `;

  const pending = sql`
    select count(*)::int from orders o
     where o.customer_id = customers.id and o.status = 'pending_approval'
  `;

  const [rows, counts] = await Promise.all([
    db.execute<FirstOrderRow>(sql`
      select customers.id as "customerId", customers.name,
             customers.company_name as "companyName", customers.city,
             customers.lead_sales_type::text as "salesType",
             customers.lead_stage::text as stage,
             customers.lead_stage_since::text as "stageSince",
             coalesce(${day}::date - customers.lead_stage_since, 0)::int as "daysHere",
             customers.owner_id as "salesmanId", u.name as "salesmanName",
             m.name as "leadManagerName",
             customers.kind::text as kind,
             customers.lead_expected_order_date::text as "forecastDate",
             customers.lead_expected_order_value_paise as "forecastValuePaise",
             (customers.lead_expected_order_date is not null) as asked,
             (${COUNTING_ORDERS}) as "countingOrders",
             (${pending}) as "pendingOrders",
             (select count(*)::int from orders o
               where o.customer_id = customers.id and o.status = 'declined')
               as "declinedOrders",
             lo.id as "latestOrderId", lo.order_no as "latestOrderNo",
             lo.status::text as "latestOrderStatus",
             to_char(lo.ordered_at at time zone ${APP_TIMEZONE}, 'YYYY-MM-DD') as "latestOrderAt",
             lo.total_amount as "latestOrderValuePaise",
             /* Billed, and what nobody has spoken for. An unstated bill is
                NEITHER paid nor owed — the sheet never asserted money — so it
                is counted and never added into a balance. */
             (select coalesce(sum(b.amount), 0)::bigint from bills b
               where b.customer_id = customers.id) as "billedPaise",
             (select count(*)::int from bills b
               where b.customer_id = customers.id
                 and b.payment_position = 'unstated') as "unstatedBills",
             /* CONFIRMED money only. A reported or held receipt moves nothing
                anywhere else in this product and moves nothing here. */
             (select coalesce(sum(r.amount), 0)::bigint from payment_receipts r
               where r.customer_id = customers.id and r.status = 'confirmed')
               as "confirmedReceiptsPaise",
             customers.outstanding as "outstandingPaise"
        from customers
        left join users u on u.id = customers.owner_id
        left join users m on m.id = customers.lead_manager_id
        /* The newest order in ANY state, because "accounts declined it" is
           exactly what a manager is looking for on this screen. What counts
           as a sale is the three counts above; this is the latest news. */
        left join lateral (
          select o.id, o.order_no, o.status, o.ordered_at, o.total_amount
            from orders o
           where o.customer_id = customers.id
           order by o.ordered_at desc, o.id desc
           limit 1
        ) lo on true
        ${where}
       order by customers.lead_stage_since asc nulls first, customers.id asc
       limit ${limit}
    `) as unknown as FirstOrderRow[],
    /*
     * The counts, over a derived table for the reason `commitments()` gives:
     * "has this ordered" is a correlated subquery, and one inside an
     * aggregate's FILTER is the shape that costs a scan a row. Computed once
     * per account here and aggregated over the result.
     */
    db.execute<{
      stage: string;
      n: number;
      awaiting: number;
      pending: number;
    }>(sql`
      select b.stage, count(*)::int as n,
             count(*) filter (where b.counting = 0)::int as awaiting,
             count(*) filter (where b.pending > 0)::int as pending
        from (
          select customers.lead_stage::text as stage,
                 (${COUNTING_ORDERS}) as counting,
                 (${pending}) as pending
            from customers
            ${where}
        ) b
       group by b.stage
    `),
  ]);

  const byStage: Record<string, number> = {};
  let total = 0;
  let awaitingTheOrder = 0;
  let awaitingApproval = 0;
  for (const c of counts) {
    byStage[c.stage] = Number(c.n);
    total += Number(c.n);
    awaitingTheOrder += Number(c.awaiting);
    awaitingApproval += Number(c.pending);
  }

  return { rows, total, byStage, awaitingTheOrder, awaitingApproval };
}
