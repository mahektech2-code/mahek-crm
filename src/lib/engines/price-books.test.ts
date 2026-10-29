/**
 * Price books, changes, the instruction engine and overrides — every rule
 * that needs no database.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  approvalRefusal,
  cellKey,
  changedCells,
  countChanges,
  diffRates,
  goLiveProblem,
  ladderBreaks,
  largestDrop,
  needsSecondApprover,
  openFlags,
  ratesHash,
  revenueEffect,
  runChecks,
  stageOf,
  submitRefusal,
  suggestTypoFix,
  type ChangeRate,
} from "./price-change";
import { applyInstruction, describeRule, parseSimpleInstruction, ruleQuestions, EMPTY_TARGET, type InstructionRule } from "./price-instruction";
import { dueForReminder, liveOverride, overrideProblem, overrideState, plannedAgreedRates, type OverrideLike } from "./price-overrides";
import { inclFromEx } from "./price-math";

const GST = 1800;
const rate = (productId: string, ex: number, opts: Partial<ChangeRate> = {}): ChangeRate => ({
  productId,
  productName: opts.productName ?? `Product ${productId}`,
  family: opts.family ?? "Nano",
  millilitresPerCan: opts.millilitresPerCan ?? 1000,
  minCans: opts.minCans ?? null,
  rateExGstPaise: ex,
  rateInclGstPaise: opts.rateInclGstPaise ?? inclFromEx(ex, GST),
  offered: opts.offered ?? true,
});

describe("diffRates", () => {
  test("classifies every cell", () => {
    const base = [rate("a", 10000), rate("b", 20000), rate("c", 30000), rate("d", 40000)];
    const draft = [rate("a", 10500), rate("b", 19000), rate("c", 30000), rate("e", 5000)];
    const d = diffRates(base, draft);
    const by = Object.fromEntries(d.map((x) => [x.productId, x.kind]));
    assert.deepEqual(by, { a: "up", b: "down", c: "same", d: "removed", e: "added" });
    assert.equal(d.find((x) => x.productId === "a")!.changeBp, 500);
    assert.equal(changedCells(d).length, 4);
  });
  test("a slab is its own cell", () => {
    const base = [rate("a", 10000), rate("a", 9500, { minCans: 50 })];
    const draft = [rate("a", 10000), rate("a", 9000, { minCans: 50 })];
    const d = changedCells(diffRates(base, draft));
    assert.equal(d.length, 1);
    assert.equal(d[0].key, cellKey("a", 50));
  });
  test("offered flipped is its own kind", () => {
    const d = diffRates([rate("a", 100)], [rate("a", 100, { offered: false })]);
    assert.equal(d[0].kind, "offer_changed");
  });
  test("counts", () => {
    const c = countChanges(diffRates([rate("a", 10000), rate("b", 10000)], [rate("a", 11000), rate("b", 9700)]));
    assert.equal(c.changed, 2);
    assert.equal(c.up, 1);
    assert.equal(c.down, 1);
    assert.equal(c.averageBp, 350);
    assert.equal(c.largestBp, 1000);
  });
});

describe("revenueEffect", () => {
  test("multiplies the move by monthly cans; slabs not double counted", () => {
    const base = [rate("a", 10000), rate("a", 9500, { minCans: 50 }), rate("b", 20000)];
    const draft = [rate("a", 10200), rate("a", 9600, { minCans: 50 }), rate("b", 19000)];
    const e = revenueEffect(diffRates(base, draft), new Map([["a", 10], ["b", 3]]));
    assert.equal(e.totalPerMonthPaise, 200 * 10 - 1000 * 3);
    assert.equal(e.dropPerMonthPaise, -3000);
    assert.equal(e.rows.length, 2);
    assert.equal(e.rows[0].productId, "b");
  });
});

describe("checks", () => {
  const base = [rate("a", 10000, { millilitresPerCan: 1000 }), rate("b", 90000, { millilitresPerCan: 10000 })];
  const input = (draft: ChangeRate[], extra: Partial<Parameters<typeof runChecks>[0]> = {}) =>
    runChecks({
      base,
      draft,
      gstBp: GST,
      derived: false,
      goLive: "2026-11-15",
      baseEffectiveFrom: "2026-10-01",
      today: "2026-11-01",
      neighbours: [],
      overrides: [],
      bigMoveBp: 1500,
      typoFactor: 5,
      ...extra,
    });
  test("nothing changed blocks", () => {
    const f = input(base);
    assert.ok(f.some((x) => x.kind === "no_change" && x.blocking));
  });
  test("zero price blocks", () => {
    const f = input([rate("a", 0, { rateInclGstPaise: 0 }), base[1]]);
    assert.ok(f.some((x) => x.kind === "zero_or_negative" && x.blocking));
  });
  test("removed product is a flag, not a block", () => {
    const f = input([rate("a", 10500)]);
    const r = f.find((x) => x.kind === "removed_vs_live")!;
    assert.equal(r.blocking, false);
  });
  test("big move", () => {
    const f = input([rate("a", 13000), base[1]]);
    assert.ok(f.some((x) => x.kind === "big_move"));
  });
  test("gst mismatch", () => {
    const f = input([rate("a", 10500, { rateInclGstPaise: 99900 }), base[1]]);
    assert.ok(f.some((x) => x.kind === "gst_round_trip"));
  });
  test("past go-live blocks, and before the base's own start", () => {
    assert.ok(input([rate("a", 10500), base[1]], { goLive: "2026-10-30" }).some((x) => x.kind === "date_past" && x.blocking));
    assert.equal(goLiveProblem("2026-10-01", "2026-09-01", "2026-10-01")?.kind, "date_before_base");
    assert.equal(goLiveProblem("2026-11-05", "2026-11-01", "2026-10-01"), null);
  });
  test("ladder: bigger pack dearer per litre", () => {
    const flags = ladderBreaks([rate("s", 10000, { millilitresPerCan: 1000 }), rate("l", 120000, { millilitresPerCan: 10000 })]);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].productId, "l");
    assert.equal(ladderBreaks([rate("s", 10000, { millilitresPerCan: 1000 }), rate("l", 90000, { millilitresPerCan: 10000 })]).length, 0);
  });
  test("typo against neighbours, with a fix suggestion", () => {
    const f = input([rate("a", 1000), base[1]], {
      neighbours: [
        { bookName: "X", productId: "a", rateExGstPaise: 10200 },
        { bookName: "Y", productId: "a", rateExGstPaise: 9900 },
      ],
    });
    const t = f.find((x) => x.kind === "typo_vs_books")!;
    assert.match(t.message, /Did you mean ₹100/);
    assert.equal(suggestTypoFix(62500, 625800), 625000);
    assert.equal(suggestTypoFix(62500, 300000), null);
  });
  test("override dearer than the new book price", () => {
    const f = input([rate("a", 9000), base[1]], { overrides: [{ customerName: "Shree", productId: "a", rateExGstPaise: 9500 }] });
    assert.ok(f.some((x) => x.kind === "override_conflict"));
  });
  test("acknowledged flags stop blocking; blocking ones never do", () => {
    const f = input([rate("a", 13000)]);
    const ack = Object.fromEntries(f.filter((x) => !x.blocking).map((x) => [x.key, { note: "intended" }]));
    assert.equal(openFlags(f, ack).length, 0);
    const z = input([rate("a", 0, { rateInclGstPaise: 0 })]);
    const all = Object.fromEntries(z.map((x) => [x.key, { note: "x" }]));
    assert.ok(openFlags(z, all).length >= 1);
  });
});

describe("hash and stages", () => {
  test("hash is order-independent and moves with a price", () => {
    const a = [rate("a", 100), rate("b", 200)];
    assert.equal(ratesHash(a), ratesHash([...a].reverse()));
    assert.notEqual(ratesHash(a), ratesHash([rate("a", 101), rate("b", 200)]));
  });
  test("stage", () => {
    assert.equal(stageOf({ status: "draft", checkedHash: null, goLive: null }, "h", "2026-11-01"), "edit");
    assert.equal(stageOf({ status: "draft", checkedHash: "h", goLive: null }, "h", "2026-11-01"), "check");
    assert.equal(stageOf({ status: "draft", checkedHash: "old", goLive: null }, "h", "2026-11-01"), "edit");
    assert.equal(stageOf({ status: "submitted", checkedHash: "h", goLive: "2026-11-05" }, "h", "2026-11-01"), "approve");
    assert.equal(stageOf({ status: "approved", checkedHash: "h", goLive: "2026-11-05" }, "h", "2026-11-01"), "scheduled");
    assert.equal(stageOf({ status: "approved", checkedHash: "h", goLive: "2026-11-01" }, "h", "2026-11-01"), "live");
  });
});

describe("send and approve", () => {
  const base = { status: "draft", checkedHash: "h", currentHash: "h", flags: [], acks: {}, goLive: "2026-11-05", reason: "Diwali revision" };
  test("send needs a check that matches, a date, a reason", () => {
    assert.equal(submitRefusal(base), null);
    assert.match(submitRefusal({ ...base, checkedHash: null })!, /check/i);
    assert.match(submitRefusal({ ...base, checkedHash: "old" })!, /changed after/);
    assert.match(submitRefusal({ ...base, goLive: null })!, /day/);
    assert.match(submitRefusal({ ...base, reason: " " })!, /why/i);
    assert.match(submitRefusal({ ...base, status: "submitted" })!, /submitted/);
  });
  test("maker cannot approve their own; switch turns it off", () => {
    const a = { status: "submitted", makerId: "m", approverId: null, actorId: "m", makerChecker: true, needsSecond: false, checkedHash: "h", currentHash: "h" };
    assert.match(approvalRefusal(a)!, /somebody else/);
    assert.equal(approvalRefusal({ ...a, makerChecker: false }), null);
    assert.equal(approvalRefusal({ ...a, actorId: "x" }), null);
    assert.match(approvalRefusal({ ...a, actorId: "x", checkedHash: "old" })!, /changed after/);
  });
  test("second approver must be a third person", () => {
    const a = { status: "submitted", makerId: "m", approverId: "x", actorId: "x", makerChecker: true, needsSecond: true, checkedHash: "h", currentHash: "h" };
    assert.match(approvalRefusal(a)!, /already approved this/);
    assert.equal(approvalRefusal({ ...a, actorId: "y" }), null);
  });
  test("second approver thresholds", () => {
    const s = { aboveEffectPaise: 10_000_000, dropPercent: 10 };
    assert.equal(needsSecondApprover({ ...s, effectPerMonthPaise: 5_000_000, dropPerMonthPaise: 0, largestDropBp: null }), false);
    assert.equal(needsSecondApprover({ ...s, effectPerMonthPaise: 12_000_000, dropPerMonthPaise: 0, largestDropBp: null }), true);
    assert.equal(needsSecondApprover({ ...s, effectPerMonthPaise: 0, dropPerMonthPaise: 0, largestDropBp: -1200 }), true);
    assert.equal(needsSecondApprover({ ...s, effectPerMonthPaise: 0, dropPerMonthPaise: 0, largestDropBp: -800 }), false);
    assert.equal(largestDrop(diffRates([rate("a", 100), rate("b", 100)], [rate("a", 80), rate("b", 95)])), -2000);
  });
});

describe("instruction", () => {
  const rows = [
    rate("n1", 10000, { family: "Nano", millilitresPerCan: 1000, rateInclGstPaise: 11800 }),
    rate("n20", 180000, { family: "Nano", millilitresPerCan: 20000, rateInclGstPaise: 212400 }),
    rate("u1", 20000, { family: "Universal", millilitresPerCan: 1000, rateInclGstPaise: 23600 }),
  ];
  const rule = (r: Partial<InstructionRule>): InstructionRule => ({
    op: "percent",
    valueBp: 500,
    valuePaise: null,
    basis: "incl",
    target: EMPTY_TARGET,
    rounding: "rupee",
    exceptions: [],
    ...r,
  });
  test("+5% on inclusive, rounded to the rupee, stored ex-GST", () => {
    const p = applyInstruction(rows, rule({}), GST);
    const n1 = p.find((x) => x.productId === "n1")!;
    assert.equal(n1.afterInclPaise, 12400);
    assert.equal(n1.afterExPaise, Math.round((12400 * 10000) / 11800));
    assert.equal(p.length, 3);
  });
  test("exceptions hold", () => {
    const p = applyInstruction(rows, rule({ exceptions: [{ ...EMPTY_TARGET, families: ["nano"], action: "hold", valueBp: null, valuePaise: null }] }), GST);
    assert.deepEqual(p.map((x) => x.productId), ["u1"]);
  });
  test("per litre scales with the pack", () => {
    const p = applyInstruction(rows, rule({ op: "per_litre", valueBp: null, valuePaise: 200, rounding: "none", target: { ...EMPTY_TARGET, families: ["Nano"] } }), GST);
    assert.equal(p.find((x) => x.productId === "n20")!.afterInclPaise, 212400 + 4000);
  });
  test("pack bounds", () => {
    const p = applyInstruction(rows, rule({ target: { ...EMPTY_TARGET, minLitres: 10, maxLitres: null } }), GST);
    assert.deepEqual(p.map((x) => x.productId), ["n20"]);
  });
  test("a set exception moving against the rule is questioned", () => {
    const q = ruleQuestions(rows, rule({ exceptions: [{ ...EMPTY_TARGET, families: ["Universal"], action: "set", valueBp: null, valuePaise: 22000 }] }), GST);
    assert.ok(q.some((s) => /cut, not a hold/.test(s)));
  });
  test("describe", () => {
    assert.match(describeRule(rule({ exceptions: [{ ...EMPTY_TARGET, families: ["Nano"], action: "hold", valueBp: null, valuePaise: null }] })), /\+5%.*with GST.*every product.*rupee.*Nano held/);
  });
  test("simple sentences without a model", () => {
    const fams = ["Nano", "Universal"];
    assert.deepEqual(parseSimpleInstruction("everything up 5% round to rupee", fams)?.valueBp, 500);
    assert.equal(parseSimpleInstruction("cut 3 percent on Nano", fams)?.valueBp, -300);
    assert.deepEqual(parseSimpleInstruction("cut 3 percent on Nano", fams)?.target.families, ["Nano"]);
    const pl = parseSimpleInstruction("add ₹2 per litre except universal", fams)!;
    assert.equal(pl.op, "per_litre");
    assert.equal(pl.valuePaise, 200);
    assert.deepEqual(pl.exceptions.map((e) => e.families[0]), ["Universal"]);
    assert.equal(parseSimpleInstruction("make it nicer", fams), null);
    assert.equal(parseSimpleInstruction("+10 per can before gst", fams)?.basis, "ex");
  });
});

describe("overrides", () => {
  const o = (p: Partial<OverrideLike & { remindedAt: string | null }>): OverrideLike & { remindedAt: string | null } => ({
    id: p.id ?? "o1",
    productId: p.productId ?? "a",
    rateExGstPaise: p.rateExGstPaise ?? 9000,
    rateInclGstPaise: p.rateInclGstPaise ?? inclFromEx(p.rateExGstPaise ?? 9000, GST),
    validFrom: p.validFrom ?? "2026-10-01",
    validTo: p.validTo ?? null,
    cancelledAt: p.cancelledAt ?? null,
    createdAt: p.createdAt ?? "2026-10-01T00:00:00Z",
    remindedAt: p.remindedAt ?? null,
  });
  test("state", () => {
    assert.equal(overrideState(o({ validFrom: "2026-11-05" }), "2026-11-01"), "scheduled");
    assert.equal(overrideState(o({ validTo: "2026-10-31" }), "2026-11-01"), "ended");
    assert.equal(overrideState(o({}), "2026-11-01"), "live");
    assert.equal(overrideState(o({ cancelledAt: "2026-10-10" }), "2026-11-01"), "cancelled");
  });
  test("renewal wins", () => {
    const l = liveOverride([o({ id: "a1", validFrom: "2026-09-01" }), o({ id: "a2", validFrom: "2026-10-15", rateExGstPaise: 8500 })], "a", "2026-11-01");
    assert.equal(l?.id, "a2");
  });
  test("plan keeps hand-typed rows, applies live, removes ended", () => {
    const current = [
      { productId: "manual", rateExGstPaise: 5000, rateInclGstPaise: 5900, minCans: null, offered: true },
      { productId: "a", rateExGstPaise: 9000, rateInclGstPaise: inclFromEx(9000, GST), minCans: null, offered: true },
      { productId: "b", rateExGstPaise: 7000, rateInclGstPaise: inclFromEx(7000, GST), minCans: null, offered: true },
    ];
    const plan = plannedAgreedRates(current, [o({ productId: "a", rateExGstPaise: 8800 }), o({ id: "b1", productId: "b", validTo: "2026-10-20" }), o({ id: "c1", productId: "c" })], "2026-11-01");
    assert.ok(plan.differs);
    assert.deepEqual(plan.repriced, ["a"]);
    assert.deepEqual(plan.removed, ["b"]);
    assert.deepEqual(plan.added, ["c"]);
    assert.deepEqual(plan.rows.map((r) => r.productId), ["a", "c", "manual"]);
    const steady = plannedAgreedRates(plan.rows, [o({ productId: "a", rateExGstPaise: 8800 }), o({ id: "b1", productId: "b", validTo: "2026-10-20" }), o({ id: "c1", productId: "c" })], "2026-11-01");
    assert.equal(steady.differs, false);
  });
  test("reminders and problems", () => {
    assert.equal(dueForReminder([o({ validTo: "2026-11-05" }), o({ id: "x", validTo: "2026-12-30" })], "2026-11-01", 7).length, 1);
    assert.match(overrideProblem({ rateExGstPaise: 0, validFrom: "2026-11-01", validTo: null, minCansPerMonth: null, today: "2026-11-01" })!, /above zero/);
    assert.match(overrideProblem({ rateExGstPaise: 10, validFrom: "2026-11-05", validTo: "2026-11-01", minCansPerMonth: null, today: "2026-11-01" })!, /before it starts/);
    assert.equal(overrideProblem({ rateExGstPaise: 10, validFrom: "2026-11-05", validTo: null, minCansPerMonth: 35, today: "2026-11-01" }), null);
  });
});
