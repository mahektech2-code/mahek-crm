import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  erpExpenseAdjustments,
  erpExpenseApprovals,
  erpExpenseBudgets,
  erpExpenseCategories,
  erpExpensePayments,
  erpExpenses,
  erpFundAccounts,
  erpSuppliers,
} from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpId } from "../server";
import { inTx, refuse, today, type Tx } from "../screens/common";
import {
  ADVANCE_TYPE,
  OTHER_TYPE,
  PAYMENT_MODES_BY_FUND,
  PETTY_TXN_TYPES,
  approvalRoute,
  decisionRefusal,
  duplicateOf,
  fundsRefusal,
  payableState,
  paymentRefusal,
  rupees,
  type ApprovalLevel,
  type FundType,
} from "../engines/petty-cash";
import { addEvidence, audit, balanceIn, lock, nextCode, pettyConfig, pettyRoles, post, queueTally, reverseSource, tallyAfterReversal, type PettyConfig } from "./core";
import { notifyPetty } from "./notify";

/* ---------------------------------------------------------------------------
 * An expense and its payments (PRD §6–§7). An expense says what was bought
 * and who must approve it; a payment says money left a fund. They are
 * separate records, and the expense's payment status is derived from its
 * payments — nobody sets it.
 * ------------------------------------------------------------------------- */

export type ExpenseInput = {
  date: string;
  particular: string | null;
  category: string | null;
  txnType: string | null;
  godownId: string | null;
  vendorName: string | null;
  amountPaise: number | null;
  billNo?: string | null;
  billDate?: string | null;
  dueDate?: string | null;
  termsDays?: number | null;
  remarks?: string | null;
  docStatus?: string | null;
  fileId?: string | null;
  department?: string | null;
  /** False: ordered, not yet received — a commitment, not a payable. */
  incurred?: boolean;
  expenseBy?: string | null;
  submit: boolean;
  /** "yes" once somebody has seen the duplicate warning and says it is a separate expense. */
  notDuplicate?: boolean;
  /** Paid at the time it was recorded. Only with `submit`. */
  payNow?: PaymentInput | null;
};

export type PaymentInput = {
  date: string;
  amountPaise: number | null;
  fundId: string | null;
  mode: string | null;
  reference?: string | null;
  payee?: string | null;
  ackName?: string | null;
  ackFileId?: string | null;
  evidenceFileId?: string | null;
  /** Paying an expense not yet approved: why it could not wait. */
  urgentReason?: string | null;
  /** An approver's authority to pay more than the fund holds. */
  overdrawReason?: string | null;
  /** An approver's authority to pay cash with no acknowledgement. */
  evidenceExceptionReason?: string | null;
  /** The same reference pays several bills (one transfer for two expenses). */
  splitReference?: boolean;
  /** A request: nothing moves until accounts confirm it was paid. */
  asRequest?: boolean;
  /** Minted when the form opened: a retry of the same submission is the same payment. */
  requestKey?: string | null;
};

const DOC_STATUSES = ["attached", "to_follow", "not_available"];

/** The ERP supplier a typed payee names, where there is one — the payee stays as typed either way. */
async function supplierOf(name: string | null): Promise<string | null> {
  if (!name) return null;
  const [s] = await db.select({ id: erpSuppliers.id }).from(erpSuppliers).where(sql`lower(${erpSuppliers.name}) = lower(${name})`);
  return s?.id ?? null;
}

async function categoryByName(name: string | null) {
  if (!name) return null;
  const [c] = await db.select().from(erpExpenseCategories).where(sql`lower(${erpExpenseCategories.name}) = lower(${name})`);
  return c ?? null;
}

function validate(input: ExpenseInput): Result<unknown> | null {
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return fieldErr("date", "The expense date is required");
  if (input.incurred !== false && input.date > today()) return fieldErr("date", "An expense incurred cannot be dated in the future — record it as not yet received");
  if (!input.particular) return fieldErr("particular", "Say what it was for");
  if (!input.category) return fieldErr("category", "Pick a category");
  if (!input.godownId) return fieldErr("godown", "Pick the godown");
  if (!input.txnType || !(PETTY_TXN_TYPES as readonly string[]).includes(input.txnType)) return fieldErr("txnType", "Pick the transaction type");
  if (input.txnType === OTHER_TYPE && !input.remarks) return fieldErr("remarks", "“Other” needs an explanation in the remarks");
  if (input.amountPaise == null || !(input.amountPaise > 0)) return fieldErr("amount", "The amount must be more than zero");
  if (input.docStatus && !DOC_STATUSES.includes(input.docStatus)) return fieldErr("docStatus", "Pick whether the bill is attached");
  if (input.dueDate && input.dueDate < input.date) return fieldErr("dueDate", "The due date cannot be before the expense date");
  if (input.payNow && !input.submit) return fieldErr("submitAs", "An expense paid now has to be submitted, not kept as a draft");
  return null;
}

/** Possible duplicates among live expenses — the same bill from the same payee, or the same payee, amount and day. */
async function duplicates(input: ExpenseInput, excludeId?: string) {
  const live = await db
    .select({ id: erpExpenses.id, code: erpExpenses.code, payee: erpExpenses.vendorName, billNo: erpExpenses.billNo, amountPaise: erpExpenses.amountPaise, date: erpExpenses.expenseDate })
    .from(erpExpenses)
    .where(and(eq(erpExpenses.legacy, false), inArray(erpExpenses.approvalStatus, ["draft", "submitted", "under_review", "approved", "returned"]), excludeId ? ne(erpExpenses.id, excludeId) : undefined));
  return duplicateOf({ payee: input.vendorName, billNo: input.billNo ?? null, amountPaise: input.amountPaise ?? 0, date: input.date }, live);
}

/* ============================================================== create */

