import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, erpAdvances, erpBankLines, erpBankMatches, erpMoneyAccounts, erpMoneyTxns } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { bindErpFiles } from "./attachments";
import {
  advanceLabel,
  advancePosition,
  bankLineKey,
  cashUse,
  duplicateOf,
  FROM_CUSTOMER_CASH,
  FROM_WITHDRAWAL,
  matchCandidates,
  parseBankStatement,
  PAY_MODES,
  reviewFor,
  splitRefusal,
  txnLabel,
  type AdvancePosition,
  type MoneyKind,
  type Review,
} from "./engines/money";
import { erpId, nextNumber } from "./server";

/* ---------------------------------------------------------------------------
 * The Petty Cash module's reads and writes. The rules are the pure engine
 * (`engines/money.ts`); the screens are `screens/money.ts`. Every write here
 * is ONE transaction, numbered from the `moneyTxn` series inside it, and every
 * write lands in the audit log with its before and after.
 * ------------------------------------------------------------------------- */

export type Actor = { id: string; name: string; administrator: boolean; approver: boolean };

type Ex = { execute: (q: SQL) => Promise<unknown> };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function q<T>(ex: Ex, query: SQL): Promise<T[]> {
  return (await ex.execute(query)) as unknown as T[];
}

const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const today = () => calendarDate(new Date());

async function audit(actor: Actor, action: string, entityId: string | null, after?: unknown, before?: unknown) {
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: actor.id,
    action,
    entityType: "erp_money_txn",
    entityId,
    actorApp: "erp",
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

/** A refusal thrown from inside a transaction, so everything it wrote rolls back. */
class Refused extends Error {
  constructor(public r: Result<never>) {
    super("refused");
  }
}
const refuse = (r: Result<never>): never => {
  throw new Refused(r as Result<never>);
};

async function inTx<T>(fn: (tx: Tx) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (e instanceof Refused) return e.r as Result<T>;
    throw e;
  }
}

/* =================================================================== reads */

export type MoneyAccount = { id: string; name: string; kind: "bank" | "cash" | "petty"; last4: string | null; openingPaise: number; openingDate: string | null; active: boolean; sort: number };

export async function moneyAccounts(): Promise<MoneyAccount[]> {
  const rows = await db.select().from(erpMoneyAccounts).orderBy(asc(erpMoneyAccounts.sort), asc(erpMoneyAccounts.name));
  return rows.map((r) => ({ ...r, kind: r.kind as MoneyAccount["kind"] }));
}

/** Every account's balance, read from the transactions. */
export async function accountBalanceMap(ex: Ex = db, before?: string): Promise<Map<string, number>> {
  const accounts = await moneyAccounts();
  const cut = before ? sql`and t.txn_date < ${before}::date` : sql``;
  const rows = await q<{ a: string; v: number }>(ex, sql`
    select a, sum(v)::float8 as v from (
      select t.from_account_id as a, -t.amount_paise as v from erp_money_txns t where t.status = 'active' and t.from_account_id is not null ${cut}
      union all
      select t.to_account_id as a, t.amount_paise as v from erp_money_txns t where t.status = 'active' and t.to_account_id is not null ${cut}
    ) x group by a`);
  const out = new Map(accounts.map((a) => [a.id, a.openingPaise]));
  for (const r of rows) out.set(r.a, (out.get(r.a) ?? 0) + Number(r.v));
  return out;
}

export type TxnRow = {
  id: string;
  txnNo: number;
  label: string;
  date: string;
  kind: MoneyKind;
  amountPaise: number;
  fromAccountId: string | null;
  toAccountId: string | null;
  from: string | null;
  to: string | null;
  fromKind: string | null;
  toKind: string | null;
  mode: string | null;
  reference: string | null;
  category: string | null;
  payee: string | null;
  invoiceNo: string | null;
  description: string | null;
  petty: boolean;
  customerId: string | null;
  customer: string | null;
  payer: string | null;
  billsText: string | null;
  scrapReceiptId: string | null;
  sourceTxnId: string | null;
  sourceLabel: string | null;
  advanceId: string | null;
  advanceLabel: string | null;
  advanceEmployee: string | null;
  noBillReason: string | null;
  review: Review;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  duplicateOverride: boolean;
  status: "active" | "cancelled";
  cancelReason: string | null;
  note: string | null;
  createdAt: string;
  createdById: string | null;
  by: string | null;
  /** How much of it bank lines explain. */
  matchedPaise: number;
  /** How much was paid onward from it (a cash receipt or a withdrawal). */
  usedPaise: number;
};

/** Transactions, newest first, narrowed by a condition on `t`. */
export async function txnRows(where: SQL = sql`true`, ex: Ex = db): Promise<TxnRow[]> {
  const rows = await q<Record<string, unknown>>(ex, sql`
    select t.id, t.txn_no as "txnNo", t.txn_date::text as date, t.kind, t.amount_paise::float8 as amount,
           t.from_account_id as "fromAccountId", t.to_account_id as "toAccountId", fa.name as "from", ta.name as "to", fa.kind as "fromKind", ta.kind as "toKind",
           t.mode, t.reference, t.category, t.payee, t.invoice_no as "invoiceNo", t.description, t.petty, t.customer_id as "customerId",
           c.name as customer, t.payer, t.bills_text as "billsText", t.scrap_receipt_id as "scrapReceiptId",
           t.source_txn_id as "sourceTxnId", s.txn_no as "sourceNo", s.txn_date::text as "sourceDate",
           t.advance_id as "advanceId", a.advance_no as "advanceNo", a.issued_on::text as "advanceOn", a.employee_name as "advanceEmployee",
           t.no_bill_reason as "noBillReason", t.review, t.review_note as "reviewNote", rv.name as "reviewedBy", t.reviewed_at::text as "reviewedAt",
           t.duplicate_override as "duplicateOverride", t.status, t.cancel_reason as "cancelReason", t.note,
           t.created_at::text as "createdAt", t.created_by_id as "createdById", u.name as by,
           coalesce((select sum(m.amount_paise) from erp_bank_matches m where m.txn_id = t.id and m.voided_at is null), 0)::float8 as matched,
           coalesce((select sum(o.amount_paise) from erp_money_txns o where o.source_txn_id = t.id and o.status = 'active'), 0)::float8 as used
      from erp_money_txns t
      left join erp_money_accounts fa on fa.id = t.from_account_id
      left join erp_money_accounts ta on ta.id = t.to_account_id
      left join customers c on c.id = t.customer_id
      left join erp_money_txns s on s.id = t.source_txn_id
      left join erp_advances a on a.id = t.advance_id
      left join users u on u.id = t.created_by_id
      left join users rv on rv.id = t.reviewed_by_id
     where ${where}
     order by t.txn_date desc, t.txn_no desc`);
  return rows.map((r) => ({
    id: r.id as string,
    txnNo: Number(r.txnNo),
    label: txnLabel(Number(r.txnNo), r.date as string),
    date: r.date as string,
    kind: r.kind as MoneyKind,
    amountPaise: Number(r.amount),
    fromAccountId: (r.fromAccountId as string) ?? null,
    toAccountId: (r.toAccountId as string) ?? null,
    from: (r.from as string) ?? null,
    to: (r.to as string) ?? null,
    fromKind: (r.fromKind as string) ?? null,
    toKind: (r.toKind as string) ?? null,
    mode: (r.mode as string) ?? null,
    reference: (r.reference as string) ?? null,
    category: (r.category as string) ?? null,
    payee: (r.payee as string) ?? null,
    invoiceNo: (r.invoiceNo as string) ?? null,
    description: (r.description as string) ?? null,
    petty: !!r.petty,
    customerId: (r.customerId as string) ?? null,
    customer: (r.customer as string) ?? null,
    payer: (r.payer as string) ?? null,
    billsText: (r.billsText as string) ?? null,
    scrapReceiptId: (r.scrapReceiptId as string) ?? null,
    sourceTxnId: (r.sourceTxnId as string) ?? null,
    sourceLabel: r.sourceNo != null ? txnLabel(Number(r.sourceNo), r.sourceDate as string) : null,
    advanceId: (r.advanceId as string) ?? null,
    advanceLabel: r.advanceNo != null ? advanceLabel(Number(r.advanceNo), r.advanceOn as string) : null,
    advanceEmployee: (r.advanceEmployee as string) ?? null,
    noBillReason: (r.noBillReason as string) ?? null,
    review: r.review as Review,
    reviewNote: (r.reviewNote as string) ?? null,
    reviewedBy: (r.reviewedBy as string) ?? null,
    reviewedAt: (r.reviewedAt as string) ?? null,
    duplicateOverride: !!r.duplicateOverride,
    status: r.status as "active" | "cancelled",
    cancelReason: (r.cancelReason as string) ?? null,
    note: (r.note as string) ?? null,
    createdAt: r.createdAt as string,
    createdById: (r.createdById as string) ?? null,
    by: (r.by as string) ?? null,
    matchedPaise: Number(r.matched),
    usedPaise: Number(r.used),
  }));
}

