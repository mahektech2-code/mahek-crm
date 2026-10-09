import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decideCustomerMatch, foldShopName, matchSalesmanName } from "./field-activity-match";

describe("matchSalesmanName", () => {
  const candidates = [
    { id: "u1", name: "Prakash Vasudev Prasad" },
    { id: "u2", name: "Vinod Verma" },
    { id: "u3", name: "Rahul Richhariya" },
  ];

  test("an exact-fold match resolves, case and spacing aside", () => {
    assert.deepEqual(matchSalesmanName("VINOD VERMA", candidates), {
      status: "matched",
      matchedId: "u2",
      note: null,
    });
    assert.deepEqual(matchSalesmanName("  Rahul   Richhariya ", candidates), {
      status: "matched",
      matchedId: "u3",
      note: null,
    });
  });

  test("no fold match is unmatched, not guessed at", () => {
    assert.deepEqual(matchSalesmanName("Somebody Else", candidates), {
      status: "unmatched",
      matchedId: null,
      note: null,
    });
  });

  test("blank is unmatched", () => {
    assert.deepEqual(matchSalesmanName("", candidates), {
      status: "unmatched",
      matchedId: null,
      note: null,
    });
    assert.deepEqual(matchSalesmanName(null, candidates), {
      status: "unmatched",
      matchedId: null,
      note: null,
    });
  });

  test("more than one account folding to the same name is ambiguous, never picked at random", () => {
    const dupes = [...candidates, { id: "u4", name: "vinod verma" }];
    const result = matchSalesmanName("Vinod Verma", dupes);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedId, null);
    assert.ok(result.note?.includes("u2"));
    assert.ok(result.note?.includes("u4"));
  });
});

describe("foldShopName", () => {
  test("case, spacing and punctuation are not part of a name", () => {
    assert.equal(foldShopName("  K. Ramsing   sales "), "K RAMSING SALES");
    assert.equal(foldShopName("K RAMSING SALES"), "K RAMSING SALES");
  });
  test("every other character is", () => {
    assert.notEqual(foldShopName("Shree Ganesh Paints"), foldShopName("Shree Ganesh Paint"));
    assert.notEqual(foldShopName("Shri Traders"), foldShopName("Shree Traders"));
  });
});

describe("decideCustomerMatch", () => {
  test("nothing exact and nothing close is unmatched", () => {
    assert.deepEqual(decideCustomerMatch({ exact: [] }), { status: "unmatched", matchedId: null, note: null });
    assert.equal(
      decideCustomerMatch({ exact: [], near: [{ id: "c1", name: "some shop", score: 0.1 }] }).status,
      "unmatched",
    );
  });

  test("exactly one account with the same name is a match", () => {
    assert.deepEqual(decideCustomerMatch({ exact: [{ id: "c1", name: "Hira Hardware" }] }), {
      status: "matched",
      matchedId: "c1",
      note: null,
    });
  });

  test("two accounts with the same name are a question, named with their towns", () => {
    const r = decideCustomerMatch({
      exact: [
        { id: "c1", name: "Balaji Traders", city: "Ajmer" },
        { id: "c2", name: "Balaji Traders", city: "Mumbai" },
      ],
    });
    assert.equal(r.status, "ambiguous");
    assert.equal(r.matchedId, null);
    assert.ok(r.note?.includes("Ajmer") && r.note?.includes("Mumbai"));
  });

  test("a close name is NEVER linked, however close", () => {
    const r = decideCustomerMatch({
      exact: [],
      near: [
        { id: "c1", name: "Shree Ganesh Paint House", score: 0.95 },
        { id: "c2", name: "Kira Hardware", score: 0.31 },
      ],
    });
    assert.equal(r.status, "ambiguous");
    assert.equal(r.matchedId, null);
    assert.ok(r.note?.includes("Shree Ganesh Paint House"));
  });

  test("a person's decision wins, both ways", () => {
    const linked = decideCustomerMatch({
      exact: [{ id: "c1", name: "A" }, { id: "c2", name: "A" }],
      decision: { customerId: "c2" },
    });
    assert.equal(linked.status, "matched");
    assert.equal(linked.matchedId, "c2");
    const none = decideCustomerMatch({
      exact: [{ id: "c1", name: "A" }],
      decision: { customerId: null },
    });
    assert.equal(none.status, "unmatched");
    assert.equal(none.matchedId, null);
  });
});
