import { describe, it, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  APP_TASKS_PATH,
  shownInApp,
  taskLink,
  checklistFrom,
  closeProblems,
  dueState,
  dueWords,
  managesBoth,
  newTaskProblems,
  parseQuickAdd,
  rejectProblems,
  teamBelow,
  transferProblems,
  transferRoute,
} from "./rules";

const fields = (ps: { field: string }[]) => ps.map((p) => p.field);

describe("closing a task", () => {
  test("asks to be confirmed and for a remark, always", () => {
    assert.deepEqual(fields(closeProblems({ confirmed: false, remark: "", proofs: 0, proofRequired: false })), ["confirmed", "remark"]);
    assert.deepEqual(closeProblems({ confirmed: true, remark: "Called him, pays Friday.", proofs: 0, proofRequired: false }), []);
  });
  test("a remark is words, not a keystroke", () => {
    assert.deepEqual(fields(closeProblems({ confirmed: true, remark: "  ok ", proofs: 0, proofRequired: false })), ["remark"]);
  });
  test("needs a screenshot only where the creator asked for one", () => {
    assert.deepEqual(fields(closeProblems({ confirmed: true, remark: "Statements sent", proofs: 0, proofRequired: true })), ["proof"]);
    assert.deepEqual(closeProblems({ confirmed: true, remark: "Statements sent", proofs: 1, proofRequired: true }), []);
  });
});

describe("transferring a task", () => {
  test("a manager over both moves it; anybody else asks", () => {
    assert.equal(transferRoute({ actorManagesBoth: true }), "move");
    assert.equal(transferRoute({ actorManagesBoth: false }), "request");
  });
  test("a request needs a reason; a move does not", () => {
    assert.deepEqual(fields(transferProblems({ route: "request", fromId: "a", toId: "b", reason: "" })), ["reason"]);
    assert.deepEqual(transferProblems({ route: "move", fromId: "a", toId: "b", reason: "" }), []);
    assert.deepEqual(fields(transferProblems({ route: "move", fromId: "a", toId: "a", reason: "" })), ["to"]);
  });
  test("rejecting says why", () => {
    assert.deepEqual(fields(rejectProblems("")), ["note"]);
    assert.deepEqual(rejectProblems("Not my customer"), []);
  });
});

describe("the team on the org chart", () => {
  // vikram ← priya, rakesh; priya ← intern; deepa ← rohan
  const chart = new Map([
    ["priya", "vikram"],
    ["rakesh", "vikram"],
    ["intern", "priya"],
    ["rohan", "deepa"],
  ]);
  test("is everybody below, at any depth", () => {
    assert.deepEqual([...teamBelow(chart, "vikram")].sort(), ["intern", "priya", "rakesh"]);
    assert.deepEqual([...teamBelow(chart, "rakesh")], []);
  });
  test("survives a loop in the chart", () => {
    const loop = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    assert.deepEqual([...teamBelow(loop, "a")], ["b"]);
  });
  test("manager or above covers both people, and nobody outside", () => {
    const team = teamBelow(chart, "vikram");
    assert.ok(managesBoth(team, "vikram", "priya", "rakesh"));
    assert.ok(managesBoth(team, "vikram", "vikram", "intern"));
    assert.ok(!managesBoth(team, "vikram", "priya", "rohan"));
    assert.ok(!managesBoth(teamBelow(chart, "priya"), "priya", "priya", "rakesh"));
  });
});

describe("a new task", () => {
  const ok = { title: "Send the statements", app: "accounts", dueDate: "2026-11-12", priority: "normal" };
  test("is refused field by field", () => {
    assert.deepEqual(newTaskProblems(ok), []);
    assert.deepEqual(fields(newTaskProblems({ ...ok, title: " ", app: "nowhere", dueDate: "", priority: "big", dueTime: "3pm" })), [
      "title",
      "app",
      "dueDate",
      "dueTime",
      "priority",
    ]);
  });
  test("reads a checklist one step per line", () => {
    assert.deepEqual(checklistFrom("Balaji\n\n  Colour Camp \n"), [
      { text: "Balaji", done: false },
      { text: "Colour Camp", done: false },
    ]);
  });
});

describe("dates", () => {
  test("say how late or how soon", () => {
    assert.equal(dueState("2026-11-09", "2026-11-11"), "late");
    assert.equal(dueWords("2026-11-09", "2026-11-11"), "2 days late");
    assert.equal(dueWords("2026-11-10", "2026-11-11"), "1 day late");
    assert.equal(dueWords("2026-11-11", "2026-11-11"), "Today");
    assert.equal(dueWords("2026-11-12", "2026-11-11"), "Tomorrow");
    assert.equal(dueWords("2026-11-14", "2026-11-11"), "Sat 14 Nov");
  });
  test("quick add reads only what is unmistakable", () => {
    assert.deepEqual(parseQuickAdd("Call Hari Om Paints tomorrow 3pm !high", "2026-11-11"), {
      title: "Call Hari Om Paints",
      dueDate: "2026-11-12",
      dueTime: "15:00",
      priority: "high",
    });
    assert.deepEqual(parseQuickAdd("Send 20 L rate", "2026-11-11"), { title: "Send 20 L rate", dueDate: "2026-11-11", dueTime: null, priority: "normal" });
  });
});

/* ---------------------------------------------------------------- My tasks in every app */

describe("every app's own My tasks", () => {
  it("each path has a page that renders the shared screen for its own app", () => {
    for (const [app, path] of Object.entries(APP_TASKS_PATH)) {
      const dir = app === "founder" ? join("src", "app", "founder", "(desks)", "my-tasks") : join("src", "app", ...path!.split("/").filter(Boolean));
      const page = join(process.cwd(), dir, "page.tsx");
      assert.ok(existsSync(page), `${path} has no page`);
      assert.match(readFileSync(page, "utf8"), new RegExp(`<AppTasksPage app="${app}"`), `${path} must render AppTasksPage for ${app}`);
    }
  });

  it("an app shows its own tasks and personal ones, nothing else", () => {
    assert.equal(shownInApp("erp", "erp"), true);
    assert.equal(shownInApp("tasks", "erp"), true);
    assert.equal(shownInApp("crm", "erp"), false);
  });

  it("a link goes to the Tasks app for its holders, else to the task's own app", () => {
    assert.equal(taskLink({ id: "t1", app: "crm" }, { tasks: true }), "/crm/tasks?task=t1");
    assert.equal(taskLink({ id: "t1", app: "erp" }, { tasks: true }), "/tasks?task=t1");
    assert.equal(taskLink({ id: "t1", app: "erp" }, { tasks: false, apps: ["erp"] }), "/erp/my-tasks?task=t1");
    assert.equal(taskLink({ id: "t1", app: "tasks" }, { tasks: false, apps: ["accounts"] }), "/accounts/my-tasks?task=t1");
  });
});