export async function createExpense(ctx: ErpContext, input: ExpenseInput): Promise<Result<{ id: string; code: string }>> {
  const bad = validate(input);
  if (bad) return bad as Result<never>;
  const cat = await categoryByName(input.category);
  if (!cat || !cat.active) return fieldErr("category", "That category is not active");
  if (!input.notDuplicate) {
    const dup = await duplicates(input);
    if (dup.length) return fieldErr("notDuplicate", `Possible duplicate of ${dup.map((d) => d.code ?? "an expense").join(", ")} — same payee and ${dup[0].billNo && dup[0].billNo === input.billNo ? "bill number" : "amount on the same day"}. Tick “separate expense” if it is not.`);
  }
  const cfg = await pettyConfig();
  const vendorId = await supplierOf(input.vendorName);
  let made: { id: string; code: string } | null = null;
  const res = await inTx(async (tx) => {
    const id = erpId("exp");
    const code = await nextCode(tx, "expense", "EXP");
    const docStatus = input.docStatus ?? (input.fileId ? "attached" : "to_follow");
    await tx.insert(erpExpenses).values({
      id,
      code,
      expenseDate: input.date,
      godownId: input.godownId!,
      expenseBy: input.expenseBy || ctx.user.name,
      category: cat.name,
      categoryId: cat.id,
      txnType: input.txnType,
      particular: input.particular,
      amountPaise: input.amountPaise!,
      note: input.remarks ?? null,
      vendorName: input.vendorName ?? null,
      vendorId,
      billNo: input.billNo ?? null,
      billDate: input.billDate ?? null,
      dueDate: input.dueDate ?? null,
      paymentTermsDays: input.termsDays ?? null,
      docStatus: input.fileId ? "attached" : docStatus === "attached" ? "to_follow" : docStatus,
      department: input.department ?? null,
      incurred: input.incurred !== false,
      receivedAt: input.incurred !== false ? input.date : null,
      isAdvance: input.txnType === ADVANCE_TYPE,
      approvalStatus: "draft",
      createdById: ctx.actor.id,
      updatedById: ctx.actor.id,
    });
    await addEvidence(tx, ctx, "expense", id, input.fileId, input.txnType === "Purchase of material" ? "Vendor invoice" : "Cash receipt");
    await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: "created", comment: "Saved as draft", byId: ctx.actor.id });
    await audit(tx, ctx, "erp.petty.expense.create", "erp_expense", id, null, { code, amount: input.amountPaise, category: cat.name, submit: input.submit });
    if (input.submit) {
      const s = await submitIn(tx, ctx, cfg, id);
      if (!s.ok) refuse(s);
    }
    if (input.payNow) {
      const p = await payIn(tx, ctx, cfg, id, input.payNow);
      if (!p.ok) refuse(p);
    }
    made = { id, code };
    return okVoid();
  });
  if (!res.ok) return res as Result<never>;
  const m = made as unknown as { id: string; code: string };
  await afterSubmit(m.id);
  return ok(m, `${m.code} saved${input.submit ? "" : " as a draft"}`);
}

/* ================================================================ edit */

export async function editExpense(ctx: ErpContext, id: string, input: ExpenseInput & { version: number | null }): Promise<Result<unknown>> {
  const bad = validate({ ...input, payNow: null });
  if (bad) return bad;
  const cat = await categoryByName(input.category);
  if (!cat || !cat.active) return fieldErr("category", "That category is not active");
  if (!input.notDuplicate) {
    const dup = await duplicates(input, id);
    if (dup.length) return fieldErr("notDuplicate", `Possible duplicate of ${dup.map((d) => d.code ?? "an expense").join(", ")}. Tick “separate expense” if it is not.`);
  }
  const cfg = await pettyConfig();
  const vendorId = await supplierOf(input.vendorName);
  const res = await inTx(async (tx) => {
    await lock(tx, `expense:${id}`);
    const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, id));
    if (!e) return err("That expense no longer exists.", "not_found");
    if (e.legacy) return err("An expense from before the ledger is kept as it was.", "rule_violation");
    if (!["draft", "returned"].includes(e.approvalStatus)) return err("Only a draft or an expense returned for correction can be edited. A submitted one is corrected by an adjustment.", "rule_violation");
    if (e.createdById !== ctx.actor.id && !ctx.administrator) return err("Only the person who raised it edits a draft.", "not_permitted");
    if (input.version != null && input.version !== e.version) return err("Somebody changed this expense while you had it open. Close it and open it again.", "conflict");
    await tx
      .update(erpExpenses)
      .set({
        expenseDate: input.date,
        godownId: input.godownId!,
        category: cat.name,
        categoryId: cat.id,
        txnType: input.txnType,
        particular: input.particular,
        amountPaise: input.amountPaise!,
        note: input.remarks ?? null,
        vendorName: input.vendorName ?? null,
        vendorId,
        billNo: input.billNo ?? null,
        billDate: input.billDate ?? null,
        dueDate: input.dueDate ?? null,
        paymentTermsDays: input.termsDays ?? null,
        department: input.department ?? null,
        incurred: input.incurred !== false,
        receivedAt: input.incurred !== false ? (e.receivedAt ?? input.date) : null,
        isAdvance: input.txnType === ADVANCE_TYPE,
        docStatus: input.fileId || e.docStatus === "attached" ? "attached" : (input.docStatus ?? e.docStatus),
        version: e.version + 1,
        updatedAt: new Date(),
        updatedById: ctx.actor.id,
      })
      .where(eq(erpExpenses.id, id));
    await addEvidence(tx, ctx, "expense", id, input.fileId, "Vendor invoice");
    await audit(tx, ctx, "erp.petty.expense.edit", "erp_expense", id, { amount: e.amountPaise, category: e.category, date: e.expenseDate }, { amount: input.amountPaise, category: cat.name, date: input.date });
    if (input.submit) {
      const s = await submitIn(tx, ctx, cfg, id);
      if (!s.ok) refuse(s);
    }
    return okVoid(input.submit ? "Saved and submitted" : "Saved");
  });
  if (res.ok && input.submit) await afterSubmit(id);
  return res;
}

/* ============================================================== submit */

