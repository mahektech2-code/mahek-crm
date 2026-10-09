import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  customers,
  erpCashClosings,
  erpCustomerCashReceipts,
  erpExpenses,
  erpFundAccounts,
  erpFundAdjustments,
  erpFundTransfers,
} from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpId } from "../server";
import { inTx, today } from "../screens/common";
import { FUND_TYPES, closingFigures, fundsRefusal, rupees, transferRefusal, transferType, varianceOf, type FundType } from "../engines/petty-cash";
import { addEvidence, audit, balanceIn, lock, nextCode, pettyConfig, pettyRoles, post, queueTally, reverseSource, tallyAfterReversal } from "./core";
import { advanceOpen } from "./expenses";
import { notifyPetty } from "./notify";

/* ---------------------------------------------------------------------------
 * Money moving between funds, customer cash coming in, the day's count, and
 * the controlled entries that set or correct a balance (PRD §5, §8, §9, §12).
 * Every one of them reaches a balance only through `post`.
 * ------------------------------------------------------------------------- */

const fundOf = async (id: string | null) => (id ? ((await db.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, id)))[0] ?? null) : null);

/* ============================================================ transfers */

export type TransferInput = {
  type: string | null;
  date: string | null;
  fromFundId: string | null;
  toFundId: string | null;
  amountPaise: number | null;
  purpose?: string | null;
  bankReference?: string | null;
  receiptIds?: string[];
  evidenceFileId?: string | null;
  requestKey?: string | null;
};

/**
 * Starting a transfer moves NOTHING: the cash is in transit until whoever
 * receives it confirms (PRD §8B). Only the confirmation posts, and it posts
 * both legs in one transaction under one transfer id.
 */
export async function initiateTransfer(ctx: ErpContext, input: TransferInput): Promise<Result<{ id: string; code: string }>> {
  const t = input.type ? transferType(input.type) : undefined;
  if (!t) return fieldErr("type", "Pick the kind of transfer");
  if (!input.date || input.date > today()) return fieldErr("date", "The date cannot be in the future");
  if (!input.amountPaise || input.amountPaise <= 0) return fieldErr("amount", "The amount must be more than zero");
  if (input.requestKey) {
    const [prior] = await db.select().from(erpFundTransfers).where(eq(erpFundTransfers.requestKey, input.requestKey));
    if (prior) return ok({ id: prior.id, code: prior.code }, `Already recorded as ${prior.code}`);
  }
  const [from, to] = await Promise.all([fundOf(input.fromFundId), fundOf(input.toFundId)]);
  if (!from || from.status !== "active") return fieldErr("from", "Pick the fund the money leaves");
  if (!to || to.status !== "active") return fieldErr("to", "Pick the fund the money reaches");
  const bad = transferRefusal(t, from.fundType as FundType, to.fundType as FundType, from.id === to.id);
  if (bad) return fieldErr("type", bad);
  if (t.bank && !input.bankReference) return fieldErr("bankReference", `${t.label} needs the bank reference — the withdrawal slip or deposit number`);
  const receiptIds = input.receiptIds ?? [];
  if (from.fundType === "CUSTOMER_CASH" && receiptIds.length) {
    const rows = await db.select().from(erpCustomerCashReceipts).where(inArray(erpCustomerCashReceipts.id, receiptIds));
    if (rows.length !== receiptIds.length || rows.some((r) => r.status !== "posted" || r.fundAccountId !== from.id)) return fieldErr("receipts", "Those receipts are not all held in this fund");
    const busy = await db.select({ code: erpFundTransfers.code, ids: erpFundTransfers.linkedReceiptIds }).from(erpFundTransfers).where(inArray(erpFundTransfers.status, ["initiated", "confirmed"]));
    const taken = busy.find((b) => b.ids.some((x) => receiptIds.includes(x)));
    if (taken) return fieldErr("receipts", `A receipt here is already on ${taken.code} — the same cash is not deposited twice`);
    const sum = rows.reduce((s, r) => s + r.amountPaise, 0);
    if (sum > input.amountPaise) return fieldErr("amount", `The receipts picked come to ${rupees(sum)}; the transfer carries less`);
  }
  let made: { id: string; code: string } | null = null;
  const res = await inTx(async (tx) => {
    await lock(tx, `fund:${from.id}`);
    const held = await balanceIn(tx, from.id);
    const pending = (await tx.execute(sql`select coalesce(sum(amount_paise), 0)::float8 as s from erp_fund_transfers where from_fund_id = ${from.id} and status = 'initiated'`)) as unknown as { s: number }[];
    const short = fundsRefusal(held - Number(pending[0]?.s ?? 0), input.amountPaise!, `${from.name} (less what is already in transit)`);
    if (short && from.fundType !== "BANK") return err(short, "rule_violation");
    const id = erpId("trf");
    const code = await nextCode(tx, "transfer", "TRF");
    await tx.insert(erpFundTransfers).values({
      id,
      code,
      transferType: t.key,
      transferDate: input.date!,
      fromFundId: from.id,
      toFundId: to.id,
      amountPaise: input.amountPaise!,
      purpose: input.purpose ?? t.label,
      requestKey: input.requestKey ?? null,
      bankReference: input.bankReference ?? null,
      linkedReceiptIds: receiptIds,
      status: "initiated",
      reconStatus: t.bank ? "unreconciled" : "not_applicable",
      initiatedById: ctx.actor.id,
    });
    await addEvidence(tx, ctx, "transfer", id, input.evidenceFileId, t.bank ? "Approval document" : "Cash handover acknowledgement");
    await audit(tx, ctx, "erp.petty.fundTransfer.initiate", "erp_fund_transfer", id, null, { code, type: t.key, from: from.name, to: to.name, amount: input.amountPaise });
    made = { id, code };
    return okVoid();
  });
  if (!res.ok) return res as Result<never>;
  const m = made as unknown as { id: string; code: string };
  const receiver = to.custodianUserId ? { users: [to.custodianUserId] } : ("pettyAccounts" as const);
  await notifyPetty(receiver, { title: `Confirm you received ${rupees(input.amountPaise)}`, body: `${m.code}: ${t.label} from ${from.name} to ${to.name}. It counts in ${to.name} only once you confirm.`, view: "credits", open: m.id, exclude: [ctx.actor.id] });
  return ok(m, `${m.code} recorded · in transit until ${to.name} confirms receipt`);
}

