import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "../business-date";
import type { LeadStage } from "../lead-labels";
import type { TimelineRow } from "./lead-console-service";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * The reads the RECORD page needs and the console's list service does not.
 *
 * `lead-console-service.ts` answers a desk's questions — who is waiting on my
 * call, which appointment sits on my signature — and it answers them for a
 * hundred leads at a time. This file answers the other kind: everything about
 * ONE lead that a list would never carry, and the two are apart for the same
 * reason the Sales Dashboard has its own service at all. A record page reading
 * through a list query pays for a `group by` it never looks at, and a list
 * reading through a record query asks thirty subqueries per row.
 *
 * Three rules run through every function here, and none of them is optional.
 *
 * **Scope is resolved INSIDE, never passed in.** `managerScope()` reads the
 * session here, so no call site can forget the filter — and a forgotten filter
 * is silent, looks like working software, and shows a regional manager the
 * whole country. Every read joins `customers` and carries `leadsVisible`, so a
 * URL is not a way past the narrowing a list already applies: a manager who
 * cannot see this lead on `/sales/leads` cannot read its samples by id either.
 *
 * **Every list is CAPPED and says what it is a slice of.** The cap is the easy
 * half; the count is the half that was missing on the CRM's customer record for
 * a year. A capped read that counted itself printed "34 bills" against an
 * account with a thousand and nothing on the screen said so, which is worse
 * than either number alone. So `leadPanelCounts` is nine `count(*)`s on indexed
 * columns and the panels print those.
 *
 * **Raw SQL, every column of the outer table qualified, every day window naming
 * its zone.** Drizzle renders `${customers.id}` as a bare `"id"`, which inside
 * a correlated subquery binds to the INNER table and silently makes the
 * condition false. And a stored DATE is not an instant until something names
 * the midnight — `::timestamp at time zone ${APP_TIMEZONE}`, never a bare
 * `::timestamptz`, which is evaluated in whatever zone the pooled connection
 * was left in by the query before it.
 * ------------------------------------------------------------------------- */

/* ═══════════════════════════════════════════════ §27 the park, and its rung */

/**
 * WHERE A PARKED LEAD WAS PARKED FROM, which is not in the stage column.
 *
 * `on_hold` DISPLACES the rung rather than being one — a lead has one stage
 * column and this took it — so the rung it came from lives in
 * `lead_stage_transitions.from_stage` and nowhere else. `bandOf` refuses to
 * answer for a parked lead and `gateForNext` refuses to say what comes next,
 * both deliberately, and both refusals leave a screen with nothing to draw
 * unless somebody goes and reads the transition.
 *
 * The NEWEST move into `on_hold` is the one that counts: a prospect parked in
 * March, unparked, worked up to qualification and parked again in August came
 * from qualification, and reading the oldest would send it back three rungs.
 *
 * `holdReason` comes off the customer rather than off the transition, because
 * that is where the column is and because it is edited while the lead is
 * parked — "back after Diwali" becomes "back in February" without a second
 * transition being written. Both are returned: the transition says when and
 * who, the column says what is true now.
 */
export type ParkDetail = {
  fromStage: LeadStage | null;
  at: Date | null;
  actorName: string | null;
  /** One of `leads.holdReasons`. Null on a park made before the codes existed. */
  reasonCode: string | null;
  note: string | null;
  holdReason: string | null;
  /**
   * The day it comes back, off the customer row rather than off the transition.
   *
   * The transition records the DECISION and the row records the park as it now
   * stands — and the two differ the moment somebody parks a lead again with a
   * new date, which is the ordinary way a hold is extended. The banner is a
   * statement about now, so it reads the row.
   */
  resumeDate: string | null;
};

export async function parkedFrom(customerId: string): Promise<ParkDetail | null> {
  const scope = await managerScope();
  const rows = (await db.execute(sql`
    select t.from_stage::text as "fromStage",
           t.at,
           u.name as "actorName",
           t.reason_code as "reasonCode",
           t.note,
           c.lead_hold_reason as "holdReason",
           c.lead_hold_resume_date::text as "resumeDate"
      from customers c
      left join lateral (
        select t2.from_stage, t2.at, t2.reason_code, t2.note, t2.actor_id
          from lead_stage_transitions t2
         where t2.customer_id = c.id
           and t2.to_stage = 'on_hold'
         order by t2.at desc, t2.id desc
         limit 1
      ) t on true
      left join users u on u.id = t.actor_id
     where c.id = ${customerId}
       ${leadsVisible(scope)}
     limit 1
  `)) as unknown as ParkDetail[];
  return rows[0] ?? null;
}

