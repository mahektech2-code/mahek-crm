import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, asDate } from "../business-date";
import { getConfig } from "../config/store";
import {
  checklistFor,
  gateForNext,
  gateTo,
  mustDecideSuspect,
  type Condition,
  type GateVerdict,
} from "../engines/lead-gates";
import {
  verificationAnswers,
  verificationVerdict,
  type LeadSalesType,
  type LeadStage,
} from "../lead-labels";
import { leadGateInput } from "./lead-service";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * The three reads behind the Qualification module's other three tabs.
 *
 * `lead-console-service.ts` already owns the verification QUEUE, which is the
 * work waiting to be done. These three are the other half of the same module:
 * who is sitting undecided (§4), what the calls that were made actually said
 * (§8), and what a book of leads at Qualification is stuck behind (§28). They
 * are here rather than there for the reason that file gives for existing at
 * all — one screen's reads live together, and a file nobody can hold in their
 * head is a file where the next reader adds a fourth copy of a query rather
 * than finding the third.
 *
 * Reads only. Every write on these three screens is an EXISTING action in
 * `lib/actions/leads.ts` — `decideSuspect`, `saveLeadQualification`,
 * `advanceLeadStage` — and nothing here writes anything at all.
 *
 * TWO RULES RUN THROUGH ALL OF IT, both inherited rather than restated:
 *
 * **No verdict is derived here.** `mustDecideSuspect`, `gateForNext` and
 * `checklistFor` are the only producers of an answer about a lead, and these
 * functions call them. A screen that worked out for itself whether a gate was
 * shut would be a second copy of §28 drifting inside one release, and the half
 * that drifts is the half somebody is reading.
 *
 * **Scope is resolved here, never passed in.** `managerScope()` reads the
 * session inside the service, so there is no call site that can forget it — and
 * a forgotten filter is silent, looks like working software, and shows a
 * regional manager the whole country.
 * ------------------------------------------------------------------------- */

/**
 * The rungs these three screens treat as live work.
 *
 * The same fragment `lead-console-service.ts` keeps, written again rather than
 * imported because it is not exported there and this file may not edit it.
 * That is a real duplication and it is named here rather than hidden: if the
 * definition of a worklist ever changes, both copies have to move, and the
 * comment is what tells the next reader there is a second one.
 */
const STILL_WORKING = sql.raw(
  `c.lead_stage is not null
     and c.lead_archived = false
     and c.lead_stage not in ('lost', 'won', 'customer', 'active_distributor')`,
);

/* ═════════════════════════════════════════════ §4 — the suspect decisions */

/**
 * What the screen says about one undecided Suspect.
 *
 * `demanded` is the ENGINE's answer and nothing else. The band beside it is
 * what a screen needs in order to draw three groups, and only its first step —
 * "has this reached the warning threshold" — is computed here, because the
 * engine has no function for a warning: §4's warning is a sentence on a
 * handset, not a gate, and there is nothing for it to refuse.
 */
export type SuspectDecisionRow = {
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
  stageSince: string | null;
  /** Days on this rung. What "sitting undecided" is measured in. */
  waitingDays: number;
  /** `count(*)` over `mbos_visits`, never a cached column — see below. */
  visitCount: number;
  lastVisitAt: Date | null;
  /** How far past the cap, which is what the list is sorted by. */
  overCap: number;
  /** Set once somebody has answered. Such a lead is off this list entirely. */
  decidedAt: Date | null;
  /** §4's third answer: still a Suspect, and why. */
  holdReason: string | null;
  /** What the salesman has already established, so the decision is informed. */
  competitor: string | null;
  monthlyLitres: number | null;
  potentialPaise: number | null;
  /** The engine's own answer: is an answer MANDATORY before a visit closes. */
  demanded: boolean;
  band: "past" | "must_decide" | "warned" | "watching";
  /**
   * True where the rung is not the funnel's `suspect` at all.
   *
   * `mustDecideSuspect` answers only about `suspect`, and a lead raised before
   * the funnel existed climbs `new → contacted → …` with no sales type. Those
   * leads are LISTED, because a shop visited five times that nobody has decided
   * about is the same problem whichever vocabulary it was raised in — and they
   * are marked, because saying the engine demands an answer when it does not
   * would be this screen inventing a rule of its own.
   */
  legacyRung: boolean;
};

