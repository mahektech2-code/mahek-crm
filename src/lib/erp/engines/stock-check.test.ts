import test from "node:test";
import assert from "node:assert/strict";
import {
  abcClasses,
  causeCandidates,
  controlStep,
  cycleDaysFor,
  daysBetween,
  gateCountStatus,
  judgeCount,
  pickCycleCounts,
  recountOutcome,
  reorderJustification,
  stockGate,
  toleranceFor,
  type CycleCandidate,
} from "./stock-check";

/* Inventory Accuracy Control's rules, pinned. */

test("tolerance is a share of the book, never below its floor", () => {
  assert.equal(toleranceFor(1000, 2, 1), 20);
  assert.equal(toleranceFor(10, 2, 1), 1);
  assert.equal(toleranceFor(0, 5, 0.5), 0.5);
});

test("a count is held against the RECONCILED book: goods at the gate are not a discrepancy", () => {
  const j = judgeCount({ counted: 1200, book: 1000, pendingIn: 200, pendingOut: 0, tolerancePercent: 2, toleranceFloor: 0 });
  assert.equal(j.reconciled, 1200);
  assert.equal(j.verdict, "matched");
  assert.equal(j.direction, "exact");
});

test("a difference beyond tolerance is a red flag, either way", () => {
  const short = judgeCount({ counted: 950, book: 1000, pendingIn: 0, pendingOut: 0, tolerancePercent: 2, toleranceFloor: 0 });
  assert.equal(short.verdict, "flagged");
  assert.equal(short.direction, "short");
  assert.equal(short.difference, -50);
  const within = judgeCount({ counted: 985, book: 1000, pendingIn: 0, pendingOut: 0, tolerancePercent: 2, toleranceFloor: 0 });
  assert.equal(within.verdict, "matched");
  const surplus = judgeCount({ counted: 1100, book: 1000, pendingIn: 0, pendingOut: 0, tolerancePercent: 2, toleranceFloor: 0 });
  assert.equal(surplus.direction, "surplus");
  assert.equal(surplus.verdict, "flagged");
});

test("an independent recount decides which count to believe", () => {
  assert.equal(recountOutcome({ first: 900, second: 1000, reconciled: 1000, tolerance: 10 }), "book_confirmed");
  assert.equal(recountOutcome({ first: 900, second: 905, reconciled: 1000, tolerance: 10 }), "discrepancy_confirmed");
  assert.equal(recountOutcome({ first: 900, second: 950, reconciled: 1000, tolerance: 10 }), "inconsistent");
});

test("ABC splits by the value that moved; nothing moved is C", () => {
  const m = abcClasses([
    { key: "a", value: 700 },
    { key: "b", value: 200 },
    { key: "c", value: 60 },
    { key: "d", value: 40 },
    { key: "e", value: 0 },
  ]);
  assert.equal(m.get("a"), "A");
  assert.equal(m.get("b"), "B");
  assert.equal(m.get("c"), "C");
  assert.equal(m.get("d"), "C");
  assert.equal(m.get("e"), "C");
});

test("a recent discrepancy halves the cycle", () => {
  assert.equal(cycleDaysFor({ abc: "A", discrepancies: 0 }, { A: 30, B: 60, C: 90 }), 30);
  assert.equal(cycleDaysFor({ abc: "A", discrepancies: 1 }, { A: 30, B: 60, C: 90 }), 15);
});

test("today's cycle counts: the overdue, the valuable, the busy and the wrong first", () => {
  const days = { A: 30, B: 60, C: 90 };
  const c = (key: string, x: Partial<CycleCandidate>): CycleCandidate => ({ key, abc: "C", lastCounted: "2026-10-01", movements: 0, discrepancies: 0, hasOpenCount: false, ...x });
  const picks = pickCycleCounts(
    [
      c("fresh", { abc: "A", lastCounted: "2026-10-05" }),
      c("never", { abc: "B", lastCounted: null }),
      c("wrongA", { abc: "A", lastCounted: "2026-09-20", discrepancies: 1 }),
      c("open", { abc: "A", lastCounted: null, hasOpenCount: true }),
      c("oldC", { abc: "C", lastCounted: "2026-06-01" }),
    ],
    "2026-10-11",
    days,
    10,
  );
  const keys = picks.map((p) => p.key);
  assert.ok(!keys.includes("fresh"), "counted within its cycle");
  assert.ok(!keys.includes("open"), "already waiting on a count");
  assert.deepEqual(keys, ["wrongA", "never", "oldC"]);
  assert.equal(pickCycleCounts([c("x", { lastCounted: null })], "2026-10-11", days, 0).length, 0);
});

