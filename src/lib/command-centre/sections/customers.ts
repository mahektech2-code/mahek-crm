import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { bandFor, type HealthBand } from "@/lib/engines/inactivity";
import { bandedCustomers, type BandedCustomer } from "@/lib/services/owner-dashboard-service";
import { customerTimeline } from "@/lib/queries";
import { updateAccountManagers } from "@/lib/actions/account-manager";
import {
  auditFor,
  fromOwning,
  notesFor,
  refusal,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { fmtDate, inr, monthLabel, num, plural } from "../format";
import type { ActSpec, Bar, Cell, FigureDrawer, Metric, RecordView, Row, TableDef, TablePage, Tone } from "../types";

/* ---------------------------------------------------------------------------
 * CUSTOMERS — the book's health (PRD §11).
 *
 * The bands are the Reports app's own: `bandedCustomers` places every
 * customer live, off their own buying cycle, and `customer_health_snapshots`
 * is where the band at the end of last month survives — the same two reads
 * `movementSince` compares. The design's three words are a reading of the
 * engine's four bands: active is Healthy, at-risk is Slowing, and dormant and
 * lost are both Lapsed. The record view names the real band beside it.
 *
 * "Assign" moves the SALES seat through `updateAccountManagers` — the
 * Accounts desk's own action, `customer.reassign`, with a coded reason from
 * `people.amChangeReasons` — so a move here writes the same history row,
 * notifies the same people and holds the sheet off the same way.
 * ------------------------------------------------------------------------- */

const TZ = "Asia/Kolkata";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The design's word for each of the engine's four bands. */
export const BAND_WORD: Record<HealthBand, { word: string; tone: Tone }> = {
  active: { word: "Healthy", tone: "good" },
  "at-risk": { word: "Slowing", tone: "warn" },
  dormant: { word: "Lapsed", tone: "bad" },
  lost: { word: "Lapsed", tone: "bad" },
};

/** The engine's own name for the band, said in words (never the code). */
const BAND_REAL: Record<HealthBand, string> = {
  active: "Active",
  "at-risk": "At risk",
  dormant: "Dormant",
  lost: "Lost",
};

const RANK: Record<HealthBand, number> = { active: 0, "at-risk": 1, dormant: 2, lost: 3 };

/** "31 Aug", with the year only where it is not this year. */
function dayMonth(iso: string | null | undefined, thisYear: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${y === thisYear ? "" : ` ${y}`}`;
}

/** The month before `today`'s, as its key and its last day. */
function previousMonth(today: string): { key: string; end: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const key = `${py}-${String(pm).padStart(2, "0")}`;
  return { key, end: `${key}-${String(last).padStart(2, "0")}` };
}

/** The twelve month keys ending with `today`'s month, oldest first. */
function lastTwelveMonths(today: string): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const t = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

function multiplierWords(x: number): string {
  if (x === 2) return "twice";
  if (x === 3) return "three times";
  return `${x}×`;
}

/* ------------------------------------------------------------------- book */

type BookRow = {
  id: string;
  name: string;
  city: string | null;
  status: string;
  thirdParty: boolean;
  lastOrderDate: string | null;
  cycleDays: number;
  measured: boolean;
  salesperson: string | null;
};

type Book = {
  rows: BookRow[];
  banded: Map<string, BandedCustomer>;
  bandedList: BandedCustomer[];
  neverOrdered: number;
  before: Map<string, HealthBand> | null;
  prev: { key: string; end: string };
  config: Awaited<ReturnType<typeof getConfig>>;
};

/**
 * Every customer, their band now and their band at the end of last month.
 *
 * Company-wide by name (`unscoped`): the Command Centre reads the whole book
 * whoever's session asks, exactly as the nightly snapshot does.
 */
async function loadBook(today: string): Promise<Book> {
  const prev = previousMonth(today);
  const [health, rows, snap, config] = await Promise.all([
    bandedCustomers(today, {}, { unscoped: true }),
    db.execute<{
      id: string;
      name: string;
      city: string | null;
      status: string;
      third_party: boolean;
      last_order_date: string | null;
      cycle_days: number;
      cycle_confidence: number | null;
      salesperson: string | null;
    }>(sql`
      select c.id, c.name, c.city, c.status::text as status, c.third_party,
             to_char(c.last_order_date, 'YYYY-MM-DD') as last_order_date,
             c.cycle_days, c.cycle_confidence,
             coalesce(c.sales_person_name, u.name) as salesperson
        from customers c
        left join users u on u.id = c.sales_am_id
       where c.kind = 'customer'
    `),
    db.execute<{ customer_id: string; band: string }>(sql`
      select s.customer_id, s.band from customer_health_snapshots s where s.period = ${prev.key}
    `),
    getConfig(),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      status: r.status,
      thirdParty: Boolean(r.third_party),
      lastOrderDate: r.last_order_date,
      cycleDays: Number(r.cycle_days),
      measured: r.cycle_confidence !== null,
      salesperson: r.salesperson,
    })),
    banded: new Map(health.banded.map((b) => [b.customerId, b])),
    bandedList: health.banded,
    neverOrdered: health.neverOrdered,
    before: snap.length ? new Map(snap.map((s) => [s.customer_id, s.band as HealthBand])) : null,
    prev,
    config,
  };
}

function bandCell(band: HealthBand): Cell {
  return { t: BAND_WORD[band].word, pill: BAND_WORD[band].tone };
}

/** Why a customer carries no band, in words. */
function noBandCell(r: BookRow): Cell {
  if (r.status === "deactivated") return { t: "Deactivated", pill: "muted" };
  if (r.thirdParty) return { t: "Third party", pill: "muted" };
  if (!r.lastOrderDate) return { t: "Never ordered", pill: "muted" };
  return { t: "No band", pill: "muted" };
}

/* ------------------------------------------------------------------ table */

const ASSIGN_KEY = "assign";

async function assignAct(): Promise<ActSpec> {
  const config = await getConfig();
  const reasons = (config["people.amChangeReasons"] as string[]) ?? [];
  return {
    key: ASSIGN_KEY,
    label: "Assign",
    confirm: "The customer is put in the chosen telecaller's book from today.",
    done: "Assigned",
    form: {
      title: "Assign this customer",
      sub: "Moves the salesperson seat — whose book the customer is in and whose numbers it counts towards.",
      submit: "Assign",
      consequence: "The customer is put in the chosen telecaller's book from today. Both people are told.",
      fields: [
        { k: "person", label: "Put in the book of", type: "person", search: "staff", req: true },
        {
          k: "reason",
          label: "Why it moves",
          type: "select",
          req: true,
          options: reasons.map((r) => ({ v: r, l: r })),
        },
        { k: "note", label: "Note", type: "area", cond: "needed when the reason is Other" },
      ],
    },
  };
}

async function everyDef(book: Book): Promise<TableDef> {
  return {
    key: "every",
    title: "Every customer",
    hint: book.before
      ? `Now · band movement since ${dayMonth(book.prev.end, book.prev.end.slice(0, 4))}`
      : `Now · no month-end reading for ${monthLabel(book.prev.key)} yet, so From shows the band now`,
    cols: [
      ["Customer", "1.6fr"],
      ["From", "0.9fr"],
      ["To", "0.9fr"],
      ["Last order", "0.9fr"],
      ["Cycle", "0.7fr", true],
      ["Salesperson", "1.1fr"],
    ],
    noun: "customer",
    rec: "Customer",
    acts: [await assignAct()],
    actW: "100px",
  };
}

type Ranked = { row: BookRow; from: HealthBand | null; to: HealthBand | null; order: number };

/** Movers first — slipping before recovering — then everybody else by name. */
function ranked(book: Book): Ranked[] {
  const out: Ranked[] = book.rows.map((row) => {
    const to = book.banded.get(row.id)?.band ?? null;
    const from = to ? (book.before?.get(row.id) ?? to) : null;
    const order = !to || !from || from === to ? 2 : RANK[to] > RANK[from] ? 0 : 1;
    return { row, from, to, order };
  });
  return out.sort((a, b) => a.order - b.order || a.row.name.localeCompare(b.row.name));
}

function toRow(r: Ranked, thisYear: string): Row {
  const noBand = noBandCell(r.row);
  return {
    id: r.row.id,
    cells: [
      { t: r.row.name, sub: r.row.city ?? undefined },
      r.from ? bandCell(r.from) : noBand,
      r.to ? bandCell(r.to) : noBand,
      { t: r.row.lastOrderDate ? dayMonth(r.row.lastOrderDate, thisYear) : "Never" },
      r.row.lastOrderDate
        ? { t: `${num(r.row.cycleDays)} days`, sub: r.row.measured ? undefined : "not measured" }
        : { t: "—" },
      { t: r.row.salesperson ?? "Nobody" },
    ],
  };
}

function pageOf(book: Book, ctx: Ctx, query: TableQuery): TablePage {
  const s = slice(ranked(book), query, (r, q) =>
    r.row.name.toLowerCase().includes(q) || (r.row.city ?? "").toLowerCase().includes(q),
  );
  const thisYear = ctx.period.today.slice(0, 4);
  return { rows: s.rows.map((r) => toRow(r, thisYear)), count: s.count, total: s.total, page: s.page, size: query.size, q: query.q };
}

/* ---------------------------------------------------------------- metrics */

function counts(book: Book) {
  const now: Record<HealthBand, number> = { active: 0, "at-risk": 0, dormant: 0, lost: 0 };
  for (const b of book.bandedList) now[b.band]++;
  let healthyBefore = 0;
  let movedIntoSlowing = 0;
  if (book.before) {
    for (const band of book.before.values()) if (band === "active") healthyBefore++;
    for (const b of book.bandedList) {
      const was = book.before.get(b.customerId);
      if (b.band === "at-risk" && was && was !== "at-risk") movedIntoSlowing++;
    }
  }
  return { now, healthyBefore, movedIntoSlowing };
}

function metricsOf(book: Book): Metric[] {
  const c = counts(book);
  const since = dayMonth(book.prev.end, book.prev.end.slice(0, 4));
  const lapsed = c.now.dormant + c.now.lost;
  const d = c.now.active - c.healthyBefore;
  return [
    {
      key: "active",
      label: "Active customers",
      value: num(book.bandedList.length),
      sub: `with a health band, of ${num(book.rows.length)}`,
      kind: "Now",
    },
    {
      key: "healthy",
      label: "Healthy",
      value: num(c.now.active),
      sub: book.before
        ? d === 0
          ? `no change since ${since}`
          : `${d > 0 ? "▲" : "▼"} ${num(Math.abs(d))} since ${since}`
        : `no reading at ${since} to compare`,
      kind: "Now",
      tone: "good",
    },
    {
      key: "slowing",
      label: "Slowing",
      value: num(c.now["at-risk"]),
      sub: book.before
        ? c.movedIntoSlowing
          ? `▼ ${num(c.movedIntoSlowing)} moved in since ${since}`
          : `none moved in since ${since}`
        : `no reading at ${since} to compare`,
      kind: "Now",
      tone: "warn",
    },
    {
      key: "lapsed",
      label: "Lapsed",
      value: num(lapsed),
      sub: `past ${multiplierWords(Number(book.config["inactive.cycleMultiplier"]))} their buying cycle`,
      kind: "Now",
      tone: "bad",
    },
    {
      key: "never",
      label: "Never ordered",
      value: num(book.neverOrdered),
      sub: "no band — not zero",
      kind: "Now",
    },
  ];
}

/* ----------------------------------------------------------------- figure */

const DEFS: Record<string, string> = {
  active:
    "Customers with a health band today: not deactivated, not third-party, with a last order and a buying cycle. A customer who has never ordered has no band.",
  healthy:
    "Customers who have gone less than their at-risk multiple of their own buying cycle since their last order — the Reports app's Active band.",
  slowing:
    "Customers past the at-risk multiple of their own buying cycle but not yet past the dormant one — the Reports app's At risk band.",
  lapsed:
    "Customers past the dormant multiple of their own buying cycle — the Reports app's Dormant and Lost bands together. Dormant is the same point at which the CRM marks a customer inactive.",
  never: "Customers with no counting order ever. They have no band, which is not the same as zero.",
};

const TITLES: Record<string, string> = {
  active: "Active customers",
  healthy: "Healthy",
  slowing: "Slowing",
  lapsed: "Lapsed",
  never: "Never ordered",
};

const IN_METRIC: Record<string, (b: HealthBand) => boolean> = {
  active: () => true,
  healthy: (b) => b === "active",
  slowing: (b) => b === "at-risk",
  lapsed: (b) => b === "dormant" || b === "lost",
};

async function snapshotBars(metric: string, today: string, current: number): Promise<Bar[]> {
  const months = lastTwelveMonths(today);
  const rows = await db.execute<{ period: string; band: string; n: number }>(sql`
    select s.period, s.band, count(*)::int as n
      from customer_health_snapshots s
     where s.period >= ${months[0]} and s.period < ${months[11]}
     group by s.period, s.band
  `);
  const by = new Map<string, number>();
  const pred = IN_METRIC[metric];
  for (const r of rows) {
    if (!pred(r.band as HealthBand)) continue;
    by.set(r.period, (by.get(r.period) ?? 0) + Number(r.n));
  }
  const bars: Bar[] = [];
  for (const m of months.slice(0, 11)) {
    if (by.has(m)) bars.push({ h: by.get(m)!, tip: `${monthLabel(m)} · ${num(by.get(m)!)} at month end` });
  }
  bars.push({ h: current, tip: `${monthLabel(months[11])} · ${num(current)} now`, current: true });
  return bars;
}

/* ----------------------------------------------------------------- record */

/** A customer's story: CRM timeline plus the shared timeline events, newest first. */
export async function customerStory(customerId: string, limit = 20): Promise<{ what: string; when: string }[]> {
  const [page, events] = await Promise.all([
    customerTimeline(customerId, { limit }),
    db.execute<{ at: string; summary: string | null; event_type: string; actor: string | null }>(sql`
      select e.occurred_at as at, e.summary, e.event_type, u.name as actor
        from timeline_events e
        left join users u on u.id = e.actor_user_id
       where e.customer_id = ${customerId}
       order by e.occurred_at desc
       limit ${limit}
    `),
  ]);
  const all = [
    ...page.entries.map((e) => ({
      at: new Date(e.at).getTime(),
      what: `${e.content}${e.meta ? ` · ${e.meta}` : ""}`,
      when: `${stampIST(e.at)} · ${e.actor}`,
    })),
    ...events.map((e) => ({
      at: new Date(e.at).getTime(),
      what: e.summary || e.event_type.replace(/[_.]/g, " ").replace(/^./, (c) => c.toUpperCase()),
      when: `${stampIST(e.at)}${e.actor ? ` · ${e.actor}` : ""}`,
    })),
  ];
  return all
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ what, when }) => ({ what, when }));
}

async function customerRecord(ctx: Ctx, id: string): Promise<RecordView> {
  const [rows, config] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select c.id, c.name, c.city, c.region, c.area, c.contact_person, c.phone, c.email, c.gstin,
             c.kind::text as kind, c.status::text as status, c.third_party,
             to_char(c.last_order_date, 'YYYY-MM-DD') as last_order_date, c.last_order_value,
             c.cycle_days, c.cycle_confidence, c.outstanding, c.credit_term_days, c.credit_limit_paise,
             to_char(c.customer_since, 'YYYY-MM-DD') as customer_since,
             to_char((c.created_at at time zone ${TZ})::date, 'YYYY-MM-DD') as created_on,
             c.customer_type::text as customer_type, c.slow_payer, c.do_not_contact,
             coalesce(c.sales_person_name, su.name) as salesperson,
             coalesce(bu.name, c.back_office_name) as back_office,
             coalesce(mu.name, c.sales_manager_person_name) as sales_manager,
             ru.name as relationship_owner
        from customers c
        left join users su on su.id = c.sales_am_id
        left join users bu on bu.id = c.back_office_am_id
        left join users mu on mu.id = c.sales_manager_id
        left join users ru on ru.id = c.relationship_owner_id
       where c.id = ${id}
    `),
    getConfig(),
  ]);
  const c = rows[0];
  if (!c) throw new Error("That customer is no longer on MahekOne.");
  const s = (k: string) => (c[k] === null || c[k] === undefined ? null : String(c[k]));
  const today = ctx.period.today;
  const cycleDays = Number(c.cycle_days ?? 0);
  const eligible = s("status") !== "deactivated" && s("kind") === "customer" && !c.third_party;
  const band = eligible ? bandFor({ lastOrderDate: s("last_order_date"), cycleDays }, today, config) : null;
  const expected =
    s("last_order_date") && cycleDays > 0
      ? (() => {
          const [y, m, d] = s("last_order_date")!.split("-").map(Number);
          const t = new Date(Date.UTC(y, m - 1, d + cycleDays));
          return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
        })()
      : null;

  const healthLine = band
    ? `${BAND_WORD[band.band].word} — the Reports band is ${BAND_REAL[band.band]}: ${band.cyclesElapsed.toFixed(2)} cycles since the last order${band.daysOverdue ? `, ${plural(band.daysOverdue, "day")} past due` : ""}`
    : s("status") === "deactivated"
      ? "No band — the account is deactivated"
      : c.third_party
        ? "No band — a third-party shop, billed through a distributor"
        : !s("last_order_date")
          ? "No band — never ordered"
          : "No band";

  const statusWord: Record<string, string> = { active: "Active", inactive: "Inactive", deactivated: "Deactivated" };
  const fields = [
    { label: "Customer", value: s("name")! },
    { label: "Town", value: [s("city"), s("area"), s("region")].filter(Boolean).join(" · ") || "Not recorded" },
    { label: "Contact", value: [s("contact_person"), s("phone"), s("email")].filter(Boolean).join(" · ") || "Not recorded" },
    { label: "Health", value: healthLine },
    {
      label: "Last order",
      value: s("last_order_date")
        ? `${fmtDate(s("last_order_date"))}${Number(c.last_order_value ?? 0) > 0 ? ` · ${inr(Number(c.last_order_value))} with GST` : ""}`
        : "Never ordered",
    },
    {
      label: "Buying cycle",
      value: cycleDays
        ? `${plural(cycleDays, "day")} · ${c.cycle_confidence !== null ? `measured, ${Number(c.cycle_confidence)}% confidence` : "not measured — the configured default, not a due date"}`
        : "Not known",
    },
    { label: "Next order expected", value: expected && c.cycle_confidence !== null ? fmtDate(expected) : "Not predicted — the cycle is not measured" },
    { label: "Outstanding", value: `${inr(Number(c.outstanding ?? 0))} with GST · stated bills after confirmed receipts` },
    { label: "Credit term", value: c.credit_term_days != null ? plural(Number(c.credit_term_days), "day") : "The company default" },
    { label: "Salesperson", value: s("salesperson") ?? "Nobody" },
    { label: "Back office", value: s("back_office") ?? "Nobody" },
    { label: "Sales manager", value: s("sales_manager") ?? "Nobody" },
    { label: "Relationship owner", value: s("relationship_owner") ?? "Nobody" },
    { label: "Status", value: statusWord[s("status") ?? ""] ?? "Not recorded" },
    { label: "Third party", value: c.third_party ? "Yes — delivered to, billed through a distributor" : "No" },
    { label: "Slow payer", value: c.slow_payer ? "Yes" : "No" },
    { label: "Do not contact", value: c.do_not_contact ? "Yes" : "No" },
    { label: "GSTIN", value: s("gstin") ?? "Not recorded" },
    { label: "Customer since", value: fmtDate(s("customer_since") ?? s("created_on")) },
  ];

  const [notes, story, audit, act] = await Promise.all([
    notesFor("customer", id),
    customerStory(id),
    auditFor("customer", id),
    assignAct(),
  ]);
  return {
    kind: "Customer · Customers",
    title: s("name")!,
    sub: [s("city"), band ? BAND_WORD[band.band].word : null, s("salesperson") ? `Salesperson ${s("salesperson")}` : "No salesperson"]
      .filter(Boolean)
      .join(" · "),
    fields,
    timeline: [...notes, ...story],
    audit,
    acts: [act],
    href: { label: "Open in the CRM", url: `/crm/customers/${id}` },
    noteTarget: { kind: "customer", id },
  };
}

