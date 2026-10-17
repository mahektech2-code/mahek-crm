import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import {
  addDays,
  addMonths,
  APP_TIMEZONE,
  endOfMonth,
  monthKey,
  previousWorkingDay,
  type BusinessDate,
} from "@/lib/business-date";
import { eodMetricsForRange } from "@/lib/services/eod-service";
import { heldSentence, paymentCallsDueToday, telecallerQueue, type TelecallerQueue } from "../view-as";
import {
  auditFor,
  notesFor,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { fmtDay, monthShort, num, plural, span } from "../format";
import type { ActSpec, Bar, FigureDrawer, Metric, RecordView, Row, TableDef, TablePage, Tone } from "../types";

/* ---------------------------------------------------------------------------
 * CALLING (PRD §13) — the telecallers' day, company-wide.
 *
 * A telecaller is an active person holding the CRM at the associate level —
 * the same definition the People section counts. Each one's queue is the Call
 * Log's own pipeline for their book (`telecallerQueue`, which runs
 * `queueCandidatesFor` and `buildQueue` over the day's settled list and
 * writes nothing); their calls and orders are `eodMetricsForRange`, the
 * figures their own dashboard and EOD report print.
 *
 * "Queues worked" is the sum of those per-person queues rather than
 * `queueProgress()`: that function settles a list under the REQUESTING user,
 * so asked from here it would build and store a company-wide list under the
 * founder's name — a list nobody works — and count the book of every
 * salesman and manager in a figure about the calling team.
 * ------------------------------------------------------------------------- */

const IST = sql.raw(`at time zone '${APP_TIMEZONE}'`);
const SCOPE = "Company-wide · every telecaller";

const VIEW_AS: ActSpec = { key: "viewAs", label: "View as", done: "Viewed", viewAs: true };

const TEAM_DEF: TableDef = {
  key: "team",
  title: "The telecallers today",
  hint: "Now · click a person to see their call log exactly as they do",
  // role-name-ok: the job title on screen, not a stored role
  noun: "telecaller",
  // role-name-ok: the job title on screen, not a stored role
  rec: "Telecaller",
  acts: [VIEW_AS],
  actW: "110px",
  cols: [
    // role-name-ok: the job title on screen, not a stored role
    ["Telecaller", "1.4fr"],
    ["Queue", "0.8fr", true],
    ["Calls", "0.6fr", true],
    ["Connected", "0.8fr", true],
    ["Orders", "0.6fr", true],
    ["Overdue", "0.8fr", true],
    ["EOD", "0.8fr"],
  ],
};

const OUTCOME: Record<string, string> = {
  order_taken: "Order taken",
  no_order: "No order",
  no_answer: "No answer",
  payment_promised: "Payment promised",
  follow_up: "Follow-up agreed",
  not_interested: "Not interested",
  complaint: "Complaint raised",
  transport_follow_up: "Transport follow-up",
  casual_talk: "General conversation",
};

const TYPE: Record<string, string> = {
  outbound_call: "Called",
  inbound_call: "Customer called in",
  order_received: "Order received without a call",
};

const CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function clock(at: Date | string | null | undefined): string {
  if (!at) return "—";
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : CLOCK.format(d);
}

/* ------------------------------------------------------------ the telecallers */

type Base = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  overdue: number;
  due_today: number;
  eod_at: string | null;
  eod_auto: boolean | null;
  last_call: string | null;
};

type Teller = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  queue: TelecallerQueue;
  attempted: number;
  connected: number;
  inbound: number;
  orders: number;
  overdue: number;
  dueToday: number;
  eodSent: boolean;
  eodAuto: boolean;
  eodAt: string | null;
  lastCall: string | null;
};

