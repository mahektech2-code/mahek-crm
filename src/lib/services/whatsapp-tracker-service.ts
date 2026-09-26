import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { asDate } from "../business-date";
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
         m.resolved_destination, m.dest_kind, m.prepared_at, m.sent_at, m.confirmed_sent_at,
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
