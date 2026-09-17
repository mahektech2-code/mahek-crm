import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, asDate } from "../business-date";
import { listSettings, type SettingRow } from "../config/store";
import {
  DISTRIBUTOR_CONDITIONS,
  PROSPECT_CONDITIONS,
  QUALIFICATION_CONDITIONS,
} from "../engines/lead-gates";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { leadsVisible, managerScope, onlyMine } from "./sales-service";

/* ---------------------------------------------------------------------------
 * OVERSIGHT — the three questions nobody can answer from a worklist.
 *
 * Who is running a converted account. Which shut gates somebody walked past.
 * What was done to the funnel, under whose hat. Every one of them is a read of
 * something that already exists — a pair of columns, an append-only table, the
 * audit log — and none of them is a new fact. That is deliberate: an oversight
 * screen that stores its own answer is a second copy of the thing it is meant
 * to be watching, and the copy is the half that drifts.
 *
 * NOTHING IN THIS FILE WRITES. There is no update, no insert and no delete
 * path here and there is not meant to be one — the handover is performed by
 * `handOverRelationships`, and a threshold is authored in the Admin Console.
 *
 * Two rules run through it, both inherited from `lead-console-service.ts`
 * beside it and both load-bearing. **Scope is resolved here, never passed in**
 * — `managerScope()` reads the session inside the service, so there is no call
 * site that can forget the filter, and a forgotten filter is silent and looks
 * exactly like working software. **Raw SQL, every column of the outer table
 * qualified, every day window naming its zone**: a bare `${customers.id}`
 * renders as `"id"` and binds to the inner table inside a correlated subquery,
 * and a bare `::date` reads in the session's zone, which is not a property of
 * the row.
 * ------------------------------------------------------------------------- */

/**
 * WHOSE BOOK A CONVERTED ACCOUNT IS IN, spelled for the alias these queries
 * use.
 *
 * `ASSIGNED_TO_SQL` is the authority and says the same thing about the table
 * called `customers`; none of the reads here can use it, because they all join
 * and alias. It is the sales seat after somebody decided, and the sales seat
 * falling back to the owner before anybody did — the lead arm is deliberately
 * absent, since a converted account is by construction no longer a lead.
 */
const BOOK_OF_C = `case when c.am_decided_at is not null
                        then c.sales_am_id
                        else coalesce(c.sales_am_id, c.owner_id) end`;

/* ═════════════════════════════════════════════════ §Q the outstanding seats */

export type OutstandingHandover = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  stage: LeadStage | null;
  salesType: LeadSalesType | null;
  /** The instant `kind` flipped. What "outstanding" is measured from. */
  convertedAt: Date | null;
  /** Whole days since, in Asia/Kolkata. Null where the instant is missing. */
  waitingDays: number | null;
  /** Who coordinated it as a lead, and is still holding it for want of this. */
  leadManagerId: string | null;
  leadManagerName: string | null;
  /** Null by construction on this list — the panel wants it anyway. */
  relationshipOwnerId: string | null;
  relationshipOwnerName: string | null;
  /** Whose book it is for crediting orders. NOT what a handover moves. */
  salesSeatName: string | null;
};

/**
 * CONVERTED, AND NOBODY NAMED TO RUN IT — derived, never stored.
 *
 * A flag would be a cache, and the only facts it could be rebuilt from are the
 * two columns it would be caching: `lead_converted_at` and `handed_over_at`.
 * So there is nothing to rebuild it FROM that is not simply asking the
 * question, and a cache with no recompute path is a column that goes wrong
 * quietly and is believed for months. `pendingHandoverClause()` in
 * `handover-service.ts` is the same condition said in Drizzle, for the callers
 * that can use the table directly; this is it said in SQL, for the one that
 * cannot.
 *
 * **Oldest first.** The cost of this list is not that any one account is
 * broken — every one of them works perfectly, which is exactly why nobody
 * notices — it is that the longer a row sits here the less anybody remembers
 * who was supposed to take it on.
 *
 * A row with no `lead_converted_at` cannot appear at all, and that is the
 * honest behaviour rather than a gap: `kind` flipping without the marker being
 * written is a state this codebase does not produce, and inventing a wait for
 * a conversion with no date would put a number on the screen nobody could
 * check.
 */
