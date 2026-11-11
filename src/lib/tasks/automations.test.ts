import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTOMATIONS, planAutoSync, taskOpenHref, type ExistingAutoTask, type WantedTask } from "./automations";

const want = (key: string, extra: Partial<WantedTask> = {}): WantedTask => ({ key, assigneeId: "priya", title: `Call back ${key}`, note: null, customerId: null, dueDate: "2026-11-12", priority: "high", ...extra });
const have = (key: string, extra: Partial<ExistingAutoTask> = {}): ExistingAutoTask => ({ id: `t-${key}`, key, assigneeId: "priya", title: `Call back ${key}`, dueDate: "2026-11-12", status: "todo", ...extra });

test("a record that needs somebody raises a task once", () => {
  const p = planAutoSync([want("r1"), want("r2")], [have("r1")]);
  assert.deepEqual(p.insert.map((w) => w.key), ["r2"]);
  assert.deepEqual(p.update, []);
  assert.deepEqual(p.close, []);
});

test("a record that no longer needs anybody closes its task", () => {
  const p = planAutoSync([], [have("r1"), have("r2", { status: "done" })]);
  assert.deepEqual(p.close, ["t-r1"], "only the open one");
});

test("a task drifts with its record — reassigned, renamed, moved", () => {
  const p = planAutoSync([want("r1", { assigneeId: "rakesh", dueDate: "2026-11-14" })], [have("r1")]);
  assert.deepEqual(p.update, [{ id: "t-r1", set: { assigneeId: "rakesh", dueDate: "2026-11-14" } }]);
});

test("a task somebody closed by hand is not raised again while its record is still open", () => {
  const p = planAutoSync([want("r1")], [have("r1", { status: "done" })]);
  assert.deepEqual(p, { insert: [], update: [], close: [] });
});

test("every rule says when, who and what closes it, and ids are unique", () => {
  assert.equal(new Set(AUTOMATIONS.map((r) => r.id)).size, AUTOMATIONS.length);
  for (const r of AUTOMATIONS) for (const k of ["when", "who", "closes", "closedRemark"] as const) assert.ok(r[k].trim(), `${r.id}.${k}`);
});

test("Open in <app> goes where the work is done", () => {
  assert.equal(taskOpenHref({ app: "accounts", customerId: "c1", autoRule: "accounts.reported-payment" }), "/accounts/payments");
  assert.equal(taskOpenHref({ app: "crm", customerId: "c1", autoRule: null }), "/crm/customers/c1");
  assert.equal(taskOpenHref({ app: "erp", customerId: null, autoRule: null }), "/erp");
  assert.equal(taskOpenHref({ app: "tasks", customerId: null, autoRule: null }), null);
});