/* ═══════════════════════════════════════════ §25 the timeline, KEYSET paged */

/**
 * The shared timeline, one page at a time, newest first.
 *
 * **A paged read needs a tiebreaker in its sort.** A projection lands several
 * events on one instant — an order, its bill and its timeline row all carry the
 * same `occurred_at` to the microsecond — so `order by occurred_at desc` alone
 * leaves their order to the planner. Invisible until it is paged, and then it
 * is a row appearing on two pages while another appears on none. The sort is
 * `(occurred_at desc, id desc)` and the cursor compares the PAIR.
 *
 * **A keyset and never an offset.** An offset re-counts the rows it skips on
 * every page, so page forty of a lead with three thousand events costs forty
 * times page one — and worse, an event written between two pages shifts every
 * row down by one and the reader sees the same entry twice. The cursor is a
 * position in the sort rather than a distance from the top, so a write during
 * paging changes nothing about what has already been read.
 *
 * **Filtering by kind asks the SERVER.** Narrowing the twenty-five rows the
 * browser happens to hold would answer "the orders among the newest twenty-five
 * events" and print it as the order history — the exact mistake the CRM's
 * timeline pills made before their counts came from SQL.
 */
export type TimelineCursor = { at: string; id: string };

export type TimelineKindCount = { eventType: string; n: number };

export type TimelinePage = {
  rows: TimelineRow[];
  /** Null at the end of the list. What the "Load older" button sends back. */
  next: TimelineCursor | null;
  /** Every kind with a count, from `count(*)`. Never from what was loaded. */
  byKind: TimelineKindCount[];
  /** The whole history, whatever this page is showing. */
  total: number;
};

export async function leadTimelinePage(
  customerId: string,
  {
    limit = 20,
    before,
    kind,
  }: { limit?: number; before?: TimelineCursor | null; kind?: string | null } = {},
): Promise<TimelinePage> {
  const scope = await managerScope();

  /* One more than asked for, so "is there another page" is answered by the read
     rather than by a second count that can disagree with it. */
  const take = Math.max(1, Math.min(limit, 100)) + 1;

  const [rows, kinds] = await Promise.all([
    db.execute<TimelineRow>(sql`
      select e.id, e.event_type as "eventType", e.source_app::text as "sourceApp",
             e.source_record_id as "sourceRecordId",
             e.occurred_at as "occurredAt",
             u.name as "actorName", e.summary
        from timeline_events e
        join customers c on c.id = e.customer_id
        left join users u on u.id = e.actor_user_id
       where e.customer_id = ${customerId}
         ${kind ? sql`and e.event_type = ${kind}` : sql``}
         ${
           before
             ? /* The PAIR, not the instant. An instant alone excluded every
                  row sharing the cursor's microsecond, which on a projection is
                  three or four of them. */
               sql`and (e.occurred_at, e.id) < (${before.at}::timestamptz, ${before.id})`
             : sql``
         }
         ${leadsVisible(scope)}
       order by e.occurred_at desc, e.id desc
       limit ${take}
    `) as unknown as TimelineRow[],
    db.execute<TimelineKindCount>(sql`
      select e.event_type as "eventType", count(*)::int as n
        from timeline_events e
        join customers c on c.id = e.customer_id
       where e.customer_id = ${customerId}
         ${leadsVisible(scope)}
       group by e.event_type
       order by n desc, e.event_type asc
    `) as unknown as TimelineKindCount[],
  ]);

  const page = rows.slice(0, take - 1);
  const last = page[page.length - 1];
  const more = rows.length === take && last;

  return {
    rows: page,
    next: more
      ? {
          /* An ISO instant carries its own zone, so this is not the bare-cast
             rule in different clothes — and it is a STRING because `postgres`
             serialises a JS Date by asking Node to measure it as text, which
             throws inside the driver where no type check can see it. */
          at: new Date(last.occurredAt).toISOString(),
          id: last.id,
        }
      : null,
    byKind: kinds,
    total: kinds.reduce((n, k) => n + Number(k.n), 0),
  };
}

