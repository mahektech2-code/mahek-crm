import test from "node:test";
import assert from "node:assert/strict";
import {
  PURCHASE_STATUSES,
  NON_PURCHASE_STATUSES,
  countsAsPurchase,
  orderCountsSql,
} from "@/lib/order-status";
import { orderStatusEnum } from "@/db/schema";

/**
 * "Did the business sell anything" has ONE definition, and this is what keeps
 * it that way.
 *
 * `orderCountsSql` used to spell the statuses out as a string beside an array
 * holding the same ones — two definitions, read by different halves of the
 * codebase. The SQL is read by the eight money queries (EOD value, targets, the
 * buying cycle, the product history, outstanding) and checked by nothing, so it
 * is the half that would have drifted, and it would have drifted silently and
 * only for orders that had got as far as being delivered.
 */

test("every order status is classified, one way or the other", () => {
  /* A status in neither list is one that silently does not count. The enum is
     the authority on what statuses exist, so it is what this is read against
     rather than a list typed out here. */
  const classified = new Set<string>([...PURCHASE_STATUSES, ...NON_PURCHASE_STATUSES]);
  const missing = orderStatusEnum.enumValues.filter((v) => !classified.has(v));
  assert.deepEqual(
    missing,
    [],
    `these order statuses are in neither list, so nothing knows whether they are a sale: ${missing.join(", ")}`,
  );
});

test("nothing is in both lists", () => {
  const both = PURCHASE_STATUSES.filter((s) =>
    (NON_PURCHASE_STATUSES as readonly string[]).includes(s),
  );
  assert.deepEqual(both, []);
});

/**
 * The fragment's own text.
 *
 * `sql.raw` wraps the string in a `StringChunk` inside `queryChunks`, which is
 * Drizzle's internal shape rather than a promised API — so this reads it in one
 * place and every test below goes through here. If a Drizzle upgrade moves it,
 * one helper fails loudly instead of six assertions passing vacuously against
 * an empty string.
 */
function renderedSql(alias: string): string {
  const chunks = (orderCountsSql(alias) as unknown as {
    queryChunks?: { value?: unknown }[];
  }).queryChunks;
  const text = chunks?.map((c) => (Array.isArray(c.value) ? c.value.join("") : "")).join("") ?? "";
  assert.ok(text.length > 0, "could not read the fragment's SQL — Drizzle's shape has moved");
  return text;
}

test("the SQL names exactly the statuses the array holds", () => {
  const rendered = renderedSql("o");

  for (const status of PURCHASE_STATUSES) {
    assert.ok(
      rendered.includes(`'${status}'`),
      `${status} counts as a purchase in TypeScript and is missing from the SQL`,
    );
  }
  for (const status of NON_PURCHASE_STATUSES) {
    assert.ok(
      !rendered.includes(`'${status}'`),
      `${status} does not count as a purchase and the SQL counts it`,
    );
  }
});

test("goods on a lorry are goods sold", () => {
  /* The reasoning behind §N's two: an order that reached the customer must not
     stop counting towards money and history merely because somebody recorded
     that it arrived. */
  assert.ok(countsAsPurchase("dispatched"));
  assert.ok(countsAsPurchase("in_transit"));
  assert.ok(countsAsPurchase("delivered"));
});

test("a declined order never counted, and still does not", () => {
  assert.ok(!countsAsPurchase("declined"));
  assert.ok(!countsAsPurchase("pending_approval"));
  assert.ok(!countsAsPurchase("cancelled"));
});

test("the alias is qualified, because an unqualified column binds inward", () => {
  /* Drizzle renders a bare column name as `"status"`, which inside a correlated
     subquery binds to the INNER table and makes the condition silently false.
     The alias is the whole reason this function takes an argument. */
  const rendered = renderedSql("o");
  assert.ok(rendered.startsWith("o.status in ("), rendered);
  /* And it really does take the alias rather than ignoring it. */
  assert.ok(renderedSql("orders").startsWith("orders.status in ("));
});
