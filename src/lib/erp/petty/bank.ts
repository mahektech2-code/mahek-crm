import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpBankImports, erpBankLines, erpBankMatches, erpExpensePayments, erpFundAccounts, erpFundAdjustments, erpFundTransfers } from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpId } from "../server";
import { inTx, type Tx } from "../screens/common";
import { lineKey, matchLine, parseStatement, rupees, splitRefusal, type MatchCandidate } from "../engines/petty-cash";
import { audit, lock, pettyConfig, pettyRoles } from "./core";
import { initiateTransfer, requestFundAdjustment } from "./funds";

/* ---------------------------------------------------------------------------
 * The bank statement, read against what MahekOne already holds (PRD §11).
 *
 * MahekOne had no bank statement module of its own, so this is it — one for
 * the whole app, keyed by fund account, not a second one for production.
 * A statement line CONFIRMS a recorded payment, withdrawal or deposit; it
 * never creates an expense or a payment of its own. A line nothing explains
 * is an exception for a person, and re-importing the same statement adds
 * nothing.
 * ------------------------------------------------------------------------- */

const requireAccounts = (ctx: ErpContext) => (pettyRoles(ctx).accounts ? null : err("The accounts team reconciles the bank statement.", "not_permitted"));

export type ImportResult = { importId: string; total: number; added: number; duplicates: number; repeatOf: string | null; skipped: { row: number; reason: string }[]; matched: number; suggested: number };

export async function importStatement(ctx: ErpContext, input: { fundId: string | null; csv: string | null; fileName?: string | null }): Promise<Result<ImportResult>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  if (!input.csv) return fieldErr("file", "Choose the statement CSV");
  const [fund] = input.fundId ? await db.select().from(erpFundAccounts).where(eq(erpFundAccounts.id, input.fundId)) : [];
  if (!fund || fund.fundType !== "BANK") return fieldErr("fund", "Pick the bank account the statement is for");
  const parsed = parseStatement(input.csv);
  if (!parsed.lines.length) return fieldErr("file", parsed.skipped[0]?.reason ?? "No transactions could be read from that file");
  const fileHash = createHash("sha256").update(input.csv.replace(/\r\n/g, "\n").trim()).digest("hex");
  let out: ImportResult | null = null;
  const res = await inTx(async (tx) => {
    await lock(tx, `bank:${fund.id}`);
    const [repeat] = await tx.select().from(erpBankImports).where(and(eq(erpBankImports.fundAccountId, fund.id), eq(erpBankImports.fileHash, fileHash)));
    const importId = erpId("bimp");
    const dates = parsed.lines.map((l) => l.date).sort();
    const last = parsed.lines[parsed.lines.length - 1];
    await tx.insert(erpBankImports).values({
      id: importId,
      fundAccountId: fund.id,
      fileName: input.fileName ?? null,
      fileHash,
      linesTotal: parsed.lines.length,
      linesNew: 0,
      linesDuplicate: 0,
      duplicateOfImportId: repeat?.id ?? null,
      statementFrom: dates[0],
      statementTo: dates[dates.length - 1],
      closingBalancePaise: last.balancePaise,
      importedById: ctx.actor.id,
    });
    let added = 0;
    for (const l of parsed.lines) {
      const hash = createHash("sha256").update(lineKey(fund.id, l)).digest("hex");
      const ins = await tx
        .insert(erpBankLines)
        .values({ id: erpId("bln"), importId, fundAccountId: fund.id, lineHash: hash, statementTxnId: l.txnId, txnDate: l.date, valueDate: l.valueDate, narration: l.narration || null, reference: l.reference, debitPaise: l.debitPaise, creditPaise: l.creditPaise, balancePaise: l.balancePaise })
        .onConflictDoNothing()
        .returning({ id: erpBankLines.id });
      added += ins.length;
    }
    const duplicates = parsed.lines.length - added;
    await tx.update(erpBankImports).set({ linesNew: added, linesDuplicate: duplicates }).where(eq(erpBankImports.id, importId));
    const m = await autoMatchIn(tx, ctx, fund.id);
    await audit(tx, ctx, "erp.petty.bank.import", "erp_bank_import", importId, null, { fund: fund.name, total: parsed.lines.length, added, duplicates, repeatOf: repeat?.id ?? null, matched: m.matched, suggested: m.suggested });
    out = { importId, total: parsed.lines.length, added, duplicates, repeatOf: repeat?.id ?? null, skipped: parsed.skipped, matched: m.matched, suggested: m.suggested };
    return okVoid();
  });
  if (!res.ok) return res as Result<never>;
  const o = out as unknown as ImportResult;
  const msg = o.repeatOf && o.added === 0 ? `This statement was imported before — all ${o.total} lines are already here; nothing was added` : `${o.added} new line${o.added === 1 ? "" : "s"} · ${o.duplicates} already imported · ${o.matched} matched by reference · ${o.suggested} suggested`;
  return ok(o, msg);
}