export async function submitExpense(ctx: ErpContext, id: string): Promise<Result<unknown>> {
  const cfg = await pettyConfig();
  const res = await inTx(async (tx) => {
    await lock(tx, `expense:${id}`);
    return submitIn(tx, ctx, cfg, id);
  });
  if (res.ok) await afterSubmit(id);
  return res;
}

/** Whether this month's approved budget for the category is passed by adding `amountPaise`. */
async function budgetPassed(tx: Tx, e: typeof erpExpenses.$inferSelect): Promise<{ passed: boolean; budget: number | null; spent: number }> {
  if (!e.categoryId) return { passed: false, budget: null, spent: 0 };
  const period = e.expenseDate.slice(0, 7);
  const budgets = await tx
    .select()
    .from(erpExpenseBudgets)
    .where(and(eq(erpExpenseBudgets.period, period), eq(erpExpenseBudgets.categoryId, e.categoryId), eq(erpExpenseBudgets.status, "approved")));
  const own = budgets.filter((b) => b.godownId === e.godownId);
  const use = own.length ? own : budgets.filter((b) => !b.godownId);
  if (!use.length) return { passed: false, budget: null, spent: 0 };
  const budget = use.reduce((s, b) => s + b.amountPaise, 0);
  const godownClause = own.length ? sql`and godown_id = ${e.godownId}` : sql``;
  const rows = (await tx.execute(sql`
    select coalesce(sum(amount_paise), 0)::float8 as spent from erp_expenses
     where not legacy and incurred and category_id = ${e.categoryId} and approval_status in ('submitted', 'under_review', 'approved')
       and expense_date >= ${period + "-01"}::date and expense_date < (${period + "-01"}::date + interval '1 month') and id <> ${e.id} ${godownClause}`)) as unknown as { spent: number }[];
  const spent = Number(rows[0]?.spent ?? 0);
  return { passed: spent + e.amountPaise > budget, budget, spent };
}

/**
 * Submitting checks the expense and decides who must approve it (PRD §6 step
 * 4–5). Under the auto-approve limit, in a category that allows it, with its
 * receipt where one is needed, it is approved by policy on the spot and the
 * approval row says so — no person approved their own expense.
 */
async function submitIn(tx: Tx, ctx: ErpContext, cfg: PettyConfig, id: string): Promise<Result<unknown>> {
  const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, id));
  if (!e) return err("That expense no longer exists.", "not_found");
  if (e.legacy) return err("An expense from before the ledger is kept as it was.", "rule_violation");
  if (!["draft", "returned"].includes(e.approvalStatus)) return err("This expense is already submitted.", "rule_violation");
  if (!(e.amountPaise > 0)) return err("The amount must be more than zero.", "validation");
  const [cat] = e.categoryId ? await tx.select().from(erpExpenseCategories).where(eq(erpExpenseCategories.id, e.categoryId)) : [];
  if (!cat?.active) return err("Its category is not active. Edit it and pick another.", "validation");
  const missingEvidence = cat.receiptRequired && e.docStatus !== "attached" && e.docStatus !== "exception_approved";
  const budget = await budgetPassed(tx, e);
  const route = approvalRoute({
    amountPaise: e.amountPaise,
    categoryRule: cat.approvalRule,
    autoApproveUpToPaise: cfg.autoApproveUpToPaise,
    approverLimitPaise: cfg.approverLimitPaise,
    budgetExceeded: budget.passed,
    budgetRule: cfg.budgetRule,
    missingEvidence,
  });
  const now = new Date();
  await tx
    .update(erpExpenses)
    .set({
      approvalStatus: route.level === "policy" ? "approved" : "submitted",
      approvalLevel: route.level,
      approvalRule: route.rule + (budget.passed ? ` · over budget (${rupees(budget.spent + e.amountPaise)} of ${rupees(budget.budget ?? 0)})` : ""),
      submittedById: ctx.actor.id,
      submittedAt: now,
      decidedById: null,
      decidedAt: route.level === "policy" ? now : null,
      decisionNote: route.level === "policy" ? "Approved by policy" : null,
      version: e.version + 1,
      updatedAt: now,
      updatedById: ctx.actor.id,
    })
    .where(eq(erpExpenses.id, id));
  await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: "submitted", level: route.level, ruleApplied: route.rule, comment: missingEvidence ? "Bill not attached yet" : null, byId: ctx.actor.id });
  if (route.level === "policy") {
    await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: "approved", level: "policy", ruleApplied: route.rule, comment: "Approved by policy on submission", byId: null });
    if (e.incurred) await queueTally(tx, cfg, "expense", id, e.code ?? id);
  }
  if (budget.passed) await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: "budget_exceeded", level: route.level, ruleApplied: `Budget ${rupees(budget.budget ?? 0)}, spent ${rupees(budget.spent)} before this`, byId: null });
  await audit(tx, ctx, "erp.petty.expense.submit", "erp_expense", id, { approvalStatus: e.approvalStatus }, { approvalStatus: route.level === "policy" ? "approved" : "submitted", level: route.level, rule: route.rule });
  return okVoid(route.level === "policy" ? `${e.code} approved by policy` : `${e.code} submitted · ${route.level === "owner" ? "waits for the owner" : "waits for an approver"}`);
}

async function afterSubmit(id: string): Promise<void> {
  const [e] = await db.select().from(erpExpenses).where(eq(erpExpenses.id, id));
  if (!e || e.approvalStatus !== "submitted") return;
  await notifyPetty(e.approvalLevel === "owner" ? "pettyOwner" : "pettyApprove", {
    title: `Expense to approve: ${e.code} · ${rupees(e.amountPaise)}`,
    body: `${e.particular ?? "Expense"} — ${e.vendorName ?? e.expenseBy}. ${e.approvalRule ?? ""}`,
    view: "expenses",
    open: id,
    exclude: [e.createdById, e.submittedById],
  });
}

/* ============================================================== decide */

export type Decision = "approve" | "reject" | "return" | "review";