/** Who paid, or who was paid — the one name a list shows for a row. */
export function partyOf(t: Pick<TxnRow, "kind" | "payee" | "customer" | "payer" | "advanceEmployee" | "from" | "to">): string {
  if (t.kind === "receipt") return t.customer ?? t.payer ?? "—";
  if (t.kind === "transfer") return `${t.from ?? "?"} → ${t.to ?? "?"}`;
  if (t.kind === "advance" || t.kind === "advance_return" || t.kind === "advance_topup") return t.advanceEmployee ?? "—";
  return t.payee ?? "—";
}

/** Where the money left from, as one line: an account, or an employee's advance. */
export function paidFromOf(t: Pick<TxnRow, "from" | "advanceEmployee" | "advanceId" | "sourceLabel" | "mode">): string {
  if (t.advanceId && !t.from) return `Advance · ${t.advanceEmployee ?? "—"}`;
  const via = t.sourceLabel ? ` (from ${t.sourceLabel})` : "";
  return `${t.from ?? "—"}${t.mode ? ` · ${t.mode}` : ""}${via}`;
}

/** A customer as the receipt form offers them: the name, and the city where two share it. */
export async function customerChoices(): Promise<{ id: string; label: string }[]> {
  const rows = await q<{ id: string; name: string; city: string | null }>(db, sql`select id, name, city from customers where kind = 'customer' order by name`);
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.name.toLowerCase(), (count.get(r.name.toLowerCase()) ?? 0) + 1);
  return rows.map((r) => ({ id: r.id, label: (count.get(r.name.toLowerCase()) ?? 0) > 1 && r.city ? `${r.name} — ${r.city}` : r.name }));
}

/**
 * Cash that may be paid onward from: a receipt into Cash in Hand from a
 * customer, or a withdrawal from a bank into it, with what is left of it.
 */
export async function cashSources(kind: "customer" | "withdrawal", ex: Ex = db): Promise<{ id: string; label: string; left: number }[]> {
  const where =
    kind === "customer"
      ? sql`t.kind = 'receipt' and t.status = 'active' and ta.kind = 'cash'`
      : sql`t.kind = 'transfer' and t.status = 'active' and ta.kind = 'cash' and fa.kind = 'bank'`;
  const rows = await txnRows(where, ex);
  return rows
    .map((r) => ({ id: r.id, left: cashUse(r, [{ amountPaise: r.usedPaise, status: "active" }]).left, r }))
    .filter((x) => x.left > 0)
    .map((x) => ({ id: x.id, left: x.left, label: `${x.r.label} · ${kind === "customer" ? partyOf(x.r) : x.r.from} · ${inr(x.left)} left` }));
}

/* ================================================================ writes */

async function accountByName(ex: Ex, name: string | null): Promise<MoneyAccount | null> {
  if (!name) return null;
  const all = await moneyAccounts();
  return all.find((a) => a.name === name && a.active) ?? null;
}

async function cashAccount(): Promise<MoneyAccount | null> {
  return (await moneyAccounts()).find((a) => a.kind === "cash" && a.active) ?? null;
}

/** Locks a source of cash and answers what is left of it. */
async function lockedLeft(tx: Tx, sourceId: string): Promise<{ left: number; label: string } | null> {
  await tx.execute(sql`select id from erp_money_txns where id = ${sourceId} for update`);
  const [s] = await txnRows(sql`t.id = ${sourceId}`, tx);
  if (!s || s.status !== "active") return null;
  return { left: s.amountPaise - s.usedPaise, label: s.label };
}

export type ExpenseInput = {
  id?: string;
  petty: boolean;
  date: string;
  category: string | null;
  payee: string | null;
  invoiceNo: string | null;
  description: string | null;
  amountPaise: number | null;
  /** An account's name, or one of the two cash-traced choices. */
  paidFrom: string | null;
  /** The receipt or withdrawal the cash came from, by its label. */
  source: string | null;
  mode: string | null;
  reference: string | null;
  note: string | null;
  files: string[];
  duplicateOverride: boolean;
};

