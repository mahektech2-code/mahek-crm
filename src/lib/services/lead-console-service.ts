import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { canFor, type Capability } from "../access-control";
import { bandOf, ladderFor } from "../engines/lead-ladder";
import type { LeadGateInput } from "../engines/lead-gates";
import {
  verificationAnswers,
  verificationVerdict,
  type LeadSalesType,
  type LeadStage,
} from "../lead-labels";
import { asDate } from "../business-date";
import { orderCountsSql } from "../order-status";
import { managerScope, onlyMine } from "./sales-service";

/* ---------------------------------------------------------------------------
 * Every read the funnel's OFFICE end makes.
 *
 * The handset works one lead at a time and asks about that lead; a sales
 * manager works a desk and asks about a queue — who is waiting on my call, what
 * has nobody promised anything about, which appointment is sitting on my
 * signature, which sample nobody has chased. Those are list questions, and they
 * are here rather than in `lead-service.ts` for the same reason the Sales
 * Dashboard has its own service at all: a screen that lists two hundred leads
 * and a screen that shows one have almost no SQL in common, and folding them
 * would give the record page a query it pays for and never reads.
 *
 * Two rules run through it, both inherited from `sales-service.ts` and both
 * load-bearing.
 *
 * **Scope is resolved here, never passed in.** `managerScope()` reads the
 * session inside the service, so there is no call site that can forget the
 * filter — and a forgotten filter is silent, looks like working software, and
 * shows a regional manager the whole country. A manager granted Reports must
 * not see the whole company through this.
 *
 * **Raw SQL, every column of the outer table qualified, every day window
 * naming its zone.** Drizzle renders `${customers.id}` as a bare `"id"`, which
 * inside a correlated subquery binds to the INNER table and silently makes the
 * condition false. And a bare `::date` reads in the session's zone, which puts
 * a 9am visit on the wrong day the moment the database is not Asia/Kolkata.
 * ------------------------------------------------------------------------- */

/**
 * The rungs that are still the funnel's work.
 *
 * Every list here excludes the terminal ones — a queue is what is waiting, and
 * a lost lead is not waiting on anybody. It is written as a SQL fragment rather
 * than derived from `TERMINAL_STAGES` because the enum values and the engine's
 * list are the same set said twice; the engine is the authority on the ladder,
 * and this is the authority on what a WORKLIST is.
 */
const STILL_WORKING = sql.raw(
  `c.lead_stage is not null
     and c.lead_archived = false
     and c.lead_stage not in ('lost', 'won', 'customer', 'active_distributor')`,
);

/**
 * The four capabilities the funnel adds, named in one place.
 *
 * A thin wrapper over `can` rather than four calls to it scattered through the
 * screens, for the reason every list here is a constant: these four move
 * together — they are one feature's permissions — and a screen that reached for
 * `can` directly would be the place somebody later asked for `lead.verify` and
 * got `lead.work` because the two read alike at a glance. The narrowing to
 * these four is the point; `can` itself is unchanged and is still the authority.
 */
export type LeadCapability = Extract<
  Capability,
  | "lead.work"
  | "lead.override"
  | "lead.verify"
  | "distributor.approve"
  | "distributor.terms"
  /*
   * §22 — the handover, and the one capability here that is NOT the funnel's.
   *
   * It names who RUNS the relationship, which moves no revenue, no target and
   * no collections list — so it is a manager's, and it is not
   * `customer.reassign`. That one moves the sales seat, decides whose targets
   * an account counts toward, and stays accounts' and admin's; this panel
   * called it for a while and so could not be used by the people whose job the
   * handover is. Listed here rather than reached for with a bare `canFor()`
   * beside this narrowing, because two doors onto one question is how one of
   * them ends up more generous.
   */
  | "customer.handOver"
>;

export async function canLead(
  user: { id: string; role: string },
  capability: LeadCapability,
): Promise<boolean> {
  return canFor(user, capability);
}

/* ═══════════════════════════════════════════════ §7 §8 the verification queue */

export type VerificationRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  area: string | null;
  mobile: string | null;
  contactPerson: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerId: string | null;
  leadManagerName: string | null;
  /** The day it reached Prospect. What the wait is measured from. */
  prospectSince: string | null;
  waitingDays: number;
  /** True where the signed-in manager is the one who owes this call. */
  mine: boolean;
  /** What the salesman already established, so the call is not asked twice. */
  monthlyLitres: number | null;
  competitor: string | null;
  requiredProductName: string | null;
  potentialPaise: number | null;
  /** A follow-up call already recorded — verified false is not a closed lead. */
  attempts: number;
  lastAttemptAt: Date | null;
};

/**
 * §7 — prospects waiting on their manager's verification call, oldest first.
 *
 * **Oldest first and nothing else.** Not by value, not by salesman: the
 * specification makes this the FIRST thing that happens to a prospect and the
 * gate to Qualification refuses to open without it, so every day a lead sits
 * here is a day the salesman cannot move. Sorting by potential would leave the
 * small ones permanently at the bottom of a list that is a blockage rather
 * than an opportunity.
 *
 * **A lead with no manager is shown, not hidden.** `lead_manager_id` is filled
 * from `mbos_manager_territories` when the lead reaches Prospect, and a
 * territory nobody covers leaves it null — which is exactly the row a manager
 * most needs to see, because nobody else is going to. It is marked as not
 * theirs rather than dropped, the same way an unassigned customer is said in
 * words on a team list.
 *
 * `total` comes from SQL rather than from the length of the capped list, so a
 * desk of four hundred says four hundred.
 */
