import { test } from "node:test";
import assert from "node:assert/strict";
import { factorySessionAllows } from "./factory-session-paths";

test("a factory-only session counts on the factory app and its own API", () => {
  assert.equal(factorySessionAllows("/factory"), true);
  assert.equal(factorySessionAllows("/factory?tab=floor"), true);
  assert.equal(factorySessionAllows("/factory/anything"), true);
  assert.equal(factorySessionAllows("/api/factory/rpc"), true);
  assert.equal(factorySessionAllows("/api/factory/photo"), true);
});

test("and nowhere else — not the console, not another app, not a look-alike", () => {
  for (const p of ["/admin", "/apps", "/erp", "/crm", "/accounts", "/api/workday", "/factoryx", "/api/factoryrpc", "/api/erp/factory", "", null, undefined, "factory"]) {
    assert.equal(factorySessionAllows(p), false, String(p));
  }
});