/* ═══════════════════════════════════════════════════ §15 §16 every sample */

/**
 * EVERY sample on this lead, not only the newest.
 *
 * `leadRecord.sample` answers the gate's question — is there a trial and what
 * did they think — and one row is the right answer to it. A tab is a different
 * question: a shop that rejected one product and approved another has two
 * samples that tell opposite stories, and drawing the newer alone reads as the
 * whole history of the account.
 *
 * **The three dates are kept apart, because three parties assert three things.**
 * `dispatched_at` is us saying it went, `delivered_at` is the carrier, and
 * `received_at` is the SHOP saying it is in their hands. §J turns entirely on
 * the third and a single delivery date could never answer it, so nothing here
 * defaults one from another.
 *
 * `state` and `trial_outcome` are likewise two columns and two questions. With
 * one, a sample approved three weeks ago and never dispatched looked identical
 * to one under evaluation — stock nobody gave away, beside an opportunity
 * nobody took.
 */
export type LeadSampleRow = {
  id: string;
  state: string;
  trialOutcome: string;
  productName: string | null;
  quantityCans: number | null;
  reasonCode: string | null;
  requestedDate: string | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  dispatchedAt: Date | null;
  courierName: string | null;
  trackingNumber: string | null;
  expectedDeliveryDate: string | null;
  deliveredAt: Date | null;
  receivedAt: Date | null;
  trialStartedAt: Date | null;
  trialCompletedAt: Date | null;
  reviewedAt: Date | null;
  reviewChaseCount: number;
  rejectionReason: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  /** §16's seven answers, or null where nobody has recorded any. */
  feedback: Record<string, string> | null;
  feedbackAt: Date | null;
  feedbackByName: string | null;
};

export async function leadSamplesFor(
  customerId: string,
  { limit = 10 }: { limit?: number } = {},
): Promise<LeadSampleRow[]> {
  const scope = await managerScope();
  return db.execute<LeadSampleRow>(sql`
    select s.id, s.state::text as state, s.trial_outcome::text as "trialOutcome",
           p.name as "productName", s.quantity_cans as "quantityCans",
           s.reason_code as "reasonCode",
           s.requested_date::text as "requestedDate",
           s.approved_at as "approvedAt", ap.name as "approvedByName",
           s.dispatched_at as "dispatchedAt",
           s.courier_name as "courierName", s.tracking_number as "trackingNumber",
           s.expected_delivery_date::text as "expectedDeliveryDate",
           s.delivered_at as "deliveredAt",
           s.received_at as "receivedAt",
           s.trial_started_at as "trialStartedAt",
           s.trial_completed_at as "trialCompletedAt",
           s.reviewed_at as "reviewedAt",
           s.review_chase_count as "reviewChaseCount",
           s.rejection_reason as "rejectionReason",
           s.cancelled_at as "cancelledAt", s.cancel_reason as "cancelReason",
           /* The seven, keyed the way FEEDBACK_FIELDS names them, so the
              screen renders the shared vocabulary rather than a second list of
              its own. Null where nobody has recorded any — which is not the
              same as seven empty strings, and §16 chases exactly that gap. */
           /* nullif against an empty object, because jsonb_strip_nulls on a row
              whose seven answers are all null gives {} rather than null — and
              {} is truthy on the far side, so the screen would draw an empty
              feedback list where it means to say nobody has recorded anything.
              A row that exists and says nothing is still a fact, and feedbackAt
              beside this is what keeps it. */
           (select nullif(jsonb_strip_nulls(jsonb_build_object(
                     'quality', f.quality,
                     'performance', f.performance,
                     'application', f.application,
                     'drying', f.drying,
                     'competitorComparison', f.competitor_comparison,
                     'priceFeedback', f.price_feedback,
                     'otherComments', f.other_comments)), '{}'::jsonb)
              from sample_feedback f where f.sample_id = s.id
             order by f.recorded_at desc limit 1) as feedback,
           (select f.recorded_at from sample_feedback f where f.sample_id = s.id
             order by f.recorded_at desc limit 1) as "feedbackAt",
           (select fu.name from sample_feedback f
              left join users fu on fu.id = f.recorded_by_id
             where f.sample_id = s.id
             order by f.recorded_at desc limit 1) as "feedbackByName"
      from mbos_samples s
      join customers c on c.id = s.customer_id
      left join products p on p.id = s.product_id
      left join users ap on ap.id = s.approved_by_id
     where s.customer_id = ${customerId}
       ${leadsVisible(scope)}
     /*
      * mbos_samples HAS NO created_at. It is an MBOS table, so it takes
      * mbosColumns(), which gives client_created_at — what the phone said, and
      * its owner can set it — and server_created_at, which is when we heard
      * about it. There is no third column, and s.created_at throws at the
      * database rather than at anything that could have caught it: the query is
      * a string, so nothing between here and Postgres has an opinion about the
      * name. The server's clock is preferred for the same reason anything
      * anybody is paid on reads it, and the handset's is the fallback for rows
      * written before the server stamped one — ordering by a null would put the
      * oldest sample on top.
      */
     order by coalesce(s.server_created_at, s.client_created_at) desc, s.id desc
     limit ${limit}
  `) as unknown as LeadSampleRow[];
}

