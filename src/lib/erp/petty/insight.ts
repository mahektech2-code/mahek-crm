import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpExpenseBudgets, erpExpenseCategories, erpGodowns } from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpId } from "../server";
import { inTx, today } from "../screens/common";
import { addDaysIso, daysBetween } from "../engines/sales";
import { budgetFigures, rupees, splitsNearLimit, type BudgetFigures } from "../engines/petty-cash";
import { audit, balances, fundAccounts, pettyConfig, pettyRoles, type PettyConfig } from "./core";
import { isLive, isPayable, loadBankLines, loadClosings, loadExpenses, loadPayments, loadReceipts, loadTransfers, receiptCustody, tallyByRecord, type ExpenseFact } from "./facts";

/* ---------------------------------------------------------------------------
 * Budgets, and the exception queue (PRD §13, §19). Both are read off the
 * records as they stand, so an exception clears itself the moment its cause
 * is fixed — and the hourly alert run keeps the history of when it was
 * raised and when it cleared.
 * ------------------------------------------------------------------------- */

/* ============================================================== budgets */

export async function saveBudget(ctx: ErpContext, input: { id?: string | null; period: string | null; category: string | null; godownId: string | null; department: string | null; amountPaise: number | null }): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.approve && !roles.owner) return err("An approver or the owner sets budgets.", "not_permitted");
  if (!input.period || !/^\d{4}-\d{2}$/.test(input.period)) return fieldErr("period", "Pick the month");
  if (input.amountPaise == null || input.amountPaise < 0) return fieldErr("amount", "The budget cannot be negative");
  const [cat] = input.category ? await db.select().from(erpExpenseCategories).where(sql`lower(${erpExpenseCategories.name}) = lower(${input.category})`) : [];
  if (!cat) return fieldErr("category", "Pick the category");
  if (!cat.budgetApplicable) return fieldErr("category", "That category is not budgeted");
  return inTx(async (tx) => {
    const dept = (input.department ?? "").trim();
    const [dup] = await tx
      .select()
      .from(erpExpenseBudgets)
      .where(and(eq(erpExpenseBudgets.period, input.period!), eq(erpExpenseBudgets.categoryId, cat.id), input.godownId ? eq(erpExpenseBudgets.godownId, input.godownId) : sql`${erpExpenseBudgets.godownId} is null`, eq(erpExpenseBudgets.department, dept)));
    if (dup && dup.id !== input.id) return fieldErr("category", `${cat.name} already has a budget for ${input.period} there — change that one`);
    if (input.id) {
      const [b] = await tx.select().from(erpExpenseBudgets).where(eq(erpExpenseBudgets.id, input.id));
      if (!b) return err("That budget no longer exists.", "not_found");
      /* Changing an approved budget sends it back for approval: the figure a manager agreed to is the one that stands until they agree again. */
      await tx.update(erpExpenseBudgets).set({ period: input.period!, categoryId: cat.id, godownId: input.godownId, department: dept, amountPaise: input.amountPaise!, status: "draft", approvedById: null, approvedAt: null }).where(eq(erpExpenseBudgets.id, b.id));
      await audit(tx, ctx, "erp.petty.budget.edit", "erp_expense_budget", b.id, { amount: b.amountPaise, status: b.status }, { amount: input.amountPaise, status: "draft" });
      return okVoid(b.status === "approved" ? "Budget changed — it needs approving again" : "Budget saved");
    }
    const id = erpId("bud");
    await tx.insert(erpExpenseBudgets).values({ id, period: input.period!, categoryId: cat.id, godownId: input.godownId, department: dept, amountPaise: input.amountPaise!, createdById: ctx.actor.id });
    await audit(tx, ctx, "erp.petty.budget.create", "erp_expense_budget", id, null, { period: input.period, category: cat.name, amount: input.amountPaise });
    return okVoid("Budget saved as a draft — the owner approves it");
  });
}