/* --------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(ctx) {
    const book = await loadBook(ctx.period.today);
    const def = await everyDef(book);
    return {
      metrics: metricsOf(book),
      callouts: [],
      tables: [withPage(def, pageOf(book, ctx, { q: "", page: 1, size: 25 }))],
      foot: "A customer who has never ordered has no band, and an unmeasured buying cycle is not a due date.",
    };
  },

  async tablePage(ctx, table, query) {
    if (table !== "every") throw new Error(`No table called ${table}.`);
    return pageOf(await loadBook(ctx.period.today), ctx, query);
  },

  async figure(ctx, metric): Promise<FigureDrawer> {
    if (!TITLES[metric]) throw new Error(`No figure called ${metric}.`);
    const book = await loadBook(ctx.period.today);
    const m = metricsOf(book).find((x) => x.key === metric)!;
    const asOf = stampIST(new Date());
    const facts = [
      { label: "Kind", value: "As of now" },
      { label: "Basis", value: "Count of customers, each against their own buying cycle" },
      { label: "Scope", value: "Company-wide · every customer" },
      { label: "Source", value: "Customer health — the Reports app's bands" },
      { label: "As of", value: asOf },
    ];
    const thisYear = ctx.period.today.slice(0, 4);

    if (metric === "never") {
      const rows = await db.execute<{ name: string; city: string | null; created_on: string; who: string | null }>(sql`
        select c.name, c.city,
               to_char((c.created_at at time zone ${TZ})::date, 'YYYY-MM-DD') as created_on,
               coalesce(c.sales_person_name, u.name) as who
          from customers c left join users u on u.id = c.sales_am_id
         where c.kind = 'customer' and c.status <> 'deactivated' and not c.third_party
           and c.last_order_date is null
         order by c.created_at desc limit 8
      `);
      return {
        kind: "Now figure · Customers",
        title: TITLES[metric],
        value: m.value,
        facts,
        def: DEFS[metric],
        bars: [],
        barsLabel: "No history is kept for this figure",
        rowsLabel: `Records behind it · customers who have never ordered · ${num(book.neverOrdered)} in all`,
        rows: rows.map((r) => ({
          a: r.name,
          b: [r.city, r.who ?? "No salesperson"].filter(Boolean).join(" · "),
          c: `added ${fmtDate(r.created_on)}`,
        })),
        noRowsLine: rows.length ? undefined : "Every customer on the book has ordered at least once.",
      };
    }

    const pred = IN_METRIC[metric];
    const behind = book.bandedList
      .filter((b) => pred(b.band))
      .sort((a, b) => b.cyclesElapsed - a.cyclesElapsed);
    const pick = metric === "healthy" ? [...behind].reverse() : behind;
    const current = behind.length;
    const bars = await snapshotBars(metric, ctx.period.today, current);
    const cities = new Map(book.rows.map((r) => [r.id, r.city]));
    return {
      kind: "Now figure · Customers",
      title: TITLES[metric],
      value: m.value,
      facts,
      def: DEFS[metric],
      bars,
      barsLabel:
        bars.length > 1
          ? "At the end of each month, from the nightly snapshot · the running month as of now · months before the first snapshot are not shown"
          : "Only the reading now — no month-end snapshot has been kept yet",
      rowsLabel: `Records behind it · every customer · ${num(book.rows.length)} in all`,
      rows: pick.slice(0, 8).map((b) => ({
        a: b.name,
        b: [cities.get(b.customerId), b.lastOrderDate ? `last order ${dayMonth(b.lastOrderDate, thisYear)}` : null, b.ownerName ?? "Nobody"]
          .filter(Boolean)
          .join(" · "),
        c: `${BAND_WORD[b.band].word}${b.daysOverdue ? ` · ${plural(b.daysOverdue, "day")} past due` : ""}`,
      })),
      noRowsLine: pick.length ? undefined : "No customer is in this band today.",
    };
  },

  async record(ctx, table, id) {
    if (table !== "every") throw new Error(`No table called ${table}.`);
    return customerRecord(ctx, id);
  },

  async act(_ctx, table, act, id, input) {
    if (table !== "every" || act !== ASSIGN_KEY) return { ok: false, error: "That action is not offered here." };
    const person = String(input.person ?? "").trim();
    const reason = String(input.reason ?? "").trim();
    const note = String(input.note ?? "").trim();
    const fe: Record<string, string> = {};
    if (!person) fe.person = "Pick whose book it goes into.";
    if (!reason) fe.reason = "Pick why it moves.";
    if (/^other$/i.test(reason) && !note) fe.note = "Say why — Other needs a note.";
    if (Object.keys(fe).length) return { ok: false, error: Object.values(fe)[0], fieldErrors: fe };
    try {
      const [who] = await db.execute<{ customer: string | null; person: string | null }>(sql`
        select (select name from customers where customers.id = ${id}) as customer,
               (select name from users where users.id = ${person}) as person
      `);
      if (!who?.customer) return { ok: false, error: "That customer is no longer on MahekOne." };
      const r = await updateAccountManagers({
        customerIds: [id],
        salesAmId: person,
        sales: { reasonCode: reason, note: note || undefined },
      });
      const x = r as { ok: boolean; fieldErrors?: { field: string; message: string }[] };
      if (!x.ok && x.fieldErrors) {
        x.fieldErrors = x.fieldErrors.map((f) => ({
          field: f.field === "sales.reasonCode" ? "reason" : f.field === "salesAmId" ? "person" : f.field,
          message: f.message,
        }));
      }
      return fromOwning(x, `Assigned · ${who.customer} to ${who.person ?? "the chosen person"}`);
    } catch (e) {
      return refusal(e);
    }
  },
};
