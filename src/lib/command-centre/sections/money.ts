import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { ASSIGNED_TO_SQL } from "@/lib/access-control";
import { rejectReceiptAction, confirmReceiptAction } from "@/lib/actions/payments";
import { billCreditDaysSql } from "@/lib/bill-terms";
import { getConfig } from "@/lib/config/store";
import { agingBucket } from "@/lib/engines/escalation";
import { addDays } from "@/lib/format";
import { today } from "@/lib/recompute";
import { accountsHome, agingAcrossTheBook, bucketise } from "@/lib/services/accounts-home-service";
import { pendingCreditNotes } from "@/lib/services/credit-note-service";
import { customerLedger, pendingReceipts, receiptStatusSentence, type PendingReceipt } from "@/lib/services/receipt-service";
import { createReminder } from "@/lib/services/worklist-services";
import {
  auditFor,
  emptyPage,
  fromOwning,
  hoursSince,
  notesFor,
  refusal,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { change, crore, fmtDate, fmtDay, inr, monthLabel, monthShort, num, plural, span, waited } from "../format";
import type { ActSpec, Cell, FigureDrawer, Metric, RecordView, Row, TableDef, TablePage, Tone } from "../types";

/* ---------------------------------------------------------------------------
 * MONEY — PRD §14, the design's `money` section.
 *
 * Every figure is read where Accounts reads it: the queues and the aging from
 * `accountsHome()` / `agingAcrossTheBook()`, the receipts waiting from
 * `pendingReceipts()`, the credit-note requests from `pendingCreditNotes()`.
 * Confirm and reject are Accounts' own actions; chasing is the CRM's own
 * `createReminder`, put in the book owner's name for today.
 *
 * Confirmed money only, stated bills only, with GST — the same rules the
 * Accounts app keeps, because it is the same code answering.
 * ------------------------------------------------------------------------- */

const SECTION = "Money";
const n = (v: unknown) => Number(v ?? 0);

/* ------------------------------------------------------------ table defs */

const RECEIPT_ACTS: ActSpec[] = [
  {
    key: "confirm",
    label: "Confirm",
    confirm: "The bills are settled, outstanding drops and the customer leaves the collections list.",
    done: "Confirmed",
  },
  {
    key: "reject",
    label: "Reject",
    tone: "bad",
    confirm: "The bills reopen and the customer returns to collections. The rejection stays on their statement.",
    done: "Rejected",
    form: {
      title: "Reject this receipt",
      sub: "Accounts looked for this money and did not find it.",
      submit: "Reject",
      consequence: "The bills reopen and the customer returns to collections. The rejection stays on their statement.",
      fields: [
        {
          k: "reason",
          label: "Why is it being rejected?",
          type: "area",
          req: true,
          ph: "Not on the bank statement up to 26 Sep",
          hint: "The telecaller reads this back to the customer.",
        },
      ],
    },
  },
];

const CHASE_ACT: ActSpec = {
  key: "chase",
  label: "Chase",
  confirm: "The customer moves to the top of their telecaller's queue today.",
  done: "Chased",
};

function defs(asOfMonthEnd: string): Record<"aging" | "receipts" | "owes", TableDef> {
  return {
    aging: {
      key: "aging",
      title: "Aging of stated bills",
      hint: "Now · by days past due",
      noun: "bucket",
      rec: "Aging bucket",
      cols: [
        ["Bucket", "1.2fr"],
        ["Bills", "0.7fr", true],
        ["Amount", "1fr", true],
        ["Share", "0.7fr", true],
        [`Change since ${fmtDay(asOfMonthEnd).replace(/^0/, "")}`, "1.2fr", true],
      ],
    },
    receipts: {
      key: "receipts",
      title: "Receipts reported, not confirmed",
      hint: "Now · check the bank statement, then decide",
      noun: "receipt",
      rec: "Receipt",
      acts: RECEIPT_ACTS,
      cols: [
        ["Customer", "1.5fr"],
        ["Amount", "0.9fr", true],
        ["How", "1.1fr"],
        ["Reported by", "1.1fr"],
        ["Waiting", "0.8fr"],
      ],
    },
    owes: {
      key: "owes",
      title: "Everyone who owes",
      hint: "Now · stated bills only · largest first",
      noun: "customer",
      rec: "Customer",
      acts: [CHASE_ACT],
      actW: "100px",
      cols: [
        ["Customer", "1.6fr"],
        ["Owes", "1fr", true],
        ["Overdue", "1fr", true],
        ["Oldest bill", "0.9fr"],
        ["Collector", "1.1fr"],
        ["Stage", "0.9fr"],
      ],
    },
  };
}

/* ------------------------------------------------------------- words */

const SOURCE_WORDS: Record<string, string> = {
  collections_call: "on a collections call",
  bills_screen: "entered against a bill",
  accounts: "entered by accounts",
  sheet_import: "from the payment sheet",
  tally_receipts: "from Tally's receipt register",
  mbos: "collected in the field",
};
const sourceWords = (s: string) => SOURCE_WORDS[s] ?? "reported";

const STATUS_WORDS: Record<string, string> = {
  reported: "Reported, waiting for accounts",
  held: "On hold with accounts, being checked",
  confirmed: "Confirmed",
  rejected: "Rejected — never arrived",
  reversed: "Reversed",
};

function stageCell(stage: number | null, held: boolean, overdue: number): Cell {
  if (held) return { t: "On hold", pill: "muted" };
  if (!stage || overdue <= 0) return { t: "Current", pill: "good" };
  const tone: Tone = stage >= 3 ? "bad" : stage === 2 ? "warn" : "info";
  return { t: `Stage ${stage}`, pill: tone };
}

/* ------------------------------------------------------------- reads */

/** Last day of the month before the one `day` is in. */
function lastMonthEnd(day: string): string {
  return addDays(`${day.slice(0, 7)}-01`, -1);
}

/**
 * Every open STATED bill with how far past due it is — as of now (the stored
 * `paid_amount`), or as the ledger stood at the end of a past day (confirmed
 * receipts received by then). The due date is resolved exactly as
 * `agingAcrossTheBook` resolves it.
 */
async function openStatedBills(defaultCreditDays: number, asOf?: string) {
  const due = sql`coalesce(bills.due_date, bills.bill_date + coalesce(${billCreditDaysSql}, ${defaultCreditDays}::int)::int)`;
  if (!asOf) {
    const rows = await db.execute<{ od: number; bal: string }>(sql`
      select greatest(0, (now() at time zone 'Asia/Kolkata')::date - (${due})::date)::int as od,
             (bills.amount - bills.paid_amount)::bigint as bal
        from bills
       where bills.amount > bills.paid_amount and bills.payment_position = 'stated'
    `);
    return rows.map((r) => ({ overdueDays: n(r.od), balance: n(r.bal) }));
  }
  const rows = await db.execute<{ od: number; bal: string }>(sql`
    with paid as (
      select p.bill_id, sum(p.amount) as s
        from payments p
        join payment_receipts r on r.id = p.receipt_id
       where r.status = 'confirmed' and p.bill_id is not null and r.received_at <= ${asOf}::date
       group by p.bill_id
    )
    select greatest(0, ${asOf}::date - (${due})::date)::int as od,
           (bills.amount - coalesce(paid.s, 0))::bigint as bal
      from bills
      left join paid on paid.bill_id = bills.id
     where bills.payment_position = 'stated'
       and bills.bill_date <= ${asOf}::date
       and bills.amount > coalesce(paid.s, 0)
  `);
  return rows.map((r) => ({ overdueDays: n(r.od), balance: n(r.bal) }));
}

async function unstatedTotals() {
  const [r] = await db.execute<{ n: number; amt: string; customers: number }>(sql`
    select count(*)::int as n,
           coalesce(sum(bills.amount - bills.paid_amount), 0)::bigint as amt,
           count(distinct bills.customer_id)::int as customers
      from bills
     where bills.amount > bills.paid_amount and bills.payment_position = 'unstated'
  `);
  return { count: n(r?.n), amount: n(r?.amt), customers: n(r?.customers) };
}

/** Confirmed money in a window. Adjustments and credit notes are not money arriving. */
const MONEY_IN = sql`payment_receipts.status = 'confirmed'
  and payment_receipts.mode not in ('Adjustment', 'Credit note')
  and payment_receipts.idempotency_key not like 'creditnote:%'`;

async function collected(from: string, to: string) {
  const [r] = await db.execute<{ amt: string; n: number }>(sql`
    select coalesce(sum(payment_receipts.amount), 0)::bigint as amt, count(*)::int as n
      from payment_receipts
     where ${MONEY_IN} and payment_receipts.received_at between ${from}::date and ${to}::date
  `);
  return { amount: n(r?.amt), count: n(r?.n) };
}

async function cityOf(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: customers.id, city: customers.city })
    .from(customers)
    .where(inArray(customers.id, ids));
  return new Map(rows.map((r) => [r.id, r.city ?? ""]));
}