/** The receiver's acknowledgement: both legs post, atomically, under one transfer id. */
export async function confirmTransfer(ctx: ErpContext, id: string, input: { fileId?: string | null; note?: string | null } = {}): Promise<Result<unknown>> {
  const cfg = await pettyConfig();
  const [t0] = await db.select().from(erpFundTransfers).where(eq(erpFundTransfers.id, id));
  if (!t0) return err("That transfer no longer exists.", "not_found");
  const roles = pettyRoles(ctx);
  const res = await inTx(async (tx) => {
    await lock(tx, `transfer:${id}`, `fund:${t0.fromFundId}`, `fund:${t0.toFundId}`);
    const [t] = await tx.select().from(erpFundTransfers).where(eq(erpFundTransfers.id, id));
    if (t.status === "confirmed") return okVoid(`${t.code} was already confirmed`);
    if (t.status !== "initiated") return err(`${t.code} is ${t.status} and cannot be confirmed.`, "rule_violation");
    if (t.initiatedById === ctx.actor.id && !ctx.administrator) return err("Whoever receives the money confirms it — not whoever sent it.", "not_permitted");
    const [to] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, t.toFundId));
    const [from] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, t.fromFundId));
    /* A fund with a named custodian is confirmed by them (or accounts); one with none, by anybody but the sender. */
    const receiverOk = to.custodianUserId ? to.custodianUserId === ctx.actor.id || roles.accounts || roles.approve : true;
    if (!receiverOk) return err(`${to.name}'s custodian, or the accounts team, confirms receipt.`, "not_permitted");
    if (from.fundType !== "BANK") {
      const held = await balanceIn(tx, from.id);
      const short = fundsRefusal(held, t.amountPaise, from.name);
      if (short) return err(short, "rule_violation");
    }
    await post(tx, ctx, { fundId: from.id, direction: "debit", amountPaise: t.amountPaise, date: t.transferDate, txnType: "transfer_out", sourceType: "transfer", sourceId: t.id, transferId: t.id, postingKey: `transfer-out:${t.id}`, narration: `${t.code} to ${to.name}` });
    await post(tx, ctx, { fundId: to.id, direction: "credit", amountPaise: t.amountPaise, date: t.transferDate, txnType: "transfer_in", sourceType: "transfer", sourceId: t.id, transferId: t.id, postingKey: `transfer-in:${t.id}`, narration: `${t.code} from ${from.name}` });
    await tx.update(erpFundTransfers).set({ status: "confirmed", receivedById: ctx.actor.id, receivedAt: new Date() }).where(eq(erpFundTransfers.id, id));
    await addEvidence(tx, ctx, "transfer", id, input.fileId, "Cash handover acknowledgement", input.note);
    await queueTally(tx, cfg, "transfer", id, t.code);
    await audit(tx, ctx, "erp.petty.fundTransfer.confirm", "erp_fund_transfer", id, { status: "initiated" }, { status: "confirmed", note: input.note ?? null });
    return okVoid(`${t.code} confirmed · ${rupees(t.amountPaise)} moved from ${from.name} to ${to.name}`);
  });
  return res;
}

export async function cancelTransfer(ctx: ErpContext, id: string, reason: string | null): Promise<Result<unknown>> {
  if (!reason) return fieldErr("reason", "Say why it is cancelled");
  const roles = pettyRoles(ctx);
  return inTx(async (tx) => {
    const [t] = await tx.select().from(erpFundTransfers).where(eq(erpFundTransfers.id, id));
    if (!t) return err("That transfer no longer exists.", "not_found");
    if (t.status !== "initiated") return err("Only a transfer still in transit is cancelled; a confirmed one is reversed.", "rule_violation");
    if (t.initiatedById !== ctx.actor.id && !roles.accounts && !roles.approve) return err("Whoever started it, or the accounts team, cancels it.", "not_permitted");
    await tx.update(erpFundTransfers).set({ status: "cancelled", cancelledById: ctx.actor.id, cancelReason: reason }).where(eq(erpFundTransfers.id, id));
    await audit(tx, ctx, "erp.petty.fundTransfer.cancel", "erp_fund_transfer", id, { status: "initiated" }, { status: "cancelled", reason });
    return okVoid(`${t.code} cancelled — nothing had moved`);
  });
}

