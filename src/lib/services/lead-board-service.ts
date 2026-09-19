import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, asDate } from "../business-date";
import { gateForNext, type GateVerdict, type LeadGateInput } from "../engines/lead-gates";
import { ladderFor } from "../engines/lead-ladder";
import { getConfig } from "../config/store";
import { figuresAreStale } from "./lead-service";
import type { LeadFilters } from "../lead-filters";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { orderCountsSql } from "../order-status";
import { leadsVisible, managerScope } from "./sales-service";
import { leadFilterClause } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * The two reads behind the Stage board and the Stage transitions screen.
 *
 * Both are LIST questions about a population the console already has a service
 * for, and both are here rather than in `lead-console-service.ts` for the
 * reason that file gives for existing at all: the record page asks about one
 * lead and a board asks about six hundred, and the SQL those two want has
 * almost nothing in common. Folding them would give the record page a window
 * function it pays for and never reads.
 *
 * Every rule `lead-console-service.ts` states at its own head applies here word
 * for word — scope resolved INSIDE the service so no call site can forget it,
 * every column of the outer table qualified inside a correlated subquery, and
 * every day window naming its zone. `IST_DAY` below is the local spelling of
 * the last one; `APP_TIMEZONE` is still the only place the zone is named.
 * ------------------------------------------------------------------------- */

const IST_DAY = sql.raw(`at time zone '${APP_TIMEZONE}'`);

/* ═════════════════════════════════════════════════════ narrowing the board */


/* ═══════════════════════════════════════════════════════════ the board itself */

/**
 * Fifty cards a column, and the true count in the header.
 *
 * The same discipline the CRM's customer record learned the hard way: a column
 * of four hundred cards is a column nobody reads AND a lie about what fits, and
 * a cap whose count came from what had been drawn would print "50" over a rung
 * carrying four hundred with nothing on the screen saying so.
 */
export const BOARD_COLUMN_CAP = 50;

export type BoardCard = {
  id: string;
  name: string;
  companyName: string | null;
  city: string | null;
  ownerName: string | null;
  ownerInitials: string | null;
  potentialPaise: number | null;
  /** §24's date, as a plain day. The screen mutes it where it is past. */
  nextActionDate: string | null;
  /**
   * Decided in SQL against the business date rather than in the browser. A
   * client component may not read the clock during render, and comparing two
   * day strings in JS is one more place the zone could be dropped.
   */
  nextActionOverdue: boolean;
  stage: LeadStage;
  /**
   * §28 for the ONE rung above this card, which is the only move a board
   * gesture can make — see the note on the drop handler in `board-screen.tsx`.
   * It is the verdict the card draws AND the verdict the advance flow is handed,
   * so the tick on the card and the refusal in the dialog cannot disagree.
   */
  next: GateVerdict;
};

export type BoardColumn = {
  stage: LeadStage;
  /** Over the whole filtered population of this rung, from SQL. */
  total: number;
  /** At most `BOARD_COLUMN_CAP` of them. */
  cards: BoardCard[];
};

/** A rung this board does not draw, with how many are standing on it. */
export type OffLadderCount = { stage: LeadStage; total: number };

export type LeadBoard = {
  salesType: LeadSalesType | null;
  columns: BoardColumn[];
  /**
   * WHAT THE COLUMNS DO NOT SHOW, counted rather than dropped.
   *
   * `lost` is on none of the three ladders and `on_hold` is on none of them
   * either — it DISPLACES the rung, which is the whole subject of the
   * transitions screen. A board that silently omitted both would be a picture
   * of a book with the dead and the parked quietly deleted from it, and the
   * parked ones are exactly the leads somebody opens a board to find.
   */
  offLadder: OffLadderCount[];
  /** Every lead of this sales type matching the filters, on a rung or off one. */
  total: number;
  /** Every lead of this sales type before any filter — "62 of 511". */
  listTotal: number;
  cap: number;
};

