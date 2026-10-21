import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, bankStatementUploads, erpBankLines, erpBankMatches, erpMoneyAccounts, paymentReceipts, vendorPayouts } from "@/db/schema";
import { requireCapability, resolveScope } from "@/lib/access-control";
import type { Capability } from "@/lib/capability-matrix";
import { getConfig } from "@/lib/config/store";
import {
  bankMark,
  bestSuggestion,
  candidatesFor,
  checkBalances,
  checkRows,
  flagFor,
  guessMode,
  inStatementOrder,
  MARK_CATEGORY,
  pdfLineKey,
  type AccountIn,
  type Candidate,
  type CheckedRow,
  type CustomerIn,
  type HeldLine,
  type LineIn,
  type LineState,
  type MarkKind,
  type MatchData,
  type PayoutIn,
  type ReadRow,
  type ReceiptIn,
  type TxnIn,
} from "@/lib/engines/bank-statements";
import * as M from "@/lib/erp/money";
import { DEFAULT_CATEGORIES } from "@/lib/erp/money-views";
import { refValues } from "@/lib/erp/refs";
import { PAY_MODES, txnLabel } from "@/lib/erp/engines/money";
import { today } from "@/lib/recompute";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { fileStorage } from "@/lib/storage";
import { confirmReceipt, recordReceipt, rejectReceipt, reverseReceipt } from "./receipt-service";
import { readStatementPdf, StatementLocked } from "./bank-statement-reader";

/* ---------------------------------------------------------------------------
 * BANK STATEMENT MANAGEMENT — Accounts' record of what the BANK says.
 *
 * Not Petty Cash's statements: those are our own record of each account
 * (ERP → Petty Cash → Cash & Bank → Petty Cash statements). This is the bank's
 * PDF, uploaded as often as anybody likes, read by OpenAI, checked, and its
 * new lines imported into `erp_bank_lines` — the ONE store of bank lines,
 * which Petty Cash reads to tick its own rows "✓ Bank".
 *
 * Each line is then explained once: matched to a customer receipt (which
 * confirms it), a vendor payout (which marks it paid), a Petty Cash
 * transaction, a transfer between our own accounts or a bank charge — or
 * marked by hand, which creates the record that was missing, or set aside
 * with a reason. A suggestion never moves money on its own.
 *
 * The PDF is kept `bankStatements.pdfRetentionDays` and then deleted by the
 * hourly sweep; the lines and every match stay.
 *
 * Who may: the three screens are modules (`accounts.bank-statements`,
 * `accounts.bank-reconcile`, `accounts.bank-uploads`). Uploading, importing,
 * fixing a figure and setting a line aside are `payment.record`; anything
 * that confirms, records or reverses money is `payment.confirm`, the Accounts
 * manager's — as confirming a receipt is everywhere else.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
type Ex = { execute: (q: SQL) => Promise<unknown> };
async function q<T>(query: SQL, ex: Ex = db): Promise<T[]> {
  return (await ex.execute(query)) as unknown as T[];
}

export const BANK_MODULES = {
  home: "accounts.bank-statements",
  reconcile: "accounts.bank-reconcile",
  uploads: "accounts.bank-uploads",
} as const;

type Ctx = Awaited<ReturnType<typeof requireCapability>>;

async function desk(capability: Capability): Promise<{ ctx: Ctx; refused?: undefined } | { refused: Result<never>; ctx?: undefined }> {
  try {
    return { ctx: await requireCapability(capability) };
  } catch {
    return {
      refused: err(
        capability === "payment.confirm"
          ? "Matching a bank line confirms or records money — that is the Accounts manager's."
          : "You cannot work bank statements.",
        "not_permitted",
      ),
    };
  }
}

async function audit(ctx: Ctx, action: string, entityId: string, after: Record<string, unknown>, before: Record<string, unknown> | null = null) {
  await db.insert(auditLog).values({
    id: id("aud"),
    actorId: ctx.user.id,
    actorRole: ctx.authorisedBy,
    actorApp: ctx.authorisedIn,
    action,
    entityType: "bank_line",
    entityId,
    beforeState: before as never,
    afterState: after as never,
  });
}

/** The Petty Cash writer, acting for Accounts: whoever holds `payment.confirm` here is the accountant there. */
const actorOf = (ctx: Ctx): M.Actor => ({ id: ctx.user.id, name: ctx.user.name, administrator: false, approver: true });

/* =================================================================== reads */

export type BankAccountView = {
  id: string;
  name: string;
  bankName: string | null;
  last4: string | null;
  accountType: string | null;
  mark: { letters: string; color: string };
  balancePaise: number | null;
  matched: number;
  unmatched: number;
  flagged: number;
  toDo: number;
  lastUploadAt: string | null;
};

/** Every line with its derived state — the one place "matched" is decided in SQL. */
const LINE_STATE = sql`
  case when l.status = 'ignored' then 'ignored'
       when coalesce(m.s, 0) >= l.debit_paise + l.credit_paise then 'matched'
       when l.flag is not null then 'flagged'
       when l.suggestion is not null then 'suggested'
       else 'unmatched' end`;
const MATCHED = sql`left join (select line_id, sum(amount_paise)::float8 as s from erp_bank_matches where voided_at is null group by line_id) m on m.line_id = l.id`;

export async function bankAccounts(): Promise<BankAccountView[]> {
  const rows = await q<{
    id: string;
    name: string;
    bank_name: string | null;
    last4: string | null;
    account_type: string | null;
    balance: number | null;
    matched: number;
    unmatched: number;
    flagged: number;
    suggested: number;
    last_upload: string | null;
  }>(sql`
    select a.id, a.name, a.bank_name, a.last4, a.account_type,
           (select l.balance_paise::float8 from erp_bank_lines l where l.account_id = a.id and l.balance_paise is not null
             order by l.line_date desc, l.line_no desc nulls last, l.created_at desc limit 1) as balance,
           coalesce(s.matched, 0)::int as matched, coalesce(s.unmatched, 0)::int as unmatched,
           coalesce(s.flagged, 0)::int as flagged, coalesce(s.suggested, 0)::int as suggested,
           (select max(u.uploaded_at)::text from bank_statement_uploads u where u.account_id = a.id) as last_upload
      from erp_money_accounts a
      left join (
        select l.account_id,
               count(*) filter (where st = 'matched') as matched,
               count(*) filter (where st in ('unmatched')) as unmatched,
               count(*) filter (where st = 'suggested') as suggested,
               count(*) filter (where st = 'flagged') as flagged
          from (select l.account_id, ${LINE_STATE} as st from erp_bank_lines l ${MATCHED}) l
         group by l.account_id) s on s.account_id = a.id
     where a.kind = 'bank' and a.active
     order by a.sort, a.name`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    bankName: r.bank_name,
    last4: r.last4,
    accountType: r.account_type,
    mark: bankMark(r.bank_name ?? r.name),
    balancePaise: r.balance == null ? null : Number(r.balance),
    matched: r.matched,
    unmatched: r.unmatched + r.suggested,
    flagged: r.flagged,
    toDo: r.unmatched + r.suggested + r.flagged,
    lastUploadAt: r.last_upload,
  }));
}

export type UploadRow = {
  id: string;
  accountId: string;
  account: string;
  mark: { letters: string; color: string };
  last4: string | null;
  fileName: string;
  fileSize: number;
  pages: number | null;
  status: "reading" | "ready" | "failed" | "imported" | "discarded";
  step: string | null;
  error: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  read: number;
  fresh: number;
  existing: number;
  balanceOk: boolean | null;
  breakAt: number | null;
  matched: number;
  imported: number;
  uploadedAt: string;
  uploadedBy: string | null;
  pdfExpiresAt: string;
  pdfKept: boolean;
  note: string | null;
};

const UPLOAD_SELECT = sql`
  select u.id, u.account_id as "accountId", a.name as account, a.bank_name as "bankName", a.last4, u.file_name as "fileName", u.file_size as "fileSize",
         u.pages, u.status, u.step, u.error, u.period_from as "periodFrom", u.period_to as "periodTo", u.lines_read as read,
         u.lines_new as fresh, u.lines_existing as existing, u.balance_ok as "balanceOk", u.break_at as "breakAt",
         u.uploaded_at::text as "uploadedAt", us.name as "uploadedBy", u.pdf_expires_at::text as "pdfExpiresAt",
         (u.file_ref is not null and u.pdf_deleted_at is null) as "pdfKept", u.note,
         (select count(*)::int from erp_bank_lines l where l.upload_id = u.id) as imported,
         (select count(*)::int from erp_bank_lines l ${MATCHED} where l.upload_id = u.id and coalesce(m.s, 0) >= l.debit_paise + l.credit_paise) as matched
    from bank_statement_uploads u
    join erp_money_accounts a on a.id = u.account_id
    left join users us on us.id = u.uploaded_by_id`;

function toUpload(r: Record<string, unknown>): UploadRow {
  return {
    id: r.id as string,
    accountId: r.accountId as string,
    account: r.account as string,
    mark: bankMark((r.bankName as string) ?? (r.account as string)),
    last4: (r.last4 as string) ?? null,
    fileName: r.fileName as string,
    fileSize: Number(r.fileSize),
    pages: r.pages == null ? null : Number(r.pages),
    status: r.status as UploadRow["status"],
    step: (r.step as string) ?? null,
    error: (r.error as string) ?? null,
    periodFrom: (r.periodFrom as string) ?? null,
    periodTo: (r.periodTo as string) ?? null,
    read: Number(r.read),
    fresh: Number(r.fresh),
    existing: Number(r.existing),
    balanceOk: (r.balanceOk as boolean) ?? null,
    breakAt: r.breakAt == null ? null : Number(r.breakAt),
    matched: Number(r.matched),
    imported: Number(r.imported),
    uploadedAt: r.uploadedAt as string,
    uploadedBy: (r.uploadedBy as string) ?? null,
    pdfExpiresAt: r.pdfExpiresAt as string,
    pdfKept: !!r.pdfKept,
    note: (r.note as string) ?? null,
  };
}

