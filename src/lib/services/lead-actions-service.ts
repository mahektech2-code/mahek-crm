import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { asDate } from "../business-date";
import { STILL_WORKING, dueTodayWindow, overdueWindow } from "../lead-action-window";
import { COMMUNICATION_ACTIONS, type LeadSalesType, type LeadStage } from "../lead-labels";
import { MBOS_EVENT, sourceIdField } from "../timeline";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * §24 and §14 — what is owed on a lead, and what has actually gone out.
 *
 * Three screens read this file and they are three windows onto one column
 * group: `lead_next_action`, its day, its person and what that person is
 * expected to come back with. Due today, past its day, and — one tab along and
 * not this file's — nothing owed by anybody at all. Splitting them into three
 * services would give three answers to "what is a next action", and the half
 * that drifts is always the half somebody is reading at the wrong moment.
 *
 * Every rule `lead-console-service.ts` states in its own header holds here and
 * is not restated: scope is resolved INSIDE the service so no call site can
 * forget it, every column of the outer table is qualified because Drizzle
 * renders a bare `"id"` that binds to the inner table of a subquery, and no JS
 * `Date` is ever bound into a template — the driver serialises one by asking
 * Node to measure it as text, which throws inside the driver where no type
 * check can see it.
 *
 * What this file does NOT do is decide anything. The four answers are read as
 * stored; whether all four are REQUIRED is `leads.requireNextAction`, read by
 * the screen and enforced by `setLeadNextAction`, because a rule that lived in
 * a read would be a second opinion about what the write already refuses.
 * ------------------------------------------------------------------------- */

/* ══════════════════════════════════════════════ §24 the four answers, listed */

/**
 * One lead, with what is owed on it.
 *
 * All four answers are carried separately and none of them is coalesced into a
 * sentence here. §24's whole argument is that a DATE alone is how a lead sits
 * for six weeks with everybody assuming somebody else is holding it, and a
 * service that folded the action, the person and the expected outcome into one
 * display string would hand the screen exactly the shape the rule exists to
 * refuse.
 */
export type NextActionRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;

  /* The four answers. Any of them null is a real state and is drawn as one. */
  action: string | null;
  actionDate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  outcome: string | null;

  /* Who else is on the record. The next-action owner is NOT necessarily
     either: §24 asks who is holding this one thing, which is routinely the
     lead manager on a lead the salesman still visits. */
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerId: string | null;
  leadManagerName: string | null;

  stuckDays: number;
  quietDays: number;
  /** Zero on the due list, and the point of the overdue one. */
  overdueDays: number;

  /* ── the park, where this row is one ──────────────────────────────────────
   *
   * Mahek's instruction is that a parked lead comes back into the salesman's
   * Actions Due on its Hold Until Date BY ITSELF. It does that by being read
   * here (see the windows below), which means a row on this list can be one of
   * two things — something somebody promised, or something that has come back —
   * and the screen has to be able to tell them apart. So the park travels with
   * the row rather than being inferred from `stage === "on_hold"`: the rung it
   * returns to is not on the customer row at all and the reason is not in the
   * four answers.
   */
  /** The day it was parked until. Null on every row that is not a park. */
  holdResumeDate: string | null;
  /** The remarks somebody typed. Null where a code alone was picked. */
  holdReason: string | null;
  /** One of `leads.holdReasons`. Null on a park made before the codes existed. */
  holdReasonCode: string | null;
  /**
   * The rung it comes back TO, read off the transition that parked it.
   *
   * `on_hold` DISPLACES the rung — a lead has one stage column and the park
   * took it — so `stage` says "On hold" and cannot say where this lead was
   * standing. Without this the salesman is handed a lead that is due back and
   * no screen anywhere can tell him what it is due back AS, which is the one
   * way an automatic return could still lose a lead its place on the ladder.
   * Null is a park recorded with no rung, which is a different fact from a lead
   * that is not parked and is drawn as one.
   */
  parkedFrom: LeadStage | null;
};

/** How many are owed by each person, counted in SQL rather than off the page. */
export type OwnerTally = {
  ownerId: string | null;
  ownerName: string | null;
  count: number;
};

