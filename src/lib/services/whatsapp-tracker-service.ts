import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, waAutomationRuns, waMessages, waTemplates } from "@/db/schema";
import { resolveScope, scopedToUsers, scopedUserIds } from "../access-control";
import { APP_TIMEZONE, asDate } from "../business-date";
import type { TrackedMessage } from "../whatsapp-status";
import { ruleClock } from "../wati-templates";
import { describeRule } from "../whatsapp-rules";
import { factsFor } from "./wati-facts-service";
import { listRules } from "./whatsapp-automation-service";

/* ---------------------------------------------------------------------------
 * The WhatsApp message tracker: what went to whom, how far it got — sent,
 * delivered, read, replied — who or which rule sent it, and which rule will
 * reach the customer next. Read by the collections worklist, the payment
 * panel, the customer record and the founder's Messages tab, so every screen
 * tells the same story about one message.
 *
 * Every timestamp here was written by WhatsApp through the webhook (delivered,
 * read, failed), by the send (sent), by a person (confirmed), or by the
 * customer (a reply). Nothing is inferred.
 * ------------------------------------------------------------------------- */

export type TrackerRow = TrackedMessage & {
  id: string;
  customerId: string;
  customerName: string;
  templateName: string | null;
  destination: string;
  destKind: string;
  /**
   * The words exactly as they went — after the merge, after any edit. A
   * telecaller about to ring somebody has to know what the customer has
   * already been told, and "Payment reminder (stage 2)" does not say it.
   */
  body: string;
  /** "Rule: Payment follow-up" or the person's name. */
  sentBy: string;
  viaRule: boolean;
};

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = asDate(v);
  return d ? d.toISOString() : null;
};

type RawRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  template_name: string | null;
  status: string;
  mode: string;
  resolved_destination: string;
  dest_kind: string;
  body: string;
  prepared_at: unknown;
  sent_at: unknown;
  confirmed_sent_at: unknown;
  delivered_at: unknown;
  read_at: unknown;
  failure_reason: string | null;
  trigger_id: string | null;
  user_name: string | null;
  replied_at: unknown;
};

function toRow(r: RawRow): TrackerRow {
  return {
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    templateName: r.template_name,
    status: r.status,
    mode: r.mode,
    destination: r.resolved_destination,
    destKind: r.dest_kind,
    body: r.body,
    preparedAt: iso(r.prepared_at)!,
    sentAt: iso(r.sent_at),
    confirmedSentAt: iso(r.confirmed_sent_at),
    deliveredAt: iso(r.delivered_at),
    readAt: iso(r.read_at),
    failureReason: r.failure_reason,
    repliedAt: iso(r.replied_at),
    sentBy: r.trigger_id ? `Automatic rule` : (r.user_name ?? "—"),
    viaRule: Boolean(r.trigger_id),
  };
}

/** The columns every read here selects, and the reply that came after. */
const SELECT = sql`
  select m.id, m.customer_id, c.name as customer_name, m.template_name, m.status, m.mode,
         m.resolved_destination, m.dest_kind, m.body, m.prepared_at, m.sent_at, m.confirmed_sent_at,
         m.delivered_at, m.read_at, m.failure_reason, m.trigger_id,
         u.name as user_name,
         (select min(r.received_at) from wa_replies r
           where r.customer_id = m.customer_id
             and r.received_at > coalesce(m.sent_at, m.confirmed_sent_at, m.prepared_at)) as replied_at
    from wa_messages m
    join customers c on c.id = m.customer_id
    left join users u on u.id = m.user_id
`;

/** The newest message to each of these customers that got further than a draft. */
export async function latestMessageFor(customerIds: string[]): Promise<Record<string, TrackerRow>> {
  if (!customerIds.length) return {};
  const rows = await db.execute<RawRow>(sql`
    select distinct on (x.customer_id) x.* from (${SELECT}
      where m.customer_id in (${sql.join(customerIds.map((id) => sql`${id}`), sql`, `)})
        and m.status not in ('prepared', 'cancelled')
    ) x
    order by x.customer_id, x.prepared_at desc
  `);
  return Object.fromEntries(rows.map((r) => [r.customer_id, toRow(r)]));
}

/** One customer's messages, newest first, with every receipt. */
export async function messagesForCustomer(customerId: string, limit = 25): Promise<TrackerRow[]> {
  const rows = await db.execute<RawRow>(sql`
    ${SELECT}
    where m.customer_id = ${customerId} and m.status <> 'prepared'
    order by m.prepared_at desc
    limit ${limit}
  `);
  return rows.map(toRow);
}

export type RuleOutlook = {
  ruleId: string;
  templateName: string;
  status: "off" | "preview" | "live";
  sentence: string;
  /** Where this customer stands on the rule's clock today, if it applies at all. */
  day: number | null;
  /** In words: inside the range now, or when it would start, or why not. */
  verdict: string;
  inRange: boolean;
};

