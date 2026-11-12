/**
 * TASK LISTS AT SCALE — thousands of tasks, read a page at a time.
 *
 * Every Tasks screen used to fetch everything a person could see, capped at a
 * few hundred rows, and count in the browser; past the cap the counts were
 * wrong and nothing said so. This seeds a book far past any of those caps and
 * asks the real readers what a screen would draw: the page holds a page, every
 * count is the whole truth, a group's size is counted across pages, the last
 * page is the last page, a search for "100%" finds a hundred per cent, and a
 * manager whose permission reaches everybody is not asked through a list of
 * every id in the company.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, taskBatches, taskTransfers, taskUserPowers, tasks, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ALL_TASKS_LIST, DONE_LIST, groupKeyOf, readTaskQuery, type TaskGroup } from "./list-query";
import { boardColumns, calendarWeek, givenBatches, groupKeySql, matchingTaskIds, myDay, taskListPage, teamWorkload, transferHistoryPage, PREVIEW_ROWS } from "./list-service";
import { plusDays } from "./rules";
import { TASK_FROM } from "./service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-11-12";

async function makeUser(name: string, reportsToId: string | null = null) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      passwordHash: "x",
      role: reportsToId ? "associate" : "manager",
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId,
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "tasks", role: reportsToId ? "associate" : "manager" });
  return row;
}

const APPS = ["crm", "accounts", "erp", "tasks"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

/** `n` tasks for a person, spread across apps, priorities, statuses and a month either side of DAY. */
async function seed(assigneeId: string, createdById: string, n: number, extra: Partial<typeof tasks.$inferInsert> = {}) {
  const rows: (typeof tasks.$inferInsert)[] = [];
  for (let i = 0; i < n; i++) {
    const done = i % 5 === 0;
    rows.push({
      id: id("tsk"),
      title: `Task ${i}${i % 97 === 0 ? " 100% checked" : ""}`,
      app: APPS[i % APPS.length],
      assigneeId,
      createdById,
      status: done ? "done" : (["todo", "doing", "waiting"] as const)[i % 3],
      priority: PRIORITIES[i % PRIORITIES.length],
      dueDate: plusDays(DAY, (i % 61) - 30),
      dueTime: i % 2 ? "10:30" : null,
      closedAt: done ? new Date(Date.parse(`${DAY}T06:00:00Z`) - (i % 40) * 86_400_000) : null,
      closedById: done ? assigneeId : null,
      closeRemark: done ? "Done" : null,
      ...extra,
    });
  }
  for (let i = 0; i < rows.length; i += 1000) await db.insert(tasks).values(rows.slice(i, i + 1000));
  return rows;
}

