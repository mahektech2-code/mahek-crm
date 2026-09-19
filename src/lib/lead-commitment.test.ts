import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commitmentGap,
  commitmentSizeLabel,
  commitmentState,
  confirmedCommitmentSql,
  isConfirmedCommitment,
} from "./lead-commitment";

/* ---------------------------------------------------------------------------
 * §3.4 — a day AND a size, and the three answers it can give.
 *
 * The rule is read by a client form, a server action and four queries, and the
 * queries cannot be exercised without a database — so what is pinned here is
 * the rule itself, which is the half every one of them shares.
 * ------------------------------------------------------------------------- */

const DAY = "2026-09-25";

test("a day with a quantity is a commitment", () => {
  assert.equal(
    commitmentState({
      expectedOrderDate: DAY,
      expectedOrderCans: 40,
      expectedOrderValuePaise: null,
    }),
    "confirmed",
  );
});

test("a day with a value is a commitment, because at commitment there is often no SKU", () => {
  assert.equal(
    commitmentState({
      expectedOrderDate: DAY,
      expectedOrderCans: null,
      expectedOrderValuePaise: 2_500_00,
    }),
    "confirmed",
  );
});

test("a day alone is an EXPECTED ORDER — recorded, and never counted", () => {
  const f = {
    expectedOrderDate: DAY,
    expectedOrderCans: null,
    expectedOrderValuePaise: null,
  };
  assert.equal(commitmentState(f), "expected");
  assert.equal(isConfirmedCommitment(f), false);
  /* The whole point of the shape: it is a real state with a real sentence,
     never a refusal. */
  assert.match(commitmentGap(f) ?? "", /forecast/);
});

test("a size with no day is nothing, because nobody can chase it", () => {
  assert.equal(
    commitmentState({
      expectedOrderDate: null,
      expectedOrderCans: 40,
      expectedOrderValuePaise: 2_500_00,
    }),
    "none",
  );
});

test("zero is a customer declining, not a customer committing", () => {
  assert.equal(
    commitmentState({
      expectedOrderDate: DAY,
      expectedOrderCans: 0,
      expectedOrderValuePaise: 0,
    }),
    "expected",
  );
});

test("a commitment has no gap to name", () => {
  assert.equal(
    commitmentGap({
      expectedOrderDate: DAY,
      expectedOrderCans: 1,
      expectedOrderValuePaise: null,
    }),
    null,
  );
});

test("the size is one phrasing, and an unanswered one says so rather than printing zero", () => {
  const money = (p: number) => `Rs ${p / 100}`;
  assert.equal(
    commitmentSizeLabel(
      { expectedOrderDate: DAY, expectedOrderCans: 1, expectedOrderValuePaise: 5_000_00 },
      money,
    ),
    "1 can · Rs 5000",
  );
  assert.equal(
    commitmentSizeLabel(
      { expectedOrderDate: DAY, expectedOrderCans: null, expectedOrderValuePaise: null },
      money,
    ),
    "No quantity or value given",
  );
});

test("the SQL says the same thing, and qualifies every column with the alias it was given", () => {
  const frag = confirmedCommitmentSql("c");
  for (const column of [
    "lead_expected_order_date",
    "lead_expected_order_cans",
    "lead_expected_order_value_paise",
  ]) {
    assert.ok(
      frag.includes(`c.${column}`),
      `${column} has to be qualified: a bare column inside a correlated subquery binds to the inner table and the condition silently becomes false`,
    );
  }
  /* And the shape is date AND (one OR the other), never either half. */
  assert.ok(frag.includes("and"));
  assert.ok(frag.includes("or"));
});