/** Records an expense — always one already paid. On `id`, corrects it, keeping the before in the audit log. */
export async function saveExpense(actor: Actor, x: ExpenseInput): Promise<Result<{ id: string; label: string }>> {
  if (!x.date) return fieldErr("date", "When was it paid?");
  if (x.date > today()) return fieldErr("date", "A payment cannot be dated in the future.");
  if (!x.category) return fieldErr("category", "Choose the category.");
  if (!x.invoiceNo) return fieldErr("invoiceNo", "The invoice or bill number is required.");
  if (!x.description && !x.petty) return fieldErr("description", "Say what it was for.");
  if (!(x.amountPaise && x.amountPaise > 0)) return fieldErr("amount", "Enter the amount paid.");
  if (x.mode && !(PAY_MODES as readonly string[]).includes(x.mode)) return fieldErr("mode", "Choose how it was paid.");

  let fromId: string | null = null;
  let sourceKind: "customer" | "withdrawal" | null = null;
  if (x.paidFrom === FROM_CUSTOMER_CASH || x.paidFrom === FROM_WITHDRAWAL) {
    const cash = await cashAccount();
    if (!cash) return fieldErr("paidFrom", "There is no Cash in Hand account.");
    fromId = cash.id;
    sourceKind = x.paidFrom === FROM_CUSTOMER_CASH ? "customer" : "withdrawal";
    if (!x.source) return fieldErr("source", sourceKind === "customer" ? "Choose the customer's cash receipt it was paid from." : "Choose the withdrawal it was paid from.");
  } else {
    const acc = await accountByName(db, x.paidFrom);
    if (!acc) return fieldErr("paidFrom", "Choose the account it was paid from.");
    fromId = acc.id;
  }
  const mode = x.mode ?? (sourceKind ? "Cash" : null);
  if (!mode) return fieldErr("mode", "Choose how it was paid.");

  const cfg = await getConfig();
  const existing = await txnRows(sql`t.kind = 'expense' and t.status = 'active' and regexp_replace(lower(coalesce(t.invoice_no, '')), '[^a-z0-9]', '', 'g') = ${x.invoiceNo.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
  const dup = duplicateOf({ id: x.id, invoiceNo: x.invoiceNo, payee: x.payee, amountPaise: x.amountPaise }, existing);
  if (dup && !x.duplicateOverride) return fieldErr("invoiceNo", `Already on ${dup.label} (${dup.date}, ${inr(dup.amountPaise)}, ${dup.payee ?? "no payee"}). Open it — or tick "This is a different invoice" to save anyway.`);

  const r = await inTx<{ id: string; label: string; before: TxnRow | null }>(async (tx) => {
    let before: TxnRow | null = null;
    if (x.id) {
      await tx.execute(sql`select id from erp_money_txns where id = ${x.id} for update`);
      [before] = await txnRows(sql`t.id = ${x.id}`, tx);
      if (!before || before.kind !== "expense") return err("That expense no longer exists.", "not_found");
      if (before.status !== "active") return err("A cancelled expense cannot be changed.", "rule_violation");
      if (before.review === "approved" && !actor.approver) return err("An approved expense is closed. The accountant can correct it.", "not_permitted");
      if (before.createdById !== actor.id && !actor.approver) return err("Only the person who entered it, or the accountant, can correct it.", "not_permitted");
      if (before.matchedPaise > 0 && (before.amountPaise !== x.amountPaise || before.fromAccountId !== fromId)) return err("This expense is matched to a bank line. Undo the match before changing the amount or the account.", "rule_violation");
      if (before.advanceId) return err("A bill against an advance is corrected on the advance.", "rule_violation");
    }
    let sourceId: string | null = null;
    if (sourceKind) {
      const choices = await cashSources(sourceKind, tx);
      const keep = before?.sourceTxnId && before.sourceLabel && x.source?.startsWith(before.sourceLabel) ? before.sourceTxnId : null;
      sourceId = keep ?? choices.find((c) => c.label === x.source)?.id ?? null;
      if (!sourceId) return fieldErr("source", "That cash is not available any more — choose again.");
      const left = await lockedLeft(tx, sourceId);
      const mine = before?.sourceTxnId === sourceId ? before.amountPaise : 0;
      if (!left || left.left + mine < x.amountPaise!) return fieldErr("amount", `Only ${inr((left?.left ?? 0) + mine)} is left of ${left?.label ?? "that cash"}.`);
    }
    const values = {
      txnDate: x.date,
      kind: "expense",
      amountPaise: x.amountPaise!,
      fromAccountId: fromId,
      toAccountId: null,
      mode,
      reference: x.reference,
      category: x.category,
      payee: x.payee,
      invoiceNo: x.invoiceNo,
      description: x.description,
      petty: x.petty,
      sourceTxnId: sourceId,
      duplicateOverride: !!dup && x.duplicateOverride,
      note: x.note,
      updatedAt: new Date(),
    };
    let id = x.id ?? "";
    let no = before?.txnNo ?? 0;
    if (before) {
      /* A fixed send-back goes back to the accountant; an approved row stays approved (only the accountant can touch it); a correction that lifts an expense over the limit needs review. */
      const review: Review =
        before.review === "sent_back" ? "to_review" : before.review === "none" ? reviewFor({ petty: x.petty, advance: false, amountPaise: x.amountPaise! }, cfg["erp.money.approvalAbovePaise"]) : before.review;
      await tx.update(erpMoneyTxns).set({ ...values, review }).where(eq(erpMoneyTxns.id, before.id));
    } else {
      id = erpId("mtx");
      no = await nextNumber(tx, "moneyTxn");
      await tx.insert(erpMoneyTxns).values({ id, txnNo: no, ...values, review: reviewFor({ petty: x.petty, advance: false, amountPaise: x.amountPaise! }, cfg["erp.money.approvalAbovePaise"]), createdById: actor.id });
    }
    await bindErpFiles(tx as unknown as typeof db, x.files, "erp_money_txn", id, actor.id);
    return ok({ id, label: txnLabel(no, x.date), before });
  });
  if (!r.ok) return r;
  await audit(actor, x.id ? "erp.money.expense.edit" : "erp.money.expense.create", r.data.id, { ...x, files: x.files.length }, r.data.before);
  const bal = (await accountBalanceMap()).get(fromId!) ?? 0;
  const acc = (await moneyAccounts()).find((a) => a.id === fromId);
  return ok({ id: r.data.id, label: r.data.label }, `${r.data.label} ${x.id ? "corrected" : "saved"} · ${acc?.name ?? ""} now ${inr(bal)}${bal < 0 ? " — below zero" : ""}`);
}

export type ReceiptInput = { id?: string; date: string; into: string | null; amountPaise: number | null; customer: string | null; payer: string | null; mode: string | null; reference: string | null; billsText: string | null; note: string | null; files: string[] };

export async function saveReceipt(actor: Actor, x: ReceiptInput): Promise<Result<{ id: string; label: string }>> {
  if (!x.date) return fieldErr("date", "When did it arrive?");
  if (x.date > today()) return fieldErr("date", "A receipt cannot be dated in the future.");
  const acc = await accountByName(db, x.into);
  if (!acc) return fieldErr("into", "Choose the account it came into.");
  if (!(x.amountPaise && x.amountPaise > 0)) return fieldErr("amount", "Enter the amount received.");
  if (!x.mode || !(PAY_MODES as readonly string[]).includes(x.mode)) return fieldErr("mode", "Choose how it came.");
  if (acc.kind !== "bank" && x.mode !== "Cash") return fieldErr("mode", `${acc.name} only takes cash.`);
  let customerId: string | null = null;
  if (x.customer) {
    customerId = (await customerChoices()).find((c) => c.label === x.customer)?.id ?? null;
    if (!customerId) return fieldErr("customer", "Choose the customer from the list.");
  }
  if (!customerId && !x.payer) return fieldErr("customer", "Choose the customer, or name who paid.");
  const r = await inTx<{ id: string; label: string; before: TxnRow | null }>(async (tx) => {
    let before: TxnRow | null = null;
    if (x.id) {
      await tx.execute(sql`select id from erp_money_txns where id = ${x.id} for update`);
      [before] = await txnRows(sql`t.id = ${x.id}`, tx);
      if (!before || before.kind !== "receipt") return err("That receipt no longer exists.", "not_found");
      if (before.status !== "active") return err("A cancelled receipt cannot be changed.", "rule_violation");
      if (before.scrapReceiptId) return err("A scrap buyer's receipt is corrected on Scrap buyers.", "rule_violation");
      if (before.createdById !== actor.id && !actor.approver) return err("Only the person who entered it, or the accountant, can correct it.", "not_permitted");
      if (before.matchedPaise > 0 && (before.amountPaise !== x.amountPaise || before.toAccountId !== acc.id)) return err("This receipt is matched to a bank line. Undo the match first.", "rule_violation");
      if (before.usedPaise > x.amountPaise!) return err(`${inr(before.usedPaise)} of this cash has already been paid onward.`, "rule_violation");
    }
    const values = { txnDate: x.date, kind: "receipt", amountPaise: x.amountPaise!, fromAccountId: null, toAccountId: acc.id, mode: x.mode, reference: x.reference, customerId, payer: customerId ? null : x.payer, billsText: x.billsText, note: x.note, updatedAt: new Date() };
    let id = x.id ?? "";
    let no = before?.txnNo ?? 0;
    if (before) await tx.update(erpMoneyTxns).set(values).where(eq(erpMoneyTxns.id, before.id));
    else {
      id = erpId("mtx");
      no = await nextNumber(tx, "moneyTxn");
      await tx.insert(erpMoneyTxns).values({ id, txnNo: no, ...values, createdById: actor.id });
    }
    await bindErpFiles(tx as unknown as typeof db, x.files, "erp_money_txn", id, actor.id);
    return ok({ id, label: txnLabel(no, x.date), before });
  });
  if (!r.ok) return r;
  await audit(actor, x.id ? "erp.money.receipt.edit" : "erp.money.receipt.create", r.data.id, { ...x, files: x.files.length }, r.data.before);
  const bal = (await accountBalanceMap()).get(acc.id) ?? 0;
  return ok({ id: r.data.id, label: r.data.label }, `${r.data.label} ${x.id ? "corrected" : "recorded"} · ${acc.name} now ${inr(bal)}`);
}

export type TransferInput = { id?: string; date: string; from: string | null; to: string | null; amountPaise: number | null; mode: string | null; reference: string | null; source: string | null; note: string | null; files: string[] };

export async function saveTransfer(actor: Actor, x: TransferInput): Promise<Result<{ id: string; label: string }>> {
  if (!x.date) return fieldErr("date", "When did it move?");
  if (x.date > today()) return fieldErr("date", "A transfer cannot be dated in the future.");
  const from = await accountByName(db, x.from);
  const to = await accountByName(db, x.to);
  if (!from) return fieldErr("from", "Choose where it came from.");
  if (!to) return fieldErr("to", "Choose where it went.");
  if (from.id === to.id) return fieldErr("to", "A transfer moves money between two different accounts.");
  if (!(x.amountPaise && x.amountPaise > 0)) return fieldErr("amount", "Enter the amount.");
  if (!x.mode || !(PAY_MODES as readonly string[]).includes(x.mode)) return fieldErr("mode", "Choose how it moved.");
  const r = await inTx<{ id: string; label: string; before: TxnRow | null }>(async (tx) => {
    let before: TxnRow | null = null;
    if (x.id) {
      await tx.execute(sql`select id from erp_money_txns where id = ${x.id} for update`);
      [before] = await txnRows(sql`t.id = ${x.id}`, tx);
      if (!before || before.kind !== "transfer") return err("That transfer no longer exists.", "not_found");
      if (before.status !== "active") return err("A cancelled transfer cannot be changed.", "rule_violation");
      if (before.createdById !== actor.id && !actor.approver) return err("Only the person who entered it, or the accountant, can correct it.", "not_permitted");
      if (before.matchedPaise > 0 && (before.amountPaise !== x.amountPaise || before.fromAccountId !== from.id || before.toAccountId !== to.id)) return err("This transfer is matched to a bank line. Undo the match first.", "rule_violation");
      if (before.usedPaise > x.amountPaise!) return err(`${inr(before.usedPaise)} of this cash has already been paid onward.`, "rule_violation");
    }
    /* A deposit of a customer's cash may name the receipt it came from, so the receipt says where its cash went. */
    let sourceId: string | null = null;
    if (x.source && from.kind === "cash") {
      const choices = await cashSources("customer", tx);
      sourceId = (before?.sourceTxnId && before.sourceLabel && x.source.startsWith(before.sourceLabel) ? before.sourceTxnId : null) ?? choices.find((c) => c.label === x.source)?.id ?? null;
      if (!sourceId) return fieldErr("source", "That cash is not available any more — choose again.");
      const left = await lockedLeft(tx, sourceId);
      const mine = before?.sourceTxnId === sourceId ? before.amountPaise : 0;
      if (!left || left.left + mine < x.amountPaise!) return fieldErr("amount", `Only ${inr((left?.left ?? 0) + mine)} is left of ${left?.label ?? "that cash"}.`);
    }
    const values = { txnDate: x.date, kind: "transfer", amountPaise: x.amountPaise!, fromAccountId: from.id, toAccountId: to.id, mode: x.mode, reference: x.reference, sourceTxnId: sourceId, note: x.note, updatedAt: new Date() };
    let id = x.id ?? "";
    let no = before?.txnNo ?? 0;
    if (before) await tx.update(erpMoneyTxns).set(values).where(eq(erpMoneyTxns.id, before.id));
    else {
      id = erpId("mtx");
      no = await nextNumber(tx, "moneyTxn");
      await tx.insert(erpMoneyTxns).values({ id, txnNo: no, ...values, createdById: actor.id });
    }
    await bindErpFiles(tx as unknown as typeof db, x.files, "erp_money_txn", id, actor.id);
    return ok({ id, label: txnLabel(no, x.date), before });
  });
  if (!r.ok) return r;
  await audit(actor, x.id ? "erp.money.transfer.edit" : "erp.money.transfer.create", r.data.id, { ...x, files: x.files.length }, r.data.before);
  const bal = await accountBalanceMap();
  return ok({ id: r.data.id, label: r.data.label }, `${r.data.label} · ${from.name} ${inr(bal.get(from.id) ?? 0)} · ${to.name} ${inr(bal.get(to.id) ?? 0)}`);
}

/* ------------------------------------------------------------- review, cancel */

/** The accountant approves, or sends back with a note. Nobody decides what they entered themselves, unless an administrator. */
export async function reviewTxns(actor: Actor, ids: string[], decision: "approved" | "sent_back", note: string | null): Promise<Result> {
  if (!actor.approver) return err("Only the accountant reviews petty cash and expenses.", "not_permitted");
  if (decision === "sent_back" && !(note && note.trim().length >= 5)) return fieldErr("note", "Say what needs fixing.");
  const rows = await txnRows(sql`t.id in ${ids}`);
  const live = rows.filter((r) => r.status === "active" && (r.review === "to_review" || (decision === "approved" && r.review === "sent_back")));
  if (!live.length) return err("Nothing there is waiting for review.", "rule_violation");
  const own = live.filter((r) => r.createdById === actor.id && !actor.administrator);
  if (own.length === live.length) return err("Somebody else reviews what you entered.", "not_permitted");
  const go = live.filter((r) => !own.includes(r));
  await db.update(erpMoneyTxns).set({ review: decision, reviewNote: note?.trim() || null, reviewedById: actor.id, reviewedAt: new Date(), updatedAt: new Date() }).where(sql`${erpMoneyTxns.id} in ${go.map((r) => r.id)}`);
  for (const r of go) await audit(actor, decision === "approved" ? "erp.money.approve" : "erp.money.sendBack", r.id, { note }, { review: r.review });
  const skipped = own.length ? ` · ${own.length} of your own left for somebody else` : "";
  return okVoid(`${go.length} ${decision === "approved" ? "approved" : "sent back"}${skipped}`);
}

/** Cancels a transaction with a reason. It stays, marked cancelled, and its legs stop counting. */
export async function cancelTxn(actor: Actor, id: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why (10 characters or more).");
  const r = await inTx(async (tx) => {
    await tx.execute(sql`select id from erp_money_txns where id = ${id} for update`);
    const [t] = await txnRows(sql`t.id = ${id}`, tx);
    if (!t) return err("That transaction no longer exists.", "not_found");
    if (t.status !== "active") return err("Already cancelled.", "conflict");
    if (!actor.approver && (t.createdById !== actor.id || t.review === "approved")) return err("Only the accountant cancels this — or whoever entered it, before it is approved.", "not_permitted");
    if (t.scrapReceiptId) return err("A scrap buyer's receipt is voided on Scrap buyers.", "rule_violation");
    if (t.kind === "advance") return err("Cancel the advance itself, on Advances.", "rule_violation");
    if (t.kind === "advance_return" || t.kind === "advance_topup") return err("A settlement is undone by reopening the advance.", "rule_violation");
    if (t.matchedPaise > 0) return err("It is matched to a bank line. Undo the match first.", "rule_violation");
    if (t.usedPaise > 0) return err("Cash from it has been paid onward. Cancel those first.", "rule_violation");
    if (t.advanceId) {
      const [a] = await tx.select().from(erpAdvances).where(eq(erpAdvances.id, t.advanceId));
      if (a?.status === "settled") return err("The advance is settled. Reopen it first.", "rule_violation");
    }
    await tx.update(erpMoneyTxns).set({ status: "cancelled", cancelReason: reason.trim(), cancelledById: actor.id, cancelledAt: new Date(), updatedAt: new Date() }).where(eq(erpMoneyTxns.id, id));
    return okVoid(`${t.label} cancelled`);
  });
  if (r.ok) await audit(actor, "erp.money.cancel", id, { reason });
  return r;
}

/* ---------------------------------------------------------------- advances */

export type AdvanceRow = {
  id: string;
  no: number;
  label: string;
  employee: string;
  purpose: string | null;
  issuedOn: string;
  billsDueOn: string | null;
  status: "open" | "settled" | "cancelled";
  issueTxn: TxnRow | null;
  bills: TxnRow[];
  settlements: TxnRow[];
  position: AdvancePosition;
  by: string | null;
  createdAt: string;
};

export async function advanceRows(where: SQL = sql`true`): Promise<AdvanceRow[]> {
  const heads = await q<Record<string, unknown>>(db, sql`
    select a.id, a.advance_no as no, a.employee_name as employee, a.purpose, a.issued_on::text as "issuedOn", a.bills_due_on::text as "billsDueOn", a.status,
           u.name as by, a.created_at::text as "createdAt"
      from erp_advances a left join users u on u.id = a.created_by_id
     where ${where}
     order by a.issued_on desc, a.advance_no desc`);
  if (!heads.length) return [];
  const ids = heads.map((h) => h.id as string);
  const txns = await txnRows(sql`t.advance_id in ${ids}`);
  return heads.map((h) => {
    const mine = txns.filter((t) => t.advanceId === h.id);
    const issue = mine.find((t) => t.kind === "advance") ?? null;
    const bills = mine.filter((t) => t.kind === "expense");
    const settlements = mine.filter((t) => t.kind === "advance_return" || t.kind === "advance_topup");
    const status = h.status as AdvanceRow["status"];
    return {
      id: h.id as string,
      no: Number(h.no),
      label: advanceLabel(Number(h.no), h.issuedOn as string),
      employee: h.employee as string,
      purpose: (h.purpose as string) ?? null,
      issuedOn: h.issuedOn as string,
      billsDueOn: (h.billsDueOn as string) ?? null,
      status,
      issueTxn: issue,
      bills,
      settlements,
      position: advancePosition({
        given: issue && issue.status === "active" ? issue.amountPaise : 0,
        status,
        bills,
        returns: settlements.map((s) => ({ kind: s.kind as "advance_return" | "advance_topup", amountPaise: s.amountPaise, status: s.status })),
      }),
      by: (h.by as string) ?? null,
      createdAt: h.createdAt as string,
    };
  });
}

export type AdvanceInput = { employee: string | null; amountPaise: number | null; date: string; purpose: string | null; billsDueOn: string | null; from: string | null; mode: string | null; reference: string | null; note: string | null };

/** Gives an employee a lump sum: a transfer out of an account into their hands, not an expense. */
export async function giveAdvance(actor: Actor, x: AdvanceInput): Promise<Result<{ id: string; label: string }>> {
  if (!x.employee) return fieldErr("employee", "Who is it given to?");
  if (!(x.amountPaise && x.amountPaise > 0)) return fieldErr("amount", "Enter the amount given.");
  if (!x.date) return fieldErr("date", "When was it given?");
  if (x.date > today()) return fieldErr("date", "An advance cannot be dated in the future.");
  if (x.billsDueOn && x.billsDueOn < x.date) return fieldErr("billsDueOn", "Bills cannot be due before the advance is given.");
  const from = await accountByName(db, x.from);
  if (!from) return fieldErr("from", "Choose the account it was given from.");
  if (!x.mode || !(PAY_MODES as readonly string[]).includes(x.mode)) return fieldErr("mode", "Choose how it was handed over.");
  const r = await inTx<{ id: string; label: string }>(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"erp-advance|" + x.employee!.toLowerCase()}))`);
    const [open] = await q<{ no: number; on: string; who: string }>(tx, sql`select advance_no as no, issued_on::text as on, employee_name as who from erp_advances where lower(employee_name) = ${x.employee!.toLowerCase()} and status = 'open' limit 1`);
    if (open) return fieldErr("employee", `${open.who} still holds ${advanceLabel(Number(open.no), open.on)}. Settle it before giving another.`);
    const id = erpId("adv");
    const no = await nextNumber(tx, "advance");
    await tx.insert(erpAdvances).values({ id, advanceNo: no, employeeName: x.employee!, purpose: x.purpose, issuedOn: x.date, billsDueOn: x.billsDueOn, createdById: actor.id });
    const tno = await nextNumber(tx, "moneyTxn");
    await tx.insert(erpMoneyTxns).values({ id: erpId("mtx"), txnNo: tno, txnDate: x.date, kind: "advance", amountPaise: x.amountPaise!, fromAccountId: from.id, mode: x.mode, reference: x.reference, advanceId: id, description: x.purpose, note: x.note, createdById: actor.id });
    return ok({ id, label: advanceLabel(no, x.date) });
  });
  if (!r.ok) return r;
  await audit(actor, "erp.money.advance.give", r.data.id, x);
  const bal = (await accountBalanceMap()).get(from.id) ?? 0;
  return ok(r.data, `${r.data.label}: ${inr(x.amountPaise)} given to ${x.employee} · ${from.name} now ${inr(bal)}`);
}