/**
 * Everything the gate engine reads, selected for a board's worth of leads.
 *
 * The column list is the one `leadRecord` carries and it is deliberately not
 * shared with it: that read is one row wide enough to draw a whole record page,
 * and this is the subset §28 asks about, taken over up to six hundred rows.
 * Half of it is correlated subqueries, which is why the cap is applied in a CTE
 * FIRST — the window function decides which fifty of a rung's four hundred
 * survive, and only those fifty are asked what their sample state is.
 */
export async function leadBoard(
  day: string,
  options: {
    /** Null is the legacy ladder — the six rungs this product shipped with. */
    salesType: LeadSalesType | null;
    filters?: LeadFilters;
    health: { atRiskBelow: number; strongAtOrAbove: number };
  },
): Promise<LeadBoard> {
  const scope = await managerScope();
  const filters = options.filters ?? {};
  const ladder = ladderFor(options.salesType);
  /* Read ONCE for the whole board rather than per row: whether sixty days have
     passed is a fact about the calendar, not about a lead. */
  const freshDays = (await getConfig())["leads.figuresFreshDays"];

  /* A sales type is a column that can be null, so "this board" is two different
     predicates and neither may be written as the other: `= null` matches
     nothing, and an `is not distinct from` over an enum reads as cleverness
     rather than as an answer. The legacy ladder IS the null case — see
     LEGACY_LADDER, which exists precisely because nothing backfills one. */
  const ofType = options.salesType
    ? sql`and c.lead_sales_type::text = ${options.salesType}`
    : sql`and c.lead_sales_type is null`;

  const where = sql`
     where c.lead_stage is not null
       and c.lead_archived = false
       ${ofType}
       ${leadsVisible(scope)}`;
  const narrowed = leadFilterClause(filters, day, options.health);

  /*
   * THE COUNTS AND THE CARDS ARE TWO QUERIES, AND THE COUNT IS THE ONE THAT
   * MATTERS. Every rung the filtered book actually stands on comes back here,
   * including the ones this ladder does not draw — which is what lets the
   * screen say how many are lost or parked rather than losing them.
   */
  const [counted, book] = await Promise.all([
    db.execute<{ stage: string; total: number }>(sql`
      select c.lead_stage::text as stage, count(*)::int as total
        from customers c
        ${where}
        ${narrowed}
       group by 1
    `),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from customers c ${where}
    `),
  ]);

  const totalByStage = new Map<string, number>(
    counted.map((r) => [r.stage, Number(r.total)]),
  );

  /*
   * ONE query for every column's cards, capped per column by a window function.
   *
   * Twelve queries would have been the obvious shape and it is the wrong one:
   * the counts above already know which rungs are occupied, and a board that
   * asked the database once per column would pay twelve round trips to draw one
   * screen — several of them for rungs with nothing on them.
   *
   * The ordering inside a column is the list's own — the follow-up somebody
   * promised first, then the quietest — with `c.id` as the tiebreaker, because
   * a partition ordered on a nullable date leaves the fifty that survive the cap
   * to the planner otherwise.
   */
  const rows = (await db.execute(sql`
    with ranked as (
      select c.id,
             row_number() over (
               partition by c.lead_stage
                   order by c.lead_next_follow_up_date asc nulls last,
                            c.lead_last_activity_date asc nulls last,
                            c.id desc
             ) as rn
        from customers c
        ${where}
        ${narrowed}
    )
    select c.id, c.name, c.company_name as "companyName", c.city,
           u.name as "ownerName", u.initials as "ownerInitials",
           c.lead_estimated_potential_paise as "potentialPaise",
           c.lead_next_action_date::text as "nextActionDate",
           (c.lead_next_action_date is not null
              and c.lead_next_action_date < ${day}::date) as "nextActionOverdue",
           c.lead_stage::text as stage,

           c.lead_sales_type::text as "salesType",
           c.customer_type::text as "customerType",
           c.lead_monthly_volume_litres as "monthlyLitres",
           c.lead_competitor as competitor,
           c.lead_required_product_id as "requiredProductId",
           c.contact_person as "contactPerson",
           c.lead_decision_maker as "decisionMaker",
           c.lead_buyer as "buyer",
           c.gst_verified as "gstVerified",
           c.lead_figures_confirmed_at as "figuresConfirmedAt",
           c.lead_qualification_review::text as "qualificationReview",
           c.lead_credit_days_wanted as "creditDaysWanted",
           c.lead_application as application,
           c.gstin,
           c.lead_next_action as "nextAction",
           c.lead_next_action_owner_id as "nextActionOwnerId",
           c.lead_qualification as qualification,
           c.lead_stage_since::text as "stageSince",
           c.lead_verified_at as "verifiedAt",
           c.third_party as "thirdParty",
           c.lead_suspect_decided_at as "suspectDecidedAt",
           c.lead_expected_order_date::text as "expectedOrderDate",

           (select count(*)::int from mbos_visits vi
             where vi.customer_id = c.id) as "suspectVisitCount",
           (select count(*)::int from customer_distributors cd
             where cd.customer_id = c.id) as "distributorCount",

           to_jsonb(dp.*) as "distributorProfile",
           dp.commercial_terms_agreed_at as "commercialTermsAgreedAt",
           exists (
             select 1 from mbos_approvals a
              where a.subject_id = c.id and a.type = 'distributor_appointment'
                and a.step_index = 0 and a.state in ('approved', 'partially_approved')
           ) as "managementReviewApproved",
           exists (
             select 1 from mbos_approvals a
              where a.subject_id = c.id and a.type = 'distributor_appointment'
                and a.step_index = 1 and a.state in ('approved', 'partially_approved')
           ) as "distributorApprovalApproved",
           exists (
             select 1 from mbos_documents md
              where md.customer_id = c.id and md.category = 'agreement' and md.active
           ) as "agreementOnFile",

           (select to_jsonb(x) from (
              select s.state::text as state,
                     s.trial_outcome::text as "trialOutcome",
                     (exists (select 1 from sample_feedback f where f.sample_id = s.id))
                       as "feedbackRecorded"
                from mbos_samples s
               where s.customer_id = c.id and s.state <> 'cancelled'
               /* server_created_at, NOT created_at, and NO BACKTICKS in this
                  comment: it sits inside a sql template literal and one
                  backtick ends the literal. mbos_samples is an MBOS table and
                  carries the handset's column set, which has no plain
                  created_at on it. The server's clock is the right one anyway:
                  the device's is its owner's to set. */
               order by s.server_created_at desc, s.id desc
               limit 1
            ) x) as sample,

           (select count(*)::int from orders o
             where o.customer_id = c.id
               /* Through order-status.ts, never a literal - the same reading
                  the second-order gate and the conversion rule both turn on. */
               and ${orderCountsSql("o")}) as "countingOrderCount",
           (select count(*)::int from orders o
             where o.customer_id = c.id and o.status = 'dispatched') as "deliveredOrderCount",
           (select count(*)::int from payment_receipts pr
             where pr.customer_id = c.id and pr.status = 'confirmed') as "confirmedPaymentCount"

      from ranked r
      join customers c on c.id = r.id
      left join users u on u.id = c.owner_id
      left join distributor_profiles dp on dp.customer_id = c.id
     /* The cast is not decoration. An untyped parameter beside a column lets
        Postgres resolve the comparison, and this file already carries the rule
        the MBOS delta learned twice: say the type out loud rather than leaving
        a bind parameter to be guessed at next to a column of another one. */
     where r.rn <= ${BOARD_COLUMN_CAP}::int
  `)) as unknown as Record<string, unknown>[];

  /*
   * THE GATE IS EVALUATED ON THE SERVER AND THE VERDICT IS WHAT TRAVELS.
   *
   * The record page carries the argument and it holds harder here: the engine
   * is pure and would run perfectly in a browser, but its INPUT is half a
   * customer row apiece and shipping six hundred of them to draw six hundred
   * ticks is how a board comes to carry a book's ledger in its payload. What
   * the card needs is one verdict, and one verdict is what it gets.
   *
   * Building the input is `gateInputFor`'s job on the record page and is done
   * by hand here for the same reason that function exists: the engine is the
   * authority on what a gate reads, and assembling it inside the SELECT would
   * put half of §28 back into a query.
   */
  const cards: BoardCard[] = rows.map((r) => {
    const sample = (r.sample as { state: string; trialOutcome: string; feedbackRecorded: boolean } | null) ?? null;
    const gate: LeadGateInput = {
      salesType: (r.salesType as LeadSalesType | null) ?? null,
      stage: r.stage as LeadStage,
      customerType: (r.customerType as string | null) ?? null,
      monthlyLitres: (r.monthlyLitres as number | null) ?? null,
      potentialPaise: (r.potentialPaise as number | null) ?? null,
      competitor: (r.competitor as string | null) ?? null,
      requiredProductId: (r.requiredProductId as string | null) ?? null,
      contactPerson: (r.contactPerson as string | null) ?? null,
      decisionMaker: (r.decisionMaker as string | null) ?? null,
      buyer: (r.buyer as string | null) ?? null,
      creditDaysWanted: (r.creditDaysWanted as number | null) ?? null,
      application: (r.application as string | null) ?? null,
      gstin: (r.gstin as string | null) ?? null,
      /* §11.6 — somebody else's check, not the salesman's tick. */
      gstVerified: Boolean(r.gstVerified),
      /*
       * THE BOARD IS THE THIRD READING OF ONE LEAD, and it has to agree with
       * the other two.
       *
       * `leadGateInput` assembles this for the handset and `gateInputFor` for
       * the record; this one draws the Kanban. All three ask the same engine
       * whether a lead may move, and all three have to hand it the same facts —
       * a field added to one and forgotten in another is not a type error and
       * not a failing test, it is a lead that can be dragged forward on the
       * board while its own record refuses the same move, with nothing on
       * either screen explaining the disagreement.
       *
       * Both of these arrived that way. They were wired into the handset's
       * assembler and missed here and on the record.
       */
      figuresStale: figuresAreStale(asDate(r.figuresConfirmedAt), freshDays),
      qualificationReview:
        (r.qualificationReview as LeadGateInput["qualificationReview"]) ?? null,
      nextAction: (r.nextAction as string | null) ?? null,
      nextActionDate: (r.nextActionDate as string | null) ?? null,
      nextActionOwnerId: (r.nextActionOwnerId as string | null) ?? null,
      qualification: (r.qualification as Record<string, boolean | string> | null) ?? null,
      suspectVisitCount: Number(r.suspectVisitCount ?? 0),
      suspectDecidedAt: asDate(r.suspectDecidedAt),
      /* The same reading `gateInputFor` takes: the reason lives on the
         transition that made it a prospect, so it is true exactly when the lead
         has been past Suspect. One copy of that inference would be better than
         two and it belongs beside the other one — see the report. */
      prospectReasonRecorded: Boolean(r.stageSince) && r.stage !== "suspect",
      verifiedAt: asDate(r.verifiedAt),
      thirdParty: Boolean(r.thirdParty),
      distributorCount: Number(r.distributorCount ?? 0),
      sample,
      distributorProfile: (r.distributorProfile as Record<string, unknown> | null) ?? null,
      managementReviewApproved: Boolean(r.managementReviewApproved),
      distributorApprovalApproved: Boolean(r.distributorApprovalApproved),
      commercialTermsAgreed: Boolean(r.commercialTermsAgreedAt),
      agreementOnFile: Boolean(r.agreementOnFile),
      countingOrderCount: Number(r.countingOrderCount ?? 0),
      deliveredOrderCount: Number(r.deliveredOrderCount ?? 0),
      confirmedPaymentCount: Number(r.confirmedPaymentCount ?? 0),
      expectedOrderDate: (r.expectedOrderDate as string | null) ?? null,
      initialStockOrderPlaced: Number(r.countingOrderCount ?? 0) > 0,
    };

    return {
      id: String(r.id),
      name: String(r.name),
      companyName: (r.companyName as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      ownerName: (r.ownerName as string | null) ?? null,
      ownerInitials: (r.ownerInitials as string | null) ?? null,
      potentialPaise: (r.potentialPaise as number | null) ?? null,
      nextActionDate: (r.nextActionDate as string | null) ?? null,
      nextActionOverdue: Boolean(r.nextActionOverdue),
      stage: r.stage as LeadStage,
      /* The VERDICT is what survives this function and the INPUT is not. It
         goes no further than this closure deliberately: shipping six hundred
         gate inputs to draw six hundred ticks is how a board comes to carry a
         book's ledger in its payload — the record page carries the same
         argument, one lead at a time. */
      next: gateForNext(gate),
    };
  });

  const byStage = new Map<string, BoardCard[]>();
  for (const card of cards) {
    const list = byStage.get(card.stage) ?? [];
    list.push(card);
    byStage.set(card.stage, list);
  }

  const columns: BoardColumn[] = ladder.map((stage) => ({
    stage,
    total: totalByStage.get(stage) ?? 0,
    cards: byStage.get(stage) ?? [],
  }));

  const onLadder = new Set<string>(ladder);
  const offLadder: OffLadderCount[] = [...totalByStage.entries()]
    .filter(([stage]) => !onLadder.has(stage))
    .map(([stage, total]) => ({ stage: stage as LeadStage, total }))
    .sort((a, b) => b.total - a.total);

  let total = 0;
  for (const n of totalByStage.values()) total += n;

  return {
    salesType: options.salesType,
    columns,
    offLadder,
    total,
    listTotal: Number(book[0]?.n ?? 0),
    cap: BOARD_COLUMN_CAP,
  };
}

/* ═════════════════════════════════════════════ §25 — the transitions screen */

/** Twenty-five a page, like `leadTimeline` beside it and for its reasons. */
export const STREAM_PER_PAGE = 25;

/**
 * Where a page stopped, as the two columns the sort is on.
 *
 * `at` alone is not a cursor here: a lead converted by a job lands several
 * transitions on one instant, and a cursor that only knew the instant would
 * either skip the rest of that instant or serve it twice. Both failures are
 * invisible until the history is long enough to page, which is exactly when
 * somebody is reading it carefully. The second column is the SYNTHETIC key
 * below rather than a bare id, because this stream is five tables and two of
 * them could legitimately mint the same id.
 */
export type StreamCursor = { at: string; key: string };

export type StreamKind = "transition" | "call" | "sample" | "order" | "receipt";

export type StreamEntry = {
  /** `<kind>:<row id>`, plus the step where one row produces several. */
  key: string;
  kind: StreamKind;
  at: Date;
  /** The kind's own columns. Read through the narrowing types below. */
  payload: Record<string, unknown>;
};

export type TransitionPayload = {
  fromStage: LeadStage | null;
  toStage: LeadStage;
  moveKind: string;
  reasonCode: string | null;
  note: string | null;
  /** What was still missing when somebody passed the gate. Empty is the norm. */
  overriddenConditions: string[];
  actorName: string | null;
  actorRole: string | null;
  actorApp: string | null;
  salesType: LeadSalesType | null;
};

export type StreamPage = {
  entries: StreamEntry[];
  /** Every entry in the stream, from SQL — never the length of what was loaded. */
  total: number;
  /** How many of them are stage moves, and how many of those passed a shut gate. */
  transitionCount: number;
  overrideCount: number;
  /** Null at the end of the history. */
  next: StreamCursor | null;
};

/**
 * §25 IN ONE CHRONOLOGICAL STREAM, and it is one query rather than five reads
 * merged in JavaScript.
 *
 * The specification asks for every stage move joined to the manager's calls,
 * the samples, the orders and the receipts, and the joining is the whole point
 * — "the sample was dispatched, and nine days later somebody moved the lead to
 * Sample received" is a sentence you can only read if the two sit next to each
 * other. Merging five separately-capped reads in the service would have looked
 * the same and been a different thing: each source capped on its own, so the
 * stream would silently be missing whichever kind happened to be busiest, and
 * no cursor could page it because there would be no single sort to page ALONG.
 *
 * A SAMPLE IS NOT ONE EVENT, which is why it contributes several rows here. It
 * is requested, approved, dispatched, received and reviewed, routinely weeks
 * apart, with three different parties asserting three of those — us that it
 * went, the carrier that it arrived, the SHOP that it is in their hands. One
 * row per sample would put all of that on whichever date was picked, and the
 * gap between dispatch and receipt is the commonest way a sample goes quiet.
 * The step is in the KEY, the same discipline `lib/timeline.ts` keeps when it
 * puts the stage in the source id: left as the bare id the five would collapse
 * onto one row and the first written would win.
 *
 * A DATE IS NOT AN INSTANT UNTIL SOMETHING NAMES THE MIDNIGHT.
 * `payment_receipts.received_at` is a DATE, and a bare `::timestamptz` on it is
 * evaluated in the SESSION's zone — which is not a property of the row, so one
 * pooled connection left in Asia/Kolkata by an earlier query would place a
 * receipt eighteen and a half hours from where another placed it, in one
 * process. In a stream sorted on that column and paged with a keyset, that is
 * a row on two pages and another on none.
 */
export async function leadStream(
  customerId: string,
  { cursor, limit = STREAM_PER_PAGE }: { cursor?: StreamCursor; limit?: number } = {},
): Promise<StreamPage> {
  /*
   * The union is built once and asked twice — the page and the counts. Written
   * out at both call sites it would be two definitions of what §25's stream IS,
   * and the half that drifts would be the counts, because nothing reads them
   * closely enough to notice a source going missing.
   */
  const stream = sql`
    select t.at as at,
           'transition'::text as kind,
           ('transition:' || t.id) as key,
           jsonb_build_object(
             'fromStage', t.from_stage::text,
             'toStage', t.to_stage::text,
             'moveKind', t.kind::text,
             'reasonCode', t.reason_code,
             'note', t.note,
             'overriddenConditions', t.overridden_conditions,
             'actorName', tu.name,
             'actorRole', t.actor_role,
             'actorApp', t.actor_app,
             'salesType', t.sales_type::text
           ) as payload
      from lead_stage_transitions t
      left join users tu on tu.id = t.actor_id
     where t.customer_id = ${customerId}

    union all

    select k.called_at,
           'call'::text,
           ('call:' || k.id),
           jsonb_build_object(
             'managerName', ku.name,
             'verdict', k.verdict::text,
             'note', coalesce(k.verdict_reason, k.notes)
           )
      from mbos_lead_validations k
      left join users ku on ku.id = k.called_by_user_id
     where k.customer_id = ${customerId}

    union all

    /* Five dates, five rows, and the step in the key. server_created_at is the
       raised instant: mbos_samples carries the handset's column set and has no
       plain created_at, and the device's own clock is its owner's to set —
       anything anybody is judged on reads the server's. NO BACKTICKS in this
       comment either; see the one in the board query above. */
    select m.at,
           'sample'::text,
           ('sample:' || s.id || ':' || m.step),
           jsonb_build_object(
             'step', m.step,
             'productName', sp.name,
             'state', s.state::text,
             'trialOutcome', s.trial_outcome::text,
             'rejectionReason', s.rejection_reason
           )
      from mbos_samples s
      left join products sp on sp.id = s.product_id
      cross join lateral (values
          (s.server_created_at, 'requested'),
          (s.approved_at, 'approved'),
          (s.dispatched_at, 'dispatched'),
          (s.received_at, 'received'),
          (s.reviewed_at, 'reviewed')
      ) as m(at, step)
     where s.customer_id = ${customerId}
       /* A null date produces no row rather than a row with no date: "not
          dispatched yet" and "dispatched on a day nobody recorded" are
          different facts, and only the first is what a null here means. */
       and m.at is not null

    union all

    select o.ordered_at,
           'order'::text,
           ('order:' || o.id),
           jsonb_build_object(
             'orderNo', o.order_no,
             'amountPaise', o.total_amount,
             'status', o.status::text,
             'declineReason', o.decline_reason
           )
      from orders o
     where o.customer_id = ${customerId}

    union all

    select (r.received_at::timestamp ${IST_DAY}),
           'receipt'::text,
           ('receipt:' || r.id),
           jsonb_build_object(
             'receiptNo', r.receipt_no,
             'amountPaise', r.amount,
             'mode', r.mode,
             'reference', r.reference,
             'status', r.status::text
           )
      from payment_receipts r
     where r.customer_id = ${customerId}
  `;

  /* The cursor's instant crosses as an ISO string and is cast explicitly. A JS
     Date bound into a raw template throws INSIDE the driver, where no type
     check sees it and the failure comes back as a retry rather than an error;
     an ISO instant carries its own zone, so this is not the bare-cast rule in
     different clothes. */
  const after = cursor
    ? sql`where (evt.at, evt.key) < (${cursor.at}::timestamptz, ${cursor.key})`
    : sql``;

  const [raw, counts] = await Promise.all([
    db.execute(sql`
      with evt as (${stream})
      select evt.at, evt.kind, evt.key, evt.payload
        from evt
        ${after}
       /* THE TIEBREAKER IS NOT OPTIONAL. Several of these land on one instant
          — a conversion writes a transition and an order in one transaction —
          and without a second sort column their order is the planner's to
          choose, which is a row on two pages and another on none. */
       order by evt.at desc, evt.key desc
       limit ${limit + 1}
    `) as unknown as Promise<Record<string, unknown>[]>,
    db.execute<{ total: number; transitions: number; overrides: number }>(sql`
      with evt as (${stream})
      select count(*)::int as total,
             count(*) filter (where evt.kind = 'transition')::int as transitions,
             /* JSONB, not a text array — so this is jsonb_array_length and NOT
                array_length, which would throw at the database and nowhere
                else. The column is NOT NULL with a default of the empty array,
                so there is no null case to guard. */
             count(*) filter (
               where evt.kind = 'transition'
                 and jsonb_array_length(evt.payload -> 'overriddenConditions') > 0
             )::int as overrides
        from evt
    `),
  ]);

  /* One more than the page asked for, so "is there another page" is answered by
     the read rather than by comparing a running total against a count taken in
     a different statement. Two reads of a growing table can disagree, and the
     disagreement shows up as a Load older button that produces nothing. */
  const hasMore = raw.length > limit;
  const page = hasMore ? raw.slice(0, limit) : raw;

  const entries = page.flatMap((r): StreamEntry[] => {
    /* `db.execute` hands a timestamptz back as a STRING whatever the annotation
       says. Null here is a row the driver could not parse — dropped rather than
       carried as an Invalid Date that throws somewhere unrelated. */
    const at = asDate(r.at);
    if (!at) return [];
    return [
      {
        key: String(r.key),
        kind: r.kind as StreamKind,
        at,
        payload: (r.payload as Record<string, unknown> | null) ?? {},
      },
    ];
  });

  const last = entries[entries.length - 1];
  return {
    entries,
    total: Number(counts[0]?.total ?? 0),
    transitionCount: Number(counts[0]?.transitions ?? 0),
    overrideCount: Number(counts[0]?.overrides ?? 0),
    next: hasMore && last ? { at: last.at.toISOString(), key: last.key } : null,
  };
}

/**
 * Who this lead is, and whether the person asking may see it at all.
 *
 * The transitions screen needs a header and it needs a gate, and they are one
 * query because they are one question: `leadTransitions` in
 * `lead-console-service.ts` reads by customer id with NO scope on it, which is
 * correct there because the record page has already resolved the lead through
 * `leadRecord`. A second screen reading the same table has to resolve it too,
 * or the id in the URL becomes a way to read the stage history of a book
 * somebody was never given.
 *
 * Null covers both "no such lead" and "not in this manager's territory", and
 * the two are deliberately the same answer — the record page makes the same
 * argument for the same reason.
 */
export type TransitionsHead = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  /**
   * The lead's own salesman, as an id as well as a name.
   *
   * The name is what the header prints; the ID is what the park control
   * pre-selects as the owner of the action a parked lead comes back to. A
   * picker that opened on "Nobody yet" for the one answer that is right nine
   * times in ten is a picker people fill in wrongly to get past it.
   */
  ownerId: string | null;
  ownerName: string | null;
};

export async function transitionsHead(customerId: string): Promise<TransitionsHead | null> {
  const scope = await managerScope();
  const rows = (await db.execute<TransitionsHead>(sql`
    select c.id as "customerId", c.name, c.company_name as "companyName", c.city,
           c.lead_sales_type::text as "salesType",
           c.lead_stage::text as stage,
           c.owner_id as "ownerId", u.name as "ownerName"
      from customers c
      left join users u on u.id = c.owner_id
     where c.id = ${customerId}
       and c.lead_stage is not null
       ${leadsVisible(scope)}
     limit 1
  `)) as unknown as TransitionsHead[];
  return rows[0] ?? null;
}

/**
 * THE RUNG A PARKED LEAD WAS PARKED FROM, which lives here and nowhere else.
 *
 * `on_hold` DISPLACES the stage, because a lead has one stage column and this
 * took it — so once a qualified lead is parked, the only record that it was
 * ever at Qualification is the `from_stage` of the transition that parked it.
 * `bandOf` refuses to guess a band for it and `gateForNext` refuses to say what
 * comes next, both deliberately; this is the read that makes coming back
 * possible, because a reopen is a move to a NAMED rung and this is the name.
 *
 * It answers null for a lead that is not parked, and — separately — it can
 * answer a row whose `fromStage` is null, where the parking transition recorded
 * no rung to return to. Those are two different facts and the screen must not
 * draw them alike: the first is a lead that is moving, the second is a parked
 * lead whose way back nobody can read off the record.
 */
export type ParkedFrom = {
  fromStage: LeadStage | null;
  at: Date;
  actorName: string | null;
  reasonCode: string | null;
  note: string | null;
};

export async function parkedFrom(customerId: string): Promise<ParkedFrom | null> {
  const rows = (await db.execute(sql`
    select t.from_stage::text as "fromStage", t.at,
           u.name as "actorName", t.reason_code as "reasonCode", t.note
      from lead_stage_transitions t
      left join users u on u.id = t.actor_id
     where t.customer_id = ${customerId}
       and t.to_stage = 'on_hold'
     order by t.at desc, t.id desc
     limit 1
  `)) as unknown as Record<string, unknown>[];

  const r = rows[0];
  if (!r) return null;
  const at = asDate(r.at);
  if (!at) return null;
  return {
    fromStage: (r.fromStage as LeadStage | null) ?? null,
    at,
    actorName: (r.actorName as string | null) ?? null,
    reasonCode: (r.reasonCode as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}
