/**
 * Either a work number or an email, and neither on its own is compulsory.
 *
 *   npm run test:integration
 *
 * `signIn` has matched the last ten digits of a work number as readily as a
 * whole email since it was written, so both columns are credentials and neither
 * is THE credential. `users.email` was NOT NULL anyway, so setting anybody up
 * demanded an address — and a field salesman issued a handset and a number has
 * no company mailbox, so somebody typed one in that nobody would ever read.
 *
 * The rule that replaced it is "at least one", which no single-column
 * constraint can see, so it lives in `setAccess` and is pinned here.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
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

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let boss: typeof users.$inferSelect;

async function makeEmployee(name: string) {
  const [row] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: Math.floor(Math.random() * 100000),
      employeeCode: `E${randomUUID().slice(0, 6)}`,
      name,
      status: "active",
      /* The mirror keeps the sheet's own row and its hash — this fixture is
         standing in for one HR wrote, so both are present and empty. */
      raw: {},
      rowHash: randomUUID(),
    })
    .returning();
  return row;
}

/** Every screen of the CRM, which is what "grant the app" means. */
const CRM = { app: "crm", modules: moduleKeysForApp("crm"), role: "associate" as const };

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
      app_module_access, app_access, password_resets, sessions, audit_log,
      employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Boss",
      email: `boss-${randomUUID().slice(0, 4)}@test.local`,
      phone: "9820000001",
      passwordHash: "x",
      role: "manager",
      initials: "BO",
    })
    .returning();
  boss = row;
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "manager" });
  setTestUser(boss);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("a work number alone is a whole account — no email invented to fill a column", async () => {
  const e = await makeEmployee("Mahesh Field");
  const r = await setAccess({
    employeeId: e.id,
    grants: [CRM],
    account: { email: null, phone: "9820011007", role: "associate" },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;

  const [row] = await db.select().from(users).where(eq(users.id, r.data.userId));
  assert.equal(row.email, null, "nothing may be made up to satisfy the column");
  assert.equal(row.phone, "9820011007");
});

test("an email alone is a whole account too", async () => {
  const e = await makeEmployee("Deepa Desk");
  const r = await setAccess({
    employeeId: e.id,
    grants: [CRM],
    account: { email: "deepa@mahek.in", phone: null, role: "associate" },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;

  const [row] = await db.select().from(users).where(eq(users.id, r.data.userId));
  assert.equal(row.email, "deepa@mahek.in");
  assert.equal(row.phone, null);
});

test("both is fine, and is the case where they get to choose at the login box", async () => {
  const e = await makeEmployee("Vikram Both");
  const r = await setAccess({
    employeeId: e.id,
    grants: [CRM],
    account: { email: "vikram@mahek.in", phone: "9820011006", role: "manager" },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;

  const [row] = await db.select().from(users).where(eq(users.id, r.data.userId));
  assert.equal(row.email, "vikram@mahek.in");
  assert.equal(row.phone, "9820011006");
});

test("NEITHER is refused, because there would be nothing to sign in with", async () => {
  const e = await makeEmployee("Nobody Atall");
  const r = await setAccess({
    employeeId: e.id,
    grants: [CRM],
    account: { email: null, phone: null, role: "associate" },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.fieldErrors?.length, 1);
  assert.match(r.fieldErrors![0].message, /work number or an email/i);
});

test("a bad email is still refused where one is given", async () => {
  const e = await makeEmployee("Typo Person");
  const r = await setAccess({
    employeeId: e.id,
    grants: [CRM],
    account: { email: "not-an-address", phone: "9820011010", role: "associate" },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.fieldErrors?.[0].field, "email");
});

test("a bad work number is still refused where one is given", async () => {
  const e = await makeEmployee("Short Number");
  const r = await setAccess({
    employeeId: e.id,
    grants: [CRM],
    account: { email: "short@mahek.in", phone: "12345", role: "associate" },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.fieldErrors?.[0].field, "phone");
});

/* ------------------------------------------------------------ uniqueness */

test("two accounts may not share a work number, or sign-in has two answers", async () => {
  const first = await makeEmployee("First Holder");
  const second = await makeEmployee("Second Holder");
  const taken = "9820011099";

  const a = await setAccess({
    employeeId: first.id,
    grants: [CRM],
    account: { email: null, phone: taken, role: "associate" },
  });
  assert.equal(a.ok, true, a.ok ? "" : a.error);

  const b = await setAccess({
    employeeId: second.id,
    grants: [CRM],
    account: { email: null, phone: taken, role: "associate" },
  });
  assert.equal(b.ok, false);
  if (b.ok) return;
  assert.equal(b.fieldErrors?.[0].field, "phone");
});

test("and the index says so too, not just the action that checks first", async () => {
  /* The action's check can be skipped — `provisionUser` and the seed both write
     users directly — so the promise has to be at the database. */
  await db.insert(users).values({
    id: id("usr"),
    name: "Direct One",
    email: null,
    phone: "9820011088",
    passwordHash: "x",
    role: "associate",
    initials: "DO",
  });

  await assert.rejects(
    db.insert(users).values({
      id: id("usr"),
      name: "Direct Two",
      email: null,
      phone: "9820011088",
      passwordHash: "x",
      role: "associate",
      initials: "DT",
    }),
    (err: unknown) => {
      /* Drizzle's own message is "Failed query: insert into …" and names no
         constraint — the driver's error is on `cause`, and that is where the
         index name lives. Matching the outer message would pass for ANY
         failed insert, which is not what this test is about. */
      const e = err as { message?: string; cause?: { message?: string; constraint_name?: string } };
      assert.match(
        `${e.cause?.constraint_name ?? ""} ${e.cause?.message ?? ""}`,
        /users_phone_key/i,
        "the refusal must come from the phone index, not from something else",
      );
      return true;
    },
  );
});

test("but any number of accounts may have NO number, which is not a clash", async () => {
  /* A partial unique index holds as many NULLs as it likes — the point of
     making it partial rather than plain. */
  for (const name of ["Email Only A", "Email Only B"]) {
    await db.insert(users).values({
      id: id("usr"),
      name,
      email: `${name.replace(/\W+/g, "").toLowerCase()}@mahek.in`,
      phone: null,
      passwordHash: "x",
      role: "associate",
      initials: "EO",
    });
  }
  const rows = await db.select().from(users);
  assert.equal(rows.filter((r) => r.phone === null).length, 2);
});

test("nothing is emailed when access is granted", async () => {
  /* It used to mint and mail a reset link on every account creation — a thing
     the office cannot see happen, cannot repeat, and which reaches nobody at
     all on an account with no address. */
  const e = await makeEmployee("Quiet Setup");
  const r = await setAccess({
    employeeId: e.id,
    grants: [CRM],
    account: { email: "quiet@mahek.in", phone: "9820011077", role: "associate" },
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;

  const resets = await db.execute(sql`select count(*)::int as n from password_resets`);
  assert.equal((resets as unknown as Array<{ n: number }>)[0].n, 0);
  assert.doesNotMatch(r.message ?? "", /email/i);
});
