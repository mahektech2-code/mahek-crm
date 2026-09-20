import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { leadsPage, leadsVisible, managerScope, type LeadRow } from "./sales-service";
import { qualificationDesk } from "./lead-qualify-service";
import { verificationQueue } from "./lead-console-service";
import { commitments, negotiationDesk } from "./lead-commercial-service";
import { sampleDeskCounts } from "./sample-service";
import { nextActionsDue, nextActionsOverdue, type NextActionRow } from "./lead-actions-service";
import {
  isOnQueueFor,
  roleAction,
  type LeadAction,
  type LeadVantage,
} from "../engines/lead-role-action";
import { primaryVantage, vantagesFor, type VantageViewer } from "../lead-vantage";
import type { LeadSalesType, LeadStage } from "../lead-labels";

/* ---------------------------------------------------------------------------
 * §8.2 — everything the lead dashboard reads, and it reads almost nothing of
 * its own.
 *
 * Three answers live here: what is owed today, what is on the reader's own
 * queue, and the sales manager's seven blocks. None of the three is a new
 * reading of the book. That is the whole discipline of this file, and it is
 * the one a dashboard gets wrong most easily: a headline figure is cheap to
 * compute from scratch and expensive to be wrong about, because the person
 * reading it presses it, lands on a list of a different length, and stops
 * believing every other figure on the screen at the same time.
 *
 * So: "needs your attention" is `nextActionsDue` and `nextActionsOverdue`, the
 * two functions the Due and Overdue tabs are made of. The role focus card is
 * `leadsPage` — the list's own query — filtered by `isOnQueueFor`, the engine
 * the list's own "For you" column reads. And six of the seven blocks are the
 * `total` their own screen prints at the top of itself.
 *
 * SCOPED LIKE EVERY OTHER LIST, and for free: every function called here
 * resolves `managerScope` inside itself, so there is no call site — including
 * this one — that can forget the narrowing. The one query this file still owns
 * asks for it explicitly.
 * ------------------------------------------------------------------------- */

/* ═════════════════════════════════════════ §8.2 — needs your attention */

/**
 * One lead with the thing that is owed on it, as the attention card draws it.
 *
 * A narrow projection of `NextActionRow` rather than the row itself: the card
 * shows six lines and the row carries twenty-two fields, several of them about
 * a park's own history, and handing the whole shape to a component invites the
 * component to start deciding things with it.
 */
export type AttentionRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  stage: LeadStage;
  salesType: LeadSalesType | null;
  /** The action itself. Null is a real state — §24's whole subject. */
  action: string | null;
  actionDate: string | null;
  ownerName: string | null;
  /**
   * How late, in days. ZERO MEANS TODAY rather than "not late": the card draws
   * the two differently and `overdue` below is what says which this is, so no
   * reader has to infer a state from a number being zero.
   */
  overdueDays: number;
  overdue: boolean;
  /**
   * A parked lead that has come back on its own resume date. It is on this
   * list for the same reason it is on the Due and Overdue tabs — the read is
   * what brings it back, not a job — and it is marked because "nobody promised
   * this, a date arrived" is a different kind of work from a promise somebody
   * made.
   */
  parkedBack: boolean;
};

export type AttentionList = {
  rows: AttentionRow[];
  /** From SQL, over the whole scoped book — so six rows can say what they are six of. */
  overdueTotal: number;
  dueTodayTotal: number;
};

function attentionRow(r: NextActionRow, overdue: boolean): AttentionRow {
  return {
    customerId: r.customerId,
    name: r.name,
    companyName: r.companyName,
    stage: r.stage,
    salesType: r.salesType,
    action: r.action,
    actionDate: r.actionDate,
    ownerName: r.ownerName,
    overdueDays: r.overdueDays,
    overdue,
    parkedBack: r.stage === "on_hold",
  };
}