export async function approveBudgets(ctx: ErpContext, ids: string[]): Promise<Result<unknown>> {
  if (!pettyRoles(ctx).owner) return err("The owner approves budgets.", "not_permitted");
  let n = 0;
  const res = await inTx(async (tx) => {
    for (const id of ids) {
      const [b] = await tx.select().from(erpExpenseBudgets).where(eq(erpExpenseBudgets.id, id));
      if (!b || b.status === "approved") continue;
      if (b.createdById === ctx.actor.id && !ctx.administrator) continue;
      await tx.update(erpExpenseBudgets).set({ status: "approved", approvedById: ctx.actor.id, approvedAt: new Date() }).where(eq(erpExpenseBudgets.id, id));
      await audit(tx, ctx, "erp.petty.budget.approve", "erp_expense_budget", id, { status: "draft" }, { status: "approved" });
      n++;
    }
    return okVoid();
  });
  if (!res.ok) return res;
  if (!n) return err("Nothing there was a draft somebody else set.", "rule_violation");
  return okVoid(`${n} budget${n === 1 ? "" : "s"} approved`);
}

export type BudgetRow = BudgetFigures & { id: string | null; period: string; categoryId: string; category: string; godownId: string | null; godown: string; department: string; status: string; count: number };

/**
 * Budget against actual for a month. Actual is INCURRED expense (approved or
 * waiting, received, net of approved adjustments); paid is shown beside it;
 * committed is what was approved but not received yet. A category that spent
 * without a budget is still listed, with no budget, so nothing hides.
 */