export async function reverseTransfer(ctx: ErpContext, id: string, reason: string | null): Promise<Result<unknown>> {
  if (!reason) return fieldErr("reason", "Say why it is reversed");
  const roles = pettyRoles(ctx);
  if (!roles.approve && !roles.owner) return err("An approver reverses a confirmed transfer.", "not_permitted");
  const [t0] = await db.select().from(erpFundTransfers).where(eq(erpFundTransfers.id, id));
  if (!t0) return err("That transfer no longer exists.", "not_found");
  return inTx(async (tx) => {
    await lock(tx, `transfer:${id}`, `fund:${t0.fromFundId}`, `fund:${t0.toFundId}`);
    const [t] = await tx.select().from(erpFundTransfers).where(eq(erpFundTransfers.id, id));
    if (t.status !== "confirmed") return err("Only a confirmed transfer is reversed.", "rule_violation");
    if (t.reconStatus === "matched" || t.reconStatus === "reconciled") return err("It is matched to a bank statement line. Unmatch it on Bank reconciliation first.", "rule_violation");
    const [to] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, t.toFundId));
    if (to.fundType !== "BANK") {
      const held = await balanceIn(tx, to.id);
      if (held < t.amountPaise) return err(`${to.name} holds ${rupees(held)} — less than the ${rupees(t.amountPaise)} to take back. Count it first.`, "rule_violation");
    }
    await reverseSource(tx, ctx, "transfer", id, today(), reason);
    await tx.update(erpFundTransfers).set({ status: "reversed", reversedById: ctx.actor.id, reversedAt: new Date(), reversalReason: reason }).where(eq(erpFundTransfers.id, id));
    await tallyAfterReversal(tx, "transfer", id);
    await audit(tx, ctx, "erp.petty.fundTransfer.reverse", "erp_fund_transfer", id, { status: "confirmed" }, { status: "reversed", reason });
    return okVoid(`${t.code} reversed`);
  });
}

/* ======================================================= customer cash */

export type ReceiptInput = {
  customerId: string | null;
  date: string | null;
  amountPaise: number | null;
  fundId: string | null;
  billIds?: string[];
  ackFileId?: string | null;
  evidenceFileId?: string | null;
  remarks?: string | null;
  requestKey?: string | null;
};

/**
 * Cash a customer handed over (PRD §8C). It raises the customer-cash fund and
 * is queued for accounts to reconcile against the customer's ledger — it is a
 * receipt, never revenue, and depositing it later is a transfer, never a
 * second receipt.
 */
export async function recordReceipt(ctx: ErpContext, input: ReceiptInput): Promise<Result<{ id: string; receiptNo: string }>> {
  if (!input.customerId) return fieldErr("customer", "Pick the customer");
  if (!input.date || input.date > today()) return fieldErr("date", "The date cannot be in the future");
  if (!input.amountPaise || input.amountPaise <= 0) return fieldErr("amount", "The amount must be more than zero");
  if (!input.ackFileId && !input.evidenceFileId) return fieldErr("ack", "Attach the customer's acknowledgement or the receipt you gave them");
  if (input.requestKey) {
    const [prior] = await db.select().from(erpCustomerCashReceipts).where(eq(erpCustomerCashReceipts.requestKey, input.requestKey));
    if (prior) return ok({ id: prior.id, receiptNo: prior.receiptNo }, `Already recorded as ${prior.receiptNo}`);
  }
  const fund = await fundOf(input.fundId);
  if (!fund || fund.status !== "active" || fund.fundType !== "CUSTOMER_CASH") return fieldErr("fund", "Pick the customer-cash fund it is held in");
  const [cust] = await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, input.customerId));
  if (!cust) return fieldErr("customer", "That customer no longer exists");
  const billIds = input.billIds ?? [];
  const allocations: { billId: string; billNo: string; amountPaise: number }[] = [];
  if (billIds.length) {
    const rows = await db.select().from(bills).where(and(inArray(bills.id, billIds), eq(bills.customerId, cust.id)));
    if (rows.length !== billIds.length) return fieldErr("bills", "Those invoices are not all this customer's");
    let left = input.amountPaise;
    for (const b of rows.sort((a, z) => String(a.billDate).localeCompare(String(z.billDate)))) {
      const open = Math.max(0, Number(b.amount) - Number(b.paidAmount ?? 0));
      const take = Math.min(open, left);
      allocations.push({ billId: b.id, billNo: b.billNo, amountPaise: take });
      left -= take;
    }
  }
  const cfg = await pettyConfig();
  let made: { id: string; receiptNo: string } | null = null;
  const res = await inTx(async (tx) => {
    await lock(tx, `fund:${fund.id}`);
    const id = erpId("rcp");
    const receiptNo = await nextCode(tx, "receipt", "RCP");
    await tx.insert(erpCustomerCashReceipts).values({
      id,
      receiptNo,
      customerId: cust.id,
      receiptDate: input.date!,
      amountPaise: input.amountPaise!,
      fundAccountId: fund.id,
      allocations,
      remarks: input.remarks ?? null,
      requestKey: input.requestKey ?? null,
      recordedById: ctx.actor.id,
    });
    await addEvidence(tx, ctx, "receipt", id, input.ackFileId, "Customer receipt acknowledgement");
    await addEvidence(tx, ctx, "receipt", id, input.evidenceFileId, "Cash receipt");
    await post(tx, ctx, { fundId: fund.id, direction: "credit", amountPaise: input.amountPaise!, date: input.date!, txnType: "customer_receipt", sourceType: "receipt", sourceId: id, postingKey: `receipt:${id}`, narration: `${receiptNo} · ${cust.name}` });
    await queueTally(tx, cfg, "receipt", id, receiptNo);
    await audit(tx, ctx, "erp.petty.cashReceipt.record", "erp_customer_cash_receipt", id, null, { receiptNo, customer: cust.name, amount: input.amountPaise, bills: allocations.map((a) => a.billNo) });
    made = { id, receiptNo };
    return okVoid();
  });
  if (!res.ok) return res as Result<never>;
  const m = made as unknown as { id: string; receiptNo: string };
  await notifyPetty("pettyAccounts", { title: `Customer cash to reconcile: ${rupees(input.amountPaise)}`, body: `${m.receiptNo} from ${cust.name}. Reconcile it with the customer's ledger and Tally.`, view: "pettyReceipts", open: m.id, exclude: [ctx.actor.id] });
  return ok(m, `${m.receiptNo} · ${rupees(input.amountPaise)} from ${cust.name} into ${fund.name}`);
}