const count = async (where: ReturnType<typeof sql>) => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from tasks t where ${where}`))[0].n);

let boss: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table task_transfers, task_events, tasks, task_batches, task_user_powers, audit_log, notifications,
      app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  boss = await makeUser("Vikram Shah");
  priya = await makeUser("Priya Sharma", boss.id);
});

after(async () => {
  await db.$client.end();
});

describe("A person's list of thousands", () => {
  test("sends one page, and every count is the whole truth", async () => {
    await seed(priya.id, priya.id, 3000);
    const scope = { kind: "mine" as const, userId: priya.id };
    const q = readTaskQuery({}, ALL_TASKS_LIST);
    const page = await taskListPage(scope, q, DAY);

    assert.equal(page.rows.length, 50, "a page, not the book");
    assert.equal(page.tabCounts.all, 3000);
    assert.equal(page.tabCounts.open, await count(sql`t.assignee_id = ${priya.id} and t.status <> 'done'`));
    assert.equal(page.tabCounts.done, await count(sql`t.assignee_id = ${priya.id} and t.status = 'done'`));
    assert.equal(page.tabCounts.late, await count(sql`t.assignee_id = ${priya.id} and t.status <> 'done' and t.due_date < ${DAY}::date`));
    assert.equal(page.total, page.tabCounts.open);
    assert.equal(page.pages, Math.ceil(page.total / 50));
    assert.deepEqual(page.apps.map((a) => a.app).sort(), [...APPS].sort());
    assert.equal(page.apps.reduce((a, x) => a + x.n, 0), 3000);
    // Grouped by app: each heading on the page counts its whole group, not the rows that came.
    for (const r of page.rows) assert.equal(page.groupCounts[r.app], await count(sql`t.assignee_id = ${priya.id} and t.status <> 'done' and t.app = ${r.app}`));
  });

  test("pages through every row exactly once, and a page past the end is the last page", async () => {
    await seed(priya.id, priya.id, 730);
    const scope = { kind: "mine" as const, userId: priya.id };
    const seen = new Set<string>();
    const q = { ...readTaskQuery({ tab: "all", per: "100" }, ALL_TASKS_LIST) };
    for (let p = 1; p <= 8; p++) for (const r of (await taskListPage(scope, { ...q, page: p }, DAY)).rows) seen.add(r.id);
    assert.equal(seen.size, 730, "no row twice, none missed");
    const past = await taskListPage(scope, { ...q, page: 999 }, DAY);
    assert.equal(past.page, 8);
    assert.equal(past.rows.length, 30);
  });

  test("filters by app, source and a search that means what it says", async () => {
    await seed(priya.id, priya.id, 600);
    await seed(priya.id, boss.id, 40, { app: "erp", title: "Given work 50_off" });
    const scope = { kind: "mine" as const, userId: priya.id };
    const erp = await taskListPage(scope, readTaskQuery({ app: "erp", tab: "all" }, ALL_TASKS_LIST), DAY);
    assert.equal(erp.total, await count(sql`t.assignee_id = ${priya.id} and t.app = 'erp'`));
    assert.ok(erp.rows.every((r) => r.app === "erp"));
    const given = await taskListPage(scope, readTaskQuery({ kind: "assigned", tab: "all" }, ALL_TASKS_LIST), DAY);
    assert.equal(given.total, 40);
    const pct = await taskListPage(scope, readTaskQuery({ q: "100%", tab: "all" }, ALL_TASKS_LIST), DAY);
    assert.equal(pct.total, await count(sql`t.assignee_id = ${priya.id} and t.title like '%100\\%%'`));
    assert.ok(pct.total > 0 && pct.rows.every((r) => r.title.includes("100%")));
    const underscore = await taskListPage(scope, readTaskQuery({ q: "50_", tab: "all" }, ALL_TASKS_LIST), DAY);
    assert.equal(underscore.total, 40, "a typed _ is a character, not a wildcard");
  });

  test("the browser's grouping agrees with the server's for every grouping", async () => {
    await seed(priya.id, priya.id, 400);
    await seed(priya.id, boss.id, 20);
    const rows = (await taskListPage({ kind: "mine", userId: priya.id }, { ...readTaskQuery({ tab: "all", per: "100" }, ALL_TASKS_LIST) }, DAY)).rows;
    for (const g of ["app", "due", "priority", "source", "day", "none"] as TaskGroup[]) {
      const server = await db.execute<{ id: string; k: string }>(sql`select t.id, ${groupKeySql(g, DAY)} as k ${TASK_FROM} where t.assignee_id = ${priya.id}`);
      const byId = new Map(server.map((r) => [r.id, r.k]));
      for (const r of rows) assert.equal(groupKeyOf(g, r, DAY), byId.get(r.id), `${g} for ${r.title}`);
    }
  });

  test("Done reads newest first, grouped by day, across all time", async () => {
    await seed(priya.id, priya.id, 1500);
    const page = await taskListPage({ kind: "mine", userId: priya.id }, readTaskQuery({}, DONE_LIST), DAY);
    assert.equal(page.total, 300);
    const closed = page.rows.map((r) => r.closedAt!);
    assert.deepEqual(closed, [...closed].sort().reverse());
    for (const r of page.rows) assert.ok(page.groupCounts[r.closedOn!] > 0);
  });

  test("select every match stops at the bulk ceiling and says how many there were", async () => {
    await seed(priya.id, priya.id, 900);
    const { ids, total } = await matchingTaskIds({ kind: "mine", userId: priya.id }, readTaskQuery({}, ALL_TASKS_LIST), DAY, 200);
    assert.equal(ids.length, 200);
    assert.equal(total, 720);
  });
});

describe("Previews are capped and counted whole", () => {
  test("My day, the Board and the Calendar draw a preview and the real total", async () => {
    await seed(priya.id, priya.id, 4000);
    const md = await myDay(priya.id, DAY);
    assert.equal(md.late.rows.length, PREVIEW_ROWS);
    assert.equal(md.late.total, await count(sql`t.assignee_id = ${priya.id} and t.status <> 'done' and t.due_date < ${DAY}::date`));
    assert.equal(md.today.total, await count(sql`t.assignee_id = ${priya.id} and t.status <> 'done' and t.due_date = ${DAY}::date`));
    const sum = md.byKind.auto + md.byKind.assigned + md.byKind.routine + md.byKind.self;
    assert.equal(sum, await count(sql`t.assignee_id = ${priya.id} and t.status <> 'done'`));

    const board = await boardColumns(priya.id, DAY, null);
    assert.equal(board.todo.rows.length, 50);
    assert.equal(board.todo.total, await count(sql`t.assignee_id = ${priya.id} and t.status = 'todo'`));

    const days = Array.from({ length: 7 }, (_, i) => plusDays(DAY, i - 3));
    const week = await calendarWeek(priya.id, days, DAY, 20);
    for (const d of days) {
      assert.ok(week.byDay[d].rows.length <= 20);
      assert.ok(week.byDay[d].rows.every((r) => r.dueDate === d));
    }
    // A day before today shows only what is done — the late work sits on today.
    assert.ok(week.byDay[days[0]].rows.every((r) => r.status === "done"));
    assert.equal(week.late.total, md.late.total);
  });
});

describe("A team of hundreds", () => {
  test("is counted in SQL, paged by person, and never asked through a list of every id", async () => {
    const team = [];
    for (let i = 0; i < 120; i++) team.push(await makeUser(`Person ${String(i).padStart(3, "0")}`, boss.id));
    for (const p of team.slice(0, 30)) await seed(p.id, boss.id, 40);
    const w = await teamWorkload(boss, DAY, { q: "", page: 1, per: 50 });
    assert.equal(w.totals.people, 121, "everybody below the boss — the 120, and Priya");
    assert.equal(w.people, 121);
    assert.equal(w.rows.length, 50);
    assert.equal(w.totals.open, await count(sql`t.status <> 'done'`));
    assert.ok(w.rows[0].late >= w.rows[w.rows.length - 1].late, "most late first");
    const found = await teamWorkload(boss, DAY, { q: "Person 00", page: 1, per: 50 });
    assert.equal(found.people, 10);

    // Somebody whose permission reaches everybody: the same figures, asked against `users` rather than a list of ids.
    const ops = await makeUser("Office Coordinator");
    await db.insert(taskUserPowers).values({ userId: ops.id, power: "seeAll" });
    const all = await teamWorkload(ops, DAY, { q: "", page: 1, per: 100 });
    assert.equal(all.totals.people, 122, "everybody but themselves");
    assert.equal(all.totals.open, w.totals.open);
  });
});

describe("Assigned by me and the transfers", () => {
  test("a group given to hundreds is a card with two dozen faces and a count", async () => {
    const team = [];
    for (let i = 0; i < 60; i++) team.push(await makeUser(`Member ${i}`, boss.id));
    const [batch] = await db.insert(taskBatches).values({ id: id("tbt"), title: "Stock count", app: "erp", givenById: boss.id, audience: "60 people" }).returning();
    for (const p of team) await seed(p.id, boss.id, 1, { batchId: batch.id, title: "Stock count", status: "todo", closedAt: null, closedById: null, closeRemark: null });
    const b = await givenBatches(boss.id, 1, 10);
    assert.equal(b.total, 1);
    assert.equal(b.rows[0].total, 60);
    assert.equal(b.rows[0].people.length, 24);
    const singles = await taskListPage({ kind: "given", userId: boss.id, singles: true }, readTaskQuery({ tab: "all" }, ALL_TASKS_LIST), DAY);
    assert.equal(singles.total, 0, "a group's copies are not listed again one by one");
  });

  test("transfer history pages", async () => {
    const t = await seed(priya.id, priya.id, 130, { status: "todo", closedAt: null, closedById: null, closeRemark: null });
    await db.insert(taskTransfers).values(
      t.map((x, i) => ({ id: id("ttr"), taskId: x.id!, fromId: priya.id, toId: boss.id, requestedById: priya.id, status: "rejected", decisionNote: "Not mine", decidedById: boss.id, decidedAt: new Date(Date.now() - i * 60_000) })),
    );
    const p1 = await transferHistoryPage(priya.id, 1, 50);
    const p3 = await transferHistoryPage(priya.id, 3, 50);
    assert.equal(p1.total, 130);
    assert.equal(p1.rows.length, 50);
    assert.equal(p3.rows.length, 30);
  });
});
