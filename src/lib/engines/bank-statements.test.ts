import test from "node:test";
import assert from "node:assert/strict";
import {
  bankMark,
  bestSuggestion,
  candidatesFor,
  checkBalances,
  checkRows,
  flagFor,
  inStatementOrder,
  lineState,
  partyKey,
  pdfLineKey,
  type LineIn,
  type MatchData,
  type ReadRow,
} from "./bank-statements";

const row = (n: number, date: string, narration: string, dr: number, cr: number, bal: number | null, extra: Partial<ReadRow> = {}): ReadRow => ({
  lineNo: n,
  page: 1,
  date,
  narration,
  reference: null,
  debitPaise: dr * 100,
  creditPaise: cr * 100,
  balancePaise: bal == null ? null : bal * 100,
  confidence: 98,
  ...extra,
});

const S = { windowDays: 5, lowConfidence: 80, largeCreditPaise: 50_000_000 };
const empty: MatchData = { receipts: [], customers: [], payouts: [], txns: [], accounts: [], lines: [] };
const line = (x: Partial<LineIn>): LineIn => ({ id: "l1", accountId: "kotak", date: "2026-10-21", description: "", reference: null, debitPaise: 0, creditPaise: 0, confidence: 98, breakHere: false, ...x });

test("the balance check: opening + credits − debits = closing, and every running balance follows", () => {
  const rows = [row(1, "2026-10-21", "a", 0, 1000, 11000), row(2, "2026-10-21", "b", 500, 0, 10500), row(3, "2026-10-21", "c", 0, 250, 10750)];
  const c = checkBalances(rows, 1_000_000, 1_075_000);
  assert.equal(c.ok, true);
  assert.equal(c.credits, 125_000);
  assert.equal(c.debits, 50_000);
  assert.equal(c.workedPaise, 1_075_000);
  assert.deepEqual(c.breaks, []);
});

test("a misread figure breaks the running balance on its own line", () => {
  const rows = [row(1, "2026-10-21", "a", 0, 1000, 11000), row(2, "2026-10-21", "b", 500, 0, 10600), row(3, "2026-10-21", "c", 0, 250, 10850)];
  const c = checkBalances(rows, 1_000_000, 1_085_000);
  assert.equal(c.ok, false);
  assert.deepEqual(c.breaks, [2]);
});

test("without a printed opening, it is worked back from the first line", () => {
  const c = checkBalances([row(1, "2026-10-21", "a", 200, 0, 800)], null, null);
  assert.equal(c.openingPaise, 100_000);
  assert.equal(c.ok, true);
});

test("a statement printed newest first is put oldest first", () => {
  const newestFirst = [row(1, "2026-10-21", "c", 0, 250, 10750), row(2, "2026-10-21", "b", 500, 0, 10500), row(3, "2026-10-20", "a", 0, 1000, 11000)];
  const ordered = inStatementOrder(newestFirst, 1_000_000);
  assert.deepEqual(ordered.map((r) => r.narration), ["a", "b", "c"]);
  assert.deepEqual(ordered.map((r) => r.lineNo), [1, 2, 3]);
});

test("a line already imported from an earlier download is found by date, amount and balance", () => {
  const rows = [row(1, "2026-10-21", "NEFT-SHREE GANESH PAINTS-UTR SBIN2262", 0, 124500, 1742860), row(2, "2026-10-21", "UPI/COLOURCAMP", 0, 56000, 1798860)];
  const held = [{ date: "2026-10-21", debitPaise: 0, creditPaise: 12_450_000, balancePaise: 174_286_000, reference: null, description: "NEFT-SHREE GANESH PAINTS-UTR SBIN226294811 (wrapped differently)", createdAt: "2026-10-21T08:44:00Z" }];
  const checked = checkRows(rows, held, [], 80);
  assert.equal(checked[0].existing, true);
  assert.equal(checked[1].existing, false);
});

test("the stored key ignores how the narration was wrapped when there is a balance", () => {
  const a = pdfLineKey({ date: "2026-10-21", debitPaise: 0, creditPaise: 100, balancePaise: 900, reference: null, narration: "NEFT ABC" });
  const b = pdfLineKey({ date: "2026-10-21", debitPaise: 0, creditPaise: 100, balancePaise: 900, reference: "X", narration: "NEFT ABC PAINTS LTD" });
  assert.equal(a, b);
});

test("a credit whose UTR and amount equal a reported receipt is a strong suggestion", () => {
  const data: MatchData = {
    ...empty,
    receipts: [{ id: "r1", label: "Receipt R-2291", customerId: "c1", customer: "COLOUR CAMP", amountPaise: 5_600_000, reference: "429411027734", mode: "UPI", date: "2026-10-20", status: "reported", holdReason: null, reportedBy: "Priya", bills: "MMI/26-27/1102" }],
  };
  const l = line({ description: "UPI/COLOURCAMP PAINTS/9876501234@ybl/PAYMENT", reference: "429411027734", creditPaise: 5_600_000 });
  const c = candidatesFor(l, data, S);
  assert.equal(c[0].kind, "receipt");
  assert.equal(c[0].strength, "strong");
  assert.deepEqual(c[0].reasons.filter((r) => r.ok).map((r) => r.t), ["UTR equal", "Amount equal", "Name in narration", "1 day after"]);
  assert.equal(bestSuggestion(c)?.id, "r1");
});

