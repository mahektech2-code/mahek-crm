import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { addMonths, endOfMonth, type DateRange } from "@/lib/business-date";
import { matchKey } from "@/lib/catalogue";
import { getConfig } from "@/lib/config/store";
import { billSize, conversionFor, frequency, type Conversion } from "@/lib/engines/owner-kpis";
import { orderCountsSql } from "@/lib/order-status";
import { CREDIT_SEAT_LABELS, CREDITED_TO_SEAT_SQL, CREDITED_TO_SQL, creditedToSql, type CreditSeat } from "@/lib/sales-attribution";
import { approveOrderAction, declineOrderAction } from "@/lib/actions/orders";
import { orderLines, pendingOrders, type PendingOrder } from "@/lib/services/order-approval-service";
import { leadsCreatedIn, salesFigures } from "@/lib/services/owner-dashboard-service";
import { loadCatalogue, orderLinesOf } from "@/lib/services/performance-service";
import {
  auditFor,
  emptyPage,
  notesFor,
  refusal,
  fromOwning,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { change, crore, fmtDate, fmtDay, inr, monthLabel, num, plural, span, waited } from "../format";
import type {
  ActSpec,
  Callout,
  Cell,
  Fact,
  FigureDrawer,
  Metric,
  RecordView,
  Result,
  Row,
  SectionPayload,
  TableDef,
  TablePage,
  Tone,
} from "../types";

/* ---------------------------------------------------------------------------
 * SALES & ORDER BOOK (PRD §9).
 *
 * Every figure is the owner's own reading — `salesFigures` and
 * `leadsCreatedIn` from the Reports app, the same `billSize`, `frequency` and
 * `conversionFor` engines it scores them with — and every order decision is
 * Accounts' own `approveOrderAction` / `declineOrderAction`. The volume is
 * the performance module's reading of an order's lines (`orderLinesOf` over
 * `loadCatalogue`), so the litres here cannot count one order two ways from
 * the litres a salesman is scored on.
 * ------------------------------------------------------------------------- */

const TITLE = "Sales & order book";
const SCOPE = "Company-wide · every customer";
const ZONE = "Asia/Kolkata";

/* ------------------------------------------------------------------ words */

const SOURCE_WORD: Record<string, string> = {
  crm: "Call",
  mbos: "Field",
  external: "Sheet import",
  erp: "ERP",
};

function orderLabel(orderNo: string | null, externalRef: string | null): string {
  if (orderNo) return orderNo;
  if (externalRef) return externalRef.startsWith("SHEET-") ? `Order ${externalRef.slice(6)}` : externalRef;
  return "Unnumbered";
}

function statusCell(status: string, cancelled: boolean, unattributed: boolean): Cell {
  const word = statusWord(status, cancelled);
  if (unattributed && !cancelled && !["pending_approval", "declined"].includes(status)) {
    return { t: "Unattributed", pill: "bad", sub: word.t };
  }
  return word;
}

function statusWord(status: string, cancelled: boolean): Cell {
  if (cancelled) return { t: "Cancelled", pill: "muted" };
  switch (status) {
    case "pending_approval":
      return { t: "Waiting on accounts", pill: "warn" };
    case "declined":
      return { t: "Declined", pill: "bad" };
    case "confirmed":
      return { t: "Approved", pill: "good" };
    case "captured":
      return { t: "Accepted", pill: "good", sub: "before approval existed" };
    case "dispatched":
      return { t: "Dispatched", pill: "good" };
    case "in_transit":
      return { t: "In transit", pill: "info" };
    case "delivered":
      return { t: "Delivered", pill: "good" };
    default:
      return { t: "Unknown status", pill: "muted" };
  }
}

/** A day window with its zone named — the owner dashboard's own spelling. */
function win(range: DateRange) {
  return {
    start: sql.raw(`'${range.from} 00:00:00+05:30'::timestamptz`),
    end: sql.raw(`'${range.to} 23:59:59.999+05:30'::timestamptz`),
  };
}

function rangeOf(ctx: Ctx): DateRange {
  return { from: ctx.period.from, to: ctx.period.to };
}

function compareOf(ctx: Ctx): DateRange {
  return { from: ctx.period.compareFrom, to: ctx.period.compareTo };
}

/** The twelve months ending with the period's month, oldest first. */
function twelveMonths(ctx: Ctx): string[] {
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) out.push(addMonths(ctx.period.monthKey, -i));
  return out;
}

function monthsRange(months: string[], ctx: Ctx): DateRange {
  const last = months[months.length - 1];
  const end = endOfMonth(last);
  return { from: `${months[0]}-01`, to: end < ctx.period.to ? end : ctx.period.to };
}

function litres(ml: number): string {
  return `${num(Math.round(ml / 1000))} L`;
}

/* --------------------------------------------------------------- volume */

type Volume = { ml: number; unmatchedPaise: number; byMonth: Map<string, number> };

/**
 * Litres sold in a window: counting orders, their lines read exactly as the
 * score reads them (`orderLinesOf`), matched on the catalogue's own key.
 */