export type SuspectDecisions = {
  rows: SuspectDecisionRow[];
  /** From SQL. A capped list still says what it is a slice of. */
  total: number;
  warnAt: number;
  decideAt: number;
};

/**
 * §4 — every lead nobody has decided about, furthest past the cap first.
 *
 * **THE VISIT COUNT IS `count(*)` OVER `mbos_visits` AND NEVER A COLUMN.** A
 * counter would drift the first time a visit arrived late from a handset, which
 * is not an edge case: a salesman in a district with no signal syncs on
 * Wednesday what he did on Monday, and a count incremented on arrival would
 * have him asked for a decision one visit early or one visit late for ever.
 *
 * **Sorted by how far past the cap, not by age.** Two visits on a shop seen
 * last week and five on one nobody has decided about since March are not the
 * same problem, and the second is the one §4 exists for. `overCap` can be
 * negative — a lead approaching the warning is still worth seeing, because the
 * screen's job is to stop leads reaching the cap rather than to list the ones
 * that have.
 *
 * Both the funnel's `suspect` and the legacy `new`/`contacted` are here. See
 * `legacyRung` above for what the second means and what it deliberately does
 * not claim.
 */
export async function suspectDecisions(
  day: string,
  { limit = 300 }: { limit?: number } = {},
): Promise<SuspectDecisions> {
  const [scope, config] = await Promise.all([managerScope(), getConfig()]);
  const warnAt = config["mbos.leads.visitsBeforeDecision"];
  const decideAt = config["mbos.leads.maxSuspectVisits"];

  const where = sql`
     where ${STILL_WORKING}
       and c.lead_stage in ('suspect', 'new', 'contacted')
       and c.lead_suspect_decided_at is null
       ${leadsVisible(scope)}
  `;

  /* `${decideAt}::int` and not a bare parameter. An untyped parameter beside a
     number lets Postgres resolve the arithmetic somewhere nobody meant, and the
     same omission one type along — a date minus an untyped parameter — took the
     whole MBOS pull down twice. The cast costs nothing and the absence of it
     fails at the database rather than at any type check. */
  const [rows, counts] = await Promise.all([
    db.execute<SuspectDecisionRow>(sql`
      select c.id as "customerId", c.name, c.company_name as "companyName",
             c.city, c.area, c.phone as mobile, c.contact_person as "contactPerson",
             c.lead_sales_type::text as "salesType",
             c.lead_stage::text as stage,
             c.owner_id as "salesmanId", u.name as "salesmanName",
             c.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
             c.lead_stage_since::text as "stageSince",
             coalesce(${day}::date - c.lead_stage_since, 0)::int as "waitingDays",
             coalesce(v.n, 0)::int as "visitCount",
             v.last_at as "lastVisitAt",
             (coalesce(v.n, 0) - ${decideAt}::int)::int as "overCap",
             c.lead_suspect_decided_at as "decidedAt",
             c.lead_hold_reason as "holdReason",
             c.lead_competitor as competitor,
             c.lead_monthly_volume_litres as "monthlyLitres",
             c.lead_estimated_potential_paise as "potentialPaise"
        from customers c
        left join users u on u.id = c.owner_id
        left join users m on m.id = c.lead_manager_id
        left join lateral (
          select count(*)::int as n, max(x.check_in_at) as last_at
            from mbos_visits x
           where x.customer_id = c.id
        ) v on true
        ${where}
       order by coalesce(v.n, 0) desc, c.lead_stage_since asc nulls first, c.id asc
       limit ${limit}
    `) as unknown as SuspectDecisionRow[],
    db.execute<{ total: number }>(sql`
      select count(*)::int as total
        from customers c
        ${where}
    `),
  ]);

  return {
    rows: rows.map((r) => {
      const visitCount = Number(r.visitCount ?? 0);
      const stage = r.stage as LeadStage;
      /* The engine, given exactly the three facts it reads. Handing it a
         hand-built input is not a second reading of the book: every one of
         these came off the row above, and `mustDecideSuspect` is still the only
         thing that decides whether an answer is owed. */
      const demanded = mustDecideSuspect(
        {
          salesType: (r.salesType as LeadSalesType | null) ?? null,
          stage,
          suspectVisitCount: visitCount,
          suspectDecidedAt: asDate(r.decidedAt),
        },
        decideAt,
      );
      return {
        ...r,
        visitCount,
        stage,
        lastVisitAt: asDate(r.lastVisitAt),
        decidedAt: asDate(r.decidedAt),
        overCap: visitCount - decideAt,
        demanded,
        band: demanded
          ? visitCount > decideAt
            ? ("past" as const)
            : ("must_decide" as const)
          : visitCount >= warnAt
            ? ("warned" as const)
            : ("watching" as const),
        legacyRung: stage !== "suspect",
      };
    }),
    total: Number(counts[0]?.total ?? 0),
    warnAt,
    decideAt,
  };
}