export async function uploadRows(where: SQL = sql`true`, limit = 200): Promise<UploadRow[]> {
  const rows = await q<Record<string, unknown>>(sql`${UPLOAD_SELECT} where ${where} order by u.uploaded_at desc limit ${limit}`);
  return rows.map(toUpload);
}

export type HomeView = {
  accounts: BankAccountView[];
  kpis: { creditsN: number; creditsPaise: number; debitsN: number; debitsPaise: number; flagged: number; matchedWeek: number; viaSuggestionPct: number | null };
  today: UploadRow[];
  review: UploadRow[];
};

export async function homeView(): Promise<HomeView> {
  const day = await today();
  const [accounts, k, uploadsToday, review] = await Promise.all([
    bankAccounts(),
    q<{ cn: number; cp: number; dn: number; dp: number; fl: number; mw: number; ms: number }>(sql`
      with s as (select l.credit_paise, l.debit_paise, ${LINE_STATE} as st from erp_bank_lines l ${MATCHED}
                   join erp_money_accounts a on a.id = l.account_id and a.kind = 'bank')
      select count(*) filter (where st in ('unmatched', 'suggested') and credit_paise > 0)::int as cn,
             coalesce(sum(credit_paise) filter (where st in ('unmatched', 'suggested') and credit_paise > 0), 0)::float8 as cp,
             count(*) filter (where st in ('unmatched', 'suggested') and debit_paise > 0)::int as dn,
             coalesce(sum(debit_paise) filter (where st in ('unmatched', 'suggested') and debit_paise > 0), 0)::float8 as dp,
             count(*) filter (where st = 'flagged')::int as fl,
             (select count(distinct line_id)::int from erp_bank_matches where voided_at is null and via is not null and at >= now() - interval '7 days') as mw,
             (select count(distinct line_id)::int from erp_bank_matches where voided_at is null and via = 'suggestion' and at >= now() - interval '7 days') as ms
        from s`),
    uploadRows(sql`(u.uploaded_at at time zone 'Asia/Kolkata')::date = ${day}::date`),
    uploadRows(sql`(u.status in ('reading', 'ready', 'failed') or (u.status = 'imported' and u.balance_ok is false and u.uploaded_at >= now() - interval '7 days'))`),
  ]);
  const x = k[0];
  return {
    accounts,
    kpis: {
      creditsN: x.cn,
      creditsPaise: Number(x.cp),
      debitsN: x.dn,
      debitsPaise: Number(x.dp),
      flagged: x.fl,
      matchedWeek: x.mw,
      viaSuggestionPct: x.mw ? Math.round((x.ms / x.mw) * 100) : null,
    },
    today: uploadsToday,
    review,
  };
}

/* ---------------------------------------------------------- one upload */

export type UploadDetail = UploadRow & {
  rows: CheckedRow[];
  openingPaise: number | null;
  closingPaise: number | null;
  warnings: string[];
  check: ReturnType<typeof checkBalances>;
};

export async function uploadDetail(uploadId: string): Promise<UploadDetail | null> {
  const [u] = await uploadRows(sql`u.id = ${uploadId}`, 1);
  if (!u) return null;
  const [raw] = await q<{ rows: CheckedRow[]; warnings: string[]; opening: number | null; closing: number | null }>(
    sql`select rows, warnings, opening_paise::float8 as opening, closing_paise::float8 as closing from bank_statement_uploads where id = ${uploadId}`,
  );
  const rows = raw.rows ?? [];
  const opening = raw.opening == null ? null : Number(raw.opening);
  const closing = raw.closing == null ? null : Number(raw.closing);
  return { ...u, rows, openingPaise: opening, closingPaise: closing, warnings: raw.warnings ?? [], check: checkBalances(rows, opening, closing) };
}

/* ------------------------------------------------------------- the lines */

export type LineView = {
  id: string;
  accountId: string;
  account: string;
  mark: { letters: string; color: string };
  last4: string | null;
  date: string;
  description: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  state: LineState;
  flag: string | null;
  flagNote: string | null;
  flagReceiptId: string | null;
  flagReceiptLabel: string | null;
  suggestion: Candidate | null;
  ignoreReason: string | null;
  matchedPaise: number;
  matchLabels: string[];
  markedAs: string | null;
  confidence: number | null;
  uploadId: string | null;
  page: number | null;
};

const LINE_SELECT = sql`
  select l.id, l.account_id as "accountId", a.name as account, a.bank_name as "bankName", a.last4, l.line_date::text as date,
         l.description, l.reference, l.debit_paise::float8 as debit, l.credit_paise::float8 as credit, l.balance_paise::float8 as balance,
         ${LINE_STATE} as state, l.flag, l.flag_note as "flagNote", l.suggestion, l.ignore_reason as "ignoreReason",
         l.flag_receipt_id as "flagReceiptId", (select coalesce(fr.receipt_no, 'R-' || upper(substr(fr.id, 5, 4))) from payment_receipts fr where fr.id = l.flag_receipt_id) as "flagReceiptLabel",
         coalesce(m.s, 0) as matched, l.marked_as as "markedAs", l.confidence, l.upload_id as "uploadId", l.page,
         (select coalesce(json_agg(coalesce(
             case when mm.txn_id is not null then 'TXN-' || t.txn_no end,
             case when mm.receipt_id is not null then 'Receipt ' || coalesce(r.receipt_no, 'R-' || upper(substr(r.id, 5, 4))) end,
             case when mm.payout_id is not null then coalesce('PR-' || p.pr_number, 'Payout') || ' · ' || p.payee_name end)), '[]')
            from erp_bank_matches mm
            left join erp_money_txns t on t.id = mm.txn_id
            left join payment_receipts r on r.id = mm.receipt_id
            left join vendor_payouts p on p.id = mm.payout_id
           where mm.line_id = l.id and mm.voided_at is null) as labels
    from erp_bank_lines l
    join erp_money_accounts a on a.id = l.account_id
    ${MATCHED}`;

function toLine(r: Record<string, unknown>): LineView {
  return {
    id: r.id as string,
    accountId: r.accountId as string,
    account: r.account as string,
    mark: bankMark((r.bankName as string) ?? (r.account as string)),
    last4: (r.last4 as string) ?? null,
    date: r.date as string,
    description: r.description as string,
    reference: (r.reference as string) ?? null,
    debitPaise: Number(r.debit),
    creditPaise: Number(r.credit),
    balancePaise: r.balance == null ? null : Number(r.balance),
    state: r.state as LineState,
    flag: (r.flag as string) ?? null,
    flagNote: (r.flagNote as string) ?? null,
    flagReceiptId: (r.flagReceiptId as string) ?? null,
    flagReceiptLabel: (r.flagReceiptLabel as string) ?? null,
    suggestion: (r.suggestion as Candidate) ?? null,
    ignoreReason: (r.ignoreReason as string) ?? null,
    matchedPaise: Number(r.matched),
    matchLabels: (r.labels as string[]) ?? [],
    markedAs: (r.markedAs as string) ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    uploadId: (r.uploadId as string) ?? null,
    page: r.page == null ? null : Number(r.page),
  };
}

export type ReconcileTab = "todo" | "suggested" | "unmatched" | "flagged" | "matched" | "ignored" | "all";
export type ReconcileFilter = { account: string | null; tab: ReconcileTab; q: string | null; dir: "both" | "in" | "out"; period: "7" | "30" | "month" | "all"; upload: string | null };

function filterSql(f: ReconcileFilter, day: string, withTab: boolean): SQL {
  const parts: SQL[] = [sql`a.kind = 'bank'`];
  if (f.account) parts.push(sql`l.account_id = ${f.account}`);
  if (f.upload) parts.push(sql`l.upload_id = ${f.upload}`);
  if (f.dir === "in") parts.push(sql`l.credit_paise > 0`);
  if (f.dir === "out") parts.push(sql`l.debit_paise > 0`);
  if (f.period === "7") parts.push(sql`l.line_date >= ${day}::date - 6`);
  if (f.period === "30") parts.push(sql`l.line_date >= ${day}::date - 29`);
  if (f.period === "month") parts.push(sql`l.line_date >= date_trunc('month', ${day}::date)::date`);
  if (f.q?.trim()) {
    const t = f.q.trim();
    const digits = t.replace(/[^\d.]/g, "");
    const paise = digits && /^\d+(\.\d{1,2})?$/.test(digits) ? Math.round(Number(digits) * 100) : null;
    parts.push(
      paise
        ? sql`(l.description ilike ${"%" + t + "%"} or coalesce(l.reference, '') ilike ${"%" + t + "%"} or l.debit_paise = ${paise} or l.credit_paise = ${paise})`
        : sql`(l.description ilike ${"%" + t + "%"} or coalesce(l.reference, '') ilike ${"%" + t + "%"})`,
    );
  }
  if (withTab) {
    const tab = f.tab;
    if (tab === "todo") parts.push(sql`${LINE_STATE} in ('unmatched', 'suggested', 'flagged')`);
    else if (tab !== "all") parts.push(sql`${LINE_STATE} = ${tab}`);
  }
  return sql.join(parts, sql` and `);
}

export type ReconcileView = {
  accounts: { id: string; name: string; mark: { letters: string; color: string }; last4: string | null; toDo: number }[];
  allToDo: number;
  counts: Record<ReconcileTab, number>;
  rows: LineView[];
  more: boolean;
  acceptable: number;
};