export async function verificationQueue(
  day: string,
  { limit = 100 }: { limit?: number } = {},
): Promise<{ rows: VerificationRow[]; total: number; mine: number }> {
  const scope = await managerScope();
  const me = await currentUserId();

  const where = sql`
     where ${STILL_WORKING}
       and c.lead_stage = 'prospect'
       and c.lead_verified_at is null
       ${onlyMine(scope, "c.owner_id")}
  `;

  const [rows, counts] = await Promise.all([
    db.execute<VerificationRow>(sql`
      select c.id as "customerId", c.name, c.company_name as "companyName",
             c.city, c.area, c.phone as mobile, c.contact_person as "contactPerson",
             c.lead_sales_type::text as "salesType",
             c.lead_stage::text as stage,
             c.owner_id as "salesmanId", u.name as "salesmanName",
             c.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
             c.lead_stage_since::text as "prospectSince",
             coalesce(${day}::date - c.lead_stage_since, 0)::int as "waitingDays",
             (c.lead_manager_id = ${me}) as mine,
             c.lead_monthly_volume_litres as "monthlyLitres",
             c.lead_competitor as competitor,
             p.name as "requiredProductName",
             c.lead_estimated_potential_paise as "potentialPaise",
             (select count(*)::int from mbos_lead_validations k
               where k.customer_id = c.id) as attempts,
             (select max(k.called_at) from mbos_lead_validations k
               where k.customer_id = c.id) as "lastAttemptAt"
        from customers c
        left join users u on u.id = c.owner_id
        left join users m on m.id = c.lead_manager_id
        left join products p on p.id = c.lead_required_product_id
        ${where}
       order by c.lead_stage_since asc nulls first, c.id asc
       limit ${limit}
    `) as unknown as VerificationRow[],
    db.execute<{ total: number; mine: number }>(sql`
      select count(*)::int as total,
             count(*) filter (where c.lead_manager_id = ${me})::int as mine
        from customers c
        ${where}
    `),
  ]);

  return {
    rows,
    total: Number(counts[0]?.total ?? 0),
    mine: Number(counts[0]?.mine ?? 0),
  };
}

/* ═══════════════════════════════════════════════════ §3 the funnel, by type */

export type FunnelBandCount = {
  band: "new" | "contacted" | "qualified" | "negotiation";
  count: number;
  potentialPaise: number;
};

export type FunnelByType = {
  salesType: LeadSalesType | null;
  bands: FunnelBandCount[];
  /** Everything still in the funnel, whatever band it landed in. */
  inFunnel: number;
  inFunnelPotentialPaise: number;
  /** Out of it, and counted separately — a funnel that includes the business
   *  it already did is a funnel that only ever grows. */
  won: number;
  lost: number;
};

const BANDS: FunnelBandCount["band"][] = ["new", "contacted", "qualified", "negotiation"];

/**
 * §3 — one funnel per sales type, because they are three different climbs.
 *
 * The console's bar counted four bands of one ladder, which was right while
 * there was one ladder and stopped being right the moment a distributor
 * appointment could sit in it: "Negotiation" then means "talking about
 * quantity" for a shop and "management has appointed them" for a distributor,
 * and a manager reading one number cannot tell which they are looking at.
 *
 * The counting is SQL and the BANDING is `bandOf`, deliberately. Seventeen
 * stage values fold onto four bands and that mapping already exists in the
 * engine the handset and the owner's cohort both read; restating it as a
 * `case` in this query would be a second copy, and the copy that drifts is
 * always the one somebody is reading.
 */
export async function leadFunnel(): Promise<FunnelByType[]> {
  const scope = await managerScope();

  const rows = await db.execute<{
    salesType: LeadSalesType | null;
    stage: LeadStage;
    n: number;
    potential: number | null;
  }>(sql`
    select c.lead_sales_type::text as "salesType",
           c.lead_stage::text as stage,
           count(*)::int as n,
           coalesce(sum(c.lead_estimated_potential_paise), 0) as potential
      from customers c
     where c.lead_stage is not null
       and c.lead_archived = false
       ${onlyMine(scope, "c.owner_id")}
     group by 1, 2
  `);

  const byType = new Map<string, FunnelByType>();
  const key = (t: LeadSalesType | null) => t ?? "legacy";

  for (const r of rows) {
    const k = key(r.salesType);
    let f = byType.get(k);
    if (!f) {
      f = {
        salesType: r.salesType,
        bands: BANDS.map((band) => ({ band, count: 0, potentialPaise: 0 })),
        inFunnel: 0,
        inFunnelPotentialPaise: 0,
        won: 0,
        lost: 0,
      };
      byType.set(k, f);
    }

    if (r.stage === "lost") {
      f.lost += r.n;
      continue;
    }

    const band = bandOf(r.stage);
    if (!band) {
      /* `won`, `customer` and `active_distributor` — arrived rather than
         waiting, and counted as such. */
      f.won += r.n;
      continue;
    }

    const cell = f.bands.find((b) => b.band === band)!;
    cell.count += r.n;
    cell.potentialPaise += Number(r.potential ?? 0);
    f.inFunnel += r.n;
    f.inFunnelPotentialPaise += Number(r.potential ?? 0);
  }

  /* A stable order: the three real ladders as the specification lists them,
     then the leads raised before any of this existed. */
  const order: (LeadSalesType | null)[] = ["direct", "distributor", "third_party", null];
  return order
    .map((t) => byType.get(key(t)))
    .filter((f): f is FunnelByType => Boolean(f));
}

/* ═══════════════════════════════════════════ §24 leads with no next action */

export type NoNextActionRow = {
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
  stageSince: string | null;
  stuckDays: number;
  quietDays: number;
  /** Which half is missing — a date with no action is as useless as neither. */
  hasAction: boolean;
  hasDate: boolean;
  hasOwner: boolean;
  /** Set where somebody promised a day that has since gone past. */
  overdueDays: number | null;
};

/**
 * §24 — the exception list, and it should be empty.
 *
 * The rule is that an active lead may never sit with nothing owed by anybody,
 * and `advanceLeadStage` enforces it on every upward move. What that does not
 * catch is a lead that already had a next action and outlived it: the day comes
 * and goes, nobody records an outcome, and the lead is now exactly as
 * unattended as one that never had a plan. Both shapes are on this list,
 * because a manager asking "what is nobody working" means both.
 *
 * Worst first — no plan at all, then the most overdue promise — for the same
 * reason the expense exceptions screen sorts that way: a lead nobody has said
 * anything about is a different order of thing from one whose call was due
 * yesterday, and a list sorted by date buries the first under the second.
 */
