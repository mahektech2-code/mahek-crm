/**
 * The Petty Cash module — expenses, receipts, transfers, advances and bank
 * statements — against a real database through the real handlers.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appSettings, customers, erpCashReceipts, erpMoneyTxns, erpUserPowers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { ERP_SCREENS, erpKeysOf } from "@/lib/erp/registry";
import * as M from "@/lib/erp/money";
import { recordReceipt as recordScrapReceipt, voidReceipt as voidScrapReceipt } from "@/lib/erp/drums";
import { FROM_CUSTOMER_CASH, FROM_WITHDRAWAL } from "@/lib/erp/engines/money";
import * as V from "@/lib/erp/money-views";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD, type ImpactReport } from "@/lib/impact/types";

/** The report the impact modal shows to `u`, and the payload it sends back with the act — typed exactly as asked. */
async function confirmed(u: typeof users.$inferSelect, kind: string, recordId: string): Promise<{ report: ImpactReport; values: Record<string, string> }> {
  setTestUser(u);
  const r = await impactReport(kind, recordId);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { report: r.data, values: { [IMPACT_FIELD]: JSON.stringify({ typed: r.data.confirmWord, fingerprint: r.data.fingerprint }) } };
}

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const msg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string }) => (r.ok ? "ok" : (r.fieldErrors?.[0]?.message ?? r.error ?? "?"));

let admin: typeof users.$inferSelect;
let accountant: typeof users.$inferSelect;
let head: typeof users.$inferSelect;

