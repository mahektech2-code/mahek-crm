import { test } from "node:test";
import assert from "node:assert/strict";
import { adjusted, denseSeries, forecastTotal, planLevel, roundUp, seasonalFactors, weekOfMonth, type DayQty, type PlanConfig } from "./stock-plan";

const CFG: PlanConfig = { coverDays: 10.5, orderCycleDays: 7, recentWeeks: 8, minHistoryWeeks: 4 };

/** Every day from `from` for `days` days, the quantity a function of the date. */
function daily(from: string, days: number, qty: (y: number, m: number, d: number) => number): DayQty[] {
  const out: DayQty[] = [];
  const t0 = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  for (let i = 0; i < days; i++) {
    const t = new Date(t0 + i * 86_400_000);
    const y = t.getUTCFullYear();
    const m = t.getUTCMonth();
    const d = t.getUTCDate();
    out.push({ date: `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`, qty: qty(y, m, d) });
  }
  return out;
}

test("week of month buckets: 1–7, 8–14, 15–21, 22–28, 29–31", () => {
  assert.deepEqual([1, 7, 8, 14, 15, 22, 28, 29, 31].map(weekOfMonth), [0, 0, 1, 1, 2, 3, 3, 4, 4]);
});

test("the series ends yesterday and ignores today and later", () => {
  const s = denseSeries([{ date: "2026-10-01", qty: 5 }, { date: "2026-10-19", qty: 99 }], "2026-10-19");
  assert.equal(s.qty.length, 18);
  assert.equal(s.qty.reduce((a, b) => a + b, 0), 5);
});

test("steady use of 10 a day plans 105 for a week and a half", () => {
  const use = daily("2024-10-01", 750, () => 10);
  const p = planLevel({ use, purchases: [], today: "2026-10-20", config: CFG })!;
  assert.ok(p);
  assert.equal(p.rateFrom, "use");
  /* 10.5 days × 10, rounded up to a multiple of 10 above 100. */
  assert.equal(p.min, 110);
  assert.ok(Math.abs(p.coverForecast - 105) < 1, String(p.coverForecast));
  assert.ok(p.max >= p.min);
  assert.equal(p.confidence, "high");
  for (const f of p.monthFactor) assert.ok(Math.abs(f - 1) < 0.05);
});

test("a busy October raises the level planned in October, not in June", () => {
  const use = daily("2023-06-01", 1230, (_y, m) => (m === 9 ? 20 : 10));
  const oct = planLevel({ use, purchases: [], today: "2026-10-05", config: CFG })!;
  const jun = planLevel({ use, purchases: [], today: "2026-06-05", config: CFG })!;
  assert.ok(oct.monthFactor[9] > 1.4, String(oct.monthFactor[9]));
  assert.ok(oct.min > jun.min * 1.4, `${oct.min} vs ${jun.min}`);
  assert.ok(oct.notes.some((n) => n.startsWith("Oct runs")));
});

test("a heavy last week of each month is read as its own pattern", () => {
  const use = daily("2024-01-01", 1000, (_y, _m, d) => (d >= 22 ? 30 : 10));
  const f = seasonalFactors(denseSeries(use, "2026-10-20"));
  assert.ok(f.week[3] > 1.5 && f.week[0] < 0.8, JSON.stringify(f.week));
  /* A window over the 22nd–28th forecasts more than one over the 1st–7th. */
  const p = planLevel({ use, purchases: [], today: "2026-10-01", config: CFG })!;
  const early = forecastTotal(p.baseDaily, p.monthFactor, p.weekOfMonthFactor, Math.floor(Date.UTC(2026, 9, 1) / 86_400_000), 7);
  const late = forecastTotal(p.baseDaily, p.monthFactor, p.weekOfMonthFactor, Math.floor(Date.UTC(2026, 9, 22) / 86_400_000), 7);
  assert.ok(late > early * 2, `${late} vs ${early}`);
});

test("purchases alone give a plan when production use is not recorded", () => {
  /* A drum of 200 every 20 days: 10 a day on average. */
  const purchases = daily("2024-10-01", 750, (_y, _m, d) => (d === 1 || d === 21 ? 200 : 0));
  const p = planLevel({ use: [], purchases, today: "2026-10-20", config: CFG })!;
  assert.equal(p.rateFrom, "purchases");
  assert.ok(p.min >= 70 && p.min <= 200, String(p.min));
});

test("longer purchase history gives the seasonality while use gives the rate", () => {
  const purchases = daily("2023-06-01", 1230, (_y, m) => (m === 9 ? 40 : 20));
  const use = daily("2026-05-01", 170, () => 10);
  const p = planLevel({ use, purchases, today: "2026-10-05", config: CFG })!;
  assert.equal(p.rateFrom, "use");
  assert.equal(p.seasonFrom, "purchases");
  assert.ok(p.monthFactor[9] > 1.3);
});

test("too little history plans nothing", () => {
  const use = daily("2026-10-10", 9, () => 5);
  assert.equal(planLevel({ use, purchases: [], today: "2026-10-19", config: CFG }), null);
});

test("one bulk purchase does not set the rate by itself", () => {
  const use = daily("2025-10-01", 380, (_y, m, d) => (m === 8 && d === 15 ? 3000 : 10));
  const p = planLevel({ use, purchases: [], today: "2026-10-16", config: CFG })!;
  /* Uncapped, the spike would add ~37/day to the recent average. */
  assert.ok(p.baseDaily < 30, String(p.baseDaily));
});

test("the AI's factor is held inside the limit and never puts max below min", () => {
  assert.deepEqual(adjusted({ min: 100, max: 170 }, 3, 30), { min: 130, max: 230, factor: 1.3 });
  assert.deepEqual(adjusted({ min: 100, max: 170 }, 0.1, 30), { min: 70, max: 120, factor: 0.7 });
  assert.deepEqual(adjusted({ min: 100, max: 170 }, null, 30), { min: 100, max: 170, factor: 1 });
});

test("quantities round up to something a person orders", () => {
  assert.deepEqual([0, 0.2, 7.1, 12, 101].map(roundUp), [0, 1, 8, 15, 110]);
});
