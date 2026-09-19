import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * §8.2 — THE SALES MANAGER'S SEVEN, and why they are these seven.
 *
 * Mahek asked for seven management blocks. These are the seven the
 * specification names, and each one is a QUEUE rather than a score: every
 * figure here is work that is sitting still, waiting on somebody, and every
 * one of them opens the list behind it. That is the whole test a block has to
 * pass to earn a place on this strip — "leads this month" is a fact about the
 * past and belongs on the funnel screen; "prospects nobody has verified" is
 * four phone calls somebody has to make today.
 *
 * ONE QUERY, seven correlated counts. It is written as a single statement for
 * the reason the EOD metrics are: seven round trips to answer one screen is
 * seven chances for the numbers to disagree with each other, because the book
 * moves while they are being asked. Read together they are a consistent
 * picture of one instant.
 *
 * SCOPED LIKE EVERY OTHER LIST. `managerScope` and `leadsVisible` are the same
 * narrowing the verification queue and the sample desk already run through, so
 * a manager sees his own people's leads and an admin sees the book. A dashboard
 * that skipped the narrowing would be a way around it rather than a report of
 * it.
 *
 * IN RAW SQL, QUALIFY EVERY COLUMN OF THE OUTER TABLE. Drizzle renders a bare
 * `"id"` for `${customers.id}`, which inside a correlated subquery binds to the
 * INNER table and silently makes the condition false — types and unit tests
 * both pass. Every reference below is spelled `c.` for that reason.
 * ------------------------------------------------------------------------- */

export type ManagerLeadBlock = {
  /** Stable, and what a screen keys its link off. Never the label. */
  id: string;
  label: string;
  /** What the number MEANS, drawn under it. A count with no sentence gets read
   *  as whichever thing the reader was already worried about. */
  hint: string;
  count: number;
  /** Where the block opens. A figure nobody can get behind is one they have to
   *  take on trust, which is the thing this strip exists not to be. */
  href: string;
  /** `warn` and `danger` are earned by the QUESTION, not by the size of the
   *  number — see the note on each. */
  tone: "brand" | "warn" | "danger" | "muted";
};

type Counts = {
  pendingVerification: number;
  verifiedAwaitingQualification: number;
  verificationFollowUp: number;
  sampleReviewsPending: number;
  negotiationsOpen: number;
  awaitingOrderConfirmation: number;
  expectedOrdersThisWeek: number;
};

/**
 * The seven, for whoever is asking.
 *
 * `day` is the business date the caller already resolved — never `now()` in the
 * statement, because the working day is Asia/Kolkata and a bare cast reads in
 * the session's zone, which on a server running in GMT puts a Monday order on
 * Sunday. The week window carries its offset explicitly for the same reason.
 */