/**
 * Which automation rules could reach this customer, and where they stand —
 * the "why did they get that message / will they get one" answer, shown to
 * the telecaller beside the conversation. Informational: the runner decides.
 */
export async function ruleOutlookFor(customerId: string, kind?: "payment" | "order"): Promise<RuleOutlook[]> {
  const [facts, rules] = await Promise.all([factsFor(customerId), listRules()]);
  if (!facts) return [];
  return rules
    .filter((r) => r.spec && (!kind || r.kind === kind))
    .map((r) => {
      const clock = ruleClock(r.kind, facts);
      const unit = r.kind === "payment" ? "days overdue" : "days from the expected order date";
      let verdict: string;
      let inRange = false;
      if (!clock) {
        verdict = r.kind === "payment" ? "Nothing overdue — this rule does not apply." : "No measured buying cycle — this rule does not apply.";
      } else if (clock.day < r.fromDay) {
        verdict = `At ${clock.day} ${unit}; it starts at ${r.fromDay}, in ${r.fromDay - clock.day} day${r.fromDay - clock.day === 1 ? "" : "s"}.`;
      } else if (r.toDay !== null && clock.day > r.toDay) {
        verdict = `At ${clock.day} ${unit} — past this rule's range (ends at ${r.toDay}).`;
      } else {
        inRange = true;
        verdict = `At ${clock.day} ${unit} — inside this rule's range.`;
      }
      return {
        ruleId: r.id,
        templateName: r.templateName,
        status: r.status,
        sentence: describeRule(r),
        day: clock?.day ?? null,
        verdict,
        inRange,
      };
    });
}

/* ------------------------------------------- the collections screen's day */

export type ReminderDay = {
  /** Every payment reminder that got further than a draft on this day. */
  total: number;
  /** Sent by one of the founder's automatic rules. */
  byRule: number;
  /** Sent by a person, through the API or pasted by hand. */
  byPerson: number;
  /** WhatsApp says it reached the phone (delivered or read). */
  delivered: number;
  read: number;
  failed: number;
  /** Copied to paste and never confirmed — may or may not have gone. */
  unconfirmed: number;
  /** Customers who wrote back after one of these. */
  replied: number;
  /** Distinct customers reached. */
  customers: number;
};

export type ReminderSummary = {
  today: ReminderDay;
  yesterday: ReminderDay;
  /**
   * The newest pass of the automatic runner, whatever it decided. "Did the
   * triggers go out today" is first a question of whether the runner RAN —
   * zero rule-sent messages after a run is a different fact from zero
   * because nothing ran.
   */
  lastRun: { at: string; dry: boolean } | null;
  /**
   * The newest pass that actually SENT. The runner alternates — a live pass,
   * then preview passes — so the newest run alone would read "nothing sent"
   * an hour after it sent a hundred.
   */
  lastSendingRun: { at: string } | null;
};

/**
 * Today's and yesterday's PAYMENT reminders over this person's book — the
 * worklist's own scope, so a telecaller's strip and the rows beneath it are
 * about the same customers. A payment reminder is a message written from a
 * `payment_reminder` template; that is the column that says so, rather than
 * guessing from a rule's kind or a template's name.
 *
 * A message belongs to the day it WENT, not the day it was drafted, so the
 * date is `sent_at`, then the person's confirmation, then the draft — with the
 * zone named, because a bare cast reads it in the session's zone.
 */