/** Every recorded movement through this bank fund that no statement line has claimed yet. */
async function candidates(tx: Tx, fundId: string): Promise<MatchCandidate[]> {
  const rows = (await tx.execute(sql`
    select 'payment' as type, p.id, 'debit' as direction, p.amount_paise::float8 as amount, p.payment_date::text as date, p.reference, coalesce(p.payee, e.vendor_name) as words
      from erp_expense_payments p join erp_expenses e on e.id = p.expense_id
     where p.fund_account_id = ${fundId} and p.status = 'confirmed'
       and not exists (select 1 from erp_bank_matches m where m.record_type = 'payment' and m.record_id = p.id)
    union all
    select 'transfer', t.id, case when t.from_fund_id = ${fundId} then 'debit' else 'credit' end, t.amount_paise::float8, t.transfer_date::text, t.bank_reference, t.purpose
      from erp_fund_transfers t
     where (t.from_fund_id = ${fundId} or t.to_fund_id = ${fundId}) and t.status in ('initiated', 'confirmed')
       and not exists (select 1 from erp_bank_matches m where m.record_type = 'transfer' and m.record_id = t.id)
    union all
    select 'adjustment', a.id, a.direction, a.amount_paise::float8, a.adj_date::text, a.code, a.reason
      from erp_fund_adjustments a
     where a.fund_account_id = ${fundId} and a.status in ('requested', 'approved')
       and not exists (select 1 from erp_bank_matches m where m.record_type = 'adjustment' and m.record_id = a.id)`)) as unknown as {
    type: MatchCandidate["type"];
    id: string;
    direction: "debit" | "credit";
    amount: number;
    date: string;
    reference: string | null;
    words: string | null;
  }[];
  return rows.map((r) => ({ type: r.type, id: r.id, direction: r.direction, amountPaise: Number(r.amount), date: r.date, reference: r.reference, words: r.words }));
}

async function setRecordRecon(tx: Tx, type: string, id: string, status: "unreconciled" | "matched" | "reconciled") {
  if (type === "payment") await tx.update(erpExpensePayments).set({ reconStatus: status }).where(eq(erpExpensePayments.id, id));
  if (type === "transfer") await tx.update(erpFundTransfers).set({ reconStatus: status }).where(eq(erpFundTransfers.id, id));
}

/**
 * Runs the matching rules over every open line. Only an exact reference
 * settles a line on its own; an equal amount is a suggestion a person
 * confirms, and two equal amounts are an exception (PRD §11: amount, date and
 * narration alone never settle an ambiguous line).
 */