/* ═════════════════════════════════════════════ §8 — the calls that were made */

/**
 * One thing the salesman wrote down and the office was told something else
 * about.
 *
 * THIS IS THE REASON THE SCREEN EXISTS. `customers.lead_requirement` is what
 * the salesman was told standing in the shop; `confirmed_requirement` is what
 * the shop told the office on the phone, and the two disagreeing is how
 * anybody ever finds out that the report and the shop did not match. Collapsing
 * them into one column would overwrite the first reading with the second and
 * destroy exactly that.
 *
 * `comparable` is false where one side is silent, and that is NOT a
 * disagreement: a question nobody asked and two answers that differ are
 * different facts about a call, and drawing them alike would put an accusation
 * on a row where nothing happened.
 */
export type ValidationDisagreement = {
  field: string;
  label: string;
  /** What the salesman recorded on the lead. */
  reported: string | null;
  /** What the shop said on the call. */
  confirmed: string | null;
  comparable: boolean;
  differs: boolean;
};

export type ValidationCallRow = {
  id: string;
  customerId: string;
  customerName: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  salesmanId: string | null;
  salesmanName: string | null;
  callerId: string;
  callerName: string | null;
  calledAt: Date;
  reached: boolean;
  /** Null where nobody has decided — `pending` is a real state, not a missing one. */
  verified: boolean | null;
  verdictRaw: string;
  verdictReason: string | null;
  notes: string | null;
  /** The twelve, keyed the way the form asked them. */
  answers: Record<string, string>;
  answered: number;
  disagreements: ValidationDisagreement[];
  /** How many times this shop has been rung. The first call is usually the one that matters. */
  attempt: number;
  attempts: number;
};

export type ValidationCalls = {
  rows: ValidationCallRow[];
  total: number;
  /** Calls in the window where at least one answer contradicts the lead. */
  withDisagreement: number;
  days: number;
};

/**
 * §8 — the record of validation calls, newest first.
 *
 * Not the queue: that is the Verification tab one along, and it answers "who
 * has nobody rung". This answers "what did the calls say", which is the
 * question somebody asks about a BOOK rather than about a lead — and the only
 * place the pattern is visible. One salesman whose reports disagree with the
 * shop on every third call is invisible one record at a time.
 *
 * It writes nothing and there is no action on this screen. A validation record
 * is append-only by nature: a second call is a second row, and the first is
 * usually the one that matters, so there is nothing here that could honestly be
 * edited.
 */
