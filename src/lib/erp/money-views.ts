import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { refValues } from "./refs";
import { advanceLabel, invoiceKey, matchCandidates, statement, txnLabel, type MatchCandidate } from "./engines/money";
import {
  accountBalanceMap,
  advanceRows,
  bankLineRows,
  candidatesFor,
  cashSources,
  customerChoices,
  moneyAccounts,
  partyOf,
  txnRows,
  type AdvanceRow,
  type BankLineRow,
  type MoneyAccount,
  type TxnRow,
} from "./money";

/* ---------------------------------------------------------------------------
 * The reads behind Petty Cash's own screens (`app/erp/expenses`): each list
 * drawn as the mockups draw it, the drawer a row opens, an advance's page and
 * the bank statement's matching view. Every figure comes from `money.ts` —
 * this file only chooses rows and shapes them for a page.
 * ------------------------------------------------------------------------- */

async function q<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/* ------------------------------------------------------------------ period */

export const PERIODS = [
  { v: "month", l: "This month" },
  { v: "last", l: "Last month" },
  { v: "3m", l: "Last 3 months" },
  { v: "fy", l: "This financial year" },
  { v: "all", l: "All time" },
] as const;
export type Period = (typeof PERIODS)[number]["v"];

export function periodOf(v: string | undefined): Period {
  return (PERIODS.find((p) => p.v === v)?.v ?? "month") as Period;
}