async function autoMatchIn(tx: Tx, ctx: ErpContext, fundId: string): Promise<{ matched: number; suggested: number }> {
  const cfg = await pettyConfig();
  const open = await tx.select().from(erpBankLines).where(and(eq(erpBankLines.fundAccountId, fundId), inArray(erpBankLines.reconStatus, ["unmatched", "suggested"])));
  let pool = await candidates(tx, fundId);
  let matched = 0;
  let suggested = 0;
  for (const l of open.sort((a, b) => a.txnDate.localeCompare(b.txnDate))) {
    const hasMatch = (await tx.select({ id: erpBankMatches.id }).from(erpBankMatches).where(eq(erpBankMatches.bankLineId, l.id))).length;
    if (hasMatch) continue;
    const v = matchLine({ date: l.txnDate, valueDate: l.valueDate, narration: l.narration ?? "", reference: l.reference, debitPaise: l.debitPaise, creditPaise: l.creditPaise, balancePaise: l.balancePaise, txnId: l.statementTxnId }, pool, cfg.matchWindowDays);
    if (v.kind === "auto" || v.kind === "suggest") {
      const c = v.candidates[0];
      await tx.insert(erpBankMatches).values({ id: erpId("bmt"), bankLineId: l.id, recordType: c.type, recordId: c.id, amountPaise: c.amountPaise, rule: v.rule, confirmed: false, matchedById: ctx.actor.id });
      await tx.update(erpBankLines).set({ reconStatus: v.kind === "auto" ? "matched" : "suggested", exceptionReason: null }).where(eq(erpBankLines.id, l.id));
      if (v.kind === "auto") await setRecordRecon(tx, c.type, c.id, "matched");
      pool = pool.filter((x) => !(x.type === c.type && x.id === c.id));
      if (v.kind === "auto") matched++;
      else suggested++;
    } else if (v.kind === "ambiguous") {
      await tx.update(erpBankLines).set({ reconStatus: "exception", exceptionReason: `Ambiguous: ${v.candidates.length} recorded movements fit — pick the right one` }).where(eq(erpBankLines.id, l.id));
    }
  }
  return { matched, suggested };
}

export async function rematch(ctx: ErpContext, fundId: string | null): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  const funds = fundId ? [fundId] : (await db.select({ id: erpFundAccounts.id }).from(erpFundAccounts).where(eq(erpFundAccounts.fundType, "BANK"))).map((f) => f.id);
  let m = { matched: 0, suggested: 0 };
  const res = await inTx(async (tx) => {
    for (const f of funds) {
      await lock(tx, `bank:${f}`);
      const r = await autoMatchIn(tx, ctx, f);
      m = { matched: m.matched + r.matched, suggested: m.suggested + r.suggested };
    }
    return okVoid();
  });
  if (!res.ok) return res;
  return okVoid(`${m.matched} matched by reference · ${m.suggested} suggested for confirmation`);
}

/** A person confirms what a line was matched to: the line and its records read reconciled. */
export async function confirmLines(ctx: ErpContext, lineIds: string[]): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  let n = 0;
  const res = await inTx(async (tx) => {
    for (const id of lineIds) {
      const [l] = await tx.select().from(erpBankLines).where(eq(erpBankLines.id, id));
      if (!l || !["matched", "suggested"].includes(l.reconStatus)) continue;
      const ms = await tx.select().from(erpBankMatches).where(eq(erpBankMatches.bankLineId, id));
      if (!ms.length) continue;
      await tx.update(erpBankMatches).set({ confirmed: true }).where(eq(erpBankMatches.bankLineId, id));
      for (const m of ms) await setRecordRecon(tx, m.recordType, m.recordId, "reconciled");
      await tx.update(erpBankLines).set({ reconStatus: "reconciled", reconciledById: ctx.actor.id, reconciledAt: new Date(), exceptionReason: null }).where(eq(erpBankLines.id, id));
      await audit(tx, ctx, "erp.petty.bank.reconcile", "erp_bank_line", id, { status: l.reconStatus }, { status: "reconciled", records: ms.map((m) => `${m.recordType}:${m.recordId}`) });
      n++;
    }
    return okVoid();
  });
  if (!res.ok) return res;
  if (!n) return err("Nothing selected was matched and waiting to be reconciled.", "rule_violation");
  return okVoid(`${n} line${n === 1 ? "" : "s"} reconciled`);
}