export async function decideExpense(ctx: ErpContext, ids: string[], decision: Decision, comment: string | null): Promise<Result<unknown>> {
  if ((decision === "reject" || decision === "return") && !comment) return fieldErr("comment", decision === "reject" ? "Say why it is rejected" : "Say what needs correcting");
  const roles = pettyRoles(ctx);
  const cfg = await pettyConfig();
  const done: string[] = [];
  for (const id of ids) {
    const res = await inTx(async (tx) => {
      await lock(tx, `expense:${id}`);
      const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, id));
      if (!e) return err("That expense no longer exists.", "not_found");
      if (!["submitted", "under_review"].includes(e.approvalStatus)) return err(`${e.code ?? "This expense"} is not waiting for a decision.`, "rule_violation");
      const why = decisionRefusal({
        level: e.approvalLevel as ApprovalLevel,
        deciderId: ctx.actor.id,
        deciderName: ctx.actor.name,
        makerIds: [e.createdById, e.submittedById],
        makerNames: [e.expenseBy],
        canApprove: roles.approve,
        canOwnerApprove: roles.owner,
      });
      if (why) {
        await audit(tx, ctx, "erp.petty.expense.decisionRefused", "erp_expense", id, null, { decision, why });
        return err(why, "not_permitted");
      }
      const next = { approve: "approved", reject: "rejected", return: "returned", review: "under_review" }[decision];
      const now = new Date();
      await tx
        .update(erpExpenses)
        .set({
          approvalStatus: next,
          ...(decision === "review" ? {} : { decidedById: ctx.actor.id, decidedAt: now, decisionNote: comment }),
          version: e.version + 1,
          updatedAt: now,
          updatedById: ctx.actor.id,
        })
        .where(eq(erpExpenses.id, id));
      await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: decision === "review" ? "review_started" : next, level: e.approvalLevel, ruleApplied: e.approvalRule, comment, byId: ctx.actor.id });
      if (decision === "approve" && e.incurred) await queueTally(tx, cfg, "expense", id, e.code ?? id);
      await audit(tx, ctx, `erp.petty.expense.${decision}`, "erp_expense", id, { approvalStatus: e.approvalStatus }, { approvalStatus: next, comment });
      done.push(id);
      return okVoid();
    });
    if (!res.ok) {
      if (ids.length === 1) return res;
      continue;
    }
  }
  if (!done.length) return err("None of those could be decided — they are not waiting, or they are yours.", "rule_violation");
  if (decision !== "review") await tellMakers(done, decision, comment);
  const word = { approve: "approved", reject: "rejected", return: "returned for correction", review: "taken for review" }[decision];
  return okVoid(`${done.length} expense${done.length === 1 ? "" : "s"} ${word}${done.length < ids.length ? ` · ${ids.length - done.length} could not be (yours, or not waiting)` : ""}`);
}

async function tellMakers(ids: string[], decision: Decision, comment: string | null) {
  const rows = await db.select().from(erpExpenses).where(inArray(erpExpenses.id, ids));
  const { notifyUsers } = await import("@/lib/notify");
  const { erpLink } = await import("../registry");
  await notifyUsers(
    rows
      .filter((e) => e.createdById)
      .map((e) => ({
        userId: e.createdById!,
        title: `${e.code} ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "returned for correction"}`,
        body: `${e.particular ?? "Expense"} · ${rupees(e.amountPaise)}${comment ? ` — ${comment}` : ""}`,
        kind: decision === "approve" ? ("success" as const) : ("warn" as const),
        href: erpLink("expenses", { open: e.id }),
      })),
  );
}

/* ====================================================== other changes */

/** Withdraws an expense before anything was paid on it. Its history stays. */
export async function cancelExpense(ctx: ErpContext, id: string, reason: string | null): Promise<Result<unknown>> {
  if (!reason) return fieldErr("reason", "Say why it is cancelled");
  const roles = pettyRoles(ctx);
  return inTx(async (tx) => {
    await lock(tx, `expense:${id}`);
    const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, id));
    if (!e) return err("That expense no longer exists.", "not_found");
    if (!["draft", "submitted", "under_review", "returned"].includes(e.approvalStatus)) return err("An approved expense is corrected by an adjustment, never cancelled.", "rule_violation");
    if (e.createdById !== ctx.actor.id && !roles.approve && !roles.owner) return err("The person who raised it, or an approver, cancels it.", "not_permitted");
    const pays = await tx.select().from(erpExpensePayments).where(and(eq(erpExpensePayments.expenseId, id), inArray(erpExpensePayments.status, ["requested", "confirmed"])));
    if (pays.length) return err("Money was paid or requested on it. Reverse or cancel those payments first.", "rule_violation");
    await tx.update(erpExpenses).set({ approvalStatus: "cancelled", decisionNote: reason, version: e.version + 1, updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpExpenses.id, id));
    await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: "cancelled", comment: reason, byId: ctx.actor.id });
    await audit(tx, ctx, "erp.petty.expense.cancel", "erp_expense", id, { approvalStatus: e.approvalStatus }, { approvalStatus: "cancelled", reason });
    return okVoid(`${e.code} cancelled`);
  });
}

/** A commitment arrived: it becomes an incurred expense, and a payable once approved. */
export async function markReceived(ctx: ErpContext, id: string, date: string | null): Promise<Result<unknown>> {
  const cfg = await pettyConfig();
  return inTx(async (tx) => {
    await lock(tx, `expense:${id}`);
    const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, id));
    if (!e) return err("That expense no longer exists.", "not_found");
    if (e.incurred) return err("It is already received.", "rule_violation");
    const on = date ?? today();
    if (on > today()) return fieldErr("date", "It cannot be received in the future");
    await tx.update(erpExpenses).set({ incurred: true, receivedAt: on, version: e.version + 1, updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpExpenses.id, id));
    await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: "received", comment: `Goods or service received ${on}`, byId: ctx.actor.id });
    if (e.approvalStatus === "approved") await queueTally(tx, cfg, "expense", id, e.code ?? id);
    await audit(tx, ctx, "erp.petty.expense.received", "erp_expense", id, { incurred: false }, { incurred: true, on });
    return okVoid(`${e.code} received — it is a payable now${e.approvalStatus === "approved" ? "" : " once approved"}`);
  });
}