export async function leadsWithoutNextAction(
  day: string,
  { limit = 200 }: { limit?: number } = {},
): Promise<{ rows: NoNextActionRow[]; total: number; unplanned: number }> {
  const scope = await managerScope();

  const where = sql`
     where ${STILL_WORKING}
       and (
         c.lead_next_action is null
         or c.lead_next_action_date is null
         or c.lead_next_action_owner_id is null
         or (c.lead_next_action_date < ${day}::date and c.lead_next_action_outcome is null)
       )
       ${onlyMine(scope, "c.owner_id")}
  `;

  const [rows, counts] = await Promise.all([
    db.execute<NoNextActionRow>(sql`
      select c.id as "customerId", c.name, c.company_name as "companyName", c.city,
             c.lead_sales_type::text as "salesType",
             c.lead_stage::text as stage,
             c.owner_id as "salesmanId", u.name as "salesmanName",
             c.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
             c.lead_stage_since::text as "stageSince",
             coalesce(${day}::date - c.lead_stage_since, 0)::int as "stuckDays",
             coalesce(${day}::date - c.lead_last_activity_date, 0)::int as "quietDays",
             (c.lead_next_action is not null) as "hasAction",
             (c.lead_next_action_date is not null) as "hasDate",
             (c.lead_next_action_owner_id is not null) as "hasOwner",
             case when c.lead_next_action_date < ${day}::date
                  then (${day}::date - c.lead_next_action_date)::int end as "overdueDays"
        from customers c
        left join users u on u.id = c.owner_id
        left join users m on m.id = c.lead_manager_id
        ${where}
       order by
         case when c.lead_next_action is null
                or c.lead_next_action_date is null
                or c.lead_next_action_owner_id is null then 0 else 1 end,
         c.lead_next_action_date asc nulls first,
         c.lead_stage_since asc nulls first,
         c.id asc
       limit ${limit}
    `) as unknown as NoNextActionRow[],
    db.execute<{ total: number; unplanned: number }>(sql`
      select count(*)::int as total,
             count(*) filter (
               where c.lead_next_action is null
                  or c.lead_next_action_date is null
                  or c.lead_next_action_owner_id is null
             )::int as unplanned
        from customers c
        ${where}
    `),
  ]);

  return {
    rows,
    total: Number(counts[0]?.total ?? 0),
    unplanned: Number(counts[0]?.unplanned ?? 0),
  };
}

/* ═════════════════════════════════════════ §12 the distributor appointment */

export type AppointmentRow = {
  approvalId: string;
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  stage: LeadStage;
  /** 0 is the sales manager's review, 1 is management. */
  stepIndex: number;
  state: string;
  /** Why this step exists: `exclusivity`, `over_discount`, `over_credit_limit`. */
  routeReason: string | null;
  requestedAt: Date;
  requestedByName: string | null;
  waitingHours: number;
  decisionNote: string | null;
  approverName: string | null;
  /** The three numbers §12 says force a second signature. */
  discountPercent: number | null;
  creditLimitPaise: number | null;
  exclusivityGranted: boolean | null;
  creditLimitRequestedPaise: number | null;
  proposedTerritory: string | null;
  territoryConflict: boolean | null;
  monthlyPotentialPaise: number | null;
  initialStockCommitmentPaise: number | null;
  commercialTermsAgreedAt: Date | null;
  /** True once the step below has said yes — step 1 cannot run ahead of it. */
  managerStepDone: boolean;
};

/**
 * §12 — appointments waiting on a signature, by step.
 *
 * One row per approval rather than per candidate, because the two steps are
 * two decisions with two people and two dates. Rolling them into a single
 * "pending" row per distributor is what makes it impossible to say whether the
 * thing waiting is a sales manager who has not looked or a director who has
 * not been asked yet.
 *
 * `managerStepDone` is read rather than assumed: nothing stops step 1 being
 * created early, and a screen that offers management a decision on something
 * their own sales manager has not seen is offering them somebody else's job.
 */
export async function appointmentQueue(): Promise<AppointmentRow[]> {
  const scope = await managerScope();
  return db.execute<AppointmentRow>(sql`
    select a.id as "approvalId",
           c.id as "customerId", c.name, c.company_name as "companyName", c.city,
           c.lead_stage::text as stage,
           a.step_index as "stepIndex",
           a.state::text as state,
           a.route_reason as "routeReason",
           a.requested_at as "requestedAt",
           r.name as "requestedByName",
           (extract(epoch from (now() - a.requested_at)) / 3600)::int as "waitingHours",
           a.decision_note as "decisionNote",
           d.name as "approverName",
           p.special_discount_percent as "discountPercent",
           p.agreed_credit_limit_paise as "creditLimitPaise",
           p.exclusivity_granted as "exclusivityGranted",
           p.credit_limit_required_paise as "creditLimitRequestedPaise",
           p.proposed_territory as "proposedTerritory",
           p.territory_conflict as "territoryConflict",
           p.monthly_potential_paise as "monthlyPotentialPaise",
           p.initial_stock_commitment_paise as "initialStockCommitmentPaise",
           p.commercial_terms_agreed_at as "commercialTermsAgreedAt",
           exists (
             select 1 from mbos_approvals prior
              where prior.subject_type = a.subject_type
                and prior.subject_id = a.subject_id
                and prior.type = 'distributor_appointment'
                and prior.step_index < a.step_index
                and prior.state in ('approved', 'partially_approved')
           ) as "managerStepDone"
      from mbos_approvals a
      join customers c on c.id = a.subject_id
      left join distributor_profiles p on p.customer_id = c.id
      left join users r on r.id = a.requested_by_user_id
      left join users d on d.id = a.approver_user_id
     where a.type = 'distributor_appointment'
       and a.state = 'pending'
       and a.subject_type = 'customers'
       ${onlyMine(scope, "c.owner_id")}
     order by a.step_index asc, a.requested_at asc, a.id asc
     limit 200
  `) as unknown as AppointmentRow[];
}

/* ═══════════════════════════════════════════════════ §15 §16 the sample desk */

export type SampleDeskRow = {
  id: string;
  customerId: string;
  customerName: string;
  city: string | null;
  salesmanId: string;
  salesmanName: string | null;
  productName: string | null;
  quantityCans: number | null;
  application: string | null;
  reasonCode: string | null;
  state: string;
  trialOutcome: string;
  requestedDate: string | null;
  approvalId: string | null;
  approvalState: string | null;
  dispatchedAt: Date | null;
  courierName: string | null;
  trackingNumber: string | null;
  expectedDeliveryDate: string | null;
  receivedAt: Date | null;
  /** Days past what the courier promised. Null before dispatch, or once it landed. */
  lateByDays: number | null;
  reviewChaseCount: number;
  lastReviewChaseAt: Date | null;
  feedbackRecorded: boolean;
  feedbackQuality: string | null;
  feedbackPerformance: string | null;
  feedbackPrice: string | null;
  feedbackCompetitor: string | null;
  leadStage: LeadStage | null;
  salesType: LeadSalesType | null;
};