export async function validationCalls(
  day: string,
  { days = 90, limit = 200 }: { days?: number; limit?: number } = {},
): Promise<ValidationCalls> {
  const scope = await managerScope();

  /* A stored DATE is not an instant until something names the midnight, and
     `called_at` is a timestamptz being compared against one. A bare
     `::timestamptz` on the left is evaluated in the SESSION's zone, and the
     session is not a property of the row — one pooled connection left in
     another zone answers differently from the rest, in one process. */
  const since = sql`((${day}::date - ${days}::int)::timestamp at time zone ${APP_TIMEZONE})`;

  const where = sql`
     where k.called_at >= ${since}
       ${leadsVisible(scope)}
  `;

  const [rows, counts] = await Promise.all([
    db.execute(sql`
      select k.id, k.customer_id as "customerId", k.called_by_user_id as "callerId",
             k.called_at as "calledAt", k.reached, k.verdict, k.verdict_reason, k.notes,
             k.salesman_visited, k.mahek_explained, k.product_understood,
             k.current_product, k.confirmed_competitor, k.confirmed_requirement,
             k.growth_potential, k.salesman_feedback, k.price_concern,
             k.quality_feedback, k.dispatch_feedback, k.genuine_interest,
             k.confirmed_monthly_volume_litres, k.confirmed_potential_paise,
             c.name as "customerName", c.company_name as "companyName", c.city,
             c.lead_sales_type::text as "salesType", c.lead_stage::text as stage,
             c.lead_requirement as "leadRequirement",
             c.lead_competitor as "leadCompetitor",
             c.lead_monthly_volume_litres as "leadMonthlyLitres",
             c.lead_estimated_potential_paise as "leadPotentialPaise",
             c.owner_id as "salesmanId", u.name as "salesmanName",
             caller.name as "callerName",
             (select count(*)::int from mbos_lead_validations e
               where e.customer_id = k.customer_id) as attempts,
             (select count(*)::int from mbos_lead_validations e
               where e.customer_id = k.customer_id
                 and (e.called_at, e.id) <= (k.called_at, k.id)) as attempt
        from mbos_lead_validations k
        join customers c on c.id = k.customer_id
        left join users u on u.id = c.owner_id
        left join users caller on caller.id = k.called_by_user_id
        ${where}
       order by k.called_at desc, k.id desc
       limit ${limit}
    `) as unknown as Record<string, unknown>[],
    db.execute<{ total: number }>(sql`
      select count(*)::int as total
        from mbos_lead_validations k
        join customers c on c.id = k.customer_id
        ${where}
    `),
  ]);

  const mapped = rows.flatMap<ValidationCallRow>((r) => {
    /* `db.execute` hands back a timestamptz as a STRING whatever the type
       annotation says, so it comes through `asDate`. The column is NOT NULL,
       which makes null here a row the driver could not parse — dropped rather
       than carried as an Invalid Date that throws somewhere unrelated. */
    const calledAt = asDate(r.calledAt);
    if (!calledAt) return [];

    /* Read off snake_case and handed across in the camelCase keys the shared
       vocabulary is written in. A raw row cast across that boundary is what
       made `canRead` refuse every attachment for months. */
    const answers = verificationAnswers({
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
    });

    return [
      {
        id: String(r.id),
        customerId: String(r.customerId),
        customerName: String(r.customerName),
        companyName: (r.companyName as string | null) ?? null,
        city: (r.city as string | null) ?? null,
        salesType: (r.salesType as LeadSalesType | null) ?? null,
        stage: r.stage as LeadStage,
        salesmanId: (r.salesmanId as string | null) ?? null,
        salesmanName: (r.salesmanName as string | null) ?? null,
        callerId: String(r.callerId),
        callerName: (r.callerName as string | null) ?? null,
        calledAt,
        reached: r.reached !== false,
        verified: verificationVerdict((r.verdict as string | null) ?? null),
        verdictRaw: String(r.verdict ?? "pending"),
        verdictReason: (r.verdict_reason as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
        answers,
        answered: Object.keys(answers).length,
        disagreements: disagreementsIn(r),
        attempt: Number(r.attempt ?? 1),
        attempts: Number(r.attempts ?? 1),
      },
    ];
  });

  return {
    rows: mapped,
    total: Number(counts[0]?.total ?? 0),
    withDisagreement: mapped.filter((r) => r.disagreements.some((d) => d.differs)).length,
    days,
  };
}

/**
 * The four things both sides answered, compared.
 *
 * Text is compared case- and space-insensitively and nothing cleverer: "Asian
 * Paints" and "asian paints " are one answer, and deciding that "Asian" and
 * "Asian Paints thinner" are the same answer is a judgement this screen has no
 * business making on somebody's behalf. Numbers are compared as numbers, so 200
 * and 200.0 do not read as a contradiction.
 *
 * The volume and the potential are on the row and deliberately NOT filled by
 * the verification form — see `VERIFICATION_COLUMNS` — so on most calls they
 * are silent and come back `comparable: false`. They are still asked, because
 * the handset's own validation path does fill them and a comparison that only
 * exists for one of two writers is a comparison nobody trusts.
 */
function disagreementsIn(r: Record<string, unknown>): ValidationDisagreement[] {
  const text = (v: unknown) => {
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    return s.length ? s : null;
  };
  const num = (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const pairs: Array<{
    field: string;
    label: string;
    reported: string | null;
    confirmed: string | null;
    differs: boolean;
  }> = [];

  const push = (
    field: string,
    label: string,
    reported: string | null,
    confirmed: string | null,
    differs: boolean,
  ) => pairs.push({ field, label, reported, confirmed, differs });

  const reportedRequirement = text(r.leadRequirement);
  const confirmedRequirement = text(r.confirmed_requirement);
  push(
    "requirement",
    "What they need",
    reportedRequirement,
    confirmedRequirement,
    Boolean(
      reportedRequirement &&
        confirmedRequirement &&
        reportedRequirement.toLowerCase() !== confirmedRequirement.toLowerCase(),
    ),
  );

  const reportedCompetitor = text(r.leadCompetitor);
  const confirmedCompetitor = text(r.confirmed_competitor);
  push(
    "competitor",
    "Whose product they use",
    reportedCompetitor,
    confirmedCompetitor,
    Boolean(
      reportedCompetitor &&
        confirmedCompetitor &&
        reportedCompetitor.toLowerCase() !== confirmedCompetitor.toLowerCase(),
    ),
  );

  const reportedLitres = num(r.leadMonthlyLitres);
  const confirmedLitres = num(r.confirmed_monthly_volume_litres);
  push(
    "monthly_litres",
    "Litres a month",
    reportedLitres === null ? null : String(reportedLitres),
    confirmedLitres === null ? null : String(confirmedLitres),
    reportedLitres !== null && confirmedLitres !== null && reportedLitres !== confirmedLitres,
  );

  const reportedPotential = num(r.leadPotentialPaise);
  const confirmedPotential = num(r.confirmed_potential_paise);
  push(
    "potential_paise",
    "What they could be worth",
    reportedPotential === null ? null : String(reportedPotential),
    confirmedPotential === null ? null : String(confirmedPotential),
    reportedPotential !== null &&
      confirmedPotential !== null &&
      reportedPotential !== confirmedPotential,
  );

  return pairs.map((p) => ({
    ...p,
    comparable: p.reported !== null && p.confirmed !== null,
  }));
}

/* ═══════════════════════════════════════════════ §28 — the qualification desk */

/** One condition of a lead's checklist, with both halves of its answer. */
export type ChecklistItem = {
  id: string;
  says: string;
  group?: Condition["group"];
  /** Whether the gate is satisfied. From the ENGINE, never worked out here. */
  met: boolean;
  /** Whether somebody ticked the box beside it. */
  ticked: boolean;
  /**
   * WHETHER THE TICK IS WHAT SATISFIES IT — ASKED OF THE ENGINE, NEVER LISTED.
   *
   * Four of the twelve are genuine yes/no judgements with nothing to store but
   * the answer, and the other eight are satisfied by a real column. Which four
   * is a fact about `lead-gates.ts` and it is ASKED rather than copied: the
   * condition is put back to `gateTo` with its own box forced on and then
   * forced off, and the tick is the answer only where the first opens it and
   * the second shuts it. A list of the eight typed in here would be a second
   * copy of the gate, and the
   * day somebody moves a condition from a tick to a column the copy is the half
   * still saying the old thing — on the screen a manager is reading.
   */
  satisfiedByTick: boolean;
  /**
   * A TICK IS NOT AN ANSWER WHERE A COLUMN EXISTS.
   *
   * Eight of the twelve are satisfied by a real value and not by the checkbox —
   * the gate reads `lead_monthly_volume_litres`, not a boolean beside the words
   * "monthly requirement" — so a ticked box over an empty field is precisely
   * the state §28 exists to prevent, and it is INVISIBLE unless a screen draws
   * it. This is that state, and it is derived from the engine's own verdict
   * rather than from a list of which conditions are column-backed: such a list
   * typed in here would be a second copy of the gate, and the day somebody
   * moves a condition from a tick to a column the copy would be the half
   * still saying the old thing.
   */
  tickedButEmpty: boolean;
};

export type QualificationDeskRow = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  mobile: string | null;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerId: string | null;
  leadManagerName: string | null;
  stageSince: string | null;
  stuckDays: number;
  quietDays: number;
  /** The whole checklist, in the order the engine lists it. */
  checklist: ChecklistItem[];
  done: number;
  /** The gate for the NEXT rung, which is what the checklist is the toll for. */
  gate: GateVerdict;
  /** Ticked boxes over empty fields. The count the Blocked view leads on. */
  tickedButEmpty: number;
  /** Never computed here — `gate.open`, said once. */
  ready: boolean;
};

export type QualificationDesk = {
  rows: QualificationDeskRow[];
  /** From SQL, over the whole visible book rather than the page. */
  total: number;
  /** True where the desk is a slice and the band counts describe the slice. */
  capped: boolean;
};

/**
 * The row as the list query returns it, before the gates are asked about it.
 *
 * Its own type because the desk is built in two halves — a list query and a
 * per-lead reading — and an inline shape repeated at both ends is the pair that
 * drifts by one column.
 */
type DeskHead = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  mobile: string | null;
  salesType: string | null;
  stage: string;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerId: string | null;
  leadManagerName: string | null;
  stageSince: string | null;
  stuckDays: number;
  quietDays: number;
};