/** The candidates a person may pick from for one line, labelled. */
export async function lineCandidates(lineId: string): Promise<{ key: string; label: string; amountPaise: number }[]> {
  const [l] = await db.select().from(erpBankLines).where(eq(erpBankLines.id, lineId));
  if (!l) return [];
  const pool = await db.transaction(async (tx) => candidates(tx as unknown as Tx, l.fundAccountId));
  const dir = l.debitPaise > 0 ? "debit" : "credit";
  const codes = await codesFor(pool);
  return pool
    .filter((c) => c.direction === dir)
    .sort((a, b) => Math.abs(a.amountPaise - (l.debitPaise || l.creditPaise)) - Math.abs(b.amountPaise - (l.debitPaise || l.creditPaise)))
    .slice(0, 40)
    .map((c) => ({ key: `${c.type}:${c.id}`, label: `${codes.get(c.id) ?? c.type} · ${rupees(c.amountPaise)} · ${c.date}${c.reference ? ` · ${c.reference}` : ""}${c.words ? ` · ${c.words}` : ""}`, amountPaise: c.amountPaise }));
}

async function codesFor(pool: MatchCandidate[]): Promise<Map<string, string>> {
  const ids = (t: string) => pool.filter((c) => c.type === t).map((c) => c.id);
  const out = new Map<string, string>();
  const [p, t, a] = await Promise.all([
    ids("payment").length ? db.select({ id: erpExpensePayments.id, code: erpExpensePayments.code }).from(erpExpensePayments).where(inArray(erpExpensePayments.id, ids("payment"))) : [],
    ids("transfer").length ? db.select({ id: erpFundTransfers.id, code: erpFundTransfers.code }).from(erpFundTransfers).where(inArray(erpFundTransfers.id, ids("transfer"))) : [],
    ids("adjustment").length ? db.select({ id: erpFundAdjustments.id, code: erpFundAdjustments.code }).from(erpFundAdjustments).where(inArray(erpFundAdjustments.id, ids("adjustment"))) : [],
  ]);
  for (const r of [...p, ...t, ...a]) out.set(r.id, r.code);
  return out;
}

/**
 * An authorised accounts user matches by hand — one record, or several where
 * one bank transaction paid several bills (a split). The total can never
 * exceed the line, and a record already claimed by another line is refused.
 */
export async function matchManually(ctx: ErpContext, lineId: string, keys: string[]): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  if (!keys.length) return fieldErr("records", "Pick what this line is");
  return inTx(async (tx) => {
    const [l] = await tx.select().from(erpBankLines).where(eq(erpBankLines.id, lineId));
    if (!l) return err("That line no longer exists.", "not_found");
    await lock(tx, `bank:${l.fundAccountId}`);
    if (l.reconStatus === "reconciled") return err("It is already reconciled. Unmatch it first.", "rule_violation");
    const pool = await candidates(tx, l.fundAccountId);
    const dir = l.debitPaise > 0 ? "debit" : "credit";
    const picked = keys.map((k) => pool.find((c) => `${c.type}:${c.id}` === k && c.direction === dir));
    if (picked.some((p) => !p)) return fieldErr("records", "Something picked is already matched elsewhere, or runs the other way");
    const existing = await tx.select().from(erpBankMatches).where(eq(erpBankMatches.bankLineId, lineId));
    const keep = existing.filter((m) => m.rule !== "amount_date" && m.rule !== "narration");
    for (const m of existing.filter((x) => !keep.includes(x))) await tx.delete(erpBankMatches).where(eq(erpBankMatches.id, m.id));
    const already = keep.reduce((s, m) => s + m.amountPaise, 0);
    const adding = picked.reduce((s, p) => s + p!.amountPaise, 0);
    const amount = l.debitPaise || l.creditPaise;
    const over = splitRefusal(amount, already, adding);
    if (over) return fieldErr("records", over);
    for (const p of picked) {
      await tx.insert(erpBankMatches).values({ id: erpId("bmt"), bankLineId: lineId, recordType: p!.type, recordId: p!.id, amountPaise: p!.amountPaise, rule: "manual", confirmed: true, matchedById: ctx.actor.id });
      await setRecordRecon(tx, p!.type, p!.id, "reconciled");
    }
    const full = already + adding === amount;
    await tx.update(erpBankLines).set({ reconStatus: full ? "reconciled" : "matched", reconciledById: full ? ctx.actor.id : null, reconciledAt: full ? new Date() : null, exceptionReason: full ? null : `Split: ${rupees(amount - already - adding)} of the line still unexplained` }).where(eq(erpBankLines.id, lineId));
    await audit(tx, ctx, "erp.petty.bank.matchManual", "erp_bank_line", lineId, null, { records: keys, full });
    return okVoid(full ? "Matched and reconciled" : `Matched · ${rupees(amount - already - adding)} of the line still to explain`);
  });
}