export type NextActionsPage = {
  rows: NextActionRow[];
  /** From SQL, so a capped list can say what it is a slice of. */
  total: number;
  /**
   * Every owner with something on this list, whatever the filter is — the
   * chips have to be able to offer the person you are not currently looking
   * at, and a tally computed off the filtered rows would offer exactly one.
   */
  owners: OwnerTally[];
  /**
   * Rows with the day set and one of the other three answers missing. It is
   * counted rather than filtered out: a lead owed something TODAY with nobody
   * named is the most urgent shape on the screen, not a row to hide because
   * another tab also lists it.
   */
  incomplete: number;
  /**
   * How many of these are parked leads that have come back.
   *
   * Counted in SQL beside the total rather than off the rows, for the reason
   * every count on this screen is: the list is capped at two hundred and a
   * banner reading "3 leads are back off hold" computed from what happened to
   * be drawn would say three on a morning there were forty. It is a separate
   * sentence from the total because it is a different KIND of work — nobody
   * promised these, a date arrived — and folding them into one number is how
   * a salesman reads past them.
   */
  parkedBack: number;
};

/**
 * The shared read. Two windows, one set of columns, one scope.
 *
 * `window` is a SQL fragment rather than a pair of dates because "today" and
 * "before today with nothing recorded since" are not the same shape of
 * condition, and a from/to pair would have forced the second to be expressed
 * as a lie about a range.
 */
async function nextActions(
  day: string,
  window: SQL,
  { ownerId, limit = 200 }: { ownerId?: string; limit?: number },
): Promise<NextActionsPage> {
  const scope = await managerScope();

  /* The filter is applied to the ROWS and deliberately not to the tallies
     below, so the chip you are standing on and the chip beside it are counted
     the same way. */
  const owned = ownerId ? sql`and c.lead_next_action_owner_id = ${ownerId}` : sql``;

  const where = sql`
    where ${STILL_WORKING}
      and ${window}
      ${leadsVisible(scope)}
  `;

  const [rows, counts, owners] = await Promise.all([
    db.execute<NextActionRow>(sql`
      select c.id as "customerId", c.name, c.company_name as "companyName", c.city,
             c.lead_sales_type::text as "salesType",
             c.lead_stage::text as stage,
             c.lead_next_action as action,
             c.lead_next_action_date::text as "actionDate",
             c.lead_next_action_owner_id as "ownerId", o.name as "ownerName",
             c.lead_next_action_outcome as outcome,
             c.owner_id as "salesmanId", u.name as "salesmanName",
             c.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
             coalesce(${day}::date - c.lead_stage_since, 0)::int as "stuckDays",
             coalesce(${day}::date - c.lead_last_activity_date, 0)::int as "quietDays",
             /* How late THIS ROW is, whichever of the two things made it due.
                A park read back a week after its resume date is a week late and
                its next action date may say nothing at all — legacy parks have
                none — so a figure taken from the promise alone would print "0
                days" beside a lead nobody has looked at since March. The
                greatest of the two is the honest single number, and it is one
                number because the screen has one column. */
             greatest(
               coalesce(${day}::date - c.lead_next_action_date, 0),
               case when c.lead_stage = 'on_hold'
                    then coalesce(${day}::date - c.lead_hold_resume_date, 0) else 0 end,
               0
             )::int as "overdueDays",
             c.lead_hold_resume_date::text as "holdResumeDate",
             c.lead_hold_reason as "holdReason",
             c.lead_hold_reason_code as "holdReasonCode",
             p.from_stage as "parkedFrom"
        from customers c
        left join users o on o.id = c.lead_next_action_owner_id
        left join users u on u.id = c.owner_id
        left join users m on m.id = c.lead_manager_id
        /* The rung a park came FROM, and it is the only place that fact exists
           -- on_hold took the stage column. Guarded on the outer row actually
           being parked, inside the subquery rather than in the join condition,
           so this costs one indexed lookup on the handful of parked rows and
           nothing at all on the rest. Every column of the outer table is
           qualified: Drizzle renders a bare name, and a bare id in here would
           bind to lead_stage_transitions and make the correlation false. */
        left join lateral (
          select t.from_stage::text as from_stage
            from lead_stage_transitions t
           where c.lead_stage = 'on_hold'
             and t.customer_id = c.id
             and t.to_stage = 'on_hold'
           order by t.at desc, t.id desc
           limit 1
        ) p on true
        ${where}
        ${owned}
       order by
         /* Worst first, and "worst" is not the date. A lead owed something
            today with nobody named is a different order of thing from one with
            all four answers on it, and a list sorted by day alone buries the
            first under twenty of the second. */
         case when c.lead_next_action_owner_id is null
                or c.lead_next_action is null then 0 else 1 end,
         /* A park's day is its RESUME date, and a park routinely carries a next
            action dated the same day -- the modal defaults one to the other.
            The coalesce is for the park whose action was dated a week either
            side of it, and for the legacy park with no next action at all:
            sorted on lead_next_action_date alone the second lands under a null
            and the first sorts by a day that is not the day it came back. */
         coalesce(c.lead_next_action_date, c.lead_hold_resume_date) asc nulls first,
         c.lead_stage_since asc nulls first,
         c.id asc
       limit ${limit}
    `) as unknown as NextActionRow[],

    db.execute<{ total: number; incomplete: number; parkedBack: number }>(sql`
      select count(*)::int as total,
             count(*) filter (
               where c.lead_next_action is null
                  or c.lead_next_action_owner_id is null
                  or c.lead_next_action_outcome is null
             )::int as incomplete,
             count(*) filter (where c.lead_stage = 'on_hold')::int as "parkedBack"
        from customers c
        ${where}
        ${owned}
    `),

    db.execute<OwnerTally>(sql`
      select c.lead_next_action_owner_id as "ownerId",
             o.name as "ownerName",
             count(*)::int as count
        from customers c
        left join users o on o.id = c.lead_next_action_owner_id
        ${where}
       group by c.lead_next_action_owner_id, o.name
        /* Nobody sorts first where it exists: an unowned row is the one a
           manager most needs to see, and a name is not a reason to rank. */
       order by (c.lead_next_action_owner_id is not null), count(*) desc, o.name asc
    `) as unknown as OwnerTally[],
  ]);

  return {
    rows,
    total: Number(counts[0]?.total ?? 0),
    incomplete: Number(counts[0]?.incomplete ?? 0),
    parkedBack: Number(counts[0]?.parkedBack ?? 0),
    owners,
  };
}