/** An approver lets an expense stand without its bill, in writing (PRD §14.7). */
export async function approveDocException(ctx: ErpContext, id: string, reason: string | null): Promise<Result<unknown>> {
  if (!reason) return fieldErr("reason", "Say why the bill can be done without");
  const roles = pettyRoles(ctx);
  if (!roles.approve && !roles.owner) return err("An approver allows a missing document.", "not_permitted");
  return inTx(async (tx) => {
    const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, id));
    if (!e) return err("That expense no longer exists.", "not_found");
    if (e.createdById === ctx.actor.id || e.expenseBy.trim().toLowerCase() === ctx.actor.name.trim().toLowerCase()) return err("Nobody excuses the bill on their own expense.", "not_permitted");
    if (e.docStatus === "attached") return err("Its bill is already attached.", "rule_violation");
    await tx.update(erpExpenses).set({ docStatus: "exception_approved", docExceptionById: ctx.actor.id, docExceptionReason: reason, updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpExpenses.id, id));
    await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: id, action: "doc_exception", comment: reason, byId: ctx.actor.id });
    await audit(tx, ctx, "erp.petty.expense.docException", "erp_expense", id, { docStatus: e.docStatus }, { docStatus: "exception_approved", reason });
    return okVoid("Missing-document exception approved");
  });
}

export async function addExpenseEvidence(ctx: ErpContext, id: string, fileId: string | null, kind: string | null): Promise<Result<unknown>> {
  if (!fileId) return fieldErr("file", "Attach the file");
  return inTx(async (tx) => {
    const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, id));
    if (!e) return err("That expense no longer exists.", "not_found");
    const added = await addEvidence(tx, ctx, "expense", id, fileId, kind ?? "Other");
    if (!added) return err("That file was already filed, or is not yours.", "rule_violation");
    if (e.docStatus !== "attached") await tx.update(erpExpenses).set({ docStatus: "attached", updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpExpenses.id, id));
    await audit(tx, ctx, "erp.petty.expense.evidence", "erp_expense", id, null, { kind, fileId });
    return okVoid("Evidence added");
  });
}

/* ============================================================ payments */

export async function recordPayment(ctx: ErpContext, expenseId: string, input: PaymentInput): Promise<Result<{ id: string; existing: boolean }>> {
  const cfg = await pettyConfig();
  if (input.requestKey) {
    const [prior] = await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.requestKey, input.requestKey));
    if (prior) return ok({ id: prior.id, existing: true }, `Already recorded as ${prior.code} — nothing was paid twice`);
  }
  let made: { id: string; existing: boolean } | null = null;
  const res = await inTx(async (tx) => {
    const r = await payIn(tx, ctx, cfg, expenseId, input);
    if (r.ok) made = r.data;
    return r;
  });
  if (!res.ok) {
    if (input.requestKey) {
      /* Two identical submissions raced: the loser's unique key refused it, and the winner is the answer. */
      const [prior] = await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.requestKey, input.requestKey));
      if (prior) return ok({ id: prior.id, existing: true }, `Already recorded as ${prior.code} — nothing was paid twice`);
    }
    if (res.code === "rule_violation" && /holds/.test(res.error)) await logRefusedAttempt(ctx, expenseId, input, res.error);
    return res as Result<never>;
  }
  return ok(made as unknown as { id: string; existing: boolean }, res.message);
}

async function logRefusedAttempt(ctx: ErpContext, expenseId: string, input: PaymentInput, why: string) {
  const { erpAudit } = await import("../server");
  await erpAudit(ctx, "erp.petty.payment.refused", "erp_expense", expenseId, null, { amount: input.amountPaise, fundId: input.fundId, why });
}