async function volumeIn(range: DateRange): Promise<Volume> {
  const w = win(range);
  const [catalogue, rows] = await Promise.all([
    loadCatalogue(),
    db.execute<{ line_items: unknown; call_id: string | null; month: string }>(sql`
      select o.line_items, o.call_id,
             to_char(o.ordered_at at time zone ${sql.raw(`'${ZONE}'`)}, 'YYYY-MM') as month
        from orders o
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
    `),
  ]);
  const callIds = rows
    .filter((r) => r.call_id && !Array.isArray(r.line_items))
    .map((r) => r.call_id as string);
  const crmByCall = new Map<string, { product_id: string; quantity: number }[]>();
  for (let i = 0; i < callIds.length; i += 1000) {
    const chunk = callIds.slice(i, i + 1000);
    const lines = await db.execute<{ interaction_id: string; product_id: string; quantity: number }>(sql`
      select ipl.interaction_id, ipl.product_id, ipl.quantity
        from interaction_product_lines ipl
       where ipl.interaction_id in (${sql.join(
         chunk.map((c) => sql`${c}`),
         sql`, `,
       )})
    `);
    for (const l of lines) {
      const list = crmByCall.get(l.interaction_id) ?? [];
      list.push({ product_id: l.product_id, quantity: Number(l.quantity) });
      crmByCall.set(l.interaction_id, list);
    }
  }

  let ml = 0;
  let unmatched = 0;
  const byMonth = new Map<string, number>();
  for (const row of rows) {
    for (const line of orderLinesOf(row, crmByCall)) {
      const facts =
        (line.productId ? catalogue.byId.get(line.productId) : undefined) ??
        (line.product ? catalogue.byName.get(matchKey(line.product)) : undefined);
      if (!facts) {
        unmatched += Math.max(0, line.amount);
        continue;
      }
      const m = facts.millilitresPerCan ? Math.round(line.quantity * facts.millilitresPerCan) : 0;
      ml += m;
      byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + m);
    }
  }
  return { ml, unmatchedPaise: unmatched, byMonth };
}

/* ---------------------------------------------------------------- tables */

const APPROVE: ActSpec = {
  key: "approve",
  label: "Approve",
  confirm: "It is confirmed, counts towards revenue and targets, and goes to dispatch.",
  done: "Approved",
};

const DECLINE: ActSpec = {
  key: "decline",
  label: "Decline",
  tone: "bad",
  confirm: "The customer is told through the telecaller and the order leaves every total.",
  done: "Declined",
  form: {
    title: "Decline this order",
    sub: "Whoever took it is told, with your reason, so they can ring the customer back.",
    submit: "Decline order",
    consequence: "The customer is told through the telecaller and the order leaves every total.",
    fields: [
      {
        k: "reason",
        label: "Why it is being declined",
        type: "area",
        req: true,
        ph: "Over the credit limit",
        hint: "The telecaller reads this out to the customer.",
      },
    ],
  },
};

const WAITING_DEF: TableDef = {
  key: "waiting",
  title: "Orders waiting on a decision",
  hint: "Now · oldest first · you decide them here",
  cols: [
    ["Order", "1.1fr"],
    ["Customer", "1.5fr"],
    ["Owes now", "0.9fr", true],
    ["Value", "0.9fr", true],
    ["Waiting", "0.8fr"],
  ],
  noun: "order",
  rec: "Order",
  acts: [APPROVE, DECLINE],
};

const FUNNEL_DEF: TableDef = {
  key: "funnel",
  title: "Lead funnel",
  hint: "",
  cols: [
    ["Stage", "1.4fr"],
    ["Leads", "0.7fr", true],
    ["Share", "0.7fr", true],
    ["Change", "0.8fr", true],
    ["Note", "2fr"],
  ],
  noun: "stage",
  rec: "Stage",
};

const ORDERS_DEF: TableDef = {
  key: "orders",
  title: "Every order this period",
  hint: "With GST · newest first",
  cols: [
    ["Order", "1.1fr"],
    ["Customer", "1.6fr"],
    ["Credited to", "1.2fr"],
    ["Source", "0.8fr"],
    ["Value", "0.9fr", true],
    ["Status", "0.9fr"],
  ],
  noun: "order",
  rec: "Order",
  acts: [APPROVE, DECLINE],
};

/* ---- waiting on a decision ---- */

type Waiting = PendingOrder & { label: string; source: string };

async function waitingList(): Promise<Waiting[]> {
  const pending = await pendingOrders();
  if (!pending.length) return [];
  const ids = pending.map((p) => p.orderId);
  const extra = await db.execute<{ id: string; order_no: string | null; external_ref: string | null; source: string }>(sql`
    select o.id, o.order_no, o.external_ref, o.source::text as source
      from orders o
     where o.id in (${sql.join(
       ids.map((i) => sql`${i}`),
       sql`, `,
     )})
  `);
  const byId = new Map(extra.map((e) => [e.id, e]));
  return pending.map((p) => {
    const e = byId.get(p.orderId);
    return {
      ...p,
      label: orderLabel(e?.order_no ?? null, e?.external_ref ?? null),
      source: SOURCE_WORD[e?.source ?? ""] ?? "Unknown",
    };
  });
}

function waitingTone(hours: number, staleHours: number): Tone {
  if (hours > staleHours * 2) return "bad";
  if (hours > staleHours) return "warn";
  return "muted";
}

