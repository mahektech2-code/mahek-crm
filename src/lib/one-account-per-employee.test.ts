/**
 * One person, one account (owner, 2026-11-18).
 *
 *   npm run test:integration
 *
 * Poonam Pashte's login was never linked to her HRMS record, so when she
 * became Pranavi the only way to give "Pranavi" a login was Add user, which
 * made a second, empty account while her whole book sat on the first. These
 * pin the three things that stop it happening again:
 *
 *   - every employee is given exactly one account, opening nothing;
 *   - Add user sets up THAT account rather than making another;
 *   - an account in use, or an unlinked login that looks like the person, is
 *     refused rather than duplicated.
 *
 * Needs mahekone_test (`npm run test:db`). Truncates its own tables.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, employees, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setAccess } from "@/lib/actions/access";
import { moduleKeysForApp } from "@/lib/modules";
import { ensureEmployeeAccounts } from "@/lib/services/person-identity-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const CRM = { app: "crm", modules: moduleKeysForApp("crm"), role: "associate" as const };

async function makeEmployee(name: string, extra: Partial<typeof employees.$inferInsert> = {}) {
  const [row] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: Math.floor(Math.random() * 100000),
      employeeCode: `E${randomUUID().slice(0, 6)}`,
      name,
      status: "active",
      raw: {},
      rowHash: randomUUID(),
      ...extra,
    })
    .returning();
  return row;
}

const accountsOf = (employeeId: string) => db.select().from(users).where(eq(users.employeeId, employeeId));

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      app_module_access, app_access, password_resets, sessions, audit_log,
      person_name_aliases, employee_reporting, employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [boss] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Boss",
      email: "boss@test.local",
      phone: "9820000001",
      passwordHash: "x",
      role: "admin",
      initials: "BO",
      notEmployee: true,
    })
    .returning();
  await db.insert(appAccess).values([
    { id: id("aca"), userId: boss.id, app: "crm", role: "manager" },
    { id: id("aca"), userId: boss.id, app: "admin", role: "admin" },
  ]);
  setTestUser(boss);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("every employee gets exactly one account, opening nothing, and a leaver's is switched off", async () => {
  const helper = await makeEmployee("Gangaram Helper");
  const leaver = await makeEmployee("Bharat Left", { status: "inactive" });
  const gone = await makeEmployee("Withdrawn Row", { sheetStatus: "withdrawn" });

  const first = await ensureEmployeeAccounts();
  assert.deepEqual(first.created.sort(), ["Bharat Left", "Gangaram Helper"]);

  const [h] = await accountsOf(helper.id);
  assert.equal(h.active, true);
  assert.equal(h.email, null, "no way in until somebody sets it up");
  assert.equal(h.phone, null);
  const apps = await db.select().from(appAccess).where(eq(appAccess.userId, h.id));
  assert.equal(apps.length, 0, "it opens nothing");

  const [l] = await accountsOf(leaver.id);
  assert.equal(l.active, false);
  assert.equal((await accountsOf(gone.id)).length, 0, "a row gone from HRMS gets nothing");

  const again = await ensureEmployeeAccounts();
  assert.deepEqual(again.created, [], "idempotent");
  assert.equal((await accountsOf(helper.id)).length, 1);
});

test("Add user sets up the account the employee already has — never a second", async () => {
  const e = await makeEmployee("Pranavi Daphale");
  await ensureEmployeeAccounts();
  const [auto] = await accountsOf(e.id);

  const r = await setAccess({ employeeId: e.id, grants: [CRM], account: { email: null, phone: "7021471839" } });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.data.userId, auto.id, "the same account");
  assert.equal(r.data.created, true, "and the dialog goes on to issue a password, as for a new one");

  const mine = await accountsOf(e.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].phone, "7021471839");
  const apps = await db.select().from(appAccess).where(eq(appAccess.userId, auto.id));
  assert.deepEqual(apps.map((a) => a.app), ["crm"]);
});

test("an account somebody already uses is refused, not duplicated", async () => {
  const e = await makeEmployee("Rahul Busy");
  const made = await setAccess({ employeeId: e.id, grants: [CRM], account: { email: null, phone: "9820011010" } });
  assert.equal(made.ok, true, made.ok ? "" : made.error);

  const again = await setAccess({ employeeId: e.id, grants: [CRM], account: { email: null, phone: "9820011011" } });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.match(again.error, /already has a MahekOne account/);
  assert.doesNotMatch(again.error, /usr_|emp_/, "no id ever reaches the screen");
  assert.equal((await accountsOf(e.id)).length, 1);
});

test("an unlinked login that looks like the person is to be linked, not duplicated — and the nightly pass leaves it too", async () => {
  /* Poonam's shape: a login with nobody behind it in HRMS, under the same
     person's name. */
  await db.insert(users).values({
    id: id("usr"),
    name: "Poonam Pashte",
    email: "poonam@test.local",
    passwordHash: "x",
    role: "manager",
    initials: "PP",
  });
  const e = await makeEmployee("Poonam Pashte");

  const pass = await ensureEmployeeAccounts();
  assert.deepEqual(pass.created, []);
  assert.deepEqual(pass.waitingForLink, ["Poonam Pashte"]);
  assert.equal((await accountsOf(e.id)).length, 0);

  const r = await setAccess({ employeeId: e.id, grants: [CRM], account: { email: null, phone: "9820011012" } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /already a login that looks like Poonam Pashte/);
  assert.match(r.error, /Link it/);
  const all = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.name, "Poonam Pashte"));
  assert.equal(Number(all[0].n), 1);
});