export async function managerLeadBlocks(day: string): Promise<ManagerLeadBlock[]> {
  const scope = await managerScope();
  const visible = leadsVisible(scope);

  /* The funnel's own work, excluding everything terminal: a queue is what is
     waiting, and a lost lead is not waiting on anybody. */
  const working = sql.raw(
    `c.lead_stage is not null
       and c.lead_archived = false
       and c.lead_stage not in ('lost', 'won', 'customer', 'active_distributor')`,
  );

  const rows = (await db.execute<Counts>(sql`
    select
      count(*) filter (
        where c.lead_stage = 'prospect' and c.lead_verified_at is null
      )::int as "pendingVerification",

      count(*) filter (
        where c.lead_verified_at is not null and c.lead_stage = 'qualification'
      )::int as "verifiedAwaitingQualification",

      /* A call was made and it did not confirm the visit. NOT the same as a
         lead nobody has rung — that is the first block — and no longer the
         same as a failed verification either, which now closes the lead and
         so has left this set entirely. This is the one that needs a manager
         and a salesman in the same room. */
      count(*) filter (
        where c.lead_stage = 'prospect'
          and c.lead_verified_at is null
          and exists (
            select 1 from mbos_lead_validations k where k.customer_id = c.id
          )
      )::int as "verificationFollowUp",

      /* Stock is already out of the godown and nobody has written down what
         the customer thought. Every day this sits is a day the trial is
         harder to remember. */
      count(*) filter (
        where exists (
          select 1 from mbos_samples s
           where s.customer_id = c.id
             and s.state in ('received', 'trial_done')
             and s.cancelled_at is null
        )
      )::int as "sampleReviewsPending",

      count(*) filter (where c.lead_stage = 'negotiation')::int as "negotiationsOpen",

      /* §3.4 — THE ONE THIS STRIP EXISTS FOR, and it counts the SLIPPED ones
         rather than every commitment on file.
         A promise whose day has not come is a plan and belongs in the block
         below; a promise whose day CAME AND WENT with no order is money
         somebody was told to expect and nobody collected, and it is the only
         one of the two that wants a manager today. Counting both together
         made the loud block loud on its calmest rows and sent whoever pressed
         it to the same list as the quiet one. */
      count(*) filter (
        where c.lead_stage = 'negotiation'
          and c.lead_expected_order_date is not null
          and c.lead_expected_order_date < ${day}::date
      )::int as "awaitingOrderConfirmation",

      /* A FORECAST, and the screen must say so. Counted over the seven days
         from the business date rather than a calendar week, because "this
         week" on a Friday means the next seven days to the person reading it. */
      count(*) filter (
        where c.lead_expected_order_date is not null
          and c.lead_expected_order_date >= ${day}::date
          and c.lead_expected_order_date < ${day}::date + 7
      )::int as "expectedOrdersThisWeek"

      from customers c
     where ${working} ${visible}
  `)) as unknown as Counts[];

  const c = rows[0] ?? {
    pendingVerification: 0,
    verifiedAwaitingQualification: 0,
    verificationFollowUp: 0,
    sampleReviewsPending: 0,
    negotiationsOpen: 0,
    awaitingOrderConfirmation: 0,
    expectedOrdersThisWeek: 0,
  };

  return [
    {
      id: "pending-verification",
      label: "Prospects to verify",
      hint: "Nobody has rung the shop yet. Qualification cannot open until somebody does.",
      count: c.pendingVerification,
      href: "leads/qualify/verification",
      /* Danger because it BLOCKS: every one of these is a salesman who has
         done his visit and can go no further until a manager picks up a
         phone. */
      tone: c.pendingVerification > 0 ? "danger" : "muted",
    },
    {
      id: "verified-awaiting-qualification",
      label: "Verified, in qualification",
      hint: "Verified by phone and now with the salesman for the eight-point checklist.",
      count: c.verifiedAwaitingQualification,
      href: "leads/qualify/checklist",
      /* Somebody else's move. Worth seeing, not worth alarming about. */
      tone: "brand",
    },
    {
      id: "verification-follow-up",
      label: "Verification unfinished",
      hint: "A call was made and could not confirm the visit. These need the manager and the salesman together.",
      count: c.verificationFollowUp,
      href: "leads/qualify/validation",
      tone: c.verificationFollowUp > 0 ? "warn" : "muted",
    },
    {
      id: "sample-reviews",
      label: "Trials to review",
      hint: "The shop has the sample and nobody has written down what they thought of it.",
      count: c.sampleReviewsPending,
      href: "samples/feedback",
      /* Stock already spent, and the answer decays. */
      tone: c.sampleReviewsPending > 0 ? "danger" : "muted",
    },
    {
      id: "negotiations",
      label: "In negotiation",
      hint: "Price, credit and delivery are on the table.",
      count: c.negotiationsOpen,
      href: "leads/commercial",
      tone: "brand",
    },
    {
      id: "awaiting-order",
      label: "Promised, and the day has gone",
      hint: "The date they gave has passed with no order against it. Until an order is confirmed it was only ever a forecast.",
      count: c.awaitingOrderConfirmation,
      /* The view whose rows ARE this count. Two blocks pointing at one
         unfiltered list is a manager pressing the urgent one and landing on
         the calm one's rows, which teaches them not to press either. */
      href: "leads/commercial/commitments?view=slipped",
      /* The specification asks for this to be loud, and it is right: this is
         the block where money is left on the table. */
      tone: c.awaitingOrderConfirmation > 0 ? "danger" : "muted",
    },
    {
      id: "expected-this-week",
      label: "Expected in the next 7 days",
      hint: "Forecast only — what customers said they would order, not what they have.",
      count: c.expectedOrdersThisWeek,
      href: "leads/commercial/commitments?view=due",
      /* Deliberately NOT danger. It is a plan, and colouring a plan like a
         problem is how a strip teaches people to ignore its colours. */
      tone: "brand",
    },
  ];
}