async function waitingPage(query: TableQuery): Promise<TablePage> {
  const [all, config] = await Promise.all([waitingList(), getConfig()]);
  const stale = Number(config["payments.confirmationAgeWarningHours"]);
  const s = slice(all, query, (r, q) =>
    [r.label, r.customerName, r.customerCity, r.takenByName ?? ""].some((v) => v.toLowerCase().includes(q)),
  );
  return {
    rows: s.rows.map<Row>((r) => ({
      id: r.orderId,
      cells: [
        { t: r.label, sub: `${fmtDay(isoDay(r.orderedAt))} · ${r.source.toLowerCase()}` },
        { t: r.customerName, sub: [r.customerCity, r.takenByName ?? "from the order sheet"].filter(Boolean).join(" · ") },
        { t: inr(r.outstanding) },
        { t: inr(r.totalAmount) },
        { t: waited(r.waitingHours), pill: waitingTone(r.waitingHours, stale) },
      ],
    })),
    count: s.count,
    total: s.total,
    page: s.page,
    size: query.size,
    q: query.q,
  };
}

function isoDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/* ---- every order this period ---- */

function searchClause(q: string): SQL {
  const t = q.trim();
  if (t.length < 2) return sql`true`;
  const like = `%${t.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return sql`(c.name ilike ${like} or coalesce(c.city, '') ilike ${like}
             or coalesce(o.order_no, '') ilike ${like} or coalesce(o.external_ref, '') ilike ${like}
             or coalesce(cu.name, '') ilike ${like})`;
}

async function ordersPage(ctx: Ctx, query: TableQuery): Promise<TablePage> {
  const w = win(rangeOf(ctx));
  const where = searchClause(query.q);
  const [counts, rows] = await Promise.all([
    db.execute<{ total: number; matched: number }>(sql`
      select count(*)::int as total, count(*) filter (where ${where})::int as matched
        from orders o
        join customers c on c.id = o.customer_id
        left join users cu on cu.id = ${creditedToSql("c")}
       where o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
    `),
    db.execute<{
      id: string;
      order_no: string | null;
      external_ref: string | null;
      source: string;
      status: string;
      cancelled: boolean;
      ordered_on: string;
      total_amount: string;
      customer: string;
      city: string | null;
      credited: string | null;
      credited_id: string | null;
    }>(sql`
      select o.id, o.order_no, o.external_ref, o.source::text as source, o.status::text as status,
             o.cancelled_at is not null as cancelled,
             to_char(o.ordered_at at time zone ${sql.raw(`'${ZONE}'`)}, 'YYYY-MM-DD') as ordered_on,
             o.total_amount, c.name as customer, c.city,
             cu.name as credited, ${creditedToSql("c")} as credited_id
        from orders o
        join customers c on c.id = o.customer_id
        left join users cu on cu.id = ${creditedToSql("c")}
       where o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
         and ${where}
       order by o.ordered_at desc, o.id desc
       limit ${query.size} offset ${(query.page - 1) * query.size}
    `),
  ]);
  const matched = Number(counts[0]?.matched ?? 0);
  const pages = Math.max(1, Math.ceil(matched / query.size));
  return {
    rows: rows.map<Row>((r) => {
      const pending = r.status === "pending_approval" && !r.cancelled;
      return {
        id: r.id,
        cells: [
          { t: orderLabel(r.order_no, r.external_ref), sub: fmtDay(r.ordered_on) },
          { t: r.customer, sub: r.city ?? undefined },
          r.credited_id ? { t: r.credited ?? "Somebody no longer listed" } : { t: "Nobody" },
          { t: SOURCE_WORD[r.source] ?? "Unknown" },
          { t: inr(Number(r.total_amount)) },
          statusCell(r.status, r.cancelled, !r.credited_id),
        ],
        acts: pending ? ["approve", "decline"] : [],
      };
    }),
    count: matched,
    total: Number(counts[0]?.total ?? 0),
    page: Math.min(query.page, pages),
    size: query.size,
    q: query.q,
  };
}

/* ---- the funnel ---- */

type FunnelRead = {
  now: Conversion;
  before: Conversion;
  createdNow: number;
  createdBefore: number;
  contactedNow: number;
  contactedBefore: number;
};

const CONTACTED = new Set(["contacted", "qualified", "negotiation", "won", "lost"]);

async function funnelRead(ctx: Ctx): Promise<FunnelRead> {
  const [config, leadsNow, leadsBefore] = await Promise.all([
    getConfig(),
    leadsCreatedIn(rangeOf(ctx), {}),
    leadsCreatedIn(compareOf(ctx), {}),
  ]);
  const contacted = (rows: typeof leadsNow) =>
    rows.filter((l) => (l.stage !== null && CONTACTED.has(l.stage)) || l.firstOrderOn !== null).length;
  return {
    now: conversionFor(leadsNow, ctx.period.today, config),
    before: conversionFor(leadsBefore, ctx.period.today, config),
    createdNow: leadsNow.length,
    createdBefore: leadsBefore.length,
    contactedNow: contacted(leadsNow),
    contactedBefore: contacted(leadsBefore),
  };
}

function share(n: number, of: number): number | null {
  return of ? Math.round((n / of) * 1000) / 10 : null;
}

function funnelRows(f: FunnelRead): Row[] {
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
  const ptsChange = (n: number, nOf: number, b: number, bOf: number) =>
    change(share(n, nOf), share(b, bOf), true).text;
  const created = change(f.createdNow, f.createdBefore);
  return [
    {
      id: "created",
      cells: [
        { t: "Created" },
        { t: num(f.createdNow) },
        { t: f.createdNow ? "100%" : "—" },
        { t: created.text },
        { t: "Every lead counts in the denominator" },
      ],
    },
    {
      id: "contacted",
      cells: [
        { t: "Contacted" },
        { t: num(f.contactedNow) },
        { t: pct(share(f.contactedNow, f.createdNow)) },
        { t: ptsChange(f.contactedNow, f.createdNow, f.contactedBefore, f.createdBefore) },
        { t: "" },
      ],
    },
    {
      id: "qualified",
      cells: [
        { t: "Qualified" },
        { t: num(f.now.qualified) },
        { t: pct(share(f.now.qualified, f.createdNow)) },
        { t: ptsChange(f.now.qualified, f.createdNow, f.before.qualified, f.createdBefore) },
        { t: "The qualified-lead rate, shown beside conversion" },
      ],
    },
    {
      id: "first-order",
      cells: [
        { t: "First order" },
        { t: num(f.now.converted) },
        { t: pct(f.now.ratePercent) },
        { t: change(f.now.ratePercent, f.before.ratePercent, true).text },
        f.now.stillOpen > 0
          ? {
              t: "Unfinished",
              pill: "warn",
              sub: `${plural(f.now.stillOpen, "lead")} still inside ${f.now.stillOpen === 1 ? "its" : "their"} window`,
            }
          : f.now.leads
            ? { t: "Every lead's window has closed" }
            : { t: "No leads were created in this period" },
      ],
    },
  ];
}

function funnelDef(windowDays: number): TableDef {
  return { ...FUNNEL_DEF, hint: `Cohort · leads created in the period, followed ${windowDays} days` };
}

/* ------------------------------------------------------------- section */

async function readSales(ctx: Ctx) {
  const range = rangeOf(ctx);
  const [config, now, before, vol] = await Promise.all([
    getConfig(),
    salesFigures(range, {}),
    salesFigures(compareOf(ctx), {}),
    volumeIn(range),
  ]);
  return {
    config,
    now,
    before,
    vol,
    sizeNow: billSize(now.grossValuePaise, now.creditNotePaise, now.transactions),
    sizeBefore: billSize(before.grossValuePaise, before.creditNotePaise, before.transactions),
    freqNow: frequency(now.transactions, now.ordersPerCustomer, config),
  };
}

function metricsFrom(ctx: Ctx, r: Awaited<ReturnType<typeof readSales>>): Metric[] {
  const vs = span(ctx.period.compareFrom, ctx.period.compareTo);
  const rev = change(r.now.grossValuePaise, r.before.grossValuePaise);
  const ord = change(r.now.transactions, r.before.transactions);
  const bill = change(r.sizeNow.averagePaise, r.sizeBefore.averagePaise);
  const ordering = r.now.ordersPerCustomer.length;
  return [
    {
      key: "revenue",
      label: "Revenue",
      value: r.now.transactions ? crore(r.now.grossValuePaise) : "None yet",
      sub: rev.text === "No comparison" ? `nothing in ${vs} to compare · with GST` : `${rev.text} vs ${vs} · with GST`,
      kind: "Period",
    },
    {
      key: "orders",
      label: "Orders",
      value: num(r.now.transactions),
      sub: `${ord.text} · ${plural(ordering, "customer")} ordered`,
      kind: "Period",
    },
    {
      key: "bill",
      label: "Average bill",
      value: r.sizeNow.averagePaise === null ? "None yet" : inr(r.sizeNow.averagePaise),
      sub: `${bill.text} · net of credit notes`,
      kind: "Period",
    },
    {
      key: "frequency",
      label: "Order frequency",
      value: r.freqNow.perActiveCustomer === null ? "None yet" : r.freqNow.perActiveCustomer.toFixed(1),
      sub: "orders per ordering customer",
      kind: "Period",
    },
    {
      key: "volume",
      label: "Volume",
      value: litres(r.vol.ml),
      sub: r.vol.unmatchedPaise > 0
        ? `${inr(r.vol.unmatchedPaise)} of lines unmatched`
        : "every line matched a product",
      kind: "Period",
      tone: r.vol.unmatchedPaise > 0 ? "warn" : undefined,
    },
  ];
}

async function priceRevisionCallout(ctx: Ctx): Promise<Callout | null> {
  const w = win(rangeOf(ctx));
  const rows = await db.execute<{ name: string; version: number; published_on: string; n: number }>(sql`
    select p.name, p.version,
           to_char(p.published_at at time zone ${sql.raw(`'${ZONE}'`)}, 'YYYY-MM-DD') as published_on,
           count(*) over ()::int as n
      from price_lists p
     where p.published_at >= ${w.start} and p.published_at <= ${w.end}
       and (p.supersedes_id is not null or p.version > 1)
     order by p.published_at desc
     limit 1
  `);
  const r = rows[0];
  if (!r) return null;
  const n = Number(r.n);
  const list = /\bv\d+\s*$/i.test(r.name) ? r.name : `${r.name} v${r.version}`;
  const lead =
    n === 1
      ? `A price revision was published on ${fmtDay(r.published_on).replace(/^0/, "")} (${list}).`
      : `${num(n)} price revisions were published in this period, the latest on ${fmtDay(r.published_on).replace(/^0/, "")} (${list}).`;
  return {
    tone: "info",
    text: `${lead} Revenue can rise with no extra volume — compare the two before reading growth.`,
  };
}

async function sourceFoot(ctx: Ctx): Promise<string> {
  const w = win(rangeOf(ctx));
  const rows = await db.execute<{ source: string; n: number }>(sql`
    select o.source::text as source, count(*)::int as n
      from orders o
     where ${orderCountsSql("o")}
       and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
     group by 1
  `);
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const lead = "Every figure here is company-wide and follows the period.";
  if (!total) return `${lead} No order counted in this period, so there are no sources to split.`;
  const word: Record<string, string> = { crm: "calls", mbos: "field", external: "order sheet import", erp: "the ERP" };
  const parts = ["crm", "mbos", "external"]
    .map((k) => ({ k, n: Number(rows.find((r) => r.source === k)?.n ?? 0) }))
    .filter((p) => p.n > 0)
    .map((p) => `${word[p.k]} ${Math.round((p.n / total) * 100)}%`);
  return `${lead} Order sources: ${parts.join(", ")}.`;
}

/* --------------------------------------------------------------- drawer */

type MonthRow = { month: string; value: string; n: number; customers: number; credit: string };

async function monthly(ctx: Ctx, months: string[]): Promise<Map<string, MonthRow>> {
  const w = win(monthsRange(months, ctx));
  const [orders, credits] = await Promise.all([
    db.execute<{ month: string; value: string; n: number; customers: number }>(sql`
      select to_char(o.ordered_at at time zone ${sql.raw(`'${ZONE}'`)}, 'YYYY-MM') as month,
             coalesce(sum(o.total_amount), 0) as value, count(*)::int as n,
             count(distinct o.customer_id)::int as customers
        from orders o
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
       group by 1
    `),
    db.execute<{ month: string; credit: string }>(sql`
      select to_char(r.received_at, 'YYYY-MM') as month, coalesce(sum(r.amount), 0) as credit
        from payment_receipts r
       where r.status = 'confirmed'
         and r.idempotency_key like 'creditnote:%'
         and r.received_at >= ${`${months[0]}-01`}::date and r.received_at <= ${ctx.period.to}::date
       group by 1
    `),
  ]);
  const out = new Map<string, MonthRow>();
  for (const m of months) out.set(m, { month: m, value: "0", n: 0, customers: 0, credit: "0" });
  for (const o of orders) {
    const row = out.get(o.month);
    if (row) Object.assign(row, { value: o.value, n: Number(o.n), customers: Number(o.customers) });
  }
  for (const c of credits) {
    const row = out.get(c.month);
    if (row) row.credit = c.credit;
  }
  return out;
}

const FIGURE_KEYS: Record<string, string> = {
  revenue: "revenue",
  orders: "orders",
  bill: "bill",
  "average bill": "bill",
  frequency: "frequency",
  "order frequency": "frequency",
  volume: "volume",
};

const DEFS: Record<string, string> = {
  revenue:
    "Every order that counts as a sale — accepted by accounts, dispatched, in transit or delivered — placed in the period, at its value with GST. Orders waiting on accounts, declined or cancelled count for nothing.",
  orders:
    "How many orders that count as a sale were placed in the period. A credit note never removes an order from this count; it is money given back on a sale that happened.",
  bill:
    "The value of the period's counting orders, with GST, less the credit notes issued in the period, divided by how many orders there were.",
  frequency:
    "Counting orders in the period divided by the customers who placed at least one. Customers who did not order are not in the denominator.",
  volume:
    "Litres in the period's counting orders: cans on each line times the product's own can size. A line whose product name matches nothing in the catalogue adds no litres; its value is shown as unmatched, net of GST as the line records it.",
};

const LABELS: Record<string, string> = {
  revenue: "Revenue",
  orders: "Orders",
  bill: "Average bill",
  frequency: "Order frequency",
  volume: "Volume",
};

async function figureFor(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const key = FIGURE_KEYS[metric.toLowerCase()] ?? "revenue";
  const months = twelveMonths(ctx);
  const range = rangeOf(ctx);
  const w = win(range);
  const periodLine = span(range.from, range.to);

  const [r, monthRows] = await Promise.all([readSales(ctx), monthly(ctx, months)]);
  const value = metricsFrom(ctx, r).find((m) => m.key === key)!.value;

  let bars: FigureDrawer["bars"] = [];
  let basis = "";
  let rowsLabel = "";
  let rows: FigureDrawer["rows"] = [];

  const tip = (m: string, v: string) => `${monthLabel(m)} · ${v}`;
  const current = (i: number) => (i === months.length - 1 ? { current: true } : {});

  if (key === "volume") {
    const vol12 = await volumeIn(monthsRange(months, ctx));
    bars = months.map((m, i) => ({ h: (vol12.byMonth.get(m) ?? 0) / 1000, tip: tip(m, litres(vol12.byMonth.get(m) ?? 0)), ...current(i) }));
    basis = "Litres, from cans × can size";
  } else {
    bars = months.map((m, i) => {
      const x = monthRows.get(m)!;
      const value = Number(x.value);
      const credit = Number(x.credit);
      if (key === "revenue") return { h: value, tip: tip(m, crore(value)), ...current(i) };
      if (key === "orders") return { h: x.n, tip: tip(m, plural(x.n, "order")), ...current(i) };
      if (key === "bill") {
        const avg = x.n ? Math.round((value - credit) / x.n) : 0;
        return { h: avg, tip: tip(m, x.n ? inr(avg) : "no orders"), ...current(i) };
      }
      const f = x.customers ? x.n / x.customers : 0;
      return { h: f, tip: tip(m, x.customers ? f.toFixed(1) : "no orders"), ...current(i) };
    });
    basis =
      key === "revenue"
        ? "With GST"
        : key === "orders"
          ? "Count of orders"
          : key === "bill"
            ? "With GST, net of credit notes"
            : "Orders per ordering customer";
  }

  if (key === "frequency") {
    const top = await db.execute<{ name: string; city: string | null; n: number; value: string }>(sql`
      select c.name, c.city, count(*)::int as n, coalesce(sum(o.total_amount), 0) as value
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
       group by c.id, c.name, c.city
       order by n desc, value desc
       limit 8
    `);
    rowsLabel = "The customers who ordered most often";
    rows = top.map((t) => ({ a: t.name, b: [t.city, inr(Number(t.value))].filter(Boolean).join(" · "), c: plural(Number(t.n), "order") }));
  } else {
    const order =
      key === "orders" ? sql`o.ordered_at desc` : sql`o.total_amount desc, o.ordered_at desc`;
    const top = await db.execute<{ order_no: string | null; external_ref: string | null; name: string; on: string; value: string }>(sql`
      select o.order_no, o.external_ref, c.name,
             to_char(o.ordered_at at time zone ${sql.raw(`'${ZONE}'`)}, 'YYYY-MM-DD') as on,
             o.total_amount as value
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")}
         and o.ordered_at >= ${w.start} and o.ordered_at <= ${w.end}
       order by ${order}
       limit 8
    `);
    rowsLabel = key === "orders" ? "The newest orders behind it" : "The largest orders behind it";
    rows = top.map((t) => ({ a: t.name, b: `${orderLabel(t.order_no, t.external_ref)} · ${fmtDate(t.on)}`, c: inr(Number(t.value)) }));
  }

  return {
    kind: "Period figure · " + (key === "volume" ? "Volume" : key === "orders" || key === "frequency" ? "Count" : "Money"),
    title: LABELS[key],
    value,
    facts: [
      { label: "Kind", value: "Period" },
      { label: "Period", value: periodLine },
      { label: "Basis", value: basis },
      { label: "Scope", value: SCOPE },
      { label: "Source", value: key === "volume" ? "Orders and their lines, matched to the catalogue" : "Orders, and credit notes accounts issued" },
      { label: "As of", value: stampIST(new Date()) },
    ],
    def: DEFS[key],
    bars,
    barsLabel: "The last 12 months, the period's own month last (to date)",
    rowsLabel,
    rows,
    noRowsLine: rows.length ? undefined : "No order counted in this period.",
    section: key === "frequency" ? undefined : "sales",
    sectionLabel: key === "frequency" ? undefined : "Every order this period",
  };
}

/* ---------------------------------------------------------------- record */

type OrderRecord = {
  id: string;
  order_no: string | null;
  external_ref: string | null;
  source: string;
  status: string;
  customer_id: string;
  customer: string;
  city: string | null;
  outstanding: string;
  credit_days: number | null;
  kind: string;
  seat: CreditSeat;
  credited: string | null;
  taken_by: string | null;
  approver: string | null;
  approved_at: string | null;
  decline_reason: string | null;
  ordered_at: string;
  created_at: string;
  total_amount: string;
  net_amount_paise: string | null;
  order_credit_days: number | null;
  payment_due_date: string | null;
  expected_dispatch: string | null;
  customer_confirmed_at: string | null;
  customer_confirmed_note: string | null;
  delivery_confirmed_at: string | null;
  delivery_discrepancy: string | null;
  cancelled_at: string | null;
  price_list: string | null;
  delivered_to: string | null;
  line_items: unknown;
  call_id: string | null;
};

async function readOrder(id: string): Promise<OrderRecord | null> {
  const rows = await db.execute<OrderRecord>(sql`
    select o.id, o.order_no, o.external_ref, o.source::text as source, o.status::text as status,
           customers.id as customer_id, customers.name as customer, customers.city, customers.outstanding,
           customers.credit_days, customers.kind::text as kind,
           ${CREDITED_TO_SEAT_SQL} as seat,
           cu.name as credited, tu.name as taken_by, au.name as approver,
           o.approved_at, o.decline_reason, o.ordered_at, o.created_at, o.total_amount, o.net_amount_paise,
           o.credit_days as order_credit_days,
           to_char(o.payment_due_date, 'YYYY-MM-DD') as payment_due_date,
           to_char(o.expected_dispatch, 'YYYY-MM-DD') as expected_dispatch,
           o.customer_confirmed_at, o.customer_confirmed_note, o.delivery_confirmed_at,
           o.delivery_discrepancy, o.cancelled_at,
           (select pl.name || ' v' || pl.version from price_lists pl where pl.id = o.price_list_id) as price_list,
           (select dc.name from customers dc where dc.id = o.delivery_customer_id) as delivered_to,
           o.line_items, o.call_id
      from orders o
      join customers on customers.id = o.customer_id
      left join users cu on cu.id = ${CREDITED_TO_SQL}
      left join users tu on tu.id = o.user_id
      left join users au on au.id = o.approved_by_id
     where o.id = ${id}
  `);
  return rows[0] ?? null;
}

async function lineFacts(o: OrderRecord): Promise<Fact[]> {
  if (Array.isArray(o.line_items) && o.line_items.length) {
    return (o.line_items as Record<string, unknown>[]).slice(0, 30).map((l, i) => ({
      label: `Line ${i + 1}`,
      value: `${String(l.product ?? "A product")} × ${num(Number(l.quantity ?? 0))} ${Number(l.quantity) === 1 ? "can" : "cans"}${
        Number(l.amount) > 0 ? ` · ${inr(Number(l.amount))}` : ""
      }`,
    }));
  }
  const lines = await orderLines(o.id);
  return lines.slice(0, 30).map((l, i) => ({
    label: `Line ${i + 1}`,
    value: `${l.productName}${l.subtitle ? ` (${l.subtitle})` : ""} × ${plural(l.quantity, "can")}`,
  }));
}

async function orderRecord(id: string): Promise<RecordView> {
  const o = await readOrder(id);
  if (!o) {
    return {
      kind: `Order · ${TITLE}`,
      title: "That order no longer exists",
      sub: "It may have been removed by the order sheet's reconcile.",
      fields: [],
      timeline: [],
      audit: [],
      acts: [],
      noteTarget: { kind: "order", id },
    };
  }
  const label = orderLabel(o.order_no, o.external_ref);
  const cancelled = o.cancelled_at !== null;
  const status = statusWord(o.status, cancelled);
  const pending = o.status === "pending_approval" && !cancelled;
  const decided = o.approved_at && ["confirmed", "declined", "dispatched", "in_transit", "delivered"].includes(o.status);
  const d = (x: string | null) => (x ? stampIST(x) : "—");

  const fields: Fact[] = [
    { label: "Order", value: label },
    { label: "Customer", value: [o.customer, o.city].filter(Boolean).join(", ") },
    { label: "Status", value: status.sub ? `${status.t} — ${status.sub}` : status.t },
    { label: "Came in through", value: o.source === "crm" ? "A call logged in the CRM" : o.source === "mbos" ? "The Salesman App" : o.source === "erp" ? "The ERP's order desk" : "The order sheet" },
    { label: "Ordered", value: d(o.ordered_at) },
    { label: "Value, with GST", value: inr(Number(o.total_amount)) },
    { label: "Value, excl. GST", value: o.net_amount_paise === null ? "Not stated on this order" : inr(Number(o.net_amount_paise)) },
    { label: "Credited to", value: o.credited ? `${o.credited} — ${CREDIT_SEAT_LABELS[o.seat]}` : CREDIT_SEAT_LABELS.none },
    { label: "Taken by", value: o.taken_by ?? (o.source === "external" ? "Nobody in MahekOne — the order sheet wrote it" : "Not recorded") },
    { label: "Customer owes now", value: inr(Number(o.outstanding)) },
    {
      label: "Payment term",
      value:
        o.order_credit_days !== null
          ? `${plural(o.order_credit_days, "day")}, agreed on the order`
          : o.credit_days !== null
            ? `${plural(o.credit_days, "day")}, the customer's standing term`
            : "The default term",
    },
    { label: "Payment due", value: o.payment_due_date ? fmtDate(o.payment_due_date) : "Set by the bill" },
    { label: "Expected dispatch", value: o.expected_dispatch ? fmtDate(o.expected_dispatch) : "Not stated" },
    { label: "Price list", value: o.price_list ?? "None resolved for this order" },
    { label: "Delivered to", value: o.delivered_to ?? "The billing customer" },
  ];
  if (decided || o.status === "declined") {
    fields.push({ label: o.status === "declined" ? "Declined by" : "Approved by", value: `${o.approver ?? "Someone no longer listed"} · ${d(o.approved_at)}` });
  }
  if (o.decline_reason) fields.push({ label: "Why it was declined", value: o.decline_reason });
  fields.push({
    label: "Customer's confirmation",
    value: o.customer_confirmed_at ? `${d(o.customer_confirmed_at)}${o.customer_confirmed_note ? ` — ${o.customer_confirmed_note}` : ""}` : "Not recorded",
  });
  fields.push({ label: "Customer says it arrived", value: o.delivery_confirmed_at ? d(o.delivery_confirmed_at) : "Not recorded" });
  fields.push({ label: "Delivery discrepancy", value: o.delivery_discrepancy ?? "Nobody reported one" });
  if (cancelled) fields.push({ label: "Cancelled", value: d(o.cancelled_at) });
  fields.push(...(await lineFacts(o)));

  const events: { what: string; at: string }[] = [{ what: `Ordered — ${inr(Number(o.total_amount))}`, at: o.ordered_at }];
  if (o.created_at !== o.ordered_at) events.push({ what: "Recorded in MahekOne", at: o.created_at });
  if (o.approved_at) {
    events.push({
      what: o.status === "declined" ? `Declined by ${o.approver ?? "accounts"}${o.decline_reason ? ` — ${o.decline_reason}` : ""}` : `Approved by ${o.approver ?? "accounts"}`,
      at: o.approved_at,
    });
  }
  if (o.customer_confirmed_at) events.push({ what: "The customer confirmed the order", at: o.customer_confirmed_at });
  if (o.delivery_confirmed_at) events.push({ what: "The customer confirmed it arrived", at: o.delivery_confirmed_at });
  if (o.cancelled_at) events.push({ what: "Cancelled", at: o.cancelled_at });
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const [notes, audit] = await Promise.all([notesFor("order", id), auditFor("order", id)]);

  return {
    kind: `Order · ${TITLE}`,
    title: label,
    sub: `${o.customer} · ${fmtDate(isoDay(new Date(o.ordered_at)))} · ${inr(Number(o.total_amount))}`,
    fields,
    timeline: [...notes, ...events.map((e) => ({ what: e.what, when: stampIST(e.at) }))],
    audit,
    acts: pending ? [APPROVE, DECLINE] : [],
    href: pending
      ? { label: "Open in Accounts · Order approvals", url: "/accounts/approvals" }
      : { label: "Open the customer in the CRM", url: `/crm/customers/${o.customer_id}` },
    noteTarget: { kind: "order", id },
  };
}