export async function verifyReceipt(ctx: ErpContext, id: string, note: string | null, crmReference: string | null): Promise<Result<unknown>> {
  if (!pettyRoles(ctx).accounts) return err("The accounts team reconciles customer receipts.", "not_permitted");
  return inTx(async (tx) => {
    const [r] = await tx.select().from(erpCustomerCashReceipts).where(eq(erpCustomerCashReceipts.id, id));
    if (!r) return err("That receipt no longer exists.", "not_found");
    if (r.status !== "posted") return err("A reversed receipt is not verified.", "rule_violation");
    if (r.recordedById === ctx.actor.id && !ctx.administrator) return err("Somebody other than whoever recorded it verifies it.", "not_permitted");
    await tx.update(erpCustomerCashReceipts).set({ verifiedById: ctx.actor.id, verifiedAt: new Date(), verifyNote: note, crmReference }).where(eq(erpCustomerCashReceipts.id, id));
    await audit(tx, ctx, "erp.petty.cashReceipt.verify", "erp_customer_cash_receipt", id, null, { note, crmReference });
    return okVoid(`${r.receiptNo} verified against the customer's ledger`);
  });
}

export async function reverseReceipt(ctx: ErpContext, id: string, reason: string | null): Promise<Result<unknown>> {
  if (!reason) return fieldErr("reason", "Say why it is reversed");
  const roles = pettyRoles(ctx);
  if (!roles.approve && !roles.owner) return err("An approver reverses a posted receipt.", "not_permitted");
  const [r0] = await db.select().from(erpCustomerCashReceipts).where(eq(erpCustomerCashReceipts.id, id));
  if (!r0) return err("That receipt no longer exists.", "not_found");
  return inTx(async (tx) => {
    await lock(tx, `fund:${r0.fundAccountId}`);
    const [r] = await tx.select().from(erpCustomerCashReceipts).where(eq(erpCustomerCashReceipts.id, id));
    if (r.status !== "posted") return err("It is already reversed.", "rule_violation");
    const moving = (await tx.execute(sql`select code from erp_fund_transfers where ${id} = any(linked_receipt_ids) and status in ('initiated', 'confirmed') limit 1`)) as unknown as { code: string }[];
    if (moving[0]) return err(`It was handed over or deposited on ${moving[0].code}. Reverse that first.`, "rule_violation");
    const held = await balanceIn(tx, r.fundAccountId);
    if (held < r.amountPaise) return err(`The fund holds ${rupees(held)} — less than this receipt. Count the cash first.`, "rule_violation");
    await reverseSource(tx, ctx, "receipt", id, today(), reason);
    await tx.update(erpCustomerCashReceipts).set({ status: "reversed", reversedById: ctx.actor.id, reversedAt: new Date(), reversalReason: reason }).where(eq(erpCustomerCashReceipts.id, id));
    await tallyAfterReversal(tx, "receipt", id);
    await audit(tx, ctx, "erp.petty.cashReceipt.reverse", "erp_customer_cash_receipt", id, { status: "posted" }, { status: "reversed", reason });
    return okVoid(`${r.receiptNo} reversed`);
  });
}