async function eodDay(day: BusinessDate): Promise<BusinessDate> {
  const config = await getConfig();
  return previousWorkingDay(day, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
}

/** Active CRM associates — the calling team. */
async function telecallerBase(day: BusinessDate, eodOn: BusinessDate): Promise<Base[]> {
  return db.execute<Base>(sql`
    select u.id, u.name, u.email, u.phone,
           (select count(*)::int from reminders r
             where r.assigned_user_id = u.id and r.status = 'pending'
               and r.due_date < ${day}::date) as overdue,
           (select count(*)::int from reminders r
             where r.assigned_user_id = u.id and r.status = 'pending'
               and r.due_date = ${day}::date) as due_today,
           e.finalised_at as eod_at, e.auto_generated as eod_auto,
           (select max(c.started_at) from calls c where c.user_id = u.id
             and (c.started_at ${IST})::date = ${day}::date) as last_call
      from users u
      join app_access a on a.user_id = u.id and a.app = 'crm'
      left join eod_reports e on e.user_id = u.id and e.day = ${eodOn}::date
     where u.active and coalesce(a.role, u.role) = 'associate'
     order by u.name asc
  `) as unknown as Promise<Base[]>;
}

async function tellersToday(day: BusinessDate): Promise<{ tellers: Teller[]; eodOn: BusinessDate }> {
  const eodOn = await eodDay(day);
  const [base, paymentDue] = await Promise.all([telecallerBase(day, eodOn), paymentCallsDueToday()]);
  const tellers = await Promise.all(
    base.map(async (b) => {
      const [queue, m] = await Promise.all([
        telecallerQueue(b.id, { day, paymentDue }),
        eodMetricsForRange(b.id, { from: day, to: day }),
      ]);
      return {
        id: b.id,
        name: b.name,
        email: b.email,
        phone: b.phone,
        queue,
        attempted: m.callsAttempted,
        connected: m.callsConnected,
        inbound: m.callsInbound,
        orders: m.ordersCaptured,
        overdue: Number(b.overdue),
        dueToday: Number(b.due_today),
        eodSent: !!b.eod_at && !b.eod_auto,
        eodAuto: !!b.eod_auto,
        eodAt: b.eod_at,
        lastCall: b.last_call,
      } satisfies Teller;
    }),
  );
  return { tellers, eodOn };
}

function pct(n: number, d: number): number {
  return d ? Math.round((n / d) * 100) : 0;
}

function eodCell(t: Teller): { t: string; sub?: string; pill: Tone } {
  if (t.eodSent) return { t: "Sent", pill: "good" };
  if (t.eodAuto) return { t: "Not sent", sub: "the system wrote one", pill: t.overdue > 5 ? "bad" : "warn" };
  return { t: "Not sent", pill: t.overdue > 5 ? "bad" : "warn" };
}

function tellerRow(t: Teller): Row {
  return {
    id: t.id,
    cells: [
      { t: t.name, sub: t.lastCall ? `last call ${clock(t.lastCall)}` : "no call yet today" },
      { t: num(t.queue.stillToWork), sub: `${num(t.queue.worked)} worked` },
      { t: num(t.attempted + t.inbound) },
      { t: t.attempted ? `${pct(t.connected, t.attempted)}%` : "—" },
      { t: num(t.orders) },
      { t: num(t.overdue), ...(t.overdue > 5 ? { pill: "bad" as Tone } : t.overdue ? { pill: "warn" as Tone } : {}) },
      eodCell(t),
    ],
  };
}

function tellerPage(tellers: Teller[], query: TableQuery): TablePage {
  const s = slice(tellers, query, (t, q) => `${t.name} ${t.email}`.toLowerCase().includes(q));
  return { rows: s.rows.map(tellerRow), count: s.count, total: s.total, page: s.page, size: query.size, q: query.q };
}

/* --------------------------------------------------------------- counts */

async function remindersOverdue(day: BusinessDate): Promise<number> {
  const [r] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from reminders r
     where r.status = 'pending' and r.due_date < ${day}::date
  `);
  return Number(r?.n ?? 0);
}

async function assistantUse(from: string, to: string) {
  const [r] = await db.execute<{ suggested: number; applied: number }>(sql`
    select count(*) filter (where d.suggested_outcome is not null)::int as suggested,
           count(*) filter (where d.suggested_outcome is not null and d.applied_outcome is not null)::int as applied
      from call_ai_drafts d
     where d.channel = 'call'
       and (d.created_at ${IST})::date between ${from}::date and ${to}::date
  `);
  return { suggested: Number(r?.suggested ?? 0), applied: Number(r?.applied ?? 0) };
}

/* ------------------------------------------------------------- section */

async function section(ctx: Ctx) {
  const day = ctx.period.today as BusinessDate;
  const [{ tellers, eodOn }, overdue, ai] = await Promise.all([
    tellersToday(day),
    remindersOverdue(day),
    assistantUse(ctx.period.from, ctx.period.to),
  ]);
  const n = tellers.length;
  const calls = tellers.reduce((s, t) => s + t.attempted + t.inbound, 0);
  const attempted = tellers.reduce((s, t) => s + t.attempted, 0);
  const connected = tellers.reduce((s, t) => s + t.connected, 0);
  const worked = tellers.reduce((s, t) => s + t.queue.worked, 0);
  const total = tellers.reduce((s, t) => s + t.queue.total, 0);
  const eodSent = tellers.filter((t) => t.eodSent).length;

  const metrics: Metric[] = [
    {
      key: "callsToday",
      label: "Calls today",
      value: num(calls),
      sub: n
        // role-name-ok: the job title on screen, not a stored role
        ? `${plural(n, "telecaller")}${attempted ? ` · ${pct(connected, attempted)}% connected` : " · nobody has dialled yet"}`
        : "nobody holds the CRM as a telecaller",
      kind: "Now",
    },
    {
      key: "queuesWorked",
      label: "Queues worked",
      value: total ? `${pct(worked, total)}%` : "None yet",
      sub: total ? `${num(worked)} of ${plural(total, "customer")}` : "no customer on any list today",
      kind: "Now",
      tone: total && worked < total ? "warn" : total ? "good" : undefined,
    },
    {
      key: "remindersOverdue",
      label: "Reminders overdue",
      value: num(overdue),
      sub: "across the team",
      kind: "Now",
      tone: overdue ? "bad" : "good",
    },
    {
      key: "eod",
      label: "EOD reports",
      value: n ? `${num(eodSent)} of ${num(n)}` : "None yet",
      sub: `for ${fmtDay(eodOn).replace(/^0/, "")}`,
      kind: "Now",
      tone: n && eodSent < n ? "warn" : n ? "good" : undefined,
    },
    {
      key: "assistant",
      label: "Assistant used",
      value: ai.suggested ? `${pct(ai.applied, ai.suggested)}%` : "None yet",
      sub: ai.suggested
        ? `of ${plural(ai.suggested, "suggested outcome")} used`
        : "no suggestion made in this period",
      kind: "Period",
    },
  ];

  return {
    metrics,
    callouts: [],
    tables: [withPage(TEAM_DEF, tellerPage(tellers, { q: "", page: 1, size: 25 }))],
    foot: "Viewing as a person is read-only. Anything you do from there is done as you.",
  };
}

/* -------------------------------------------------------------- figure */

function days12(day: string): string[] {
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) out.push(addDays(day as BusinessDate, -i));
  return out;
}

function months12(day: string): string[] {
  const k = monthKey(day as BusinessDate);
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) out.push(addMonths(k, -i));
  return out;
}

function bars<T extends string>(keys: T[], val: (k: T) => number, tip: (k: T, v: number) => string): Bar[] {
  return keys.map((k, i) => {
    const v = val(k);
    return { h: v, tip: tip(k, v), ...(i === keys.length - 1 ? { current: true } : {}) };
  });
}

const TELLERS_SQL = sql`
  select u.id from users u
    join app_access a on a.user_id = u.id and a.app = 'crm'
   where coalesce(a.role, u.role) = 'associate'
`;

async function figure(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const day = ctx.period.today as BusinessDate;
  const asOf = stampIST(new Date());
  const base = { section: "calling" as const, sectionLabel: "Calling" };
  const nowFacts = (basis: string, source: string) => [
    { label: "Kind", value: "Now — today so far, whatever the period" },
    { label: "As of", value: asOf },
    { label: "Basis", value: basis },
    { label: "Scope", value: SCOPE },
    { label: "Source", value: source },
  ];

  if (metric === "callsToday") {
    const days = days12(day);
    const [{ tellers }, hist] = await Promise.all([
      tellersToday(day),
      db.execute<{ d: string; n: string }>(sql`
        select (c.started_at ${IST})::date::text as d, count(*)::bigint as n from calls c
         where c.interaction_type in ('outbound_call', 'inbound_call')
           and c.user_id in (${TELLERS_SQL})
           and (c.started_at ${IST})::date between ${days[0]}::date and ${day}::date
         group by 1`),
    ]);
    const m = new Map(hist.map((h) => [h.d, Number(h.n)]));
    const calls = tellers.reduce((s, t) => s + t.attempted + t.inbound, 0);
    const att = tellers.reduce((s, t) => s + t.attempted, 0);
    const con = tellers.reduce((s, t) => s + t.connected, 0);
    return {
      kind: "Now figure · Calls",
      title: "Calls today",
      value: num(calls),
      facts: nowFacts(
        `${num(att)} dialled, ${num(con)} connected · ${num(calls - att)} came in`,
        "Calls logged in the CRM, as each telecaller's EOD report counts them",
      ),
      def: "Every call logged today by every telecaller, connected or not — calls they dialled and calls customers made to them. An order that arrived without a call is not a call. Connected is the share of dialled calls that were answered.",
      bars: bars(days, (d) => m.get(d) ?? 0, (d, v) => `${fmtDay(d)} · ${num(v)}`),
      barsLabel: "Calls logged by telecallers on each of the last 12 days",
      rowsLabel: "Telecallers by calls today",
      rows: [...tellers]
        .sort((a, b) => b.attempted + b.inbound - (a.attempted + a.inbound))
        .slice(0, 8)
        .map((t) => ({
          a: t.name,
          b: t.attempted ? `${pct(t.connected, t.attempted)}% connected` : "nothing dialled yet",
          c: num(t.attempted + t.inbound),
        })),
      noRowsLine: tellers.length ? undefined : "Nobody holds the CRM as a telecaller.",
      ...base,
    };
  }

  if (metric === "queuesWorked") {
    const days = days12(day);
    const [{ tellers }, hist] = await Promise.all([
      tellersToday(day),
      db.execute<{ d: string; total: string; worked: string }>(sql`
        select q.day::text as d, count(*)::bigint as total,
               count(*) filter (where exists (
                 select 1 from calls c where c.customer_id = q.customer_id
                   and (c.started_at ${IST})::date = q.day
               ))::bigint as worked
          from queue_snapshots q
         where q.user_id in (${TELLERS_SQL})
           and q.day between ${days[0]}::date and ${day}::date
         group by 1`),
    ]);
    const m = new Map(hist.map((h) => [h.d, pct(Number(h.worked), Number(h.total))]));
    const worked = tellers.reduce((s, t) => s + t.queue.worked, 0);
    const total = tellers.reduce((s, t) => s + t.queue.total, 0);
    return {
      kind: "Now figure · Queues",
      title: "Queues worked",
      value: total ? `${pct(worked, total)}%` : "None yet",
      facts: nowFacts(`${num(worked)} called of ${plural(total, "customer")} on today's lists`, "Each telecaller's Call Log, built by the queue engine"),
      def: "For every telecaller, the customers on today's Call Log who have been called today, out of those called plus those still waiting — the same worked-of-total their own Call Log header shows, added up across the team. Held-back customers are not on the list and are not counted.",
      bars: bars(days, (d) => m.get(d) ?? 0, (d, v) => `${fmtDay(d)} · ${m.has(d) ? `${v}% of the settled lists` : "no list settled"}`),
      barsLabel: "Share of each day's settled lists that was called, last 12 days",
      rowsLabel: "Telecallers by share of their queue worked",
      rows: [...tellers]
        .sort((a, b) => a.queue.percent - b.queue.percent)
        .slice(0, 8)
        .map((t) => ({ a: t.name, b: `${num(t.queue.worked)} of ${num(t.queue.total)} · ${num(t.queue.stillToWork)} still to work`, c: `${t.queue.percent}%` })),
      noRowsLine: tellers.length ? undefined : "Nobody holds the CRM as a telecaller.",
      ...base,
    };
  }

  if (metric === "remindersOverdue") {
    const [count, rows] = await Promise.all([
      remindersOverdue(day),
      db.execute<{ customer: string; who: string | null; due: string; note: string }>(sql`
        select c.name as customer, u.name as who, r.due_date::text as due, r.note
          from reminders r
          join customers c on c.id = r.customer_id
          left join users u on u.id = r.assigned_user_id
         where r.status = 'pending' and r.due_date < ${day}::date
         order by r.due_date asc
         limit 8`),
    ]);
    return {
      kind: "Now figure · Reminders",
      title: "Reminders overdue",
      value: num(count),
      facts: nowFacts("Pending reminders whose due date has passed", "CRM reminders"),
      def: "Every reminder still pending whose due date is before today, whoever it is assigned to. A reminder is a promise to call a customer back; it stops counting when it is completed or dismissed.",
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: "The oldest overdue reminders",
      rows: rows.map((r) => {
        const late = Math.round((Date.parse(day) - Date.parse(r.due)) / 86_400_000);
        return { a: r.customer, b: `${r.who ?? "Nobody assigned"} · due ${fmtDay(r.due)} · ${r.note}`, c: `${plural(late, "day")} late` };
      }),
      noRowsLine: rows.length ? undefined : "No reminder is overdue.",
      ...base,
    };
  }

  if (metric === "eod") {
    const { tellers, eodOn } = await tellersToday(day);
    const days = days12(eodOn);
    const hist = await db.execute<{ d: string; n: string }>(sql`
      select e.day::text as d, count(*)::bigint as n from eod_reports e
       where e.user_id in (${TELLERS_SQL}) and not e.auto_generated
         and e.day between ${days[0]}::date and ${eodOn}::date
       group by 1`);
    const m = new Map(hist.map((h) => [h.d, Number(h.n)]));
    const sent = tellers.filter((t) => t.eodSent).length;
    return {
      kind: "Now figure · EOD reports",
      title: "EOD reports",
      value: tellers.length ? `${num(sent)} of ${num(tellers.length)}` : "None yet",
      facts: nowFacts(`Reports sent for ${fmtDay(eodOn).replace(/^0/, "")}, the last working day`, "EOD reports submitted in the CRM"),
      def: "Telecallers who submitted their end-of-day report for the last working day. A report the system wrote on somebody's behalf, because they never submitted one, is not counted as sent.",
      bars: bars(days, (d) => m.get(d) ?? 0, (d, v) => `${fmtDay(d)} · ${plural(v, "report")}`),
      barsLabel: "Reports submitted for each of the last 12 days",
      rowsLabel: "Telecallers, those who have not sent first",
      rows: [...tellers]
        .sort((a, b) => Number(a.eodSent) - Number(b.eodSent) || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((t) => ({
          a: t.name,
          b: t.eodSent ? `sent ${stampIST(t.eodAt)}` : t.eodAuto ? "the system wrote one for them" : "nothing submitted",
          c: t.eodSent ? "Sent" : "Not sent",
        })),
      noRowsLine: tellers.length ? undefined : "Nobody holds the CRM as a telecaller.",
      ...base,
    };
  }

  if (metric === "assistant") {
    const months = months12(ctx.period.to);
    const from = `${months[0]}-01`;
    const to = endOfMonth(months[months.length - 1]!);
    const [ai, hist, who] = await Promise.all([
      assistantUse(ctx.period.from, ctx.period.to),
      db.execute<{ m: string; s: string; a: string }>(sql`
        select to_char((d.created_at ${IST})::date, 'YYYY-MM') as m,
               count(*) filter (where d.suggested_outcome is not null)::bigint as s,
               count(*) filter (where d.suggested_outcome is not null and d.applied_outcome is not null)::bigint as a
          from call_ai_drafts d
         where d.channel = 'call' and (d.created_at ${IST})::date between ${from}::date and ${to}::date
         group by 1`),
      db.execute<{ name: string; s: string; a: string }>(sql`
        select u.name,
               count(*) filter (where d.suggested_outcome is not null)::bigint as s,
               count(*) filter (where d.suggested_outcome is not null and d.applied_outcome is not null)::bigint as a
          from call_ai_drafts d join users u on u.id = d.user_id
         where d.channel = 'call'
           and (d.created_at ${IST})::date between ${ctx.period.from}::date and ${ctx.period.to}::date
         group by u.name order by s desc limit 8`),
    ]);
    const m = new Map(hist.map((h) => [h.m, { s: Number(h.s), a: Number(h.a) }]));
    return {
      kind: "Period figure · Call assistant",
      title: "Assistant used",
      value: ai.suggested ? `${pct(ai.applied, ai.suggested)}%` : "None yet",
      facts: [
        { label: "Kind", value: "Period — follows the period control" },
        { label: "Period", value: `${span(ctx.period.from, ctx.period.to)}` },
        { label: "Basis", value: `${num(ai.applied)} of ${plural(ai.suggested, "suggested outcome")} used` },
        { label: "Scope", value: SCOPE },
        { label: "Source", value: "The call assistant's drafts in the CRM" },
        { label: "As of", value: asOf },
      ],
      def: "Of the call notes the assistant read in the period and suggested an outcome for, the share where the telecaller pressed “Use this” on the suggestion. Whether the saved call kept that outcome afterwards is not part of this figure.",
      bars: bars(
        months,
        (k) => {
          const v = m.get(k);
          return v && v.s ? pct(v.a, v.s) : 0;
        },
        (k, v) => `${monthShort(k)} ${k.slice(0, 4)} · ${m.get(k)?.s ? `${v}% of ${num(m.get(k)!.s)}` : "no suggestions"}`,
      ),
      barsLabel: "Share of suggestions used, each of the last 12 months",
      rowsLabel: "Telecallers by suggestions in the period",
      rows: who.map((w) => ({ a: w.name, b: `${num(Number(w.a))} of ${num(Number(w.s))} used`, c: `${pct(Number(w.a), Number(w.s))}%` })),
      noRowsLine: who.length ? undefined : "The assistant made no suggestion in this period.",
      ...base,
    };
  }

  throw new Error("That figure is not part of Calling.");
}

