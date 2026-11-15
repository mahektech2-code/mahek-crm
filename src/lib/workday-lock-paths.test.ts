import { test } from "node:test";
import assert from "node:assert/strict";
import { lockGuardsPage, safeNext } from "./workday-lock-paths";

test("every app page is shut; the launcher, sign-in and the API are not", () => {
  for (const p of ["/crm", "/crm/leads?view=today", "/erp/orders", "/accounts", "/admin", "/hrms", "/sales-lead-pipeline/list", "/tasks", "/feedback"]) {
    assert.equal(lockGuardsPage(p), true, p);
  }
  for (const p of ["/apps", "/apps?next=%2Fcrm", "/api/workday", "/login", "/login/forgot", null, "", "crm"]) {
    assert.equal(lockGuardsPage(p), false, String(p));
  }
});

test("only a page on this site is followed after punching in", () => {
  assert.equal(safeNext("/crm/leads?view=today"), "/crm/leads?view=today");
  for (const p of ["//evil.example", "/\\evil.example", "https://evil.example", "/apps", "/api/workday", null]) {
    assert.equal(safeNext(p), null, String(p));
  }
});
