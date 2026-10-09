import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageing,
  approvalRoute,
  balanceOf,
  budgetFigures,
  closingFigures,
  decisionRefusal,
  dueDateFor,
  duplicateOf,
  fundBalances,
  fundsRefusal,
  lineKey,
  matchLine,
  parseStatement,
  payableState,
  paymentRefusal,
  splitRefusal,
  splitsNearLimit,
  statementAmount,
  statementDate,
  transferRefusal,
  transferType,
  varianceOf,
  type MatchCandidate,
  type StatementLine,
} from "./petty-cash";

const L = 100; // one rupee in paise

test("an unpaid expense is Pending with the whole amount outstanding (acceptance 1)", () => {
  const s = payableState(5000 * L, []);
  assert.equal(s.status, "PENDING");
  assert.equal(s.paidPaise, 0);
  assert.equal(s.outstandingPaise, 5000 * L);
});

test("a part payment leaves the expense whole and the rest outstanding (acceptance 2, 3)", () => {
  const part = payableState(5000 * L, [{ amountPaise: 3000 * L, status: "confirmed" }]);
  assert.equal(part.status, "PARTIALLY_PAID");
  assert.equal(part.amountPaise, 5000 * L);
  assert.equal(part.outstandingPaise, 2000 * L);
  const full = payableState(5000 * L, [
    { amountPaise: 3000 * L, status: "confirmed" },
    { amountPaise: 2000 * L, status: "confirmed" },
  ]);
  assert.equal(full.status, "COMPLETED");
  assert.equal(full.outstandingPaise, 0);
  assert.equal(full.amountPaise, 5000 * L);
});

test("a request, a reversal and a cancellation move nothing; an approved adjustment does", () => {
  const s = payableState(5000 * L, [
    { amountPaise: 1000 * L, status: "requested" },
    { amountPaise: 2000 * L, status: "reversed" },
    { amountPaise: 500 * L, status: "cancelled" },
  ], [{ amountPaise: 1000 * L, status: "approved" }, { amountPaise: 700 * L, status: "requested" }]);
  assert.equal(s.paidPaise, 0);
  assert.equal(s.requestedPaise, 1000 * L);
  assert.equal(s.payablePaise, 4000 * L);
  assert.equal(s.status, "PENDING");
});

test("a payment may not exceed what is left, counting requests already made", () => {
  const s = payableState(5000 * L, [{ amountPaise: 3000 * L, status: "confirmed" }, { amountPaise: 1000 * L, status: "requested" }]);
  assert.equal(paymentRefusal(1000 * L, s), null);
  assert.match(paymentRefusal(1500 * L, s)!, /Only ₹1,000 is left/);
  assert.match(paymentRefusal(0, s)!, /more than zero/);
});

test("a fund's balance is credits less debits; insufficient funds are refused (acceptance 9)", () => {
  const entries = [
    { fundAccountId: "k", direction: "credit", amountPaise: 50000 * L, txnDate: "2026-10-01" },
    { fundAccountId: "k", direction: "debit", amountPaise: 10000 * L, txnDate: "2026-10-02" },
    { fundAccountId: "c", direction: "credit", amountPaise: 10000 * L, txnDate: "2026-10-02" },
  ];
  const b = fundBalances(entries);
  assert.equal(b.get("k"), 40000 * L);
  assert.equal(b.get("c"), 10000 * L);
  assert.equal(b.get("k")! + b.get("c")!, 50000 * L, "a transfer leaves the total unchanged");
  assert.equal(balanceOf(entries.filter((e) => e.fundAccountId === "c")), 10000 * L);
  assert.equal(fundsRefusal(10000 * L, 10000 * L, "Cash"), null);
  assert.match(fundsRefusal(10000 * L, 10001 * L, "Cash")!, /holds ₹10,000/);
});

test("the day's expected cash and its variance (acceptance 10)", () => {
  const f = closingFigures(
    [
      { direction: "credit", amountPaise: 8000 * L, txnDate: "2026-10-09" },
      { direction: "credit", amountPaise: 3000 * L, txnDate: "2026-10-10" },
      { direction: "debit", amountPaise: 1000 * L, txnDate: "2026-10-10" },
      { direction: "debit", amountPaise: 999 * L, txnDate: "2026-10-11" },
    ],
    "2026-10-10",
  );
  assert.deepEqual(f, { openingPaise: 8000 * L, inPaise: 3000 * L, outPaise: 1000 * L, expectedPaise: 10000 * L });
  assert.equal(varianceOf(9500 * L, f.expectedPaise), -500 * L);
});