/**
 * §15 §16 — everything out on trial, with the whole of its life on the row.
 *
 * The existing Samples screen answers one question — what has no feedback —
 * and answers it well. This is the desk BEHIND it: approve the request, record
 * the dispatch and the docket, watch the delivery against what the courier
 * promised, read what the customer actually said. They are separate screens
 * rather than more columns because they are separate jobs at separate hours,
 * and a table wide enough for both is one nobody reads either half of.
 *
 * `reviewChaseCount` is on the row and not summarised away. "Asked three
 * times" is the number that tells a manager to stop raising tasks and ring the
 * shop themselves, and it is invisible in any figure that only counts what is
 * outstanding.
 */
export async function sampleDesk(
  day: string,
  { limit = 200 }: { limit?: number } = {},
): Promise<SampleDeskRow[]> {
  const scope = await managerScope();
  return db.execute<SampleDeskRow>(sql`
    select s.id, s.customer_id as "customerId", c.name as "customerName", c.city,
           s.salesman_id as "salesmanId", u.name as "salesmanName",
           p.name as "productName",
           s.quantity_cans as "quantityCans",
           s.application, s.reason_code as "reasonCode",
           s.state::text as state,
           s.trial_outcome::text as "trialOutcome",
           s.requested_date::text as "requestedDate",
           a.id as "approvalId", a.state::text as "approvalState",
           s.dispatched_at as "dispatchedAt",
           s.courier_name as "courierName", s.tracking_number as "trackingNumber",
           s.expected_delivery_date::text as "expectedDeliveryDate",
           s.received_at as "receivedAt",
           case when s.received_at is null
                 and s.expected_delivery_date is not null
                 and s.expected_delivery_date < ${day}::date
                then (${day}::date - s.expected_delivery_date)::int end as "lateByDays",
           s.review_chase_count as "reviewChaseCount",
           s.last_review_chase_at as "lastReviewChaseAt",
           (f.id is not null) as "feedbackRecorded",
           f.quality as "feedbackQuality",
           f.performance as "feedbackPerformance",
           f.price_feedback as "feedbackPrice",
           f.competitor_comparison as "feedbackCompetitor",
           c.lead_stage::text as "leadStage",
           c.lead_sales_type::text as "salesType"
      from mbos_samples s
      join customers c on c.id = s.customer_id
      left join users u on u.id = s.salesman_id
      left join products p on p.id = s.product_id
      left join sample_feedback f on f.sample_id = s.id
      left join mbos_approvals a
             on a.subject_id = s.id and a.type = 'sample'
     where s.state <> 'cancelled'
       ${onlyMine(scope, "s.salesman_id")}
     order by
       /* Worst first: a request nobody has answered stops a salesman dead;
          a delivery past its promised date is a courier to ring; everything
          else is the ordinary queue, newest last. */
       case
         when a.state = 'pending' then 0
         when s.received_at is null and s.expected_delivery_date < ${day}::date then 1
         when s.state in ('received', 'trial_done') and f.id is null then 2
         else 3
       end,
       s.requested_date asc nulls last, s.id asc
     limit ${limit}
  `) as unknown as SampleDeskRow[];
}

/* ═════════════════════════════════════════════════ §13 the nurture schedule */

export type NurtureRow = {
  id: string;
  title: string;
  description: string | null;
  customerId: string | null;
  customerName: string | null;
  assignedToUserId: string;
  assignedToName: string | null;
  dueDate: string | null;
  status: string;
  completedAt: Date | null;
  sourceType: string | null;
  /** Negative is overdue, 0 is today. Null where nothing named a day. */
  dueInDays: number | null;
  leadStage: LeadStage | null;
  salesType: LeadSalesType | null;
};

export type NurtureSchedule = {
  overdue: NurtureRow[];
  today: NurtureRow[];
  ahead: NurtureRow[];
  done: NurtureRow[];
  /** From SQL, so a capped list still says what it is a slice of. */
  counts: { overdue: number; today: number; ahead: number; done: number };
};

/**
 * §13 — the nurture sequence as it actually stands, rather than as a table of
 * rules.
 *
 * `NURTURE_SEQUENCE` in `lib/lead-labels.ts` says what SHOULD be raised and
 * when; this says what was, what is due, and what nobody did. A schedule
 * nobody can see is one nobody trusts, and a nurture engine whose output is
 * invisible is indistinguishable from one that is not running — which is the
 * failure mode that made the field photographs disappear for a year.
 *
 * It reads `mbos_tasks` because that is where the sequence lands: the engine
 * raises a task against the lead's customer row, owned by whichever of the two
 * people §13 says owes it. Nothing here writes one.
 *
 It deliberately reads EVERY task against a funnel lead rather than only those
 * carrying `lead-nurture.ts`'s own `NURTURE_SOURCE_TYPE`. A manager-raised task
 * on a lead is on the same schedule as a generated one — the salesman does not
 * experience them as two lists — and a screen that showed only the generated
 * half would present it as the whole plan. `sourceType` comes back on the row
 * so the two can still be told apart where it matters.
 */