export async function unmatchLine(ctx: ErpContext, lineId: string, reason: string | null): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  if (!reason) return fieldErr("reason", "Say why");
  return inTx(async (tx) => {
    const [l] = await tx.select().from(erpBankLines).where(eq(erpBankLines.id, lineId));
    if (!l) return err("That line no longer exists.", "not_found");
    const ms = await tx.select().from(erpBankMatches).where(eq(erpBankMatches.bankLineId, lineId));
    for (const m of ms) {
      await setRecordRecon(tx, m.recordType, m.recordId, "unreconciled");
      await tx.delete(erpBankMatches).where(eq(erpBankMatches.id, m.id));
    }
    await tx.update(erpBankLines).set({ reconStatus: "correction", exceptionReason: reason, reconciledById: null, reconciledAt: null }).where(eq(erpBankLines.id, lineId));
    await audit(tx, ctx, "erp.petty.bank.unmatch", "erp_bank_line", lineId, { status: l.reconStatus, records: ms.map((m) => `${m.recordType}:${m.recordId}`) }, { status: "correction", reason });
    return okVoid("Unmatched · marked correction required");
  });
}

export async function markException(ctx: ErpContext, lineId: string, reason: string | null): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  if (!reason) return fieldErr("reason", "Say what is wrong with it");
  const [l] = await db.select().from(erpBankLines).where(eq(erpBankLines.id, lineId));
  if (!l) return err("That line no longer exists.", "not_found");
  if (l.reconStatus === "reconciled") return err("A reconciled line is unmatched first.", "rule_violation");
  await db.update(erpBankLines).set({ reconStatus: "exception", exceptionReason: reason }).where(eq(erpBankLines.id, lineId));
  const { erpAudit } = await import("../server");
  await erpAudit(ctx, "erp.petty.bank.exception", "erp_bank_line", lineId, { status: l.reconStatus }, { status: "exception", reason });
  return okVoid("Marked as an exception");
}

/**
 * A withdrawal that shows on the statement before anybody recorded it: the
 * transfer to production cash is raised FROM the line, already matched, and
 * still waits for the custodian to confirm the cash in hand.
 */
