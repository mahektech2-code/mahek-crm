/**
 * A NAME MAY NOT CONTRADICT THE ID BESIDE IT.
 *
 *   npm run test:integration
 *
 * `customers.sales_person_name` is the sheet's own word for who sells to a
 * shop, and every screen reads it BEFORE falling through to the linked
 * account. That is right while the sheet is still in charge of the account.
 * It stops being right the moment `am_decided_at` is stamped, because from
 * then on `recomputeSalesPeople` skips the account entirely.
 *
 * `updateAccountManagers` stamps that mark on ANY seat change. So moving the
 * back office seat alone used to freeze a sales NAME against a sales ID that
 * disagreed with it — permanently, with no path back. In production that left
 * forty-two accounts displaying one salesperson while the Call Log, the
 * collections list and the target their orders counted toward all belonged to
 * somebody else. Every screen was reporting its own column correctly.
 *
 * Needs mahekone_test; `npm run test:db` creates it. The harness truncates
 * between tests.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customerAmChanges, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { updateAccountManagers } from "@/lib/actions/account-manager";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let admin: typeof users.$inferSelect;
let heena: typeof users.$inferSelect;
let pritesh: typeof users.$inferSelect;

async function makeUser(name: string, role: "admin" | "manager" | "associate") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  return row;
}

async function makeCustomer(overrides: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Berhampur",
      status: "active",
      kind: "customer",
      ...overrides,
    })
    .returning();
  return row;
}

const reload = async (customerId: string) =>
  (await db.select().from(customers).where(eq(customers.id, customerId)))[0];

const REASON = "Salesperson left";

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
      timeline_events, customer_am_changes, notifications, audit_log,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  admin = await makeUser("Admin", "admin");
  heena = await makeUser("Heena Doshi", "associate");
  pritesh = await makeUser("Pritesh Doshi", "manager");
  setTestUser(admin);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("moving the back office seat brings a stale sales name back into step with the seat", async () => {
  /* Exactly the production shape: the sheet's name says one person, the seat
     says another, and the change being made is to the OTHER seat entirely. */
  const shop = await makeCustomer({
    salesAmId: heena.id,
    salesPersonName: "Sanjay Kumar Samantaray",
    backOfficeAmId: heena.id,
    backOfficeName: "Heena Doshi",
  });

  const result = await updateAccountManagers({
    customerIds: [shop.id],
    backOffice: { kind: "user", userId: pritesh.id },
    backOfficeReason: { reasonCode: REASON },
  });
  assert.equal(result.ok, true);

  const after = await reload(shop.id);
  // The seat this call moved.
  assert.equal(after.backOfficeAmId, pritesh.id);
  assert.equal(after.backOfficeName, "Pritesh Doshi");
  // The seat it did NOT move is untouched — the book does not move by accident.
  assert.equal(after.salesAmId, heena.id);
  // But its mirror no longer contradicts it.
  assert.equal(after.salesPersonName, "Heena Doshi");
  assert.notEqual(after.amDecidedAt, null);
});

test("a name with no account behind it is left alone, because it is the only answer there is", async () => {
  /* "South Zone" is a real value in this book. Where the seat holds nobody,
     that string is the only statement of who works the account — overwriting
     it would destroy the answer rather than correct it. */
  const shop = await makeCustomer({
    salesAmId: null,
    salesPersonName: "South Zone",
    backOfficeAmId: heena.id,
  });

  await updateAccountManagers({
    customerIds: [shop.id],
    backOffice: { kind: "user", userId: pritesh.id },
    backOfficeReason: { reasonCode: REASON },
  });

  const after = await reload(shop.id);
  assert.equal(after.salesPersonName, "South Zone");
  assert.equal(after.salesAmId, null);
});

test("moving the sales seat still writes its own mirror, as it always did", async () => {
  const shop = await makeCustomer({
    salesAmId: heena.id,
    salesPersonName: "Heena Doshi",
  });

  await updateAccountManagers({
    customerIds: [shop.id],
    salesAmId: pritesh.id,
    sales: { reasonCode: REASON },
  });

  const after = await reload(shop.id);
  assert.equal(after.salesAmId, pritesh.id);
  assert.equal(after.salesPersonName, "Pritesh Doshi");
});

test("a lead's book is its owner, and its mirror follows that", async () => {
  const lead = await makeCustomer({
    kind: "lead",
    ownerId: heena.id,
    salesPersonName: "Somebody Else",
    backOfficeAmId: heena.id,
  });

  await updateAccountManagers({
    customerIds: [lead.id],
    backOffice: { kind: "user", userId: pritesh.id },
    backOfficeReason: { reasonCode: REASON },
  });

  const after = await reload(lead.id);
  assert.equal(after.ownerId, heena.id);
  assert.equal(after.salesPersonName, "Heena Doshi");
});

test("the history names whoever actually held the seat, not the stale mirror", async () => {
  /* The remediation of this very fault wrote thirty-five rows reading
     "Sanjay → Sanjay", because `fromName` came from the display mirror rather
     than from the person the id pointed at. The ids were right and the
     sentence on the record was not. */
  const shop = await makeCustomer({
    salesAmId: heena.id,
    salesPersonName: "Sanjay Kumar Samantaray",
  });

  await updateAccountManagers({
    customerIds: [shop.id],
    salesAmId: pritesh.id,
    sales: { reasonCode: REASON },
  });

  const [row] = await db
    .select()
    .from(customerAmChanges)
    .where(eq(customerAmChanges.customerId, shop.id));
  assert.equal(row.fromUserId, heena.id);
  assert.equal(row.fromName, "Heena Doshi");
  assert.equal(row.toName, "Pritesh Doshi");
});

test("a seat held by a name with no login keeps that name in the history", async () => {
  /* There is no user to read a name from, so the mirror is the only answer
     there is — and it is a true one. */
  const shop = await makeCustomer({
    salesAmId: null,
    salesPersonName: "South Zone",
  });

  await updateAccountManagers({
    customerIds: [shop.id],
    salesAmId: pritesh.id,
    sales: { reasonCode: REASON },
  });

  const [row] = await db
    .select()
    .from(customerAmChanges)
    .where(eq(customerAmChanges.customerId, shop.id));
  assert.equal(row.fromUserId, null);
  assert.equal(row.fromName, "South Zone");
});
