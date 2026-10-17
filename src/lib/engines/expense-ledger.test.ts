import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  allocatePayouts,
  disallowedPaise,
  eligibilityOf,
  ledgerTotals,
  payStatusOf,
  payablePaise,
  statement,
  type LedgerLine,
  type LedgerPayout,
} from "./expense-ledger";

const line = (over: Partial<LedgerLine> & { id: string }): LedgerLine => ({
  day: "2026-10-01",
  loggedAt: null,
  allowance: false,
  state: "pending",
  claimedPaise: 10_000,
  eligiblePaise: 10_000,
  approvedAmountPaise: null,
  ...over,
});
const pay = (
  id: string,
  paidOn: string,
  amountPaise: number,
  voided = false,
): LedgerPayout => ({
  id,
  paidOn,
  amountPaise,
  voided,
});

test("what a line is worth: allowance whole, approved at what was allowed, nothing while waiting or refused", () => {
  assert.equal(
    payablePaise(
      line({
        id: "a",
        allowance: true,
        state: "allowance",
        claimedPaise: 25_000,
      }),
    ),
    25_000,
  );
  assert.equal(payablePaise(line({ id: "b", state: "approved" })), 10_000);
  /* A flat hotel rate approved above the bill pays the rate. */
  assert.equal(
    payablePaise(
      line({ id: "c", state: "approved", approvedAmountPaise: 45_000 }),
    ),
    45_000,
  );
  assert.equal(
    payablePaise(
      line({
        id: "d",
        state: "partially_approved",
        approvedAmountPaise: 6_000,
      }),
    ),
    6_000,
  );
  assert.equal(payablePaise(line({ id: "e", state: "pending" })), 0);
  assert.equal(payablePaise(line({ id: "f", state: "rejected" })), 0);
});

test("disallowed is the whole refusal or the cut — never negative", () => {
  assert.equal(disallowedPaise(line({ id: "r", state: "rejected" })), 10_000);
  assert.equal(
    disallowedPaise(
      line({
        id: "p",
        state: "partially_approved",
        approvedAmountPaise: 6_000,
      }),
    ),
    4_000,
  );
  assert.equal(
    disallowedPaise(
      line({ id: "h", state: "approved", approvedAmountPaise: 45_000 }),
    ),
    0,
  );
  assert.equal(disallowedPaise(line({ id: "w", state: "pending" })), 0);
});

test("the policy's verdict is read off the eligible figure", () => {
  assert.equal(
    eligibilityOf(line({ id: "1", eligiblePaise: null })),
    "unpriced",
  );
  assert.equal(
    eligibilityOf(line({ id: "2", eligiblePaise: 0 })),
    "not_eligible",
  );
  assert.equal(
    eligibilityOf(line({ id: "3", eligiblePaise: 4_000 })),
    "over_policy",
  );
  assert.equal(
    eligibilityOf(line({ id: "4", eligiblePaise: 10_000 })),
    "within",
  );
  assert.equal(
    eligibilityOf(line({ id: "5", eligiblePaise: 45_000 })),
    "within",
  );
  assert.equal(
    eligibilityOf(line({ id: "6", allowance: true, state: "allowance" })),
    "allowance",
  );
});

test("payouts settle the oldest payable lines first, and a voided one counts for nothing", () => {
  const lines = [
    line({
      id: "late",
      day: "2026-10-05",
      state: "approved",
      claimedPaise: 3_000,
    }),
    line({
      id: "early",
      day: "2026-10-01",
      state: "approved",
      claimedPaise: 5_000,
    }),
    line({ id: "waiting", day: "2026-10-02", state: "pending" }),
    line({
      id: "mid",
      day: "2026-10-03",
      allowance: true,
      state: "allowance",
      claimedPaise: 2_000,
    }),
  ];
  const a = allocatePayouts(lines, [
    pay("p1", "2026-10-06", 6_000),
    pay("void", "2026-10-06", 9_999, true),
  ]);
  assert.equal(a.paidByLine.get("early"), 5_000);
  assert.equal(a.paidByLine.get("mid"), 1_000);
  assert.equal(a.paidByLine.get("late"), 0);
  assert.equal(a.paidByLine.has("waiting"), false);
  assert.equal(a.advancePaise, 0);
  assert.equal(payStatusOf(lines[1], a), "paid");
  assert.equal(payStatusOf(lines[3], a), "part_paid");
  assert.equal(payStatusOf(lines[0], a), "unpaid");
  assert.equal(payStatusOf(lines[2], a), "nothing_to_pay");
});

test("paying more than is owed is an advance, not a negative balance", () => {
  const lines = [line({ id: "x", state: "approved", claimedPaise: 1_000 })];
  const a = allocatePayouts(lines, [pay("p", "2026-10-02", 1_500)]);
  assert.equal(a.advancePaise, 500);
  const t = ledgerTotals(lines, [pay("p", "2026-10-02", 1_500)]);
  assert.equal(t.duePaise, 0);
  assert.equal(t.advancePaise, 500);
});

test("totals add up: claimed = approved + disallowed + pending, payable = approved + allowances", () => {
  const lines = [
    line({ id: "a", state: "approved", claimedPaise: 10_000 }),
    line({
      id: "p",
      state: "partially_approved",
      claimedPaise: 10_000,
      approvedAmountPaise: 7_000,
      eligiblePaise: 7_000,
    }),
    line({ id: "r", state: "rejected", claimedPaise: 5_000, eligiblePaise: 0 }),
    line({ id: "w", state: "pending", claimedPaise: 2_000 }),
    line({
      id: "m",
      allowance: true,
      state: "allowance",
      claimedPaise: 25_000,
    }),
  ];
  const t = ledgerTotals(lines, [pay("p1", "2026-10-09", 30_000)]);
  assert.equal(t.claimedPaise, 27_000);
  assert.equal(t.approvedPaise, 17_000);
  assert.equal(t.disallowedPaise, 8_000);
  assert.equal(t.refusedPaise, 5_000);
  assert.equal(t.pendingPaise, 2_000);
  assert.equal(
    t.claimedPaise,
    t.approvedPaise + t.disallowedPaise + t.pendingPaise,
  );
  assert.equal(t.allowancePaise, 25_000);
  assert.equal(t.payablePaise, 42_000);
  assert.equal(t.paidPaise, 30_000);
  assert.equal(t.duePaise, 12_000);
  assert.equal(t.notEligibleCount, 1);
  assert.equal(t.overPolicyCount, 1);
  assert.equal(t.overPolicyPaise, 3_000);
  assert.equal(t.partCount, 1);
});

test("the statement runs in date order, lines before payouts on a day, and ends at the balance due", () => {
  const lines = [
    line({
      id: "b",
      day: "2026-10-03",
      state: "approved",
      claimedPaise: 4_000,
    }),
    line({
      id: "a",
      day: "2026-10-01",
      state: "approved",
      claimedPaise: 6_000,
    }),
    line({
      id: "r",
      day: "2026-10-02",
      state: "rejected",
      claimedPaise: 9_000,
    }),
  ];
  const payouts = [
    pay("p", "2026-10-03", 5_000),
    pay("v", "2026-10-02", 1_000, true),
  ];
  const s = statement(lines, payouts);
  assert.deepEqual(
    s.map((e) => (e.kind === "line" ? e.line.id : e.payout.id)),
    ["a", "r", "v", "b", "p"],
  );
  assert.deepEqual(
    s.map((e) => e.balancePaise),
    [6_000, 6_000, 6_000, 10_000, 5_000],
  );
  assert.equal(s.at(-1)!.balancePaise, ledgerTotals(lines, payouts).duePaise);
});
