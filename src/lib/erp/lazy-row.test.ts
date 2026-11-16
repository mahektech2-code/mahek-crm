import { test } from "node:test";
import assert from "node:assert/strict";
import { later, withLater } from "./lazy-row";

test("a later part is built once, on its first read, and reads like the eager row", () => {
  let built = 0;
  const row = withLater<{ id: string; fields: string[]; actions: string[] }>({
    id: "r1",
    fields: later(() => {
      built++;
      return ["a", "b"];
    }),
    actions: ["x"],
  });
  assert.equal(built, 0, "nothing read, nothing built");
  assert.deepEqual(Object.keys(row), ["id", "fields", "actions"], "the keys keep their order");
  assert.deepEqual(row.fields, ["a", "b"]);
  assert.deepEqual(row.fields, ["a", "b"]);
  assert.equal(built, 1, "built once");
  assert.equal(JSON.stringify(row), JSON.stringify({ id: "r1", fields: ["a", "b"], actions: ["x"] }));
  assert.deepEqual({ ...row }, { id: "r1", fields: ["a", "b"], actions: ["x"] }, "a spread copies the built value");
});

test("a later part can be written over", () => {
  const row = withLater<{ id: string; actions: string[] }>({ id: "r1", actions: later(() => ["x"]) });
  row.actions = ["y"];
  assert.deepEqual(row.actions, ["y"]);
});
