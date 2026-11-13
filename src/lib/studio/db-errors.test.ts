import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isUniqueViolation } from "./db-errors";

describe("isUniqueViolation", () => {
  test("finds the PostgreSQL code on the error itself and on a wrapped cause, at any depth Drizzle uses", () => {
    assert.equal(isUniqueViolation({ code: "23505" }), true);
    assert.equal(isUniqueViolation(Object.assign(new Error("Failed query"), { cause: { code: "23505" } })), true);
    assert.equal(isUniqueViolation({ cause: { cause: { code: "23505" } } }), true);
  });
  test("is false for every other code and for things that are not errors", () => {
    assert.equal(isUniqueViolation({ code: "23503" }), false, "a foreign key violation is not a unique one");
    assert.equal(isUniqueViolation({ code: "40001" }), false);
    assert.equal(isUniqueViolation(new Error("duplicate key value violates unique constraint")), false, "the words are not the code");
    for (const v of [null, undefined, "23505", 23505, {}]) assert.equal(isUniqueViolation(v), false);
  });
  test("a cycle in the causes cannot loop for ever", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    assert.equal(isUniqueViolation(a), false);
  });
});