async function funnelRecord(ctx: Ctx, id: string): Promise<RecordView> {
  const f = await funnelRead(ctx);
  const row = funnelRows(f).find((r) => r.id === id) ?? funnelRows(f)[0];
  const [stage, leads, shareCell, changeCell, note] = row.cells;
  return {
    kind: `Stage · ${TITLE}`,
    title: stage.t,
    sub: `Leads created ${span(ctx.period.from, ctx.period.to)}, followed ${f.now.windowDays} days`,
    fields: [
      { label: "Leads at this stage", value: leads.t },
      { label: "Share of the cohort", value: shareCell.t },
      { label: `Change against ${span(ctx.period.compareFrom, ctx.period.compareTo)}`, value: changeCell.t },
      { label: "Leads in the cohort", value: num(f.createdNow) },
      { label: "Placed a first order in their window", value: num(f.now.converted) },
      { label: "Still inside their window", value: num(f.now.stillOpen) },
      ...(note.t ? [{ label: "Note", value: note.sub ? `${note.t} — ${note.sub}` : note.t }] : []),
    ],
    timeline: [],
    audit: [],
    acts: [],
    noteTarget: { kind: "lead_funnel", id },
  };
}

/* -------------------------------------------------------------- provider */

async function subjectOf(id: string): Promise<string> {
  const rows = await db.execute<{ order_no: string | null; external_ref: string | null; name: string }>(sql`
    select o.order_no, o.external_ref, c.name from orders o join customers c on c.id = o.customer_id where o.id = ${id}
  `);
  const r = rows[0];
  return r ? `${orderLabel(r.order_no, r.external_ref)}, ${r.name}` : "the order";
}