/**
 * OVERDUE FIRST, THEN DUE TODAY, capped at six.
 *
 * The order is the specification's and it is also the only defensible one: a
 * promise whose day went by is work somebody has already failed to do, and a
 * promise that falls today is work with a day left in it. Sorted together by
 * date they would interleave, and the six lines a card has room for would be
 * spent on whichever mixture the dates happened to produce.
 *
 * **It is the two tabs' own functions, asked for six rows each.** The Overdue
 * and Due screens are `nextActionsOverdue` and `nextActionsDue`, and this asks
 * the same two with a smaller limit — so a lead at the top of this card is at
 * the top of that list, in the same order, with the same lateness printed
 * against it. Re-deriving "what is owed today" here would have meant writing
 * §24's two windows a third time, and the third copy is the one nobody
 * remembers to change when a park's resume date starts counting.
 *
 * **THE TOTALS COME FROM SQL, NOT FROM THE SIX.** Both functions already count
 * the whole scoped set beside the rows they return, so the card can say "6 of
 * 41" rather than printing six and letting the reader believe that is all
 * there is. A capped list that does not say what it is a slice of is the
 * mistake the timeline's filter pills carry a paragraph about.
 */
export async function needsAttention(
  day: string,
  { limit = 6 }: { limit?: number } = {},
): Promise<AttentionList> {
  const [overdue, due] = await Promise.all([
    nextActionsOverdue(day, { limit }),
    nextActionsDue(day, { limit }),
  ]);

  const rows = [
    ...overdue.rows.map((r) => attentionRow(r, true)),
    ...due.rows.map((r) => attentionRow(r, false)),
  ].slice(0, limit);

  return {
    rows,
    overdueTotal: overdue.total,
    dueTodayTotal: due.total,
  };
}

/* ═══════════════════════════════════ §7 — whose queue a lead sits in */

/**
 * One lead on somebody's queue, with the instruction that put it there.
 *
 * The action is the ENGINE'S OWN OBJECT rather than a label and a tone pulled
 * out of it, so the card cannot quietly print one and colour by the other.
 */
export type FocusRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  stage: LeadStage;
  salesType: LeadSalesType | null;
  /** WHICH of the reader's five jobs this row landed on their queue under. */
  vantage: LeadVantage;
  action: LeadAction;
};

export type RoleFocus = {
  rows: FocusRow[];
  /** On the reader's queue, within what was read. */
  total: number;
  /** How many of their leads were read. Equal to `bookTotal` unless capped. */
  scanned: number;
  /** The whole scoped, unarchived book — so a capped answer can say so. */
  bookTotal: number;
  /** True where the book is longer than one page of this read. */
  capped: boolean;
  /** Every vantage that put at least one row on the list, with its count. */
  byVantage: { vantage: LeadVantage; count: number }[];
};

/**
 * How many leads are read to build the card.
 *
 * Two of the five vantages are held by a SEAT on the row, so "is this mine" is
 * arithmetic per lead rather than a clause, and there is no honest way to ask
 * the database for it without teaching it §7 a second time. So a page of the
 * book is read and the answer is worked out over it — and because that is a
 * slice, the card says what it is a slice of rather than implying a whole.
 *
 * It is the list's own maximum page rather than a number chosen here: the
 * ordering is the list's too, which puts what was promised soonest at the top,
 * so a capped read is capped at the far end from the work.
 */
const FOCUS_SCAN = 200;