export type BillInput = { date: string | null; category: string | null; payee: string | null; invoiceNo: string | null; amountPaise: number | null; noBillReason: string | null; description: string | null; photo: string | null };

/** The employee's bills against their advance: each one an expense drawn from the advance, waiting for the accountant. */
export async function submitAdvanceBills(actor: Actor, advanceId: string, bills: BillInput[]): Promise<Result<{ n: number; total: number }>> {
  const real = bills.filter((b) => b.amountPaise || b.payee || b.invoiceNo || b.category);
  if (!real.length) return err("Add at least one bill.");
  for (let i = 0; i < real.length; i++) {
    const b = real[i];
    const l = `l${bills.indexOf(b)}`;
    if (!b.date) return fieldErr(`${l}.date`, `Bill ${i + 1}: the date is missing.`);
    if (b.date > today()) return fieldErr(`${l}.date`, `Bill ${i + 1}: a bill cannot be dated in the future.`);
    if (!b.category) return fieldErr(`${l}.category`, `Bill ${i + 1}: choose the category.`);
    if (!(b.amountPaise && b.amountPaise > 0)) return fieldErr(`${l}.amount`, `Bill ${i + 1}: enter the amount.`);
    if (!b.invoiceNo && !(b.noBillReason && b.noBillReason.trim().length >= 5)) return fieldErr(`${l}.noBillReason`, `Bill ${i + 1}: no bill number — say why there is no bill.`);
    if (b.invoiceNo && !b.photo) return fieldErr(`${l}.photo`, `Bill ${i + 1}: add a photo of the bill.`);
  }
  const r = await inTx<{ n: number; total: number }>(async (tx) => {
    await tx.execute(sql`select id from erp_advances where id = ${advanceId} for update`);
    const [a] = await tx.select().from(erpAdvances).where(eq(erpAdvances.id, advanceId));
    if (!a) return err("That advance no longer exists.", "not_found");
    if (a.status !== "open") return err(`This advance is ${a.status}.`, "rule_violation");
    let total = 0;
    for (const b of real) {
      if (b.date! < a.issuedOn) return refuse(fieldErr(`l${bills.indexOf(b)}.date`, "A bill cannot be older than the advance it was paid from."));
      const id = erpId("mtx");
      const no = await nextNumber(tx, "moneyTxn");
      await tx.insert(erpMoneyTxns).values({
        id,
        txnNo: no,
        txnDate: b.date!,
        kind: "expense",
        amountPaise: b.amountPaise!,
        mode: "Cash",
        category: b.category,
        payee: b.payee,
        invoiceNo: b.invoiceNo,
        description: b.description,
        advanceId,
        noBillReason: b.invoiceNo ? null : b.noBillReason!.trim(),
        review: "to_review",
        createdById: actor.id,
      });
      await bindErpFiles(tx as unknown as typeof db, [b.photo], "erp_money_txn", id, actor.id);
      total += b.amountPaise!;
    }
    return ok({ n: real.length, total });
  });
  if (!r.ok) return r;
  await audit(actor, "erp.money.advance.bills", advanceId, { n: r.data.n, total: r.data.total });
  return ok(r.data, `${r.data.n} bill${r.data.n === 1 ? "" : "s"} · ${inr(r.data.total)} sent for review`);
}