export async function outstandingHandovers(
  { limit = 200 }: { limit?: number } = {},
): Promise<{ rows: OutstandingHandover[]; total: number }> {
  const scope = await managerScope();

  const rows = await db.execute<{
    customer_id: string;
    name: string;
    company_name: string | null;
    city: string | null;
    stage: LeadStage | null;
    sales_type: LeadSalesType | null;
    converted_at: unknown;
    waiting_days: number | null;
    lead_manager_id: string | null;
    lead_manager_name: string | null;
    relationship_owner_id: string | null;
    relationship_owner_name: string | null;
    sales_seat_name: string | null;
    total: number;
  }>(sql`
    select c.id as customer_id, c.name, c.company_name, c.city,
           c.lead_stage as stage, c.lead_sales_type as sales_type,
           c.lead_converted_at as converted_at,
           (now() at time zone ${APP_TIMEZONE})::date
             - (c.lead_converted_at at time zone ${APP_TIMEZONE})::date as waiting_days,
           c.lead_manager_id, lm.name as lead_manager_name,
           c.relationship_owner_id, ro.name as relationship_owner_name,
           coalesce(c.sales_person_name, seat.name) as sales_seat_name,
           (count(*) over ())::int as total
      from customers c
      left join users lm on lm.id = c.lead_manager_id
      left join users ro on ro.id = c.relationship_owner_id
      left join users seat on seat.id = ${sql.raw(BOOK_OF_C)}
     where c.lead_converted_at is not null
       and c.handed_over_at is null
       ${leadsVisible(scope, BOOK_OF_C)}
     order by c.lead_converted_at asc, c.id asc
     limit ${limit}
  `);

  return {
    rows: rows.map((r) => ({
      customerId: r.customer_id,
      name: r.name,
      companyName: r.company_name,
      city: r.city,
      stage: r.stage,
      salesType: r.sales_type,
      convertedAt: asDate(r.converted_at),
      waitingDays: r.waiting_days === null ? null : Number(r.waiting_days),
      leadManagerId: r.lead_manager_id,
      leadManagerName: r.lead_manager_name,
      relationshipOwnerId: r.relationship_owner_id,
      relationshipOwnerName: r.relationship_owner_name,
      salesSeatName: r.sales_seat_name,
    })),
    total: rows.length ? Number(rows[0].total) : 0,
  };
}

/* ══════════════════════════════════════════════════ §28 the overrides */

/**
 * EVERY CONDITION ID THE GATES CAN REFUSE ON, in one map.
 *
 * `overridden_conditions` stores ids and the three ladders spell their own
 * lists, so the words come from the engine rather than from anything typed
 * into a screen — a second copy would drift inside one release and the half
 * that drifts is always the half somebody is reading. Ids repeat across the
 * ladders on purpose (`decision_maker` is asked on two of them and means the
 * same thing on both), so first-wins is not a collision being papered over: it
 * is one question with one sentence.
 *
 * An id that resolves to nothing is shown as the id, never dropped and never
 * guessed at. A condition retired from an engine still has rows pointing at
 * it, and "we let somebody past something we can no longer name" is a worse
 * answer than the bare id.
 */
const CONDITION_SAYS: ReadonlyMap<string, string> = new Map(
  [...PROSPECT_CONDITIONS, ...QUALIFICATION_CONDITIONS, ...DISTRIBUTOR_CONDITIONS]
    .map((c) => [c.id, c.says] as const)
    /* Reversed before the Map is built so the FIRST list wins rather than the
       last, which is what `new Map` would otherwise give. */
    .reverse(),
);

export function conditionSays(id: string): string {
  return CONDITION_SAYS.get(id) ?? id;
}

export type OverrideRow = {
  id: string;
  at: Date;
  customerId: string;
  customerName: string;
  city: string | null;
  fromStage: LeadStage | null;
  toStage: LeadStage;
  salesType: LeadSalesType | null;
  /** A code from `leads.overrideReasons`. Null where none was recorded. */
  reasonCode: string | null;
  note: string | null;
  actorId: string | null;
  actorName: string | null;
  /** Which hat allowed it. Null means NOT RECORDED, never "no role". */
  actorRole: string | null;
  actorApp: string | null;
  /** The condition ids the gate was refusing on when it was passed. */
  conditions: string[];
};

export type ConditionCount = { id: string; says: string; count: number };