/**
 * §28 — every lead at Qualification, with what its gate is still waiting on.
 *
 * `leadGateInput` is the ONE assembler of what the gates read, and this calls
 * it per lead rather than writing a wider query of its own. That is the whole
 * reason it exists: the console's checklist, `advanceLeadStage` and the sync
 * handler all ask the same question of the same reading, and a list query that
 * gathered the same eleven facts a little differently would put a screen and a
 * save into disagreement about whether a lead may move — with the screen the
 * half somebody is working from.
 *
 * It costs several queries per lead, which is why the desk is CAPPED and says
 * so rather than quietly paging. A desk of forty is a morning's work; a desk of
 * four hundred is a different screen, and inventing it here would mean either a
 * second reading of the gates or a page that takes ten seconds to draw.
 */
export async function qualificationDesk(
  day: string,
  { limit = 60 }: { limit?: number } = {},
): Promise<QualificationDesk> {
  const scope = await managerScope();

  const where = sql`
     where ${STILL_WORKING}
       and c.lead_stage = 'qualification'
       ${leadsVisible(scope)}
  `;

  const [heads, counts] = await Promise.all([
    db.execute<DeskHead>(sql`
      select c.id as "customerId", c.name, c.company_name as "companyName",
             c.city, c.phone as mobile,
             c.lead_sales_type::text as "salesType",
             c.lead_stage::text as stage,
             c.owner_id as "salesmanId", u.name as "salesmanName",
             c.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
             c.lead_stage_since::text as "stageSince",
             coalesce(${day}::date - c.lead_stage_since, 0)::int as "stuckDays",
             coalesce(${day}::date - c.lead_last_activity_date, 0)::int as "quietDays"
        from customers c
        left join users u on u.id = c.owner_id
        left join users m on m.id = c.lead_manager_id
        ${where}
       order by c.lead_stage_since asc nulls first, c.id asc
       limit ${limit}
    `),
    db.execute<{ total: number }>(sql`
      select count(*)::int as total
        from customers c
        ${where}
    `),
  ]);

  /* In batches rather than one `Promise.all` over the lot: each lead is eight
     queries, and sixty at once is four hundred and eighty connections' worth of
     work asked for in one breath. The pool would serialise it anyway; asking
     politely is what keeps the rest of the app answering while this draws. */
  const rows: QualificationDeskRow[] = [];
  const BATCH = 8;
  for (let i = 0; i < heads.length; i += BATCH) {
    const slice = heads.slice(i, i + BATCH);
    const built = await Promise.all(slice.map((head) => deskRow(head)));
    for (const r of built) if (r) rows.push(r);
  }

  return {
    rows,
    total: Number(counts[0]?.total ?? 0),
    capped: heads.length < Number(counts[0]?.total ?? 0),
  };
}