/** Closes an advance: the unspent part comes back, or the overspend is paid out — one transaction either way. */
export async function settleAdvance(actor: Actor, advanceId: string, accountName: string | null, mode: string | null): Promise<Result> {
  if (!actor.approver) return err("Only the accountant settles an advance.", "not_permitted");
  const acc = await accountByName(db, accountName);
  if (!acc) return fieldErr("account", "Choose the account.");
  const r = await inTx(async (tx) => {
    await tx.execute(sql`select id from erp_advances where id = ${advanceId} for update`);
    const [a] = await advanceRows(sql`a.id = ${advanceId}`);
    if (!a) return err("That advance no longer exists.", "not_found");
    if (a.position.settleWhy) return err(a.position.settleWhy, "rule_violation");
    const amount = a.position.settleAmount;
    if (amount !== 0) {
      const no = await nextNumber(tx, "moneyTxn");
      await tx.insert(erpMoneyTxns).values({
        id: erpId("mtx"),
        txnNo: no,
        txnDate: today(),
        kind: amount > 0 ? "advance_return" : "advance_topup",
        amountPaise: Math.abs(amount),
        fromAccountId: amount > 0 ? null : acc.id,
        toAccountId: amount > 0 ? acc.id : null,
        mode: mode ?? "Cash",
        advanceId,
        description: amount > 0 ? `Unspent part of ${a.label} returned` : `Spent beyond ${a.label}, paid back to ${a.employee}`,
        createdById: actor.id,
      });
    }
    await tx.update(erpAdvances).set({ status: "settled", settledAt: new Date(), settledById: actor.id }).where(eq(erpAdvances.id, advanceId));
    return okVoid(amount > 0 ? `${a.label} settled · ${inr(amount)} returned to ${acc.name}` : amount < 0 ? `${a.label} settled · ${inr(-amount)} paid to ${a.employee} from ${acc.name}` : `${a.label} settled · nothing left over`);
  });
  if (r.ok) await audit(actor, "erp.money.advance.settle", advanceId, { account: acc.name });
  return r;
}