/* ═══════════════════════════════════ §12 the appointment chain, as it stands */

/**
 * BOTH STEPS OF §12's CHAIN, with the decider and the note on each.
 *
 * `leadRecord` answers two booleans — did step 0 pass, did step 1 — which is
 * what the GATE needs and nothing like what a manager reading a stalled
 * appointment needs. The questions on that screen are who is sitting on it, how
 * long it has been there, and what forced a second signature at all, and none
 * of those is answerable from a boolean.
 *
 * `routeReason` is the last of those and is stored as a CODE rather than a
 * sentence — exclusivity, over_discount, over_credit_limit — because "how many
 * appointments went to management on the discount this year" is a question
 * somebody asks and a grep over free text is not an answer to it.
 *
 * A step with no row is a step nobody has ASKED for yet, which is different
 * from one waiting on a signature, and the screen draws the two apart.
 */
export type ApprovalStep = {
  id: string;
  stepIndex: number;
  state: string;
  routeReason: string | null;
  reason: string | null;
  requestedByName: string | null;
  requestedAt: Date;
  approverName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
};

export async function leadApprovalChain(customerId: string): Promise<ApprovalStep[]> {
  const scope = await managerScope();
  return db.execute<ApprovalStep>(sql`
    select a.id, a.step_index as "stepIndex", a.state::text as state,
           a.route_reason as "routeReason", a.reason,
           rq.name as "requestedByName", a.requested_at as "requestedAt",
           ap.name as "approverName", a.decided_at as "decidedAt",
           a.decision_note as "decisionNote"
      from mbos_approvals a
      join customers c on c.id = a.subject_id
      left join users rq on rq.id = a.requested_by_user_id
      left join users ap on ap.id = a.approver_user_id
     where a.subject_id = ${customerId}
       and a.type = 'distributor_appointment'
       ${leadsVisible(scope)}
     order by a.step_index asc, a.requested_at asc, a.id asc
     limit 20
  `) as unknown as ApprovalStep[];
}

/* ═════════════════════════════════════════════ §11 the distributor's answers */

/**
 * The thirty answers, ALIASED rather than handed over as a row.
 *
 * `leadRecord` reads this profile with `to_jsonb(dp.*)`, which keys the object
 * on the PHYSICAL column names — `gst_verified`, `monthly_potential_paise`. The
 * thirty conditions in `lead-gates.ts` read camelCase off the same object, and
 * a key that does not exist is `undefined`, which `has()` reads as "not
 * answered". So this is selected with explicit aliases instead: a naming
 * boundary crossed by a cast is the bug rather than the fix, and this one is
 * the same shape as the `canRead` failure that refused every attachment for
 * months.
 *
 * Money is paise and stays paise — `money()` formats on the way to the screen
 * and nowhere else.
 */