/**
 * §28's escape hatch, read back.
 *
 * **It is not a shaming list, and the counts are why.** A manager passing a
 * gate is the rule surviving contact with a Tuesday — the alternative is not a
 * process that is followed, it is work recorded after the event by people who
 * have learned to route around a system that refuses everything, and a record
 * that says the process was followed when it was not is worse than an open
 * gate. What the log is FOR is the pattern: one condition shut on everybody,
 * every week, is not twenty people cutting corners, it is the wrong condition,
 * and nothing else in the product can tell you that.
 *
 * So the counts come from SQL over the whole window rather than from the rows
 * the screen happens to hold — a capped list counting itself would report the
 * shape of the page instead of the shape of the problem, which is precisely
 * the mistake the customer timeline's filter pills made.
 *
 * Non-empty `overridden_conditions` is the test rather than `kind`, because
 * that column is what §28 actually stores and a row that names nothing missing
 * is a move that passed a gate which was open.
 */
export async function overrideLog(
  { limit = 200 }: { limit?: number } = {},
): Promise<{ rows: OverrideRow[]; counts: ConditionCount[]; total: number }> {
  const scope = await managerScope();

  const visible = leadsVisible(scope, BOOK_OF_C);
  const nonEmpty = sql.raw(`coalesce(jsonb_array_length(t.overridden_conditions), 0) > 0`);

  const [rows, counts, totals] = await Promise.all([
    db.execute<{
      id: string;
      at: unknown;
      customer_id: string;
      customer_name: string;
      city: string | null;
      from_stage: LeadStage | null;
      to_stage: LeadStage;
      sales_type: LeadSalesType | null;
      reason_code: string | null;
      note: string | null;
      actor_id: string | null;
      actor_name: string | null;
      actor_role: string | null;
      actor_app: string | null;
      conditions: string[] | null;
    }>(sql`
      select t.id, t.at, t.customer_id, c.name as customer_name, c.city,
             t.from_stage, t.to_stage, t.sales_type,
             t.reason_code, t.note,
             t.actor_id, u.name as actor_name, t.actor_role, t.actor_app,
             t.overridden_conditions as conditions
        from lead_stage_transitions t
        join customers c on c.id = t.customer_id
        left join users u on u.id = t.actor_id
       where ${nonEmpty}
         ${visible}
       order by t.at desc, t.id desc
       limit ${limit}
    `),

    db.execute<{ condition_id: string; n: number }>(sql`
      select cond.condition_id, count(*)::int as n
        from lead_stage_transitions t
        join customers c on c.id = t.customer_id
        cross join lateral jsonb_array_elements_text(t.overridden_conditions) as cond(condition_id)
       where ${nonEmpty}
         ${visible}
       group by cond.condition_id
       order by n desc, cond.condition_id asc
    `),

    db.execute<{ total: number }>(sql`
      select count(*)::int as total
        from lead_stage_transitions t
        join customers c on c.id = t.customer_id
       where ${nonEmpty}
         ${visible}
    `),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      at: asDate(r.at) ?? new Date(0),
      customerId: r.customer_id,
      customerName: r.customer_name,
      city: r.city,
      fromStage: r.from_stage,
      toStage: r.to_stage,
      salesType: r.sales_type,
      reasonCode: r.reason_code,
      note: r.note,
      actorId: r.actor_id,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      actorApp: r.actor_app,
      conditions: r.conditions ?? [],
    })),
    counts: counts.map((c) => ({
      id: c.condition_id,
      says: conditionSays(c.condition_id),
      count: Number(c.n),
    })),
    total: totals.length ? Number(totals[0].total) : 0,
  };
}

/* ═══════════════════════════════════════════ the funnel's own audit trail */

export type LeadAuditRow = {
  id: string;
  at: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: string | null;
  actorName: string | null;
  /**
   * WHICH HAT ALLOWED IT, and it takes both of these.
   *
   * Null means NOT RECORDED — every row that predates the column, and anything
   * written outside a capability check. It is emphatically not "no role": a
   * write with no hat behind it is not a thing this product can produce, and a
   * screen that rendered the absence as an answer would be inventing one.
   */
  actorRole: string | null;
  actorApp: string | null;
  /** The account behind it, where the row names one a person would recognise. */
  subject: string | null;
  subjectCustomerId: string | null;
};