async function payIn(tx: Tx, ctx: ErpContext, cfg: PettyConfig, expenseId: string, input: PaymentInput): Promise<Result<{ id: string; existing: boolean }>> {
  const roles = pettyRoles(ctx);
  if (!input.fundId) return fieldErr("fund", "Pick the fund it was paid from");
  await lock(tx, `expense:${expenseId}`, `fund:${input.fundId}`);
  if (input.requestKey) {
    const [prior] = await tx.select().from(erpExpensePayments).where(eq(erpExpensePayments.requestKey, input.requestKey));
    if (prior) return ok({ id: prior.id, existing: true }, `Already recorded as ${prior.code}`);
  }
  const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, expenseId));
  if (!e) return err("That expense no longer exists.", "not_found");
  if (e.legacy) return err("An expense from before the ledger takes no payments here.", "rule_violation");
  if (!e.incurred && !e.isAdvance) return err("This is a commitment — not received yet. Mark it received first, or pay an advance as its own expense.", "rule_violation");
  let approval: "approved" | "urgent" = "approved";
  if (e.approvalStatus !== "approved") {
    if (!["submitted", "under_review"].includes(e.approvalStatus)) return err(`An expense that is ${e.approvalStatus.replace("_", " ")} cannot be paid. Submit it first.`, "rule_violation");
    if (input.asRequest) return err("A payment request waits for the expense's approval. Approve it first, or record an urgent payment with its reason.", "rule_violation");
    if (!input.urgentReason) return fieldErr("urgentReason", "This expense is not approved yet. Paying it now is an urgent payment: say why it could not wait");
    if (!input.evidenceFileId && !input.ackFileId) return fieldErr("evidence", "An urgent payment needs its supporting evidence attached");
    approval = "urgent";
  }
  if (!input.date || input.date > today()) return fieldErr("date", "The payment date cannot be in the future");
  const amount = input.amountPaise ?? 0;
  const [pays, adjs] = await Promise.all([
    tx.select().from(erpExpensePayments).where(eq(erpExpensePayments.expenseId, expenseId)),
    tx.select().from(erpExpenseAdjustments).where(eq(erpExpenseAdjustments.expenseId, expenseId)),
  ]);
  const state = payableState(e.amountPaise, pays, adjs, cfg.tolerancePaise);
  const over = paymentRefusal(amount, state, { isAdvance: e.isAdvance });
  if (over) return fieldErr("amount", over);
  const [fund] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, input.fundId));
  if (!fund || fund.status !== "active") return fieldErr("fund", "That fund account is not active");
  const modes = PAYMENT_MODES_BY_FUND[fund.fundType as FundType] ?? [];
  if (!input.mode || !modes.includes(input.mode)) return fieldErr("mode", `${fund.name} pays by ${modes.join(" or ")}`);
  const ref = (input.reference ?? "").trim() || null;
  const isBank = fund.fundType === "BANK";
  if (isBank && !ref && !input.asRequest) return fieldErr("reference", "A bank payment needs its UPI/UTR or cheque reference");
  if (!isBank && !input.asRequest && !input.ackName && !input.ackFileId) {
    if (!input.evidenceExceptionReason) return fieldErr("ackName", "A cash payment needs the payee's acknowledgement — their name, or a photo of the signed slip");
    if (!roles.approve && !roles.owner) return fieldErr("ackName", "Only an approver can let a cash payment go without an acknowledgement");
  }
  if (ref && !input.splitReference) {
    const norm = ref.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const clash = (await tx.execute(sql`
      select code from erp_expense_payments
       where status in ('requested', 'confirmed') and regexp_replace(upper(coalesce(reference, '')), '[^A-Z0-9]', '', 'g') = ${norm} limit 1`)) as unknown as { code: string }[];
    if (clash[0]) return fieldErr("reference", `Reference ${ref} is already on ${clash[0].code}. If one transfer paid both bills, tick “same transfer pays several bills”.`);
  }
  if (!input.asRequest) {
    const available = await balanceIn(tx, fund.id);
    const short = fundsRefusal(available, amount, fund.name);
    if (short) {
      if (!input.overdrawReason) return err(short + " Record a payment request instead, or move funds in first.", "rule_violation");
      if (!roles.approve && !roles.owner) return err(short + " Only an approver can authorise paying beyond what a fund holds.", "rule_violation");
    }
  }
  const id = erpId("pay");
  const code = await nextCode(tx, "payment", "PAY");
  const confirmed = !input.asRequest;
  await tx.insert(erpExpensePayments).values({
    id,
    code,
    expenseId,
    paymentDate: input.date,
    amountPaise: amount,
    fundAccountId: fund.id,
    payee: input.payee || e.vendorName,
    mode: input.mode,
    reference: ref,
    ackName: input.ackName ?? null,
    ackFileId: input.ackFileId ?? null,
    evidenceFileId: input.evidenceFileId ?? null,
    status: confirmed ? "confirmed" : "requested",
    approval,
    urgentReason: approval === "urgent" ? input.urgentReason : null,
    overdrawReason: input.overdrawReason ?? null,
    splitReference: !!input.splitReference,
    evidenceExceptionReason: input.evidenceExceptionReason ?? null,
    reconStatus: isBank ? "unreconciled" : "not_applicable",
    requestKey: input.requestKey ?? null,
    requestedById: confirmed ? null : ctx.actor.id,
    recordedById: ctx.actor.id,
    confirmedById: confirmed ? ctx.actor.id : null,
    confirmedAt: confirmed ? new Date() : null,
  });
  await addEvidence(tx, ctx, "payment", id, input.evidenceFileId, isBank ? "UPI screenshot / reference" : "Cash receipt");
  await addEvidence(tx, ctx, "payment", id, input.ackFileId, "Cash receipt");
  if (confirmed) {
    await post(tx, ctx, { fundId: fund.id, direction: "debit", amountPaise: amount, date: input.date, txnType: "expense_payment", sourceType: "payment", sourceId: id, postingKey: `payment:${id}`, narration: `${code} · ${e.code} ${e.particular ?? ""}`.trim() });
    await queueTally(tx, cfg, "payment", id, code);
  }
  await audit(tx, ctx, confirmed ? "erp.petty.payment.record" : "erp.petty.payment.request", "erp_expense_payment", id, null, { code, expense: e.code, amount, fund: fund.name, approval, overdraw: input.overdrawReason ?? null });
  const left = state.payablePaise - state.paidPaise - amount;
  return ok(
    { id, existing: false },
    confirmed
      ? `${code} · ${rupees(amount)} paid from ${fund.name}${left > 0 ? ` · ${rupees(left)} still to pay` : " · paid in full"}${approval === "urgent" ? " · urgent: waits for the expense's approval" : ""}`
      : `${code} · payment request for ${rupees(amount)} — nothing moves until accounts confirm it`,
  );
}