export type DistributorProfile = {
  gstVerified: boolean | null;
  panNumber: string | null;
  panVerified: boolean | null;
  businessAddressVerified: boolean | null;
  businessType: string | null;
  yearsInBusiness: number | null;
  decisionMaker: string | null;
  hasDealerNetwork: boolean | null;
  activeDealerCount: number | null;
  territoryCovered: string | null;
  citiesCovered: string | null;
  salesTeamSize: number | null;
  deliveryCapability: string | null;
  hasWarehouse: boolean | null;
  storageCapacityLitres: number | null;
  productPortfolio: string | null;
  competitorBrands: string | null;
  monthlyPotentialPaise: number | null;
  initialOrderPotentialPaise: number | null;
  investmentCapacityPaise: number | null;
  expectedMonthlyPurchasePaise: number | null;
  creditDaysRequired: number | null;
  creditLimitRequiredPaise: number | null;
  proposedTerritory: string | null;
  existingDistributorChecked: boolean | null;
  territoryConflict: boolean | null;
  territoryConflictNote: string | null;
  exclusivityRequested: boolean | null;
  initialStockCommitmentPaise: number | null;
  monthlyPurchaseCommitmentPaise: number | null;
  dealerDevelopmentCommitment: string | null;
  expectedStartDate: string | null;
  specialDiscountPercent: number | null;
  agreedCreditLimitPaise: number | null;
  exclusivityGranted: boolean | null;
  commercialTermsNote: string | null;
  commercialTermsAgreedAt: Date | null;
};

export async function distributorProfileFor(
  customerId: string,
): Promise<DistributorProfile | null> {
  const scope = await managerScope();
  const rows = (await db.execute<DistributorProfile>(sql`
    select dp.gst_verified as "gstVerified",
           dp.pan_number as "panNumber",
           dp.pan_verified as "panVerified",
           dp.business_address_verified as "businessAddressVerified",
           dp.business_type as "businessType",
           dp.years_in_business as "yearsInBusiness",
           dp.decision_maker as "decisionMaker",
           dp.has_dealer_network as "hasDealerNetwork",
           dp.active_dealer_count as "activeDealerCount",
           dp.territory_covered as "territoryCovered",
           dp.cities_covered as "citiesCovered",
           dp.sales_team_size as "salesTeamSize",
           dp.delivery_capability as "deliveryCapability",
           dp.has_warehouse as "hasWarehouse",
           dp.storage_capacity_litres as "storageCapacityLitres",
           dp.product_portfolio as "productPortfolio",
           dp.competitor_brands as "competitorBrands",
           dp.monthly_potential_paise as "monthlyPotentialPaise",
           dp.initial_order_potential_paise as "initialOrderPotentialPaise",
           dp.investment_capacity_paise as "investmentCapacityPaise",
           dp.expected_monthly_purchase_paise as "expectedMonthlyPurchasePaise",
           dp.credit_days_required as "creditDaysRequired",
           dp.credit_limit_required_paise as "creditLimitRequiredPaise",
           dp.proposed_territory as "proposedTerritory",
           dp.existing_distributor_checked as "existingDistributorChecked",
           dp.territory_conflict as "territoryConflict",
           dp.territory_conflict_note as "territoryConflictNote",
           dp.exclusivity_requested as "exclusivityRequested",
           dp.initial_stock_commitment_paise as "initialStockCommitmentPaise",
           dp.monthly_purchase_commitment_paise as "monthlyPurchaseCommitmentPaise",
           dp.dealer_development_commitment as "dealerDevelopmentCommitment",
           dp.expected_start_date::text as "expectedStartDate",
           dp.special_discount_percent as "specialDiscountPercent",
           dp.agreed_credit_limit_paise as "agreedCreditLimitPaise",
           dp.exclusivity_granted as "exclusivityGranted",
           dp.commercial_terms_note as "commercialTermsNote",
           dp.commercial_terms_agreed_at as "commercialTermsAgreedAt"
      from distributor_profiles dp
      join customers c on c.id = dp.customer_id
     where dp.customer_id = ${customerId}
       ${leadsVisible(scope)}
     limit 1
  `)) as unknown as DistributorProfile[];
  return rows[0] ?? null;
}