/**
 * §7's companion — WHOSE QUEUE A LEAD SITS IN — as a named resolution.
 *
 * `isOnQueueFor` answers it about one lead and one vantage, and this is the
 * same question asked of a book. It is deliberately NOT a second opinion: the
 * membership rule is `vantagesFor` for the seat half and `isOnQueueFor` for
 * the work half, and nothing here adds a condition of its own. Where the two
 * could disagree the engine wins, because the list's "For you" column reads
 * exactly these two functions and a dashboard that answered differently would
 * be telling somebody about work the list does not show them.
 *
 * ---------------------------------------------------------------------------
 * §7'S LAST BULLET NAMES FIVE ROLES AND THIS PRODUCT HAS THREE LEVELS. Each
 * half of it is mapped rather than invented, and the two halves it cannot
 * express are said out loud instead of being quietly approximated.
 *
 * "Salesman sees leads they own" — held, exactly. `vantagesFor` gives the
 * salesman vantage only where `owner_id` is the reader AND they hold `field`,
 * which is the grant that means somebody walks a beat; a lead owned by whoever
 * ran an import is not thereby a salesman's.
 *
 * "Telecaller sees new/Suspect-stage or Website-sourced leads" — THERE IS NO
 * TELECALLER ROLE. AGENTS.md is emphatic that a role is a LEVEL and the app is
 * the job: the calling desk is the CRM grant, which is what `holdsCrm` reads.
 * The rung half needs nothing added — `roleAction` gives the calling desk a
 * verb at `suspect`/`new` and at `second_order` and at no other rung, so the
 * engine already answers it. The WEBSITE-SOURCED half is not honoured here and
 * that is a decision rather than an omission: `customers.source` is a fact the
 * engine has no input for, so honouring it would mean a membership rule living
 * in this file that `isOnQueueFor` knows nothing about — which is the second
 * opinion the paragraph above exists to refuse. A telecaller reaches a
 * website-sourced lead at any rung through the list's own source filter.
 *
 * "Back Office sees any lead with an order or an active sample" — THERE IS NO
 * BACK OFFICE ROLE EITHER. It is a SEAT, `customers.back_office_am_id`, held
 * by somebody whose hat is an ordinary CRM one — AGENTS.md's own note on the
 * brief's "Logistics" actor says so and says why no such role was created. So
 * membership is the seat, and the "order or active sample" half is again the
 * engine's: the back office is given a verb at `sample_trial`, `first_order`,
 * `delivery`, `payment` and `initial_stock_order`, plus §11.6's GST check at
 * `prospect`, which is the same sentence read off the ladder instead of off
 * two joins.
 *
 * "Sales Manager and Management see the whole active book" — held. Both
 * vantages come off hats rather than seats, so every visible lead is a
 * candidate and the engine decides which of them carry a verb. `whole` means
 * whole WITHIN SCOPE: `leadsPage` resolves `managerScope` for itself, and a
 * dashboard that reached past the narrowing would be a way around it rather
 * than a report of it.
 */
export async function leadsForRole(
  day: string,
  viewer: VantageViewer,
  { limit = 8 }: { limit?: number } = {},
): Promise<RoleFocus> {
  const page = await leadsPage(day, { perPage: FOCUS_SCAN });

  const matched: FocusRow[] = [];
  for (const lead of page.rows) {
    /* The row's PRIMARY vantage, which is what the list prints in its own "For
       you" column. `vantagesFor` orders seats before hats, so a manager who is
       also the named back office person on one lead is asked for the specific
       instruction on that lead and the general one on the rest — and this card
       and that column cannot name two different jobs for one shop. */
    const vantage = primaryVantage(viewer, seatsOf(lead));
    if (!vantage) continue;
    const facts = factsOf(lead);
    if (!isOnQueueFor(facts, vantage)) continue;
    matched.push({
      customerId: lead.id,
      name: lead.name,
      companyName: lead.companyName,
      city: lead.city,
      stage: lead.stage as LeadStage,
      salesType: lead.salesType,
      vantage,
      action: roleAction(facts, vantage),
    });
  }

  /* Counted over the matched set rather than over the page: a reader who is
     the back office on two leads and the sales manager on nine wants to know
     that, and "eleven" on its own does not say it. */
  const tally = new Map<LeadVantage, number>();
  for (const r of matched) tally.set(r.vantage, (tally.get(r.vantage) ?? 0) + 1);

  return {
    rows: matched.slice(0, limit),
    total: matched.length,
    scanned: page.rows.length,
    bookTotal: page.listTotal,
    capped: page.listTotal > page.rows.length,
    byVantage: [...tally].map(([vantage, count]) => ({ vantage, count })),
  };
}

/**
 * §7's five facts off a list row, and the seats beside them.
 *
 * Two small adapters rather than one shape passed around, because they answer
 * two different questions of the same row — what the lead IS, and who is named
 * on it — and the engine takes only the first.
 */
function factsOf(lead: LeadRow) {
  return {
    stage: lead.stage as LeadStage,
    salesType: lead.salesType,
    hasCommitment: lead.hasCommitment,
    hasOrder: lead.hasOrder,
    sampleAwaitingDispatch: lead.sampleAwaitingDispatch,
  };
}

function seatsOf(lead: LeadRow) {
  /* `salesmanId` IS `owner_id`. The list names the column for the person,
     which is the right word on a screen and the wrong one here, where what is
     being matched is the seat. */
  return {
    ownerId: lead.salesmanId,
    backOfficeAmId: lead.backOfficeAmId,
    leadManagerId: lead.leadManagerId,
  };
}