/** Accounts confirm a requested payment was made: only now does the fund go down. */
export async function confirmPaymentRequest(ctx: ErpContext, id: string, input: { date: string | null; reference: string | null; ackName: string | null; fileId: string | null }): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.accounts && !roles.approve) return err("The accounts team confirms a payment was made.", "not_permitted");
  const cfg = await pettyConfig();
  const [p0] = await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.id, id));
  if (!p0) return err("That payment no longer exists.", "not_found");
  return inTx(async (tx) => {
    await lock(tx, `expense:${p0.expenseId}`, `fund:${p0.fundAccountId}`);
    const [p] = await tx.select().from(erpExpensePayments).where(eq(erpExpensePayments.id, id));
    if (p.status !== "requested") return err("Only a payment request is confirmed.", "rule_violation");
    if (p.requestedById === ctx.actor.id && !ctx.administrator) return err("Somebody other than whoever asked for it confirms it was paid.", "not_permitted");
    const [fund] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, p.fundAccountId));
    const ref = input.reference || p.reference;
    if (fund.fundType === "BANK" && !ref) return fieldErr("reference", "A bank payment needs its UPI/UTR or cheque reference");
    if (fund.fundType !== "BANK" && !p.ackName && !input.ackName && !input.fileId && !p.ackFileId) return fieldErr("ackName", "A cash payment needs the payee's acknowledgement");
    const available = await balanceIn(tx, fund.id);
    const short = fundsRefusal(available, p.amountPaise, fund.name);
    if (short) return err(short, "rule_violation");
    const date = input.date ?? today();
    if (date > today()) return fieldErr("date", "The payment date cannot be in the future");
    await tx
      .update(erpExpensePayments)
      .set({ status: "confirmed", paymentDate: date, reference: ref, ackName: input.ackName ?? p.ackName, confirmedById: ctx.actor.id, confirmedAt: new Date() })
      .where(eq(erpExpensePayments.id, id));
    await addEvidence(tx, ctx, "payment", id, input.fileId, fund.fundType === "BANK" ? "UPI screenshot / reference" : "Cash receipt");
    await post(tx, ctx, { fundId: fund.id, direction: "debit", amountPaise: p.amountPaise, date, txnType: "expense_payment", sourceType: "payment", sourceId: id, postingKey: `payment:${id}`, narration: `${p.code} confirmed` });
    await queueTally(tx, cfg, "payment", id, p.code);
    await audit(tx, ctx, "erp.petty.payment.confirm", "erp_expense_payment", id, { status: "requested" }, { status: "confirmed", date, reference: ref });
    return okVoid(`${p.code} confirmed · ${rupees(p.amountPaise)} out of ${fund.name}`);
  });
}

export async function cancelPaymentRequest(ctx: ErpContext, id: string, reason: string | null): Promise<Result<unknown>> {
  if (!reason) return fieldErr("reason", "Say why it is cancelled");
  const roles = pettyRoles(ctx);
  return inTx(async (tx) => {
    const [p] = await tx.select().from(erpExpensePayments).where(eq(erpExpensePayments.id, id));
    if (!p) return err("That payment no longer exists.", "not_found");
    if (p.status !== "requested") return err("Only a request that was never paid is cancelled. A paid one is reversed.", "rule_violation");
    if (p.requestedById !== ctx.actor.id && !roles.accounts && !roles.approve) return err("Whoever asked for it, or the accounts team, cancels it.", "not_permitted");
    await tx.update(erpExpensePayments).set({ status: "cancelled", reversalReason: reason, reversedById: ctx.actor.id, reversedAt: new Date() }).where(eq(erpExpensePayments.id, id));
    await audit(tx, ctx, "erp.petty.payment.cancel", "erp_expense_payment", id, { status: "requested" }, { status: "cancelled", reason });
    return okVoid(`${p.code} cancelled`);
  });
}

/**
 * A posted payment is never edited or deleted (PRD §7.10). A mistake is
 * reversed: a new ledger row puts the money back, the payment reads reversed,
 * the expense's status recalculates, and a Tally voucher already posted is
 * flagged for correction. Dated on the original day, it reopens that day's
 * approved closing rather than changing it silently.
 */
export async function reversePayment(ctx: ErpContext, id: string, reason: string | null, onOriginalDate: boolean): Promise<Result<unknown>> {
  if (!reason) return fieldErr("reason", "Say why it is reversed");
  const roles = pettyRoles(ctx);
  if (!roles.approve && !roles.owner) return err("An approver reverses a posted payment.", "not_permitted");
  const [p0] = await db.select().from(erpExpensePayments).where(eq(erpExpensePayments.id, id));
  if (!p0) return err("That payment no longer exists.", "not_found");
  return inTx(async (tx) => {
    await lock(tx, `expense:${p0.expenseId}`, `fund:${p0.fundAccountId}`);
    const [p] = await tx.select().from(erpExpensePayments).where(eq(erpExpensePayments.id, id));
    if (p.status !== "confirmed") return err("Only a confirmed payment is reversed.", "rule_violation");
    if (p.reconStatus === "matched" || p.reconStatus === "reconciled") return err("It is matched to a bank statement line. Unmatch it on Bank reconciliation first.", "rule_violation");
    const date = onOriginalDate ? p.paymentDate : today();
    await reverseSource(tx, ctx, "payment", id, date, reason);
    await tx.update(erpExpensePayments).set({ status: "reversed", reversedById: ctx.actor.id, reversedAt: new Date(), reversalReason: reason }).where(eq(erpExpensePayments.id, id));
    await tallyAfterReversal(tx, "payment", id);
    await audit(tx, ctx, "erp.petty.payment.reverse", "erp_expense_payment", id, { status: "confirmed" }, { status: "reversed", reason, date });
    return okVoid(`${p.code} reversed · ${rupees(p.amountPaise)} back in the fund`);
  });
}

/** Accounts checked the bill and the proof behind a payment. */
export async function verifyPayment(ctx: ErpContext, ids: string[]): Promise<Result<unknown>> {
  if (!pettyRoles(ctx).accounts) return err("The accounts team verifies payments.", "not_permitted");
  const rows = await db.select().from(erpExpensePayments).where(inArray(erpExpensePayments.id, ids));
  const mine = rows.filter((p) => p.recordedById === ctx.actor.id && !ctx.administrator);
  const ok2 = rows.filter((p) => p.status === "confirmed" && !p.verifiedAt && !mine.includes(p));
  if (!ok2.length) return err(mine.length ? "Somebody other than whoever recorded it verifies it." : "Nothing there is confirmed and unverified.", "rule_violation");
  await db.update(erpExpensePayments).set({ verifiedById: ctx.actor.id, verifiedAt: new Date() }).where(inArray(erpExpensePayments.id, ok2.map((p) => p.id)));
  const { erpAudit } = await import("../server");
  await erpAudit(ctx, "erp.petty.payment.verify", "erp_expense_payment", ok2.map((p) => p.id).join(","));
  return okVoid(`${ok2.length} payment${ok2.length === 1 ? "" : "s"} verified`);
}

/* ========================================================= adjustments */

