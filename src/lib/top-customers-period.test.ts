import test from "node:test";
import assert from "node:assert/strict";
import { addMonthsKey, currentReportMonth, monthsCovered } from "./top-customers-period";

const IST = "Asia/Kolkata";

test("month arithmetic crosses years both ways", () => {
  assert.equal(addMonthsKey("2026-01", -1), "2025-12");
  assert.equal(addMonthsKey("2025-12", 1), "2026-01");
  assert.equal(addMonthsKey("2026-10", -12), "2025-10");
});

test("a report covers whole months ending with the one just finished", () => {
  assert.deepEqual(monthsCovered("2026-10", 3), ["2026-07", "2026-08", "2026-09"]);
  assert.equal(monthsCovered("2026-10", 12)[0], "2025-10");
  assert.equal(monthsCovered("2026-10", 12).at(-1), "2026-09");
  assert.deepEqual(monthsCovered("2026-02", 3), ["2025-11", "2025-12", "2026-01"]);
});

test("the new report is current from 10:00 IST on the 1st, not midnight", () => {
  // 1 Oct 09:59 IST = 04:29 UTC — still September's report.
  assert.equal(currentReportMonth(Date.UTC(2026, 9, 1, 4, 29), IST), "2026-09");
  // 1 Oct 10:00 IST = 04:30 UTC.
  assert.equal(currentReportMonth(Date.UTC(2026, 9, 1, 4, 30), IST), "2026-10");
  // 30 Sep 20:00 UTC is already 1 Oct 01:30 IST, and still before ten.
  assert.equal(currentReportMonth(Date.UTC(2026, 8, 30, 20, 0), IST), "2026-09");
  assert.equal(currentReportMonth(Date.UTC(2026, 9, 4, 6, 0), IST), "2026-10");
  // January's turn crosses the year.
  assert.equal(currentReportMonth(Date.UTC(2027, 0, 1, 3, 0), IST), "2026-12");
});