/** A period as two dates, inclusive; null for "all time". */
export function periodRange(p: Period, day: string): { from: string; to: string } | null {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const iso = (yy: number, mm: number, dd = 1) => `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const back = (k: number) => {
    let yy = y;
    let mm = m - k;
    while (mm < 1) {
      mm += 12;
      yy -= 1;
    }
    return iso(yy, mm);
  };
  if (p === "all") return null;
  if (p === "month") return { from: iso(y, m), to: day };
  if (p === "last") {
    const from = back(1);
    const end = new Date(`${iso(y, m)}T00:00:00Z`);
    end.setUTCDate(0);
    return { from, to: end.toISOString().slice(0, 10) };
  }
  if (p === "3m") return { from: back(2), to: day };
  return { from: m >= 4 ? iso(y, 4) : iso(y - 1, 4), to: day };
}

/* ------------------------------------------------------------------- views */

const BANK_TO = sql`exists (select 1 from erp_money_accounts a where a.id = t.to_account_id and a.kind = 'bank')`;
const UNMATCHED = sql`t.amount_paise > coalesce((select sum(m.amount_paise) from erp_bank_matches m where m.txn_id = t.id and m.voided_at is null), 0)`;

/** Which transactions each Petty Cash list holds, and whether its period applies. */
export const TXN_VIEWS: Record<string, { where: SQL; windowed: boolean }> = {
  expenses: { where: sql`t.kind = 'expense' and t.status = 'active' and not t.petty and t.advance_id is null`, windowed: true },
  pettyExpenses: { where: sql`t.kind = 'expense' and t.status = 'active' and (t.petty or t.advance_id is not null)`, windowed: true },
  moneyReview: { where: sql`t.status = 'active' and t.review in ('to_review', 'sent_back')`, windowed: false },
  expensesCancelled: { where: sql`t.status = 'cancelled'`, windowed: true },
  moneyTxns: { where: sql`t.kind = 'expense'`, windowed: true },
  moneyReceipts: { where: sql`t.kind = 'receipt'`, windowed: true },
  receiptsBank: { where: sql`t.kind = 'receipt' and ${BANK_TO}`, windowed: true },
  receiptsCash: { where: sql`t.kind = 'receipt' and not ${BANK_TO}`, windowed: true },
  receiptsUnmatched: { where: sql`t.kind = 'receipt' and t.status = 'active' and ${BANK_TO} and ${UNMATCHED}`, windowed: false },
  moneyTransfers: { where: sql`t.kind = 'transfer'`, windowed: true },
};

export type TxnFilters = { period: Period; category?: string; party?: string; account?: string; q?: string };

function txnWhere(key: string, f: TxnFilters, day: string): SQL {
  const v = TXN_VIEWS[key];
  const parts: SQL[] = [v.where];
  const r = v.windowed ? periodRange(f.period, day) : null;
  if (r) parts.push(sql`t.txn_date between ${r.from}::date and ${r.to}::date`);
  if (f.category) parts.push(sql`t.category = ${f.category}`);
  if (f.party) parts.push(sql`coalesce(t.payee, t.payer, (select c.name from customers c where c.id = t.customer_id), '') = ${f.party}`);
  if (f.account) parts.push(sql`(t.from_account_id = ${f.account} or t.to_account_id = ${f.account})`);
  if (f.q) {
    const like = `%${f.q.toLowerCase()}%`;
    parts.push(sql`(lower(coalesce(t.payee, '') || ' ' || coalesce(t.payer, '') || ' ' || coalesce(t.invoice_no, '') || ' ' || coalesce(t.description, '') || ' ' || coalesce(t.reference, '') || ' ' || coalesce(t.category, '')) like ${like}
                    or ('txn-' || to_char(t.txn_date, 'YY') || '-' || lpad(t.txn_no::text, 5, '0')) ilike ${like})`);
  }
  return sql.join(parts, sql` and `);
}

/** A list's rows, newest first, at most 500 — with the duplicates among them marked. */
export async function txnView(key: string, f: TxnFilters, day: string): Promise<{ rows: (TxnRow & { dup: boolean })[]; total: number; sum: number; capped: boolean }> {
  const where = txnWhere(key, f, day);
  const [c] = await q<{ n: number; s: number }>(sql`select count(*)::int as n, coalesce(sum(t.amount_paise), 0)::float8 as s from erp_money_txns t where ${where}`);
  const rows = (await txnRows(where)).slice(0, 500);
  // Two live expenses with one invoice number and one payee or amount: the later one is the possible duplicate.
  const seen = new Map<string, TxnRow>();
  const dups = new Set<string>();
  for (const r of [...rows].reverse()) {
    if (r.kind !== "expense" || r.status !== "active") continue;
    const k = invoiceKey(r.invoiceNo);
    if (!k) continue;
    const before = seen.get(k);
    if (before && (before.amountPaise === r.amountPaise || (before.payee ?? "").toLowerCase() === (r.payee ?? "").toLowerCase())) dups.add(r.id);
    else seen.set(k, r);
  }
  return { rows: rows.map((r) => ({ ...r, dup: dups.has(r.id) })), total: Number(c?.n ?? 0), sum: Number(c?.s ?? 0), capped: Number(c?.n ?? 0) > rows.length };
}

/** How many rows each tab holds, in its own period. */
export async function tabCounts(keys: string[], period: Period, day: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    keys.map(async (k) => {
      if (TXN_VIEWS[k]) {
        const [c] = await q<{ n: number }>(sql`select count(*)::int as n from erp_money_txns t where ${txnWhere(k, { period }, day)}`);
        out[k] = Number(c?.n ?? 0);
      } else if (k === "advances") {
        const [c] = await q<{ n: number }>(sql`select count(*)::int as n from erp_advances where status = 'open'`);
        out[k] = Number(c?.n ?? 0);
      } else if (k === "bankLines") {
        const [c] = await q<{ n: number }>(sql`select count(*)::int as n from erp_bank_lines l where l.status = 'open' and not exists (select 1 from erp_bank_matches m where m.line_id = l.id and m.voided_at is null)`);
        out[k] = Number(c?.n ?? 0);
      }
    }),
  );
  return out;
}

/** The distinct values a list's filters offer. */
export async function filterOptions(key: string): Promise<{ categories: string[]; parties: string[] }> {
  const v = TXN_VIEWS[key];
  if (!v) return { categories: [], parties: [] };
  const rows = await q<{ c: string | null; p: string | null }>(sql`
    select distinct t.category as c, coalesce(t.payee, t.payer, (select c.name from customers c where c.id = t.customer_id)) as p
      from erp_money_txns t where ${v.where} limit 2000`);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
  return { categories: uniq(rows.map((r) => r.c)), parties: uniq(rows.map((r) => r.p)).slice(0, 300) };
}

/* ------------------------------------------------------------------ the kit */

export const DEFAULT_CATEGORIES = ["Petrol", "Tea / food", "Transportation", "Freight", "Courier", "Labour", "Repairs & maintenance", "Hardware", "Testing material", "Packing material", "Stationery", "Electricity", "Rent", "Telephone & internet", "Bank charges", "Other"];

/** Everything a Petty Cash dialog offers: the accounts and their balances, the lists, the next numbers. */
export async function moneyKitData(day: string) {
  const [accounts, bal, configured, emps, customers, customerCash, withdrawals, cfg, [nt], [na], open] = await Promise.all([
    moneyAccounts(),
    accountBalanceMap(),
    refValues("expenseCategory"),
    q<{ name: string; dept: string | null }>(sql`select name, department as dept from employees where status = 'active' order by name`),
    customerChoices(),
    cashSources("customer"),
    cashSources("withdrawal"),
    getConfig(),
    q<{ n: number }>(sql`select coalesce(max(txn_no), 0)::int + 1 as n from erp_money_txns`),
    q<{ n: number }>(sql`select coalesce(max(advance_no), 0)::int + 1 as n from erp_advances`),
    q<{ name: string }>(sql`select lower(employee_name) as name from erp_advances where status = 'open'`),
  ]);
  const openSet = new Set(open.map((o) => o.name));
  return {
    accounts: accounts.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, kind: a.kind, last4: a.last4, balance: bal.get(a.id) ?? 0 })),
    categories: configured.length ? [...new Set([...configured, "Other"])] : DEFAULT_CATEGORIES,
    employees: emps.map((e) => ({ name: e.name, dept: e.dept, open: openSet.has(e.name.toLowerCase()) })),
    customers,
    customerCash,
    withdrawals,
    approvalAbove: cfg["erp.money.approvalAbovePaise"],
    billsDays: cfg["erp.money.advanceBillsDays"],
    nextTxn: txnLabel(Number(nt?.n ?? 1), day),
    nextAdv: advanceLabel(Number(na?.n ?? 1), day),
  };
}

/* ---------------------------------------------------------------- statement */

export async function statementView(accountId: string, period: Period, day: string) {
  const a = (await moneyAccounts()).find((x) => x.id === accountId) ?? null;
  if (!a) return null;
  const r = periodRange(period, day);
  const opening = r ? ((await accountBalanceMap(db, r.from)).get(a.id) ?? a.openingPaise) : a.openingPaise;
  const txns = await txnRows(sql`t.status = 'active' and (t.from_account_id = ${a.id} or t.to_account_id = ${a.id})${r ? sql` and t.txn_date between ${r.from}::date and ${r.to}::date` : sql``}`);
  const st = statement(a.id, opening, txns);
  return { account: a, from: r?.from ?? a.openingDate, ...st };
}

/* ------------------------------------------------------------------ drawer */

export type TxnDetail = {
  t: TxnRow;
  files: { id: string; name: string; image: boolean }[];
  uses: TxnRow[];
  balanceAfter: number | null;
  history: { at: string; who: string | null; action: string }[];
};

export async function txnDetail(id: string): Promise<TxnDetail | null> {
  const [t] = await txnRows(sql`t.id = ${id}`);
  if (!t) return null;
  const [files, uses, history] = await Promise.all([
    q<{ id: string; name: string; type: string }>(sql`select id, filename as name, content_type as type from attachments where parent_type = 'erp_money_txn' and parent_id = ${id} and status <> 'removed' order by created_at`),
    txnRows(sql`t.source_txn_id = ${id}`),
    q<{ at: string; who: string | null; action: string }>(sql`select l.at::text as at, u.name as who, l.action from audit_log l left join users u on u.id = l.actor_id where l.entity_type = 'erp_money_txn' and l.entity_id = ${id} order by l.at`),
  ]);
  let balanceAfter: number | null = null;
  const acc = t.toAccountId ?? t.fromAccountId;
  if (acc && t.status === "active") {
    const a = (await moneyAccounts()).find((x) => x.id === acc);
    if (a) {
      const all = await txnRows(sql`t.status = 'active' and (t.from_account_id = ${a.id} or t.to_account_id = ${a.id}) and t.txn_date <= ${t.date}::date`);
      const st = statement(a.id, a.openingPaise, all);
      balanceAfter = st.rows.find((r) => r.t.id === t.id)?.balance ?? null;
    }
  }
  return { t, files: files.map((f) => ({ id: f.id, name: f.name, image: f.type.startsWith("image/") })), uses, balanceAfter, history };
}

/* ----------------------------------------------------------------- advance */

export async function advanceView(id: string): Promise<{ a: AdvanceRow; files: Map<string, { id: string; name: string }[]>; history: { at: string; who: string | null; action: string }[] } | null> {
  const [a] = await advanceRows(sql`a.id = ${id}`);
  if (!a) return null;
  const ids = a.bills.map((b) => b.id);
  const [files, history] = await Promise.all([
    ids.length ? q<{ id: string; parent: string; name: string }>(sql`select id, parent_id as parent, filename as name from attachments where parent_type = 'erp_money_txn' and parent_id in ${ids} and status <> 'removed'`) : Promise.resolve([]),
    q<{ at: string; who: string | null; action: string }>(sql`
      select l.at::text as at, u.name as who, l.action from audit_log l left join users u on u.id = l.actor_id
       where (l.entity_type = 'erp_money_txn' and l.entity_id in ${[id, ...ids, ...(a.issueTxn ? [a.issueTxn.id] : [])]}) or (l.entity_id = ${id})
       order by l.at`),
  ]);
  const byTxn = new Map<string, { id: string; name: string }[]>();
  for (const f of files) byTxn.set(f.parent, [...(byTxn.get(f.parent) ?? []), { id: f.id, name: f.name }]);
  return { a, files: byTxn, history };
}

export async function advanceList(): Promise<AdvanceRow[]> {
  return advanceRows(sql`a.status <> 'cancelled' or a.issued_on >= current_date - 90`);
}

/* -------------------------------------------------------------------- bank */

export type BankTab = "all" | "unmatched" | "matched" | "ignored" | "review";

export async function bankView(accountId: string | null, tab: BankTab, lineId: string | null, windowDays: number) {
  const accounts = (await moneyAccounts()).filter((a) => a.kind === "bank" && a.active);
  const account: MoneyAccount | undefined = accounts.find((a) => a.id === accountId) ?? accounts[0];
  if (!account) return null;
  const all = await bankLineRows(sql`l.account_id = ${account.id}`);
  const amount = (l: BankLineRow) => l.debitPaise + l.creditPaise;
  const state = (l: BankLineRow): "matched" | "partial" | "ignored" | "unmatched" => (l.status === "ignored" ? "ignored" : l.matchedPaise >= amount(l) ? "matched" : l.matchedPaise > 0 ? "partial" : "unmatched");
  const cands = await candidatesFor(all.filter((l) => state(l) === "unmatched" || state(l) === "partial"), windowDays);
  const review = (l: BankLineRow) => state(l) === "partial" || ((state(l) === "unmatched") && !(cands.get(l.id) ?? []).length);
  const counts = {
    all: all.length,
    unmatched: all.filter((l) => state(l) === "unmatched" && !review(l)).length,
    matched: all.filter((l) => state(l) === "matched").length,
    ignored: all.filter((l) => state(l) === "ignored").length,
    review: all.filter(review).length,
  };
  const lines = all.filter((l) =>
    tab === "all" ? true : tab === "matched" ? state(l) === "matched" : tab === "ignored" ? state(l) === "ignored" : tab === "review" ? review(l) : state(l) === "unmatched" && !review(l),
  );
  const selected = lines.find((l) => l.id === lineId) ?? lines.find((l) => state(l) !== "matched" && state(l) !== "ignored") ?? null;
  const perAccount = await Promise.all(
    accounts.map(async (a) => {
      const [c] = await q<{ n: number; last: string | null }>(sql`
        select count(*) filter (where l.status = 'open' and not exists (select 1 from erp_bank_matches m where m.line_id = l.id and m.voided_at is null))::int as n,
               max(l.line_date) filter (where exists (select 1 from erp_bank_matches m where m.line_id = l.id and m.voided_at is null))::text as last
          from erp_bank_lines l where l.account_id = ${a.id}`);
      return { ...a, unmatched: Number(c?.n ?? 0), lastMatched: c?.last ?? null };
    }),
  );
  return {
    accounts: perAccount,
    account,
    lines: lines.map((l) => ({ l, state: review(l) ? ("review" as const) : state(l) })),
    counts,
    selected,
    candidates: selected ? ((cands.get(selected.id) ?? []) as MatchCandidate<TxnRow>[]) : [],
    others: lines
      .filter((l) => l.id !== selected?.id && (state(l) === "unmatched" || state(l) === "partial"))
      .map((l) => ({ l, c: (cands.get(l.id) ?? [])[0] as MatchCandidate<TxnRow> | undefined }))
      .filter((x) => x.c)
      .slice(0, 6),
  };
}

export { partyOf, matchCandidates };
