"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { ErpNotPermitted, requireErpWrite, erpContext, type ErpContext } from "@/lib/erp/access";
import * as M from "@/lib/erp/money";
import { duplicateOf, invoiceKey } from "@/lib/erp/engines/money";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * Petty Cash's own dialogs write through these — the same services the ERP's
 * generic forms reach (`lib/erp/money.ts`), so a rule is checked once.
 * Every one re-checks the Petty Cash screen (`expenses`), because a server
 * action is a URL and a hidden button is not a permission.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

const actorOf = (ctx: ErpContext): M.Actor => ({ id: ctx.actor.id, name: ctx.actor.name, administrator: ctx.administrator, approver: ctx.powers.has("approveMoney") });

async function run<T>(fn: (actor: M.Actor, ctx: ErpContext) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const ctx = await requireErpWrite("expenses");
    const res = await fn(actorOf(ctx), ctx);
    revalidatePath("/erp/expenses");
    revalidatePath("/erp");
    return res;
  } catch (e) {
    return refused(e);
  }
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 20) : []);

export async function erpMoneyExpense(x: M.ExpenseInput) {
  return run((a) =>
    M.saveExpense(a, {
      petty: !!x.petty,
      date: s(x.date) ?? "",
      category: s(x.category),
      payee: s(x.payee),
      invoiceNo: s(x.invoiceNo),
      description: s(x.description),
      amountPaise: n(x.amountPaise),
      paidFrom: s(x.paidFrom),
      source: s(x.source),
      mode: s(x.mode),
      reference: s(x.reference),
      note: s(x.note),
      files: list(x.files),
      duplicateOverride: !!x.duplicateOverride,
    }),
  );
}

export async function erpMoneyReceipt(x: M.ReceiptInput) {
  return run((a) =>
    M.saveReceipt(a, {
      date: s(x.date) ?? "",
      into: s(x.into),
      amountPaise: n(x.amountPaise),
      customer: s(x.customer),
      payer: s(x.payer),
      mode: s(x.mode),
      reference: s(x.reference),
      billsText: s(x.billsText),
      note: s(x.note),
      files: list(x.files),
    }),
  );
}

export async function erpMoneyTransfer(x: M.TransferInput) {
  return run((a) =>
    M.saveTransfer(a, {
      date: s(x.date) ?? "",
      from: s(x.from),
      to: s(x.to),
      amountPaise: n(x.amountPaise),
      mode: s(x.mode),
      reference: s(x.reference),
      source: s(x.source),
      note: s(x.note),
      files: list(x.files),
    }),
  );
}

export async function erpMoneyAdvance(x: M.AdvanceInput) {
  return run((a) =>
    M.giveAdvance(a, {
      employee: s(x.employee),
      amountPaise: n(x.amountPaise),
      date: s(x.date) ?? "",
      purpose: s(x.purpose),
      billsDueOn: s(x.billsDueOn),
      from: s(x.from),
      mode: s(x.mode),
      reference: s(x.reference),
      note: s(x.note),
    }),
  );
}

export async function erpMoneyBills(advanceId: string, bills: M.BillInput[]) {
  const rows = (Array.isArray(bills) ? bills : []).slice(0, 50).map((b) => ({
    date: s(b.date),
    category: s(b.category),
    payee: s(b.payee),
    invoiceNo: s(b.invoiceNo),
    amountPaise: n(b.amountPaise),
    noBillReason: s(b.noBillReason),
    description: s(b.description),
    photo: s(b.photo),
  }));
  return run((a) => M.submitAdvanceBills(a, String(advanceId), rows));
}

export async function erpMoneyReview(ids: string[], decision: "approved" | "sent_back", note?: string | null) {
  if (decision !== "approved" && decision !== "sent_back") return err("Approve or send back.");
  return run((a) => M.reviewTxns(a, list(ids), decision, s(note)));
}

/** Cancels a transaction once the impact modal has been confirmed — the same check the screen's own Cancel makes. */
export async function erpMoneyCancel(id: string, reason: string, confirmation?: ImpactConfirmation | null) {
  return run(async (a) => {
    const refusal = await confirmImpact("erp-money-txn", String(id), confirmation);
    if (refusal) return refusal;
    return M.cancelTxn(a, String(id), typeof reason === "string" ? reason : "");
  });
}

export async function erpMoneySettle(advanceId: string, account: string) {
  return run((a) => M.settleAdvance(a, String(advanceId), s(account), null));
}

export async function erpMoneyMatch(lineId: string, txnIds: string[]) {
  return run((a) => M.matchBankLine(a, String(lineId), list(txnIds)));
}

export async function erpMoneyCreateFromLine(lineId: string, v: { category: string | null; party: string | null; description: string | null; counter: string | null }) {
  return run((a) => M.createFromBankLine(a, String(lineId), { category: s(v?.category), party: s(v?.party), description: s(v?.description), counter: s(v?.counter) }));
}

export async function erpMoneyImport(account: string, text: string) {
  return run((a) => M.importBankStatement(a, s(account), typeof text === "string" ? text : null));
}

/* ------------------------------------------------------------------ reads */

async function canRead(): Promise<boolean> {
  const ctx = await erpContext();
  return ctx.screens.has("expenses");
}

/** The live expense a new one would copy: the same invoice number from the same payee, or for the same amount. */
export async function erpMoneyDuplicate(x: { invoiceNo: string | null; payee: string | null; amountPaise: number }): Promise<{ id: string; label: string; date: string; amountPaise: number } | null> {
  if (!(await canRead())) return null;
  const key = invoiceKey(x.invoiceNo);
  if (!key) return null;
  const rows = await M.txnRows(sql`t.kind = 'expense' and t.status = 'active' and regexp_replace(lower(coalesce(t.invoice_no, '')), '[^a-z0-9]', '', 'g') = ${key}`);
  const d = duplicateOf({ invoiceNo: x.invoiceNo, payee: x.payee, amountPaise: Number(x.amountPaise) || 0 }, rows);
  return d ? { id: d.id, label: d.label, date: d.date, amountPaise: d.amountPaise } : null;
}

export type OpenBill = { id: string; billNo: string; billDate: string; dueDate: string | null; balancePaise: number };

/** A customer's open bills, oldest first, for a receipt to be applied against. Shown, never written. */
export async function erpMoneyCustomerBills(customer: string): Promise<Result<{ outstanding: number; bills: OpenBill[] }>> {
  if (!(await canRead())) return err("Not permitted.", "not_permitted");
  const rows = (await db.execute(sql`
    select b.id, b.bill_no as "billNo", b.bill_date::text as "billDate", b.due_date::text as "dueDate", (b.amount - b.paid_amount)::float8 as bal
      from bills b join customers c on c.id = b.customer_id
     where (c.id = ${customer} or c.name = ${customer}) and b.amount > b.paid_amount and b.status <> 'paid' and not b.disputed
     order by b.bill_date, b.bill_no
     limit 40`)) as unknown as { id: string; billNo: string; billDate: string; dueDate: string | null; bal: number }[];
  const bills = rows.map((r) => ({ id: r.id, billNo: r.billNo, billDate: r.billDate, dueDate: r.dueDate, balancePaise: Number(r.bal) }));
  return ok({ outstanding: bills.reduce((t, b) => t + b.balancePaise, 0), bills });
}