/**
 * Whether this reader is one of the two §8.2 draws the KPI strip for.
 *
 * Asked of the HATS with no seats, deliberately: the strip is a statement
 * about a book rather than about a lead, so somebody who happens to be the
 * back office person on one shop has not thereby become a sales manager. It is
 * `vantagesFor` and not a second reading of the four booleans, so the day the
 * rule for "who is management" changes it changes in one place.
 */
export function readsManagerStrip(viewer: VantageViewer): boolean {
  const hats = vantagesFor(viewer, { ownerId: null, backOfficeAmId: null, leadManagerId: null });
  return hats.includes("sales_manager") || hats.includes("management");
}

/* ═══════════════════════════════════ §8.2 — the sales manager's seven */

/*
 * THE SEVEN, and why they are these seven.
 *
 * Mahek asked for seven management blocks. Each one is a QUEUE rather than a
 * score: work that is sitting still, waiting on somebody, and every one of
 * them opens the list behind it. That is the whole test a block has to pass to
 * earn a place on this strip — "leads this month" is a fact about the past and
 * belongs on the funnel screen; "prospects nobody has verified" is four phone
 * calls somebody has to make today.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE IS ITS OWN SCREEN'S FIGURE NOW, AND THAT IS A REVERSAL.
 *
 * This was one statement with seven correlated `count(*) filter (...)`, on the
 * reasoning that seven round trips to answer one screen is seven chances for
 * the numbers to disagree with each other, because the book moves while they
 * are being asked. That reasoning is sound and it was aimed at the smaller of
 * the two risks. Five of the seven predicates had drifted from the screens
 * their tiles open, and two had never matched: the slipped-commitment tile
 * counted negotiations with a confirmed commitment whose day had gone, while
 * the list it opened counted every recorded day that had gone past with no
 * order against it, at any rung. A manager pressing a tile reading 6 landed on
 * a list of 19. Numbers that disagree with each other by a few seconds of a
 * moving book is an inconsistency nobody can see; a number that disagrees with
 * the list it opens is one everybody sees, once, and then stops trusting the
 * strip.
 *
 * So six of the seven are now the `total` the screen behind them prints at its
 * own head, asked through the screen's own function. They are asked together
 * in one `Promise.all`, so it is one round of parallel work rather than seven
 * sequential ones, and each is asked with `limit: 0` — the counts are a
 * separate statement inside each of those functions, so no rows are built to
 * throw away.
 *
 * The seventh has no screen function to share with, and it keeps the old
 * shape: one small scoped query, here, saying so.
 *
 * IN RAW SQL, QUALIFY EVERY COLUMN OF THE OUTER TABLE. Drizzle renders a bare
 * `"id"` for `${customers.id}`, which inside a correlated subquery binds to
 * the INNER table and silently makes the condition false — types and unit
 * tests both pass. Every reference below is spelled `c.` for that reason.
 */

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

/**
 * §8.2's third block, which is the one with nowhere to share from.
 *
 * "Verification failed" is a lead at Prospect that somebody has already rung
 * and could not confirm. The screen the tile opens is the record of the CALLS,
 * and `validationCalls` counts calls inside a window — a different unit over a
 * different population, and asking it for this number would be asking a
 * question it does not answer. The verification queue's own function counts
 * every unrung prospect, which is the first block. So this one is counted
 * here, over the same `leadsVisible` scope both of those resolve for
 * themselves, and the tile's own sentence says it is a subset of the queue it
 * opens rather than pretending to be its total.
 */