async function deskRow(head: DeskHead): Promise<QualificationDeskRow | null> {
  const input = await leadGateInput(head.customerId);
  /* A lead that vanished between the list and the detail. Dropped rather than
     drawn half-built: a row with no gate on a §28 screen is a row that says
     nothing and looks like a lead nobody is blocking. */
  if (!input) return null;

  const gate = gateForNext(input);
  const missing = new Set(gate.missing.map((c) => c.id));
  const answers = input.qualification ?? {};

  const checklist: ChecklistItem[] = checklistFor(input.salesType, input.stage).map((c) => {
    const met = !missing.has(c.id);
    const ticked = hasAnswer(answers[c.id]);
    /* PUT BACK TO THE ENGINE TWICE, with this one box forced each way and
       nothing else changed. One probe cannot answer it: with the tick forced on,
       a condition a filled COLUMN already satisfies also comes back met, and
       reading that as "the tick did it" is exactly the confusion this flag
       exists to clear. The tick is what decides a condition only where forcing
       it on satisfies the gate AND forcing it off breaks it. */
    const missingWith = (value: boolean) =>
      gate.noNextRung
        ? true
        : gateTo({ ...input, qualification: { ...answers, [c.id]: value } }, gate.to).missing.some(
            (m) => m.id === c.id,
          );
    const satisfiedByTick = !gate.noNextRung && !missingWith(true) && missingWith(false);
    return {
      id: c.id,
      says: c.says,
      group: c.group,
      met,
      ticked,
      satisfiedByTick,
      tickedButEmpty: ticked && !met,
    };
  });

  return {
    customerId: head.customerId,
    name: head.name,
    companyName: head.companyName,
    city: head.city,
    mobile: head.mobile,
    salesType: (head.salesType as LeadSalesType | null) ?? null,
    stage: head.stage as LeadStage,
    salesmanId: head.salesmanId,
    salesmanName: head.salesmanName,
    leadManagerId: head.leadManagerId,
    leadManagerName: head.leadManagerName,
    stageSince: head.stageSince,
    stuckDays: Number(head.stuckDays ?? 0),
    quietDays: Number(head.quietDays ?? 0),
    checklist,
    done: checklist.filter((c) => c.met).length,
    gate,
    tickedButEmpty: checklist.filter((c) => c.tickedButEmpty).length,
    ready: gate.open,
  };
}