export type AuditCursor = { at: string; id: string };

/**
 * WHAT COUNTS AS THE FUNNEL'S OWN, and why it is a prefix rather than a list.
 *
 * `accountsAudit` names its twelve actions one at a time, and that is right
 * there: the accounts desk's actions come from six different files and share
 * no naming, so the list IS the definition. Here the opposite holds — every
 * audited write in `actions/leads.ts`, `actions/lead-samples.ts` and
 * `actions/distributor-appointment.ts` already names itself `lead.*`,
 * `sample.*` or `distributor.*`, so a hand-typed copy of those names would be
 * a second definition that silently loses the fourteenth action the day
 * somebody adds it. A screen that quietly stops showing a category is the one
 * failure an audit trail may not have.
 *
 * `customer.handOver` is the one that has to be named, and it is named because
 * it is genuinely not the funnel's: §Q's seat is a fact about a customer, so
 * the action is spelled the way the customer capabilities are. Leaving it out
 * would take the end of the funnel off the record of the funnel.
 */
const FUNNEL_ACTION = sql.raw(
  `(a.action like 'lead.%'
     or a.action like 'sample.%'
     or a.action like 'distributor.%'
     or a.action = 'customer.handOver')`,
);

/**
 * The audit trail, paged with a keyset and a tiebreaker.
 *
 * `order by at desc` alone leaves rows sharing a second to the planner, which
 * is invisible until it is paged and is then a row appearing on two pages
 * while another appears on none. The sort is `(at, id) desc` and the cursor is
 * the pair, which is the discipline the customer timeline learned under load.
 *
 * **Narrowed two ways, and a row that satisfies either is shown.** An audited
 * row is visible when the account behind it is in your book, OR when you or
 * one of your people did it. One clause alone is wrong in both directions: by
 * account only, a manager cannot see what his own salesman did to somebody
 * else's shop; by actor only, he cannot see what was done to his book by the
 * office. A national scope has neither clause and sees everything, which is
 * what `managerScope` answering `null` means.
 */
export async function leadAudit(
  { limit = 50, cursor }: { limit?: number; cursor?: AuditCursor | null } = {},
): Promise<{ rows: LeadAuditRow[]; nextCursor: AuditCursor | null; total: number }> {
  const scope = await managerScope();

  /* Either seat: the book the subject sits in, or the person who acted. Both
     vanish for a national scope, which is what `sql``` renders as. */
  const byBook = leadsVisible(scope, BOOK_OF_C);
  const byActor = onlyMine(scope, "a.actor_id");
  const narrowing =
    scope.salesmanIds === null
      ? sql``
      : /*
         * The book half is asked only where there IS a book to ask about.
         * `leadsVisible` carries an `is null` arm on purpose — an account
         * nobody is working belongs on a manager's list rather than nowhere —
         * and without `c.id is not null` in front of it every row that names no
         * account at all would satisfy that arm and be shown to everybody. A
         * distributor's own salesman is such a row. Those fall to the actor
         * clause instead, which is the honest answer: you see it if one of
         * your people did it.
         */
        sql`and ((c.id is not null ${byBook}) or (true ${byActor}))`;

  /*
   * A DATE IS NEVER BOUND AS A `Date`. The driver serialises one by asking
   * Node to render it as text, which throws inside itself on Node 25, where no
   * type check can see it — and the whole query fails rather than the
   * parameter. The cursor travels as an ISO string with its cast said out
   * loud.
   */
  const after = cursor
    ? sql`and (a.at, a.id) < (${cursor.at}::timestamptz, ${cursor.id})`
    : sql``;

  const [rows, totals] = await Promise.all([
    db.execute<{
      id: string;
      at: unknown;
      action: string;
      entity_type: string;
      entity_id: string | null;
      actor_id: string | null;
      actor_name: string | null;
      actor_role: string | null;
      actor_app: string | null;
      subject: string | null;
      subject_id: string | null;
    }>(sql`
      select a.id, a.at, a.action, a.entity_type, a.entity_id,
             a.actor_id, u.name as actor_name,
             a.actor_role::text as actor_role,
             a.actor_app::text as actor_app,
             c.name as subject, c.id as subject_id
        from audit_log a
        left join users u on u.id = a.actor_id
        left join customers c
               on c.id = coalesce(
                    case when a.entity_type in ('customer', 'customers')
                         then a.entity_id end,
                    (select s.customer_id from mbos_samples s
                      where a.entity_type = 'mbos_samples' and s.id = a.entity_id),
                    (select d.customer_id from distributor_profiles d
                      where a.entity_type = 'distributor_profiles' and d.id = a.entity_id)
                  )
       where ${FUNNEL_ACTION}
         ${narrowing}
         ${after}
       order by a.at desc, a.id desc
       limit ${limit + 1}
    `),

    db.execute<{ total: number }>(sql`
      select count(*)::int as total
        from audit_log a
        left join customers c
               on c.id = coalesce(
                    case when a.entity_type in ('customer', 'customers')
                         then a.entity_id end,
                    (select s.customer_id from mbos_samples s
                      where a.entity_type = 'mbos_samples' and s.id = a.entity_id),
                    (select d.customer_id from distributor_profiles d
                      where a.entity_type = 'distributor_profiles' and d.id = a.entity_id)
                  )
       where ${FUNNEL_ACTION}
         ${narrowing}
    `),
  ]);

  /* One row past the page is how the screen knows there is a next one without
     a second count. It is dropped rather than drawn. */
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? { at: (asDate(last.at) ?? new Date(0)).toISOString(), id: last.id }
      : null;

  return {
    rows: page.map((r) => ({
      id: r.id,
      at: asDate(r.at) ?? new Date(0),
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      actorApp: r.actor_app,
      subject: r.subject,
      subjectCustomerId: r.subject_id,
    })),
    nextCursor,
    total: totals.length ? Number(totals[0].total) : 0,
  };
}

