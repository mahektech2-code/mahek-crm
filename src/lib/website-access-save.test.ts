/**
 *   npm run test:integration
 *
 * Website access, saved through `setAccess` and read back the two ways the
 * product reads it: the Access screen's own listing (`listAccess`) and the
 * route guard's (`canOpenModule`). Ticking every box, a partial pick, Review
 * and Publish granted singly, removal, and a second person who must not move.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, employees, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setAccess } from "@/lib/actions/access";
import { listAccess } from "@/lib/services/access-service";
import { moduleKeysForApp, wholeAppKeys } from "@/lib/modules";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const ALL = moduleKeysForApp("website");
const ORDINARY = wholeAppKeys("website");
const PUB = "website.publish";
const REV = "website.review";

let boss: typeof users.$inferSelect;

async function person(name: string, phone: string): Promise<string> {
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: Math.floor(Math.random() * 100000),
      employeeCode: `E${randomUUID().slice(0, 6)}`,
      name,
      status: "active",
      raw: {},
      rowHash: randomUUID(),
    })
    .returning();
  const r = await setAccess({
    employeeId: e.id,
    grants: [{ app: "crm", modules: moduleKeysForApp("crm"), role: "associate" }],
    account: { email: null, phone },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.data.userId : "";
}

const save = async (userId: string, modules: string[]) => {
  const r = await setAccess({
    userId,
    grants: [
      { app: "crm", modules: moduleKeysForApp("crm"), role: "associate" },
      { app: "website", modules, role: "associate" },
    ],
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
};

/** What the Access screen lists as held, and what the guard lets through. */
async function held(userId: string) {
  const row = (await listAccess()).find((a) => a.userId === userId);
  const grant = row?.grants.find((g) => g.app === "website");
  const screen = (grant?.modules ?? []).filter((m) => m.granted).map((m) => m.key).sort();
  const guard: string[] = [];
  for (const k of ALL) if (await canOpenModule(userId, k)) guard.push(k);
  assert.deepEqual(guard.sort(), screen, "the screen and the guard must agree about what is held");
  return { keys: screen, grant };
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_module_access, app_access, password_resets, sessions, audit_log, employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Boss", email: `boss-${randomUUID().slice(0, 4)}@test.local`, phone: "9820000001", passwordHash: "x", role: "admin", initials: "BO" })
    .returning();
  boss = row;
  await db.insert(appAccess).values([
    { id: id("aca"), userId: row.id, app: "crm", role: "manager" },
    { id: id("aca"), userId: row.id, app: "admin", role: "admin" },
  ]);
  setTestUser(boss);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("every Website box ticked: saved, reloaded, and exactly the same again after a second identical save", async () => {
  const u = await person("Eva All", "9820011001");
  await save(u, ALL);
  assert.deepEqual((await held(u)).keys, [...ALL].sort());
  await save(u, ALL);
  assert.deepEqual((await held(u)).keys, [...ALL].sort());
});

test("Review and Publish are granted singly, and neither carries the other", async () => {
  const a = await person("Rita Review", "9820011002");
  await save(a, [...ORDINARY, REV]);
  const ra = (await held(a)).keys;
  assert.ok(ra.includes(REV) && !ra.includes(PUB));

  const b = await person("Pat Publish", "9820011003");
  await save(b, [...ORDINARY, PUB]);
  const rb = (await held(b)).keys;
  assert.ok(rb.includes(PUB) && !rb.includes(REV));
});

test("the whole ordinary app with neither right: neither is held, and the grant reads as the whole app", async () => {
  const u = await person("Ola Ordinary", "9820011004");
  await save(u, ORDINARY);
  const h = await held(u);
  assert.deepEqual(h.keys, [...ORDINARY].sort());
  assert.equal(h.grant?.whole, true);
});

test("a partial pick stores exactly that pick", async () => {
  const u = await person("Pia Partial", "9820011005");
  const pick = ["website.dashboard", "website.products", REV];
  await save(u, pick);
  assert.deepEqual((await held(u)).keys, [...pick].sort());
});

test("removing a right removes only that right", async () => {
  const u = await person("Rem Ove", "9820011006");
  await save(u, ALL);
  await save(u, ALL.filter((k) => k !== REV));
  const keys = (await held(u)).keys;
  assert.ok(!keys.includes(REV) && keys.includes(PUB));
  await save(u, ALL.filter((k) => k !== REV && k !== PUB));
  const keys2 = (await held(u)).keys;
  assert.ok(!keys2.includes(PUB) && !keys2.includes(REV));
  assert.equal(keys2.length, ORDINARY.length);
});

test("a right posted without its Dashboard is not held — the server's rule the screen now mirrors", async () => {
  const u = await person("Dee Dash", "9820011007");
  await save(u, ["website.products", REV, PUB]);
  assert.deepEqual((await held(u)).keys, ["website.products"]);
});

test("granting one person changes nobody else", async () => {
  const a = await person("Alpha One", "9820011008");
  const b = await person("Beta Two", "9820011009");
  await save(b, [...ORDINARY, REV]);
  const before = (await held(b)).keys;
  const rowsBefore = await db.select().from(appModuleAccess).where(eq(appModuleAccess.userId, b));
  await save(a, ALL);
  await save(a, [...ORDINARY, PUB]);
  await save(a, ORDINARY);
  assert.deepEqual((await held(b)).keys, before);
  const rowsAfter = await db.select().from(appModuleAccess).where(eq(appModuleAccess.userId, b));
  assert.deepEqual(rowsAfter.map((r) => r.id).sort(), rowsBefore.map((r) => r.id).sort(), "B's rows are untouched, not rewritten");
});

test("the Access listing names Dashboard once as read-only, however many levels it has", async () => {
  const u = await person("Rod Only", "9820011010");
  await save(u, ORDINARY);
  const { grant } = await held(u);
  assert.deepEqual(grant?.readOnly, ["Dashboard"]);
});
