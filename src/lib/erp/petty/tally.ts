import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpTallySync } from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpAudit } from "../server";
import { pettyConfig, pettyRoles } from "./core";

/* ---------------------------------------------------------------------------
 * TallyPrime (PRD §17). Tally stays the authority for the books; MahekOne
 * keeps the operational record and a queue of what should reach Tally, with a
 * status of its own — a completed payment is not a posted voucher.
 *
 * Every voucher carries the record's stable MahekOne id as Tally's REMOTEID,
 * so a retry after a timeout ALTERS the voucher Tally already has rather than
 * creating a second one. With no Tally reachable (or the mode at "export"),
 * accounts post it by hand from the voucher written out here and record the
 * number; nothing is ever lost because Tally was down.
 * ------------------------------------------------------------------------- */

type Voucher = { type: string; date: string; narration: string; lines: { ledger: string; amountPaise: number; debit: boolean }[] };

/** What a record should become in Tally, read fresh from the record. Null where it no longer needs one. */
async function voucherFor(recordType: string, recordId: string): Promise<Voucher | null> {
  const q = async <T>(s: ReturnType<typeof sql>) => ((await db.execute(s)) as unknown as T[])[0];
  if (recordType === "payment") {
    const r = await q<{ code: string; date: string; amount: number; fund: string; fundLedger: string | null; ledger: string | null; category: string | null; vendor: string | null; expense: string; status: string }>(sql`
      select p.code, p.payment_date::text as date, p.amount_paise::float8 as amount, f.name as fund, f.tally_ledger as "fundLedger",
             c.tally_ledger as ledger, c.name as category, coalesce(p.payee, e.vendor_name) as vendor, e.code as expense, p.status
        from erp_expense_payments p join erp_expenses e on e.id = p.expense_id join erp_fund_accounts f on f.id = p.fund_account_id
        left join erp_expense_categories c on c.id = e.category_id where p.id = ${recordId}`);
    if (!r || r.status !== "confirmed") return null;
    return {
      type: "Payment",
      date: r.date,
      narration: `${r.code} against ${r.expense}${r.vendor ? ` to ${r.vendor}` : ""}`,
      lines: [
        { ledger: r.vendor || r.ledger || r.category || "Production Expenses", amountPaise: r.amount, debit: true },
        { ledger: r.fundLedger || r.fund, amountPaise: r.amount, debit: false },
      ],
    };
  }
  if (recordType === "expense") {
    const r = await q<{ code: string; date: string; amount: number; ledger: string | null; category: string | null; vendor: string | null; particular: string | null; status: string }>(sql`
      select e.code, coalesce(e.bill_date, e.expense_date)::text as date, e.amount_paise::float8 as amount, c.tally_ledger as ledger, c.name as category,
             e.vendor_name as vendor, e.particular, e.approval_status as status
        from erp_expenses e left join erp_expense_categories c on c.id = e.category_id where e.id = ${recordId}`);
    if (!r || r.status !== "approved") return null;
    return {
      type: "Journal",
      date: r.date,
      narration: `${r.code} ${r.particular ?? ""}`.trim(),
      lines: [
        { ledger: r.ledger || r.category || "Production Expenses", amountPaise: r.amount, debit: true },
        { ledger: r.vendor || "Sundry Creditors (petty cash)", amountPaise: r.amount, debit: false },
      ],
    };
  }
  if (recordType === "transfer") {
    const r = await q<{ code: string; date: string; amount: number; from: string; fromL: string | null; to: string; toL: string | null; status: string }>(sql`
      select t.code, t.transfer_date::text as date, t.amount_paise::float8 as amount, a.name as from, a.tally_ledger as "fromL", b.name as to, b.tally_ledger as "toL", t.status
        from erp_fund_transfers t join erp_fund_accounts a on a.id = t.from_fund_id join erp_fund_accounts b on b.id = t.to_fund_id where t.id = ${recordId}`);
    if (!r || r.status !== "confirmed") return null;
    return { type: "Contra", date: r.date, narration: `${r.code}: ${r.from} to ${r.to}`, lines: [{ ledger: r.toL || r.to, amountPaise: r.amount, debit: true }, { ledger: r.fromL || r.from, amountPaise: r.amount, debit: false }] };
  }
  if (recordType === "receipt") {
    const r = await q<{ no: string; date: string; amount: number; customer: string; fund: string; fundL: string | null; status: string }>(sql`
      select r.receipt_no as no, r.receipt_date::text as date, r.amount_paise::float8 as amount, c.name as customer, f.name as fund, f.tally_ledger as "fundL", r.status
        from erp_customer_cash_receipts r join customers c on c.id = r.customer_id join erp_fund_accounts f on f.id = r.fund_account_id where r.id = ${recordId}`);
    if (!r || r.status !== "posted") return null;
    return { type: "Receipt", date: r.date, narration: `${r.no}: cash from ${r.customer}`, lines: [{ ledger: r.fundL || r.fund, amountPaise: r.amount, debit: true }, { ledger: r.customer, amountPaise: r.amount, debit: false }] };
  }
  if (recordType === "adjustment") {
    const r = await q<{ code: string; date: string; amount: number; dir: string; fund: string; fundL: string | null; kind: string; status: string }>(sql`
      select a.code, a.adj_date::text as date, a.amount_paise::float8 as amount, a.direction as dir, f.name as fund, f.tally_ledger as "fundL", a.kind, a.status
        from erp_fund_adjustments a join erp_fund_accounts f on f.id = a.fund_account_id where a.id = ${recordId}`);
    if (!r || r.status !== "approved") return null;
    const other = r.kind === "bank_charge" ? "Bank Charges" : "Cash Short / Excess";
    return { type: "Journal", date: r.date, narration: `${r.code}: ${r.kind.replace("_", " ")}`, lines: [{ ledger: r.fundL || r.fund, amountPaise: r.amount, debit: r.dir === "credit" }, { ledger: other, amountPaise: r.amount, debit: r.dir !== "credit" }] };
  }
  return null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (p: number, debit: boolean) => ((debit ? -1 : 1) * (p / 100)).toFixed(2);

/** The import envelope Tally's XML interface takes; REMOTEID makes a re-post an alteration. */
export function voucherXml(v: Voucher, remoteId: string, company: string): string {
  const d = v.date.replace(/-/g, "");
  return [
    "<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>",
    `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>${company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : ""}</REQUESTDESC>`,
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(v.type)}" ACTION="Create">`,
    `<DATE>${d}</DATE><VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME><NARRATION>${esc(v.narration)}</NARRATION>`,
    ...v.lines.map((l) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${l.debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amt(l.amountPaise, l.debit)}</AMOUNT></ALLLEDGERENTRIES.LIST>`),
    "</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>",
  ].join("\n");
}

const requireAccounts = (ctx: ErpContext) => (pettyRoles(ctx).accounts ? null : err("The accounts team keeps the Tally queue.", "not_permitted"));

/** The voucher written out, for posting by hand. Writes nothing. */
export async function exportVoucher(ctx: ErpContext, syncId: string): Promise<Result<{ xml: string; remoteId: string }>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  const cfg = await pettyConfig();
  const [row] = await db.select().from(erpTallySync).where(eq(erpTallySync.id, syncId));
  if (!row) return err("That queue entry no longer exists.", "not_found");
  const v = await voucherFor(row.recordType, row.recordId);
  if (!v) return err("This record no longer needs a voucher (it was reversed or not yet approved).", "rule_violation");
  return ok({ xml: voucherXml(v, row.remoteId, row.tallyCompany ?? cfg.tallyCompany), remoteId: row.remoteId });
}

/**
 * Sends one voucher to Tally. Tally unavailable is a FAILED attempt recorded
 * with its error — the MahekOne record is untouched and the entry can be
 * retried, and the REMOTEID makes the retry safe.
 */
export async function postToTally(ctx: ErpContext, syncId: string, fetcher: typeof fetch = fetch): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  const cfg = await pettyConfig();
  const [row] = await db.select().from(erpTallySync).where(eq(erpTallySync.id, syncId));
  if (!row) return err("That queue entry no longer exists.", "not_found");
  if (row.status === "posted") return okVoid(`Already posted as ${row.voucherNo ?? "a voucher"} — nothing sent twice`);
  if (row.status === "not_required") return err("This entry no longer needs posting.", "rule_violation");
  const v = await voucherFor(row.recordType, row.recordId);
  if (!v) {
    await db.update(erpTallySync).set({ status: "not_required", updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpTallySync.id, syncId));
    return err("The record no longer needs a voucher — the entry is marked not required.", "rule_violation");
  }
  const claimed = await db
    .update(erpTallySync)
    .set({ status: "syncing", attempts: sql`${erpTallySync.attempts} + 1`, lastAttemptAt: new Date(), updatedById: ctx.actor.id, updatedAt: new Date() })
    .where(sql`${erpTallySync.id} = ${syncId} and ${erpTallySync.status} in ('pending', 'failed', 'correction')`)
    .returning({ id: erpTallySync.id });
  if (!claimed.length) return err("Somebody else is posting this entry right now.", "conflict");
  const fail = async (why: string) => {
    await db.update(erpTallySync).set({ status: "failed", lastError: why, updatedAt: new Date() }).where(eq(erpTallySync.id, syncId));
    await erpAudit(ctx, "erp.petty.tally.failed", "erp_tally_sync", syncId, null, { why });
    return err(`Tally did not take it: ${why}. The record is safe in MahekOne; retry when Tally is reachable.`, "rule_violation");
  };
  if (cfg.tallyMode !== "live") return fail("live posting is switched off (Settings → TallyPrime) — post it by hand from the exported voucher and record its number");
  if (!cfg.tallyUrl) return fail("no Tally server address is set");
  let body: string;
  try {
    const res = await fetcher(cfg.tallyUrl, { method: "POST", headers: { "Content-Type": "text/xml" }, body: voucherXml(v, row.remoteId, row.tallyCompany ?? cfg.tallyCompany), signal: AbortSignal.timeout(15000) });
    body = await res.text();
    if (!res.ok) return fail(`Tally answered ${res.status}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Tally could not be reached");
  }
  const n = (tag: string) => Number(body.match(new RegExp(`<${tag}>(\\d+)</${tag}>`))?.[1] ?? 0);
  if (n("ERRORS") > 0 || (n("CREATED") === 0 && n("ALTERED") === 0)) {
    const line = body.match(/<LINEERROR>([^<]+)<\/LINEERROR>/)?.[1] ?? "Tally rejected the voucher";
    return fail(line);
  }
  const vno = body.match(/<LASTVCHID>(\d+)<\/LASTVCHID>/)?.[1] ?? null;
  await db.update(erpTallySync).set({ status: "posted", voucherType: v.type, voucherNo: vno, postedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(erpTallySync.id, syncId));
  await erpAudit(ctx, "erp.petty.tally.posted", "erp_tally_sync", syncId, null, { remoteId: row.remoteId, voucherNo: vno, altered: n("ALTERED") > 0 });
  return okVoid(n("ALTERED") > 0 ? "Tally already had it — the voucher was updated, not duplicated" : `Posted to Tally${vno ? ` as voucher ${vno}` : ""}`);
}

/** Accounts posted it in Tally by hand: the voucher number closes the entry. */
export async function recordVoucher(ctx: ErpContext, syncId: string, input: { voucherType: string | null; voucherNo: string | null }): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  if (!input.voucherNo) return fieldErr("voucherNo", "The voucher number Tally gave it");
  const [row] = await db.select().from(erpTallySync).where(eq(erpTallySync.id, syncId));
  if (!row) return err("That queue entry no longer exists.", "not_found");
  if (row.status === "not_required") return err("This entry no longer needs posting.", "rule_violation");
  const clash = await db.select({ id: erpTallySync.id }).from(erpTallySync).where(sql`${erpTallySync.voucherNo} = ${input.voucherNo} and coalesce(${erpTallySync.voucherType}, '') = ${input.voucherType ?? ""} and ${erpTallySync.id} <> ${syncId}`);
  if (clash.length) return fieldErr("voucherNo", "That voucher number is already recorded against another entry");
  await db.update(erpTallySync).set({ status: "posted", voucherType: input.voucherType, voucherNo: input.voucherNo, postedAt: new Date(), lastError: null, updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpTallySync.id, syncId));
  await erpAudit(ctx, "erp.petty.tally.recorded", "erp_tally_sync", syncId, { status: row.status }, { status: "posted", voucherNo: input.voucherNo, voucherType: input.voucherType });
  return okVoid(`Recorded as ${input.voucherType ?? "voucher"} ${input.voucherNo}`);
}

export async function setTallyStatus(ctx: ErpContext, syncId: string, status: "not_required" | "reversed" | "correction", reason: string | null): Promise<Result<unknown>> {
  const no = requireAccounts(ctx);
  if (no) return no;
  if (!reason) return fieldErr("reason", "Say why");
  const [row] = await db.select().from(erpTallySync).where(eq(erpTallySync.id, syncId));
  if (!row) return err("That queue entry no longer exists.", "not_found");
  await db.update(erpTallySync).set({ status, lastError: reason, updatedAt: new Date(), updatedById: ctx.actor.id }).where(eq(erpTallySync.id, syncId));
  await erpAudit(ctx, "erp.petty.tally.status", "erp_tally_sync", syncId, { status: row.status }, { status, reason });
  return okVoid("Updated");
}