/* ══════════════════════════════════════ a parked lead coming back by itself */

/**
 * THE HOLD UNTIL DATE, AS A CONDITION ON THIS LIST.
 *
 * Mahek's instruction is one sentence: "the lead must automatically come back
 * into the salesperson's Actions Due on the Hold Until Date". There were two
 * ways to keep it and only one of them is honest.
 *
 * The one not taken is a scheduled pass that UN-PARKS the lead. It reads well
 * in a sentence and it is wrong in three ways at once. A park displaces the
 * rung — `lead_stage` holds `on_hold` and the rung it was parked from lives on
 * the transition — so coming back is a move to a NAMED rung, and a job doing
 * that writes a row into `lead_stage_transitions` saying somebody put this lead
 * back on Qualification on a Tuesday when nobody did. That table is append-only
 * precisely because every row on it is a decision a person made, and a machine
 * signing one is worse than the gap it fills. Worse still, `applyLeadStageMove`
 * CLEARS the hold reason and the resume date when a lead comes off hold — so
 * the pass would delete the sentence explaining why the lead was stopped at the
 * exact moment the person picking it up needs to read it. And a scheduled pass
 * is only ever as real as its caller: this codebase shipped `runHourly` with no
 * caller at all for months, and everything it was documented to do simply
 * happened late or never, with nothing anywhere looking wrong.
 *
 * So it is the READ. The park stays a park, the lead keeps its place on the
 * ladder, nothing is written by anybody who did not decide anything — and on
 * the resume date the lead is simply ON the list, because the list asks. There
 * is no cache to rebuild, no cadence to be late, and no state that can be
 * wrong: the condition is a date comparison against the working day, so the
 * answer is right the first morning somebody opens the screen and right again
 * if they open it a fortnight later.
 *
 * **DUE IS THE DAY AND OVERDUE IS AFTER IT**, which is the same split the two
 * windows already make about a promise, and it is what stops a park being in
 * two places at once. A park read back on the day it names is work that falls
 * today; one read back a week later is late, and it belongs on the screen
 * whose whole job is saying so. Not carried on the due list for ever: a list
 * where the oldest thing is at the top and never leaves is a list people learn
 * to scroll past, and the overdue tab has the banner and the badge for exactly
 * this.
 *
 * What it does NOT do is take the lead off the On hold tab. That screen is the
 * parked BOOK — every park, its reason, its rung and its age — and it answers
 * "is anybody going back to these" for a manager. This answers "what am I doing
 * today" for the person who has to. One lead on two lists is right where the
 * two lists are two questions.
 *
 * The two windows themselves live in `lib/lead-action-window.ts` — a leaf
 * module below this one — because the leads list's summary strip counts the
 * same two populations and offers a view of each. A strip whose figures were
 * derived beside the screens they open is the drift this codebase argues
 * against everywhere else: the tile says eleven, the screen lists nine, and
 * nothing on either says which is wrong.
 */

