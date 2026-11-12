import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL_TASKS_LIST, APP_TASKS_LIST, DONE_LIST, groupKeyOf, groupLabel, likePattern, pageWindow, readTaskQuery, taskQueryHref } from "./list-query";

describe("a task list's reading, from the URL", () => {
  it("falls back to the screen's defaults for anything unknown or out of range", () => {
    const q = readTaskQuery({ tab: "nope", group: "day", kind: "x", app: "mars", page: "-3", per: "7" }, ALL_TASKS_LIST);
    assert.deepEqual(q, { tab: "open", app: null, kind: "all", q: "", group: "app", page: 1, per: 50 });
  });

  it("takes a tab only the screen offers", () => {
    assert.equal(readTaskQuery({ tab: "doing" }, APP_TASKS_LIST).tab, "now");
    assert.equal(readTaskQuery({ tab: "late" }, APP_TASKS_LIST).tab, "late");
    assert.equal(readTaskQuery({}, DONE_LIST).group, "day");
  });

  it("trims a search and caps how long it may be", () => {
    assert.equal(readTaskQuery({ q: `  ${"a".repeat(500)}  ` }, ALL_TASKS_LIST).q.length, 120);
  });

  it("writes only what differs from the defaults, and goes back to page one on any other change", () => {
    const q = readTaskQuery({ page: "4", tab: "late" }, ALL_TASKS_LIST);
    assert.equal(taskQueryHref("/tasks/all", q, { page: 5 }, ALL_TASKS_LIST), "/tasks/all?tab=late&page=5");
    assert.equal(taskQueryHref("/tasks/all", q, { q: "hari om" }, ALL_TASKS_LIST), "/tasks/all?tab=late&q=hari+om");
    assert.equal(taskQueryHref("/tasks/all", q, { tab: "open" }, ALL_TASKS_LIST), "/tasks/all");
    assert.equal(taskQueryHref("/tasks/team", q, { tab: "open" }, ALL_TASKS_LIST, { person: "usr_1" }), "/tasks/team?person=usr_1");
  });
});

describe("paging and searching", () => {
  it("clamps a page past the end to the last page", () => {
    assert.deepEqual(pageWindow(99, 50, 120), { page: 3, offset: 100, pages: 3 });
    assert.deepEqual(pageWindow(1, 50, 0), { page: 1, offset: 0, pages: 1 });
  });

  it("treats a typed % and _ as characters", () => {
    assert.equal(likePattern("100%_off"), "%100\\%\\_off%");
  });
});

describe("groups", () => {
  const row = { app: "crm", priority: "high", kind: "auto", status: "todo" as const, dueDate: "2026-11-13", closedOn: null };
  it("puts a row in its group the way the server does", () => {
    assert.equal(groupKeyOf("due", row, "2026-11-12"), "tomorrow");
    assert.equal(groupKeyOf("due", { ...row, dueDate: "2026-11-01" }, "2026-11-12"), "late");
    assert.equal(groupKeyOf("due", { ...row, status: "done" }, "2026-11-12"), "done");
    assert.equal(groupKeyOf("source", row, "2026-11-12"), "auto");
  });
  it("names a closing day in words", () => {
    assert.equal(groupLabel("day", "2026-11-12", "2026-11-12"), "Today");
    assert.equal(groupLabel("day", "2026-11-11", "2026-11-12"), "Yesterday");
    assert.equal(groupLabel("day", "2026-11-03", "2026-11-12"), "Tue, 3 Nov");
    assert.equal(groupLabel("day", "2025-11-03", "2026-11-12"), "Mon, 3 Nov 2025");
    assert.equal(groupLabel("app", "tasks", "2026-11-12"), "Personal");
  });
});