test("ageing buckets by days past due", () => {
  assert.equal(ageing("2026-10-10", "2026-10-10").bucket, "Not yet due");
  assert.equal(ageing("2026-10-03", "2026-10-10").bucket, "1–7 days overdue");
  assert.equal(ageing("2026-10-02", "2026-10-10").bucket, "8–15 days overdue");
  assert.equal(ageing("2026-09-20", "2026-10-10").bucket, "16–30 days overdue");
  assert.equal(ageing("2026-09-01", "2026-10-10").daysOverdue, 39);
  assert.equal(ageing(null, "2026-10-10").bucket, "Not yet due");
  assert.equal(dueDateFor(null, "2026-10-01", 15), "2026-10-16");
  assert.equal(dueDateFor("2026-10-05", "2026-10-01", 15), "2026-10-05");
});

test("an expense is routed by amount, category and budget", () => {
  const base = { amountPaise: 300 * L, categoryRule: "standard", autoApproveUpToPaise: 500 * L, approverLimitPaise: 10000 * L, budgetExceeded: false, budgetRule: "warn", missingEvidence: false };
  assert.equal(approvalRoute(base).level, "policy");
  assert.equal(approvalRoute({ ...base, missingEvidence: true }).level, "approver");
  assert.equal(approvalRoute({ ...base, amountPaise: 5000 * L }).level, "approver");
  assert.equal(approvalRoute({ ...base, amountPaise: 15000 * L }).level, "owner");
  assert.equal(approvalRoute({ ...base, categoryRule: "owner" }).level, "owner");
  assert.equal(approvalRoute({ ...base, categoryRule: "approver" }).level, "approver");
  assert.equal(approvalRoute({ ...base, budgetExceeded: true }).level, "policy", "a warning budget rule flags only");
  assert.equal(approvalRoute({ ...base, budgetExceeded: true, budgetRule: "approval" }).level, "owner");
  assert.equal(approvalRoute({ ...base, autoApproveUpToPaise: 0 }).level, "approver");
});

test("nobody approves their own expense, administrator or not (acceptance 11)", () => {
  const d = { level: "approver", deciderId: "u1", deciderName: "Ravi", makerIds: ["u1"], makerNames: ["Ravi"], canApprove: true, canOwnerApprove: true };
  assert.match(decisionRefusal(d)!, /Nobody approves/);
  assert.match(decisionRefusal({ ...d, makerIds: ["u2"], makerNames: ["ravi "] })!, /Nobody approves/, "spent by them counts by name");
  assert.equal(decisionRefusal({ ...d, makerIds: ["u2"], makerNames: ["Suresh"] }), null);
  assert.match(decisionRefusal({ ...d, makerIds: ["u2"], makerNames: [], level: "owner", canOwnerApprove: false })!, /owner/);
  assert.match(decisionRefusal({ ...d, makerIds: ["u2"], makerNames: [], canApprove: false, canOwnerApprove: false })!, /Only an approver/);
});

test("transfer types run only between the funds they name", () => {
  const w = transferType("withdrawal")!;
  assert.equal(transferRefusal(w, "BANK", "PHYSICAL_CASH", false), null);
  assert.ok(transferRefusal(w, "PHYSICAL_CASH", "BANK", false));
  assert.ok(transferRefusal(transferType("between")!, "BANK", "BANK", true));
  assert.equal(transferRefusal(transferType("customerDeposit")!, "CUSTOMER_CASH", "BANK", false), null);
});

const line = (o: Partial<StatementLine>): StatementLine => ({ date: "2026-10-12", valueDate: null, narration: "", reference: null, debitPaise: 0, creditPaise: 0, balancePaise: null, txnId: null, ...o });
const cand = (o: Partial<MatchCandidate>): MatchCandidate => ({ type: "payment", id: "p1", direction: "debit", amountPaise: 2000 * L, date: "2026-10-12", reference: null, words: null, ...o });

test("a statement line matches by UTR on its own, by amount only as a suggestion (acceptance 6)", () => {
  const l = line({ debitPaise: 2000 * L, reference: "UTR 412345678901", narration: "UPI/412345678901/SHREE TRANSPORT" });
  assert.equal(matchLine(l, [cand({ reference: "412345678901" })], 3).kind, "auto");
  const byAmount = matchLine(line({ debitPaise: 2000 * L, narration: "UPI/SOMEONE" }), [cand({}), cand({ id: "p2", amountPaise: 2100 * L })], 3);
  assert.equal(byAmount.kind, "suggest");
  const two = matchLine(line({ debitPaise: 2000 * L, narration: "NEFT X" }), [cand({}), cand({ id: "p2" })], 3);
  assert.equal(two.kind, "ambiguous", "two equal amounts are never settled by amount alone");
  const tie = matchLine(line({ debitPaise: 2000 * L, narration: "UPI/SHREE TRANSPORT" }), [cand({ words: "Shree Transport" }), cand({ id: "p2", words: "Lakshmi Hardware" })], 3);
  assert.equal(tie.kind, "suggest");
  assert.equal(tie.candidates[0].id, "p1");
  assert.equal(matchLine(line({ debitPaise: 2000 * L, date: "2026-10-30" }), [cand({})], 3).kind, "none");
  assert.equal(matchLine(line({ creditPaise: 2000 * L }), [cand({})], 3).kind, "none", "a credit never matches a payment out");
  assert.match(splitRefusal(1000 * L, 600 * L, 500 * L)!, /more than it carries/);
  assert.equal(splitRefusal(1000 * L, 500 * L, 500 * L), null);
});

