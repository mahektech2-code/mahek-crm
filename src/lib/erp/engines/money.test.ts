import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountBalances,
  advanceLabel,
  advanceLate,
  advancePosition,
  bankLineKey,
  cashUse,
  duplicateOf,
  isIncomeOrExpense,
  legs,
  matchCandidates,
  parseBankAmount,
  parseBankDate,
  parseBankStatement,
  reviewFor,
  splitRefusal,
  statement,
  txnLabel,
  txnNoOf,
  type MoneyTxnLike,
} from "./money";

const t = (o: Partial<MoneyTxnLike & { reference: string | null }> & { id: string }): MoneyTxnLike & { reference: string | null } => ({
  kind: "expense",
  amountPaise: 100_00,
  fromAccountId: null,
  toAccountId: null,
  status: "active",
  date: "2026-10-18",
  txnNo: 1,
  reference: null,
  ...o,
});

test("a transaction posts once: from loses it, to gains it, cancelled posts nothing", () => {
  assert.deepEqual(legs(t({ id: "a", kind: "transfer", fromAccountId: "kotak", toAccountId: "cash", amountPaise: 2000 })), [
    { accountId: "kotak", delta: -2000 },
    { accountId: "cash", delta: 2000 },
  ]);
  assert.deepEqual(legs(t({ id: "b", fromAccountId: "kotak", status: "cancelled" })), []);
});

test("balances are opening plus every leg; a transfer moves money and changes no total", () => {
  const accounts = [
    { id: "kotak", openingPaise: 1_00_000_00 },
    { id: "cash", openingPaise: 5_000_00 },
  ];
  const txns = [
    t({ id: "1", kind: "transfer", fromAccountId: "kotak", toAccountId: "cash", amountPaise: 20_000_00 }),
    t({ id: "2", kind: "expense", fromAccountId: "cash", amountPaise: 1_480_00 }),
    t({ id: "3", kind: "receipt", toAccountId: "cash", amountPaise: 25_000_00 }),
    t({ id: "4", kind: "expense", fromAccountId: "kotak", amountPaise: 9_999_00, status: "cancelled" }),
  ];
  const b = accountBalances(accounts, txns);
  assert.equal(b.get("kotak"), 80_000_00);
  assert.equal(b.get("cash"), 5_000_00 + 20_000_00 - 1_480_00 + 25_000_00);
  assert.equal(isIncomeOrExpense("transfer"), null);
  assert.equal(isIncomeOrExpense("advance"), null);
  assert.equal(isIncomeOrExpense("expense"), "expense");
});

test("numbers read the way the spec writes them, and come back out of a picked label", () => {
  assert.equal(txnLabel(423, "2026-10-19"), "TXN-26-00423");
  assert.equal(advanceLabel(31, "2026-10-14"), "ADV-26-0031");
  assert.equal(txnNoOf("TXN-26-00423 · Sai Paint House · ₹4,700 left"), 423);
  assert.equal(txnNoOf("nothing"), null);
});

test("a duplicate is the same invoice from the same payee, or for the same amount; never a cancelled one", () => {
  const existing = [
    { id: "x", kind: "expense", status: "active", invoiceNo: "SPC/2627/0912", payee: "Shree Packaging Co.", amountPaise: 48_500_00 },
    { id: "y", kind: "expense", status: "cancelled", invoiceNo: "OSE-221", payee: "Om Sai", amountPaise: 22_800_00 },
  ];
  assert.equal(duplicateOf({ invoiceNo: "spc 2627 0912", payee: "shree packaging co", amountPaise: 1 }, existing)?.id, "x");
  assert.equal(duplicateOf({ invoiceNo: "SPC-2627-0912", payee: "Other", amountPaise: 48_500_00 }, existing)?.id, "x");
  assert.equal(duplicateOf({ invoiceNo: "SPC-2627-0912", payee: "Other", amountPaise: 1 }, existing), null);
  assert.equal(duplicateOf({ invoiceNo: "OSE-221", payee: "Om Sai", amountPaise: 22_800_00 }, existing), null);
  assert.equal(duplicateOf({ id: "x", invoiceNo: "SPC/2627/0912", payee: "Shree Packaging Co.", amountPaise: 1 }, existing), null);
  assert.equal(duplicateOf({ invoiceNo: "", payee: "Shree Packaging Co.", amountPaise: 1 }, existing), null);
});