/**
 * What is owed TODAY.
 *
 * `day` is the working day — `today()` in `lib/recompute.ts`, which applies
 * the configured day boundary in Asia/Kolkata — and it arrives as an argument
 * for the same reason every engine takes one: a service that read the clock
 * could not be asked what yesterday looked like, and a component that read it
 * would be reading it during a render.
 */
export async function nextActionsDue(
  day: string,
  opts: { ownerId?: string; limit?: number } = {},
): Promise<NextActionsPage> {
  return nextActions(day, dueTodayWindow(day), opts);
}

/**
 * Past its day, with nobody having said anything since.
 *
 * `lead_next_action_outcome is null` is the second half of that sentence and
 * it is what keeps this screen meaningful: a lead whose call was made and whose
 * answer was written down has been worked, whatever its date says, and listing
 * it here would fill the one screen that is supposed to empty itself with rows
 * nobody can act on. The window itself says so in its own file.
 */
export async function nextActionsOverdue(
  day: string,
  opts: { ownerId?: string; limit?: number } = {},
): Promise<NextActionsPage> {
  return nextActions(day, overdueWindow(day), opts);
}

/**
 * How many overdue promises have since been ANSWERED.
 *
 * Not on the list above and deliberately counted beside it. Without it the
 * overdue screen has no way to tell a team that is closing them from a team
 * that never had any, and both draw an empty table. One number, one sentence,
 * and the screen can say which kind of empty it is looking at.
 */
export async function overdueAnsweredCount(day: string): Promise<number> {
  const scope = await managerScope();
  const rows = await db.execute<{ answered: number }>(sql`
    select count(*)::int as answered
      from customers c
     where ${STILL_WORKING}
       and c.lead_next_action_date < ${day}::date
       and c.lead_next_action_outcome is not null
       ${leadsVisible(scope)}
  `);
  return Number(rows[0]?.answered ?? 0);
}

/* ══════════════════════════════════════════ §14 the communication log, book-wide */

/**
 * One thing that went out, read off the shared timeline.
 *
 * `leadCommunications` in `lead-console-service.ts` answers this for ONE lead
 * and is untouched; this is the same event type across the book, which is a
 * different query rather than the same one with the customer filter removed —
 * it needs the customer's own columns joined on, a keyset to page with, and the
 * scope narrowing that a single-lead read gets from the record page above it.
 */
export type CommunicationRow = {
  id: string;
  customerId: string;
  customerName: string;
  companyName: string | null;
  city: string | null;
  stage: LeadStage | null;
  salesType: LeadSalesType | null;
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  /** The one line a human reads. Never parsed — see `actionCode` instead. */
  summary: string;
  /*
   * WHICH OF THE ELEVEN THIS WAS, read off the source id rather than out of
   * the sentence. `recordCommunication` writes `lcm_<id>:<code>` — the shape
   * AGENTS.md already uses where one record produces several events — so the
   * log can be counted and filtered by action without ever parsing prose.
   *
   * Null on a row written before that landed. That is an UNKNOWN code and not
   * a wrong one, and the screen draws it as such: a bare `lcm_…` is a
   * communication somebody really logged, and dropping it would make the list
   * shorter than the thing it is a list of.
   */
  actionCode: string | null;
};

export type CommunicationLog = {
  rows: CommunicationRow[];
  total: number;
  /**
   * `<iso>|<id>` for the next page, or null at the end. A paged read needs a
   * tiebreaker: a day's worth of communications logged in one sitting share
   * their second, and `order by at desc` alone leaves their order to the
   * planner — which is a row on two pages and another on none.
   */
  nextCursor: string | null;
};