test("a Kotak-style CSV is read, preamble and all", () => {
  const csv = [
    "Account Statement,,,,,,",
    "MAHEK MARKETING INDIA,,,,,,",
    "Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Debit,Credit,Balance",
    '1,05-10-2026,05-10-2026,UPI/412345678901/SHREE,412345678901,"2,000.00",,"48,000.00"',
    "2,06/10/2026,,ATM CASH WITHDRAWAL,,10000,,38000",
    "3,07-Oct-2026,,BY CASH DEPOSIT,,,3000.00,41000",
    ",Closing balance,,,,,,",
  ].join("\n");
  const p = parseStatement(csv);
  assert.equal(p.lines.length, 3);
  assert.deepEqual(
    p.lines.map((l) => [l.date, l.debitPaise, l.creditPaise, l.balancePaise]),
    [
      ["2026-10-05", 2000 * L, 0, 48000 * L],
      ["2026-10-06", 10000 * L, 0, 38000 * L],
      ["2026-10-07", 0, 3000 * L, 41000 * L],
    ],
  );
  assert.equal(p.lines[0].reference, "412345678901");
  assert.equal(p.skipped.length, 1);
  const again = parseStatement(csv);
  assert.equal(lineKey("k", p.lines[0]), lineKey("k", again.lines[0]), "a re-import is the same line");
  assert.notEqual(lineKey("k", p.lines[0]), lineKey("k", p.lines[1]));
});

test("an amount-and-Dr/Cr statement is read too", () => {
  const p = parseStatement(["Date,Narration,Amount,Dr/Cr,Balance", "2026-10-05,FUEL,500,DR,100", "2026-10-06,REFUND,200,CR,300"].join("\n"));
  assert.deepEqual(p.lines.map((l) => [l.debitPaise, l.creditPaise]), [[500 * L, 0], [0, 200 * L]]);
  assert.equal(statementAmount("(1,200.50)"), -120050);
  assert.equal(statementDate("5 Oct 2026"), "2026-10-05");
  assert.equal(statementDate("rubbish"), null);
});

test("budget against actual, with a forecast for the month under way", () => {
  const b = budgetFigures({ budgetPaise: 30000 * L, incurredPaise: 10000 * L, paidPaise: 6000 * L, committedPaise: 2000 * L, period: "2026-10", today: "2026-10-10" });
  assert.equal(b.unpaidPaise, 4000 * L);
  assert.equal(b.remainingPaise, 18000 * L);
  assert.equal(b.forecastPaise, 31000 * L);
  assert.equal(b.variancePct, -66.7);
  assert.equal(budgetFigures({ budgetPaise: 0, incurredPaise: 1, paidPaise: 0, committedPaise: 0, period: "2026-09", today: "2026-10-10" }).variancePct, null);
});

test("splits near a limit are flagged; duplicates are found by bill or by day", () => {
  const s = splitsNearLimit(
    [
      { id: "a", payee: "Shree", amountPaise: 6000 * L, date: "2026-10-01" },
      { id: "b", payee: "shree ", amountPaise: 6000 * L, date: "2026-10-02" },
      { id: "c", payee: "Other", amountPaise: 6000 * L, date: "2026-10-02" },
    ],
    10000 * L,
    3,
  );
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].ids, ["a", "b"]);
  const ex = [{ id: "e1", payee: "Shree", billNo: "B-1", amountPaise: 100, date: "2026-10-01" }];
  assert.equal(duplicateOf({ payee: "shree", billNo: "b-1", amountPaise: 999, date: "2026-10-09" }, ex).length, 1);
  assert.equal(duplicateOf({ payee: "Shree", billNo: null, amountPaise: 100, date: "2026-10-01" }, ex).length, 1);
  assert.equal(duplicateOf({ payee: "Shree", billNo: null, amountPaise: 100, date: "2026-10-02" }, ex).length, 0);
});