/** The same reading of a stored answer the gate engine makes of one. */
function hasAnswer(v: boolean | string | undefined): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  return v === true;
}

/* ══════════════════════════════════════════ §28 — who passed a shut gate */

export type OverriddenMoveRow = {
  id: string;
  customerId: string;
  customerName: string;
  companyName: string | null;
  city: string | null;
  salesType: LeadSalesType | null;
  fromStage: LeadStage | null;
  toStage: LeadStage;
  at: Date;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  actorApp: string | null;
  reasonCode: string | null;
  note: string | null;
  /** Exactly what the gate was refusing on when somebody moved it anyway. */
  overriddenConditions: string[];
};

export type OverriddenMoves = {
  rows: OverriddenMoveRow[];
  total: number;
  /** Condition id → how many times it was overridden in the window. */
  byCondition: Array<{ id: string; count: number }>;
  days: number;
};

/**
 * Every move that went past a shut gate, and what was shut.
 *
 * **THIS IS NOT A LIST OF PEOPLE WHO CHEATED.** It is how somebody finds out
 * that ONE condition is shut on everybody and is the wrong condition — a gate
 * that forty leads were pushed past is a gate asking for something the business
 * does not actually have, and the fix is the gate rather than the forty.
 * `byCondition` is the whole point of the screen and is why the counting is
 * here rather than left to a reader scanning rows.
 *
 * It is a read over `lead_stage_transitions`, which is append-only: a
 * transition recorded wrongly is corrected by a further transition, never by an
 * edit, so nothing on this screen may ever offer to change one.
 *
 * Not restricted to leads still at Qualification. An override is most worth
 * seeing on a lead that has since moved on — that is the one nobody would
 * otherwise go back and look at.
 */
