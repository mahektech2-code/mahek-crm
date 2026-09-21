import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markMs, numberVisits, otherMarks } from "./visit-marks";

const mark = (over: Partial<Parameters<typeof numberVisits>[0][number]> = {}) => ({
  salesmanId: "u1",
  entityType: "visit",
  customerId: "c1",
  visitStartAt: "2026-09-08T04:00:00.000Z",
  capturedAt: "2026-09-08T04:00:00.000Z",
  ...over,
});

describe("numbering the visits on a day", () => {
  it("numbers them in the order they were made, not the order they arrived", () => {
    const out = numberVisits([
      mark({ customerId: "c3", visitStartAt: "2026-09-08T09:00:00.000Z" }),
      mark({ customerId: "c1", visitStartAt: "2026-09-08T04:00:00.000Z" }),
      mark({ customerId: "c2", visitStartAt: "2026-09-08T06:30:00.000Z" }),
    ]);
    assert.deepEqual(
      out.map((v) => [v.customerId, v.seq]),
      [
        ["c1", 1],
        ["c2", 2],
        ["c3", 3],
      ],
    );
  });

  it("restarts the count for each salesman, because it is the order of HIS day", () => {
    const out = numberVisits([
      mark({ salesmanId: "u1", visitStartAt: "2026-09-08T04:00:00.000Z" }),
      mark({ salesmanId: "u2", visitStartAt: "2026-09-08T05:00:00.000Z" }),
      mark({ salesmanId: "u1", visitStartAt: "2026-09-08T06:00:00.000Z" }),
    ]);
    assert.deepEqual(
      out.map((v) => [v.salesmanId, v.seq]),
      [
        ["u1", 1],
        ["u2", 1],
        ["u1", 2],
      ],
    );
  });

  it("falls back to the fix where a visit carries no check-in time", () => {
    const out = numberVisits([
      mark({ customerId: "late", visitStartAt: null, capturedAt: "2026-09-08T08:00:00.000Z" }),
      mark({ customerId: "early", visitStartAt: null, capturedAt: "2026-09-08T03:00:00.000Z" }),
    ]);
    assert.deepEqual(out.map((v) => v.customerId), ["early", "late"]);
  });

  it("leaves everything that is not a nameable visit to the general layer", () => {
    const marks = [
      mark(),
      mark({ entityType: "expense", customerId: null }),
      /* A visit whose shop could not be resolved: still a mark somebody made,
         and not a pin that would open nothing. */
      mark({ entityType: "visit", customerId: null }),
    ];
    assert.equal(numberVisits(marks).length, 1);
    assert.deepEqual(
      otherMarks(marks).map((m) => m.entityType),
      ["expense", "visit"],
    );
  });

  it("reads a timestamp that arrived as a string, which is how they arrive", () => {
    assert.equal(markMs("2026-09-08T04:00:00.000Z"), Date.parse("2026-09-08T04:00:00.000Z"));
    assert.equal(markMs(new Date("2026-09-08T04:00:00.000Z")), Date.parse("2026-09-08T04:00:00.000Z"));
    assert.equal(markMs(null), 0);
    assert.equal(markMs("not a date"), 0);
  });
});
