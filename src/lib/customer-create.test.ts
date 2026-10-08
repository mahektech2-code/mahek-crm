/**
 * ADDING A CUSTOMER FROM ACCOUNTS — and it is wired everywhere the moment it
 * is saved.
 *
 * The point of the feature is that nobody has to do anything afterwards: the
 * account is a direct customer, its seats are a decision the nightly sync
 * leaves alone, its number is on the contacts list, and it is on the sales
 * account manager's handset because it was filed under a state he works. Each
 * of those is asked here of the real services, not of the form.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customerContacts, customers, mbosUserTerritories, notifications, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { createDirectCustomer } from "@/lib/actions/customer-create";
import { recomputeSalesPeople } from "@/lib/recompute";
import { customerIdsInScope, type MbosPrincipal } from "@/lib/services/mbos-service";
import type { NewCustomerInput } from "@/lib/new-customer";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";

async function makeUser(
  name: string,
  role: Level,
  apps: { app: "crm" | "accounts" | "field"; role: Level }[],
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const a of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app, role: a.role });
  return row;
}

const record = async (customerId: string) =>
  (await db.select().from(customers).where(eq(customers.id, customerId)))[0];

let deepa: typeof users.$inferSelect; // Accounts manager — the ledger desk
let clerk: typeof users.$inferSelect; // Accounts associate
let mahesh: typeof users.$inferSelect; // field salesman, works Maharashtra

function input(over: Partial<NewCustomerInput> = {}): NewCustomerInput {
  return {
    name: "Shree Ganesh Paints",
    contactPerson: "Ganesh Patil",
    phone: "9876500011",
    city: "Nagpur",
    state: "Maharashtra",
    gstin: "",
    creditTermDays: 45,
    sales: { kind: "user", userId: mahesh.id },
    ...over,
  };
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table customer_contacts, mbos_user_territories, timeline_events, audit_log, notifications,
      app_module_access, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  deepa = await makeUser("Deepa Desk", "manager", [{ app: "accounts", role: "manager" }]);
  clerk = await makeUser("Kiran Clerk", "associate", [{ app: "accounts", role: "associate" }]);
  mahesh = await makeUser("Mahesh Field", "associate", [{ app: "field", role: "associate" }]);
  await db.insert(mbosUserTerritories).values({
    id: id("ut"),
    userId: mahesh.id,
    kind: "state",
    region: "Maharashtra",
    parent: "",
  });
  setTestUser(deepa);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Adding a customer from Accounts", () => {
  test("writes a direct customer whose seat is a decision, with its contact", async () => {
    const r = await createDirectCustomer(input({ backOffice: { kind: "user", userId: clerk.id } }));
    assert.ok(r.ok, JSON.stringify(r));
    const c = await record(r.data.id);
    assert.equal(c.kind, "customer");
    assert.equal(c.status, "active");
    assert.equal(c.region, "Maharashtra");
    assert.equal(c.salesAmId, mahesh.id);
    assert.equal(c.ownerId, mahesh.id, "the owner follows the seat, never whoever pressed Save");
    assert.equal(c.salesPersonName, "Mahesh Field");
    assert.equal(c.backOfficeAmId, clerk.id);
    assert.equal(c.backOfficeName, "Kiran Clerk");
    assert.ok(c.amDecidedAt, "a person decided the seats — the sheet must not restate them");
    assert.equal(c.creditTermDays, 45);
    assert.equal(c.creditDays, 45);

    const contacts = await db.select().from(customerContacts).where(eq(customerContacts.customerId, c.id));
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].phone, "9876500011");
    assert.equal(contacts[0].isPrimary, true);
    assert.equal(contacts[0].name, "Ganesh Patil");
  });

  test("lands on the sales account manager's handset, through his territory", async () => {
    const r = await createDirectCustomer(input());
    assert.ok(r.ok, JSON.stringify(r));
    const principal = {
      user: mahesh,
      deviceId: "probe-device",
      role: "associate",
      scope: { kind: "own", userIds: [mahesh.id] },
    } as MbosPrincipal;
    assert.ok((await customerIdsInScope(principal)).includes(r.data.id));
  });

  test("tells the people it landed on", async () => {
    const r = await createDirectCustomer(input());
    assert.ok(r.ok, JSON.stringify(r));
    const bell = await db.select().from(notifications).where(eq(notifications.userId, mahesh.id));
    assert.equal(bell.length, 1);
    assert.match(bell[0].title, /New customer: Shree Ganesh Paints/);
  });

  test("the nightly sales-people pass leaves the seat's name alone", async () => {
    const r = await createDirectCustomer(input());
    assert.ok(r.ok, JSON.stringify(r));
    await recomputeSalesPeople();
    assert.equal((await record(r.data.id)).salesPersonName, "Mahesh Field");
  });

  test("an Accounts associate cannot decide whose book it is in", async () => {
    setTestUser(clerk);
    const r = await createDirectCustomer(input());
    assert.equal(r.ok, false);
    assert.equal(r.ok ? null : r.code, "not_permitted");
    assert.equal((await db.select().from(customers)).length, 0);
  });

  test("the required answers are required", async () => {
    for (const [over, field] of [
      [{ state: "" }, "state"],
      [{ city: "" }, "city"],
      [{ phone: "12345" }, "phone"],
      [{ sales: { kind: "none" } }, "sales"],
      [{ gstin: "27ABCDE1234F1Z9" }, "gstin"],
    ] as const) {
      const r = await createDirectCustomer(input(over as Partial<NewCustomerInput>));
      assert.equal(r.ok, false, field);
      assert.equal(r.ok ? null : r.fieldErrors?.[0]?.field, field);
    }
  });

  test("a number already on the book is refused, and a same name asks first", async () => {
    assert.ok((await createDirectCustomer(input())).ok);

    const sameNumber = await createDirectCustomer(input({ name: "Another Shop" }));
    assert.equal(sameNumber.ok ? null : sameNumber.fieldErrors?.[0]?.field, "phone");

    const sameName = await createDirectCustomer(input({ name: "  shree  ganesh paints ", phone: "9876500022" }));
    assert.equal(sameName.ok ? null : sameName.fieldErrors?.[0]?.field, "allowSameName");

    const confirmed = await createDirectCustomer(
      input({ name: "Shree Ganesh Paints", phone: "9876500022", allowSameName: true }),
    );
    assert.ok(confirmed.ok, JSON.stringify(confirmed));
  });
});