export async function lineToWithdrawal(ctx: ErpContext, lineId: string, input: { toFundId: string | null; purpose: string | null }): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  const [l] = await db.select().from(erpBankLines).where(eq(erpBankLines.id, lineId));
  if (!l) return err("That line no longer exists.", "not_found");
  if (!l.debitPaise) return err("Only money out of the bank is a withdrawal.", "rule_violation");
  if ((await db.select().from(erpBankMatches).where(eq(erpBankMatches.bankLineId, lineId))).length) return err("This line is already matched.", "rule_violation");
  const t = await initiateTransfer(ctx, { type: "withdrawal", date: l.txnDate, fromFundId: l.fundAccountId, toFundId: input.toFundId, amountPaise: l.debitPaise, purpose: input.purpose ?? "Cash withdrawal", bankReference: l.reference ?? l.statementTxnId ?? `Statement ${l.txnDate}`, requestKey: `bankline:${lineId}` });
  if (!t.ok) return t;
  await inTx(async (tx) => {
    await tx.insert(erpBankMatches).values({ id: erpId("bmt"), bankLineId: lineId, recordType: "transfer", recordId: t.data.id, amountPaise: l.debitPaise, rule: "manual", confirmed: true, matchedById: ctx.actor.id }).onConflictDoNothing();
    await setRecordRecon(tx, "transfer", t.data.id, "reconciled");
    await tx.update(erpBankLines).set({ reconStatus: "reconciled", reconciledById: ctx.actor.id, reconciledAt: new Date(), exceptionReason: null }).where(eq(erpBankLines.id, lineId));
    await audit(tx, ctx, "erp.petty.bank.toWithdrawal", "erp_bank_line", lineId, null, { transfer: t.data.code });
    return okVoid();
  });
  return okVoid(`${t.data.code} raised from the statement · the cash counts once the custodian confirms receipt`);
}

/** A bank charge or interest the statement shows: an adjustment request, matched to the line, posted once approved. */
export async function lineToAdjustment(ctx: ErpContext, lineId: string, reason: string | null): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  if (!reason) return fieldErr("reason", "Say what the bank charged for, or paid");
  const [l] = await db.select().from(erpBankLines).where(eq(erpBankLines.id, lineId));
  if (!l) return err("That line no longer exists.", "not_found");
  if ((await db.select().from(erpBankMatches).where(eq(erpBankMatches.bankLineId, lineId))).length) return err("This line is already matched.", "rule_violation");
  const a = await requestFundAdjustment(ctx, { fundId: l.fundAccountId, date: l.txnDate, amountPaise: l.debitPaise || l.creditPaise, direction: l.debitPaise ? "debit" : "credit", kind: l.debitPaise ? "bank_charge" : "other", reason, bankLineId: lineId });
  if (!a.ok) return a;
  await db.insert(erpBankMatches).values({ id: erpId("bmt"), bankLineId: lineId, recordType: "adjustment", recordId: a.data.id, amountPaise: l.debitPaise || l.creditPaise, rule: "manual", confirmed: false, matchedById: ctx.actor.id });
  await db.update(erpBankLines).set({ reconStatus: "matched", exceptionReason: `${a.data.code} awaiting approval` }).where(eq(erpBankLines.id, lineId));
  return okVoid(`${a.data.code} requested and matched · reconcile the line once it is approved`);
}

/** The statement's last balance against the book's, for the same account and cut-off. */
export async function bookVsStatement(fundId: string): Promise<{ statementPaise: number | null; asOf: string | null; bookPaise: number; differencePaise: number | null; lastImport: Date | null }> {
  const [last] = (await db.execute(sql`
    select l.balance_paise::float8 as bal, l.txn_date::text as d
      from erp_bank_lines l join erp_bank_imports i on i.id = l.import_id
     where l.fund_account_id = ${fundId} and l.balance_paise is not null
     order by l.txn_date desc, i.imported_at desc, l.created_at desc limit 1`)) as unknown as { bal: number; d: string }[];
  const [imp] = await db.select({ at: erpBankImports.importedAt }).from(erpBankImports).where(eq(erpBankImports.fundAccountId, fundId)).orderBy(sql`${erpBankImports.importedAt} desc`).limit(1);
  const asOf = last?.d ?? null;
  const [book] = (await db.execute(sql`
    select coalesce(sum(case when direction = 'credit' then amount_paise else -amount_paise end), 0)::float8 as bal
      from erp_fund_ledger where fund_account_id = ${fundId} ${asOf ? sql`and txn_date <= ${asOf}` : sql``}`)) as unknown as { bal: number }[];
  const bookPaise = Number(book?.bal ?? 0);
  const statementPaise = last ? Number(last.bal) : null;
  return { statementPaise, asOf, bookPaise, differencePaise: statementPaise == null ? null : statementPaise - bookPaise, lastImport: imp?.at ?? null };
}