export const provider: SectionProvider = {
  async section(ctx) {
    const first: TableQuery = { q: "", page: 1, size: 25 };
    const [sales, funnel, waiting, orders, revision, foot] = await Promise.all([
      readSales(ctx),
      funnelRead(ctx),
      waitingPage(first),
      ordersPage(ctx, first),
      priceRevisionCallout(ctx),
      sourceFoot(ctx),
    ]);
    const funnelRowsNow = funnelRows(funnel);
    const payload: SectionPayload = {
      metrics: metricsFrom(ctx, sales),
      callouts: revision ? [revision] : [],
      tables: [
        withPage(WAITING_DEF, waiting),
        withPage(funnelDef(funnel.now.windowDays), {
          rows: funnelRowsNow,
          count: funnelRowsNow.length,
          total: funnelRowsNow.length,
          page: 1,
          size: first.size,
          q: "",
        }),
        withPage(ORDERS_DEF, orders),
      ],
      foot,
    };
    return payload;
  },

  async tablePage(ctx, table, query) {
    if (table === "waiting") return waitingPage(query);
    if (table === "orders") return ordersPage(ctx, query);
    if (table === "funnel") {
      const rows = funnelRows(await funnelRead(ctx));
      return { rows, count: rows.length, total: rows.length, page: 1, size: query.size, q: query.q };
    }
    return emptyPage(query);
  },

  async figure(ctx, metric) {
    return figureFor(ctx, metric);
  },

  async record(ctx, table, id) {
    if (table === "funnel") return funnelRecord(ctx, id);
    return orderRecord(id);
  },

  async act(_ctx, table, act, id, input): Promise<Result> {
    if (table !== "waiting" && table !== "orders") return { ok: false, error: "Nothing to do on that row." };
    try {
      const subject = await subjectOf(id);
      if (act === "approve") {
        const r = await approveOrderAction(id);
        return fromOwning(r.ok ? { ok: true } : r, `Approved · ${subject}`);
      }
      if (act === "decline") {
        const reason = String(input.reason ?? "").trim();
        if (!reason) {
          return { ok: false, error: "Say why it is being declined.", fieldErrors: { reason: "A reason is required." } };
        }
        if (reason.length > 1000) {
          return { ok: false, error: "That reason is too long.", fieldErrors: { reason: "Keep it under 1,000 characters." } };
        }
        const r = await declineOrderAction(id, reason);
        return fromOwning(r.ok ? { ok: true } : r, `Declined · ${subject}`);
      }
      return { ok: false, error: "That action is not offered on an order." };
    } catch (e) {
      return refusal(e);
    }
  },
};
