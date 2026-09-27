import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { COMPLAINT_ACTIONS } from "@/lib/call-outcomes";
import { CN_STATUS_LABEL, categoryLabel, priorityLabel } from "@/lib/complaint-labels";
import { complaintHistory, STATUS_LABEL } from "@/lib/services/worklist-services";
import { pendingCreditNoteCount, pendingCreditNotes } from "@/lib/services/credit-note-service";
import { reassignComplaint, resolveComplaint } from "@/lib/actions/crm";
import { readSubmissionFields } from "@/lib/enquiry-submission";
import {
  auditFor,
  emptyPage,
  fromOwning,
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
import type { ActSpec, Bar, FigureDrawer, RecordView, Row, TableDef, TablePage } from "../types";

/* ---------------------------------------------------------------------------
 * SERVICE — complaints, credit notes and website enquiries (PRD §12).
 *
 * Complaints are the CRM's: the open set is the CRM complaints screen's
 * "not yet resolved" (open, in progress, awaiting the customer), the SLA is
 * the complaint's own `sla_due_at`, and both row actions go through the CRM's
 * own `reassignComplaint` and `resolveComplaint`. Credit notes are counted by
 * the Accounts credit-note service; enquiries are counted off the enquiries
 * desk's own table.
 * ------------------------------------------------------------------------- */

const TZ = "Asia/Kolkata";
const OPEN = ["open", "in_progress", "awaiting_customer"] as const;
const OPEN_SQL = sql.raw(`('${OPEN.join("','")}')`);

/** The CRM's desks (its reassign list) and every desk a customer's ask routes to. */
const DESKS = [
  ...new Set([
    "Operations",
    "Accounts",
    "Dispatch",
    "Quality",
    "Management",
    ...COMPLAINT_ACTIONS.map((a) => a.desk),
  ]),
];

const n = (v: unknown) => Number(v ?? 0);
/** A stored instant's IST calendar date, as YYYY-MM-DD. */
const istDay = (v: string | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(v));
const asDate = (v: unknown) => (v instanceof Date ? v : v ? new Date(String(v)) : null);

/* ------------------------------------------------------------------ acts */

const ACTS: ActSpec[] = [
  {
    key: "reassign",
    label: "Reassign",
    confirm: "It moves to the person you pick, and the SLA clock keeps running.",
    done: "Reassigned",
    form: {
      title: "Reassign this complaint",
      sub: "Pick a desk, or a person. The SLA deadline does not move.",
      submit: "Reassign",
      consequence: "It moves to In progress and the move is written into the complaint's history.",
      fields: [
        {
          k: "to",
          label: "Give it to",
          type: "select",
          req: true,
          options: [
            { v: "desk", l: "A desk" },
            { v: "person", l: "A person" },
          ],
        },
        {
          k: "desk",
          label: "Desk",
          type: "select",
          req: true,
          options: DESKS.map((d) => ({ v: d, l: d })),
          when: { k: "to", in: ["desk"] },
        },
        { k: "person", label: "Person", type: "person", search: "staff", req: true, when: { k: "to", in: ["person"] } },
      ],
      init: { to: "desk" },
    },
  },
  {
    key: "resolve",
    label: "Resolve",
    confirm: "It closes with your resolution note, visible on the customer's record.",
    done: "Resolved",
    form: {
      title: "Resolve this complaint",
      submit: "Resolve",
      consequence: "The complaint closes and the note shows on the customer's record.",
      fields: [
        {
          k: "resolutionNotes",
          label: "Resolution note",
          type: "area",
          req: true,
          ph: "What was done for the customer",
        },
        {
          k: "customerTold",
          label: "Has the customer been told the outcome?",
          type: "select",
          req: true,
          options: [
            { v: "yes", l: "Yes, the customer has been told" },
            { v: "no", l: "No, not yet" },
          ],
        },
      ],
      init: { customerTold: "yes" },
    },
  },
];

const OPEN_DEF: TableDef = {
  key: "open",
  title: "Open complaints",
  hint: "Now · oldest first",
  cols: [
    ["Customer", "1.5fr"],
    ["Complaint", "1.8fr"],
    ["Open for", "0.8fr", true],
    ["With", "1fr"],
    ["State", "0.9fr"],
  ],
  noun: "complaint",
  rec: "Complaint",
  acts: ACTS,
};

/* ----------------------------------------------------------------- reads */

type OpenRow = {
  id: string;
  customer: string;
  city: string;
  description: string;
  category: string;
  created_at: string;
  assigned_to: string;
  status: string;
  sla_due_at: string;
};

function stateCell(status: string, slaDue: Date | null) {
  if (slaDue && slaDue.getTime() < Date.now()) return { t: "Past SLA", pill: "bad" as const };
  const h = slaDue ? (slaDue.getTime() - Date.now()) / 3_600_000 : null;
  if (h != null && h < 12) return { t: `Due in ${waited(h)}`, pill: "warn" as const };
  return {
    t: STATUS_LABEL[status] ?? "Open",
    pill: status === "awaiting_customer" ? ("warn" as const) : status === "in_progress" ? ("info" as const) : ("muted" as const),
  };
}

function short(s: string, max = 70) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

function toRow(r: OpenRow): Row {
  return {
    id: r.id,
    cells: [
      { t: r.customer, sub: r.city || undefined },
      { t: short(r.description), sub: categoryLabel(r.category) },
      { t: waited(hoursSince(r.created_at)) },
      { t: r.assigned_to },
      stateCell(r.status, asDate(r.sla_due_at)),
    ],
  };
}

async function openPage(query: TableQuery): Promise<TablePage> {
  const q = query.q.trim();
  const like = `%${q}%`;
  const match =
    q.length >= 2
      ? sql`and (cu.name ilike ${like} or cu.city ilike ${like} or c.description ilike ${like} or c.assigned_to ilike ${like})`
      : sql``;
  const [counts] = await db.execute<{ total: number; matched: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where true ${match})::int as matched
      from complaints c
      join customers cu on cu.id = c.customer_id
     where c.status in ${OPEN_SQL}`);
  const total = n(counts?.total);
  const count = n(counts?.matched);
  if (!total) return emptyPage(query);
  const pages = Math.max(1, Math.ceil(count / query.size));
  const page = Math.min(query.page, pages);
  const rows = await db.execute<OpenRow>(sql`
    select c.id, cu.name as customer, cu.city, c.description, c.category::text as category,
           c.created_at, c.assigned_to, c.status::text as status, c.sla_due_at
      from complaints c
      join customers cu on cu.id = c.customer_id
     where c.status in ${OPEN_SQL} ${match}
     order by c.created_at asc, c.id asc
     limit ${query.size} offset ${(page - 1) * query.size}`);
  return { rows: [...rows].map(toRow), count, total, page, size: query.size, q: query.q };
}

async function complaintFigures(ctx: Ctx) {
  const p = ctx.period;
  const [row] = await db.execute<{
    open: number;
    past_sla: number;
    severities: number;
    only_severity: string | null;
    resolved: number;
    resolved_prev: number;
    median_hours: number | null;
    enq: number;
    enq_prev: number;
    enq_leads: number;
  }>(sql`
    select
      (select count(*) from complaints where status in ${OPEN_SQL})::int as open,
      (select count(*) from complaints where status in ${OPEN_SQL} and sla_due_at < now())::int as past_sla,
      (select count(distinct severity) from complaints where status in ${OPEN_SQL})::int as severities,
      (select min(severity::text) from complaints where status in ${OPEN_SQL}) as only_severity,
      (select count(*) from complaints
        where resolved_at is not null
          and (resolved_at at time zone ${TZ})::date between ${p.from}::date and ${p.to}::date)::int as resolved,
      (select count(*) from complaints
        where resolved_at is not null
          and (resolved_at at time zone ${TZ})::date between ${p.compareFrom}::date and ${p.compareTo}::date)::int as resolved_prev,
      (select percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - created_at)) / 3600)
         from complaints
        where resolved_at is not null
          and (resolved_at at time zone ${TZ})::date between ${p.from}::date and ${p.to}::date) as median_hours,
      (select count(*) from enquiries
        where source = 'website'
          and (received_at at time zone ${TZ})::date between ${p.from}::date and ${p.to}::date)::int as enq,
      (select count(*) from enquiries
        where source = 'website'
          and (received_at at time zone ${TZ})::date between ${p.compareFrom}::date and ${p.compareTo}::date)::int as enq_prev,
      (select count(*) from enquiries
        where source = 'website' and customer_id is not null
          and (received_at at time zone ${TZ})::date between ${p.from}::date and ${p.to}::date)::int as enq_leads`);
  const cfg = await getConfig();
  const slaHours = cfg["complaints.slaHours"] as Record<string, number>;
  return {
    open: n(row?.open),
    pastSla: n(row?.past_sla),
    /** Every open complaint is held to one SLA only when they share a priority. */
    oneSlaHours: n(row?.severities) === 1 && row?.only_severity ? slaHours[row.only_severity] ?? null : null,
    resolved: n(row?.resolved),
    resolvedPrev: n(row?.resolved_prev),
    medianHours: row?.median_hours == null ? null : Number(row.median_hours),
    enq: n(row?.enq),
    enqPrev: n(row?.enq_prev),
    enqLeads: n(row?.enq_leads),
  };
}

/* --------------------------------------------------------------- history */

/** The 12 calendar months ending with the month `endDay` falls in. */
function monthsEnding(endDay: string) {
  return sql`generate_series(
    date_trunc('month', ${endDay}::date) - interval '11 months',
    date_trunc('month', ${endDay}::date),
    interval '1 month') as m`;
}

async function monthlyBars(endDay: string, valueSql: ReturnType<typeof sql>): Promise<Bar[]> {
  const rows = await db.execute<{ k: string; v: number }>(sql`
    select to_char(m, 'YYYY-MM') as k, (${valueSql})::float8 as v
      from ${monthsEnding(endDay)}
     order by m`);
  const list = [...rows];
  return list.map((r, i) => ({
    h: Number(r.v ?? 0),
    tip: `${monthLabel(r.k)} · ${num(Number(r.v ?? 0))}`,
    current: i === list.length - 1 || undefined,
  }));
}

/** The instant a month's reading is taken at: its end, or now for the running month. */
const MONTH_END = sql`least(now(), ((m + interval '1 month')::timestamp at time zone 'Asia/Kolkata'))`;
const IN_MONTH = (col: string) =>
  sql.raw(`(${col} at time zone 'Asia/Kolkata')::date >= m::date and (${col} at time zone 'Asia/Kolkata')::date < (m + interval '1 month')::date`);

/* ---------------------------------------------------------------- figure */

async function figure(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const p = ctx.period;
  const asOf = stampIST(new Date());
  const periodFacts = [
    { label: "Kind", value: "Follows the period" },
    { label: "Period", value: span(p.from, p.to) },
    { label: "Compared with", value: span(p.compareFrom, p.compareTo) },
  ];
  const nowFacts = [{ label: "Kind", value: "As of now" }];
  const f = await complaintFigures(ctx);

  if (metric === "open-complaints") {
    const [bars, page] = await Promise.all([
      monthlyBars(
        p.today,
        sql`(select count(*) from complaints c
              where c.created_at <= ${MONTH_END}
                and coalesce(c.resolved_at,
                      case when c.status in ('closed','rejected') then c.updated_at end,
                      'infinity'::timestamptz) > ${MONTH_END})`,
      ),
      openPage({ q: "", page: 1, size: 8 }),
    ]);
    return {
      kind: "Now figure · Service",
      title: "Open complaints",
      value: num(f.open),
      facts: [
        ...nowFacts,
        { label: "Basis", value: `${plural(f.pastSla, "complaint")} past their SLA deadline` },
        { label: "Scope", value: "Company-wide · every customer" },
        { label: "Source", value: "CRM complaints" },
        { label: "As of", value: asOf },
      ],
      def: "Every complaint not yet resolved, whoever it is with.",
      bars,
      barsLabel: "Open at the end of each month · the running month as of now",
      rowsLabel: `Records behind it · open complaints · ${num(page.total)} in all`,
      rows: page.rows.map((r) => ({ a: r.cells[0].t, b: r.cells[1].t, c: r.cells[4].t })),
      noRowsLine: page.total ? undefined : "No complaint is open.",
    };
  }

  if (metric === "resolved") {
    const [bars, rows] = await Promise.all([
      monthlyBars(p.to, sql`(select count(*) from complaints c where c.resolved_at is not null and ${IN_MONTH("c.resolved_at")})`),
      db.execute<{ customer: string; description: string; hours: number }>(sql`
        select cu.name as customer, c.description,
               extract(epoch from (c.resolved_at - c.created_at)) / 3600 as hours
          from complaints c join customers cu on cu.id = c.customer_id
         where c.resolved_at is not null
           and (c.resolved_at at time zone ${TZ})::date between ${p.from}::date and ${p.to}::date
         order by c.resolved_at desc limit 8`),
    ]);
    return {
      kind: "Period figure · Service",
      title: "Resolved this period",
      value: num(f.resolved),
      facts: [
        ...periodFacts,
        {
          label: "Median time to resolve",
          value: f.medianHours == null ? "Nothing resolved in these dates" : `${Math.round(f.medianHours)} hours`,
        },
        { label: "Scope", value: "Company-wide · every customer" },
        { label: "Source", value: "CRM complaints" },
        { label: "As of", value: asOf },
      ],
      def: "Complaints marked resolved on a date inside the period, by the date they were resolved (IST). The median is the middle time from being raised to being resolved.",
      bars,
      barsLabel: "Resolved in each month",
      rowsLabel: "Records behind it · the latest resolved in these dates",
      rows: [...rows].map((r) => ({ a: r.customer, b: short(r.description, 60), c: `${Math.round(Number(r.hours))} h` })),
      noRowsLine: rows.length ? undefined : "No complaint was resolved in these dates.",
    };
  }

  if (metric === "credit-notes") {
    const [bars, list] = await Promise.all([
      monthlyBars(
        p.today,
        sql`(select count(*) from complaints c
              where c.request_cn and c.created_at <= ${MONTH_END}
                and coalesce((select min(a.at) from audit_log a
                               where a.entity_type = 'complaint' and a.entity_id = c.id
                                 and a.action in ('creditnote.issue','creditnote.refuse')),
                             'infinity'::timestamptz) > ${MONTH_END})`,
      ),
      pendingCreditNotes().catch(() => null),
    ]);
    const count = await pendingCreditNoteCount();
    return {
      kind: "Now figure · Service",
      title: "Credit notes",
      value: num(count),
      facts: [
        ...nowFacts,
        { label: "Basis", value: "Requested on a complaint, not yet issued or refused" },
        { label: "Scope", value: "Company-wide · every customer" },
        { label: "Source", value: "Accounts credit notes" },
        { label: "As of", value: asOf },
      ],
      def: "Credit notes requested and waiting on accounts. A credit note is not money arriving.",
      bars,
      barsLabel: "Waiting at the end of each month · the running month as of now",
      rowsLabel: `Records behind it · waiting on accounts · ${num(count)} in all`,
      rows: (list ?? []).slice(0, 8).map((r) => ({
        a: r.customerName,
        b: `${r.categoryLabel} · waiting ${waited(r.waitingHours)}`,
        c: r.amount == null ? "Amount not set" : inr(r.amount),
      })),
      noRowsLine: list == null ? "The list is Accounts' to read." : list.length ? undefined : "No credit note is waiting.",
    };
  }

  if (metric === "enquiries") {
    const [bars, rows] = await Promise.all([
      monthlyBars(p.to, sql`(select count(*) from enquiries e where e.source = 'website' and ${IN_MONTH("e.received_at")})`),
      db.execute<{ raw: unknown; received_at: string; lead: string | null }>(sql`
        select e.raw_submission as raw, e.received_at, cu.name as lead
          from enquiries e left join customers cu on cu.id = e.customer_id
         where e.source = 'website'
           and (e.received_at at time zone ${TZ})::date between ${p.from}::date and ${p.to}::date
         order by e.received_at desc limit 8`),
    ]);
    return {
      kind: "Period figure · Service",
      title: "Website enquiries",
      value: num(f.enq),
      facts: [
        ...periodFacts,
        { label: "Became leads", value: num(f.enqLeads) },
        { label: "Scope", value: "Company-wide · every enquiry" },
        { label: "Source", value: "Website enquiries desk" },
        { label: "As of", value: asOf },
      ],
      def: "Enquiries received from the website on a date inside the period (IST). \"Became leads\" counts those among them that have been turned into a lead.",
      bars,
      barsLabel: "Received in each month",
      rowsLabel: "Records behind it · the latest received in these dates",
      rows: [...rows].map((r) => ({
        a: ((f) => f.company || f.name || r.lead || "No name given")(readSubmissionFields(r.raw)),
        b: stampIST(r.received_at),
        c: r.lead ? "Became a lead" : "No lead yet",
      })),
      noRowsLine: rows.length ? undefined : "No website enquiry arrived in these dates.",
      section: "enquiries",
      sectionLabel: "Open website enquiries",
    };
  }

  throw new Error("No figure called that in Service.");
}

/* ---------------------------------------------------------------- record */

async function record(_ctx: Ctx, table: string, id: string): Promise<RecordView> {
  if (table !== "open") throw new Error("No table called that in Service.");
  const [c] = await db.execute<{
    id: string;
    customer_id: string;
    customer: string;
    city: string;
    category: string;
    description: string;
    severity: string;
    required_action: string | null;
    assigned_to: string;
    status: string;
    sla_due_at: string;
    created_at: string;
    logged_by: string | null;
    mobile_number: string | null;
    resolution_notes: string | null;
    resolved_at: string | null;
    resolved_by: string | null;
    customer_informed: boolean;
    request_cn: boolean;
    cn_status: string | null;
    cn_amount: string | null;
    cn_reference: string | null;
    goods_description: string | null;
    bill_no: string | null;
  }>(sql`
    select c.id, c.customer_id, cu.name as customer, cu.city, c.category::text as category, c.description,
           c.severity::text as severity, c.required_action, c.assigned_to, c.status::text as status,
           c.sla_due_at, c.created_at, lu.name as logged_by, c.mobile_number, c.resolution_notes,
           c.resolved_at, ru.name as resolved_by, c.customer_informed, c.request_cn,
           c.cn_status::text as cn_status, c.cn_amount, c.cn_reference, c.goods_description, b.bill_no
      from complaints c
      join customers cu on cu.id = c.customer_id
      left join users lu on lu.id = c.logged_by_user_id
      left join users ru on ru.id = c.resolved_by_id
      left join bills b on b.id = c.bill_id
     where c.id = ${id}`);
  if (!c) throw new Error("That complaint no longer exists.");

  const [history, notes, audit] = await Promise.all([
    complaintHistory(id),
    notesFor("complaint", id),
    auditFor("complaint", id),
  ]);
  const open = (OPEN as readonly string[]).includes(c.status);
  const slaDue = asDate(c.sla_due_at);
  const ask = COMPLAINT_ACTIONS.find((a) => a.code === c.required_action);
  const cnStatus = c.cn_status ?? "requested";

  const fields = [
    { label: "Customer", value: c.city ? `${c.customer} · ${c.city}` : c.customer },
    { label: "What the customer reported", value: c.description },
    { label: "Category", value: categoryLabel(c.category) },
    { label: "Priority", value: priorityLabel(c.severity) },
    { label: "What the customer is asking for", value: ask?.label ?? "Not recorded" },
    { label: "State", value: STATUS_LABEL[c.status] ?? c.status },
    { label: "With", value: c.assigned_to },
    { label: "Raised", value: `${stampIST(c.created_at)}${c.logged_by ? ` · by ${c.logged_by}` : ""}` },
    {
      label: "SLA deadline",
      value: slaDue
        ? `${stampIST(slaDue)}${open && slaDue.getTime() < Date.now() ? ` · past it by ${waited(hoursSince(slaDue))}` : ""}`
        : "—",
    },
    { label: "Open for", value: open ? waited(hoursSince(c.created_at)) : "Closed" },
    { label: "Reported from", value: c.mobile_number || "Not recorded" },
    {
      label: "Credit note",
      value: c.request_cn
        ? [
            "Requested",
            CN_STATUS_LABEL[cnStatus] ?? cnStatus,
            c.cn_amount != null ? inr(Number(c.cn_amount)) : null,
            c.bill_no ? `against ${c.bill_no}` : null,
            c.cn_reference ? `ref ${c.cn_reference}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Not asked for",
    },
    ...(c.goods_description ? [{ label: "Goods", value: c.goods_description }] : []),
    ...(c.resolved_at
      ? [
          { label: "Resolved", value: `${stampIST(c.resolved_at)}${c.resolved_by ? ` · by ${c.resolved_by}` : ""}` },
          { label: "How it was resolved", value: c.resolution_notes || "No note" },
          { label: "Customer told", value: c.customer_informed ? "Yes" : "Not yet" },
        ]
      : []),
  ];

  const timeline = [
    ...notes,
    ...[...history]
      .reverse()
      .map((h) => ({
        what: [
          h.history.fromStatus && h.history.fromStatus !== h.history.toStatus
            ? `${STATUS_LABEL[h.history.fromStatus]} → ${STATUS_LABEL[h.history.toStatus]}`
            : STATUS_LABEL[h.history.toStatus],
          h.history.note,
        ]
          .filter(Boolean)
          .join(" · "),
        when: `${stampIST(h.history.at)}${h.byName ? ` · ${h.byName}` : ""}`,
      })),
  ];

  return {
    kind: "Complaint · Service",
    title: short(c.description, 80),
    sub: `${c.customer}${c.city ? ` · ${c.city}` : ""} · ${categoryLabel(c.category)} · raised ${fmtDate(istDay(c.created_at))}`,
    fields,
    timeline,
    audit,
    acts: open ? ACTS : [],
    href: { label: "Open the customer record", url: `/crm/customers/${c.customer_id}` },
    noteTarget: { kind: "complaint", id },
  };
}