test("a debit equal to a planned payout to the vendor named in it is a strong suggestion", () => {
  const data: MatchData = {
    ...empty,
    payouts: [{ id: "p1", label: "VP-118", payee: "Asian Solvents Pvt Ltd", amountPaise: 24_878_000, payOn: "2026-10-21", dueDate: "2026-10-24", billNos: "1182, 1190", prNumber: 2207, status: "open", description: null }],
  };
  const l = line({ description: "NEFT-HDFC0000412-ASIAN SOLVENTS PVT LTD-INV 1182", debitPaise: 24_878_000 });
  const best = bestSuggestion(candidatesFor(l, data, S));
  assert.equal(best?.kind, "payout");
  assert.ok(best?.reasons.some((r) => r.t === "Bill no. 1182"));
});

test("a returned cheque is flagged with the receipt it paid", () => {
  const confirmed = [{ id: "r9", label: "Receipt R-2240", customerId: "c", customer: "RAJ ENTERPRISES", amountPaise: 4_230_000, reference: "004377", mode: "Cheque", date: "2026-10-17", status: "confirmed" as const, holdReason: null, reportedBy: null, bills: null }];
  const l = line({ description: "RTN CHQ 004377 - INSUFFICIENT FUNDS - RAJ ENTERPRISES", debitPaise: 4_230_000 });
  const f = flagFor(l, [], empty, S, confirmed);
  assert.equal(f?.flag, "returned");
  assert.equal(f?.receiptId, "r9");
});

test("less money than was reported against the same UTR is flagged short", () => {
  const data: MatchData = {
    ...empty,
    receipts: [{ id: "r2", label: "Receipt R-2288", customerId: "c2", customer: "SRI SAI PAINT AND HARDWARE", amountPaise: 24_000_000, reference: "KKBKH26294011", mode: "Bank transfer", date: "2026-10-20", status: "reported", holdReason: null, reportedBy: null, bills: null }],
  };
  const l = line({ description: "NEFT-KKBK-SRI SAI PAINT AND HARDWARE", reference: "KKBKH26294011", creditPaise: 21_000_000 });
  const f = flagFor(l, candidatesFor(l, data, S), data, S, []);
  assert.equal(f?.flag, "short");
  assert.match(f!.note, /₹30,000 short/);
});

test("the same UTR on two lines is flagged", () => {
  const data: MatchData = { ...empty, lines: [{ id: "l2", accountId: "icici", date: "2026-10-19", reference: "629108443", debitPaise: 0, creditPaise: 6_400_000 }] };
  const f = flagFor(line({ description: "IMPS/VINAYAK PAINTS", reference: "629108443", creditPaise: 6_400_000 }), [], data, S, []);
  assert.equal(f?.flag, "dup_ref");
});

test("a large credit with nothing to explain it is flagged, a small one is just unmatched", () => {
  assert.equal(flagFor(line({ description: "NEFT-BHARAT HARDWARE", creditPaise: 64_000_000 }), [], empty, S, [])?.flag, "large");
  assert.equal(flagFor(line({ description: "NEFT-BHARAT HARDWARE", creditPaise: 6_400_000 }), [], empty, S, []), null);
});

test("a figure that broke the balance is flagged before anything else", () => {
  assert.equal(flagFor(line({ breakHere: true, creditPaise: 100 }), [], empty, S, [])?.flag, "balance");
  assert.equal(flagFor(line({ confidence: 61, creditPaise: 100 }), [], empty, S, [])?.flag, "low_conf");
});

test("bank charges and interest are recognised", () => {
  assert.equal(candidatesFor(line({ description: "CHARGES-NEFT-OUTWARD-GST", debitPaise: 1770 }), empty, S)[0].kind, "charges");
  assert.equal(candidatesFor(line({ description: "INT CREDIT", creditPaise: 341_200 }), empty, S)[0].kind, "interest");
});

test("a transfer between our own accounts is found by the other side's line", () => {
  const data: MatchData = {
    ...empty,
    accounts: [{ id: "kotak", name: "Kotak Bank", bankName: "Kotak Mahindra", last4: "4471", kind: "bank" }, { id: "icici", name: "ICICI Bank", bankName: "ICICI Bank", last4: "0932", kind: "bank" }],
    lines: [{ id: "l9", accountId: "icici", date: "2026-10-21", reference: null, debitPaise: 0, creditPaise: 30_000_000 }],
  };
  const best = bestSuggestion(candidatesFor(line({ description: "RTGS-ICIC0000932-OWN A/C TRF-MAHEK MARKETING", debitPaise: 30_000_000 }), data, S));
  assert.equal(best?.kind, "transfer");
  assert.equal(best?.counterAccountId, "icici");
});

test("a line's state: matched, then set aside, then flagged, then suggested", () => {
  assert.equal(lineState({ status: "open", matchedPaise: 100, amountPaise: 100, flag: "large", suggestion: {} }), "matched");
  assert.equal(lineState({ status: "ignored", matchedPaise: 0, amountPaise: 100, flag: null, suggestion: null }), "ignored");
  assert.equal(lineState({ status: "open", matchedPaise: 0, amountPaise: 100, flag: "large", suggestion: {} }), "flagged");
  assert.equal(lineState({ status: "open", matchedPaise: 0, amountPaise: 100, flag: null, suggestion: {} }), "suggested");
  assert.equal(lineState({ status: "open", matchedPaise: 0, amountPaise: 100, flag: null, suggestion: null }), "unmatched");
});

test("a party's name loses its company suffixes before it is looked for", () => {
  assert.equal(partyKey("M/s Asian Solvents Pvt. Ltd."), "asiansolvents");
  assert.equal(bankMark("Kotak Bank").letters, "K");
  assert.equal(bankMark("HDFC Bank").color, "#004c8f");
});
