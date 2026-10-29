import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeRate } from "@/lib/engines/price-change";
import { inclFromEx } from "@/lib/engines/price-math";
import {
  byMoneyAtStake,
  morningCheck,
  withoutDismissed,
  type MorningList,
  type MorningOverride,
} from "@/lib/engines/price-morning-check";

const TODAY = "2026-10-29";
const SETTINGS = { typoFactor: 5, expiringDays: 14, reminderDays: 7 };

function rate(productId: string, ml: number, ex: number, over: Partial<ChangeRate> = {}): ChangeRate {
  return {
    productId,
    productName: `Thinner - ${ml / 1000} L`,
    family: "Thinner",
    millilitresPerCan: ml,
    minCans: null,
    rateExGstPaise: ex,
    rateInclGstPaise: inclFromEx(ex, 1800),
    offered: true,
    ...over,
  };
}

function list(id: string, rates: ChangeRate[], over: Partial<MorningList> = {}): MorningList {
  return {
    listId: `${id}-v1`,
    bookId: id,
    name: `Book ${id}`,
    kind: "standard",
    gstBp: 1800,
    derived: false,
    expiresOn: null,
    hasScheduled: false,
    scopeCount: 1,
    rates,
    ...over,
  };
}

test("a clean set of books raises nothing", () => {
  const a = list("A", [rate("p1", 1000, 20000), rate("p5", 5000, 90000)]);
  const b = list("B", [rate("p1", 1000, 21000), rate("p5", 5000, 92000)]);
  assert.deepEqual(morningCheck({ today: TODAY, lists: [a, b], overrides: [], settings: SETTINGS }), []);
});

test("a ladder break and a 10x typo on a standard book are found", () => {
  const a = list("A", [rate("p1", 1000, 20000), rate("p5", 5000, 150000), rate("p20", 20000, 30000)]);
  const b = list("B", [rate("p1", 1000, 20500), rate("p5", 5000, 92000), rate("p20", 20000, 300000)]);
  const f = morningCheck({ today: TODAY, lists: [a, b], overrides: [], settings: SETTINGS });
  const ladder = f.filter((x) => x.kind === "ladder");
  assert.ok(ladder.some((x) => x.bookId === "A" && x.productId === "p5"), "5 L dearer per litre than 1 L");
  const typo = f.filter((x) => x.kind === "typo");
  assert.ok(typo.some((x) => x.bookId === "A" && x.productId === "p20"), "₹300 vs ₹3,000");
  assert.ok(typo.find((x) => x.productId === "p20" && x.bookId === "A")!.message.includes("Did you mean"));
  // Keys are stable across runs.
  const again = morningCheck({ today: TODAY, lists: [a, b], overrides: [], settings: SETTINGS });
  assert.deepEqual(again.map((x) => x.key), f.map((x) => x.key));
});

test("an agreed list is skipped for the ladder and the typo, never for GST", () => {
  const agreed = list("S", [rate("p1", 1000, 20000), rate("p5", 5000, 150000), rate("p20", 20000, 30000, { rateInclGstPaise: 99999 })], {
    kind: "agreed",
  });
  const b = list("B", [rate("p20", 20000, 300000)]);
  const f = morningCheck({ today: TODAY, lists: [agreed, b], overrides: [], settings: SETTINGS });
  assert.equal(f.filter((x) => x.bookId === "S" && (x.kind === "ladder" || x.kind === "typo")).length, 0);
  assert.equal(f.filter((x) => x.bookId === "S" && x.kind === "gst_mismatch").length, 1);
});

test("GST: a paisa is noise, a derived list may sit within a rupee", () => {
  const exact = list("A", [rate("p1", 1000, 193305, { rateInclGstPaise: 228100 })]);
  assert.equal(morningCheck({ today: TODAY, lists: [exact], overrides: [], settings: SETTINGS }).length, 0);
  const off = list("A", [rate("p1", 1000, 20000, { rateInclGstPaise: 23700 })]);
  const f = morningCheck({ today: TODAY, lists: [off], overrides: [], settings: SETTINGS });
  assert.equal(f[0].kind, "gst_mismatch");
  const derived = list("D", [rate("p1", 1000, 20000, { rateInclGstPaise: 23650 })], { derived: true });
  assert.equal(morningCheck({ today: TODAY, lists: [derived], overrides: [], settings: SETTINGS }).length, 0);
});

test("expiring with nothing scheduled is raised; scheduled or far off is not", () => {
  const soon = list("A", [rate("p1", 1000, 20000)], { expiresOn: "2026-11-02" });
  const f = morningCheck({ today: TODAY, lists: [soon], overrides: [], settings: SETTINGS });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "expiring_unscheduled");
  assert.equal(f[0].severity, "medium");
  const tomorrow = list("A", [rate("p1", 1000, 20000)], { expiresOn: "2026-10-30" });
  assert.equal(morningCheck({ today: TODAY, lists: [tomorrow], overrides: [], settings: SETTINGS })[0].severity, "high");
  const covered = list("A", [rate("p1", 1000, 20000)], { expiresOn: "2026-11-02", hasScheduled: true });
  assert.equal(morningCheck({ today: TODAY, lists: [covered], overrides: [], settings: SETTINGS }).length, 0);
  const far = list("A", [rate("p1", 1000, 20000)], { expiresOn: "2027-01-30" });
  assert.equal(morningCheck({ today: TODAY, lists: [far], overrides: [], settings: SETTINGS }).length, 0);
});

test("a published book that names nobody is raised", () => {
  const f = morningCheck({ today: TODAY, lists: [list("A", [rate("p1", 1000, 20000)], { scopeCount: 0 })], overrides: [], settings: SETTINGS });
  assert.equal(f[0].kind, "names_nobody");
});

test("overrides: ending soon, and a condition last month did not meet (with its give-away)", () => {
  const base: MorningOverride = {
    id: "o1",
    customerId: "c1",
    customerName: "Shop A",
    productId: "p1",
    productName: "Thinner - 1 L",
    rateExGstPaise: 18000,
    validTo: "2026-11-03",
    minCansPerMonth: 50,
    lastMonthCans: 20,
    bookExGstPaise: 20000,
    listId: "agreed1",
    bookId: "agreed1",
  };
  const f = morningCheck({ today: TODAY, lists: [], overrides: [base], settings: SETTINGS });
  const ending = f.find((x) => x.kind === "override_ending")!;
  assert.ok(ending.message.includes("5 days"));
  const unmet = f.find((x) => x.kind === "override_condition_unmet")!;
  assert.equal(unmet.moneyPaise, 2000 * 20);
  const far = morningCheck({ today: TODAY, lists: [], overrides: [{ ...base, validTo: null, lastMonthCans: 60 }], settings: SETTINGS });
  assert.equal(far.length, 0);
});

test("dismissed keys are dropped, and Needs-you sorts by money with unpriced rows last", () => {
  const f = morningCheck({ today: TODAY, lists: [list("A", [rate("p1", 1000, 20000)], { scopeCount: 0 })], overrides: [], settings: SETTINGS });
  assert.equal(withoutDismissed(f, new Set([f[0].key])).length, 0);
  const rows = [
    { title: "a", moneyPaise: null },
    { title: "b", moneyPaise: 500 },
    { title: "c", moneyPaise: -9000 },
    { title: "d", moneyPaise: 1000 },
  ];
  assert.deepEqual(byMoneyAtStake(rows).map((r) => r.title), ["c", "d", "b", "a"]);
});