export async function requestExpenseAdjustment(
  ctx: ErpContext,
  expenseId: string,
  input: { kind: string | null; amountPaise: number | null; reason: string | null; advanceExpenseId?: string | null; increase?: boolean },
): Promise<Result<unknown>> {
  const kinds = ["correction", "vendor_credit", "advance_applied", "write_off"];
  if (!input.kind || !kinds.includes(input.kind)) return fieldErr("kind", "Pick the kind of adjustment");
  if (!input.amountPaise || input.amountPaise <= 0) return fieldErr("amount", "The amount must be more than zero");
  if (!input.reason) return fieldErr("reason", "Say why");
  const cfg = await pettyConfig();
  return inTx(async (tx) => {
    await lock(tx, `expense:${expenseId}`);
    const [e] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, expenseId));
    if (!e) return err("That expense no longer exists.", "not_found");
    if (!["submitted", "under_review", "approved"].includes(e.approvalStatus) || e.legacy) return err("Only a submitted or approved expense is adjusted; a draft is simply edited.", "rule_violation");
    const signed = input.increase && input.kind === "correction" ? -input.amountPaise! : input.amountPaise!;
    if (signed > 0) {
      const [pays, adjs] = await Promise.all([
        tx.select().from(erpExpensePayments).where(eq(erpExpensePayments.expenseId, expenseId)),
        tx.select().from(erpExpenseAdjustments).where(eq(erpExpenseAdjustments.expenseId, expenseId)),
      ]);
      const st = payableState(e.amountPaise, pays, adjs, cfg.tolerancePaise);
      const pending = adjs.filter((a) => a.status === "requested").reduce((s, a) => s + a.amountPaise, 0);
      if (signed > st.outstandingPaise - pending) return fieldErr("amount", `Only ${rupees(Math.max(0, st.outstandingPaise - pending))} is outstanding to adjust. A refund of money already paid is recovered into a fund instead.`);
    }
    if (input.kind === "advance_applied") {
      if (!input.advanceExpenseId) return fieldErr("advance", "Pick the advance to set against this bill");
      const [a] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, input.advanceExpenseId));
      if (!a?.isAdvance) return fieldErr("advance", "That is not an advance");
      const open = await advanceOpen(tx, a.id);
      if (signed > open) return fieldErr("amount", `Only ${rupees(open)} of that advance is still open`);
    }
    const id = erpId("xadj");
    await tx.insert(erpExpenseAdjustments).values({ id, expenseId, kind: input.kind!, amountPaise: signed, advanceExpenseId: input.advanceExpenseId ?? null, reason: input.reason!, requestedById: ctx.actor.id });
    await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId, action: "adjustment_requested", comment: `${input.kind}: ${rupees(Math.abs(signed))} — ${input.reason}`, byId: ctx.actor.id });
    await audit(tx, ctx, "erp.petty.expenseAdjustment.request", "erp_expense", expenseId, null, { kind: input.kind, amount: signed, reason: input.reason });
    return okVoid("Adjustment requested — an approver decides it");
  });
}

export async function advanceOpen(tx: Tx, advanceId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select
      coalesce((select sum(amount_paise) from erp_expense_payments where expense_id = ${advanceId} and status = 'confirmed'), 0)::float8
      - coalesce((select sum(amount_paise) from erp_expense_adjustments where advance_expense_id = ${advanceId} and kind = 'advance_applied' and status in ('approved', 'requested')), 0)::float8
      - coalesce((select sum(amount_paise) from erp_fund_adjustments where expense_id = ${advanceId} and kind = 'advance_recovery' and status in ('approved', 'requested')), 0)::float8 as open`)) as unknown as { open: number }[];
  return Math.max(0, Number(rows[0]?.open ?? 0));
}

export async function decideExpenseAdjustment(ctx: ErpContext, adjustmentId: string, approve: boolean, note: string | null): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.approve && !roles.owner) return err("An approver decides adjustments.", "not_permitted");
  if (!approve && !note) return fieldErr("note", "Say why it is rejected");
  return inTx(async (tx) => {
    const [a] = await tx.select().from(erpExpenseAdjustments).where(eq(erpExpenseAdjustments.id, adjustmentId));
    if (!a) return err("That adjustment no longer exists.", "not_found");
    if (a.status !== "requested") return err("It is already decided.", "rule_violation");
    if (a.requestedById === ctx.actor.id) return err("Somebody other than whoever asked for it decides it.", "not_permitted");
    await lock(tx, `expense:${a.expenseId}`);
    await tx.update(erpExpenseAdjustments).set({ status: approve ? "approved" : "rejected", decidedById: ctx.actor.id, decidedAt: new Date(), decisionNote: note }).where(eq(erpExpenseAdjustments.id, adjustmentId));
    await tx.insert(erpExpenseApprovals).values({ id: erpId("eap"), expenseId: a.expenseId, action: approve ? "adjustment_approved" : "adjustment_rejected", comment: note ?? `${a.kind}: ${rupees(Math.abs(a.amountPaise))}`, byId: ctx.actor.id });
    await audit(tx, ctx, `erp.petty.expenseAdjustment.${approve ? "approve" : "reject"}`, "erp_expense", a.expenseId, { status: "requested" }, { status: approve ? "approved" : "rejected", note });
    return okVoid(approve ? "Adjustment approved" : "Adjustment rejected");
  });
}

/** Re-exported for the screens that need the approval history. */
export async function approvalHistory(expenseId: string) {
  const { users } = await import("@/db/schema");
  return db
    .select({ a: erpExpenseApprovals, by: users.name })
    .from(erpExpenseApprovals)
    .leftJoin(users, eq(users.id, erpExpenseApprovals.byId))
    .where(eq(erpExpenseApprovals.expenseId, expenseId))
    /* Rows written in one transaction share its timestamp: the order they happen in breaks the tie. */
    .orderBy(erpExpenseApprovals.at, sql`case ${erpExpenseApprovals.action} when 'created' then 0 when 'submitted' then 1 when 'budget_exceeded' then 2 else 3 end`);
}