/* --------------------------------------------------------- aging table */

type AgingRead = {
  total: number;
  bills: number;
  rows: { label: string; bills: number; amount: number; share: number; delta: number; last: boolean }[];
  overdue: number;
  monthEnd: string;
};

async function readAging(): Promise<AgingRead> {
  const config = await getConfig();
  const bounds = config["bills.agingBuckets"];
  const credit = config["bills.defaultCreditDays"];
  // The month end is the business date's, not the server clock's.
  const [now, nowRows, day] = await Promise.all([agingAcrossTheBook(bounds, credit), openStatedBills(credit), today()]);
  const monthEnd = lastMonthEnd(day);
  const then = bucketise(await openStatedBills(credit, monthEnd), bounds);

  const cfg = { "bills.agingBuckets": bounds };
  const counts = new Map<string, number>();
  for (const r of nowRows) {
    const l = agingBucket(r.overdueDays, cfg);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const thenAt = new Map(then.buckets.map((b) => [b.label, b.amount]));
  const rows = now.buckets.map((b, i) => ({
    label: b.label,
    bills: counts.get(b.label) ?? 0,
    amount: b.amount,
    share: now.total > 0 ? (b.amount / now.total) * 100 : 0,
    delta: b.amount - (thenAt.get(b.label) ?? 0),
    last: i === now.buckets.length - 1,
  }));
  const overdue = now.buckets.filter((b) => b.label !== "Not due").reduce((s, b) => s + b.amount, 0);
  return { total: now.total, bills: now.bills, rows, overdue, monthEnd };
}

function agingRows(a: AgingRead): Row[] {
  return a.rows.map((r) => {
    const up = r.delta > 0;
    const d: Cell = {
      t: r.delta === 0 ? "No change" : `${up ? "▲" : "▼"} ${crore(Math.abs(r.delta))}`,
      pill: r.last && up ? "bad" : undefined,
    };
    return {
      id: r.label,
      cells: [
        { t: r.label === "Not due" ? "Not yet due" : r.label },
        { t: num(r.bills) },
        { t: crore(r.amount) },
        { t: `${Math.round(r.share)}%` },
        d,
      ],
    };
  });
}

/* ------------------------------------------------------ receipts table */

function receiptRow(r: PendingReceipt, city: string, staleHours: number): Row {
  const w = r.waitingHours;
  const tone: Tone = w > staleHours ? "bad" : w > staleHours / 2 ? "warn" : "muted";
  return {
    id: r.receiptId,
    cells: [
      { t: r.customerName, sub: city || undefined },
      { t: inr(r.amount) },
      { t: r.mode === "Not stated" ? "Method not recorded" : r.mode, sub: r.reference || "no reference" },
      { t: r.reportedBy ?? "Nobody recorded", sub: sourceWords(r.source) },
      {
        t: waited(w),
        sub: r.status === "held" ? `on hold${r.heldByName ? ` · ${r.heldByName}` : ""}` : undefined,
        pill: tone,
      },
    ],
  };
}

async function receiptsPage(query: TableQuery): Promise<TablePage> {
  const [all, config] = await Promise.all([pendingReceipts(), getConfig()]);
  const s = slice(all, query, (r, q) =>
    [r.customerName, r.mode, r.reference ?? "", r.reportedBy ?? "", String(Math.round(r.amount / 100))]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
  const cities = await cityOf(s.rows.map((r) => r.customerId));
  return {
    rows: s.rows.map((r) => receiptRow(r, cities.get(r.customerId) ?? "", config["payments.confirmationAgeWarningHours"])),
    count: s.count,
    total: s.total,
    page: s.page,
    size: query.size,
    q: query.q,
  };
}

/* ---------------------------------------------------------- owes table */

type OwesRow = {
  id: string;
  name: string;
  city: string | null;
  owes: string;
  overdue: string;
  days: number | null;
  stage: number | null;
  held: boolean | null;
  owner_id: string | null;
  collector: string | null;
};

const OWES_SELECT = sql`
  select customers.id, customers.name, customers.city,
         customers.outstanding::bigint as owes,
         coalesce(f.total_overdue, 0)::bigint as overdue,
         f.days_overdue as days, f.stage, f.held,
         (${ASSIGNED_TO_SQL}) as owner_id,
         (select u.name from users u where u.id = (${ASSIGNED_TO_SQL})) as collector
    from customers
    left join follow_up_states f on f.customer_id = customers.id
`;

function owesWhere(q: string) {
  const term = q.trim();
  return term.length >= 2
    ? sql`customers.outstanding > 0 and (customers.name ilike ${"%" + term.replace(/([\\%_])/g, "\\$1") + "%"} escape '\\' or customers.city ilike ${"%" + term + "%"})`
    : sql`customers.outstanding > 0`;
}

function owesRow(r: OwesRow): Row {
  const overdue = n(r.overdue);
  const days = n(r.days);
  return {
    id: r.id,
    acts: r.owner_id ? ["chase"] : [],
    cells: [
      { t: r.name, sub: r.city || undefined },
      { t: inr(n(r.owes)) },
      { t: inr(overdue) },
      { t: overdue > 0 && days > 0 ? `${num(days)} ${days === 1 ? "day" : "days"}` : "Not due" },
      r.collector ? { t: r.collector } : { t: "Nobody", pill: "bad" },
      stageCell(r.stage, Boolean(r.held), overdue),
    ],
  };
}

async function owesPage(query: TableQuery): Promise<TablePage> {
  const where = owesWhere(query.q);
  const [[c], [t]] = await Promise.all([
    db.execute<{ n: number }>(sql`select count(*)::int as n from customers where ${where}`),
    db.execute<{ n: number }>(sql`select count(*)::int as n from customers where customers.outstanding > 0`),
  ]);
  const count = n(c?.n);
  const pages = Math.max(1, Math.ceil(count / query.size));
  const page = Math.min(query.page, pages);
  const rows = count
    ? await db.execute<OwesRow>(sql`
        ${OWES_SELECT}
       where ${where}
       order by customers.outstanding desc, customers.id asc
       limit ${query.size}::int offset ${(page - 1) * query.size}::int
      `)
    : [];
  return { rows: rows.map(owesRow), count, total: n(t?.n), page, size: query.size, q: query.q };
}

/* --------------------------------------------------------------- section */

async function metrics(ctx: Ctx) {
  const p = ctx.period;
  const [home, aging, unstated, cur, prev] = await Promise.all([
    accountsHome(),
    readAging(),
    unstatedTotals(),
    collected(p.from, p.to),
    collected(p.compareFrom, p.compareTo),
  ]);
  const overduePct = aging.total > 0 ? Math.round((aging.overdue / aging.total) * 100) : 0;
  const chg = change(cur.amount, prev.amount);
  const pay = home.payments;
  const cn = home.credits;
  const list: Metric[] = [
    {
      key: "outstanding",
      label: "Outstanding (stated)",
      value: aging.total > 0 ? crore(aging.total) : "Nothing owed",
      sub: aging.total > 0 ? `${overduePct}% overdue` : "no stated bill is open",
      kind: "Now",
    },
    {
      key: "unstated",
      label: "Unstated bills",
      value: unstated.count ? crore(unstated.amount) : "None",
      sub: "raised, not yet stated — not counted as debt",
      kind: "Now",
      tone: unstated.count ? "warn" : undefined,
    },
    {
      key: "collected",
      label: "Collected",
      value: crore(cur.amount),
      sub: `${chg.text} · confirmed only`,
      kind: "Period",
    },
    {
      key: "reported",
      label: "Reported, not confirmed",
      value: pay.count ? crore(pay.value) : "None",
      sub: pay.count ? `${plural(pay.count, "receipt")} · oldest ${waited(pay.oldestHours).replace(" h", " hours")}` : "nothing waiting on accounts",
      kind: "Now",
      tone: pay.count ? "bad" : undefined,
    },
    {
      key: "credit-notes",
      label: "Credit notes",
      value: cn.count ? crore(cn.value) : "None",
      sub: cn.count ? `requested · ${num(cn.count)} waiting on accounts` : "no request waiting on accounts",
      kind: "Now",
    },
  ];
  return { list, aging, home, unstated, cur };
}

async function section(ctx: Ctx) {
  const q: TableQuery = { q: "", page: 1, size: 25 };
  const [{ list, aging }, receipts, owes] = await Promise.all([metrics(ctx), receiptsPage(q), owesPage(q)]);
  const d = defs(aging.monthEnd);
  const agingPage: TablePage = {
    rows: agingRows(aging),
    count: aging.rows.length,
    total: aging.rows.length,
    page: 1,
    size: 25,
    q: "",
  };
  return {
    metrics: list,
    callouts: [],
    tables: [withPage(d.aging, agingPage), withPage(d.receipts, receipts), withPage(d.owes, owes)],
    foot: "Money counts confirmed receipts only. Reported and held payments are shown on their own and never added. Credit notes are not money arriving.",
  };
}

async function tablePage(ctx: Ctx, table: string, query: TableQuery): Promise<TablePage> {
  if (table === "receipts") return receiptsPage(query);
  if (table === "owes") return owesPage(query);
  if (table === "aging") {
    const a = await readAging();
    const s = slice(agingRows(a), query, (r, q) => r.cells[0].t.toLowerCase().includes(q));
    return { rows: s.rows, count: s.count, total: s.total, page: s.page, size: query.size, q: query.q };
  }
  return emptyPage(query);
}

/* ---------------------------------------------------------------- figure */

/** The last 12 months, ending in the month `day` is in. */
function last12(day: string): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  let y = Number(day.slice(0, 4));
  let m = Number(day.slice(5, 7));
  for (let i = 0; i < 12; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const from = `${key}-01`;
    const end = addDays(addDays(from, 32).slice(0, 8) + "01", -1);
    out.unshift({ key, from, to: end < day ? end : day });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

async function figure(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const p = ctx.period;
  const asOf = stampIST(new Date());
  const scope = { label: "Scope", value: "Company-wide · every customer" };
  const base = (kind: string, title: string, value: string) => ({ kind: `${kind} figure · Money`, title, value });

  if (metric === "outstanding") {
    const config = await getConfig();
    const credit = config["bills.defaultCreditDays"];
    const months = last12(p.today);
    const [aging, top, ...hist] = await Promise.all([
      readAging(),
      db.execute<OwesRow>(sql`${OWES_SELECT} where customers.outstanding > 0 order by customers.outstanding desc, customers.id asc limit 8`),
      ...months.slice(0, 11).map((m) => openStatedBills(credit, m.to)),
    ]);
    const bars = [
      ...hist.map((rows, i) => ({ h: rows.reduce((s, r) => s + r.balance, 0), tip: `${monthLabel(months[i].key)} · ${crore(rows.reduce((s, r) => s + r.balance, 0))}` })),
      { h: aging.total, tip: `Now · ${crore(aging.total)}`, current: true },
    ];
    return {
      ...base("Now", "Outstanding (stated)", crore(aging.total)),
      facts: [
        { label: "Kind", value: "Now" },
        { label: "As of", value: asOf },
        { label: "Basis", value: "With GST · stated bills only · confirmed money only" },
        scope,
        { label: "Source", value: "Bills and confirmed receipts, as Accounts reads them" },
        { label: "Bills open", value: plural(aging.bills, "bill") },
      ],
      def: "Every stated bill’s balance after confirmed receipts. Unstated bills are counted on their own and never added.",
      bars,
      barsLabel: "Outstanding at each month end, rebuilt from the ledger as it stands today",
      rowsLabel: "Who owes the most",
      rows: top.map((r) => ({ a: r.name, b: r.city || r.collector || "", c: inr(n(r.owes)) })),
      noRowsLine: top.length ? undefined : "Nobody owes anything on a stated bill.",
      section: "money",
    };
  }

  if (metric === "unstated") {
    const [u, top] = await Promise.all([
      unstatedTotals(),
      db.execute<{ bill_no: string; name: string; bill_date: string; bal: string }>(sql`
        select bills.bill_no, customers.name, bills.bill_date::text as bill_date,
               (bills.amount - bills.paid_amount)::bigint as bal
          from bills join customers on customers.id = bills.customer_id
         where bills.amount > bills.paid_amount and bills.payment_position = 'unstated'
         order by bills.amount - bills.paid_amount desc, bills.id asc limit 8
      `),
    ]);
    return {
      ...base("Now", "Unstated bills", u.count ? crore(u.amount) : "None"),
      facts: [
        { label: "Kind", value: "Now" },
        { label: "As of", value: asOf },
        { label: "Basis", value: `With GST · ${plural(u.count, "bill")} across ${plural(u.customers, "customer")}` },
        scope,
        { label: "Source", value: "Bills brought in from the order sheet" },
      ],
      def: "Bills raised but not yet stated to the customer. They are not debt until stated.",
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: "The largest unstated bills",
      rows: top.map((r) => ({ a: r.name, b: `${r.bill_no} · ${fmtDate(r.bill_date)}`, c: inr(n(r.bal)) })),
      noRowsLine: top.length ? undefined : "Every bill has a stated position.",
      section: "money",
    };
  }

  if (metric === "collected") {
    const months = last12(p.to);
    const [cur, prev, ly, top, ...hist] = await Promise.all([
      collected(p.from, p.to),
      collected(p.compareFrom, p.compareTo),
      collected(p.lastYearFrom, p.lastYearTo),
      db.execute<{ id: string; name: string; mode: string; received_at: string; amount: string }>(sql`
        select payment_receipts.id, customers.name, payment_receipts.mode,
               payment_receipts.received_at::text as received_at, payment_receipts.amount::bigint as amount
          from payment_receipts join customers on customers.id = payment_receipts.customer_id
         where ${MONEY_IN} and payment_receipts.received_at between ${p.from}::date and ${p.to}::date
         order by payment_receipts.amount desc, payment_receipts.id asc limit 8
      `),
      ...months.map((m) => collected(m.from, m.to)),
    ]);
    const chg = change(cur.amount, prev.amount);
    const lyc = change(cur.amount, ly.amount);
    return {
      ...base("Period", "Collected", crore(cur.amount)),
      facts: [
        { label: "Kind", value: "Period" },
        { label: "Period", value: span(p.from, p.to) },
        { label: "Compared with", value: `${span(p.compareFrom, p.compareTo)} · ${crore(prev.amount)} · ${chg.text}` },
        { label: "Same dates last year", value: `${crore(ly.amount)} · ${lyc.text}` },
        { label: "Basis", value: `With GST · confirmed only · ${plural(cur.count, "receipt")}` },
        scope,
        { label: "Source", value: "Payment receipts" },
        { label: "As of", value: asOf },
      ],
      def: "Confirmed receipts dated in the period. Reported and held payments are not money yet and are shown on their own. Credit notes and adjustments are not money arriving.",
      bars: hist.map((h, i) => ({
        h: h.amount,
        tip: `${monthShort(months[i].key)} ${months[i].key.slice(0, 4)} · ${crore(h.amount)}`,
        current: i === hist.length - 1 ? true : undefined,
      })),
      barsLabel: "Collected, month by month",
      rowsLabel: "The largest receipts in the period",
      rows: top.map((r) => ({ a: r.name, b: `${r.mode} · ${fmtDate(r.received_at)}`, c: inr(n(r.amount)) })),
      noRowsLine: top.length ? undefined : "No money was confirmed in this period.",
      section: "money",
    };
  }

  if (metric === "reported") {
    const [home, all] = await Promise.all([accountsHome(), pendingReceipts()]);
    const pay = home.payments;
    return {
      ...base("Now", "Reported, not confirmed", pay.count ? crore(pay.value) : "None"),
      facts: [
        { label: "Kind", value: "Now" },
        { label: "As of", value: asOf },
        {
          label: "Basis",
          value: `With GST · ${plural(pay.count, "receipt")} · ${num(pay.stale)} past ${home.staleHours} hours`,
        },
        scope,
        { label: "Source", value: "Payment receipts reported or on hold" },
      ],
      def: "Receipts a telecaller or salesman reported that accounts has not yet found in the bank. They are never added to money.",
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: "Waiting longest",
      rows: all.slice(0, 8).map((r) => ({ a: r.customerName, b: `${r.mode} · ${waited(r.waitingHours)}`, c: inr(r.amount) })),
      noRowsLine: all.length ? undefined : "Nothing is waiting on accounts.",
      section: "money",
    };
  }

  if (metric === "credit-notes") {
    const all = await pendingCreditNotes();
    const total = all.reduce((s, r) => s + (r.amount ?? 0), 0);
    return {
      ...base("Now", "Credit notes", all.length ? crore(total) : "None"),
      facts: [
        { label: "Kind", value: "Now" },
        { label: "As of", value: asOf },
        { label: "Basis", value: `With GST · ${plural(all.length, "request")} · ${plural(all.filter((r) => r.amount == null).length, "request")} with no figure yet` },
        scope,
        { label: "Source", value: "Complaints asking for a credit note" },
      ],
      def: "Credit notes requested and waiting on accounts. A credit note is not money arriving.",
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: "Waiting longest",
      rows: all.slice(0, 8).map((r) => ({
        a: r.customerName,
        b: `${r.categoryLabel} · ${waited(r.waitingHours)}`,
        c: r.amount == null ? "No figure" : inr(r.amount),
      })),
      noRowsLine: all.length ? undefined : "No credit note is waiting on accounts.",
      sectionLabel: "Decided in Accounts",
    };
  }

  throw new Error("There is no figure by that name in Money.");
}

/* ---------------------------------------------------------------- record */

async function record(ctx: Ctx, table: string, id: string): Promise<RecordView> {
  if (table === "receipts") {
    const [r] = await db.execute<{
      id: string;
      customer_id: string;
      name: string;
      city: string | null;
      amount: string;
      received_at: string;
      instrument_date: string | null;
      mode: string;
      reference: string | null;
      receipt_no: string | null;
      note: string | null;
      status: "reported" | "held" | "confirmed" | "rejected" | "reversed";
      source: string;
      reject_reason: string | null;
      hold_reason: string | null;
      held_at: string | null;
      held_by: string | null;
      reported_by: string | null;
      confirmed_by: string | null;
      confirmed_at: string | null;
      created_at: string;
      outstanding: string;
    }>(sql`
      select payment_receipts.id, payment_receipts.customer_id, customers.name, customers.city,
             payment_receipts.amount::bigint as amount, payment_receipts.received_at::text as received_at,
             payment_receipts.instrument_date::text as instrument_date, payment_receipts.mode,
             payment_receipts.reference, payment_receipts.receipt_no, payment_receipts.note,
             payment_receipts.status, payment_receipts.source, payment_receipts.reject_reason,
             payment_receipts.hold_reason, payment_receipts.held_at,
             (select u.name from users u where u.id = payment_receipts.held_by_id) as held_by,
             (select u.name from users u where u.id = payment_receipts.reported_by_id) as reported_by,
             (select u.name from users u where u.id = payment_receipts.confirmed_by_id) as confirmed_by,
             payment_receipts.confirmed_at, payment_receipts.created_at,
             customers.outstanding::bigint as outstanding
        from payment_receipts join customers on customers.id = payment_receipts.customer_id
       where payment_receipts.id = ${id}
    `);
    if (!r) throw new Error("That receipt no longer exists.");
    const lines = await db.execute<{ bill_no: string | null; amount: string }>(sql`
      select bills.bill_no, payments.amount::bigint as amount
        from payments left join bills on bills.id = payments.bill_id
       where payments.receipt_id = ${id}
       order by bills.bill_date asc nulls last
    `);
    const allocated = lines.filter((l) => l.bill_no).reduce((s, l) => s + n(l.amount), 0);
    const open = r.status === "reported" || r.status === "held";
    const timeline: { what: string; when: string }[] = [];
    if (r.confirmed_at && r.status !== "reported")
      timeline.push({ what: `Confirmed by ${r.confirmed_by ?? "accounts"}`, when: stampIST(r.confirmed_at) });
    if (r.held_at) timeline.push({ what: `Put on hold by ${r.held_by ?? "accounts"} — ${r.hold_reason ?? "no reason recorded"}`, when: stampIST(r.held_at) });
    timeline.push({
      what: `Reported by ${r.reported_by ?? "nobody recorded"}, ${sourceWords(r.source)}`,
      when: stampIST(r.created_at),
    });
    const [notes, audit] = await Promise.all([notesFor("payment_receipt", id), auditFor("payment_receipt", id)]);
    return {
      kind: `Receipt · ${SECTION}`,
      title: `${inr(n(r.amount))} from ${r.name}`,
      sub: receiptStatusSentence({
        mode: r.mode,
        reference: r.reference,
        amount: n(r.amount),
        allocated,
        status: r.status,
        rejectReason: r.reject_reason,
      }),
      fields: [
        { label: "Customer", value: r.city ? `${r.name}, ${r.city}` : r.name },
        { label: "Amount", value: `${inr(n(r.amount))} (with GST)` },
        { label: "State", value: STATUS_WORDS[r.status] ?? r.status },
        { label: "How it came", value: r.mode === "Not stated" ? "Method not recorded" : r.mode },
        { label: "Reference", value: r.reference || "None given" },
        ...(r.receipt_no ? [{ label: "Receipt number", value: r.receipt_no }] : []),
        { label: "Said to have arrived", value: fmtDate(r.received_at) },
        ...(r.instrument_date ? [{ label: "Date on the cheque", value: fmtDate(r.instrument_date) }] : []),
        { label: "Reported by", value: `${r.reported_by ?? "Nobody recorded"}, ${sourceWords(r.source)}` },
        { label: "Waiting", value: open ? waited(hoursSince(r.created_at)) : "Decided" },
        {
          label: "What it settles",
          value: lines.length
            ? lines.map((l) => `${l.bill_no ?? "On account"} ${inr(n(l.amount))}`).join(" · ")
            : "Nothing named yet",
        },
        ...(r.hold_reason ? [{ label: "Why it is on hold", value: r.hold_reason }] : []),
        ...(r.reject_reason ? [{ label: "Reason", value: r.reject_reason }] : []),
        ...(r.note ? [{ label: "Note", value: r.note }] : []),
        { label: "Customer owes now", value: inr(n(r.outstanding)) },
      ],
      timeline: [...notes, ...timeline],
      audit,
      acts: open ? RECEIPT_ACTS : [],
      href: { label: "Open the customer's statement in Accounts", url: `/accounts/ledger?customer=${r.customer_id}` },
      noteTarget: { kind: "payment_receipt", id },
    };
  }

  if (table === "owes") {
    const [r] = await db.execute<
      OwesRow & {
        unstated: string;
        open_bills: number;
        last_follow_up_at: string | null;
        next_channel: string | null;
        slow_payer: boolean;
        credit_days: number | null;
        heldReason: string | null;
      }
    >(sql`
      select customers.id, customers.name, customers.city,
             customers.outstanding::bigint as owes,
             coalesce(f.total_overdue, 0)::bigint as overdue,
             f.days_overdue as days, f.stage, f.held, f.held_reason as "heldReason",
             f.last_follow_up_at, f.next_channel,
             customers.slow_payer, customers.credit_days,
             (${ASSIGNED_TO_SQL}) as owner_id,
             (select u.name from users u where u.id = (${ASSIGNED_TO_SQL})) as collector,
             (select coalesce(sum(b.amount - b.paid_amount), 0) from bills b
               where b.customer_id = customers.id and b.amount > b.paid_amount and b.payment_position = 'unstated')::bigint as unstated,
             (select count(*) from bills b
               where b.customer_id = customers.id and b.amount > b.paid_amount and b.payment_position = 'stated')::int as open_bills
        from customers
        left join follow_up_states f on f.customer_id = customers.id
       where customers.id = ${id}
    `);
    if (!r) throw new Error("That customer no longer exists.");
    const overdue = n(r.overdue);
    const from = addDays(ctx.period.today, -120);
    const [ledger, notes, audit] = await Promise.all([
      customerLedger(id, { from }).catch(() => null),
      notesFor("customer", id),
      auditFor("customer", id),
    ]);
    const entries = (ledger?.entries ?? []).slice(-12).reverse();
    const stage = stageCell(r.stage, Boolean(r.held), overdue);
    return {
      kind: `Customer · ${SECTION}`,
      title: r.name,
      sub: `Owes ${inr(n(r.owes))} on stated bills · ${overdue > 0 ? `${inr(overdue)} overdue` : "nothing overdue"}`,
      fields: [
        { label: "City", value: r.city || "Not recorded" },
        { label: "Owes (stated bills)", value: inr(n(r.owes)) },
        { label: "Open stated bills", value: num(r.open_bills) },
        { label: "Overdue", value: inr(overdue) },
        { label: "Oldest overdue bill", value: overdue > 0 && n(r.days) > 0 ? `${num(n(r.days))} days past due` : "Nothing past due" },
        { label: "Collections stage", value: stage.t },
        ...(r.held && r.heldReason ? [{ label: "Why collections are held", value: r.heldReason }] : []),
        { label: "Unstated bills", value: n(r.unstated) > 0 ? `${inr(n(r.unstated))} — not counted as debt` : "None" },
        { label: "Collector", value: r.collector ?? "Nobody holds this customer's book" },
        { label: "Last chased", value: r.last_follow_up_at ? stampIST(r.last_follow_up_at) : "Never" },
        ...(r.next_channel ? [{ label: "Next step", value: r.next_channel === "call" ? "A call" : r.next_channel === "whatsapp" ? "A WhatsApp reminder" : "A reminder" }] : []),
        { label: "Credit term", value: r.credit_days != null ? `${r.credit_days} days` : "The default term" },
        { label: "Slow payer", value: r.slow_payer ? "Yes" : "No" },
      ],
      timeline: [
        ...notes,
        ...entries.map((e) => ({
          what: e.kind === "bill" ? `Bill ${e.ref} · ${inr(e.debit)}` : `${e.detail} · ${inr(e.credit)}`,
          when: fmtDate(e.at),
        })),
      ],
      audit,
      acts: r.owner_id ? [CHASE_ACT] : [],
      href: { label: "Open the customer's statement in Accounts", url: `/accounts/ledger?customer=${id}` },
      noteTarget: { kind: "customer", id },
    };
  }

  if (table === "aging") {
    const a = await readAging();
    const b = a.rows.find((x) => x.label === id);
    if (!b) throw new Error("That bucket is not on the strip any more.");
    return {
      kind: `Aging bucket · ${SECTION}`,
      title: b.label === "Not due" ? "Not yet due" : b.label,
      sub: `${crore(b.amount)} across ${plural(b.bills, "stated bill")}`,
      fields: [
        { label: "Bills", value: num(b.bills) },
        { label: "Amount (with GST)", value: inr(b.amount) },
        { label: "Share of outstanding", value: `${Math.round(b.share)}%` },
        { label: `Change since ${fmtDate(a.monthEnd)}`, value: b.delta === 0 ? "No change" : `${b.delta > 0 ? "Up" : "Down"} ${inr(Math.abs(b.delta))}` },
      ],
      timeline: [],
      audit: [],
      acts: [],
      href: { label: "Open outstanding in Accounts", url: "/accounts/outstanding" },
      noteTarget: { kind: "aging_bucket", id },
    };
  }

  throw new Error("There is no such list in Money.");
}

/* ------------------------------------------------------------------- act */

/** The owning action's refusal, or our own one-line success (its sentence would repeat ours). */
function owned(r: { ok: boolean }, message: string) {
  return r.ok ? { ok: true as const, message } : fromOwning(r, message);
}


async function act(ctx: Ctx, table: string, key: string, id: string, input: Record<string, string>) {
  try {
    if (table === "receipts") {
      const [r] = await db.execute<{ name: string; amount: string }>(sql`
        select customers.name, payment_receipts.amount::bigint as amount
          from payment_receipts join customers on customers.id = payment_receipts.customer_id
         where payment_receipts.id = ${id}
      `);
      if (!r) return { ok: false as const, error: "That receipt no longer exists." };
      const subject = `${inr(n(r.amount))} from ${r.name}`;
      if (key === "confirm") return owned(await confirmReceiptAction(id), `Confirmed · ${subject}`);
      if (key === "reject") {
        const reason = (input.reason ?? "").trim();
        if (!reason)
          return { ok: false as const, error: "Say why the payment is being rejected.", fieldErrors: { reason: "A reason is required." } };
        return owned(await rejectReceiptAction(id, reason), `Rejected · ${subject}`);
      }
    }
    if (table === "owes" && key === "chase") {
      const [r] = await db.execute<{ name: string; owes: string; overdue: string; owner_id: string | null; collector: string | null }>(sql`
        select customers.name, customers.outstanding::bigint as owes,
               coalesce(f.total_overdue, 0)::bigint as overdue,
               (${ASSIGNED_TO_SQL}) as owner_id,
               (select u.name from users u where u.id = (${ASSIGNED_TO_SQL})) as collector
          from customers left join follow_up_states f on f.customer_id = customers.id
         where customers.id = ${id}
      `);
      if (!r) return { ok: false as const, error: "That customer no longer exists." };
      if (!r.owner_id)
        return { ok: false as const, error: "Nobody holds this customer's book, so there is no telecaller's queue to put the call on." };
      const owes = n(r.owes);
      const overdue = n(r.overdue);
      const res = await createReminder({
        customerId: id,
        dueDate: ctx.period.today,
        type: "call_back",
        assignedUserId: r.owner_id,
        note: `Chase the payment: owes ${inr(owes)}${overdue > 0 ? `, ${inr(overdue)} of it overdue` : ""}. Asked from the Founder Command Centre.`,
      });
      return owned(res, `Chased · ${r.name} is on ${r.collector ?? "their telecaller"}'s Call Log today`);
    }
    return { ok: false as const, error: "That action is not offered here." };
  } catch (e) {
    return refusal(e);
  }
}

export const provider: SectionProvider = { section, tablePage, figure, record, act };