/* =========================================================== closings */

/** The figures a closing would carry for this fund on this day, from posted entries only. */
export async function closingFor(fundId: string, day: string) {
  const rows = (await db.execute(sql`
    select direction, amount_paise::float8 as "amountPaise", txn_date::text as "txnDate"
      from erp_fund_ledger where fund_account_id = ${fundId} and txn_date <= ${day}`)) as unknown as { direction: string; amountPaise: number; txnDate: string }[];
  return closingFigures(rows.map((r) => ({ ...r, amountPaise: Number(r.amountPaise) })), day);
}

/**
 * The custodian counts the cash (PRD §12). Expected is worked out here, never
 * typed; a difference is recorded as the variance with its explanation and is
 * NEVER turned into an expense — an approver resolves it, separately.
 */
export async function submitClosing(ctx: ErpContext, input: { fundId: string | null; date: string | null; countedPaise: number | null; explanation: string | null; fileId?: string | null }): Promise<Result<{ id: string; variancePaise: number }>> {
  const fund = await fundOf(input.fundId);
  if (!fund || fund.fundType === "BANK") return fieldErr("fund", "Pick a cash fund — a bank account is reconciled against its statement instead");
  if (!input.date || input.date > today()) return fieldErr("date", "A day cannot be closed before it has happened");
  if (input.countedPaise == null || input.countedPaise < 0) return fieldErr("counted", "Count the cash and enter what is actually there");
  let made: { id: string; variancePaise: number } | null = null;
  const res = await inTx(async (tx) => {
    await lock(tx, `fund:${fund.id}`, `closing:${fund.id}:${input.date}`);
    const [existing] = await tx.select().from(erpCashClosings).where(and(eq(erpCashClosings.fundAccountId, fund.id), eq(erpCashClosings.closingDate, input.date!)));
    if (existing && (existing.status === "submitted" || existing.status === "approved")) return err(`${input.date} is already ${existing.status} for ${fund.name}.`, "rule_violation");
    const rows = (await tx.execute(sql`
      select direction, amount_paise::float8 as "amountPaise", txn_date::text as "txnDate"
        from erp_fund_ledger where fund_account_id = ${fund.id} and txn_date <= ${input.date}`)) as unknown as { direction: string; amountPaise: number; txnDate: string }[];
    const f = closingFigures(rows.map((r) => ({ ...r, amountPaise: Number(r.amountPaise) })), input.date!);
    const variance = varianceOf(input.countedPaise!, f.expectedPaise);
    if (variance !== 0 && !input.explanation) return fieldErr("explanation", `The count is ${rupees(Math.abs(variance))} ${variance < 0 ? "short" : "over"}. Explain the difference`);
    const id = existing?.id ?? erpId("cls");
    const values = {
      openingPaise: f.openingPaise,
      inPaise: f.inPaise,
      outPaise: f.outPaise,
      expectedPaise: f.expectedPaise,
      countedPaise: input.countedPaise!,
      variancePaise: variance,
      explanation: input.explanation,
      status: "submitted",
      submittedById: ctx.actor.id,
      submittedAt: new Date(),
      reviewedById: null,
      reviewedAt: null,
      reviewNote: null,
      resolution: null,
    };
    if (existing) await tx.update(erpCashClosings).set(values).where(eq(erpCashClosings.id, id));
    else await tx.insert(erpCashClosings).values({ id, fundAccountId: fund.id, closingDate: input.date!, ...values });
    await addEvidence(tx, ctx, "closing", id, input.fileId, "Cash closing evidence");
    await audit(tx, ctx, "erp.petty.closing.submit", "erp_cash_closing", id, existing ? { status: existing.status, counted: existing.countedPaise } : null, { expected: f.expectedPaise, counted: input.countedPaise, variance });
    made = { id, variancePaise: variance };
    return okVoid();
  });
  if (!res.ok) return res as Result<never>;
  const m = made as unknown as { id: string; variancePaise: number };
  await notifyPetty("pettyApprove", {
    title: `Cash closing to review: ${fund.name} · ${input.date}`,
    body: m.variancePaise === 0 ? "Counted cash matches the expected balance." : `Variance ${rupees(m.variancePaise)} — ${input.explanation}`,
    view: "pettyClosing",
    open: m.id,
    exclude: [ctx.actor.id],
    kind: m.variancePaise === 0 ? "info" : "warn",
  });
  return ok(m, m.variancePaise === 0 ? "Closing submitted · the count matches" : `Closing submitted · variance ${rupees(m.variancePaise)} flagged for review`);
}

/**
 * Approving a closing with a difference needs a resolution: explained and
 * accepted as it stands, or an adjustment posted SEPARATELY for the variance —
 * the original variance and the resolution both stay on the record.
 */