/* ------------------------------------------------------------------- act */

async function act(_ctx: Ctx, table: string, action: string, id: string, input: Record<string, string>) {
  if (table !== "open") return { ok: false as const, error: "No table called that in Service." };
  try {
    const [c] = await db.execute<{ status: string; customer: string }>(sql`
      select c.status::text as status, cu.name as customer
        from complaints c join customers cu on cu.id = c.customer_id where c.id = ${id}`);
    if (!c) return { ok: false as const, error: "That complaint no longer exists." };
    if (!(OPEN as readonly string[]).includes(c.status)) {
      return { ok: false as const, error: `That complaint is already ${(STATUS_LABEL[c.status] ?? c.status).toLowerCase()}.` };
    }

    if (action === "reassign") {
      const byPerson = input.to === "person";
      const desk = byPerson ? "" : (input.desk ?? "").trim();
      const personId = byPerson ? (input.person ?? "").trim() : "";
      if (!byPerson && !desk) {
        return { ok: false as const, error: "Pick a desk.", fieldErrors: { desk: "Pick a desk." } };
      }
      if (byPerson && !personId) {
        return { ok: false as const, error: "Pick a person.", fieldErrors: { person: "Pick somebody from the list." } };
      }
      let to = desk;
      if (desk && !DESKS.includes(desk)) {
        return { ok: false as const, error: "That is not a desk.", fieldErrors: { desk: "Pick a desk from the list." } };
      }
      if (personId) {
        const [u] = await db.execute<{ name: string }>(sql`select name from users where id = ${personId} and active`);
        if (!u) {
          return {
            ok: false as const,
            error: "That person was not found.",
            fieldErrors: { person: "Pick somebody from the list." },
          };
        }
        to = u.name;
      }
      return fromOwning(await reassignComplaint(id, to), `Reassigned to ${to} · ${c.customer}`);
    }

    if (action === "resolve") {
      const note = (input.resolutionNotes ?? "").trim();
      if (!note) {
        return {
          ok: false as const,
          error: "Write what was done before closing - the customer record will show it.",
          fieldErrors: { resolutionNotes: "A resolution note is required." },
        };
      }
      const told = input.customerTold;
      if (told !== "yes" && told !== "no") {
        return {
          ok: false as const,
          error: "Say whether the customer has been told.",
          fieldErrors: { customerTold: "Pick one." },
        };
      }
      return fromOwning(
        await resolveComplaint({ id, resolutionNote: note, customerTold: told === "yes" }),
        `Resolved · ${c.customer}`,
      );
    }

    return { ok: false as const, error: "No action called that." };
  } catch (e) {
    return refusal(e);
  }
}

