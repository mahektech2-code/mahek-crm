import test from "node:test";
import assert from "node:assert/strict";
import { taskUpdateVerdict } from "./task-update-rules";

const base = { senderId: "u1", assigneeId: "u1", assignerId: "m1", status: "open", title: "Ring Patil" };

test("the person a task is for may work it, and so may whoever gave it", () => {
  assert.deepEqual(taskUpdateVerdict({ ...base, incomingStatus: "done" }), { kind: "apply" });
  assert.deepEqual(taskUpdateVerdict({ ...base, senderId: "m1", incomingStatus: "done" }), { kind: "apply" });
});

test("anybody else is refused, whatever id their handset holds", () => {
  const v = taskUpdateVerdict({ ...base, senderId: "u2", incomingStatus: "done" });
  assert.equal(v.kind, "refuse");
  assert.equal(v.kind === "refuse" && v.code, "not_permitted");
  assert.equal(taskUpdateVerdict({ ...base, senderId: "u2", assignerId: null }).kind, "refuse");
});

test("a cancelled task cannot be closed from a phone that had not heard", () => {
  const v = taskUpdateVerdict({ ...base, status: "cancelled", incomingStatus: "done" });
  assert.equal(v.kind, "refuse");
  assert.match(v.kind === "refuse" ? v.message : "", /cancelled by the office/);
});

test("done again is the same news; any other change to a closed task is refused", () => {
  assert.deepEqual(taskUpdateVerdict({ ...base, status: "done", incomingStatus: "done" }), { kind: "already" });
  assert.equal(taskUpdateVerdict({ ...base, status: "done", incomingStatus: null }).kind, "refuse");
  assert.equal(taskUpdateVerdict({ ...base, status: "done", incomingStatus: "open" }).kind, "refuse");
});

test("in progress is still open work", () => {
  assert.deepEqual(taskUpdateVerdict({ ...base, status: "in_progress" }), { kind: "apply" });
});