export async function reviewClosing(ctx: ErpContext, id: string, input: { decision: "approve" | "return"; note: string | null; resolution?: "explained" | "adjusted" | null }): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.approve && !roles.owner) return err("An approver reviews closings.", "not_permitted");
  if (input.decision === "return" && !input.note) return fieldErr("note", "Say what to recount or explain");
  return inTx(async (tx) => {
    await lock(tx, `closing-review:${id}`);
    const [c] = await tx.select().from(erpCashClosings).where(eq(erpCashClosings.id, id));
    if (!c) return err("That closing no longer exists.", "not_found");
    if (c.status !== "submitted") return err("Only a submitted closing is reviewed.", "rule_violation");
    if (c.submittedById === ctx.actor.id) return err("Somebody other than whoever counted the cash reviews the closing.", "not_permitted");
    if (input.decision === "return") {
      await tx.update(erpCashClosings).set({ status: "returned", reviewedById: ctx.actor.id, reviewedAt: new Date(), reviewNote: input.note }).where(eq(erpCashClosings.id, id));
      await audit(tx, ctx, "erp.petty.closing.return", "erp_cash_closing", id, { status: "submitted" }, { status: "returned", note: input.note });
      return okVoid("Closing returned for a recount");
    }
    let adjustmentId: string | null = null;
    let resolution: string | null = null;
    if (c.variancePaise !== 0) {
      if (!input.resolution) return fieldErr("resolution", "Say how the variance is resolved");
      if (!input.note) return fieldErr("note", "Record the resolution in words");
      resolution = input.resolution;
      if (input.resolution === "adjusted") {
        adjustmentId = erpId("fadj");
        const code = await nextCode(tx, "adjustment", "ADJ");
        await tx.insert(erpFundAdjustments).values({
          id: adjustmentId,
          code,
          fundAccountId: c.fundAccountId,
          adjDate: c.closingDate,
          amountPaise: Math.abs(c.variancePaise),
          direction: c.variancePaise > 0 ? "credit" : "debit",
          kind: "variance",
          reason: `Cash ${c.variancePaise > 0 ? "over" : "short"} at closing ${c.closingDate}: ${input.note}`,
          closingId: c.id,
          status: "approved",
          requestedById: c.submittedById,
          decidedById: ctx.actor.id,
          decidedAt: new Date(),
          decisionNote: input.note,
        });
        await post(tx, ctx, { fundId: c.fundAccountId, direction: c.variancePaise > 0 ? "credit" : "debit", amountPaise: Math.abs(c.variancePaise), date: c.closingDate, txnType: "adjustment", sourceType: "adjustment", sourceId: adjustmentId, postingKey: `adjustment:${adjustmentId}`, narration: `${code} · cash variance at closing` });
      }
    }
    /* `post` reopens closings on or after its date — this one included — so set it approved AFTER posting. */
    await tx.update(erpCashClosings).set({ status: "approved", resolution, adjustmentId, reviewedById: ctx.actor.id, reviewedAt: new Date(), reviewNote: input.note, reopenedReason: null }).where(eq(erpCashClosings.id, id));
    await audit(tx, ctx, "erp.petty.closing.approve", "erp_cash_closing", id, { status: "submitted" }, { status: "approved", resolution, adjustmentId, note: input.note });
    return okVoid(c.variancePaise === 0 ? "Closing approved" : `Closing approved · variance ${resolution === "adjusted" ? "adjusted by a separate entry" : "explained and accepted"}`);
  });
}

/* ========================================================= adjustments */

/**
 * A controlled correction to a fund (PRD §2 rule 5): requested with a reason,
 * decided by somebody else, and posted only once approved. Bank charges,
 * corrections and a recovered advance come in this way.
 */
export async function requestFundAdjustment(
  ctx: ErpContext,
  input: { fundId: string | null; date: string | null; amountPaise: number | null; direction: string | null; kind: string | null; reason: string | null; expenseId?: string | null; bankLineId?: string | null },
): Promise<Result<{ id: string; code: string }>> {
  const fund = await fundOf(input.fundId);
  if (!fund) return fieldErr("fund", "Pick the fund");
  if (!input.date || input.date > today()) return fieldErr("date", "The date cannot be in the future");
  if (!input.amountPaise || input.amountPaise <= 0) return fieldErr("amount", "The amount must be more than zero");
  if (input.direction !== "credit" && input.direction !== "debit") return fieldErr("direction", "Say whether it adds to the fund or takes from it");
  if (!input.kind || !["bank_charge", "correction", "advance_recovery", "other"].includes(input.kind)) return fieldErr("kind", "Pick the kind");
  if (!input.reason) return fieldErr("reason", "Say why");
  if (input.kind === "advance_recovery") {
    if (!input.expenseId) return fieldErr("advance", "Pick the advance being recovered");
    if (input.direction !== "credit") return fieldErr("direction", "Recovered money comes INTO the fund");
  }
  let made: { id: string; code: string } | null = null;
  const res = await inTx(async (tx) => {
    if (input.kind === "advance_recovery") {
      await lock(tx, `expense:${input.expenseId}`);
      const [a] = await tx.select().from(erpExpenses).where(eq(erpExpenses.id, input.expenseId!));
      if (!a?.isAdvance) return fieldErr("advance", "That is not an advance");
      const open = await advanceOpen(tx, a.id);
      if (input.amountPaise! > open) return fieldErr("amount", `Only ${rupees(open)} of that advance is still open`);
    }
    const id = erpId("fadj");
    const code = await nextCode(tx, "adjustment", "ADJ");
    await tx.insert(erpFundAdjustments).values({ id, code, fundAccountId: fund.id, adjDate: input.date!, amountPaise: input.amountPaise!, direction: input.direction!, kind: input.kind!, reason: input.reason!, expenseId: input.expenseId ?? null, bankLineId: input.bankLineId ?? null, requestedById: ctx.actor.id });
    await audit(tx, ctx, "erp.petty.fundAdjustment.request", "erp_fund_adjustment", id, null, { code, fund: fund.name, amount: input.amountPaise, direction: input.direction, kind: input.kind, reason: input.reason });
    made = { id, code };
    return okVoid();
  });
  if (!res.ok) return res as Result<never>;
  const m = made as unknown as { id: string; code: string };
  await notifyPetty("pettyApprove", { title: `Fund adjustment to decide: ${m.code}`, body: `${rupees(input.amountPaise)} ${input.direction === "credit" ? "into" : "out of"} ${fund.name} — ${input.reason}`, view: "pettyLedger", exclude: [ctx.actor.id] });
  return ok(m, `${m.code} requested — an approver decides it`);
}