export async function nurtureSchedule(
  day: string,
  { customerId, limit = 60 }: { customerId?: string; limit?: number } = {},
): Promise<NurtureSchedule> {
  const scope = await managerScope();
  const only = customerId ? sql`and t.customer_id = ${customerId}` : sql``;

  const rows = (await db.execute<NurtureRow>(sql`
    select t.id, t.title, t.description,
           t.customer_id as "customerId", c.name as "customerName",
           t.assigned_to_user_id as "assignedToUserId", u.name as "assignedToName",
           t.due_date::text as "dueDate",
           t.status::text as status,
           t.completed_at as "completedAt",
           t.source_type as "sourceType",
           case when t.due_date is not null
                then (t.due_date - ${day}::date)::int end as "dueInDays",
           c.lead_stage::text as "leadStage",
           c.lead_sales_type::text as "salesType"
      from mbos_tasks t
      join customers c on c.id = t.customer_id
      left join users u on u.id = t.assigned_to_user_id
     where c.lead_stage is not null
       and c.lead_archived = false
       ${only}
       ${onlyMine(scope, "t.assigned_to_user_id")}
     order by
       case when t.status in ('done', 'cancelled') then 1 else 0 end,
       t.due_date asc nulls last, t.id asc
     limit ${limit * 4}
  `)) as unknown as NurtureRow[];

  const counts = await db.execute<{
    overdue: number;
    today: number;
    ahead: number;
    done: number;
  }>(sql`
    select count(*) filter (
             where t.status not in ('done', 'cancelled') and t.due_date < ${day}::date
           )::int as overdue,
           count(*) filter (
             where t.status not in ('done', 'cancelled') and t.due_date = ${day}::date
           )::int as today,
           count(*) filter (
             where t.status not in ('done', 'cancelled')
               and (t.due_date > ${day}::date or t.due_date is null)
           )::int as ahead,
           count(*) filter (where t.status in ('done', 'cancelled'))::int as done
      from mbos_tasks t
      join customers c on c.id = t.customer_id
     where c.lead_stage is not null
       and c.lead_archived = false
       ${only}
       ${onlyMine(scope, "t.assigned_to_user_id")}
  `);

  const open = rows.filter((r) => r.status !== "done" && r.status !== "cancelled");
  return {
    overdue: open.filter((r) => r.dueInDays != null && r.dueInDays < 0).slice(0, limit),
    today: open.filter((r) => r.dueInDays === 0).slice(0, limit),
    ahead: open.filter((r) => r.dueInDays == null || r.dueInDays > 0).slice(0, limit),
    done: rows
      .filter((r) => r.status === "done" || r.status === "cancelled")
      .slice(0, limit),
    counts: {
      overdue: Number(counts[0]?.overdue ?? 0),
      today: Number(counts[0]?.today ?? 0),
      ahead: Number(counts[0]?.ahead ?? 0),
      done: Number(counts[0]?.done ?? 0),
    },
  };
}

/* ═══════════════════════════════════════════ §14 the documents behind the buttons */

export type PublishedDocument = {
  id: string;
  title: string;
  category: string;
  attachmentId: string | null;
  updatedAt: Date | null;
};

/**
 * §14 — the current published document for each category the buttons reach.
 *
 * The point of the eleven buttons is that a manager never hunts for a file, so
 * the button has to resolve to something without being told which. Newest
 * active document of the category wins, and one per category is returned: a
 * picker between three price lists is the hunt this replaces.
 *
 * A category with nothing published comes back ABSENT rather than as an empty
 * row, so the screen can say "no price list is published" instead of drawing a
 * button that fails when pressed. A control that dies on the click is worse
 * than one that says why it cannot work.
 *
 * Customer-specific documents — a KYC file, a signed agreement — are excluded:
 * those belong to one account and are not what a broadcast button sends.
 */
export async function publishedDocuments(): Promise<Record<string, PublishedDocument>> {
  const rows = (await db.execute<PublishedDocument>(sql`
    select distinct on (d.category)
           d.id, d.title, d.category::text as category,
           d.attachment_id as "attachmentId",
           d.updated_at as "updatedAt"
      from mbos_documents d
     where d.active
       and d.customer_id is null
     order by d.category, d.updated_at desc nulls last, d.id desc
  `)) as unknown as PublishedDocument[];

  return Object.fromEntries(rows.map((r) => [r.category, r]));
}

/* ═════════════════════════════════════════════════════════ the record page */

export type LeadTransition = {
  id: string;
  fromStage: LeadStage | null;
  toStage: LeadStage;
  kind: string;
  reasonCode: string | null;
  note: string | null;
  overriddenConditions: string[];
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  at: Date;
};

export type ManagerCall = {
  id: string;
  managerId: string;
  managerName: string | null;
  calledAt: Date;
  verified: boolean | null;
  answers: Record<string, string>;
  followUpNote: string | null;
};

export type TimelineRow = {
  id: string;
  eventType: string;
  sourceApp: string;
  sourceRecordId: string | null;
  occurredAt: Date;
  actorName: string | null;
  summary: string;
};

export type LeadOrderRow = {
  id: string;
  orderNo: string | null;
  orderedAt: Date;
  totalAmountPaise: number;
  status: string;
  approvedAt: Date | null;
  declineReason: string | null;
  billNo: string | null;
  billDate: string | null;
  billAmountPaise: number | null;
  billPaidPaise: number | null;
  billPaymentPosition: string | null;
};

export type LeadReceiptRow = {
  id: string;
  receiptNo: string | null;
  amountPaise: number;
  receivedAt: string;
  mode: string;
  reference: string | null;
  status: string;
  confirmedAt: Date | null;
};

export type LeadRecord = {
  /* ---- who they are ---- */
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  area: string | null;
  mobile: string | null;
  contactPerson: string | null;
  gstin: string | null;
  kind: string;
  thirdParty: boolean;
  archived: boolean;
  source: string;

  /* ---- where it stands ---- */
  salesType: LeadSalesType | null;
  stage: LeadStage;
  stageSince: string | null;
  stuckDays: number;
  quietDays: number;
  convertedAt: Date | null;
  lostReason: string | null;

  /* ---- who owns it, in all three seats ---- */
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerId: string | null;
  leadManagerName: string | null;
  salesAmId: string | null;
  salesAmName: string | null;
  backOfficeName: string | null;
  /*
   * §22's own seat, and NOT the sales one beside it. Who runs the
   * relationship moves no revenue, no target and no collections list — which
   * is the whole reason handing it over can be a manager's act while moving
   * `sales_am_id` stays accounts' and admin's. The panel draws this one.
   */
  relationshipOwnerId: string | null;
  relationshipOwnerName: string | null;
  handedOverAt: Date | null;

  /* ---- §7 §8 the verification ---- */
  verifiedAt: Date | null;
  verifiedByName: string | null;

  /* ---- §6 what the salesman established ---- */
  monthlyLitres: number | null;
  potentialPaise: number | null;
  competitor: string | null;
  requiredProductId: string | null;
  requiredProductName: string | null;
  decisionMaker: string | null;
  creditDaysWanted: number | null;
  application: string | null;
  customerType: string | null;
  qualification: Record<string, boolean | string>;

  /* ---- §24 the next action ---- */
  nextAction: string | null;
  nextActionDate: string | null;
  nextActionOwnerId: string | null;
  nextActionOwnerName: string | null;
  nextActionOutcome: string | null;

  /* ---- §18 what they said about the first order ---- */
  expectedOrderDate: string | null;
  expectedOrderValuePaise: number | null;

  /* ---- §4 the suspect window ---- */
  suspectVisitCount: number;
  suspectDecidedAt: Date | null;

  /* ---- §23 who invoices this shop ---- */
  distributorCount: number;
  distributorNames: string | null;

  /* ---- §11 §12 the distributor application ---- */
  distributorProfile: Record<string, unknown> | null;
  managementReviewApproved: boolean;
  distributorApprovalApproved: boolean;
  commercialTermsAgreedAt: Date | null;
  agreementOnFile: boolean;

  /* ---- §15 the newest sample ---- */
  sample: {
    id: string;
    state: string;
    trialOutcome: string;
    feedbackRecorded: boolean;
    productName: string | null;
    quantityCans: number | null;
    expectedDeliveryDate: string | null;
    receivedAt: Date | null;
    reviewChaseCount: number;
  } | null;

  /* ---- §19 §20 what the ledger says, READ ---- */
  countingOrderCount: number;
  deliveredOrderCount: number;
  confirmedPaymentCount: number;
  outstandingPaise: number;
};