export async function budgetRows(period: string, facts?: ExpenseFact[]): Promise<BudgetRow[]> {
  const [budgets, cats, gds] = await Promise.all([
    db.select().from(erpExpenseBudgets).where(eq(erpExpenseBudgets.period, period)),
    db.select().from(erpExpenseCategories),
    db.select({ id: erpGodowns.id, name: erpGodowns.name }).from(erpGodowns),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const gName = new Map(gds.map((g) => [g.id, g.name]));
  const all = (facts ?? (await loadExpenses())).filter((f) => isLive(f.e) && f.e.expenseDate.slice(0, 7) === period && f.e.categoryId);
  const t = today();
  const rows: BudgetRow[] = [];
  const used = new Set<string>();
  for (const b of budgets) {
    const mine = all.filter((f) => f.e.categoryId === b.categoryId && (!b.godownId || f.e.godownId === b.godownId) && (!b.department || (f.e.department ?? "") === b.department));
    mine.forEach((f) => used.add(f.e.id));
    rows.push({ ...figuresOf(mine, b.amountPaise, period, t), id: b.id, period, categoryId: b.categoryId, category: catName.get(b.categoryId) ?? "—", godownId: b.godownId, godown: b.godownId ? (gName.get(b.godownId) ?? "—") : "All godowns", department: b.department || "—", status: b.status, count: mine.length });
  }
  const unbudgeted = new Map<string, ExpenseFact[]>();
  for (const f of all) if (!used.has(f.e.id)) unbudgeted.set(f.e.categoryId!, [...(unbudgeted.get(f.e.categoryId!) ?? []), f]);
  for (const [catId, list] of unbudgeted) rows.push({ ...figuresOf(list, 0, period, t), id: null, period, categoryId: catId, category: catName.get(catId) ?? "—", godownId: null, godown: "All godowns", department: "—", status: "No budget", count: list.length });
  return rows;
}

function figuresOf(list: ExpenseFact[], budgetPaise: number, period: string, t: string): BudgetFigures {
  const incurred = list.filter((f) => f.e.incurred);
  const committed = list.filter((f) => !f.e.incurred && f.e.approvalStatus === "approved");
  return budgetFigures({
    budgetPaise,
    incurredPaise: incurred.reduce((s, f) => s + f.state.payablePaise, 0),
    paidPaise: incurred.reduce((s, f) => s + f.state.paidPaise, 0),
    committedPaise: committed.reduce((s, f) => s + f.e.amountPaise, 0),
    period,
    today: t,
  });
}

/* =========================================================== exceptions */

export type PettyException = {
  key: string;
  kind: string;
  label: string;
  tone: "danger" | "warn" | "info";
  text: string;
  /** The tab that holds the record, and the record to open on it. */
  view: string;
  open: string | null;
  ids: string[];
  date: string;
};

/** Every open exception, worked out from the records as they stand now. */
export async function exceptions(cfgIn?: PettyConfig): Promise<PettyException[]> {
  const cfg = cfgIn ?? (await pettyConfig());
  const t = today();
  const now = Date.now();
  const [facts, payments, transfers, receipts, closings, bank, tally, funds, bal] = await Promise.all([loadExpenses(), loadPayments(), loadTransfers(), loadReceipts(), loadClosings(), loadBankLines(), tallyByRecord(), fundAccounts(), balances()]);
  const out: PettyException[] = [];
  const add = (x: Omit<PettyException, "key">) => out.push({ ...x, key: `${x.kind}:${x.open ?? x.ids.join(",")}` });

  for (const f of facts) {
    const e = f.e;
    if (e.legacy) continue;
    if ((e.approvalStatus === "submitted" || e.approvalStatus === "under_review") && e.submittedAt && (now - new Date(e.submittedAt).getTime()) / 86400000 > cfg.reviewDays) {
      add({ kind: "reviewOverdue", label: "Waiting for approval too long", tone: "warn", text: `${e.code} · ${rupees(e.amountPaise)} has waited ${Math.floor((now - new Date(e.submittedAt).getTime()) / 86400000)} days for ${e.approvalLevel === "owner" ? "the owner" : "an approver"}.`, view: "expenses", open: e.id, ids: [e.id], date: e.expenseDate });
    }
    if ((e.approvalStatus === "submitted" || e.approvalStatus === "under_review") && e.approvalLevel === "owner") {
      add({ kind: "aboveLimit", label: "Above the approver's limit", tone: "info", text: `${e.code} · ${rupees(e.amountPaise)} — ${e.approvalRule ?? "needs the owner"}.`, view: "expenses", open: e.id, ids: [e.id], date: e.expenseDate });
    }
    if (isLive(e) && f.receiptRequired && (e.docStatus === "to_follow" || e.docStatus === "not_available")) {
      add({ kind: "missingEvidence", label: "Bill or receipt missing", tone: "warn", text: `${e.code} · ${e.particular ?? "expense"} (${f.category}) has no bill attached and no approved exception.`, view: "expenses", open: e.id, ids: [e.id], date: e.expenseDate });
    }
    if (isPayable(e) && f.state.outstandingPaise > 0 && f.due) {
      const d = daysBetween(t, f.due);
      if (d < 0) add({ kind: "vendorOverdue", label: "Vendor payment overdue", tone: "danger", text: `${e.code} · ${e.vendorName ?? "payee"}: ${rupees(f.state.outstandingPaise)} was due ${f.due} (${-d} days ago).`, view: "pettyVendors", open: e.id, ids: [e.id], date: f.due });
      else if (d <= cfg.dueSoonDays) add({ kind: "vendorDue", label: "Vendor payment due", tone: "info", text: `${e.code} · ${e.vendorName ?? "payee"}: ${rupees(f.state.outstandingPaise)} due ${f.due}.`, view: "pettyVendors", open: e.id, ids: [e.id], date: f.due });
    }
    if (f.urgent && e.approvalStatus !== "approved") {
      add({ kind: "paidUnapproved", label: "Paid without approval", tone: e.approvalStatus === "rejected" ? "danger" : "warn", text: `${e.code} was paid as urgent and is ${e.approvalStatus === "rejected" ? "now REJECTED — the money has to be recovered or the decision revisited" : "still awaiting approval"}.`, view: "expenses", open: e.id, ids: [e.id], date: e.expenseDate });
    }
    if (e.isAdvance && f.advanceOpenPaise > 0 && daysBetween(e.expenseDate, t) > 30) {
      add({ kind: "advanceOpen", label: "Advance not settled", tone: "info", text: `${e.code}: ${rupees(f.advanceOpenPaise)} advanced to ${e.vendorName ?? e.expenseBy} over 30 days ago is not yet set against a bill or recovered.`, view: "expenses", open: e.id, ids: [e.id], date: e.expenseDate });
    }
  }

  for (const s of splitsNearLimit(
    facts.filter((f) => isLive(f.e)).map((f) => ({ id: f.e.id, payee: f.e.vendorName, amountPaise: f.e.amountPaise, date: f.e.expenseDate })),
    cfg.approverLimitPaise,
    cfg.splitWindowDays,
  )) {
    add({ kind: "splitNearLimit", label: "Possible split near the limit", tone: "warn", text: `${s.ids.length} expenses to ${s.payee} within ${cfg.splitWindowDays} days total ${rupees(s.totalPaise)}, each under the ${rupees(cfg.approverLimitPaise)} limit. For review — not an accusation.`, view: "expenses", open: null, ids: s.ids, date: t });
  }

  const byRef = new Map<string, typeof payments>();
  for (const p of payments) {
    if (p.p.status !== "confirmed" || !p.p.reference) continue;
    const k = p.p.reference.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (k.length < 4) continue;
    byRef.set(k, [...(byRef.get(k) ?? []), p]);
  }
  for (const [ref, list] of byRef) {
    if (list.length > 1 && list.some((p) => !p.p.splitReference)) add({ kind: "dupReference", label: "Duplicate payment reference", tone: "danger", text: `Reference ${ref} is on ${list.map((p) => p.p.code).join(", ")}.`, view: "pettyPayments", open: null, ids: list.map((p) => p.p.id), date: list[0].p.paymentDate });
  }
  const requested = payments.filter((p) => p.p.status === "requested");
  if (requested.length) add({ kind: "paymentRequests", label: "Payment requests to pay", tone: "info", text: `${requested.length} payment request${requested.length === 1 ? "" : "s"} for ${rupees(requested.reduce((s, p) => s + p.p.amountPaise, 0))} wait for accounts.`, view: "pettyPayments", open: null, ids: requested.map((p) => p.p.id), date: t });

  for (const l of bank.lines) {
    if (["unmatched", "exception", "correction"].includes(l.reconStatus)) {
      add({ kind: "bankUnmatched", label: l.reconStatus === "unmatched" ? "Unidentified bank transaction" : "Bank line needs attention", tone: "warn", text: `${l.txnDate} · ${l.debitPaise ? "debit" : "credit"} ${rupees(l.debitPaise || l.creditPaise)} · ${l.narration ?? ""}${l.exceptionReason ? ` — ${l.exceptionReason}` : ""}`, view: "pettyBank", open: l.id, ids: [l.id], date: l.txnDate });
    }
  }

  for (const r of receipts) {
    if (r.r.status !== "posted") continue;
    const c = receiptCustody(r.r.id, transfers);
    if (c.word === "Held" && (now - new Date(r.r.createdAt).getTime()) / 3600000 > cfg.handoverHours) {
      add({ kind: "cashHeld", label: "Customer cash not handed over", tone: "warn", text: `${r.r.receiptNo} · ${rupees(r.r.amountPaise)} from ${r.customer} has been held more than ${cfg.handoverHours} hours.`, view: "pettyReceipts", open: r.r.id, ids: [r.r.id], date: r.r.receiptDate });
    }
  }
  for (const tr of transfers) {
    if (tr.status === "initiated" && (now - new Date(tr.createdAt).getTime()) / 3600000 > cfg.handoverHours) {
      add({ kind: "transferUnconfirmed", label: "Handover not confirmed", tone: "warn", text: `${tr.code} · ${rupees(tr.amountPaise)} is still in transit — nobody has confirmed receiving it.`, view: "credits", open: tr.id, ids: [tr.id], date: tr.transferDate });
    }
  }

  const fundName = new Map(funds.map((f) => [f.id, f.name]));
  for (const c of closings) {
    if (c.variancePaise !== 0 && (c.status === "submitted" || c.status === "returned")) {
      add({ kind: "cashVariance", label: c.variancePaise < 0 ? "Cash shortage" : "Cash overage", tone: "danger", text: `${fundName.get(c.fundAccountId)} on ${c.closingDate}: counted ${rupees(c.countedPaise)} against ${rupees(c.expectedPaise)} expected (${rupees(c.variancePaise)}).`, view: "pettyClosing", open: c.id, ids: [c.id], date: c.closingDate });
    }
    if (c.status === "reopened") add({ kind: "closingReopened", label: "Backdated entry reopened a closed day", tone: "danger", text: `${fundName.get(c.fundAccountId)} on ${c.closingDate}: ${c.reopenedReason ?? "an entry dated into it was posted"}. Count and submit it again.`, view: "pettyClosing", open: c.id, ids: [c.id], date: c.closingDate });
  }
  const closedDays = new Set(closings.filter((c) => c.status !== "returned").map((c) => `${c.fundAccountId}|${c.closingDate}`));
  const moved = (await db.execute(sql`
    select distinct fund_account_id as fund, txn_date::text as day from erp_fund_ledger
     where txn_date >= ${addDaysIso(t, -7)} and txn_date < ${t}`)) as unknown as { fund: string; day: string }[];
  for (const f of funds.filter((x) => x.status === "active" && x.fundType !== "BANK")) {
    const missing = moved.filter((m) => m.fund === f.id && !closedDays.has(`${f.id}|${m.day}`)).map((m) => m.day).sort();
    if (missing.length) add({ kind: "closingMissing", label: "Cash closing not submitted", tone: "warn", text: `${f.name}: no closing for ${missing.join(", ")}.`, view: "pettyClosing", open: null, ids: [f.id], date: missing[0] });
    if ((bal.get(f.id) ?? 0) < 0) add({ kind: "fundNegative", label: "Fund below zero", tone: "danger", text: `${f.name} reads ${rupees(bal.get(f.id) ?? 0)} — a payment went out under an overdraw authority.`, view: "pettyLedger", open: null, ids: [f.id], date: t });
  }
  for (const f of funds.filter((x) => x.status === "active" && x.openingStatus !== "verified")) {
    add({ kind: "openingPending", label: "Opening balance not verified", tone: "info", text: `${f.name}: ${f.openingStatus === "proposed" ? "an opening balance is proposed and waits for verification" : "no opening balance has been set"}.`, view: "pettySettings", open: f.id, ids: [f.id], date: t });
  }

  for (const b of await budgetRows(t.slice(0, 7), facts)) {
    if (b.status === "approved" && b.budgetPaise > 0 && b.incurredPaise > b.budgetPaise) {
      add({ kind: "budgetExceeded", label: "Budget exceeded", tone: "warn", text: `${b.category} (${b.godown}) has incurred ${rupees(b.incurredPaise)} against ${rupees(b.budgetPaise)} this month.`, view: "pettyBudgets", open: b.id, ids: [b.id ?? b.categoryId], date: t });
    }
  }

  for (const [, s] of tally) {
    if (s.status === "failed" || s.status === "correction") add({ kind: "tallyFailed", label: s.status === "failed" ? "Tally sync failed" : "Tally voucher needs correcting", tone: "warn", text: `${s.remoteId}: ${s.lastError ?? s.status}`, view: "pettyTally", open: s.id, ids: [s.id], date: t });
  }

  const order = { danger: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone] || a.date.localeCompare(b.date));
}