test("daysBetween is calendar days", () => {
  assert.equal(daysBetween("2026-09-30", "2026-10-11"), 11);
});

test("even a matching count must justify the quantity", () => {
  const ok = reorderJustification({ requested: 500, onShelf: 300, min: 200, max: 800, allowancePercent: 25 });
  assert.equal(ok.justified, 500);
  assert.equal(ok.unexpected, false);
  const tooMuch = reorderJustification({ requested: 900, onShelf: 300, min: 200, max: 800, allowancePercent: 25 });
  assert.equal(tooMuch.unexpected, true);
  const full = reorderJustification({ requested: 10, onShelf: 900, min: 200, max: 800, allowancePercent: 25 });
  assert.equal(full.justified, 0);
  assert.equal(full.unexpected, true);
  assert.equal(reorderJustification({ requested: 10, onShelf: 0, min: null, max: null, allowancePercent: 25 }).justified, null);
});

test("causes: a record that accounts for the gap is likely; a shortage nothing explains is physical", () => {
  const surplus = causeCandidates(200, 5, [
    { kind: "under_test", qty: 200, label: "PR 41 under test", screen: "testing", ids: ["t1"] },
    { kind: "recent_issue", qty: 50, label: "SFG 9", screen: "sfgBatches", ids: ["s1"] },
  ]);
  assert.equal(surplus[0].likelihood, "likely");
  assert.equal(surplus[0].title.startsWith("Goods under test"), true);
  assert.ok(!surplus.some((c) => c.detail === "SFG 9"), "an issue cannot explain a surplus");

  const short = causeCandidates(-80, 5, []);
  assert.equal(short.length, 1);
  assert.equal(short[0].missing, "physical");
  assert.equal(short[0].likelihood, "likely");

  const twoAddUp = causeCandidates(-100, 2, [
    { kind: "recent_issue", qty: 60, label: "a", screen: "x", ids: [] },
    { kind: "recent_issue", qty: 40, label: "b", screen: "x", ids: [] },
  ]);
  assert.equal(twoAddUp.filter((c) => c.likelihood === "likely" && c.missing === "transaction").length, 2);
  assert.deepEqual(causeCandidates(3, 5, []), [], "within tolerance there is nothing to explain");
});

test("the gate holds the purchase until the count matches, is resolved, or an exception is approved", () => {
  const g = (x: Partial<Parameters<typeof stockGate>[0]>) => stockGate({ required: true, countStatus: null, exception: null, unexpectedQty: false, qtyConfirmed: false, ...x });
  assert.equal(stockGate({ required: false, countStatus: null, exception: null, unexpectedQty: true, qtyConfirmed: false }).blocks, false);
  assert.equal(g({}).state, "to_count");
  assert.equal(g({ countStatus: "open" }).blocks, true);
  assert.equal(g({ countStatus: "flagged" }).state, "flagged");
  assert.equal(g({ countStatus: "investigating" }).blocks, true);
  assert.equal(g({ countStatus: "matched" }).blocks, false);
  assert.equal(g({ countStatus: "resolved" }).blocks, false);
  assert.equal(g({ countStatus: "flagged", exception: "requested" }).state, "exception_requested");
  assert.equal(g({ countStatus: "flagged", exception: "approved" }).blocks, false);
  assert.equal(g({ countStatus: "flagged", exception: "rejected" }).state, "flagged");
  assert.equal(g({ countStatus: "matched", unexpectedQty: true }).state, "confirm_qty");
  assert.equal(g({ countStatus: "matched", unexpectedQty: true, qtyConfirmed: true }).blocks, false);
});

test("the gate reads the newest live root count", () => {
  const t = (s: string) => new Date(s);
  assert.equal(gateCountStatus([]), null);
  assert.equal(gateCountStatus([{ status: "flagged", createdAt: t("2026-10-01") }, { status: "open", createdAt: t("2026-10-02") }]), "open");
  assert.equal(gateCountStatus([{ status: "matched", createdAt: t("2026-10-01") }, { status: "cancelled", createdAt: t("2026-10-02") }]), "matched");
  assert.equal(gateCountStatus([{ status: "cancelled", createdAt: t("2026-10-01") }]), "cancelled");
});

test("control steps", () => {
  assert.equal(controlStep("open"), 0);
  assert.equal(controlStep("flagged"), 2);
  assert.equal(controlStep("investigating", true), 4);
  assert.equal(controlStep("resolved"), 5);
  assert.equal(controlStep("cancelled"), -1);
});