/**
 * One lead, with everything the record page draws.
 *
 * It is a wide read and it is one round trip on purpose: a manager opening a
 * stalled lead wants the ladder, the answers, the money and the history in
 * front of them at once, and eight sequential queries is what makes a record
 * page feel like a report.
 *
 * **The ledger columns are counts, never a second status.** §19 and §20 are
 * rendered from `orders` and `payment_receipts` exactly as they stand —
 * `orders.status` comes from the sheet projection and from accounts' approval,
 * and a funnel-owned copy of it would be overwritten every thirty minutes or
 * land in `sync_conflicts`. What the funnel is allowed to say about an order is
 * whether there is one.
 *
 * Scope is applied, so a URL is not a way past the narrowing: a manager who
 * cannot see a lead on the list cannot open it by id either.
 */
export async function leadRecord(customerId: string, day: string): Promise<LeadRecord | null> {
  const scope = await managerScope();

  const rows = (await db.execute<LeadRecord>(sql`
    select c.id as "customerId", c.name, c.company_name as "companyName",
           c.city, c.area, c.phone as mobile,
           c.contact_person as "contactPerson", c.gstin,
           c.kind::text as kind, c.third_party as "thirdParty",
           c.lead_archived as archived,
           coalesce(c.lead_source, 'manual') as source,

           c.lead_sales_type::text as "salesType",
           c.lead_stage::text as stage,
           c.lead_stage_since::text as "stageSince",
           coalesce(${day}::date - c.lead_stage_since, 0)::int as "stuckDays",
           coalesce(${day}::date - c.lead_last_activity_date, 0)::int as "quietDays",
           c.lead_converted_at as "convertedAt",
           c.lead_lost_reason as "lostReason",

           c.owner_id as "salesmanId", u.name as "salesmanName",
           c.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
           c.sales_am_id as "salesAmId", sa.name as "salesAmName",
           c.back_office_name as "backOfficeName",
           c.relationship_owner_id as "relationshipOwnerId",
           ro.name as "relationshipOwnerName",
           c.handed_over_at as "handedOverAt",

           c.lead_verified_at as "verifiedAt", v.name as "verifiedByName",

           c.lead_monthly_volume_litres as "monthlyLitres",
           c.lead_estimated_potential_paise as "potentialPaise",
           c.lead_competitor as competitor,
           c.lead_required_product_id as "requiredProductId",
           p.name as "requiredProductName",
           c.lead_decision_maker as "decisionMaker",
           c.lead_credit_days_wanted as "creditDaysWanted",
           c.lead_application as application,
           c.customer_type::text as "customerType",
           c.lead_qualification as qualification,

           c.lead_next_action as "nextAction",
           c.lead_next_action_date::text as "nextActionDate",
           c.lead_next_action_owner_id as "nextActionOwnerId",
           na.name as "nextActionOwnerName",
           c.lead_next_action_outcome as "nextActionOutcome",

           c.lead_expected_order_date::text as "expectedOrderDate",
           c.lead_expected_order_value_paise as "expectedOrderValuePaise",

           (select count(*)::int from mbos_visits vi
             where vi.customer_id = c.id) as "suspectVisitCount",
           c.lead_suspect_decided_at as "suspectDecidedAt",

           (select count(*)::int from customer_distributors cd
             where cd.customer_id = c.id) as "distributorCount",
           (select string_agg(dc.name, ', ' order by dc.name)
              from customer_distributors cd
              join customers dc on dc.id = cd.distributor_customer_id
             where cd.customer_id = c.id) as "distributorNames",

           to_jsonb(dp.*) as "distributorProfile",
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
           dp.commercial_terms_agreed_at as "commercialTermsAgreedAt",
           exists (
             select 1 from mbos_documents md
              where md.customer_id = c.id and md.category = 'agreement' and md.active
           ) as "agreementOnFile",

           (select to_jsonb(x) from (
              select s.id, s.state::text as state,
                     s.trial_outcome::text as "trialOutcome",
                     (exists (select 1 from sample_feedback f where f.sample_id = s.id))
                       as "feedbackRecorded",
                     sp.name as "productName",
                     s.quantity_cans as "quantityCans",
                     s.expected_delivery_date::text as "expectedDeliveryDate",
                     s.received_at as "receivedAt",
                     s.review_chase_count as "reviewChaseCount"
                from mbos_samples s
                left join products sp on sp.id = s.product_id
               where s.customer_id = c.id and s.state <> 'cancelled'
               order by s.created_at desc, s.id desc
               limit 1
            ) x) as sample,

           (select count(*)::int from orders o
             where o.customer_id = c.id
               /* Through order-status.ts, never a literal. This spelled the
                  three statuses out, which is one status behind the day
                  somebody adds a fourth - and it is the count the second-order
                  gate and the conversion rule both turn on. */
               and ${orderCountsSql("o")}) as "countingOrderCount",
           (select count(*)::int from orders o
             where o.customer_id = c.id and o.status = 'dispatched') as "deliveredOrderCount",
           (select count(*)::int from payment_receipts pr
             where pr.customer_id = c.id and pr.status = 'confirmed') as "confirmedPaymentCount",
           coalesce(c.outstanding, 0) as "outstandingPaise"

      from customers c
      left join users u on u.id = c.owner_id
      left join users m on m.id = c.lead_manager_id
      left join users sa on sa.id = c.sales_am_id
      left join users v on v.id = c.lead_verified_by_id
      left join users ro on ro.id = c.relationship_owner_id
      left join users na on na.id = c.lead_next_action_owner_id
      left join products p on p.id = c.lead_required_product_id
      left join distributor_profiles dp on dp.customer_id = c.id
     where c.id = ${customerId}
       and c.lead_stage is not null
       ${onlyMine(scope, "c.owner_id")}
     limit 1
  `)) as unknown as LeadRecord[];

  return rows[0] ?? null;
}

