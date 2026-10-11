/**
 * The Enable access picker is the HRMS People directory, once each.
 *
 *   npm run test:integration
 *
 * It matched every employee to an account on email, so seven helpers and
 * delivery staff the sheet gave one shared company address were all drawn
 * under the name of the one account that also used it — and picking any of
 * them opened that account.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { employees, users } from "@/db/schema";
import { listCandidates } from "@/lib/services/access-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function employee(name: string, email: string | null, mobile: string | null = null) {
  const [row] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: Math.floor(Math.random() * 100000),
      employeeCode: `E${randomUUID().slice(0, 6)}`,
      name,
      status: "active",
      email,
      companyMobile: mobile,
      raw: {},
      rowHash: randomUUID(),
    })
    .returning();
  return row;
}

async function account(name: string, email: string, employeeId: string | null = null) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email,
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
      employeeId,
    })
    .returning();
  return row;
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`truncate table app_access, employees, users restart identity cascade`);
});

after(async () => {
  await db.$client.end();
});

const SHARED = "mahekmarketing1@gmail.com";

test("everybody sharing a company email is listed under their own name, and only the linked one carries the account", async () => {
  const ankit = await employee("Ankit Srivastav", SHARED);
  const helper = await employee("Ajit Gupta", SHARED);
  const driver = await employee("Arun Kumar", SHARED);
  const acc = await account("ANKIT SRIVASTAV", SHARED, ankit.id);

  const list = await listCandidates();
  assert.equal(list.length, 3, "one row per directory employee, nothing else");
  const byEmp = new Map(list.map((c) => [c.employeeId, c]));
  assert.equal(byEmp.get(ankit.id)?.userId, acc.id);
  assert.equal(byEmp.get(helper.id)?.name, "Ajit Gupta");
  assert.equal(byEmp.get(helper.id)?.userId, null);
  assert.equal(byEmp.get(driver.id)?.userId, null);
  assert.equal(list.filter((c) => c.userId === acc.id).length, 1);
});

test("a shared email never guesses an account, a unique one still does", async () => {
  await employee("Ajit Gupta", SHARED);
  await employee("Arun Kumar", SHARED);
  const unlinked = await account("Ankit", SHARED);
  const pooja = await employee("Pooja Dev", "pdev@example.com");
  const poojaAcc = await account("Pooja Dev", "pdev@example.com");

  const list = await listCandidates();
  assert.equal(list.filter((c) => c.userId === unlinked.id).length, 0);
  assert.equal(list.find((c) => c.employeeId === pooja.id)?.userId, poojaAcc.id);
});

test("an account with nobody behind it in HRMS is not offered", async () => {
  await employee("Ajit Gupta", null);
  await account("Seed Person", "seed@mahek.in");
  const list = await listCandidates();
  assert.deepEqual(list.map((c) => c.name), ["Ajit Gupta"]);
});
