/**
 * The bell, one app at a time, against the database.
 *
 * `notificationAppOf` decides in the browser which app a notification belongs
 * to; `notificationAppSql` decides the same in SQL for the badge, the list and
 * "mark all read". Two readings of one rule are the classic drift, so the first
 * test runs both over the same links and fails on any disagreement.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, notifications, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { notificationAppSql } from "@/lib/notification-app-sql";
import { notificationAppOf } from "@/lib/notification-apps";
import { notificationFeed } from "@/lib/queries";
import { markNotificationsRead } from "@/lib/actions/crm";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let priya: typeof users.$inferSelect;

async function note(href: string | null, mbosHref: string | null = null, minutesAgo = 0) {
  const nid = id("ntf");
  await db.insert(notifications).values({
    id: nid,
    userId: priya.id,
    title: `to ${href ?? mbosHref ?? "nowhere"}`,
    body: "",
    href,
    mbosHref,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  });
  return nid;
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`truncate table notifications, app_access, sessions, users restart identity cascade`);
  [priya] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Priya",
      email: "priya@test.local",
      phone: "9820011001",
      passwordHash: "x",
      role: "associate",
      initials: "PR",
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: priya.id, app: "crm", role: "associate" });
  setTestUser(priya);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("the SQL and the browser agree about which app every link belongs to", async () => {
  const links: [string | null, string | null][] = [
    ["/crm/customers/c_1", null],
    ["/crm", null],
    ["/crm?tab=x", null],
    ["/crmx/y", null],
    ["/accounts/approvals", null],
    ["/orders/approvals", null],
    ["/sales-lead-pipeline/l_1", null],
    ["/sales/live/u_1", null],
    ["/erp/transport#lr", null],
    ["/hrms/leave", null],
    ["/hire/applications/a_1", null],
    ["/feedback", null],
    ["https://example.com/crm", null],
    ["", "/tasks"],
    [null, "/tasks"],
    [null, null],
  ];
  for (const [href, mbos] of links) await note(href, mbos);
  const rows = await db
    .select({ href: notifications.href, mbosHref: notifications.mbosHref, app: sql<string | null>`${notificationAppSql()}` })
    .from(notifications);
  assert.equal(rows.length, links.length);
  for (const r of rows) {
    assert.equal(r.app, notificationAppOf(r.href, r.mbosHref), `href ${r.href} / ${r.mbosHref}`);
  }
});

test("a bell in one app lists that app and the general ones, and counts only those", async () => {
  await note("/crm/customers/c_1", null, 3);
  await note("/erp/transport", null, 2);
  await note("/accounts/approvals", null, 1);
  await note(null, null, 0);

  const crm = await notificationFeed(priya.id, "crm");
  assert.deepEqual(crm.items.map((n) => n.app).sort(), [null, "crm"].sort());
  assert.equal(crm.unread, 2);
  assert.equal(crm.all.length, 4, "All apps still has everything");
  const counts = Object.fromEntries(crm.byApp.map((r) => [String(r.app), r.unread]));
  assert.deepEqual(counts, { crm: 1, erp: 1, accounts: 1, null: 1 });

  const everywhere = await notificationFeed(priya.id, null);
  assert.equal(everywhere.items.length, 4);
  assert.equal(everywhere.unread, 4);
});

test("mark all read inside an app leaves the other apps' notifications unread", async () => {
  const c = await note("/crm/customers/c_1");
  const g = await note(null);
  const e = await note("/erp/transport");

  const res = await markNotificationsRead("crm");
  assert.equal(res.ok, true);
  const read = async (nid: string) =>
    (await db.select({ read: notifications.read }).from(notifications).where(eq(notifications.id, nid)))[0].read;
  assert.equal(await read(c), true);
  assert.equal(await read(g), true);
  assert.equal(await read(e), false, "the ERP's stays for the ERP's bell");

  await markNotificationsRead(null);
  assert.equal(await read(e), true);
});