export async function reconcileView(f: ReconcileFilter, limit = 200): Promise<ReconcileView> {
  const day = await today();
  const [accounts, countRows, rows, acc] = await Promise.all([
    bankAccounts(),
    q<{ st: LineState; n: number }>(sql`select ${LINE_STATE} as st, count(*)::int as n from erp_bank_lines l join erp_money_accounts a on a.id = l.account_id ${MATCHED} where ${filterSql(f, day, false)} group by 1`),
    q<Record<string, unknown>>(sql`${LINE_SELECT} where ${filterSql(f, day, true)}
      order by l.line_date desc, l.upload_id desc nulls last, l.line_no nulls last, l.created_at
      limit ${limit + 1}`),
    q<{ n: number }>(sql`select count(*)::int as n from erp_bank_lines l join erp_money_accounts a on a.id = l.account_id ${MATCHED} where ${filterSql({ ...f, tab: "suggested" }, day, true)}`),
  ]);
  const by = Object.fromEntries(countRows.map((r) => [r.st, r.n])) as Partial<Record<LineState, number>>;
  const n = (s: LineState) => by[s] ?? 0;
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, mark: a.mark, last4: a.last4, toDo: a.toDo })),
    allToDo: accounts.reduce((s, a) => s + a.toDo, 0),
    counts: {
      todo: n("unmatched") + n("suggested") + n("flagged"),
      suggested: n("suggested"),
      unmatched: n("unmatched"),
      flagged: n("flagged"),
      matched: n("matched"),
      ignored: n("ignored"),
      all: Object.values(by).reduce((s, x) => s + (x ?? 0), 0),
    },
    rows: rows.slice(0, limit).map(toLine),
    more: rows.length > limit,
    acceptable: acc[0]?.n ?? 0,
  };
}

/** The lines still to do, for the sidebar's badge. */
export async function bankToDoCount(): Promise<number> {
  const [r] = await q<{ n: number }>(sql`select count(*)::int as n from erp_bank_lines l join erp_money_accounts a on a.id = l.account_id and a.kind = 'bank' ${MATCHED}
    where ${LINE_STATE} in ('unmatched', 'suggested', 'flagged')`);
  return r?.n ?? 0;
}

export type LineDetail = {
  line: LineView;
  candidates: Candidate[];
  best: Candidate | null;
  upload: { id: string; at: string; pdfKept: boolean } | null;
  flagReceipt: { id: string; label: string; amountPaise: number; customer: string } | null;
  matches: { id: string; label: string; amountPaise: number; via: string | null; at: string; by: string | null }[];
};

export async function lineDetail(lineId: string): Promise<LineDetail | null> {
  const [r] = await q<Record<string, unknown>>(sql`${LINE_SELECT} where l.id = ${lineId}`);
  if (!r) return null;
  const line = toLine(r);
  const data = await matchData([line.accountId]);
  const s = await matchSettings();
  const dismissed = await dismissedOf(lineId);
  const lin = await lineIn(lineId);
  const candidates = lin ? candidatesFor(lin, data, s).filter((c) => !dismissed.includes(candKey(c))) : [];
  const flag = lin && line.state !== "matched" && line.state !== "ignored" ? flagFor(lin, candidates, data, s, await confirmedReceipts()) : null;
  const flagReceipt = flag?.receiptId ? await receiptBrief(flag.receiptId) : null;
  const [up] = line.uploadId
    ? await q<{ id: string; at: string; kept: boolean }>(sql`select id, uploaded_at::text as at, (file_ref is not null and pdf_deleted_at is null) as kept from bank_statement_uploads where id = ${line.uploadId}`)
    : [];
  const matches = await q<{ id: string; label: string; amount: number; via: string | null; at: string; by: string | null }>(sql`
    select mm.id, coalesce(
             case when mm.txn_id is not null then 'TXN-' || t.txn_no || ' · ' || coalesce(t.payee, t.payer, t.category, t.kind) end,
             case when mm.receipt_id is not null then 'Receipt ' || coalesce(r.receipt_no, 'R-' || upper(substr(r.id, 5, 4))) || ' · ' || c.name end,
             case when mm.payout_id is not null then coalesce('PR-' || p.pr_number, 'Payout') || ' · ' || p.payee_name end) as label,
           mm.amount_paise::float8 as amount, mm.via, mm.at::text as at, u.name as by
      from erp_bank_matches mm
      left join erp_money_txns t on t.id = mm.txn_id
      left join payment_receipts r on r.id = mm.receipt_id
      left join customers c on c.id = r.customer_id
      left join vendor_payouts p on p.id = mm.payout_id
      left join users u on u.id = mm.by_id
     where mm.line_id = ${lineId} and mm.voided_at is null order by mm.at`);
  return {
    line,
    candidates,
    best: bestSuggestion(candidates),
    upload: up ? { id: up.id, at: up.at, pdfKept: up.kept } : null,
    flagReceipt,
    matches: matches.map((m) => ({ id: m.id, label: m.label, amountPaise: Number(m.amount), via: m.via, at: m.at, by: m.by })),
  };
}

const candKey = (c: Pick<Candidate, "kind" | "id">) => `${c.kind}:${c.id ?? ""}`;

async function dismissedOf(lineId: string): Promise<string[]> {
  const [r] = await q<{ d: string[] }>(sql`select dismissed as d from erp_bank_lines where id = ${lineId}`);
  return r?.d ?? [];
}

async function receiptBrief(receiptId: string) {
  const [r] = await q<{ id: string; label: string; amount: number; customer: string }>(sql`
    select r.id, 'Receipt ' || coalesce(r.receipt_no, 'R-' || upper(substr(r.id, 5, 4))) as label, r.amount::float8 as amount, c.name as customer
      from payment_receipts r join customers c on c.id = r.customer_id where r.id = ${receiptId}`);
  return r ? { id: r.id, label: r.label, amountPaise: Number(r.amount), customer: r.customer } : null;
}

/* ------------------------------------------------------- the match data */

async function matchSettings() {
  const cfg = await getConfig();
  return {
    windowDays: cfg["bankStatements.matchWindowDays"],
    lowConfidence: cfg["bankStatements.lowConfidencePercent"],
    largeCreditPaise: cfg["bankStatements.largeCreditPaise"],
  };
}

const RECEIPT_LABEL = sql`'Receipt ' || coalesce(r.receipt_no, 'R-' || upper(substr(r.id, 5, 4)))`;

async function receiptsIn(where: SQL): Promise<ReceiptIn[]> {
  const rows = await q<Record<string, unknown>>(sql`
    select r.id, ${RECEIPT_LABEL} as label, r.customer_id as "customerId", c.name as customer, r.amount::float8 as amount, r.reference, r.mode,
           coalesce(r.instrument_date, r.received_at)::text as date, r.status::text as status, r.hold_reason as "holdReason", u.name as "reportedBy",
           (select string_agg(b.bill_no, ', ') from payments p join bills b on b.id = p.bill_id where p.receipt_id = r.id) as bills
      from payment_receipts r
      join customers c on c.id = r.customer_id
      left join users u on u.id = r.reported_by_id
     where ${where}
       and not exists (select 1 from erp_bank_matches m where m.receipt_id = r.id and m.voided_at is null)`);
  return rows.map((r) => ({
    id: r.id as string,
    label: r.label as string,
    customerId: r.customerId as string,
    customer: r.customer as string,
    amountPaise: Number(r.amount),
    reference: (r.reference as string) ?? null,
    mode: (r.mode as string) ?? "",
    date: r.date as string,
    status: r.status as ReceiptIn["status"],
    holdReason: (r.holdReason as string) ?? null,
    reportedBy: (r.reportedBy as string) ?? null,
    bills: (r.bills as string) ?? null,
  }));
}

async function confirmedReceipts(): Promise<ReceiptIn[]> {
  const rows = await q<Record<string, unknown>>(sql`
    select r.id, ${RECEIPT_LABEL} as label, r.customer_id as "customerId", c.name as customer, r.amount::float8 as amount, r.reference, r.mode,
           r.received_at::text as date, 'confirmed' as status
      from payment_receipts r join customers c on c.id = r.customer_id
     where r.status = 'confirmed' and r.reference is not null and r.received_at >= current_date - 120`);
  return rows.map((r) => ({
    id: r.id as string,
    label: r.label as string,
    customerId: r.customerId as string,
    customer: r.customer as string,
    amountPaise: Number(r.amount),
    reference: (r.reference as string) ?? null,
    mode: (r.mode as string) ?? "",
    date: r.date as string,
    status: "confirmed",
    holdReason: null,
    reportedBy: null,
    bills: null,
  }));
}

