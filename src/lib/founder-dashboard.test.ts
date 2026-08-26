/**
 * The Founder Dashboard, end to end.
 *
 *   npm run test:integration
 *
 * `founder-dashboard-service.ts` computes nothing of its own — every figure
 * is `ownerDashboard()`, `readingsForPeriod()`, `accountsHome()` or
 * `employeeMaster()`, already pinned by their own suites. What this pins is
 * what is actually new: that the `founder` app grant opens every one of its
 * modules the same way every other app's does — no module rows means every
 * module — and that the composed overview holds together as one object
 * rather than four independent reads that happen to be returned together.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { comparableRange, reportRange, sameRangeLastYear } from "@/lib/business-date";
import { listUserApps, listUserModules } from "@/lib/access";
import { moduleKeysForApp } from "@/lib/modules";
import {
  founderMoney,
  founderOverview,
  founderPeople,
  founderTeamPerformance,
} from "@/lib/services/founder-dashboard-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let founderUser: typeof users.$inferSelect;

async function makeUser(name: string, role: "telecaller" | "admin") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row;
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      app_module_access, app_access, sessions, employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  founderUser = await makeUser("Founder", "admin");
  setTestUser(founderUser);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("the founder app grant", () => {
  test("nobody opens it without a grant", async () => {
    const apps = await listUserApps(founderUser.id);
    assert.ok(!apps.includes("founder"));
  });

  test("a grant with no module rows opens every module — same rule as every other app", async () => {
    await db.insert(appAccess).values({ id: id("acc"), userId: founderUser.id, app: "founder" });

    const apps = await listUserApps(founderUser.id);
    assert.ok(apps.includes("founder"));

    const modules = await listUserModules(founderUser.id, "founder");
    assert.deepEqual(
      modules.map((m) => m.key).sort(),
      moduleKeysForApp("founder").sort(),
    );
  });

  test("narrowing to one module withholds the rest", async () => {
    await db.insert(appAccess).values({ id: id("acc"), userId: founderUser.id, app: "founder" });
    await db.insert(appModuleAccess).values({
      id: id("mod"),
      userId: founderUser.id,
      app: "founder",
      module: "founder.overview",
    });

    const modules = await listUserModules(founderUser.id, "founder");
    assert.deepEqual(
      modules.map((m) => m.key),
      ["founder.overview"],
    );
  });
});

describe("the overview", () => {
  test("composes all four apps into one object, on an empty book", async () => {
    const range = reportRange(TODAY, "month");
    const compared = comparableRange(range, "month");
    const lastYear = sameRangeLastYear(range);

    const data = await founderOverview(range, compared, lastYear, TODAY, TODAY.slice(0, 7));

    // The team count is internally consistent — nobody is silently dropped
    // between the count and the list rendered from it.
    assert.equal(data.team.total, data.team.ranked.length);
    assert.ok(data.money.aging.total >= 0);
    assert.ok(data.people.total >= 0);
    assert.ok(Array.isArray(data.crm.alerts));
  });

  test("team performance, money and people are each independently reachable", async () => {
    const ranked = await founderTeamPerformance(TODAY.slice(0, 7), TODAY);
    assert.ok(Array.isArray(ranked));

    const money = await founderMoney();
    assert.ok(money.aging.total >= 0);
    assert.equal(money.orders.count, 0);

    const people = await founderPeople();
    assert.equal(
      people.summary.total,
      people.employees.filter((e) => !e.withdrawn).length,
    );
  });
});