/** Undoes a settlement: its transaction is cancelled and the advance is open again. */
export async function reopenAdvance(actor: Actor, advanceId: string, reason: string): Promise<Result> {
  if (!actor.approver) return err("Only the accountant reopens an advance.", "not_permitted");
  if (reason.trim().length < 10) return fieldErr("reason", "Say why (10 characters or more).");
  const r = await inTx(async (tx) => {
    const [a] = await tx.select().from(erpAdvances).where(eq(erpAdvances.id, advanceId)).for("update");
    if (!a) return err("That advance no longer exists.", "not_found");
    if (a.status !== "settled") return err("Only a settled advance is reopened.", "rule_violation");
    const [m] = await q<{ n: number }>(tx, sql`select count(*)::int as n from erp_bank_matches m join erp_money_txns t on t.id = m.txn_id where t.advance_id = ${advanceId} and t.kind in ('advance_return', 'advance_topup') and t.status = 'active' and m.voided_at is null`);
    if (Number(m?.n) > 0) return err("The settlement is matched to a bank line. Undo the match first.", "rule_violation");
    await tx.update(erpMoneyTxns).set({ status: "cancelled", cancelReason: `Advance reopened: ${reason.trim()}`, cancelledById: actor.id, cancelledAt: new Date(), updatedAt: new Date() }).where(and(eq(erpMoneyTxns.advanceId, advanceId), sql`${erpMoneyTxns.kind} in ('advance_return', 'advance_topup')`, eq(erpMoneyTxns.status, "active")));
    await tx.update(erpAdvances).set({ status: "open", settledAt: null, settledById: null }).where(eq(erpAdvances.id, advanceId));
    return okVoid("Advance open again");
  });
  if (r.ok) await audit(actor, "erp.money.advance.reopen", advanceId, { reason });
  return r;
}

/** An advance given in error: its money goes back, as long as no bill has been put against it. */
export async function cancelAdvance(actor: Actor, advanceId: string, reason: string): Promise<Result> {
  if (reason.trim().length < 10) return fieldErr("reason", "Say why (10 characters or more).");
  const r = await inTx(async (tx) => {
    const [a] = await tx.select().from(erpAdvances).where(eq(erpAdvances.id, advanceId)).for("update");
    if (!a) return err("That advance no longer exists.", "not_found");
    if (a.status !== "open") return err(`This advance is ${a.status}.`, "rule_violation");
    if (!actor.approver && a.createdById !== actor.id) return err("Only the accountant, or whoever gave it, cancels an advance.", "not_permitted");
    const [b] = await q<{ n: number; m: number }>(tx, sql`select count(*) filter (where kind = 'expense' and status = 'active')::int as n,
        (select count(*) from erp_bank_matches m join erp_money_txns t on t.id = m.txn_id where t.advance_id = ${advanceId} and m.voided_at is null)::int as m
      from erp_money_txns where advance_id = ${advanceId}`);
    if (Number(b?.n) > 0) return err("Bills have been put against it. Cancel them, or settle the advance.", "rule_violation");
    if (Number(b?.m) > 0) return err("It is matched to a bank line. Undo the match first.", "rule_violation");
    await tx.update(erpMoneyTxns).set({ status: "cancelled", cancelReason: `Advance cancelled: ${reason.trim()}`, cancelledById: actor.id, cancelledAt: new Date(), updatedAt: new Date() }).where(and(eq(erpMoneyTxns.advanceId, advanceId), eq(erpMoneyTxns.status, "active")));
    await tx.update(erpAdvances).set({ status: "cancelled" }).where(eq(erpAdvances.id, advanceId));
    return okVoid("Advance cancelled · the money is back in its account");
  });
  if (r.ok) await audit(actor, "erp.money.advance.cancel", advanceId, { reason });
  return r;
}

/* ------------------------------------------------------------ bank statements */

export type BankLineRow = {
  id: string;
  accountId: string;
  account: string;
  date: string;
  description: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  status: "open" | "ignored";
  ignoreReason: string | null;
  matchedPaise: number;
  matches: { id: string; txnId: string; label: string; amountPaise: number; party: string }[];
  importBatch: string;
  createdAt: string;
};

export async function bankLineRows(where: SQL = sql`true`): Promise<BankLineRow[]> {
  const rows = await q<Record<string, unknown>>(db, sql`
    select l.id, l.account_id as "accountId", a.name as account, l.line_date::text as date, l.description, l.reference,
           l.debit_paise::float8 as debit, l.credit_paise::float8 as credit, l.balance_paise::float8 as balance, l.status, l.ignore_reason as "ignoreReason",
           l.import_batch as "importBatch", l.created_at::text as "createdAt",
           coalesce(json_agg(json_build_object('id', m.id, 'txnId', t.id, 'no', t.txn_no, 'date', t.txn_date::text, 'amount', m.amount_paise, 'party', coalesce(t.payee, c.name, t.payer, t.description, ''))) filter (where m.id is not null), '[]') as matches
      from erp_bank_lines l
      join erp_money_accounts a on a.id = l.account_id
      left join erp_bank_matches m on m.line_id = l.id and m.voided_at is null
      left join erp_money_txns t on t.id = m.txn_id
      left join customers c on c.id = t.customer_id
     where ${where}
     group by l.id, a.name
     order by l.line_date desc, l.created_at desc`);
  return rows.map((r) => {
    const matches = (r.matches as { id: string; txnId: string; no: number; date: string; amount: number; party: string }[]).map((m) => ({ id: m.id, txnId: m.txnId, label: txnLabel(Number(m.no), m.date), amountPaise: Number(m.amount), party: m.party }));
    return {
      id: r.id as string,
      accountId: r.accountId as string,
      account: r.account as string,
      date: r.date as string,
      description: r.description as string,
      reference: (r.reference as string) ?? null,
      debitPaise: Number(r.debit),
      creditPaise: Number(r.credit),
      balancePaise: r.balance == null ? null : Number(r.balance),
      status: r.status as "open" | "ignored",
      ignoreReason: (r.ignoreReason as string) ?? null,
      matchedPaise: matches.reduce((s, m) => s + m.amountPaise, 0),
      matches,
      importBatch: r.importBatch as string,
      createdAt: r.createdAt as string,
    };
  });
}

/** The candidates for each line, read once for a page of lines. */
export async function candidatesFor(lines: BankLineRow[], windowDays: number) {
  if (!lines.length) return new Map<string, ReturnType<typeof matchCandidates<TxnRow>>>();
  const accounts = [...new Set(lines.map((l) => l.accountId))];
  const txns = await txnRows(sql`t.status = 'active' and (t.from_account_id in ${accounts} or t.to_account_id in ${accounts})`);
  const matched = new Map(txns.map((t) => [t.id, t.matchedPaise]));
  return new Map(lines.map((l) => [l.id, matchCandidates({ ...l }, txns, (id) => matched.get(id) ?? 0, windowDays)]));
}

/** Imports a bank's statement; a line already imported is skipped. Lines with one exact match are matched as they land. */
export async function importBankStatement(actor: Actor, accountName: string | null, text: string | null): Promise<Result<{ added: number; repeated: number; skipped: number; matched: number }>> {
  if (!actor.approver) return err("Only the accountant imports bank statements.", "not_permitted");
  const acc = await accountByName(db, accountName);
  if (!acc || acc.kind !== "bank") return fieldErr("account", "Choose the bank the statement is from.");
  if (!text?.trim()) return fieldErr("file", "Choose the statement file (CSV), or paste it.");
  const parsed = parseBankStatement(text);
  if (parsed.problem) return fieldErr("file", parsed.problem);
  const batch = erpId("bimp");
  let added = 0;
  const ids: string[] = [];
  for (const l of parsed.lines) {
    const id = erpId("bl");
    const res = (await db
      .insert(erpBankLines)
      .values({ id, accountId: acc.id, lineDate: l.date, description: l.description, reference: l.reference, debitPaise: l.debitPaise, creditPaise: l.creditPaise, balancePaise: l.balancePaise, lineKey: bankLineKey(l), importBatch: batch, createdById: actor.id })
      .onConflictDoNothing()
      .returning({ id: erpBankLines.id })) as { id: string }[];
    if (res.length) {
      added++;
      ids.push(id);
    }
  }
  let matched = 0;
  if (ids.length) {
    const cfg = await getConfig();
    const lines = await bankLineRows(sql`l.id in ${ids}`);
    const cands = await candidatesFor(lines, cfg["erp.money.bankMatchDays"]);
    const taken = new Set<string>();
    for (const l of lines) {
      const exact = (cands.get(l.id) ?? []).filter((c) => c.score === "exact" && !taken.has(c.t.id));
      if (exact.length !== 1) continue;
      const r = await matchBankLine(actor, l.id, [exact[0].t.id]);
      if (r.ok) {
        matched++;
        taken.add(exact[0].t.id);
      }
    }
  }
  await audit(actor, "erp.money.bank.import", batch, { account: acc.name, added, repeated: parsed.lines.length - added, skipped: parsed.skipped, matched });
  return ok({ added, repeated: parsed.lines.length - added, skipped: parsed.skipped, matched }, `${added} line${added === 1 ? "" : "s"} added to ${acc.name}${parsed.lines.length - added ? ` · ${parsed.lines.length - added} already here` : ""}${matched ? ` · ${matched} matched by reference` : ""}`);
}

