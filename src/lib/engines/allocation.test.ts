import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  allocate,
  billBalance,
  oldestFirst,
  type AllocatableBill,
} from "./allocation";

/* E8 — payment allocation. Pure, so every case here is a plain function call. */

const bill = (
  id: string,
  billNo: string,
  billDate: string,
  amount: number,
  paid = 0,
): AllocatableBill => ({ id, billNo, billDate, amount, paid });

/** Three open bills, oldest first, in paise. */
const BOOK: AllocatableBill[] = [
  bill("b1", "INV-101", "2026-05-01", 10_000_00),
  bill("b2", "INV-102", "2026-05-20", 25_000_00),
  bill("b3", "INV-103", "2026-06-10", 15_000_00),
];

describe("E8 balances and ordering", () => {
  test("a balance never reads below zero", () => {
    assert.equal(billBalance({ amount: 1000, paid: 1500 }), 0);
  });

  test("oldest first, and the bill number breaks a tie", () => {
    const same = [
      bill("x", "INV-200", "2026-05-01", 100),
      bill("y", "INV-199", "2026-05-01", 100),
    ];
    assert.deepEqual(
      oldestFirst(same).map((b) => b.billNo),
      ["INV-199", "INV-200"],
    );
  });

  test("ordering does not mutate the list it was given", () => {
    const input = [...BOOK].reverse();
    const before = input.map((b) => b.id);
    oldestFirst(input);
    assert.deepEqual(
      input.map((b) => b.id),
      before,
    );
  });
});

describe("E8 auto — oldest bill first", () => {
  test("a payment covering two bills clears the oldest completely", () => {
    const r = allocate(BOOK, { mode: "auto", amount: 30_000_00 });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.lines, [
      { billId: "b1", billNo: "INV-101", amount: 10_000_00 },
      { billId: "b2", billNo: "INV-102", amount: 20_000_00 },
    ]);
    assert.equal(r.allocated, 30_000_00);
    assert.equal(r.onAccount, 0);
  });

  test("a part payment stops inside the oldest bill", () => {
    const r = allocate(BOOK, { mode: "auto", amount: 4_000_00 });
    assert.deepEqual(r.lines, [{ billId: "b1", billNo: "INV-101", amount: 4_000_00 }]);
  });

  test("what a bill has already taken is not offered twice", () => {
    const part = [bill("b1", "INV-101", "2026-05-01", 10_000_00, 7_000_00)];
    const r = allocate(part, { mode: "auto", amount: 5_000_00 });
    assert.deepEqual(r.lines, [
      { billId: "b1", billNo: "INV-101", amount: 3_000_00 },
      { billId: null, billNo: null, amount: 2_000_00 },
    ]);
  });

  test("a fully paid bill is skipped rather than allocated zero", () => {
    const settled = [
      bill("b0", "INV-100", "2026-04-01", 5_000_00, 5_000_00),
      ...BOOK,
    ];
    const r = allocate(settled, { mode: "auto", amount: 1_000_00 });
    assert.deepEqual(r.lines, [{ billId: "b1", billNo: "INV-101", amount: 1_000_00 }]);
  });
});

describe("E8 settle — these bills are cleared", () => {
  test("ticking two bills allocates both in full", () => {
    const r = allocate(BOOK, {
      mode: "settle",
      amount: 25_000_00,
      selectedBillIds: ["b1", "b3"],
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.lines, [
      { billId: "b1", billNo: "INV-101", amount: 10_000_00 },
      { billId: "b3", billNo: "INV-103", amount: 15_000_00 },
    ]);
  });

  test("money short of the ticked bills is refused, and says what it would take", () => {
    const r = allocate(BOOK, {
      mode: "settle",
      amount: 20_000_00,
      selectedBillIds: ["b1", "b3"],
    });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /₹25,000/);
    assert.match(r.errors[0], /₹20,000/);
  });

  test("ticking nothing is an error, not an empty allocation", () => {
    const r = allocate(BOOK, { mode: "settle", amount: 1000, selectedBillIds: [] });
    assert.match(r.errors[0], /Tick the bills/);
  });

  test("more money than the ticked bills leaves the rest on account", () => {
    const r = allocate(BOOK, {
      mode: "settle",
      amount: 12_000_00,
      selectedBillIds: ["b1"],
    });
    assert.deepEqual(r.errors, []);
    assert.equal(r.onAccount, 2_000_00);
    assert.deepEqual(r.lines.at(-1), { billId: null, billNo: null, amount: 2_000_00 });
  });
});

describe("E8 custom — this much against that bill", () => {
  test("an explicit split is honoured exactly", () => {
    const r = allocate(BOOK, {
      mode: "custom",
      amount: 12_000_00,
      custom: { b2: 8_000_00, b3: 4_000_00 },
    });
    assert.deepEqual(r.errors, []);
    assert.equal(r.allocated, 12_000_00);
    assert.equal(r.onAccount, 0);
  });

  test("more than a bill has open is refused, naming the bill", () => {
    const r = allocate(BOOK, {
      mode: "custom",
      amount: 20_000_00,
      custom: { b1: 20_000_00 },
    });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /INV-101 has only ₹10,000 open/);
  });

  test("a split larger than the money received is refused", () => {
    const r = allocate(BOOK, {
      mode: "custom",
      amount: 5_000_00,
      custom: { b1: 4_000_00, b2: 4_000_00 },
    });
    assert.ok(r.errors.some((e) => /more than the ₹5,000 received/.test(e)));
  });

  test("a split short of the money leaves the difference on account", () => {
    const r = allocate(BOOK, {
      mode: "custom",
      amount: 10_000_00,
      custom: { b1: 6_000_00 },
    });
    assert.deepEqual(r.errors, []);
    assert.equal(r.onAccount, 4_000_00);
  });
});

describe("E8 remainders and refusals", () => {
  test("money beyond every open bill goes on account", () => {
    const r = allocate(BOOK, { mode: "auto", amount: 60_000_00 });
    assert.deepEqual(r.errors, []);
    assert.equal(r.allocated, 50_000_00);
    assert.equal(r.onAccount, 10_000_00);
    assert.deepEqual(r.lines.at(-1), { billId: null, billNo: null, amount: 10_000_00 });
  });

  test("an advance against no bills at all is still a receipt", () => {
    const r = allocate([], { mode: "auto", amount: 5_000_00 });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.lines, [{ billId: null, billNo: null, amount: 5_000_00 }]);
  });

  test("with money on account switched off, a remainder is refused instead", () => {
    const r = allocate(BOOK, {
      mode: "auto",
      amount: 60_000_00,
      allowOnAccount: false,
    });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /₹10,000 is not against any bill/);
  });

  test("a zero or negative amount is refused before anything is allocated", () => {
    for (const amount of [0, -100]) {
      const r = allocate(BOOK, { mode: "auto", amount });
      assert.deepEqual(r.lines, []);
      assert.match(r.errors[0], /Enter the amount received/);
    }
  });

  test("paise are never invented — the lines always sum to the receipt", () => {
    for (const amount of [1, 999, 10_000_01, 49_999_99, 50_000_01]) {
      const r = allocate(BOOK, { mode: "auto", amount });
      const total = r.lines.reduce((sum, l) => sum + l.amount, 0);
      assert.equal(total, amount, `lines must sum to ${amount}`);
    }
  });
});