async function matchData(accountIds: string[]): Promise<MatchData> {
  const [receipts, confirmedRecent, bills, payouts, txns, accounts, lines] = await Promise.all([
    receiptsIn(sql`r.status in ('reported', 'held')`),
    receiptsIn(sql`r.status = 'confirmed' and r.received_at >= current_date - 30 and r.mode not in ('Adjustment', 'Credit note', 'Cash') and r.source <> 'sheet_import'`),
    q<{ cid: string; name: string; id: string; no: string; bd: string; dd: string | null; bal: number }>(sql`
      select c.id as cid, c.name, b.id, b.bill_no as no, b.bill_date::text as bd, b.due_date::text as dd, (b.amount - b.paid_amount)::float8 as bal
        from bills b join customers c on c.id = b.customer_id
       where b.amount > b.paid_amount and not b.disputed
       order by c.id, b.bill_date, b.bill_no`),
    q<Record<string, unknown>>(sql`
      select p.id, coalesce('PR-' || p.pr_number, 'VP-' || upper(substr(p.id, 5, 4))) as label, p.payee_name as payee,
             coalesce(p.paid_amount_paise, p.amount_paise)::float8 as amount, p.pay_on::text as "payOn", p.due_date::text as "dueDate", p.reference as "billNos",
             p.pr_number as "prNumber", p.status, p.description
        from vendor_payouts p
       where (p.status in ('open', 'on_hold') or (p.status = 'paid' and p.paid_on >= current_date - 30))
         and not exists (select 1 from erp_bank_matches m where m.payout_id = p.id and m.voided_at is null)`),
    q<Record<string, unknown>>(sql`
      select t.id, t.txn_no as no, t.txn_date::text as date, t.kind, coalesce(t.payee, t.payer, t.category, t.kind) as party, t.reference,
             (t.amount_paise - coalesce((select sum(m.amount_paise) from erp_bank_matches m where m.txn_id = t.id and m.voided_at is null), 0))::float8 as left_,
             t.from_account_id as "fromId", t.to_account_id as "toId"
        from erp_money_txns t
       where t.status = 'active' and (t.from_account_id in ${accountIds} or t.to_account_id in ${accountIds}) and t.txn_date >= current_date - 120`),
    q<{ id: string; name: string; bank_name: string | null; last4: string | null; kind: string }>(sql`select id, name, bank_name, last4, kind from erp_money_accounts where active`),
    q<Record<string, unknown>>(sql`select id, account_id as "accountId", line_date::text as date, reference, debit_paise::float8 as debit, credit_paise::float8 as credit
      from erp_bank_lines where line_date >= current_date - 120`),
  ]);
  const customers = new Map<string, CustomerIn>();
  for (const b of bills) {
    const c = customers.get(b.cid) ?? { id: b.cid, name: b.name, bills: [] };
    c.bills.push({ id: b.id, billNo: b.no, billDate: b.bd, dueDate: b.dd, balancePaise: Number(b.bal) });
    customers.set(b.cid, c);
  }
  const txnIn: TxnIn[] = [];
  for (const t of txns) {
    const left = Number(t.left_);
    if (left <= 0) continue;
    const base = { id: t.id as string, label: txnLabel(Number(t.no), t.date as string), kind: t.kind as string, party: t.party as string, amountPaise: left, date: t.date as string, reference: (t.reference as string) ?? null };
    if (t.fromId && accountIds.includes(t.fromId as string)) txnIn.push({ ...base, out: true, accountId: t.fromId as string });
    if (t.toId && accountIds.includes(t.toId as string)) txnIn.push({ ...base, out: false, accountId: t.toId as string });
  }
  return {
    receipts: [...receipts, ...confirmedRecent],
    customers: [...customers.values()],
    payouts: payouts.map(
      (p): PayoutIn => ({
        id: p.id as string,
        label: p.label as string,
        payee: p.payee as string,
        amountPaise: Number(p.amount),
        payOn: p.payOn as string,
        dueDate: p.dueDate as string,
        billNos: (p.billNos as string) ?? null,
        prNumber: p.prNumber == null ? null : Number(p.prNumber),
        status: p.status as PayoutIn["status"],
        description: (p.description as string) ?? null,
      }),
    ),
    txns: txnIn,
    accounts: accounts.map((a): AccountIn => ({ id: a.id, name: a.name, bankName: a.bank_name, last4: a.last4, kind: a.kind })),
    lines: lines.map((l) => ({ id: l.id as string, accountId: l.accountId as string, date: l.date as string, reference: (l.reference as string) ?? null, debitPaise: Number(l.debit), creditPaise: Number(l.credit) })),
  };
}

async function lineIn(lineId: string): Promise<LineIn | null> {
  const [l] = await q<Record<string, unknown>>(sql`select id, account_id as "accountId", line_date::text as date, description, reference,
    debit_paise::float8 as debit, credit_paise::float8 as credit, confidence, balance_break as brk from erp_bank_lines where id = ${lineId}`);
  return l ? toLineIn(l) : null;
}

const toLineIn = (l: Record<string, unknown>): LineIn => ({
  id: l.id as string,
  accountId: l.accountId as string,
  date: l.date as string,
  description: l.description as string,
  reference: (l.reference as string) ?? null,
  debitPaise: Number(l.debit),
  creditPaise: Number(l.credit),
  confidence: l.confidence == null ? null : Number(l.confidence),
  breakHere: !!l.brk,
});

/**
 * Works out the suggestion and the flag of every line still open on these
 * accounts. Run after an import, after every match and every undo — a match
 * spends a receipt, and the next line must stop being offered it.
 */
export async function refreshSuggestions(accountIds?: string[]): Promise<{ lines: number; suggested: number; flagged: number }> {
  const accounts = accountIds?.length
    ? accountIds
    : (await q<{ id: string }>(sql`select id from erp_money_accounts where kind = 'bank'`)).map((a) => a.id);
  if (!accounts.length) return { lines: 0, suggested: 0, flagged: 0 };
  const open = await q<Record<string, unknown>>(sql`
    select l.id, l.account_id as "accountId", l.line_date::text as date, l.description, l.reference, l.debit_paise::float8 as debit,
           l.credit_paise::float8 as credit, l.confidence, l.balance_break as brk, l.dismissed, l.suggestion, l.flag, l.flag_note as "flagNote", l.flag_receipt_id as "flagReceiptId"
      from erp_bank_lines l ${MATCHED}
     where l.account_id in ${accounts} and l.status = 'open' and coalesce(m.s, 0) < l.debit_paise + l.credit_paise`);
  if (!open.length) return { lines: 0, suggested: 0, flagged: 0 };
  const [data, s, confirmed] = await Promise.all([matchData(accounts), matchSettings(), confirmedReceipts()]);
  let suggested = 0;
  let flagged = 0;
  const taken = new Set<string>();
  for (const raw of open) {
    const l = toLineIn(raw);
    const dismissed = (raw.dismissed as string[]) ?? [];
    const cands = candidatesFor(l, data, s).filter((c) => !dismissed.includes(candKey(c)));
    let best = bestSuggestion(cands);
    if (best?.id && ["receipt", "payout", "txn", "bill"].includes(best.kind)) {
      /* A receipt, a payout or a bill is offered to one line only — two lines
         both "suggested" against R-2291 would let one be accepted twice. */
      if (taken.has(candKey(best))) best = null;
      else taken.add(candKey(best));
    }
    const flag = flagFor(l, cands, data, s, confirmed);
    if (best) suggested++;
    if (flag) flagged++;
    const next = { suggestion: best ? JSON.stringify(best) : null, flag: flag?.flag ?? null, note: flag?.note ?? null, receipt: flag?.receiptId ?? null };
    const prev = { suggestion: raw.suggestion ? JSON.stringify(raw.suggestion) : null, flag: (raw.flag as string) ?? null, note: (raw.flagNote as string) ?? null, receipt: (raw.flagReceiptId as string) ?? null };
    if (next.flag === prev.flag && next.note === prev.note && next.receipt === prev.receipt && next.suggestion === prev.suggestion) continue;
    await db.execute(sql`update erp_bank_lines set suggestion = ${next.suggestion}::jsonb, flag = ${next.flag}, flag_note = ${next.note}, flag_receipt_id = ${next.receipt} where id = ${l.id}`);
  }
  return { lines: open.length, suggested, flagged };
}

/* ================================================================ uploads */

/**
 * Stores the PDF and starts reading it. The reading runs after the answer, so
 * the screen can show its progress — and the person can close it.
 */
export async function startUpload(input: { accountId: string; fileName: string; bytes: Uint8Array; note: string | null }): Promise<Result<{ id: string }>> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  const cfg = await getConfig();
  if (!cfg["bankStatements.enabled"]) return err("Reading bank statements is switched off in Settings.", "rule_violation");
  const [acc] = await db.select().from(erpMoneyAccounts).where(eq(erpMoneyAccounts.id, input.accountId));
  if (!acc || acc.kind !== "bank" || !acc.active) return fieldErr("account", "Choose the bank account the statement is from.");
  const max = cfg["bankStatements.maxPdfMb"];
  if (input.bytes.byteLength > max * 1024 * 1024) return fieldErr("file", `${input.fileName} is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${max} MB.`);
  const b = input.bytes;
  if (!(b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)) return fieldErr("file", `${input.fileName} is not a PDF, whatever it is named.`);
  const uploadId = id("bsu");
  const stored = await fileStorage.upload({ key: `bank-statements/${uploadId}.pdf`, body: input.bytes, contentType: "application/pdf" });
  const days = cfg["bankStatements.pdfRetentionDays"];
  await db.insert(bankStatementUploads).values({
    id: uploadId,
    accountId: acc.id,
    fileName: input.fileName,
    fileSize: input.bytes.byteLength,
    fileRef: stored.ref,
    note: input.note?.trim() || null,
    status: "reading",
    step: "uploaded",
    model: cfg["bankStatements.model"],
    uploadedById: d.ctx.user.id,
    pdfExpiresAt: new Date(Date.now() + days * 86_400_000),
  });
  await audit(d.ctx, "bank.upload", uploadId, { account: acc.name, file: input.fileName, size: input.bytes.byteLength });
  return ok({ id: uploadId });
}