export async function decideFundAdjustment(ctx: ErpContext, id: string, approve: boolean, note: string | null): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  const cfg = await pettyConfig();
  if (!approve && !note) return fieldErr("note", "Say why it is rejected");
  const [a0] = await db.select().from(erpFundAdjustments).where(eq(erpFundAdjustments.id, id));
  if (!a0) return err("That adjustment no longer exists.", "not_found");
  if (!roles.approve && !roles.owner) return err("An approver decides fund adjustments.", "not_permitted");
  if (a0.amountPaise > cfg.approverLimitPaise && !roles.owner) return err("An adjustment above the approver's limit needs the owner.", "not_permitted");
  return inTx(async (tx) => {
    await lock(tx, `fund:${a0.fundAccountId}`);
    const [a] = await tx.select().from(erpFundAdjustments).where(eq(erpFundAdjustments.id, id));
    if (a.status !== "requested") return err("It is already decided.", "rule_violation");
    if (a.requestedById === ctx.actor.id) return err("Somebody other than whoever asked for it decides it.", "not_permitted");
    if (approve && a.direction === "debit") {
      const [f] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, a.fundAccountId));
      if (f.fundType !== "BANK") {
        const held = await balanceIn(tx, a.fundAccountId);
        if (held < a.amountPaise) return err(`${f.name} holds ${rupees(held)} — less than this adjustment.`, "rule_violation");
      }
    }
    await tx.update(erpFundAdjustments).set({ status: approve ? "approved" : "rejected", decidedById: ctx.actor.id, decidedAt: new Date(), decisionNote: note }).where(eq(erpFundAdjustments.id, id));
    if (approve) {
      await post(tx, ctx, { fundId: a.fundAccountId, direction: a.direction as "credit" | "debit", amountPaise: a.amountPaise, date: a.adjDate, txnType: a.kind === "advance_recovery" ? "advance_recovery" : "adjustment", sourceType: "adjustment", sourceId: a.id, postingKey: `adjustment:${a.id}`, narration: `${a.code} · ${a.reason}` });
      await queueTally(tx, cfg, "adjustment", a.id, a.code);
    }
    await audit(tx, ctx, `erp.petty.fundAdjustment.${approve ? "approve" : "reject"}`, "erp_fund_adjustment", id, { status: "requested" }, { status: approve ? "approved" : "rejected", note });
    return okVoid(approve ? `${a.code} approved and posted` : `${a.code} rejected`);
  });
}

/* ===================================================== fund accounts */