async function verificationFollowUps(): Promise<number> {
  const scope = await managerScope();
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from customers c
     where c.lead_stage = 'prospect'
       and c.lead_archived = false
       and c.lead_verified_at is null
       and exists (
         select 1 from mbos_lead_validations k where k.customer_id = c.id
       )
       ${leadsVisible(scope)}
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The seven, for whoever is asking.
 *
 * `day` is the business date the caller already resolved — never `now()` in a
 * statement, because the working day is Asia/Kolkata and a bare cast reads in
 * the session's zone, which on a server running in GMT puts a Monday order on
 * Sunday. Every function called here takes it for the same reason.
 */
export async function managerLeadBlocks(day: string): Promise<ManagerLeadBlock[]> {
  const [verification, qualification, negotiation, forecast, samples, followUps] =
    await Promise.all([
      /* Block 1 — the verification queue's own total. Same function, same
         scope, same window: the tile and the screen are one answer. */
      verificationQueue(day, { limit: 0 }),
      /* Block 2 — §28's checklist desk. It used to be counted here as
         "verified and at qualification", which is the desk's population plus a
         clause the gate already guarantees: a lead cannot reach Qualification
         unverified. One of the two had to go, and the one that goes is the
         copy. */
      qualificationDesk(day, { limit: 0 }),
      /* Block 5 — the negotiation desk. */
      negotiationDesk(day, { limit: 0 }),
      /* Blocks 6 AND 7 out of ONE call: `commitments` counts all four of its
         views beside whichever it is drawing, so the slipped tile and the
         due-this-week tile come from the same statement as the chips on the
         screen they open. */
      commitments(day, "slipped", { limit: 0 }),
      /* Block 4 — the sample desk's own four counts. `awaitingReview` is
         `state in ('received','trial_done')`, which is exactly the population
         `samplesAwaitingReview` lists and the chases screen draws. This file
         used to count CUSTOMERS carrying such a sample, which is a smaller
         number than the list it opened by however many shops are trialling two
         things at once. */
      sampleDeskCounts(),
      verificationFollowUps(),
    ]);

  return [
    {
      id: "pending-verification",
      label: "Prospects to verify",
      hint: "Nobody has rung the shop yet. Qualification cannot open until somebody does.",
      count: verification.total,
      href: "leads/qualify/verification",
      /* Danger because it BLOCKS: every one of these is a salesman who has
         done his visit and can go no further until a manager picks up a
         phone. */
      tone: verification.total > 0 ? "danger" : "muted",
    },
    {
      id: "verified-awaiting-qualification",
      label: "Verified, in qualification",
      hint: "Verified by phone and now with the salesman for the eight-point checklist.",
      count: qualification.total,
      href: "leads/qualify/checklist",
      /* Somebody else's move. Worth seeing, not worth alarming about. */
      tone: "brand",
    },
    {
      id: "verification-follow-up",
      label: "Verification unfinished",
      hint: "Rung once and the visit could not be confirmed — these are the ones on the verification queue that need the manager and the salesman together.",
      count: followUps,
      href: "leads/qualify/verification",
      tone: followUps > 0 ? "warn" : "muted",
    },
    {
      id: "sample-reviews",
      label: "Trials to review",
      hint: "The shop has the sample and nobody has written down what they thought of it.",
      count: samples.awaitingReview,
      /* The chase list, whose rows ARE these samples. It pointed at the
         feedback library, which is every trial that HAS an answer — the
         opposite set, under a tile counting the ones that do not. */
      href: "samples/chases",
      /* Stock already spent, and the answer decays. */
      tone: samples.awaitingReview > 0 ? "danger" : "muted",
    },
    {
      id: "negotiations",
      label: "In negotiation",
      hint: "Price, credit and delivery are on the table.",
      count: negotiation.total,
      href: "leads/commercial",
      tone: "brand",
    },
    {
      id: "awaiting-order",
      label: "Promised, and the day has gone",
      hint: "The day a customer gave has passed with no order against it. A FORECAST that did not arrive — never a sale, and not a rupee of revenue until an order is confirmed.",
      count: forecast.counts.slipped,
      /* The view whose rows ARE this count. Two blocks pointing at one
         unfiltered list is a manager pressing the urgent one and landing on
         the calm one's rows, which teaches them not to press either. */
      href: "leads/commercial/commitments?view=slipped",
      /* The specification asks for this to be loud, and it is right: this is
         the block where money is left on the table. */
      tone: forecast.counts.slipped > 0 ? "danger" : "muted",
    },
    {
      id: "expected-this-week",
      label: "Expected in the next 7 days",
      hint: "FORECAST ONLY — days customers named on a call, inside the next seven. Not orders, not revenue, and never added to either.",
      count: forecast.counts.due,
      href: "leads/commercial/commitments?view=due",
      /* Deliberately NOT danger. It is a plan, and colouring a plan like a
         problem is how a strip teaches people to ignore its colours. */
      tone: "brand",
    },
  ];
}
