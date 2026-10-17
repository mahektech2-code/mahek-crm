/**
 * Whole numbers come back from raw SQL as NUMBERS, and an account is one
 * payroll row — the two bugs behind the Sales Dashboard's Cost and return
 * screen showing a team cost of "₹1.80,00,00,00,00,25e+,112" and one salesman
 * twice.
 *
 * Postgres sends `bigint` and `numeric` as text. Until the driver converted
 * them (`src/db/index.ts`), every `sum()` in a raw query arrived as a string,
 * and adding two of them concatenated. These pin the conversion at the
 * database, because no type check can see it: the generics on `db.execute`
 * said `number` all along.
 *
 * They need mahekone_test, which `npm run test:db` creates.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { employees, users } from "@/db/schema";
import { employeeLateral } from "@/lib/employee-link";

before(() => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

after(async () => {
  await db.$client.end();
});

test("sum, count and bigint arrive as numbers, so adding them adds", async () => {
  const [row] = await db.execute<{ s: number; c: number; b: number; d: number }>(sql`
    select sum(x)::numeric as s, count(*) as c, 1800000::bigint as b, 2.125::numeric as d
      from (values (1800000::bigint), (2500000::bigint)) v(x)
  `);
  assert.equal(typeof row.s, "number");
  assert.equal(typeof row.c, "number");
  assert.equal(typeof row.b, "number");
  assert.equal(row.s + row.b, 6_100_000, "two salaries add rather than concatenate");
  assert.equal(row.c, 2);
  assert.equal(row.d, 2.125);
});

test("an account matching two payroll rows is ONE row, preferring the email match", async () => {
  const uid = `usr_${randomUUID().slice(0, 12)}`;
  const phone = `98${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
  const email = `bharat-${randomUUID().slice(0, 6)}@test.local`;
  await db.insert(users).values({
    id: uid,
    name: "Bharat Singh",
    email,
    phone,
    passwordHash: "scrypt$00$00",
    role: "associate",
    initials: "BS",
  });
  const byMobile = `emp_${randomUUID().slice(0, 12)}`;
  const byEmail = `emp_${randomUUID().slice(0, 12)}`;
  await db.insert(employees).values([
    { id: byMobile, rowNumber: 9001, employeeCode: `T-${byMobile}`, name: "Bharat Singh", companyMobile: phone, netSalaryPaise: 2_500_000, raw: {}, rowHash: randomUUID() },
    { id: byEmail, rowNumber: 9002, employeeCode: `T-${byEmail}`, name: "Bharat Singh", email, netSalaryPaise: 1_800_000, raw: {}, rowHash: randomUUID() },
  ] as never);

  try {
    const rows = await db.execute<{ id: string; salary: number }>(sql`
      select e.id, e.net_salary_paise as salary
        from users u
        ${employeeLateral("u", "e")}
       where u.id = ${uid}
    `);
    assert.equal(rows.length, 1, "one person, one row");
    assert.equal(rows[0].id, byEmail, "the email match wins over the mobile one");
    assert.equal(rows[0].salary, 1_800_000);
  } finally {
    await db.execute(sql`delete from employees where id in (${byMobile}, ${byEmail})`);
    await db.execute(sql`delete from users where id = ${uid}`);
  }
});