/* ══════════════════════════════════════ what every capped list is a slice of */

/**
 * NINE `count(*)`s, so nine panels can say what they are showing part of.
 *
 * Every list on this record is capped — fifty orders, fifty receipts, thirty
 * communications, twenty calls — and a cap without a count is the failure the
 * CRM's customer record carried for a year: a page that printed what it had
 * loaded and called it the history. The accounts with the most of it are
 * exactly the ones somebody most needs to read before ringing, and they were
 * the ones you could see the least of.
 *
 * They are counts on indexed columns and they are one round trip, because the
 * alternative — asking each panel's own query for its total — is nine more
 * reads of tables that were just read.
 */
export type LeadPanelCounts = {
  orders: number;
  receipts: number;
  bills: number;
  communications: number;
  transitions: number;
  calls: number;
  samples: number;
  visits: number;
  tasks: number;
};

export async function leadPanelCounts(customerId: string): Promise<LeadPanelCounts> {
  const scope = await managerScope();
  const rows = (await db.execute<LeadPanelCounts>(sql`
    select
      (select count(*)::int from orders o where o.customer_id = c.id) as orders,
      (select count(*)::int from payment_receipts r where r.customer_id = c.id) as receipts,
      (select count(*)::int from bills b where b.customer_id = c.id) as bills,
      (select count(*)::int from timeline_events e
        where e.customer_id = c.id and e.event_type = 'lead_communication') as communications,
      (select count(*)::int from lead_stage_transitions t
        where t.customer_id = c.id) as transitions,
      (select count(*)::int from mbos_lead_validations k
        where k.customer_id = c.id) as calls,
      (select count(*)::int from mbos_samples s where s.customer_id = c.id) as samples,
      (select count(*)::int from mbos_visits v where v.customer_id = c.id) as visits,
      (select count(*)::int from mbos_tasks t where t.customer_id = c.id) as tasks
      from customers c
     where c.id = ${customerId}
       ${leadsVisible(scope)}
     limit 1
  `)) as unknown as LeadPanelCounts[];

  return (
    rows[0] ?? {
      orders: 0,
      receipts: 0,
      bills: 0,
      communications: 0,
      transitions: 0,
      calls: 0,
      samples: 0,
      visits: 0,
      tasks: 0,
    }
  );
}

/* ═══════════════════════════════════════════ §4 the visits behind the cap */

/**
 * The visits this lead has had, for the screen that has to ask for a decision.
 *
 * §4's cap is COUNTED from `mbos_visits` and is deliberately not a column: a
 * counter would drift the first time a visit arrived late from a handset, which
 * on a book worked in market lanes is most of them. The count is already on the
 * record; what this adds is the visits themselves, so "this suspect is out of
 * visits" can be read beside the three that used them up rather than asserted
 * over nothing.
 *
 * The check-in date is a stored timestamp and it is rendered as a DAY, so the
 * zone is named: a bare `::date` is evaluated in the session's zone, which puts
 * a 9am visit on the previous day the moment the database is not Asia/Kolkata —
 * and a local Postgres set to Asia/Kolkata hides it completely rather than
 * fixing it.
 */
export type LeadVisitRow = {
  id: string;
  visitDate: string | null;
  salesmanName: string | null;
  outcome: string | null;
  verified: boolean | null;
  notes: string | null;
};

export async function leadVisitsFor(
  customerId: string,
  { limit = 10 }: { limit?: number } = {},
): Promise<LeadVisitRow[]> {
  const scope = await managerScope();
  return db.execute<LeadVisitRow>(sql`
    select v.id,
           (v.check_in_at at time zone ${APP_TIMEZONE})::date::text as "visitDate",
           u.name as "salesmanName",
           v.outcome::text as outcome,
           v.verified,
           v.notes
      from mbos_visits v
      join customers c on c.id = v.customer_id
      left join users u on u.id = v.salesman_id
     where v.customer_id = ${customerId}
       ${leadsVisible(scope)}
     order by v.check_in_at desc nulls last, v.id desc
     limit ${limit}
  `) as unknown as LeadVisitRow[];
}