export async function communicationLog({
  limit = 60,
  cursor,
  actorId,
}: { limit?: number; cursor?: string; actorId?: string } = {}): Promise<CommunicationLog> {
  const scope = await managerScope();

  /* The cursor is a pair and is compared as one. Split into two conditions it
     would either skip the rows sharing the instant or return them twice. */
  const [cursorAt, cursorId] = cursor ? cursor.split("|") : [];
  const after =
    cursorAt && cursorId
      ? sql`and (e.occurred_at, e.id) < (${cursorAt}::timestamptz, ${cursorId})`
      : sql``;
  const byActor = actorId ? sql`and e.actor_user_id = ${actorId}` : sql``;

  const where = sql`
    where e.event_type = ${MBOS_EVENT.leadCommunication}
      ${leadsVisible(scope)}
  `;

  const [rows, counts] = await Promise.all([
    db.execute<CommunicationRow>(sql`
      select e.id, e.customer_id as "customerId", c.name as "customerName",
             c.company_name as "companyName", c.city,
             c.lead_stage::text as stage,
             c.lead_sales_type::text as "salesType",
             e.occurred_at as "occurredAt",
             e.actor_user_id as "actorId", u.name as "actorName",
             e.summary,
             /* FIELD TWO of the source id, through the one function that
                knows the shape -- see sourceIdField in timeline.ts. It was
                spelled out here and read a different way in the panel that
                draws the badges, and two readings of one convention agree
                right up until the id grows a third field, which one kind of
                event already has. */
             ${sourceIdField("e.source_record_id", 2)} as "actionCode"
        from timeline_events e
        join customers c on c.id = e.customer_id
        left join users u on u.id = e.actor_user_id
        ${where}
        ${byActor}
        ${after}
       order by e.occurred_at desc, e.id desc
       limit ${limit + 1}
    `) as unknown as CommunicationRow[],

    db.execute<{ total: number }>(sql`
      select count(*)::int as total
        from timeline_events e
        join customers c on c.id = e.customer_id
        ${where}
        ${byActor}
    `),
  ]);

  /* One row past the page is how the caller knows there is another one,
     without a second count over a keyset it has already moved past. */
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  /* `db.execute` hands back a string where the type says Date, so the instant
     is normalised before it is spelled — an ISO instant carries its own zone,
     which is what makes it safe to compare against a `timestamptz` and what
     keeps this out of the bare-cast rule entirely. */
  const lastAt = last ? asDate(last.occurredAt) : null;
  return {
    rows: page,
    total: Number(counts[0]?.total ?? 0),
    nextCursor:
      rows.length > limit && last && lastAt ? `${lastAt.toISOString()}|${last.id}` : null,
  };
}

/** Who has been logging communications, so the log can be filtered by person. */
export type CommunicationActor = { actorId: string | null; actorName: string | null; count: number };

export async function communicationActors(): Promise<CommunicationActor[]> {
  const scope = await managerScope();
  return db.execute<CommunicationActor>(sql`
    select e.actor_user_id as "actorId", u.name as "actorName", count(*)::int as count
      from timeline_events e
      join customers c on c.id = e.customer_id
      left join users u on u.id = e.actor_user_id
     where e.event_type = ${MBOS_EVENT.leadCommunication}
       ${leadsVisible(scope)}
     group by e.actor_user_id, u.name
     order by count(*) desc, u.name asc
     limit 40
  `) as unknown as CommunicationActor[];
}

/* ------------------------------------------------- which of the eleven it was */

/**
 * How many of each of the eleven have gone out, and when the last one did.
 *
 * **IT IS READ OFF THE AUDIT LOG AND NOT OFF THE TIMELINE, and that is a gap
 * rather than a preference.** `recordCommunication` writes two rows in one
 * transaction: a `timeline_events` row whose `summary` is the sentence a human
 * reads, and an `audit_log` row whose `after_state` carries `actionCode` — the
 * machine-readable half. The timeline row does NOT carry the code, and
 * `timeline_events.summary` says in its own schema comment that it is never
 * parsed by anything. Recovering "was this the brochure or the price list" by
 * matching the summary against `COMMUNICATION_ACTIONS` labels would be exactly
 * that parse, and it would stop resolving the first afternoon somebody improved
 * a label — silently, as a tally that started reading zero.
 *
 * So the two halves are read from the two places they actually live and the
 * screen says which is which. The join that would put them on one row does not
 * exist: the audit row and the timeline row share a customer and an instant and
 * no key, and matching on an instant is a join that works until two managers
 * press two buttons in the same second.
 *
 * What closes it is `recordCommunication` carrying the code onto the timeline
 * row — which is somebody else's file and is reported rather than reached into.
 */
export type CommunicationTally = {
  /** The `COMMUNICATION_ACTIONS` code, or whatever was stored if it is not one. */
  code: string;
  count: number;
  /** How many distinct leads, which is the number that says reach. */
  leads: number;
  lastAt: Date | null;
};

