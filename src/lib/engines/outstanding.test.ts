import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  groupOutstanding,
  outstandingTotals,
  type OutstandingBillInput,
} from "./outstanding";

const bill = (o: Partial<OutstandingBillInput> & { id: string; customerId: string }): OutstandingBillInput => ({
  billNo: `B/${o.id}`,
  customerName: o.customerId === "c1" ? "Alpha Paints" : "Beta Hardware",
  billDate: "2026-06-01",
  dueDate: "2026-07-01",
  amount: 100_000,
  paid: 0,
  balance: 100_000,
  overdueDays: 0,
  bucket: "0-30",
  disputed: false,
  paymentPosition: "stated",
  ...o,
});

describe("who owes what", () => {
  it("sums a customer's open bills into one row", () => {
    const rows = groupOutstanding([
      bill({ id: "a", customerId: "c1", balance: 60_000 }),
      bill({ id: "b", customerId: "c1", balance: 40_000 }),
      bill({ id: "c", customerId: "c2", balance: 25_000 }),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].customerId, "c1");
    assert.equal(rows[0].outstanding, 100_000);
    assert.equal(rows[0].openBills, 2);
    assert.equal(rows[1].outstanding, 25_000);
  });

  it("a bill nobody has spoken for is counted apart and never added to the debt", () => {
    // The rule `recomputeOutstanding` follows. An unstated bill came from a
    // spreadsheet that records what was billed and never what was received —
    // counting it as debt puts the whole order book on the collections list.
    const [row] = groupOutstanding([
      bill({ id: "a", customerId: "c1", balance: 60_000 }),
      bill({ id: "b", customerId: "c1", balance: 90_000, paymentPosition: "unstated" }),
    ]);
    assert.equal(row.outstanding, 60_000);
    assert.equal(row.openBills, 1);
    assert.equal(row.unstatedBills, 1);
    assert.equal(row.unstatedAmount, 90_000);
    // Shown, though — a bill open on the ledger and missing here reads as a
    // screen that lost it.
    assert.equal(row.bills.length, 2);
  });

  it("a customer with only unstated bills is listed rather than dropped", () => {
    const rows = groupOutstanding([
      bill({ id: "a", customerId: "c1", balance: 10_000 }),
      bill({ id: "b", customerId: "c2", balance: 900_000, paymentPosition: "unstated" }),
    ]);
    assert.deepEqual(rows.map((r) => r.customerId), ["c1", "c2"]);
    assert.equal(rows[1].outstanding, 0);
    assert.equal(rows[1].unstatedAmount, 900_000);
  });

  it("keeps the worst age and its bucket, from stated bills only", () => {
    const [row] = groupOutstanding([
      bill({ id: "a", customerId: "c1", overdueDays: 12, bucket: "0-30" }),
      bill({ id: "b", customerId: "c1", overdueDays: 71, bucket: "61-90" }),
      bill({ id: "c", customerId: "c1", overdueDays: 400, bucket: "90+", paymentPosition: "unstated" }),
    ]);
    assert.equal(row.oldestOverdueDays, 71);
    assert.equal(row.worstBucket, "61-90");
  });

  it("orders bills oldest due first, with unstated ones last", () => {
    const [row] = groupOutstanding([
      bill({ id: "a", customerId: "c1", dueDate: "2026-08-01" }),
      bill({ id: "b", customerId: "c1", dueDate: "2026-02-01", paymentPosition: "unstated" }),
      bill({ id: "c", customerId: "c1", dueDate: "2026-05-01" }),
    ]);
    assert.deepEqual(row.bills.map((b) => b.id), ["c", "a", "b"]);
  });

  it("a settled bill contributes nothing even if it is handed over", () => {
    const rows = groupOutstanding([
      bill({ id: "a", customerId: "c1", amount: 50_000, paid: 50_000, balance: 0 }),
    ]);
    assert.deepEqual(rows, []);
  });

  it("totals describe the rows, and keep the two kinds apart", () => {
    const t = outstandingTotals(
      groupOutstanding([
        bill({ id: "a", customerId: "c1", balance: 60_000, overdueDays: 10 }),
        bill({ id: "b", customerId: "c1", balance: 40_000 }),
        bill({ id: "c", customerId: "c2", balance: 25_000, paymentPosition: "unstated" }),
      ]),
    );
    assert.equal(t.customers, 1);
    assert.equal(t.outstanding, 100_000);
    assert.equal(t.bills, 2);
    assert.equal(t.overdueCustomers, 1);
    assert.equal(t.overdue, 60_000);
    assert.equal(t.unstatedCustomers, 1);
    assert.equal(t.unstatedAmount, 25_000);
  });
});