/**
 * Explains a bank line with one or more transactions. Each takes what it has
 * left, in the order given, until the line is covered; the parts must add up
 * to the line exactly.
 */
export async function matchBankLine(actor: Actor, lineId: string, txnIds: string[]): Promise<Result> {
  if (!actor.approver) return err("Only the accountant matches bank lines.", "not_permitted");
  const r = await inTx(async (tx) => {
    await tx.execute(sql`select id from erp_bank_lines where id = ${lineId} for update`);
    for (const id of [...txnIds].sort()) await tx.execute(sql`select id from erp_money_txns where id = ${id} for update`);
    const [line] = await bankLineRows(sql`l.id = ${lineId}`);
    if (!line) return err("That line is gone.", "not_found");
    if (line.status === "ignored") return err("This line is set aside. Bring it back first.", "rule_violation");
    if (line.matchedPaise > 0) return err("This line is already matched. Undo it to match again.", "conflict");
    const amount = line.debitPaise || line.creditPaise;
    const txns = await txnRows(sql`t.id in ${txnIds}`, tx);
    const parts: { id: string; amountPaise: number; left: number; label: string }[] = [];
    let rest = amount;
    for (const id of txnIds) {
      const t = txns.find((x) => x.id === id);
      if (!t || t.status !== "active") return err("A transaction chosen is cancelled or gone.", "conflict");
      const ok_ = line.debitPaise > 0 ? t.fromAccountId === line.accountId : t.toAccountId === line.accountId;
      if (!ok_) return err(`${t.label} does not ${line.debitPaise > 0 ? "take money out of" : "put money into"} ${line.account}.`, "rule_violation");
      const left = t.amountPaise - t.matchedPaise;
      const take = Math.min(left, rest);
      parts.push({ id, amountPaise: take, left, label: t.label });
      rest -= take;
    }
    const why = splitRefusal(amount, parts);
    if (why) return err(why, "rule_violation");
    for (const p of parts) await tx.insert(erpBankMatches).values({ id: erpId("bm"), lineId, txnId: p.id, amountPaise: p.amountPaise, byId: actor.id });
    return okVoid(`Matched to ${parts.map((p) => p.label).join(", ")}`);
  });
  if (r.ok) await audit(actor, "erp.money.bank.match", lineId, { txnIds });
  return r;
}

export async function unmatchBankLine(actor: Actor, lineId: string): Promise<Result> {
  if (!actor.approver) return err("Only the accountant matches bank lines.", "not_permitted");
  const n = (await db.update(erpBankMatches).set({ voidedAt: new Date(), voidedById: actor.id }).where(and(eq(erpBankMatches.lineId, lineId), sql`${erpBankMatches.voidedAt} is null`)).returning({ id: erpBankMatches.id })).length;
  if (!n) return err("Nothing is matched to this line.", "rule_violation");
  await audit(actor, "erp.money.bank.unmatch", lineId);
  return okVoid("Match undone · the line is open again");
}

export async function ignoreBankLine(actor: Actor, lineId: string, reason: string | null, back = false): Promise<Result> {
  if (!actor.approver) return err("Only the accountant works the bank statement.", "not_permitted");
  if (!back && !(reason && reason.trim().length >= 5)) return fieldErr("reason", "Say why this line needs no transaction.");
  const [l] = await bankLineRows(sql`l.id = ${lineId}`);
  if (!l) return err("That line is gone.", "not_found");
  if (!back && l.matchedPaise > 0) return err("A matched line is not set aside. Undo the match first.", "rule_violation");
  await db.update(erpBankLines).set({ status: back ? "open" : "ignored", ignoreReason: back ? null : reason!.trim() }).where(eq(erpBankLines.id, lineId));
  await audit(actor, back ? "erp.money.bank.restore" : "erp.money.bank.ignore", lineId, { reason });
  return okVoid(back ? "Line open again" : "Line set aside");
}

/**
 * Creates the transaction a bank line shows and matches it, in one step — only
 * where nothing already on the books explains the line, so a payment is never
 * entered a second time from its own statement.
 */
export async function createFromBankLine(actor: Actor, lineId: string, v: { category: string | null; party: string | null; description: string | null; counter: string | null }): Promise<Result> {
  if (!actor.approver) return err("Only the accountant creates a transaction from a bank line.", "not_permitted");
  const [l] = await bankLineRows(sql`l.id = ${lineId}`);
  if (!l) return err("That line is gone.", "not_found");
  if (l.matchedPaise > 0 || l.status !== "open") return err("This line is already explained.", "conflict");
  const cfg = await getConfig();
  const cands = (await candidatesFor([l], cfg["erp.money.bankMatchDays"])).get(l.id) ?? [];
  if (cands.some((c) => c.score !== "near")) return err(`${cands[0].t.label} may already be this line — match it instead.`, "rule_violation");
  const counter = v.counter ? await accountByName(db, v.counter) : null;
  const amountPaise = l.debitPaise || l.creditPaise;
  let saved: Result<{ id: string; label: string }>;
  if (counter) {
    saved = await saveTransfer(actor, {
      date: l.date,
      from: l.debitPaise > 0 ? l.account : counter.name,
      to: l.debitPaise > 0 ? counter.name : l.account,
      amountPaise,
      mode: counter.kind === "bank" ? "NEFT" : "Cash",
      reference: l.reference,
      source: null,
      note: `From the ${l.account} statement: ${l.description}`,
      files: [],
    });
  } else if (l.debitPaise > 0) {
    if (!v.category) return fieldErr("category", "Choose the category.");
    saved = await saveExpense(actor, {
      petty: false,
      date: l.date,
      category: v.category,
      payee: v.party,
      invoiceNo: l.reference || `BANK-${l.date}`,
      description: v.description || l.description,
      amountPaise,
      paidFrom: l.account,
      source: null,
      mode: "NEFT",
      reference: l.reference,
      note: `From the ${l.account} statement: ${l.description}`,
      files: [],
      duplicateOverride: true,
    });
  } else {
    saved = await saveReceipt(actor, { date: l.date, into: l.account, amountPaise, customer: null, payer: v.party || l.description, mode: "NEFT", reference: l.reference, billsText: null, note: `From the ${l.account} statement: ${l.description}`, files: [] });
  }
  if (!saved.ok) return saved;
  const m = await matchBankLine(actor, lineId, [saved.data.id]);
  return m.ok ? okVoid(`${saved.data.label} created and matched`) : m;
}

/* ---------------------------------------------------------------- accounts */

export async function saveAccount(actor: Actor, x: { id?: string; name: string | null; kind: string | null; last4: string | null; openingPaise: number | null; openingDate: string | null; active: boolean }): Promise<Result> {
  if (!actor.approver) return err("Only the accountant sets up accounts.", "not_permitted");
  if (!x.name) return fieldErr("name", "Name the account.");
  if (!x.id && !x.kind) return fieldErr("kind", "Choose what kind of account it is.");
  if (x.last4 && !/^\d{4}$/.test(x.last4)) return fieldErr("last4", "The last four digits, as on the passbook.");
  const all = await moneyAccounts();
  if (all.some((a) => a.name.toLowerCase() === x.name!.toLowerCase() && a.id !== x.id)) return fieldErr("name", "Another account already has that name.");
  const before = x.id ? all.find((a) => a.id === x.id) : null;
  if (x.id && !before) return err("That account is gone.", "not_found");
  const kindMap: Record<string, string> = { Bank: "bank", "Cash in hand": "cash", "Petty cash": "petty" };
  if (before) {
    await db.update(erpMoneyAccounts).set({ name: x.name, last4: x.last4, openingPaise: x.openingPaise ?? 0, openingDate: x.openingDate, active: x.active }).where(eq(erpMoneyAccounts.id, before.id));
  } else {
    await db.insert(erpMoneyAccounts).values({ id: erpId("macc"), name: x.name, kind: kindMap[x.kind!] ?? x.kind!, last4: x.last4, openingPaise: x.openingPaise ?? 0, openingDate: x.openingDate, active: true, sort: all.length + 1 });
  }
  await audit(actor, before ? "erp.money.account.edit" : "erp.money.account.create", before?.id ?? null, x, before);
  return okVoid(before ? `${x.name} saved` : `${x.name} added`);
}