/** Reads a stored PDF: the model, then the check. Never throws — a failure is written on the upload, in words. */
export async function readUpload(uploadId: string, password: string | null): Promise<void> {
  const [u] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
  if (!u || u.status !== "reading" || !u.fileRef) return;
  const set = (v: Partial<typeof bankStatementUploads.$inferInsert>) => db.update(bankStatementUploads).set(v).where(eq(bankStatementUploads.id, uploadId));
  try {
    const cfg = await getConfig();
    await set({ step: "reading" });
    const bytes = new Uint8Array(await fileStorage.read(u.fileRef));
    const reading = await readStatementPdf({
      bytes,
      fileName: u.fileName,
      password,
      model: u.model ?? cfg["bankStatements.model"],
      // "reading 3/10": three pieces of ten read. The screen draws it as pages.
      onProgress: (done, total, pages) => set({ step: `reading ${done}/${total}`, pages }).then(() => undefined),
    });
    await set({ step: "checking", pages: reading.pages });
    const ordered = inStatementOrder(reading.rows, reading.openingPaise);
    const check = checkBalances(ordered, reading.openingPaise, reading.closingPaise);
    const held = await heldLines(u.accountId, ordered);
    const rows = checkRows(ordered, held, check.breaks, cfg["bankStatements.lowConfidencePercent"]);
    const [acc] = await db.select().from(erpMoneyAccounts).where(eq(erpMoneyAccounts.id, u.accountId));
    const warnings: string[] = [];
    if (reading.accountLast4 && acc?.last4 && reading.accountLast4 !== acc.last4.replace(/\D/g, "").slice(-4)) {
      warnings.push(`The PDF is for an account ending ${reading.accountLast4}, not ··${acc.last4}. Check you chose the right account.`);
    }
    if (!rows.length) warnings.push("No transaction lines were found in this PDF.");
    await set({
      status: "ready",
      step: "ready",
      periodFrom: reading.periodFrom,
      periodTo: reading.periodTo,
      openingPaise: check.openingPaise,
      closingPaise: reading.closingPaise ?? check.closingPaise,
      rows: rows as never,
      warnings: warnings as never,
      balanceOk: check.ok,
      breakAt: check.breaks[0] ?? null,
      linesRead: rows.length,
      linesNew: rows.filter((r) => !r.existing).length,
      linesExisting: rows.filter((r) => r.existing).length,
      inputTokens: reading.inputTokens,
      outputTokens: reading.outputTokens,
      readAt: new Date(),
    });
    if (acc && !acc.last4 && reading.accountLast4) await db.update(erpMoneyAccounts).set({ last4: reading.accountLast4 }).where(eq(erpMoneyAccounts.id, acc.id));
  } catch (e) {
    const message =
      e instanceof StatementLocked
        ? e.wrongPassword
          ? "That password does not open this PDF. Upload it again with the right one."
          : "This PDF is locked with a password. Upload it again and type the password."
        : `The PDF could not be read. ${e instanceof Error ? e.message : ""}`.trim();
    await set({ status: "failed", step: "failed", error: message.slice(0, 500) });
  }
}

/** The lines this account already holds over the reading's dates. */
async function heldLines(accountId: string, rows: Pick<ReadRow, "date">[]): Promise<HeldLine[]> {
  if (!rows.length) return [];
  const from = rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date);
  const to = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
  const held = await q<Record<string, unknown>>(sql`
    select line_date::text as date, debit_paise::float8 as debit, credit_paise::float8 as credit, balance_paise::float8 as balance, reference, description, created_at::text as "createdAt"
      from erp_bank_lines where account_id = ${accountId} and line_date between ${from}::date and ${to}::date`);
  return held.map((h) => ({
    date: h.date as string,
    debitPaise: Number(h.debit),
    creditPaise: Number(h.credit),
    balancePaise: h.balance == null ? null : Number(h.balance),
    reference: (h.reference as string) ?? null,
    description: h.description as string,
    createdAt: h.createdAt as string,
  }));
}

/** Where the reading is, for the screen that polls it. */
export async function uploadStatus(uploadId: string): Promise<UploadDetail | null> {
  return uploadDetail(uploadId);
}

export type RowEdit = { lineNo: number; date?: string; narration?: string; reference?: string | null; debitPaise?: number; creditPaise?: number; balancePaise?: number | null };

/** A person corrects what was read before it is imported. The check runs again over the corrected rows. */
export async function editUploadRows(uploadId: string, edits: RowEdit[]): Promise<Result<UploadDetail>> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  const u = await uploadDetail(uploadId);
  if (!u) return err("That upload is gone.", "not_found");
  if (u.status !== "ready") return err(u.status === "imported" ? "This upload is already imported. Fix the line on Reconcile." : "This upload is not waiting to be imported.", "conflict");
  const rows: ReadRow[] = u.rows.map((r) => {
    const e = edits.find((x) => x.lineNo === r.lineNo);
    if (!e) return r;
    const next = {
      ...r,
      date: e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : r.date,
      narration: e.narration?.trim() || r.narration,
      reference: e.reference === undefined ? r.reference : e.reference?.trim() || null,
      debitPaise: e.debitPaise ?? r.debitPaise,
      creditPaise: e.creditPaise ?? r.creditPaise,
      balancePaise: e.balancePaise === undefined ? r.balancePaise : e.balancePaise,
      confidence: 100,
    };
    return { ...next, edited: true } as ReadRow;
  });
  for (const r of rows) if ((r.debitPaise > 0) === (r.creditPaise > 0)) return fieldErr(`row${r.lineNo}`, `Line ${r.lineNo} needs a debit or a credit, not both.`);
  const cfg = await getConfig();
  const check = checkBalances(rows, u.openingPaise, u.closingPaise);
  const checked = checkRows(rows, await heldLines(u.accountId, rows), check.breaks, cfg["bankStatements.lowConfidencePercent"]).map((r) => ({
    ...r,
    edited: rows.find((x) => x.lineNo === r.lineNo && (x as CheckedRow).edited) ? true : undefined,
  }));
  await db
    .update(bankStatementUploads)
    .set({
      rows: checked as never,
      balanceOk: check.ok,
      breakAt: check.breaks[0] ?? null,
      linesNew: checked.filter((r) => !r.existing).length,
      linesExisting: checked.filter((r) => r.existing).length,
    })
    .where(eq(bankStatementUploads.id, uploadId));
  await audit(d.ctx, "bank.upload.edit", uploadId, { lines: edits.map((e) => e.lineNo) });
  return ok((await uploadDetail(uploadId))!, "Corrected · the check ran again");
}