export async function communicationTally(): Promise<{
  /** One per code in `COMMUNICATION_ACTIONS`, in the order that list declares. */
  known: CommunicationTally[];
  /**
   * Codes in the log that are not among the eleven. It should be empty, and a
   * row here is a real fact about the book — an action retired from the list
   * after somebody had already used it — rather than a bug to hide.
   */
  unknown: CommunicationTally[];
  total: number;
}> {
  const scope = await managerScope();

  const rows = (await db.execute<CommunicationTally>(sql`
    select a.after_state->>'actionCode' as code,
           count(*)::int as count,
           count(distinct a.entity_id)::int as leads,
           max(a.at) as "lastAt"
      from audit_log a
      join customers c on c.id = a.entity_id
     where a.action = 'lead.communication'
       and a.entity_type = 'customer'
       and a.after_state->>'actionCode' is not null
       ${leadsVisible(scope)}
     group by a.after_state->>'actionCode'
  `)) as unknown as CommunicationTally[];

  const byCode = new Map(rows.map((r) => [r.code, r]));

  /* Declared order, not observed order. A tally sorted by volume reads as a
     league table and buries the action nobody has used, which is the one worth
     looking at. */
  const known = COMMUNICATION_ACTIONS.map(
    (a) => byCode.get(a.code) ?? { code: a.code, count: 0, leads: 0, lastAt: null },
  );
  const knownCodes = new Set(COMMUNICATION_ACTIONS.map((a) => a.code));
  const unknown = rows.filter((r) => !knownCodes.has(r.code));

  return {
    known,
    unknown,
    total: rows.reduce((n, r) => n + r.count, 0),
  };
}

/* --------------------------------------------- who a communication can be against */

export type CommunicableLead = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  stage: LeadStage;
  salesType: LeadSalesType | null;
};

/**
 * The leads a communication may be logged against, for the picker.
 *
 * Capped, and the cap is reported rather than hidden: a picker that silently
 * holds the newest three hundred of eight hundred leads is one somebody
 * searches, fails to find their lead in, and concludes is broken. Where the
 * list is a slice the screen says so and says where the whole book is.
 *
 * It is the WORKING set — `STILL_WORKING` — because `recordCommunication` goes
 * through `reachableLead`, and offering a won or archived lead here would be a
 * tile that opens a modal that is refused on save.
 */
export async function communicableLeads({
  limit = 300,
}: { limit?: number } = {}): Promise<{ rows: CommunicableLead[]; total: number }> {
  const scope = await managerScope();

  const where = sql`
    where ${STILL_WORKING}
      ${leadsVisible(scope)}
  `;

  const [rows, counts] = await Promise.all([
    db.execute<CommunicableLead>(sql`
      select c.id as "customerId", c.name, c.company_name as "companyName", c.city,
             c.lead_stage::text as stage,
             c.lead_sales_type::text as "salesType"
        from customers c
        ${where}
       order by c.lead_last_activity_date desc nulls last, c.name asc, c.id asc
       limit ${limit}
    `) as unknown as CommunicableLead[],
    db.execute<{ total: number }>(sql`
      select count(*)::int as total from customers c ${where}
    `),
  ]);

  return { rows, total: Number(counts[0]?.total ?? 0) };
}

/* ------------------------------------------------ who a next action can be owed by */

export type ActionOwnerCandidate = {
  id: string;
  name: string;
  /** How many working leads already name them somewhere. Ordering, not a rule. */
  leads: number;
};

/**
 * The people a next action may be given to.
 *
 * NOT `fieldTeam()`, which is the salesmen, and not the manager list either:
 * §24's person is routinely the lead manager on a lead the salesman still
 * visits, and offering one list would make half the real answers untypeable.
 * So the candidates are read off the book — anybody already holding a seat on
 * a working lead, as its salesman, its lead manager or the owner of its
 * current next action — which is the population that actually appears in this
 * column, scoped exactly as the rows are.
 *
 * It is a PICKER and not a permission. `setLeadNextAction` checks that the
 * person can sign in and is active, and refuses otherwise; this only decides
 * what is offered without hunting, the same trade the distributor picker
 * makes one module over.
 */
export async function nextActionOwnerCandidates(): Promise<ActionOwnerCandidate[]> {
  const scope = await managerScope();
  return db.execute<ActionOwnerCandidate>(sql`
    select p.id, p.name, count(*)::int as leads
      from customers c
      join users p
        on p.id in (c.owner_id, c.lead_manager_id, c.lead_next_action_owner_id)
     where ${STILL_WORKING}
       and p.active
       ${leadsVisible(scope)}
     group by p.id, p.name
     order by count(*) desc, p.name asc
     limit 60
  `) as unknown as ActionOwnerCandidate[];
}