/* ------------------------------------------------------------- scrap receipts */

/**
 * The money side of a scrap buyer's receipt, written in the receipt's own
 * transaction: one arrival of money, one row here, so the balances include it.
 */
export async function recordScrapMoney(tx: Ex & { insert: Tx["insert"] }, x: { scrapReceiptId: string; date: string; mode: string; amountPaise: number; accountName: string | null; payer: string; reference: string | null; note: string | null; createdById: string }): Promise<Result<null>> {
  const acc = (await moneyAccounts()).find((a) => a.name === x.accountName && a.active) ?? null;
  if (!acc) return fieldErr("into", "Choose the account it came into.");
  if (acc.kind !== "bank" && x.mode !== "Cash") return fieldErr("into", `${acc.name} only takes cash.`);
  const no = await nextNumber(tx, "moneyTxn");
  await tx.insert(erpMoneyTxns).values({ id: erpId("mtx"), txnNo: no, txnDate: x.date, kind: "receipt", amountPaise: x.amountPaise, toAccountId: acc.id, mode: x.mode === "Bank transfer" ? "NEFT" : x.mode, reference: x.reference, payer: x.payer, scrapReceiptId: x.scrapReceiptId, note: x.note, createdById: x.createdById });
  return ok(null);
}

export async function cancelScrapMoney(tx: Tx, scrapReceiptId: string, reason: string, byId: string): Promise<Result<null>> {
  const [t] = await txnRows(sql`t.scrap_receipt_id = ${scrapReceiptId}`, tx);
  if (!t) return ok(null);
  if (t.matchedPaise > 0) return err("Its money is matched to a bank line. Undo that match on Petty Cash → Bank statement first.", "rule_violation");
  if (t.usedPaise > 0) return err("Cash from it has been paid onward. Cancel those first.", "rule_violation");
  await tx.update(erpMoneyTxns).set({ status: "cancelled", cancelReason: `Scrap receipt voided: ${reason}`, cancelledById: byId, cancelledAt: new Date(), updatedAt: new Date() }).where(eq(erpMoneyTxns.id, t.id));
  return ok(null);
}

/* ---------------------------------------------------------------- overview */

export type MoneyOverview = {
  accounts: (MoneyAccount & { balance: number; unmatched: number })[];
  review: { n: number; paise: number };
  sentBack: { n: number; paise: number };
  pettyReview: { n: number; paise: number };
  advancesOpen: { n: number; withThem: number; late: number };
  unmatchedLines: { n: number; paise: number };
  receiptsNotInBank: { n: number; paise: number };
  duplicates: { n: number; paise: number };
  byCustomer: { name: string; cash: number; bank: number }[];
  byCategory: { name: string; paise: number }[];
  month: { from: string; to: string };
};

export async function moneyOverview(day: string): Promise<MoneyOverview> {
  const from = `${day.slice(0, 7)}-01`;
  const [accounts, bal] = await Promise.all([moneyAccounts(), accountBalanceMap()]);
  const [counts] = await q<Record<string, number>>(db, sql`
    select
      count(*) filter (where t.review = 'to_review' and not t.petty and t.advance_id is null)::int as rn,
      coalesce(sum(t.amount_paise) filter (where t.review = 'to_review' and not t.petty and t.advance_id is null), 0)::float8 as rp,
      count(*) filter (where t.review = 'to_review' and (t.petty or t.advance_id is not null))::int as pn,
      coalesce(sum(t.amount_paise) filter (where t.review = 'to_review' and (t.petty or t.advance_id is not null)), 0)::float8 as pp,
      count(*) filter (where t.review = 'sent_back')::int as sn,
      coalesce(sum(t.amount_paise) filter (where t.review = 'sent_back'), 0)::float8 as sp,
      count(*) filter (where t.kind = 'receipt' and ta.kind = 'bank' and t.amount_paise > coalesce((select sum(m.amount_paise) from erp_bank_matches m where m.txn_id = t.id and m.voided_at is null), 0))::int as un,
      coalesce(sum(t.amount_paise) filter (where t.kind = 'receipt' and ta.kind = 'bank' and t.amount_paise > coalesce((select sum(m.amount_paise) from erp_bank_matches m where m.txn_id = t.id and m.voided_at is null), 0)), 0)::float8 as up,
      count(*) filter (where t.kind = 'expense' and t.duplicate_override)::int as dn,
      coalesce(sum(t.amount_paise) filter (where t.kind = 'expense' and t.duplicate_override), 0)::float8 as dp
    from erp_money_txns t left join erp_money_accounts ta on ta.id = t.to_account_id
    where t.status = 'active'`);
  const unmatchedByAccount = await q<{ a: string; n: number; p: number }>(db, sql`
    select l.account_id as a, count(*)::int as n, sum(l.debit_paise + l.credit_paise)::float8 as p
      from erp_bank_lines l
     where l.status = 'open' and not exists (select 1 from erp_bank_matches m where m.line_id = l.id and m.voided_at is null)
     group by l.account_id`);
  const advances = await advanceRows(sql`a.status = 'open'`);
  const byCustomer = await q<{ name: string; cash: number; bank: number }>(db, sql`
    select coalesce(c.name, t.payer, '—') as name,
           coalesce(sum(t.amount_paise) filter (where ta.kind <> 'bank'), 0)::float8 as cash,
           coalesce(sum(t.amount_paise) filter (where ta.kind = 'bank'), 0)::float8 as bank
      from erp_money_txns t join erp_money_accounts ta on ta.id = t.to_account_id left join customers c on c.id = t.customer_id
     where t.kind = 'receipt' and t.status = 'active' and t.txn_date >= ${from}::date and t.txn_date <= ${day}::date
     group by 1 order by sum(t.amount_paise) desc limit 8`);
  const byCategory = await q<{ name: string; paise: number }>(db, sql`
    select coalesce(t.category, 'Uncategorised') as name, sum(t.amount_paise)::float8 as paise
      from erp_money_txns t
     where t.kind = 'expense' and t.status = 'active' and (t.petty or t.advance_id is not null) and t.txn_date >= ${from}::date and t.txn_date <= ${day}::date
     group by 1 order by 2 desc limit 8`);
  const unAcc = new Map(unmatchedByAccount.map((u) => [u.a, Number(u.n)]));
  return {
    accounts: accounts.filter((a) => a.active).map((a) => ({ ...a, balance: bal.get(a.id) ?? 0, unmatched: unAcc.get(a.id) ?? 0 })),
    review: { n: Number(counts?.rn ?? 0), paise: Number(counts?.rp ?? 0) },
    pettyReview: { n: Number(counts?.pn ?? 0), paise: Number(counts?.pp ?? 0) },
    sentBack: { n: Number(counts?.sn ?? 0), paise: Number(counts?.sp ?? 0) },
    advancesOpen: { n: advances.length, withThem: advances.reduce((s, a) => s + a.position.withThem, 0), late: advances.filter((a) => a.billsDueOn && a.billsDueOn < day && a.bills.length === 0).length },
    unmatchedLines: { n: unmatchedByAccount.reduce((s, u) => s + Number(u.n), 0), paise: unmatchedByAccount.reduce((s, u) => s + Number(u.p), 0) },
    receiptsNotInBank: { n: Number(counts?.un ?? 0), paise: Number(counts?.up ?? 0) },
    duplicates: { n: Number(counts?.dn ?? 0), paise: Number(counts?.dp ?? 0) },
    byCustomer: byCustomer.map((r) => ({ name: r.name, cash: Number(r.cash), bank: Number(r.bank) })),
    byCategory: byCategory.map((r) => ({ name: r.name, paise: Number(r.paise) })),
    month: { from, to: day },
  };
}