export async function saveFundAccount(
  ctx: ErpContext,
  input: { id?: string | null; code: string | null; name: string | null; type: string | null; bankLabel?: string | null; custodianEmployeeId?: string | null; custodianUserId?: string | null; godownId?: string | null; tallyLedger?: string | null; active?: boolean },
): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.owner && !roles.admin) return err("The owner or an ERP administrator sets up fund accounts.", "not_permitted");
  if (!input.code || !/^[A-Z0-9-]{2,12}$/.test(input.code.toUpperCase())) return fieldErr("code", "A short code: letters and numbers, 2 to 12");
  if (!input.name) return fieldErr("name", "Name the account");
  if (!input.type || !(FUND_TYPES as readonly string[]).includes(input.type)) return fieldErr("type", "Pick the type");
  if (input.type !== "BANK" && !input.custodianUserId && !input.custodianEmployeeId) return fieldErr("custodian", "A cash fund has a custodian — the person who holds the cash");
  const code = input.code.toUpperCase();
  const name = input.name;
  const type = input.type;
  return inTx(async (tx) => {
    const now = new Date();
    if (input.id) {
      const [f] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, input.id));
      if (!f) return err("That fund account no longer exists.", "not_found");
      if (f.fundType !== type) {
        const used = (await tx.execute(sql`select 1 from erp_fund_ledger where fund_account_id = ${f.id} limit 1`)) as unknown as unknown[];
        if (used.length) return fieldErr("type", "A fund with posted entries keeps its type");
      }
      await tx
        .update(erpFundAccounts)
        .set({ code, name, fundType: type, bankAccountLabel: input.bankLabel ?? null, custodianEmployeeId: input.custodianEmployeeId ?? null, custodianUserId: input.custodianUserId ?? null, godownId: input.godownId ?? null, tallyLedger: input.tallyLedger ?? null, status: input.active === false ? "inactive" : "active", updatedById: ctx.actor.id, updatedAt: now })
        .where(eq(erpFundAccounts.id, f.id));
      await audit(tx, ctx, "erp.petty.fund.edit", "erp_fund_account", f.id, { name: f.name, custodian: f.custodianUserId, status: f.status }, { name: input.name, custodian: input.custodianUserId, status: input.active === false ? "inactive" : "active" });
      return okVoid(`${input.name} saved`);
    }
    const id = erpId("fund");
    await tx.insert(erpFundAccounts).values({ id, code, name, fundType: type, bankAccountLabel: input.bankLabel ?? null, custodianEmployeeId: input.custodianEmployeeId ?? null, custodianUserId: input.custodianUserId ?? null, godownId: input.godownId ?? null, tallyLedger: input.tallyLedger ?? null, createdById: ctx.actor.id, updatedById: ctx.actor.id });
    await audit(tx, ctx, "erp.petty.fund.create", "erp_fund_account", id, null, { code: input.code, name: input.name, type: input.type });
    return okVoid(`${input.name} added — set its opening balance next`);
  });
}

/**
 * An opening balance is PROPOSED by one person and VERIFIED by another
 * (PRD §5): only the verification posts it, once, and afterwards it can be
 * corrected only by an adjustment.
 */
export async function proposeOpening(ctx: ErpContext, fundId: string, input: { amountPaise: number | null; date: string | null; note: string | null }): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.accounts && !roles.owner) return err("The accounts team or the owner proposes an opening balance.", "not_permitted");
  if (input.amountPaise == null || input.amountPaise < 0) return fieldErr("amount", "The opening balance cannot be negative");
  if (!input.date || input.date > today()) return fieldErr("date", "The opening date cannot be in the future");
  if (!input.note) return fieldErr("note", "Say what it is based on — the bank statement, a cash count");
  return inTx(async (tx) => {
    const [f] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, fundId));
    if (!f) return err("That fund account no longer exists.", "not_found");
    if (f.openingStatus === "verified") return err("Its opening balance is verified and posted. A correction is a fund adjustment.", "rule_violation");
    const earlier = (await tx.execute(sql`select min(txn_date)::text as d from erp_fund_ledger where fund_account_id = ${fundId}`)) as unknown as { d: string | null }[];
    if (earlier[0]?.d && earlier[0].d < input.date!) return fieldErr("date", `Entries are already posted from ${earlier[0].d}; the opening must be on or before that day`);
    await tx.update(erpFundAccounts).set({ openingBalancePaise: input.amountPaise, openingBalanceDate: input.date, openingNote: input.note, openingStatus: "proposed", openingProposedById: ctx.actor.id, openingProposedAt: new Date(), updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpFundAccounts.id, fundId));
    await audit(tx, ctx, "erp.petty.opening.propose", "erp_fund_account", fundId, { opening: f.openingBalancePaise, status: f.openingStatus }, { opening: input.amountPaise, date: input.date, note: input.note });
    return okVoid(`Opening balance ${rupees(input.amountPaise!)} proposed — somebody else verifies it`);
  });
}

export async function verifyOpening(ctx: ErpContext, fundId: string): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.owner && !roles.approve) return err("An approver or the owner verifies an opening balance.", "not_permitted");
  return inTx(async (tx) => {
    await lock(tx, `fund:${fundId}`);
    const [f] = await tx.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, fundId));
    if (!f) return err("That fund account no longer exists.", "not_found");
    if (f.openingStatus !== "proposed") return err(f.openingStatus === "verified" ? "It is already verified." : "Nobody has proposed an opening balance yet.", "rule_violation");
    if (f.openingProposedById === ctx.actor.id) return err("Somebody other than whoever proposed it verifies it.", "not_permitted");
    await tx.update(erpFundAccounts).set({ openingStatus: "verified", openingVerifiedById: ctx.actor.id, openingVerifiedAt: new Date(), updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpFundAccounts.id, fundId));
    if ((f.openingBalancePaise ?? 0) > 0) {
      await post(tx, ctx, { fundId, direction: "credit", amountPaise: f.openingBalancePaise!, date: f.openingBalanceDate!, txnType: "opening", sourceType: "fund", sourceId: fundId, postingKey: `opening:${fundId}`, narration: `Opening balance · ${f.openingNote ?? ""}` });
    }
    await audit(tx, ctx, "erp.petty.opening.verify", "erp_fund_account", fundId, { status: "proposed" }, { status: "verified", opening: f.openingBalancePaise });
    return okVoid(`${f.name}: opening balance ${rupees(f.openingBalancePaise ?? 0)} verified and posted`);
  });
}
