import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { decideCustomerMatch, matchSalesmanName } from "./field-activity-match";

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

describe("decideCustomerMatch", () => {
  test("no candidates at all is unmatched", () => {
    assert.deepEqual(decideCustomerMatch([]), { status: "unmatched", matchedId: null, note: null });
  });

  test("candidates below the floor are unmatched, not treated as ambiguous", () => {
    const result = decideCustomerMatch([{ id: "c1", name: "some shop", score: 0.1 }]);
    assert.equal(result.status, "unmatched");
  });

  test("one clear leader over the threshold, well ahead of the field, matches", () => {
    const result = decideCustomerMatch([
      { id: "c1", name: "hira hardware", score: 0.95 },
      { id: "c2", name: "kira hardware", score: 0.4 },
    ]);
    assert.deepEqual(result, { status: "matched", matchedId: "c1", note: null });
  });

  test("a lone candidate over the threshold matches even with no runner-up", () => {
    const result = decideCustomerMatch([{ id: "c1", name: "hira hardware", score: 0.7 }]);
    assert.deepEqual(result, { status: "matched", matchedId: "c1", note: null });
  });

  test("two close candidates are ambiguous, never auto-picked", () => {
    const result = decideCustomerMatch([
      { id: "c1", name: "shree traders", score: 0.65 },
      { id: "c2", name: "shri traders", score: 0.62 },
    ]);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.matchedId, null);
    assert.ok(result.note?.includes("shree traders"));
    assert.ok(result.note?.includes("shri traders"));
  });

  test("a single candidate that clears the floor but not the match threshold is ambiguous, not matched", () => {
    const result = decideCustomerMatch([{ id: "c1", name: "some shop", score: 0.45 }]);
    assert.equal(result.status, "ambiguous");
  });
});