/**
 * Everything the gate engine reads, assembled from a record it already has.
 *
 * Pure, and deliberately a separate function from the read: the engine is the
 * authority on what a gate needs, and building its input inside the SQL would
 * put half the rule back in a query. Changing a condition then means editing a
 * `select`, which is exactly the second copy `lead-gates.ts` exists to prevent.
 */
export function gateInputFor(record: LeadRecord): LeadGateInput {
  return {
    salesType: record.salesType,
    stage: record.stage,
    customerType: record.customerType,
    monthlyLitres: record.monthlyLitres,
    potentialPaise: record.potentialPaise,
    competitor: record.competitor,
    requiredProductId: record.requiredProductId,
    contactPerson: record.contactPerson,
    decisionMaker: record.decisionMaker,
    creditDaysWanted: record.creditDaysWanted,
    application: record.application,
    gstin: record.gstin,
    nextAction: record.nextAction,
    nextActionDate: record.nextActionDate,
    nextActionOwnerId: record.nextActionOwnerId,
    qualification: record.qualification,
    suspectVisitCount: record.suspectVisitCount,
    suspectDecidedAt: record.suspectDecidedAt,
    /* The reason lives on the transition row that made it a prospect, so it is
       true exactly when the lead has been past Suspect. Reading it off the
       transitions rather than a column is what keeps the two in step. */
    prospectReasonRecorded: Boolean(record.stageSince) && record.stage !== "suspect",
    verifiedAt: record.verifiedAt,
    thirdParty: record.thirdParty,
    distributorCount: record.distributorCount,
    sample: record.sample
      ? {
          state: record.sample.state,
          trialOutcome: record.sample.trialOutcome,
          feedbackRecorded: record.sample.feedbackRecorded,
        }
      : null,
    distributorProfile: record.distributorProfile,
    managementReviewApproved: record.managementReviewApproved,
    distributorApprovalApproved: record.distributorApprovalApproved,
    commercialTermsAgreed: Boolean(record.commercialTermsAgreedAt),
    agreementOnFile: record.agreementOnFile,
    countingOrderCount: record.countingOrderCount,
    deliveredOrderCount: record.deliveredOrderCount,
    confirmedPaymentCount: record.confirmedPaymentCount,
    expectedOrderDate: record.expectedOrderDate,
    initialStockOrderPlaced: record.countingOrderCount > 0,
  };
}

/** Which rungs this lead climbs. Re-exported so a screen never restates one. */
export function ladderOf(record: LeadRecord): readonly LeadStage[] {
  return ladderFor(record.salesType);
}

/** §25 — every stage move, newest first. */
export async function leadTransitions(customerId: string): Promise<LeadTransition[]> {
  return db.execute<LeadTransition>(sql`
    select t.id, t.from_stage::text as "fromStage", t.to_stage::text as "toStage",
           t.kind::text as kind, t.reason_code as "reasonCode", t.note,
           t.overridden_conditions as "overriddenConditions",
           t.actor_id as "actorId", u.name as "actorName",
           t.actor_role as "actorRole", t.at
      from lead_stage_transitions t
      left join users u on u.id = t.actor_id
     where t.customer_id = ${customerId}
     order by t.at desc, t.id desc
     limit 100
  `) as unknown as LeadTransition[];
}

/**
 * §8 — the verification calls made on this lead, newest first.
 *
 * `mbos_lead_validations` is the one table a verification call lands in,
 * whether it was made from this console or from a handset. It was two for a
 * fortnight — this branch's `lead_manager_calls` beside main's — and two
 * tables answering "has anybody rung this shop" is one screen saying no while
 * the other says it was rung twice.
 *
 * The twelve answers come back through `verificationAnswers`, which is the
 * same mapping the form writes through, so a column added to the call is added
 * in one place and both ends see it.
 */
export async function managerCalls(customerId: string): Promise<ManagerCall[]> {
  const rows = (await db.execute(sql`
    select k.*, u.name as "callerName"
      from mbos_lead_validations k
      left join users u on u.id = k.called_by_user_id
     where k.customer_id = ${customerId}
     order by k.called_at desc, k.id desc
     limit 20
  `)) as unknown as Record<string, unknown>[];

  return rows.flatMap((r) => {
    /* `db.execute` hands back a timestamptz as a STRING, whatever the type
       annotation says, so it comes through `asDate`. The column is NOT NULL,
       which makes null here a row the driver could not parse — dropped rather
       than carried as an Invalid Date that throws somewhere unrelated. */
    const calledAt = asDate(r.called_at);
    if (!calledAt) return [];
    return [
      {
        id: String(r.id),
        managerId: String(r.called_by_user_id),
        managerName: (r.callerName as string | null) ?? null,
        calledAt,
        verified: verificationVerdict((r.verdict as string | null) ?? null),
        /* Read off snake_case, so the row is mapped to the camelCase keys the
       shared vocabulary is written in. Handing a raw row across that boundary
       is what made `canRead` refuse every attachment for months — a cast that
       quiets the compiler across a naming boundary is the bug, not the fix. */
        answers: verificationAnswers({
          salesmanVisited: r.salesman_visited,
          mahekExplained: r.mahek_explained,
          productUnderstood: r.product_understood,
          currentProduct: r.current_product,
          confirmedCompetitor: r.confirmed_competitor,
          confirmedRequirement: r.confirmed_requirement,
          growthPotential: r.growth_potential,
          salesmanFeedback: r.salesman_feedback,
          priceConcern: r.price_concern,
          qualityFeedback: r.quality_feedback,
          dispatchFeedback: r.dispatch_feedback,
          genuineInterest: r.genuine_interest,
        }),
        followUpNote:
          (r.verdict_reason as string | null) ?? (r.notes as string | null) ?? null,
      },
    ];
  });
}