/* -------------------------------------------------------------- record */

async function record(ctx: Ctx, table: string, id: string): Promise<RecordView> {
  if (table !== "team") throw new Error("That list is not part of Calling.");
  const day = ctx.period.today as BusinessDate;
  const eodOn = await eodDay(day);
  const [base, notes, audit, callsToday, ai, config] = await Promise.all([
    telecallerBase(day, eodOn),
    notesFor("user", id),
    auditFor("user", id),
    db.execute<{ customer: string; at: string; type: string; outcome: string | null }>(sql`
      select c2.name as customer, c.started_at as at, c.interaction_type::text as type, c.outcome::text as outcome
        from calls c join customers c2 on c2.id = c.customer_id
       where c.user_id = ${id} and (c.started_at ${IST})::date = ${day}::date
       order by c.started_at desc limit 30`),
    db.execute<{ s: number; a: number }>(sql`
      select count(*) filter (where d.suggested_outcome is not null)::int as s,
             count(*) filter (where d.suggested_outcome is not null and d.applied_outcome is not null)::int as a
        from call_ai_drafts d
       where d.user_id = ${id} and d.channel = 'call'
         and (d.created_at ${IST})::date between ${ctx.period.from}::date and ${ctx.period.to}::date`),
    getConfig(),
  ]);
  const b = base.find((x) => x.id === id);
  if (!b) throw new Error("That person is not on the calling team.");
  const [queue, m] = await Promise.all([
    telecallerQueue(id, { day }),
    eodMetricsForRange(id, { from: day, to: day }),
  ]);
  const aiRow = ai[0] ?? { s: 0, a: 0 };
  const eodSent = !!b.eod_at && !b.eod_auto;

  return {
    kind: "Telecaller · Calling",
    title: b.name,
    sub: `${num(queue.stillToWork)} still to call · ${num(queue.worked)} worked today`,
    fields: [
      { label: "Email", value: b.email || "—" },
      { label: "Phone", value: b.phone || "—" },
      { label: "Call Log today", value: `${num(queue.stillToWork)} still to call · ${num(queue.worked)} of ${num(queue.total)} worked (${queue.percent}%)${queue.settled ? "" : " · not opened yet today"}` },
      { label: "Held back today", value: heldSentence(queue.held, config["queue.whatsappCooldownDays"]) },
      { label: "Calls today", value: `${num(m.callsAttempted)} dialled · ${num(m.callsConnected)} connected · ${num(m.callsInbound)} came in` },
      { label: "Connect rate", value: m.callsAttempted ? `${pct(m.callsConnected, m.callsAttempted)}%` : "Nothing dialled yet" },
      { label: "Orders taken today", value: `${plural(m.ordersCaptured, "order")} · ${num(m.ordersCount)} approved so far` },
      { label: "Reminders due today", value: num(Number(b.due_today)) },
      { label: "Reminders overdue", value: num(Number(b.overdue)) },
      { label: `EOD report for ${fmtDay(eodOn).replace(/^0/, "")}`, value: eodSent ? `Sent ${stampIST(b.eod_at)}` : b.eod_auto ? "Not sent — the system wrote one for them" : "Not sent" },
      { label: "Call assistant this period", value: aiRow.s ? `${num(Number(aiRow.a))} of ${plural(Number(aiRow.s), "suggestion")} used` : "No suggestion made" },
      { label: "Last call", value: b.last_call ? stampIST(b.last_call) : "No call yet today" },
    ],
    timeline: [
      ...notes,
      ...callsToday.map((c) => ({
        what: `${TYPE[c.type] ?? "Call"} · ${c.customer}${c.outcome ? ` · ${OUTCOME[c.outcome] ?? "Logged"}` : ""}`,
        when: stampIST(c.at),
      })),
    ],
    audit,
    acts: [VIEW_AS],
    noteTarget: { kind: "user", id },
  };
}

/* ------------------------------------------------------------ provider */

export const provider: SectionProvider = {
  section,
  async tablePage(ctx, table, query) {
    if (table !== "team") throw new Error("That list is not part of Calling.");
    const { tellers } = await tellersToday(ctx.period.today as BusinessDate);
    return tellerPage(tellers, query);
  },
  figure,
  record,
  async act(_ctx, table, act) {
    if (table === "team" && act === "viewAs") {
      // Viewing as somebody is a read, opened by the client; nothing is run.
      return { ok: true, message: "Viewed" };
    }
    return { ok: false, error: "That action is not part of Calling." };
  },
};
