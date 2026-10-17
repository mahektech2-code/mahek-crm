import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { readLeadPrefill, readSubmissionFields } from "@/lib/enquiry-submission";
import {
  ACTIVITY_LABEL,
  PRIORITY_LABEL,
  STAGE_LABEL,
  categoryLabel,
  leadConvertibility,
  reminderTypeLabel,
  sourceFormLabel,
  sourceLabel,
  type EnquiryPriority,
  type EnquiryStage,
} from "@/lib/enquiry-labels";
import { offeredSalesTypes } from "@/lib/lead-labels";
import { assignEnquiryAction, createEnquiryReminderAction } from "@/lib/actions/enquiries";
import { captureLead } from "@/lib/actions/lead-intake";
import {
  auditFor,
  hoursSince,
  notesFor,
  refusal,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { change, fmtDate, inr, monthLabel, num, plural, span, waited } from "../format";
import type { ActSpec, Bar, Cell, FigureDrawer, Metric, RecordView, Row, TableDef, TablePage, Tone } from "../types";

/* ---------------------------------------------------------------------------
 * ENQUIRIES — the website desk (PRD §20).
 *
 * The rows are the Website Enquiries app's own table, read the way its list
 * reads them (`search_text` for the search, `readSubmissionFields` and
 * `readLeadPrefill` for what the visitor typed). The desk's own services open
 * with a check that the reader holds the Enquiries app, which the Founder hat
 * does not have to — so the reads are restated here in SQL against the same
 * columns, and every WRITE still goes through the desk's own actions:
 * `assignEnquiryAction`, `createEnquiryReminderAction` and `captureLead` with
 * `fromEnquiry`, which is the one way a lead is raised from an enquiry.
 *
 * "Median first reply": the desk records no reply as such. What it does record
 * is every action a person takes on an enquiry, so the figure is the median
 * time from receipt to the first thing somebody DID about it — a stage move, a
 * note, a follow-up, a linked customer or a lead — and says so. Opening it and
 * assigning it are not counted: neither is contact with the visitor.
 * ------------------------------------------------------------------------- */

const TZ = "Asia/Kolkata";
const WS = sql`e.workspace = 'enquiries'`;
const CONTACT_KINDS = sql.raw(`('stage_changed','note','reminder_created','customer_linked','lead_created','order_linked')`);

const n = (v: unknown) => Number(v ?? 0);

function windowOf(from: string, to: string) {
  return {
    start: sql.raw(`'${from} 00:00:00+05:30'::timestamptz`),
    end: sql.raw(`'${to} 23:59:59.999+05:30'::timestamptz`),
  };
}

/** Hours from receipt to the first thing a person did, for enquiries received in the window. */
function firstActionHours(from: string, to: string) {
  const w = windowOf(from, to);
  return sql`
    select extract(epoch from (fa.at - e.received_at)) / 3600.0 as h
      from enquiries e
      join lateral (
        select min(a.at) as at from enquiry_activity a
         where a.enquiry_id = e.id and a.actor_user_id is not null and a.kind in ${CONTACT_KINDS}
      ) fa on fa.at is not null
     where ${WS} and e.received_at >= ${w.start} and e.received_at <= ${w.end}`;
}

function hoursWords(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

function monthKeys(today: string, count: number): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return Array.from({ length: count }, (_, i) => {
    const t = y * 12 + (m - 1) - (count - 1 - i);
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  });
}

/* ------------------------------------------------------------------- acts */

const ASSIGN: ActSpec = {
  key: "assign",
  label: "Assign",
  confirm: "It goes to the chosen person with a reminder due today.",
  done: "Assigned",
  form: {
    title: "Assign this enquiry",
    sub: "Only somebody who holds Website Enquiries can be given one.",
    submit: "Assign",
    consequence: "It goes to the chosen person with a reminder due today. They are told.",
    fields: [{ k: "person", label: "Give it to", type: "person", search: "staff", req: true }],
  },
};

const MAKE_LEAD: ActSpec = {
  key: "lead",
  label: "Make a lead",
  confirm: "A lead is created with the enquiry attached, checked for duplicates first.",
  done: "Made a lead",
  form: {
    title: "Make a lead from this enquiry",
    sub: "The name, phone, town and what they asked for are taken from the enquiry itself.",
    submit: "Make a lead",
    consequence: "A lead is created with the enquiry attached, checked for duplicates first.",
    fields: [
      {
        k: "salesType",
        label: "How will this lead be sold?",
        type: "select",
        req: true,
        options: offeredSalesTypes().map((t) => ({ v: t.code, l: t.label })),
      },
      {
        k: "city",
        label: "Town",
        type: "text",
        hint: "Leave blank to use the town the enquiry gave.",
      },
    ],
  },
};

const DEF: TableDef = {
  key: "every",
  title: "Every enquiry",
  hint: "Newest first",
  cols: [
    ["From", "1.5fr"],
    ["Company", "1.3fr"],
    ["Asked about", "1.4fr"],
    ["Received", "0.9fr"],
    ["State", "0.9fr"],
  ],
  noun: "enquiry",
  plural: "enquiries",
  rec: "Enquiry",
  acts: [ASSIGN, MAKE_LEAD],
};

/* ------------------------------------------------------------------ table */

const STATE_TONE: Record<EnquiryStage, Tone> = {
  new: "warn",
  contacted: "info",
  follow_up: "info",
  qualified: "good",
  converted: "good",
  closed: "muted",
};

type EnqRow = {
  id: string;
  raw: Record<string, unknown>;
  source: string;
  source_form: string | null;
  category: string | null;
  stage: EnquiryStage;
  assigned: string | null;
  assigned_id: string | null;
  received: string;
  customer_id: string | null;
  customer_name: string | null;
};

function askedAbout(raw: unknown, form: string | null): string {
  const p = readLeadPrefill(raw);
  if (p.requirement) return p.requirement;
  const msg = readSubmissionFields(raw).message;
  if (msg) return msg.length > 60 ? `${msg.slice(0, 57).trimEnd()}…` : msg;
  return sourceFormLabel(form) ? `${sourceFormLabel(form)} form` : "Nothing stated";
}

function toRow(r: EnqRow): Row {
  const f = readSubmissionFields(r.raw);
  const p = readLeadPrefill(r.raw);
  const state: Cell = !r.assigned_id
    ? { t: "Unassigned", pill: "bad", sub: STAGE_LABEL[r.stage] === "New" ? undefined : STAGE_LABEL[r.stage] }
    : { t: STAGE_LABEL[r.stage] ?? r.stage, pill: STATE_TONE[r.stage] ?? "muted", sub: r.assigned ?? undefined };
  const terminal = r.stage === "converted" || r.stage === "closed";
  const acts: string[] = [];
  if (!terminal) acts.push("assign");
  if (!terminal && !r.customer_id && leadConvertibility({ source: r.source, sourceForm: r.source_form, category: r.category }).ok) {
    acts.push("lead");
  }
  return {
    id: r.id,
    cells: [
      { t: f.name ?? r.customer_name ?? "No name given", sub: f.phone ?? f.email ?? undefined },
      { t: f.company ?? r.customer_name ?? "—", sub: p.city ?? undefined },
      { t: askedAbout(r.raw, r.source_form) },
      { t: r.received },
      state,
    ],
    acts,
  };
}

async function everyPage(query: TableQuery): Promise<TablePage> {
  const q = query.q.trim();
  const like = `%${q}%`;
  const search =
    q.length >= 2
      ? sql`and (e.search_text ilike ${like} or exists (
          select 1 from customers c where c.id = e.customer_id and c.name ilike ${like}))`
      : sql``;
  const [counts] = await db.execute<{ total: number; matched: number }>(sql`
    select count(*)::int as total, count(*) filter (where true ${search})::int as matched
      from enquiries e where ${WS}
  `);
  const matched = n(counts?.matched);
  const pages = Math.max(1, Math.ceil(matched / query.size));
  const page = Math.min(query.page, pages);
  const rows = await db.execute<EnqRow>(sql`
    select e.id, e.raw_submission as raw, e.source, e.source_form, e.category, e.stage::text as stage,
           u.name as assigned, e.assigned_to_id as assigned_id,
           to_char(e.received_at at time zone ${TZ}, 'FMDD Mon, HH24:MI') as received,
           e.customer_id, c.name as customer_name
      from enquiries e
      left join users u on u.id = e.assigned_to_id
      left join customers c on c.id = e.customer_id
     where ${WS} ${search}
     order by e.received_at desc, e.id desc
     limit ${query.size} offset ${(page - 1) * query.size}
  `);
  return { rows: rows.map(toRow), count: matched, total: n(counts?.total), page, size: query.size, q: query.q };
}

/* ---------------------------------------------------------------- metrics */

async function headline(ctx: Ctx) {
  const p = ctx.period;
  const now = windowOf(p.from, p.to);
  const before = windowOf(p.compareFrom, p.compareTo);
  const [[c], [un], [med]] = await Promise.all([
    db.execute<{ now: number; before: number; leads: number }>(sql`
      select count(*) filter (where e.received_at >= ${now.start} and e.received_at <= ${now.end})::int as now,
             count(*) filter (where e.received_at >= ${before.start} and e.received_at <= ${before.end})::int as before,
             count(*) filter (where e.received_at >= ${now.start} and e.received_at <= ${now.end}
               and exists (select 1 from enquiry_activity a where a.enquiry_id = e.id and a.kind = 'lead_created'))::int as leads
        from enquiries e where ${WS}
    `),
    db.execute<{ n: number; oldest: string | null }>(sql`
      select count(*)::int as n, min(e.received_at) as oldest
        from enquiries e where ${WS} and e.assigned_to_id is null
    `),
    db.execute<{ median: string | null; worked: number }>(sql`
      select percentile_cont(0.5) within group (order by t.h) as median, count(*)::int as worked
        from (${firstActionHours(p.from, p.to)}) t
    `),
  ]);
  return {
    now: n(c?.now),
    before: n(c?.before),
    leads: n(c?.leads),
    unassigned: n(un?.n),
    oldest: un?.oldest ?? null,
    median: med?.median == null ? null : Number(med.median),
    worked: n(med?.worked),
  };
}

function metricsOf(ctx: Ctx, h: Awaited<ReturnType<typeof headline>>): Metric[] {
  const vs = `vs ${span(ctx.period.compareFrom, ctx.period.compareTo)}`;
  return [
    { key: "new", label: "New enquiries", value: num(h.now), sub: h.before === 0 ? (h.now ? `up from none in ${span(ctx.period.compareFrom, ctx.period.compareTo)}` : `none in ${span(ctx.period.compareFrom, ctx.period.compareTo)} either`) : `${change(h.now, h.before).text} ${vs}`, kind: "Period" },
    {
      key: "unassigned",
      label: "Unassigned",
      value: num(h.unassigned),
      sub: h.unassigned ? `oldest ${waited(hoursSince(h.oldest))}` : "every enquiry has somebody",
      kind: "Now",
      tone: h.unassigned ? "bad" : undefined,
    },
    {
      key: "leads",
      label: "Became leads",
      value: num(h.leads),
      sub: h.now ? `${Math.round((h.leads / h.now) * 100)}% of enquiries` : "no enquiries in the period",
      kind: "Period",
    },
    h.median == null
      ? {
          key: "reply",
          label: "Median first reply",
          value: "None yet",
          sub: h.now ? "nobody has logged contact on the period's enquiries" : "no enquiries in the period",
          kind: "Period",
        }
      : {
          key: "reply",
          label: "Median first reply",
          value: hoursWords(h.median),
          sub: `to the first contact logged · ${plural(h.worked, "enquiry", "enquiries")}`,
          kind: "Period",
        },
  ];
}

const TITLES: Record<string, string> = {
  new: "New enquiries",
  unassigned: "Unassigned",
  leads: "Became leads",
  reply: "Median first reply",
};

const DEFS: Record<string, string> = {
  new: "Website enquiries received in the period, by the time the visitor submitted them.",
  unassigned: "Website enquiries with nobody to follow them up.",
  leads: "Enquiries received in the period that a lead has been raised from, through the desk's Create lead.",
  reply:
    "The median time from an enquiry arriving to the first thing a person did about it — a stage move, a note, a follow-up, a linked customer or a lead. The desk does not record replies to the visitor as such; opening an enquiry and assigning it are not counted.",
};

/* ----------------------------------------------------------------- record */

async function enquiryRecord(id: string): Promise<RecordView> {
  const [r] = await db.execute<Record<string, unknown>>(sql`
    select e.id, e.raw_submission as raw, e.source, e.source_form, e.category, e.stage::text as stage,
           e.priority::text as priority, e.received_at, e.external_ref, e.assigned_to_id,
           u.name as assigned, e.customer_id, c.name as customer_name, c.kind::text as customer_kind,
           c.city as customer_city, ou.name as customer_owner
      from enquiries e
      left join users u on u.id = e.assigned_to_id
      left join customers c on c.id = e.customer_id
      left join users ou on ou.id = c.owner_id
     where e.id = ${id}
  `);
  if (!r) throw new Error("That enquiry no longer exists.");
  const s = (k: string) => (r[k] === null || r[k] === undefined || r[k] === "" ? null : String(r[k]));
  const f = readSubmissionFields(r.raw);
  const p = readLeadPrefill(r.raw);
  const stage = s("stage") as EnquiryStage;

  const [activity, reminders, orders, notes, audit] = await Promise.all([
    db.execute<{ kind: string; at: string; note: string | null; actor: string | null }>(sql`
      select a.kind, a.at, a.note, u.name as actor
        from enquiry_activity a left join users u on u.id = a.actor_user_id
       where a.enquiry_id = ${id} order by a.at desc limit 50
    `),
    db.execute<{ due: string; note: string; type: string; status: string; who: string | null }>(sql`
      select to_char(r.due_date, 'YYYY-MM-DD') as due, r.note, r.type::text as type, r.status::text as status, u.name as who
        from reminders r left join users u on u.id = r.assigned_user_id
       where r.enquiry_id = ${id} order by r.due_date desc
    `),
    db.execute<{ no: string | null; on: string; total: string }>(sql`
      select o.order_no as no, to_char(o.ordered_at at time zone ${TZ}, 'YYYY-MM-DD') as on, o.total_amount as total
        from enquiry_orders eo join orders o on o.id = eo.order_id
       where eo.enquiry_id = ${id} order by o.ordered_at desc
    `),
    notesFor("enquiry", id),
    auditFor("enquiry", id),
  ]);

  const pending = reminders.filter((x) => x.status === "pending");
  const convertible =
    !s("customer_id") &&
    stage !== "converted" &&
    stage !== "closed" &&
    leadConvertibility({ source: s("source")!, sourceForm: s("source_form"), category: s("category") }).ok;

  const fields = [
    { label: "From", value: f.name ?? "No name given" },
    { label: "Phone", value: f.phone ?? "Not given" },
    { label: "Email", value: f.email ?? "Not given" },
    { label: "Company", value: f.company ?? "Not given" },
    { label: "Town", value: p.city ?? "Not given" },
    { label: "Asked about", value: p.requirement ?? "Not stated" },
    { label: "What they wrote", value: f.message ?? "Nothing" },
    {
      label: "Came in through",
      value: [sourceLabel(s("source")!), sourceFormLabel(s("source_form")) ? `${sourceFormLabel(s("source_form"))} form` : null, categoryLabel(s("category"))]
        .filter(Boolean)
        .join(" · "),
    },
    { label: "Received", value: stampIST(s("received_at")) },
    { label: "Stage", value: STAGE_LABEL[stage] ?? "Not recorded" },
    { label: "Priority", value: PRIORITY_LABEL[s("priority") as EnquiryPriority] ?? "Normal" },
    { label: "Assigned to", value: s("assigned") ?? "Nobody" },
    {
      label: "Linked to",
      value: s("customer_id")
        ? `${s("customer_name")}${s("customer_kind") === "lead" ? ` — a lead, ${s("customer_owner") ? `owned by ${s("customer_owner")}` : "nobody owns it yet"}` : " — a customer"}`
        : "No customer or lead yet",
    },
    {
      label: "Follow-ups",
      value: pending.length
        ? pending.map((x) => `${reminderTypeLabel(x.type)} due ${fmtDate(x.due)}${x.who ? ` · ${x.who}` : ""}`).join("; ")
        : "None pending",
    },
    {
      label: "Orders linked",
      value: orders.length
        ? orders.map((o) => `${o.no ?? "Order"} · ${fmtDate(o.on)} · ${inr(n(o.total))}`).join("; ")
        : "None",
    },
  ];

  const acts: ActSpec[] = [];
  if (stage !== "converted" && stage !== "closed") acts.push(ASSIGN);
  if (convertible) acts.push(MAKE_LEAD);

  return {
    kind: "Enquiry · Website enquiries",
    title: f.name ?? f.company ?? "Website enquiry",
    sub: [f.company, p.city, STAGE_LABEL[stage], s("assigned") ? `with ${s("assigned")}` : "unassigned"].filter(Boolean).join(" · "),
    fields,
    timeline: [
      ...notes,
      ...activity.map((a) => ({
        what: [ACTIVITY_LABEL[a.kind] ?? a.kind.replace(/_/g, " "), a.note].filter(Boolean).join(" · "),
        when: `${stampIST(a.at)}${a.actor ? ` · ${a.actor}` : ""}`,
      })),
    ],
    audit,
    acts,
    href: { label: "Open in Website Enquiries", url: `/enquiries/list/${id}` },
    noteTarget: { kind: "enquiry", id },
  };
}

/* ---------------------------------------------------------------- figures */

async function monthlyBars(today: string, metric: string): Promise<Bar[]> {
  const keys = monthKeys(today, 12);
  const start = sql.raw(`'${keys[0]}-01 00:00:00+05:30'::timestamptz`);
  if (metric === "reply") {
    const rows = await db.execute<{ m: string; median: string | null }>(sql`
      select to_char(e.received_at at time zone ${TZ}, 'YYYY-MM') as m,
             percentile_cont(0.5) within group (order by extract(epoch from (fa.at - e.received_at)) / 3600.0) as median
        from enquiries e
        join lateral (
          select min(a.at) as at from enquiry_activity a
           where a.enquiry_id = e.id and a.actor_user_id is not null and a.kind in ${CONTACT_KINDS}
        ) fa on fa.at is not null
       where ${WS} and e.received_at >= ${start}
       group by 1
    `);
    const by = new Map(rows.map((r) => [r.m, r.median == null ? null : Number(r.median)]));
    return keys.map((k, i) => {
      const v = by.get(k) ?? null;
      return { h: v == null ? 0 : Math.round(v * 10) / 10, tip: `${monthLabel(k)} · ${v == null ? "none worked" : hoursWords(v)}`, current: i === 11 || undefined };
    });
  }
  const rows = await db.execute<{ m: string; n: number }>(sql`
    select to_char(e.received_at at time zone ${TZ}, 'YYYY-MM') as m, count(*)::int as n
      from enquiries e
     where ${WS} and e.received_at >= ${start}
       ${metric === "leads" ? sql`and exists (select 1 from enquiry_activity a where a.enquiry_id = e.id and a.kind = 'lead_created')` : sql``}
     group by 1
  `);
  const by = new Map(rows.map((r) => [r.m, n(r.n)]));
  return keys.map((k, i) => ({ h: by.get(k) ?? 0, tip: `${monthLabel(k)} · ${num(by.get(k) ?? 0)}`, current: i === 11 || undefined }));
}

/* --------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(ctx) {
    const [h, page] = await Promise.all([headline(ctx), everyPage({ q: "", page: 1, size: 25 })]);
    return {
      metrics: metricsOf(ctx, h),
      callouts: [],
      tables: [withPage(DEF, page)],
      foot: "An enquiry arrives unassigned and stays so until somebody takes it. A lead made from one is checked for duplicates against the whole book first.",
    };
  },

  async tablePage(_ctx, table, query) {
    if (table !== "every") throw new Error(`No table called ${table}.`);
    return everyPage(query);
  },

  async figure(ctx, metric): Promise<FigureDrawer> {
    if (!TITLES[metric]) throw new Error(`No figure called ${metric}.`);
    const p = ctx.period;
    const h = await headline(ctx);
    const m = metricsOf(ctx, h).find((x) => x.key === metric)!;
    const isNow = metric === "unassigned";
    const facts = [
      { label: "Kind", value: isNow ? "As of now" : "Follows the period" },
      ...(isNow ? [] : [{ label: "Period", value: span(p.from, p.to) }]),
      { label: "Basis", value: metric === "reply" ? "Median, in hours" : "Count — change in percent" },
      { label: "Scope", value: "Company-wide · every website enquiry" },
      { label: "Source", value: "Website Enquiries" },
      { label: "As of", value: stampIST(new Date()) },
    ];
    const w = windowOf(p.from, p.to);
    const filter =
      metric === "unassigned"
        ? sql`e.assigned_to_id is null`
        : metric === "leads"
          ? sql`e.received_at >= ${w.start} and e.received_at <= ${w.end}
                and exists (select 1 from enquiry_activity a where a.enquiry_id = e.id and a.kind = 'lead_created')`
          : sql`e.received_at >= ${w.start} and e.received_at <= ${w.end}`;
    const [bars, rows] = await Promise.all([
      isNow ? Promise.resolve([] as Bar[]) : monthlyBars(p.today, metric),
      metric === "reply"
        ? Promise.resolve([] as EnqRow[])
        : db.execute<EnqRow>(sql`
            select e.id, e.raw_submission as raw, e.source, e.source_form, e.category, e.stage::text as stage,
                   u.name as assigned, e.assigned_to_id as assigned_id,
                   to_char(e.received_at at time zone ${TZ}, 'FMDD Mon, HH24:MI') as received,
                   e.customer_id, c.name as customer_name
              from enquiries e
              left join users u on u.id = e.assigned_to_id
              left join customers c on c.id = e.customer_id
             where ${WS} and ${filter}
             order by e.received_at ${isNow ? sql`asc` : sql`desc`}
             limit 8
          `),
    ]);
    const total = metric === "unassigned" ? h.unassigned : metric === "leads" ? h.leads : h.now;
    return {
      kind: `${isNow ? "Now" : "Period"} figure · Enquiries`,
      title: TITLES[metric],
      value: m.value,
      facts,
      def: DEFS[metric],
      bars,
      barsLabel: isNow ? "No history is kept for this figure" : "Each calendar month · the running month to date",
      rowsLabel:
        metric === "reply" ? "Records behind it" : `Records behind it · every enquiry · ${num(total)} in all`,
      rows: (rows as EnqRow[]).map((r) => {
        const f = readSubmissionFields(r.raw);
        return {
          a: f.name ?? r.customer_name ?? "No name given",
          b: [f.company, askedAbout(r.raw, r.source_form)].filter(Boolean).join(" · "),
          c: r.received,
        };
      }),
      noRowsLine:
        metric === "reply"
          ? "No list on this dashboard holds the records behind this figure. The definition above is how it is counted."
          : rows.length
            ? undefined
            : "No enquiry matches this figure.",
    };
  },

  async record(_ctx, table, id) {
    if (table !== "every") throw new Error(`No table called ${table}.`);
    return enquiryRecord(id);
  },

  async act(ctx, table, act, id, input) {
    if (table !== "every") return { ok: false, error: "That action is not offered here." };
    try {
      const [e] = await db.execute<{ raw: Record<string, unknown>; customer_id: string | null; person: string | null }>(sql`
        select e.raw_submission as raw, e.customer_id,
               (select name from users where users.id = ${String(input.person ?? "")}) as person
          from enquiries e where e.id = ${id} and ${WS}
      `);
      if (!e) return { ok: false, error: "That enquiry no longer exists." };
      const subject = readSubmissionFields(e.raw).name ?? readSubmissionFields(e.raw).company ?? "the enquiry";

      if (act === "assign") {
        const person = String(input.person ?? "").trim();
        if (!person) return { ok: false, error: "Pick who it goes to.", fieldErrors: { person: "Pick who it goes to." } };
        const r = await assignEnquiryAction(id, person);
        if (!r.ok) {
          return { ok: false, error: r.error, fieldErrors: r.code === "rule_violation" ? { person: r.error } : undefined };
        }
        if (!e.customer_id) {
          return {
            ok: true,
            message: `Assigned · ${subject} to ${e.person ?? "them"} · no reminder set — the desk sets one only once a customer is linked`,
          };
        }
        const rem = await createEnquiryReminderAction({
          enquiryId: id,
          dueDate: ctx.period.today,
          note: "Follow up this website enquiry.",
          type: "call_back",
          assignedUserId: person,
        });
        return rem.ok
          ? { ok: true, message: `Assigned · ${subject} to ${e.person ?? "them"} · reminder due today` }
          : { ok: true, message: `Assigned · ${subject} to ${e.person ?? "them"} · the reminder could not be set: ${rem.error}` };
      }

      if (act === "lead") {
        const salesType = String(input.salesType ?? "").trim();
        if (!offeredSalesTypes().some((t) => t.code === salesType)) {
          return { ok: false, error: "Choose how this lead will be sold.", fieldErrors: { salesType: "Choose how this lead will be sold." } };
        }
        const p = readLeadPrefill(e.raw);
        const city = String(input.city ?? "").trim() || p.city || "";
        const name = p.name ?? p.companyName ?? "";
        const r = await captureLead({
          salesType: salesType as "direct" | "third_party",
          name,
          companyName: p.companyName ?? undefined,
          contactPerson: p.contactPerson ?? undefined,
          email: p.email ?? undefined,
          phone: p.phone ?? "",
          city,
          address: p.address ?? undefined,
          requirement: p.requirement ?? undefined,
          notes: p.notes ?? undefined,
          source: "website",
          fromEnquiry: { enquiryId: id },
        });
        if (!r.ok) {
          const fe: Record<string, string> = {};
          for (const f of r.fieldErrors ?? []) if (f.field === "city" || f.field === "salesType") fe[f.field] = f.message;
          const missing = (r.fieldErrors ?? []).find((f) => f.field === "name" || f.field === "phone");
          return {
            ok: false,
            error: missing
              ? `The enquiry does not carry a usable ${missing.field === "name" ? "name" : "phone number"} — ${missing.message} Make the lead from Website Enquiries, where it can be typed in.`
              : r.error,
            fieldErrors: Object.keys(fe).length ? fe : undefined,
          };
        }
        return { ok: true, message: `Made a lead · ${name || subject}` };
      }

      return { ok: false, error: "That action is not offered here." };
    } catch (err) {
      return refusal(err);
    }
  },
};