/**
 * §25 — the shared timeline, capped, with the count from SQL.
 *
 * The same cap the CRM's customer record uses and for the same reason: the
 * accounts with the most history are the ones somebody most needs to read
 * before ringing, and they were the ones whose record you could reach the
 * least of. Ten a page there, twenty-five here because the console screen has
 * the room and no message history beside it.
 */
export async function leadTimeline(
  customerId: string,
  { limit = 25 }: { limit?: number } = {},
): Promise<{ rows: TimelineRow[]; total: number }> {
  const [rows, counts] = await Promise.all([
    db.execute<TimelineRow>(sql`
      select e.id, e.event_type as "eventType", e.source_app::text as "sourceApp",
             e.source_record_id as "sourceRecordId",
             e.occurred_at as "occurredAt",
             u.name as "actorName", e.summary
        from timeline_events e
        left join users u on u.id = e.actor_user_id
       where e.customer_id = ${customerId}
       /* A tiebreaker is not optional on a sorted read: a projection lands
          several events on one instant, and without it their order is the
          planner's to choose. */
       order by e.occurred_at desc, e.id desc
       limit ${limit}
    `) as unknown as TimelineRow[],
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from timeline_events e where e.customer_id = ${customerId}
    `),
  ]);
  return { rows, total: Number(counts[0]?.n ?? 0) };
}

/**
 * §19 §20 — the orders on this account and the bill behind each, as they are.
 *
 * A READ and nothing else. There is no funnel-owned order status and there must
 * not be one: `orders.status` is written by the sheet projection and by
 * accounts' approval, and a second ladder over it would either be overwritten
 * every thirty minutes or fill `sync_conflicts` with disagreements nobody
 * asked for. What the funnel contributes is the QUESTION — has this lead
 * ordered, did it arrive, did they pay — and all three are answerable from
 * rows that already exist.
 */
export async function leadOrders(customerId: string): Promise<LeadOrderRow[]> {
  return db.execute<LeadOrderRow>(sql`
    select o.id, o.order_no as "orderNo", o.ordered_at as "orderedAt",
           o.total_amount as "totalAmountPaise",
           o.status::text as status,
           o.approved_at as "approvedAt",
           o.decline_reason as "declineReason",
           b.bill_no as "billNo",
           b.bill_date::text as "billDate",
           b.amount as "billAmountPaise",
           b.paid_amount as "billPaidPaise",
           b.payment_position::text as "billPaymentPosition"
      from orders o
      left join bills b on b.order_id = o.id
     where o.customer_id = ${customerId}
     order by o.ordered_at desc, o.id desc
     limit 50
  `) as unknown as LeadOrderRow[];
}

/** §20 — money against this account, in every state it can be in. */
export async function leadReceipts(customerId: string): Promise<LeadReceiptRow[]> {
  return db.execute<LeadReceiptRow>(sql`
    select r.id, r.receipt_no as "receiptNo", r.amount as "amountPaise",
           r.received_at::text as "receivedAt", r.mode, r.reference,
           r.status::text as status, r.confirmed_at as "confirmedAt"
      from payment_receipts r
     where r.customer_id = ${customerId}
     order by r.received_at desc, r.id desc
     limit 50
  `) as unknown as LeadReceiptRow[];
}

/**
 * §14 — the communications already sent, read off the shared timeline.
 *
 * Its own function rather than a filter in the browser: `leadTimeline` is
 * capped, so filtering its twenty-five rows would answer "the communications
 * among the newest twenty-five events" and print it as the communication
 * history. That is the same mistake the CRM's timeline pills made before their
 * counts came from SQL.
 *
 * The event type is `lead_communication` and it is what `recordCommunication`
 * writes. It is spelled out rather than pattern-matched on a prefix: a `like`
 * would quietly pick up whatever the next kind of lead event is called.
 */
export async function leadCommunications(customerId: string): Promise<TimelineRow[]> {
  return db.execute<TimelineRow>(sql`
    select e.id, e.event_type as "eventType", e.source_app::text as "sourceApp",
           e.source_record_id as "sourceRecordId",
           e.occurred_at as "occurredAt",
           u.name as "actorName", e.summary
      from timeline_events e
      left join users u on u.id = e.actor_user_id
     where e.customer_id = ${customerId}
       and e.event_type = 'lead_communication'
     order by e.occurred_at desc, e.id desc
     limit 30
  `) as unknown as TimelineRow[];
}

/* ═══════════════════════════════════════════════════════ §22 the handover */

export type HandoverCandidate = { id: string; name: string; role: string };

/**
 * §22 — who can be given the relationship when a lead becomes a customer.
 *
 * The lead manager works a lead; a customer is worked by whoever owns the
 * account, and the two are different jobs — `lead_manager_id` is RELEASED on
 * promotion for exactly that reason. So the handover screen has to offer a
 * real list, and the list is people who can actually be given a book: an
 * account handed to somebody with no login is an account nobody opens.
 *
 * One searchable list rather than a dropdown that becomes a search box at some
 * threshold, which is the rule the person picker already follows everywhere
 * else here.
 */
export async function handoverCandidates(): Promise<HandoverCandidate[]> {
  const scope = await managerScope();
  return db.execute<HandoverCandidate>(sql`
    select u.id, u.name, u.role::text as role
      from users u
     where u.active
       and exists (select 1 from app_access a
                    where a.user_id = u.id and a.app in ('crm', 'field', 'accounts'))
       ${onlyMine(scope, "u.id")}
     order by u.name asc
  `) as unknown as HandoverCandidate[];
}

/* ─────────────────────────────────────────────────────────────── internals */

/**
 * The signed-in person's id, or null off a request.
 *
 * The same shape `managerScope` uses and for the same reason: a job, a script
 * or a test has no session to read, and there is nobody for a queue to be
 * "mine" to. Answering null makes every `mine` flag false rather than throwing
 * in a context that has no browser.
 */
async function currentUserId(): Promise<string | null> {
  const { requireUser } = await import("../auth");
  try {
    return (await requireUser()).id;
  } catch {
    return null;
  }
}