/** Imports the rows the account does not hold yet, then works out what each could be. */
export async function importUpload(uploadId: string): Promise<Result<{ added: number; skipped: number; suggested: number; flagged: number }>> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  const u = await uploadDetail(uploadId);
  if (!u) return err("That upload is gone.", "not_found");
  if (u.status !== "ready") return err(u.status === "imported" ? "This upload is already imported." : "This upload is not ready to import.", "conflict");
  let added = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from bank_statement_uploads where id = ${uploadId} for update`);
    // Read again inside the lock: another upload may have imported the same lines a moment ago.
    const held = await heldLines(u.accountId, u.rows);
    const again = checkRows(u.rows, held, u.check.breaks, (await getConfig())["bankStatements.lowConfidencePercent"]);
    for (const r of again) {
      if (r.existing) {
        skipped++;
        continue;
      }
      const res = (await tx
        .insert(erpBankLines)
        .values({
          id: id("bl"),
          accountId: u.accountId,
          lineDate: r.date,
          description: r.narration,
          reference: r.reference,
          debitPaise: r.debitPaise,
          creditPaise: r.creditPaise,
          balancePaise: r.balancePaise,
          lineKey: pdfLineKey(r),
          importBatch: uploadId,
          uploadId,
          lineNo: r.lineNo,
          page: r.page,
          confidence: r.confidence,
          balanceBreak: r.breakHere && !(r as CheckedRow).edited,
          createdById: d.ctx.user.id,
        })
        .onConflictDoNothing()
        .returning({ id: erpBankLines.id })) as { id: string }[];
      if (res.length) added++;
      else skipped++;
    }
    await tx
      .update(bankStatementUploads)
      .set({ status: "imported", step: "imported", importedAt: new Date(), importedById: d.ctx.user.id, linesNew: added, linesExisting: skipped })
      .where(eq(bankStatementUploads.id, uploadId));
  });
  const r = await refreshSuggestions([u.accountId]);
  await audit(d.ctx, "bank.import", uploadId, { account: u.account, added, skipped });
  return ok({ added, skipped, suggested: r.suggested, flagged: r.flagged }, `${added} new line${added === 1 ? "" : "s"} imported to ${u.account}${skipped ? ` · ${skipped} already in` : ""}`);
}

export async function discardUpload(uploadId: string): Promise<Result> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  const [u] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
  if (!u) return err("That upload is gone.", "not_found");
  if (u.status === "imported") return err("An imported upload stays. Set its lines aside on Reconcile instead.", "rule_violation");
  if (u.fileRef) await fileStorage.remove(u.fileRef).catch(() => {});
  await db.update(bankStatementUploads).set({ status: "discarded", step: "discarded", fileRef: null, pdfDeletedAt: new Date() }).where(eq(bankStatementUploads.id, uploadId));
  await audit(d.ctx, "bank.upload.discard", uploadId, { file: u.fileName });
  return okVoid("Upload discarded · its PDF is deleted");
}

/** The PDF's bytes, while it is kept. Asked by the route, which checks the screen first. */
export async function uploadPdf(uploadId: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  const [u] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
  if (!u?.fileRef || u.pdfDeletedAt) return null;
  return { bytes: new Uint8Array(await fileStorage.read(u.fileRef)), name: u.fileName };
}

/** The hourly clean-up: a PDF past its days is deleted; the upload row and its lines stay. */
export async function sweepStatementPdfs(): Promise<{ deleted: number }> {
  const due = await q<{ id: string; ref: string }>(sql`select id, file_ref as ref from bank_statement_uploads where file_ref is not null and pdf_deleted_at is null and pdf_expires_at <= now() limit 500`);
  let deleted = 0;
  for (const u of due) {
    try {
      await fileStorage.remove(u.ref);
    } catch {
      continue;
    }
    await db.update(bankStatementUploads).set({ fileRef: null, pdfDeletedAt: new Date() }).where(eq(bankStatementUploads.id, u.id));
    deleted++;
  }
  /* An upload that never finished reading (the server restarted mid-read) is said to have failed, not left spinning. */
  await db.execute(sql`update bank_statement_uploads set status = 'failed', step = 'failed', error = 'The reading did not finish. Upload the PDF again.'
    where status = 'reading' and uploaded_at < now() - interval '90 minutes'`);
  return { deleted };
}

/* ============================================================== matching */

async function lockOpenLine(tx: Ex, lineId: string): Promise<Result<LineView>> {
  await tx.execute(sql`select id from erp_bank_lines where id = ${lineId} for update`);
  const [r] = await q<Record<string, unknown>>(sql`${LINE_SELECT} where l.id = ${lineId}`, tx);
  if (!r) return err("That line is gone.", "not_found");
  const line = toLine(r);
  if (line.state === "ignored") return err("This line is set aside. Bring it back first.", "rule_violation");
  if (line.matchedPaise > 0) return err("This line is already matched. Undo it to match again.", "conflict");
  return ok(line);
}

async function insertMatch(lineId: string, target: { txnId?: string; receiptId?: string; payoutId?: string }, amountPaise: number, via: "suggestion" | "hand", byId: string): Promise<Result> {
  try {
    return await db.transaction(async (tx) => {
      const l = await lockOpenLine(tx, lineId);
      if (!l.ok) return l;
      await tx.insert(erpBankMatches).values({ id: id("bm"), lineId, txnId: target.txnId ?? null, receiptId: target.receiptId ?? null, payoutId: target.payoutId ?? null, amountPaise, via, byId });
      await tx.update(erpBankLines).set({ suggestion: null, flag: null, flagNote: null, flagReceiptId: null }).where(eq(erpBankLines.id, lineId));
      return okVoid();
    });
  } catch (e) {
    if (String((e as { code?: string })?.code) === "23505") return err("That receipt or payout is already matched to another bank line.", "conflict");
    throw e;
  }
}

async function openLine(lineId: string): Promise<Result<LineView>> {
  const [r] = await q<Record<string, unknown>>(sql`${LINE_SELECT} where l.id = ${lineId}`);
  if (!r) return err("That line is gone.", "not_found");
  const line = toLine(r);
  if (line.state === "ignored") return err("This line is set aside. Bring it back first.", "rule_violation");
  if (line.matchedPaise > 0) return err("This line is already matched.", "conflict");
  return ok(line);
}

const amountOf = (l: Pick<LineView, "debitPaise" | "creditPaise">) => l.debitPaise || l.creditPaise;

async function receiptMode(description: string): Promise<string> {
  const modes = (await getConfig())["payments.modes"];
  const g = guessMode(description);
  const want = g === "UPI" ? "UPI" : g === "Cheque" ? "Cheque" : g === "Cash" ? "Cash" : "Bank transfer";
  return modes.includes(want) ? want : modes.includes("Bank transfer") ? "Bank transfer" : modes[0];
}

const payMode = (description: string): string => {
  const g = guessMode(description);
  return (PAY_MODES as readonly string[]).includes(g) ? g : "NEFT";
};

/**
 * Accepts what was suggested — or any candidate the panel offered — and does
 * what it means: confirms the receipt, records a payment against the bill,
 * marks the payout paid, matches the Petty Cash transaction, enters the
 * transfer or the charge. Every one of those is the existing writer, so its
 * own rules still apply.
 */
export async function acceptCandidate(lineId: string, c: Pick<Candidate, "kind" | "id">, via: "suggestion" | "hand" = "hand"): Promise<Result<{ message: string }>> {
  const d = await desk("payment.confirm");
  if (d.refused) return d.refused;
  const o = await openLine(lineId);
  if (!o.ok) return o;
  const line = o.data;
  const amount = amountOf(line);
  const actor = actorOf(d.ctx);
  let message = "";

  if (c.kind === "receipt" && c.id) {
    const [r] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, c.id));
    if (!r) return err("That receipt is gone.", "not_found");
    if (Number(r.amount) !== amount) return err(`The receipt is for ${inr(Number(r.amount))} and the bank line is ${inr(amount)}. Mark it by hand.`, "rule_violation");
    if (r.status === "reported" || r.status === "held") {
      const conf = await confirmReceipt(r.id);
      if (!conf.ok) return conf;
      message = conf.message ?? "Receipt confirmed";
    } else if (r.status !== "confirmed") return err("That receipt was rejected or reversed. Record the payment by hand.", "rule_violation");
    else message = "Matched to the confirmed receipt";
    const m = await insertMatch(lineId, { receiptId: r.id }, amount, via, d.ctx.user.id);
    if (!m.ok) return m;
  } else if (c.kind === "bill" && c.id) {
    const [b] = await q<{ customer: string }>(sql`select customer_id as customer from bills where id = ${c.id}`);
    if (!b) return err("That bill is gone.", "not_found");
    const rec = await recordReceipt({
      customerId: b.customer,
      amount,
      receivedAt: line.date,
      mode: await receiptMode(line.description),
      reference: line.reference ?? undefined,
      instrumentDate: (await receiptMode(line.description)) === "Cheque" ? line.date : undefined,
      note: `From the ${line.account} statement: ${line.description}`,
      allocation: "settle",
      selectedBillIds: [c.id],
      source: "accounts",
      idempotencyKey: `bankline:${lineId}`,
    });
    if (!rec.ok) return rec;
    const m = await insertMatch(lineId, { receiptId: rec.data.receiptId }, amount, via, d.ctx.user.id);
    if (!m.ok) return m;
    message = "Payment recorded and confirmed against the bill";
  } else if (c.kind === "payout" && c.id) {
    const [p] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, c.id));
    if (!p) return err("That payout is gone.", "not_found");
    if (p.status === "cancelled") return err("That payout was cancelled.", "rule_violation");
    if (p.status !== "paid") {
      if (Number(p.amountPaise) !== amount) return err(`The payout is ${inr(Number(p.amountPaise))} and the bank line is ${inr(amount)}. Mark it by hand.`, "rule_violation");
      await db
        .update(vendorPayouts)
        .set({ status: "paid", holdReason: null, paidOn: line.date, paidAmountPaise: amount, paymentMode: guessMode(line.description), paymentReference: line.reference ?? null, paidById: d.ctx.user.id, updatedAt: new Date(), updatedById: d.ctx.user.id })
        .where(eq(vendorPayouts.id, p.id));
      await db.insert(auditLog).values({
        id: id("aud"),
        actorId: d.ctx.user.id,
        actorRole: d.ctx.authorisedBy,
        actorApp: d.ctx.authorisedIn,
        action: "payout.paid",
        entityType: "vendor_payout",
        entityId: p.id,
        beforeState: { status: p.status } as never,
        afterState: { payee: p.payeeName, amount, paidOn: line.date, mode: guessMode(line.description), reference: line.reference, fromBankLine: lineId } as never,
      });
      message = `${p.payeeName} marked paid`;
    } else message = `Matched to the payout to ${p.payeeName}`;
    const m = await insertMatch(lineId, { payoutId: p.id }, amount, via, d.ctx.user.id);
    if (!m.ok) return m;
  } else if (c.kind === "txn" && c.id) {
    const r = await M.matchBankLine(actor, lineId, [c.id]);
    if (!r.ok) return r;
    await db.execute(sql`update erp_bank_matches set via = ${via} where line_id = ${lineId} and voided_at is null`);
    await db.update(erpBankLines).set({ suggestion: null, flag: null, flagNote: null, flagReceiptId: null }).where(eq(erpBankLines.id, lineId));
    message = r.message ?? "Matched";
  } else if (c.kind === "transfer" && c.id) {
    const [other] = await db.select().from(erpMoneyAccounts).where(eq(erpMoneyAccounts.id, c.id));
    if (!other) return err("That account is gone.", "not_found");
    const made = await txnForLine(actor, line, { as: "transfer", counter: other.name, via });
    if (!made.ok) return made;
    message = `Transfer ${line.debitPaise ? "to" : "from"} ${other.name} entered`;
  } else if (c.kind === "charges") {
    const made = await txnForLine(actor, line, { as: "charges", via });
    if (!made.ok) return made;
    message = "Bank charges entered";
  } else if (c.kind === "interest") {
    const made = await txnForLine(actor, line, { as: "other_in", party: "Interest from the bank", description: "Interest", via });
    if (!made.ok) return made;
    message = "Interest entered";
  } else return err("Nothing to match.", "validation");

  await audit(d.ctx, "bank.match", lineId, { kind: c.kind, target: c.id, via, amount });
  /* Every account: a transfer explains a line on the other side too. */
  await refreshSuggestions();
  return ok({ message }, message);
}

/** Accepts every suggestion on these lines. A refusal on one leaves the rest. */
export async function acceptAll(lineIds: string[]): Promise<Result<{ done: number; failed: string[] }>> {
  const d = await desk("payment.confirm");
  if (d.refused) return d.refused;
  let done = 0;
  const failed: string[] = [];
  for (const lineId of lineIds.slice(0, 500)) {
    const [l] = await q<{ s: Candidate | null; flag: string | null }>(sql`select suggestion as s, flag from erp_bank_lines where id = ${lineId}`);
    if (!l?.s || l.flag) continue;
    const r = await acceptCandidate(lineId, l.s, "suggestion");
    if (r.ok) done++;
    else failed.push(r.error);
  }
  return ok({ done, failed }, `${done} line${done === 1 ? "" : "s"} matched${failed.length ? ` · ${failed.length} need a look` : ""}`);
}

/** "Not this": the candidate is not suggested for this line again. */
export async function dismissCandidate(lineId: string, c: Pick<Candidate, "kind" | "id">): Promise<Result> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  const [l] = await q<{ acc: string }>(sql`select account_id as acc from erp_bank_lines where id = ${lineId}`);
  if (!l) return err("That line is gone.", "not_found");
  await db.execute(sql`update erp_bank_lines set dismissed = (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements(dismissed || ${JSON.stringify([candKey(c)])}::jsonb) x), suggestion = null where id = ${lineId}`);
  await refreshSuggestions([l.acc]);
  return okVoid("Not suggested for this line again");
}

/* ------------------------------------------------------- marking by hand */

export type MarkInput = {
  as: MarkKind;
  /** customer_payment */
  customerId?: string | null;
  mode?: string | null;
  reference?: string | null;
  allocation?: "auto" | "settle" | "custom";
  order?: "oldest" | "newest";
  billIds?: string[];
  custom?: Record<string, number>;
  /** vendor_payment */
  payoutId?: string | null;
  /** transfer */
  counterAccountId?: string | null;
  /** expense and the rest */
  category?: string | null;
  party?: string | null;
  description?: string | null;
  note?: string | null;
};

/** Creates the Petty Cash transaction a line shows, and matches it. */
async function txnForLine(
  actor: M.Actor,
  line: LineView,
  x: { as: "transfer" | "charges" | "expense" | "salary" | "tax" | "other_out" | "other_in"; counter?: string; category?: string | null; party?: string | null; description?: string | null; note?: string | null; via?: "suggestion" | "hand" },
): Promise<Result<{ id: string; label: string }>> {
  const amount = amountOf(line);
  const note = x.note?.trim() || `From the ${line.account} statement: ${line.description}`;
  let saved: Result<{ id: string; label: string }>;
  if (x.as === "transfer") {
    if (!x.counter) return fieldErr("counterAccountId", "Choose the other account.");
    saved = await M.saveTransfer(actor, {
      date: line.date,
      from: line.debitPaise ? line.account : x.counter,
      to: line.debitPaise ? x.counter : line.account,
      amountPaise: amount,
      mode: payMode(line.description),
      reference: line.reference,
      source: null,
      note,
      files: [],
    });
  } else if (x.as === "other_in") {
    saved = await M.saveReceipt(actor, {
      date: line.date,
      into: line.account,
      amountPaise: amount,
      customer: null,
      payer: x.party?.trim() || line.description.slice(0, 80),
      mode: payMode(line.description),
      reference: line.reference,
      billsText: null,
      note: x.description?.trim() ? `${x.description.trim()} · ${note}` : note,
      files: [],
    });
  } else {
    const category = x.as === "expense" ? x.category : (MARK_CATEGORY[x.as] ?? "Other");
    if (!category) return fieldErr("category", "Choose the category.");
    saved = await M.saveExpense(actor, {
      petty: false,
      date: line.date,
      category,
      payee: x.party?.trim() || (x.as === "charges" ? line.account : null),
      invoiceNo: line.reference || `BANK-${line.date}-${line.id.slice(-4)}`,
      description: x.description?.trim() || line.description,
      amountPaise: amount,
      paidFrom: line.account,
      source: null,
      mode: payMode(line.description),
      reference: line.reference,
      note,
      files: [],
      duplicateOverride: true,
    });
  }
  if (!saved.ok) return saved;
  const m = await insertMatch(line.id, { txnId: saved.data.id }, amount, x.via ?? "hand", actor.id);
  if (!m.ok) return m;
  await db.update(erpBankLines).set({ markedAs: x.as }).where(eq(erpBankLines.id, line.id));
  return saved;
}

export async function markLine(lineId: string, x: MarkInput): Promise<Result<{ message: string }>> {
  const d = await desk("payment.confirm");
  if (d.refused) return d.refused;
  const o = await openLine(lineId);
  if (!o.ok) return o;
  const line = o.data;
  const amount = amountOf(line);
  const credit = line.creditPaise > 0;
  const actor = actorOf(d.ctx);
  const inKinds: MarkKind[] = ["customer_payment", "transfer", "other_in"];
  const outKinds: MarkKind[] = ["vendor_payment", "expense", "salary", "tax", "charges", "transfer", "other_out"];
  if (!(credit ? inKinds : outKinds).includes(x.as)) return fieldErr("as", credit ? "Choose what this money in is." : "Choose what this money out is.");
  let message: string;

  if (x.as === "customer_payment") {
    if (!x.customerId) return fieldErr("customerId", "Choose the customer.");
    const mode = x.mode?.trim() || (await receiptMode(line.description));
    const rec = await recordReceipt({
      customerId: x.customerId,
      amount,
      receivedAt: line.date,
      mode,
      reference: x.reference?.trim() || line.reference || undefined,
      instrumentDate: (await getConfig())["payments.datedModes"].includes(mode) ? line.date : undefined,
      note: x.note?.trim() || `From the ${line.account} statement: ${line.description}`,
      allocation: x.allocation ?? "auto",
      order: x.order ?? "oldest",
      selectedBillIds: x.billIds ?? [],
      custom: x.custom ?? {},
      source: "accounts",
      idempotencyKey: `bankline:${lineId}`,
    });
    if (!rec.ok) return rec;
    const m = await insertMatch(lineId, { receiptId: rec.data.receiptId }, amount, "hand", d.ctx.user.id);
    if (!m.ok) return m;
    await db.update(erpBankLines).set({ markedAs: "customer_payment" }).where(eq(erpBankLines.id, lineId));
    message = `Payment recorded and confirmed${rec.data.onAccount ? ` · ${inr(rec.data.onAccount)} on account` : ""}`;
  } else if (x.as === "vendor_payment") {
    if (!x.payoutId) return fieldErr("payoutId", "Choose the payout this pays.");
    const r = await acceptCandidate(lineId, { kind: "payout", id: x.payoutId }, "hand");
    if (!r.ok) return r;
    await db.update(erpBankLines).set({ markedAs: "vendor_payment" }).where(eq(erpBankLines.id, lineId));
    return r;
  } else if (x.as === "transfer") {
    const [other] = x.counterAccountId ? await db.select().from(erpMoneyAccounts).where(eq(erpMoneyAccounts.id, x.counterAccountId)) : [];
    if (!other) return fieldErr("counterAccountId", "Choose the other account.");
    if (other.id === line.accountId) return fieldErr("counterAccountId", "Choose a different account from this one.");
    const made = await txnForLine(actor, line, { as: "transfer", counter: other.name, note: x.note });
    if (!made.ok) return made;
    message = `${made.data.label} · transfer ${credit ? "from" : "to"} ${other.name}`;
  } else {
    const made = await txnForLine(actor, line, { as: x.as as "expense", category: x.category, party: x.party, description: x.description, note: x.note });
    if (!made.ok) return made;
    message = `${made.data.label} entered on Petty Cash and matched`;
  }
  await audit(d.ctx, "bank.mark", lineId, { as: x.as, amount });
  await refreshSuggestions();
  return ok({ message }, message);
}

export async function ignoreLine(lineId: string, reason: string): Promise<Result> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  if (!reason || reason.trim().length < 4) return fieldErr("reason", "Say why this line needs no record.");
  const o = await openLine(lineId);
  if (!o.ok) return o;
  await db.update(erpBankLines).set({ status: "ignored", ignoreReason: reason.trim() }).where(eq(erpBankLines.id, lineId));
  await audit(d.ctx, "bank.ignore", lineId, { reason: reason.trim() });
  return okVoid("Line set aside");
}

export async function restoreLine(lineId: string): Promise<Result> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  const [l] = await db.select().from(erpBankLines).where(eq(erpBankLines.id, lineId));
  if (!l) return err("That line is gone.", "not_found");
  await db.update(erpBankLines).set({ status: "open", ignoreReason: null }).where(eq(erpBankLines.id, lineId));
  await audit(d.ctx, "bank.restore", lineId, {});
  await refreshSuggestions([l.accountId]);
  return okVoid("Line open again");
}

/**
 * Undoes a match. The record it confirmed or created stays — a receipt
 * confirmed from this line is still money that arrived — and the toast says
 * where to reverse it if it was wrong.
 */
export async function undoMatch(lineId: string): Promise<Result> {
  const d = await desk("payment.confirm");
  if (d.refused) return d.refused;
  const n = (
    await db
      .update(erpBankMatches)
      .set({ voidedAt: new Date(), voidedById: d.ctx.user.id })
      .where(and(eq(erpBankMatches.lineId, lineId), sql`${erpBankMatches.voidedAt} is null`))
      .returning({ id: erpBankMatches.id, receipt: erpBankMatches.receiptId, payout: erpBankMatches.payoutId, txn: erpBankMatches.txnId })
  );
  if (!n.length) return err("Nothing is matched to this line.", "rule_violation");
  await db.update(erpBankLines).set({ markedAs: null }).where(eq(erpBankLines.id, lineId));
  await audit(d.ctx, "bank.unmatch", lineId, { matches: n.length });
  await refreshSuggestions();
  const what = n[0].receipt ? "The receipt stays confirmed — reverse it on Customer account if it was wrong." : n[0].payout ? "The payout stays marked paid — reopen it on Cash flow if it was wrong." : "The Petty Cash entry stays — cancel it there if it was wrong.";
  return okVoid(`Match undone. ${what}`);
}

/** Corrects a figure the reading got wrong, after import. Only an unmatched line. */
export async function editLine(lineId: string, x: { date: string; description: string; reference: string | null; debitPaise: number; creditPaise: number; balancePaise: number | null }): Promise<Result> {
  const d = await desk("payment.record");
  if (d.refused) return d.refused;
  const o = await openLine(lineId);
  if (!o.ok) return o;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date)) return fieldErr("date", "Enter the date.");
  if ((x.debitPaise > 0) === (x.creditPaise > 0)) return fieldErr("amount", "A line is money in or money out, not both.");
  if (!x.description.trim()) return fieldErr("description", "Keep the narration.");
  const before = o.data;
  await db
    .update(erpBankLines)
    .set({
      lineDate: x.date,
      description: x.description.trim(),
      reference: x.reference?.trim() || null,
      debitPaise: x.debitPaise,
      creditPaise: x.creditPaise,
      balancePaise: x.balancePaise,
      confidence: 100,
      balanceBreak: false,
      editedAt: new Date(),
      editedById: d.ctx.user.id,
    })
    .where(eq(erpBankLines.id, lineId));
  await audit(d.ctx, "bank.line.edit", lineId, x, { date: before.date, description: before.description, reference: before.reference, debit: before.debitPaise, credit: before.creditPaise, balance: before.balancePaise });
  await refreshSuggestions([before.accountId]);
  return okVoid("Line corrected");
}

/** A returned cheque: the receipt it paid is reversed, and the line is set aside as explained by that. */
export async function reverseForReturn(lineId: string, receiptId: string): Promise<Result> {
  const d = await desk("payment.confirm");
  if (d.refused) return d.refused;
  const o = await openLine(lineId);
  if (!o.ok) return o;
  const r = await reverseReceipt(receiptId, `Cheque returned — ${o.data.account} statement, ${o.data.date}: ${o.data.description}`.slice(0, 300));
  if (!r.ok) return r;
  await db.update(erpBankLines).set({ status: "ignored", ignoreReason: `Cheque returned · receipt reversed`, markedAs: "returned_cheque" }).where(eq(erpBankLines.id, lineId));
  await audit(d.ctx, "bank.return", lineId, { receiptId });
  await refreshSuggestions([o.data.accountId]);
  return okVoid("Receipt reversed · the customer owes it again");
}

/** Less arrived than was reported: the report is rejected and what the bank shows is recorded and confirmed. */
export async function confirmBankAmount(lineId: string, receiptId: string): Promise<Result> {
  const d = await desk("payment.confirm");
  if (d.refused) return d.refused;
  const o = await openLine(lineId);
  if (!o.ok) return o;
  const [r] = await db.select().from(paymentReceipts).where(eq(paymentReceipts.id, receiptId));
  if (!r || (r.status !== "reported" && r.status !== "held")) return err("That receipt is no longer waiting to be confirmed.", "conflict");
  const amount = amountOf(o.data);
  const rej = await rejectReceipt(receiptId, `The bank shows ${inr(amount)}, not ${inr(Number(r.amount))} — recorded again for what arrived.`);
  if (!rej.ok) return rej;
  const rec = await recordReceipt({
    customerId: r.customerId,
    amount,
    receivedAt: o.data.date,
    mode: r.mode,
    reference: r.reference ?? o.data.reference ?? undefined,
    instrumentDate: r.instrumentDate ?? undefined,
    note: `What the bank shows for ${receiptId}. ${o.data.description}`,
    allocation: "auto",
    order: "oldest",
    source: "accounts",
    idempotencyKey: `bankline:${lineId}`,
  });
  if (!rec.ok) return rec;
  const m = await insertMatch(lineId, { receiptId: rec.data.receiptId }, amount, "hand", d.ctx.user.id);
  if (!m.ok) return m;
  await audit(d.ctx, "bank.short", lineId, { was: receiptId, now: rec.data.receiptId, amount });
  await refreshSuggestions([o.data.accountId]);
  return okVoid(`${inr(amount)} confirmed · the rest is still owed`);
}

/* ---------------------------------------------------------- bank accounts */

export async function saveBankAccount(x: { id?: string | null; name: string; bankName: string | null; last4: string | null; accountType: string | null; active: boolean }): Promise<Result> {
  const d = await desk("payment.confirm");
  if (d.refused) return d.refused;
  const name = x.name?.trim();
  if (!name) return fieldErr("name", "Name the account, e.g. Kotak Bank.");
  const last4 = x.last4?.replace(/\D/g, "").slice(-4) || null;
  if (x.last4 && (!last4 || last4.length !== 4)) return fieldErr("last4", "The last four digits of the account number.");
  const [clash] = await db.select({ id: erpMoneyAccounts.id }).from(erpMoneyAccounts).where(eq(erpMoneyAccounts.name, name));
  if (clash && clash.id !== x.id) return fieldErr("name", "Another account already has that name.");
  if (x.id) {
    const [a] = await db.select().from(erpMoneyAccounts).where(eq(erpMoneyAccounts.id, x.id));
    if (!a || a.kind !== "bank") return err("That account is gone.", "not_found");
    await db.update(erpMoneyAccounts).set({ name, bankName: x.bankName?.trim() || null, last4, accountType: x.accountType?.trim() || null, active: x.active }).where(eq(erpMoneyAccounts.id, x.id));
  } else {
    const [{ n }] = await q<{ n: number }>(sql`select coalesce(max(sort), 0)::int + 1 as n from erp_money_accounts`);
    await db.insert(erpMoneyAccounts).values({ id: id("macc"), name, kind: "bank", bankName: x.bankName?.trim() || null, last4, accountType: x.accountType?.trim() || null, active: true, sort: n });
  }
  await audit(d.ctx, "bank.account.save", x.id ?? name, { name, bankName: x.bankName, last4, accountType: x.accountType, active: x.active });
  return okVoid(x.id ? "Account saved" : `${name} added`);
}

export async function allBankAccounts() {
  return q<{ id: string; name: string; bankName: string | null; last4: string | null; accountType: string | null; active: boolean }>(
    sql`select id, name, bank_name as "bankName", last4, account_type as "accountType", active from erp_money_accounts where kind = 'bank' order by sort, name`,
  );
}

/* ----------------------------------------------------- the mark dialog */

export type MarkKit = {
  customers: { id: string; name: string; city: string | null }[];
  guessCustomerId: string | null;
  payouts: { id: string; label: string; payee: string; amountPaise: number; payOn: string }[];
  accounts: { id: string; name: string; kind: string }[];
  categories: string[];
  modes: string[];
};

export async function markKit(lineId: string): Promise<MarkKit | null> {
  const [l] = await q<{ description: string; debit: number }>(sql`select description, debit_paise::float8 as debit from erp_bank_lines where id = ${lineId}`);
  if (!l) return null;
  const [customers, payouts, accounts, configured, cfg] = await Promise.all([
    q<{ id: string; name: string; city: string | null }>(sql`select id, name, city from customers where kind = 'customer' and status <> 'deactivated' order by name limit 6000`),
    q<{ id: string; label: string; payee: string; amount: number; payOn: string }>(sql`
      select p.id, coalesce('PR-' || p.pr_number, 'VP-' || upper(substr(p.id, 5, 4))) as label, p.payee_name as payee, p.amount_paise::float8 as amount, p.pay_on::text as "payOn"
        from vendor_payouts p where p.status in ('open', 'on_hold') order by p.pay_on, p.payee_name limit 500`),
    q<{ id: string; name: string; kind: string }>(sql`select id, name, kind from erp_money_accounts where active order by sort, name`),
    refValues("expenseCategory"),
    getConfig(),
  ]);
  const { partyKey } = await import("@/lib/engines/bank-statements");
  const hay = l.description.toLowerCase().replace(/[^a-z0-9]/g, "");
  const guess = customers
    .map((c) => ({ c, k: partyKey(c.name) }))
    .filter((x) => x.k.length >= 5 && hay.includes(x.k))
    .sort((a, b) => b.k.length - a.k.length)[0]?.c.id;
  return {
    customers,
    guessCustomerId: guess ?? null,
    payouts: payouts.map((p) => ({ id: p.id, label: p.label, payee: p.payee, amountPaise: Number(p.amount), payOn: p.payOn })),
    accounts,
    categories: configured.length ? [...new Set([...configured, "Salary", "GST / TDS", "Bank charges", "Other"])] : [...new Set([...DEFAULT_CATEGORIES, "Salary", "GST / TDS"])],
    modes: cfg["payments.modes"].filter((m: string) => m !== "Adjustment" && m !== "Credit note"),
  };
}

export async function customerBills(customerId: string) {
  return (
    await q<{ id: string; no: string; billDate: string; dueDate: string | null; balance: number }>(sql`
      select id, bill_no as no, bill_date::text as "billDate", due_date::text as "dueDate", (amount - paid_amount)::float8 as balance
        from bills where customer_id = ${customerId} and amount > paid_amount and not disputed order by bill_date, bill_no limit 60`)
  ).map((b) => ({ ...b, balance: Number(b.balance) }));
}

/* ---------------------------------------------------------------- history */

export type HistoryFilter = { account: string | null; period: "month" | "last" | "all"; by: string | null; q: string | null };

export async function historyView(f: HistoryFilter) {
  const day = await today();
  const parts: SQL[] = [sql`true`];
  if (f.account) parts.push(sql`u.account_id = ${f.account}`);
  if (f.by) parts.push(sql`u.uploaded_by_id = ${f.by}`);
  if (f.q?.trim()) parts.push(sql`u.file_name ilike ${"%" + f.q.trim() + "%"}`);
  if (f.period === "month") parts.push(sql`(u.uploaded_at at time zone 'Asia/Kolkata')::date >= date_trunc('month', ${day}::date)::date`);
  if (f.period === "last")
    parts.push(sql`(u.uploaded_at at time zone 'Asia/Kolkata')::date >= (date_trunc('month', ${day}::date) - interval '1 month')::date and (u.uploaded_at at time zone 'Asia/Kolkata')::date < date_trunc('month', ${day}::date)::date`);
  const where = sql.join(parts, sql` and `);
  const [rows, [sum], people] = await Promise.all([
    uploadRows(where, 500),
    q<{ n: number; brought: number; skipped: number; kept: number; bytes: number; pages: number }>(sql`
      select count(*)::int as n, coalesce(sum(u.lines_new) filter (where u.status = 'imported'), 0)::int as brought,
             coalesce(sum(u.lines_existing) filter (where u.status = 'imported'), 0)::int as skipped,
             (select count(*)::int from bank_statement_uploads x where x.file_ref is not null and x.pdf_deleted_at is null) as kept,
             (select coalesce(sum(x.file_size), 0)::float8 from bank_statement_uploads x where x.file_ref is not null and x.pdf_deleted_at is null) as bytes,
             coalesce(sum(u.pages), 0)::int as pages
        from bank_statement_uploads u where ${where}`),
    q<{ id: string; name: string }>(sql`select distinct us.id, us.name from bank_statement_uploads u join users us on us.id = u.uploaded_by_id order by us.name`),
  ]);
  return { rows, sum: { ...sum, bytes: Number(sum.bytes) }, people };
}

/* ------------------------------------------------------------------ util */

function inr(p: number): string {
  const r = (Math.abs(p) / 100).toFixed(2).replace(/\.00$/, "");
  const [i, f] = r.split(".");
  const head = i.slice(0, -3);
  const body = (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : "") + i.slice(-3);
  return `${p < 0 ? "−" : ""}₹${body}${f ? "." + f : ""}`;
}

/** Who is reading — for the screens that draw their buttons. */
export async function bankPowers() {
  const ctx = await resolveScope();
  const { canFor } = await import("@/lib/access-control");
  const [record, confirm] = await Promise.all([canFor(ctx.user, "payment.record"), canFor(ctx.user, "payment.confirm")]);
  return { record, confirm };
}