export async function overriddenMoves(
  day: string,
  { days = 90, limit = 200 }: { days?: number; limit?: number } = {},
): Promise<OverriddenMoves> {
  const scope = await managerScope();

  const since = sql`((${day}::date - ${days}::int)::timestamp at time zone ${APP_TIMEZONE})`;

  const where = sql`
     where t.kind = 'overridden'
       and t.at >= ${since}
       ${leadsVisible(scope)}
  `;

  const [rows, counts] = await Promise.all([
    db.execute(sql`
      select t.id, t.customer_id as "customerId",
             t.from_stage::text as "fromStage", t.to_stage::text as "toStage",
             t.at, t.actor_id as "actorId", t.actor_role as "actorRole",
             t.actor_app as "actorApp", t.reason_code as "reasonCode", t.note,
             t.overridden_conditions as "overriddenConditions",
             c.name as "customerName", c.company_name as "companyName", c.city,
             c.lead_sales_type::text as "salesType",
             a.name as "actorName"
        from lead_stage_transitions t
        join customers c on c.id = t.customer_id
        left join users a on a.id = t.actor_id
        ${where}
       order by t.at desc, t.id desc
       limit ${limit}
    `) as unknown as Record<string, unknown>[],
    db.execute<{ total: number }>(sql`
      select count(*)::int as total
        from lead_stage_transitions t
        join customers c on c.id = t.customer_id
        ${where}
    `),
  ]);

  const mapped = rows.flatMap<OverriddenMoveRow>((r) => {
    const at = asDate(r.at);
    if (!at) return [];
    const conditions = Array.isArray(r.overriddenConditions)
      ? (r.overriddenConditions as unknown[]).map(String)
      : [];
    return [
      {
        id: String(r.id),
        customerId: String(r.customerId),
        customerName: String(r.customerName),
        companyName: (r.companyName as string | null) ?? null,
        city: (r.city as string | null) ?? null,
        salesType: (r.salesType as LeadSalesType | null) ?? null,
        fromStage: (r.fromStage as LeadStage | null) ?? null,
        toStage: r.toStage as LeadStage,
        at,
        actorId: (r.actorId as string | null) ?? null,
        actorName: (r.actorName as string | null) ?? null,
        actorRole: (r.actorRole as string | null) ?? null,
        actorApp: (r.actorApp as string | null) ?? null,
        reasonCode: (r.reasonCode as string | null) ?? null,
        note: (r.note as string | null) ?? null,
        overriddenConditions: conditions,
      },
    ];
  });

  const tally = new Map<string, number>();
  for (const r of mapped) {
    for (const id of r.overriddenConditions) tally.set(id, (tally.get(id) ?? 0) + 1);
  }

  return {
    rows: mapped,
    total: Number(counts[0]?.total ?? 0),
    byCondition: [...tally.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    days,
  };
}