/* -------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(ctx) {
    const [f, page, cn] = await Promise.all([
      complaintFigures(ctx),
      openPage({ q: "", page: 1, size: 25 }),
      pendingCreditNoteCount(),
    ]);
    const resolvedChg = change(f.resolved, f.resolvedPrev);
    const enqChg = change(f.enq, f.enqPrev);
    const slaWords = f.oneSlaHours ? `past the ${f.oneSlaHours}-hour SLA` : "past their SLA";
    return {
      metrics: [
        {
          key: "open-complaints",
          label: "Open complaints",
          value: num(f.open),
          sub: f.open ? `${num(f.pastSla)} ${slaWords}` : "None open",
          kind: "Now",
          tone: f.pastSla > 0 ? "bad" : undefined,
        },
        {
          key: "resolved",
          label: "Resolved this period",
          value: num(f.resolved),
          sub: [
            resolvedChg.text,
            f.medianHours == null ? "none resolved in these dates" : `median ${Math.round(f.medianHours)} hours`,
          ].join(" · "),
          kind: "Period",
        },
        {
          key: "credit-notes",
          label: "Credit notes",
          value: num(cn),
          sub: cn ? "requested · waiting on accounts" : "none waiting on accounts",
          kind: "Now",
          tone: cn > 0 ? "warn" : undefined,
        },
        {
          key: "enquiries",
          label: "Website enquiries",
          value: num(f.enq),
          sub: `${enqChg.text} · ${num(f.enqLeads)} became ${f.enqLeads === 1 ? "a lead" : "leads"}`,
          kind: "Period",
        },
      ],
      callouts: [],
      tables: [withPage(OPEN_DEF, page)],
      foot: "",
    };
  },

  async tablePage(_ctx, table, query) {
    if (table !== "open") return emptyPage(query);
    return openPage(query);
  },

  figure,
  record,
  act,
};