export async function paymentReminderSummary(day: string, yesterday: string): Promise<ReminderSummary> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const wentAt = sql`coalesce(${waMessages.sentAt}, ${waMessages.confirmedSentAt}, ${waMessages.preparedAt})`;
  // The zone as a LITERAL, not a bind parameter: the same expression is
  // selected and grouped on, and Postgres cannot tell that `$1` and `$9` are
  // the same zone, so it refuses the GROUP BY.
  const wentOn = sql`(${wentAt} at time zone ${sql.raw(`'${APP_TIMEZONE}'`)})::date`;

  const [rows, runs, sendingRuns] = await Promise.all([
    db
      .select({
        day: sql<string>`${wentOn}::text`,
        total: sql<number>`count(*)::int`,
        byRule: sql<number>`count(*) filter (where ${waMessages.triggerId} is not null)::int`,
        delivered: sql<number>`count(*) filter (where ${waMessages.status} in ('delivered','read'))::int`,
        read: sql<number>`count(*) filter (where ${waMessages.status} = 'read')::int`,
        failed: sql<number>`count(*) filter (where ${waMessages.status} = 'failed')::int`,
        unconfirmed: sql<number>`count(*) filter (where ${waMessages.status} = 'copied')::int`,
        // Outer columns spelled out: inside a correlated subquery Drizzle's
        // bare "customer_id" would bind to the reply, and match everything.
        replied: sql<number>`count(distinct wa_messages.customer_id) filter (where exists (
          select 1 from wa_replies r where r.customer_id = wa_messages.customer_id
             and r.received_at > coalesce(wa_messages.sent_at, wa_messages.confirmed_sent_at, wa_messages.prepared_at)))::int`,
        customers: sql<number>`count(distinct ${waMessages.customerId})::int`,
      })
      .from(waMessages)
      .innerJoin(customers, eq(customers.id, waMessages.customerId))
      .innerJoin(waTemplates, eq(waTemplates.id, waMessages.templateId))
      .where(
        and(
          scopedToUsers(ids),
          eq(waTemplates.category, "payment_reminder"),
          inArray(waMessages.status, ["copied", "queued", "sent", "sent_manually", "delivered", "read", "failed"]),
          sql`${wentOn} in (${day}::date, ${yesterday}::date)`,
        ),
      )
      .groupBy(wentOn),
    db
      .select({ at: waAutomationRuns.startedAt, dry: waAutomationRuns.dry })
      .from(waAutomationRuns)
      .where(isNotNull(waAutomationRuns.finishedAt))
      .orderBy(desc(waAutomationRuns.startedAt))
      .limit(1),
    db
      .select({ at: waAutomationRuns.startedAt })
      .from(waAutomationRuns)
      .where(and(isNotNull(waAutomationRuns.finishedAt), eq(waAutomationRuns.dry, false)))
      .orderBy(desc(waAutomationRuns.startedAt))
      .limit(1),
  ]);

  const empty: ReminderDay = { total: 0, byRule: 0, byPerson: 0, delivered: 0, read: 0, failed: 0, unconfirmed: 0, replied: 0, customers: 0 };
  const pick = (d: string): ReminderDay => {
    const r = rows.find((x) => x.day === d);
    if (!r) return empty;
    const n = (v: unknown) => Number(v) || 0;
    return {
      total: n(r.total),
      byRule: n(r.byRule),
      byPerson: n(r.total) - n(r.byRule),
      delivered: n(r.delivered),
      read: n(r.read),
      failed: n(r.failed),
      unconfirmed: n(r.unconfirmed),
      replied: n(r.replied),
      customers: n(r.customers),
    };
  };
  const run = runs[0];
  return {
    today: pick(day),
    yesterday: pick(yesterday),
    lastRun: run ? { at: iso(run.at)!, dry: run.dry } : null,
    lastSendingRun: sendingRuns[0] ? { at: iso(sendingRuns[0].at)! } : null,
  };
}

/* ------------------------------------------------------ the founder's tracker */

export type TrackerFilters = {
  days: number;
  status?: string;
  source?: "rule" | "person";
  template?: string;
  q?: string;
};

export async function trackerPage(f: TrackerFilters, limit = 200) {
  const where = sql`
    m.prepared_at > now() - make_interval(days => ${f.days}::int)
    and m.status <> 'prepared'
    ${f.status ? sql`and m.status = ${f.status}` : sql``}
    ${f.source === "rule" ? sql`and m.trigger_id is not null` : f.source === "person" ? sql`and m.trigger_id is null` : sql``}
    ${f.template ? sql`and m.template_name = ${f.template}` : sql``}
    ${f.q ? sql`and c.name ilike ${"%" + f.q.replace(/[%_]/g, "") + "%"}` : sql``}
  `;
  const [rows, funnel, templates] = await Promise.all([
    db.execute<RawRow>(sql`${SELECT} where ${where} order by m.prepared_at desc limit ${limit}`),
    db.execute<{ total: number; reached: number; api: number; delivered: number; read: number; failed: number; replied: number }>(sql`
      select count(*)::int as total,
             count(*) filter (where m.status in ('sent','sent_manually','delivered','read'))::int as reached,
             count(*) filter (where m.mode = 'automatic' and m.status in ('sent','delivered','read','failed'))::int as api,
             count(*) filter (where m.status in ('delivered','read'))::int as delivered,
             count(*) filter (where m.status = 'read')::int as read,
             count(*) filter (where m.status = 'failed')::int as failed,
             count(*) filter (where exists (
               select 1 from wa_replies r where r.customer_id = m.customer_id
                and r.received_at > coalesce(m.sent_at, m.confirmed_sent_at, m.prepared_at)
                and r.received_at < coalesce(m.sent_at, m.confirmed_sent_at, m.prepared_at) + interval '3 days'
             ))::int as replied
        from wa_messages m join customers c on c.id = m.customer_id
       where ${where}
    `),
    db.execute<{ name: string }>(sql`
      select distinct m.template_name as name from wa_messages m
       where m.template_name is not null and m.prepared_at > now() - interval '90 days'
       order by 1
    `),
  ]);
  const n = funnel[0] ?? { total: 0, reached: 0, api: 0, delivered: 0, read: 0, failed: 0, replied: 0 };
  return {
    rows: rows.map(toRow),
    funnel: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Number(v)])) as typeof n,
    templates: templates.map((t) => t.name),
    capped: rows.length >= limit,
  };
}
