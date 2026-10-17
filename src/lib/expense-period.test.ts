import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  inPeriod,
  periodQuery,
  readPeriod,
  stepPeriod,
} from "./expense-period";

const TODAY = "2026-10-09"; // a Friday

test("no period reads as this month, and an old ?month= link still opens its month", () => {
  const p = readPeriod({}, TODAY);
  assert.equal(p.kind, "month");
  assert.deepEqual([p.from, p.to], ["2026-10-01", "2026-10-31"]);
  const old = readPeriod({ month: "2026-09" }, TODAY);
  assert.deepEqual(
    [old.kind, old.from, old.to],
    ["month", "2026-09-01", "2026-09-30"],
  );
});

test("a week runs Monday to Sunday around the day named", () => {
  const p = readPeriod({ period: "week", on: TODAY }, TODAY);
  assert.deepEqual([p.from, p.to], ["2026-10-05", "2026-10-11"]);
  const prev = stepPeriod(p, -1)!;
  assert.deepEqual([prev.from, prev.to], ["2026-09-28", "2026-10-04"]);
});

test("a day steps a day, a month steps across a year", () => {
  const d = stepPeriod(
    readPeriod({ period: "day", on: "2026-10-01" }, TODAY),
    -1,
  )!;
  assert.deepEqual([d.from, d.to], ["2026-09-30", "2026-09-30"]);
  const m = stepPeriod(
    readPeriod({ period: "month", on: "2026-12-15" }, TODAY),
    1,
  )!;
  assert.deepEqual([m.from, m.to], ["2027-01-01", "2027-01-31"]);
});

test("a range is put in order, a lone end is one day, and it steps by its own length", () => {
  const r = readPeriod(
    { period: "range", from: "2026-10-10", to: "2026-10-01" },
    TODAY,
  );
  assert.deepEqual([r.from, r.to], ["2026-10-01", "2026-10-10"]);
  const one = readPeriod({ period: "range", from: "2026-10-03" }, TODAY);
  assert.deepEqual([one.from, one.to], ["2026-10-03", "2026-10-03"]);
  const next = stepPeriod(r, 1)!;
  assert.deepEqual([next.from, next.to], ["2026-10-11", "2026-10-20"]);
  assert.deepEqual(periodQuery(r), {
    period: "range",
    from: "2026-10-01",
    to: "2026-10-10",
  });
});

test("all time has no bounds and contains every day", () => {
  const a = readPeriod({ period: "all" }, TODAY);
  assert.equal(a.from, null);
  assert.equal(stepPeriod(a, 1), null);
  assert.ok(inPeriod(a, "2019-01-01"));
});

test("rubbish in the URL falls back rather than throwing", () => {
  const p = readPeriod({ period: "fortnight", on: "yesterday" }, TODAY);
  assert.deepEqual([p.kind, p.from], ["month", "2026-10-01"]);
});