async function makeUser(name: string, level: "associate" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@money.test`, phone: String(9820000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  return u;
}
async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return erpContext();
}
const actor = (u: typeof users.$inferSelect, approver: boolean, administrator = false): M.Actor => ({ id: u.id, name: u.name, approver, administrator });
const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
async function balance(name: string) {
  const acc = (await M.moneyAccounts()).find((a) => a.name === name)!;
  return (await M.accountBalanceMap()).get(acc.id) ?? 0;
}
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 5.5 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  await db.execute(sql`truncate users, erp_user_powers, erp_bank_matches, erp_bank_lines, erp_money_txns, erp_advances, erp_cash_receipts, erp_scrap_allocations, audit_log restart identity cascade`);
  await db.execute(sql`update erp_money_accounts set opening_paise = 0, opening_date = null, active = true`);
  await db.execute(sql`delete from erp_money_accounts where id not in ('macc_kotak', 'macc_icici', 'macc_cash', 'macc_petty')`);
  await db.execute(sql`update erp_series set last = 0 where key in ('moneyTxn', 'advance')`);
  await db.insert(appSettings).values({ key: "erp.money.approvalAbovePaise", value: 5_000_000, valueType: "integer", category: "erp", label: "x" }).onConflictDoUpdate({ target: appSettings.key, set: { value: 5_000_000 } });
  invalidateConfig();
  admin = await makeUser("Vikram Admin", "admin");
  accountant = await makeUser("Deepa Accounts", "associate");
  head = await makeUser("Rajesh Head", "associate");
  await db.insert(erpUserPowers).values({ userId: accountant.id, power: "approveMoney", grantedById: admin.id });
  await db.insert(customers).values({ id: "cus_sai", name: "Sai Paint House", city: "Nagpur", phone: "9876500011", kind: "customer" }).onConflictDoNothing();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("accounts and openings", () => {
  test("the four accounts are there, and only the accountant sets their opening", async () => {
    const names = (await M.moneyAccounts()).map((a) => a.name);
    assert.deepEqual(names, ["Kotak Bank", "ICICI Bank", "Cash in Hand", "Petty Cash"]);
    assert.equal(msg(await M.saveAccount(actor(head, false), { id: "macc_kotak", name: "Kotak Bank", kind: null, last4: "4471", openingPaise: 1, openingDate: null, active: true })), "Only the accountant sets up accounts.");
    assert.ok((await M.saveAccount(actor(accountant, true), { id: "macc_kotak", name: "Kotak Bank", kind: null, last4: "4471", openingPaise: 10_00_000_00, openingDate: daysAgo(30), active: true })).ok);
    assert.ok((await M.saveAccount(actor(accountant, true), { id: "macc_petty", name: "Petty Cash", kind: null, last4: null, openingPaise: 5_000_00, openingDate: daysAgo(30), active: true })).ok);
    assert.equal(await balance("Kotak Bank"), 10_00_000_00);
    assert.equal(msg(await M.saveAccount(actor(accountant, true), { name: "kotak bank", kind: "Bank", last4: null, openingPaise: 0, openingDate: null, active: true })), "Another account already has that name.");
  });
});

describe("expenses are entered when paid", () => {
  test("an office expense leaves its account once; above the limit it goes to review", async () => {
    const a = actor(head, false);
    const base = { petty: false, date: today(), category: "Packing material", payee: "Shree Packaging Co.", invoiceNo: "SPC/2627/0912", description: "500 × 5L boxes", paidFrom: "Kotak Bank", source: null, mode: "NEFT", reference: "KKBKH26291004812", note: null, files: [], duplicateOverride: false };
    assert.equal(msg(await M.saveExpense(a, { ...base, invoiceNo: null, amountPaise: 1 })), "The invoice or bill number is required.");
    assert.equal(msg(await M.saveExpense(a, { ...base, date: "2099-01-01", amountPaise: 1 })), "A payment cannot be dated in the future.");
    assert.equal(msg(await M.saveExpense(a, { ...base, paidFrom: null, amountPaise: 1 })), "Choose the account it was paid from.");
    const r = await M.saveExpense(a, { ...base, amountPaise: 48_500_00 });
    assert.ok(r.ok, msg(r));
    assert.match(r.message ?? "", /^TXN-\d\d-00001 saved/);
    assert.equal(await balance("Kotak Bank"), 10_00_000_00 - 48_500_00);
    const [t] = await M.txnRows(sql`t.id = ${r.data.id}`);
    assert.equal(t.review, "none", "₹48,500 is under the ₹50,000 limit");

    /* The same invoice again is a duplicate until somebody says otherwise. */
    assert.match(msg(await M.saveExpense(a, { ...base, invoiceNo: "spc 2627 0912", amountPaise: 48_500_00 })), /^Already on TXN-\d\d-00001/);
    const dup = await M.saveExpense(a, { ...base, amountPaise: 48_500_00, duplicateOverride: true });
    assert.ok(dup.ok);
    /* Cancelled from its own row: the bare act is refused, and the modal says which balance moves back. */
    assert.match(msg(await mod("expenses").actions!.cancel(await as(head), dup.data.id, { reason: "Entered twice by mistake" })), /Check what this affects/);
    const undo = await confirmed(head, "erp-money-txn", dup.data.id);
    assert.deepEqual(undo.report.items.find((i) => /account balance in Petty Cash changes/.test(i.label))?.examples, ["Kotak Bank +₹48,500"]);
    assert.ok((await mod("expenses").actions!.cancel(await as(head), dup.data.id, { reason: "Entered twice by mistake", ...undo.values })).ok);
    assert.equal(await balance("Kotak Bank"), 10_00_000_00 - 48_500_00, "a cancelled row moves nothing");

    const big = await M.saveExpense(a, { ...base, invoiceNo: "MSEB-1", payee: "MSEDCL", category: "Electricity", amountPaise: 63_140_00 });
    assert.ok(big.ok);
    const [b] = await M.txnRows(sql`t.id = ${big.data.id}`);
    assert.equal(b.review, "to_review");
    assert.equal(msg(await M.reviewTxns(actor(head, false), [b.id], "approved", null)), "Only the accountant reviews petty cash and expenses.");
    assert.equal(msg(await M.reviewTxns(actor(accountant, true), [b.id], "sent_back", "")), "Say what needs fixing.");
    assert.ok((await M.reviewTxns(actor(accountant, true), [b.id], "sent_back", "Attach the bill")).ok);
    /* The person who entered it fixes it, and it goes back for review. */
    assert.ok((await M.saveExpense(a, { ...base, id: b.id, invoiceNo: "MSEB-1", payee: "MSEDCL", category: "Electricity", amountPaise: 63_140_00, note: "bill attached" })).ok);
    assert.equal((await M.txnRows(sql`t.id = ${b.id}`))[0].review, "to_review");
    assert.ok((await M.reviewTxns(actor(accountant, true), [b.id], "approved", null)).ok);
    assert.equal(msg(await M.saveExpense(a, { ...base, id: b.id, invoiceNo: "MSEB-1", payee: "MSEDCL", category: "Electricity", amountPaise: 1 })), "An approved expense is closed. The accountant can correct it.");
    assert.equal(msg(await M.reviewTxns(actor(accountant, true), [r.data.id], "approved", null)), "Nothing there is waiting for review.");
  });

  test("nobody approves what they entered, unless an administrator", async () => {
    const r = await M.saveExpense(actor(accountant, true), { petty: true, date: today(), category: "Petrol", payee: "HP Pump", invoiceNo: "HP-1", description: null, amountPaise: 500_00, paidFrom: "Petty Cash", source: null, mode: "Cash", reference: null, note: null, files: [], duplicateOverride: false });
    assert.ok(r.ok);
    assert.equal(msg(await M.reviewTxns(actor(accountant, true), [r.data.id], "approved", null)), "Somebody else reviews what you entered.");
    assert.ok((await M.reviewTxns(actor(admin, true, true), [r.data.id], "approved", null)).ok);
  });
});

describe("cash traced from where it came", () => {
  test("a customer's cash pays petty spends and a deposit, never more than there is", async () => {
    const rc = await M.saveReceipt(actor(head, false), { date: today(), into: "Cash in Hand", amountPaise: 25_000_00, customer: "Sai Paint House", payer: null, mode: "Cash", reference: "RCPT-26-0332", billsText: "MMI/0981, MMI/1044", note: null, files: [] });
    assert.ok(rc.ok, msg(rc));
    assert.equal(msg(await M.saveReceipt(actor(head, false), { date: today(), into: "Cash in Hand", amountPaise: 1, customer: null, payer: "x", mode: "UPI", reference: null, billsText: null, note: null, files: [] })), "Cash in Hand only takes cash.");
    const [src] = await M.cashSources("customer");
    assert.match(src.label, /Sai Paint House · ₹25,000 left$/);
    const dep = await M.saveTransfer(actor(head, false), { date: today(), from: "Cash in Hand", to: "Kotak Bank", amountPaise: 18_000_00, mode: "Cash", reference: "Slip 7744", source: src.label, note: null, files: [] });
    assert.ok(dep.ok, msg(dep));
    const [left] = await M.cashSources("customer");
    assert.match(left.label, /₹7,000 left$/);
    const petrol = { petty: true, date: today(), category: "Petrol", payee: "HP Petrol Pump", invoiceNo: "HP-77120", description: null, paidFrom: FROM_CUSTOMER_CASH, source: left.label, mode: null, reference: null, note: null, files: [], duplicateOverride: false };
    assert.equal(msg(await M.saveExpense(actor(head, false), { ...petrol, amountPaise: 8_000_00 })), `Only ₹7,000 is left of ${left.label.split(" · ")[0]}.`);
    const p = await M.saveExpense(actor(head, false), { ...petrol, amountPaise: 2_300_00 });
    assert.ok(p.ok, msg(p));
    const [pt] = await M.txnRows(sql`t.id = ${p.data.id}`);
    assert.equal(pt.from, "Cash in Hand");
    assert.equal(pt.mode, "Cash");
    assert.equal(pt.review, "to_review", "petty cash is always reviewed");
    const [r] = await M.txnRows(sql`t.id = ${rc.data.id}`);
    assert.equal(r.usedPaise, 20_300_00);
    assert.match(msg(await M.cancelTxn(actor(accountant, true), r.id, "Recorded against the wrong customer")), /paid onward/);
    /* The screen says where the cash went. */
    const row = (await mod("moneyReceipts").load(await as(accountant))).rows.find((x) => x.id === r.id)!;
    const panel = row.panel!.data as { sections: { title: string; lines: { text: string }[] }[] };
    assert.deepEqual(panel.sections[0].lines.map((l) => l.text), ["₹2,300 · Petrol — HP Petrol Pump", "₹18,000 · deposited to Kotak Bank", "₹4,700 still in Cash in Hand"]);
  });

  test("a withdrawal is a transfer: both balances move, nothing is income or expense", async () => {
    const before = { kotak: await balance("Kotak Bank"), cash: await balance("Cash in Hand") };
    const w = await M.saveTransfer(actor(head, false), { date: today(), from: "Kotak Bank", to: "Cash in Hand", amountPaise: 20_000_00, mode: "Cash", reference: "CHQ 004129", source: null, note: null, files: [] });
    assert.ok(w.ok);
    assert.equal(await balance("Kotak Bank"), before.kotak - 20_000_00);
    assert.equal(await balance("Cash in Hand"), before.cash + 20_000_00);
    assert.equal(msg(await M.saveTransfer(actor(head, false), { date: today(), from: "Kotak Bank", to: "Kotak Bank", amountPaise: 1, mode: "NEFT", reference: null, source: null, note: null, files: [] })), "A transfer moves money between two different accounts.");
    const [wd] = await M.cashSources("withdrawal");
    assert.ok((await M.saveExpense(actor(head, false), { petty: true, date: today(), category: "Tea / food", payee: "Ramesh Tea Stall", invoiceNo: "RT-18", description: null, amountPaise: 640_00, paidFrom: FROM_WITHDRAWAL, source: wd.label, mode: null, reference: null, note: null, files: [], duplicateOverride: false })).ok);
  });
});

describe("advances", () => {
  test("given, accounted for with bills, reviewed and settled — the unspent part comes back", async () => {
    const pettyBefore = await balance("Petty Cash");
    const give = await M.giveAdvance(actor(head, false), { employee: "Suresh K", amountPaise: 5_000_00, date: daysAgo(3), purpose: "Diesel and loading", billsDueOn: today(), from: "Petty Cash", mode: "Cash", reference: null, note: null });
    assert.ok(give.ok, msg(give));
    assert.equal(await balance("Petty Cash"), pettyBefore - 5_000_00, "the advance leaves Petty Cash as it is given");
    assert.match(msg(await M.giveAdvance(actor(head, false), { employee: "suresh k", amountPaise: 1, date: today(), purpose: null, billsDueOn: null, from: "Petty Cash", mode: "Cash", reference: null, note: null })), /^Suresh K still holds ADV-\d\d-0001/);

    const bill = { date: daysAgo(2), category: "Hardware", payee: "Balaji Hardware", invoiceNo: "BH/3390", amountPaise: 2_860_00, noBillReason: null, description: null, photo: null };
    assert.equal(msg(await M.submitAdvanceBills(actor(head, false), give.data.id, [bill])), "Bill 1: add a photo of the bill.");
    assert.equal(msg(await M.submitAdvanceBills(actor(head, false), give.data.id, [{ ...bill, invoiceNo: null }])), "Bill 1: no bill number — say why there is no bill.");
    assert.equal(msg(await M.submitAdvanceBills(actor(head, false), give.data.id, [{ ...bill, invoiceNo: null, date: daysAgo(9), noBillReason: "Loading men" }])), "A bill cannot be older than the advance it was paid from.");
    const sub = await M.submitAdvanceBills(actor(head, false), give.data.id, [
      { ...bill, invoiceNo: null, noBillReason: "Hardware counter gives no bill" },
      { ...bill, category: "Labour", payee: "Loading — 2 men", amountPaise: 1_540_00, invoiceNo: null, noBillReason: "Daily wage, paid in hand" },
    ]);
    assert.ok(sub.ok, msg(sub));
    assert.equal(await balance("Petty Cash"), pettyBefore - 5_000_00, "a bill against an advance moves no account a second time");

    let [a] = await M.advanceRows(sql`a.id = ${give.data.id}`);
    assert.equal(a.position.withThem, 600_00);
    assert.equal(msg(await M.settleAdvance(actor(accountant, true), a.id, "Petty Cash", "Cash")), "Bills are waiting for review");
    assert.ok((await M.reviewTxns(actor(accountant, true), a.bills.map((b) => b.id), "approved", null)).ok);
    assert.equal(msg(await M.settleAdvance(actor(head, false), a.id, "Petty Cash", "Cash")), "Only the accountant settles an advance.");
    const s = await M.settleAdvance(actor(accountant, true), a.id, "Petty Cash", "Cash");
    assert.ok(s.ok, msg(s));
    assert.match(s.message ?? "", /₹600 returned to Petty Cash/);
    [a] = await M.advanceRows(sql`a.id = ${give.data.id}`);
    assert.equal(a.status, "settled");
    assert.equal(a.position.withThem, 0);
    assert.equal(await balance("Petty Cash"), pettyBefore - 4_400_00);

    /* Reopened, the settlement is undone; spending more than given is paid back to them instead. */
    assert.ok((await M.reopenAdvance(actor(accountant, true), a.id, "One more bill turned up")).ok);
    assert.ok((await M.submitAdvanceBills(actor(head, false), a.id, [{ ...bill, invoiceNo: null, payee: "Dhaba", category: "Tea / food", amountPaise: 720_00, noBillReason: "Roadside, no bill" }])).ok);
    [a] = await M.advanceRows(sql`a.id = ${give.data.id}`);
    assert.ok((await M.reviewTxns(actor(accountant, true), a.bills.filter((b) => b.review === "to_review").map((b) => b.id), "approved", null)).ok);
    const s2 = await M.settleAdvance(actor(accountant, true), a.id, "Petty Cash", "Cash");
    assert.ok(s2.ok, msg(s2));
    assert.match(s2.message ?? "", /₹120 paid to Suresh K from Petty Cash/);
    assert.equal(await balance("Petty Cash"), pettyBefore - 5_120_00);
  });

  test("an advance with no bills can be cancelled, and its money goes back", async () => {
    const before = await balance("Petty Cash");
    const g = await M.giveAdvance(actor(head, false), { employee: "Anil P", amountPaise: 3_000_00, date: today(), purpose: null, billsDueOn: null, from: "Petty Cash", mode: "Cash", reference: null, note: null });
    assert.ok(g.ok);
    assert.match(msg(await mod("advances").actions!.cancelAdvance(await as(head), g.data.id, { reason: "Given to the wrong person" })), /Check what this affects/);
    const undo = await confirmed(head, "erp-money-advance", g.data.id);
    assert.match(undo.report.items.find((i) => /transaction on it cancelled/.test(i.label))?.note ?? "", /Petty Cash \+₹3,000/);
    assert.ok((await mod("advances").actions!.cancelAdvance(await as(head), g.data.id, { reason: "Given to the wrong person", ...undo.values })).ok);
    assert.equal(await balance("Petty Cash"), before);
  });
});

describe("bank statements are matched, never re-entered", () => {
  test("an import matches by reference, a split adds up, and nothing is created where something fits", async () => {
    const day = today();
    const [dd, mm, yyyy] = [day.slice(8, 10), day.slice(5, 7), day.slice(0, 4)];
    const csv = [
      "Kotak Mahindra Bank,,,,,",
      "Date,Narration,Chq/Ref No,Withdrawal (Dr),Deposit (Cr),Balance",
      `${dd}/${mm}/${yyyy},NEFT-SHREE PACKAGING-KKBKH26291004812,KKBKH26291004812,"48,500.00",,`,
      `${dd}/${mm}/${yyyy},CASH DEP NAGPUR SLIP 7744,7744,,"18,000.00",`,
      `${dd}/${mm}/${yyyy},BANK CHARGES,,236.00,,`,
    ].join("\n");
    assert.equal(msg(await M.importBankStatement(actor(head, false), "Kotak Bank", csv)), "Only the accountant imports bank statements.");
    assert.equal(msg(await M.importBankStatement(actor(accountant, true), "Cash in Hand", csv)), "Choose the bank the statement is from.");
    const r = await M.importBankStatement(actor(accountant, true), "Kotak Bank", csv);
    assert.ok(r.ok, msg(r));
    assert.deepEqual([r.data.added, r.data.matched], [3, 2], "the NEFT line names its UTR and the deposit its slip");
    const again = await M.importBankStatement(actor(accountant, true), "Kotak Bank", csv);
    assert.ok(again.ok);
    assert.deepEqual([again.data.added, again.data.repeated], [0, 3], "the same statement twice adds nothing");

    const lines = await M.bankLineRows(sql`true`);
    const neft = lines.find((l) => l.description.startsWith("NEFT"))!;
    assert.equal(neft.matchedPaise, 48_500_00, "the line names the UTR, so it matched as it landed");
    const deposit = lines.find((l) => l.description.startsWith("CASH DEP"))!;
    const charges = lines.find((l) => l.description === "BANK CHARGES")!;
    assert.equal(deposit.matchedPaise, 18_000_00);

    /* Undone, the deposit is open again — and the transfer it was is still the first suggestion, so nothing new may be created for it. */
    assert.ok((await M.unmatchBankLine(actor(accountant, true), deposit.id)).ok);
    const cands = await M.candidatesFor([deposit, charges], 7);
    assert.equal(cands.get(deposit.id)![0].score, "exact");
    assert.equal(cands.get(charges.id)!.length, 0);
    assert.match(msg(await M.createFromBankLine(actor(accountant, true), deposit.id, { category: null, party: null, description: null, counter: "Cash in Hand" })), /may already be this line/);
    assert.ok((await M.matchBankLine(actor(accountant, true), deposit.id, [cands.get(deposit.id)![0].t.id])).ok);
    const made = await M.createFromBankLine(actor(accountant, true), charges.id, { category: "Bank charges", party: "Kotak Mahindra Bank", description: "Statement charges", counter: null });
    assert.ok(made.ok, msg(made));

    /* A matched transaction cannot be cancelled until the match is undone. */
    const [exp] = await M.txnRows(sql`t.invoice_no = 'SPC/2627/0912' and t.status = 'active'`);
    assert.match(msg(await M.cancelTxn(actor(accountant, true), exp.id, "Testing the guard on it")), /Undo the match first/);
    assert.match(msg(await mod("bankLines").actions!.unmatch(await as(accountant), neft.id, {})), /Check what this affects/);
    const unmatch = await confirmed(accountant, "erp-bank-match", neft.id);
    assert.ok(unmatch.report.items.some((i) => i.effect === "unlinked" && /Petty Cash transaction no longer explained/.test(i.label) && i.examples?.[0]?.startsWith(exp.label)), JSON.stringify(unmatch.report.items));
    assert.ok((await mod("bankLines").actions!.unmatch(await as(accountant), neft.id, unmatch.values)).ok);
    assert.equal((await M.bankLineRows(sql`l.id = ${neft.id}`))[0].matchedPaise, 0);
    assert.ok((await M.matchBankLine(actor(accountant, true), neft.id, [exp.id])).ok);
  });
});

describe("statements and scrap receipts", () => {
  test("a statement closes at opening + in − out, and agrees with the balance", async () => {
    const ctx = await as(accountant);
    const rows = (await mod("stmtKotak").load(ctx)).rows;
    const last = rows[rows.length - 1];
    assert.equal(last.v.balance, await balance("Kotak Bank"));
  });

  test("a scrap buyer's receipt is the same money once, and voiding it takes it off the balance", async () => {
    await db.execute(sql`insert into erp_scrap_buyers (id, name) values ('buyer_m', 'Metal Mart') on conflict do nothing`);
    const before = await balance("ICICI Bank");
    const a = { id: accountant.id, name: accountant.name, app: "erp" as const, level: "associate" as const };
    assert.equal(msg(await recordScrapReceipt(a, { date: today(), mode: "UPI", amountPaise: 1, buyerId: "buyer_m", payer: null, reference: null, note: null, into: "Cash in Hand" })), "Cash in Hand only takes cash.");
    const r = await recordScrapReceipt(a, { date: today(), mode: "Bank transfer", amountPaise: 6_000_00, buyerId: "buyer_m", payer: null, reference: "UTR9", note: null, into: "ICICI Bank" });
    assert.ok(r.ok, msg(r));
    assert.equal(await balance("ICICI Bank"), before + 6_000_00);
    const [t] = await db.select().from(erpMoneyTxns).where(eq(erpMoneyTxns.scrapReceiptId, r.data.id));
    assert.equal(t.payer, "Metal Mart");
    assert.match(msg(await M.cancelTxn(actor(accountant, true), t.id, "Trying it from here")), /voided on Scrap buyers/);
    assert.ok((await voidScrapReceipt(a, r.data.id, "Recorded against the wrong buyer")).ok);
    assert.equal(await balance("ICICI Bank"), before);
    const [cr] = await db.select().from(erpCashReceipts).where(eq(erpCashReceipts.id, r.data.id));
    assert.equal(cr.status, "void");
  });
});

describe("the screens", () => {
  test("every Petty Cash tab loads, for the accountant and for somebody without the power", async () => {
    const screen = ERP_SCREENS.find((s) => s.key === "expenses")!;
    for (const u of [accountant, head]) {
      const ctx = await as(u);
      for (const k of erpKeysOf(screen)) {
        const m = mod(k);
        const r = await m.load(ctx);
        assert.ok(Array.isArray(r.rows), k);
      }
    }
    const ctx = await as(head);
    const review = await mod("moneyReview").load(ctx);
    const row = review.rows[0];
    assert.equal(row.actions!.find((a) => a.id === "approve")!.why, "Only the accountant for Petty Cash");
  });

  test("the screen forms save through the module, and a correction keeps its number", async () => {
    const ctx = await as(head);
    const r = await mod("pettyExpenses").forms!.new(ctx, { date: today(), category: "Stationery", payee: "Ganesh Stores", invoiceNo: "GS-11", amount: "120", paidFrom: "Petty Cash · ₹1", mode: "Cash" }, []);
    assert.ok(r.ok, msg(r));
    const [t] = await M.txnRows(sql`t.invoice_no = 'GS-11'`);
    assert.ok(t.petty);
    const f = await mod("pettyExpenses").formLoaders!.edit(ctx, t.id);
    assert.equal(f!.init!.amount, "120");
    assert.ok((await mod("pettyExpenses").forms!.new(ctx, { ...f!.init!, amount: "150" }, [], t.id)).ok);
    const [t2] = await M.txnRows(sql`t.id = ${t.id}`);
    assert.deepEqual([t2.txnNo, t2.amountPaise], [t.txnNo, 150_00]);
  });

  test("Petty Cash's own screens read every list, the drawer, an advance, a statement and the bank view", async () => {
    const ctx = await as(head);
    const day = today();
    const keys = Object.keys(V.TXN_VIEWS);
    for (const k of keys) {
      const v = await V.txnView(k, { period: "all" }, day);
      assert.ok(Array.isArray(v.rows), k);
      assert.ok(v.total >= v.rows.length, k);
      await V.filterOptions(k);
    }
    const counts = await V.tabCounts([...keys, "advances", "bankLines"], "month", day);
    assert.equal(typeof counts.expenses, "number");
    const kit = await V.moneyKitData(day);
    assert.ok(kit.accounts.length >= 4);
    assert.match(kit.nextTxn, /^TXN-\d{2}-\d{5}$/);
    const st = await V.statementView("macc_cash", "all", day);
    assert.ok(st);
    assert.equal(st.closing, st.opening + st.inPaise - st.outPaise);
    const [any] = await M.txnRows(sql`t.status = 'active'`);
    const d = await V.txnDetail(any.id);
    assert.equal(d?.t.id, any.id);
    for (const a of await V.advanceList()) assert.equal((await V.advanceView(a.id))?.a.id, a.id);
    const b = await V.bankView(null, "all", null, 7);
    assert.ok(b && b.counts.all >= 0);
    assert.deepEqual(V.periodRange("last", "2026-03-15"), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(V.periodRange("fy", "2026-03-15"), { from: "2025-04-01", to: "2026-03-15" });
    void ctx;
  });
});