test("an advance: what is with them, and what settling moves either way", () => {
  const bills = (...xs: [number, string][]) => xs.map(([amountPaise, review]) => ({ amountPaise, review, status: "active" }));
  const open = advancePosition({ given: 5_000_00, status: "open", bills: bills([2_860_00, "approved"], [1_540_00, "to_review"]), returns: [] });
  assert.equal(open.withThem, 600_00);
  assert.equal(open.settleWhy, "Bills are waiting for review");
  const under = advancePosition({ given: 5_000_00, status: "open", bills: bills([4_400_00, "approved"]), returns: [] });
  assert.equal(under.settleWhy, null);
  assert.equal(under.settleAmount, 600_00);
  const over = advancePosition({ given: 3_000_00, status: "open", bills: bills([3_120_00, "approved"]), returns: [] });
  assert.equal(over.settleAmount, -120_00);
  assert.equal(over.withThem, -120_00);
  const back = advancePosition({ given: 3_000_00, status: "open", bills: bills([1_000_00, "sent_back"]), returns: [] });
  assert.match(back.settleWhy ?? "", /sent back/);
  const settled = advancePosition({ given: 5_000_00, status: "settled", bills: bills([4_400_00, "approved"]), returns: [{ kind: "advance_return", amountPaise: 600_00, status: "active" }] });
  assert.equal(settled.withThem, 0);
  assert.equal(settled.settleAmount, 0);
  assert.equal(advanceLate({ status: "open", billsDueOn: "2026-10-17", billCount: 0 }, "2026-10-20"), true);
  assert.equal(advanceLate({ status: "open", billsDueOn: "2026-10-17", billCount: 2 }, "2026-10-20"), false);
});

test("a statement runs oldest first and closes at opening + in − out", () => {
  const txns = [
    t({ id: "c", txnNo: 3, date: "2026-10-15", kind: "expense", fromAccountId: "cash", amountPaise: 1_480_00 }),
    t({ id: "a", txnNo: 1, date: "2026-10-14", kind: "receipt", toAccountId: "cash", amountPaise: 40_000_00 }),
    t({ id: "b", txnNo: 2, date: "2026-10-14", kind: "transfer", fromAccountId: "cash", toAccountId: "icici", amountPaise: 45_000_00 }),
    t({ id: "d", txnNo: 4, date: "2026-10-16", kind: "expense", fromAccountId: "kotak", amountPaise: 9_00 }),
  ];
  const s = statement("cash", 22_180_00, txns);
  assert.deepEqual(s.rows.map((r) => r.t.id), ["a", "b", "c"]);
  assert.equal(s.rows[0].balance, 62_180_00);
  assert.equal(s.closing, s.opening + s.inPaise - s.outPaise);
  assert.equal(s.closing, 22_180_00 + 40_000_00 - 45_000_00 - 1_480_00);
});

test("cash used from a receipt counts only live onward payments", () => {
  assert.deepEqual(cashUse({ amountPaise: 25_000_00 }, [{ amountPaise: 18_000_00, status: "active" }, { amountPaise: 2_300_00, status: "active" }, { amountPaise: 9_00, status: "cancelled" }]), { used: 20_300_00, left: 4_700_00 });
});

test("bank dates and amounts in the shapes Indian statements print", () => {
  assert.equal(parseBankDate("18/10/2026"), "2026-10-18");
  assert.equal(parseBankDate("18-10-26"), "2026-10-18");
  assert.equal(parseBankDate("18-Oct-2026"), "2026-10-18");
  assert.equal(parseBankDate("18 Oct 26"), "2026-10-18");
  assert.equal(parseBankDate("2026-10-18"), "2026-10-18");
  assert.equal(parseBankDate("31/02/2026"), null);
  assert.equal(parseBankDate("Opening balance"), null);
  assert.equal(parseBankAmount("1,23,456.78"), 1_23_456_78);
  assert.equal(parseBankAmount(""), 0);
  assert.equal(parseBankAmount("500.00 Dr"), 500_00);
  assert.equal(parseBankAmount("abc"), null);
});