/* ══════════════════════════════════════════════════ the thresholds in force */

/**
 * The seventeen keys this workspace runs on.
 *
 * Eleven `leads.*` and six `mbos.leads.*`, which is the split the registry
 * already draws: the first are read at a desk by the gate engine and the
 * services around it, the second ride down the wire and are read on a handset
 * in a shop. They are listed together because somebody asking "what is the
 * suspect cap" does not know which of the two runtimes answers them, and a
 * screen that made them find out first would be a screen they ask somebody
 * else instead.
 *
 * It is a PREFIX rather than a typed list of seventeen, for the same reason
 * the audit actions are: the eighteenth key is added to the registry and
 * belongs on this screen the moment it exists, and a list here would be the
 * thing nobody remembers to update.
 */
export type ThresholdRow = {
  key: string;
  label: string;
  description: string;
  type: SettingRow["type"];
  value: unknown;
  /** Still the shipped default — nobody has chosen this. */
  isDefault: boolean;
  changedAt: Date | null;
  /**
   * Who last changed it, where the stored row names somebody who still has an
   * account. Null is the honest answer and the screen says nothing rather than
   * naming an author it does not have.
   */
  changedByName: string | null;
};

export async function leadThresholds(): Promise<{
  office: ThresholdRow[];
  handset: ThresholdRow[];
}> {
  const all = await listSettings();
  const mine = all.filter(
    (s) => s.key.startsWith("leads.") || s.key.startsWith("mbos.leads."),
  );

  /*
   * The author is resolved here rather than by `listSettings`, which answers
   * with an id because most of its callers are writing a form rather than
   * reading a history. An id on a screen is not an answer to "who changed
   * this".
   */
  const ids = [...new Set(mine.map((s) => s.updatedById).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    const people = await db.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from users u
       where u.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `);
    for (const p of people) names.set(p.id, p.name);
  }

  const shape = (s: (typeof mine)[number]): ThresholdRow => ({
    key: s.key,
    label: s.label,
    description: s.description,
    type: s.type,
    value: s.value,
    isDefault: s.isDefault,
    /*
     * A default carries no author and no date. `app_settings` stamps
     * `updated_at` on the row that seeded it, so printing that beside a value
     * nobody chose would read as somebody having decided it — which is the one
     * thing this screen must not say about a placeholder.
     */
    changedAt: s.isDefault ? null : asDate(s.updatedAt),
    changedByName: s.isDefault || !s.updatedById ? null : (names.get(s.updatedById) ?? null),
  });

  return {
    office: mine.filter((s) => s.key.startsWith("leads.")).map(shape),
    handset: mine.filter((s) => s.key.startsWith("mbos.leads.")).map(shape),
  };
}