test("a statement with a letterhead, debit/credit columns and junk rows", () => {
  const csv = [
    "Kotak Mahindra Bank,,,,,",
    "Account No: XXXX4471,,,,,",
    "",
    "Date,Narration,Chq/Ref No,Withdrawal (Dr),Deposit (Cr),Balance",
    "01/10/2026,Opening Balance,,,,\"12,00,000.00\"",
    "18/10/2026,NEFT-SHREE PACKAGING-KKBKH26291004812,KKBKH26291004812,\"48,500.00\",,\"11,51,500.00\"",
    "19/10/2026,CASH DEP NAGPUR,7744,,\"18,000.00\",\"11,69,500.00\"",
    "Total,,,\"48,500.00\",\"18,000.00\",",
  ].join("\n");
  const r = parseBankStatement(csv);
  assert.equal(r.problem, null);
  assert.equal(r.lines.length, 2);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.lines[0], { date: "2026-10-18", description: "NEFT-SHREE PACKAGING-KKBKH26291004812", reference: "KKBKH26291004812", debitPaise: 48_500_00, creditPaise: 0, balancePaise: 11_51_500_00 });
  assert.equal(r.lines[1].creditPaise, 18_000_00);
  assert.equal(bankLineKey(r.lines[0]), bankLineKey({ ...r.lines[0] }));
  assert.notEqual(bankLineKey(r.lines[0]), bankLineKey(r.lines[1]));
});

test("a statement with one amount column and a Dr/Cr column", () => {
  const r = parseBankStatement("Txn Date\tDescription\tAmount\tDr/Cr\n18-Oct-2026\tUPI RAMESHTEA\t640.00\tDR\n19-Oct-2026\tNEFT COLOUR CAMP\t40,000.00\tCR");
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].debitPaise, 640_00);
  assert.equal(r.lines[1].creditPaise, 40_000_00);
  assert.match(parseBankStatement("hello,world").problem ?? "", /No header/);
});

test("matching: the reference named on the line wins, then the amount near the date, then a part", () => {
  const txns = [
    t({ id: "far", txnNo: 1, date: "2026-09-01", fromAccountId: "kotak", amountPaise: 48_500_00 }),
    t({ id: "ref", txnNo: 2, date: "2026-09-01", fromAccountId: "kotak", amountPaise: 48_500_00, reference: "KKBKH26291004812" }),
    t({ id: "amt", txnNo: 3, date: "2026-10-17", fromAccountId: "kotak", amountPaise: 48_500_00 }),
    t({ id: "part", txnNo: 4, date: "2026-10-18", fromAccountId: "kotak", amountPaise: 20_000_00 }),
    t({ id: "in", txnNo: 5, date: "2026-10-18", toAccountId: "kotak", amountPaise: 48_500_00 }),
    t({ id: "other", txnNo: 6, date: "2026-10-18", fromAccountId: "icici", amountPaise: 48_500_00 }),
    t({ id: "done", txnNo: 7, date: "2026-10-18", fromAccountId: "kotak", amountPaise: 48_500_00 }),
  ];
  const c = matchCandidates(
    { accountId: "kotak", date: "2026-10-18", description: "NEFT-SHREE PACKAGING-KKBKH26291004812", reference: null, debitPaise: 48_500_00, creditPaise: 0 },
    txns,
    (id) => (id === "done" ? 48_500_00 : 0),
  );
  assert.deepEqual(c.map((x) => [x.t.id, x.score]), [["ref", "exact"], ["amt", "amount"], ["part", "near"]]);
});

test("a split must add up to the line exactly and spend no more than each has left", () => {
  assert.equal(splitRefusal(48_500_00, [{ amountPaise: 30_000_00, left: 30_000_00 }, { amountPaise: 18_500_00, left: 20_000_00 }]), null);
  assert.match(splitRefusal(48_500_00, [{ amountPaise: 30_000_00, left: 30_000_00 }]) ?? "", /add up/);
  assert.match(splitRefusal(10_00, [{ amountPaise: 10_00, left: 5_00 }]) ?? "", /more than/);
  assert.match(splitRefusal(10_00, []) ?? "", /at least one/);
});

test("petty cash and advance bills always go to review; an office expense only above the limit", () => {
  assert.equal(reviewFor({ petty: true, advance: false, amountPaise: 1 }, 50_000_00), "to_review");
  assert.equal(reviewFor({ petty: false, advance: true, amountPaise: 1 }, 50_000_00), "to_review");
  assert.equal(reviewFor({ petty: false, advance: false, amountPaise: 50_000_00 }, 50_000_00), "none");
  assert.equal(reviewFor({ petty: false, advance: false, amountPaise: 50_000_01 }, 50_000_00), "to_review");
  assert.equal(reviewFor({ petty: false, advance: false, amountPaise: 99_999_999 }, 0), "none");
});
