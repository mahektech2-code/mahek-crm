/**
 * The people at a customer, against mahekone_test with the REAL actions.
 *
 *   M  the contacts list and the customer columns cannot disagree: every write
 *      leaves `phone`, `contact_person`, `whatsapp_phone`,
 *      `payment_whatsapp_phone` and `alt_phone` mirroring the list;
 *   R  a number written straight into a column (the sheet, the handset) is
 *      folded INTO the list rather than lost;
 *   D  each designation is held by one contact at most, primary can only move,
 *      WhatsApp needs a mobile, and the last number cannot be removed;
 *   E  the full edit form's details save, and the credit decisions are the
 *      ledger desk's alone;
 *   W  a reply from any number on the list is filed against the customer;
 *   B  a contact's birthday is a day and a month, saved, cleared and checked.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customerContacts, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  addCustomerContact,
  designateCustomerContact,
  loadCustomerContacts,
  loadCustomerEditor,
  removeCustomerContact,
  updateCustomerContact,
} from "@/lib/actions/customer-contacts";
import { updateCustomer } from "@/lib/actions/crm";
import { reconcileContacts } from "@/lib/services/customer-contact-service";
import { customerIdForNumber } from "@/lib/services/whatsapp-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

type Level = "associate" | "manager" | "admin";

async function makeUser(name: string, role: Level, apps: { app: "crm" | "accounts"; role: Level }[]) {
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
  for (const a of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app, role: a.role });
  return row;
}

async function makeCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ramesh",
      phone: "9811100001",
      city: "Nagpur",
      kind: "customer",
      ...over,
    })
    .returning();
  return row;
}

const record = async (customerId: string) =>
  (await db.select().from(customers).where(eq(customers.id, customerId)))[0];

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table customer_contacts, audit_log, notifications, app_module_access, app_access,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  admin = await makeUser("Ada Admin", "admin", [{ app: "crm", role: "admin" }, { app: "accounts", role: "admin" }]);
  clerk = await makeUser("Tara Telecaller", "associate", [{ app: "crm", role: "associate" }]);
  setTestUser(admin);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("R — the columns are folded into the list", () => {
  test("phone, WhatsApp and alternate numbers become contacts with their designations", async () => {
    const c = await makeCustomer({ whatsappPhone: "9811100002", altPhone: "02223456789" });
    const r = await loadCustomerContacts(c.id);
    assert.ok(r.ok);
    const list = r.data;
    assert.equal(list.length, 3);
    const primary = list.find((x) => x.isPrimary)!;
    assert.equal(primary.phone, "9811100001");
    assert.equal(primary.name, "Ramesh");
    assert.equal(list.find((x) => x.forWhatsapp)!.phone, "9811100002");
    assert.ok(list.some((x) => x.phone === "02223456789" && !x.isPrimary && !x.forWhatsapp));
  });

  test("reconciling twice adds nothing", async () => {
    const c = await makeCustomer();
    await reconcileContacts(c.id);
    await reconcileContacts(c.id);
    const rows = await db.select().from(customerContacts).where(eq(customerContacts.customerId, c.id));
    assert.equal(rows.length, 1);
  });

  test("a phone written straight into the column becomes the primary contact", async () => {
    const c = await makeCustomer();
    await reconcileContacts(c.id);
    await db.update(customers).set({ phone: "9811100009" }).where(eq(customers.id, c.id));
    const list = await reconcileContacts(c.id);
    assert.equal(list.length, 2);
    assert.equal(list.find((x) => x.isPrimary)!.phone, "9811100009");
  });
});

describe("M + D — designations and their mirrors", () => {
  test("a payment-reminder contact is mirrored, and the WhatsApp number is left alone", async () => {
    const c = await makeCustomer();
    const r = await addCustomerContact(c.id, {
      name: "Suresh (accounts)",
      role: "accounts",
      phone: "+91 98111 00003",
      designations: ["payment"],
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const after = await record(c.id);
    assert.equal(after.paymentWhatsappPhone, "9811100003");
    assert.equal(after.whatsappPhone, null);
    assert.equal(after.phone, "9811100001");
    assert.equal(after.altPhone, "9811100003");
  });

  test("moving the payment mark takes it off the previous holder", async () => {
    const c = await makeCustomer();
    await addCustomerContact(c.id, { phone: "9811100003", designations: ["payment"] });
    const r = await addCustomerContact(c.id, { phone: "9811100004", designations: ["payment"] });
    assert.ok(r.ok);
    assert.equal(r.data.filter((x) => x.forPaymentReminders).length, 1);
    assert.equal((await record(c.id)).paymentWhatsappPhone, "9811100004");
  });

  test("make primary moves the phone and the contact person on the record", async () => {
    const c = await makeCustomer();
    const added = await addCustomerContact(c.id, { name: "Mahesh", role: "orders", phone: "9811100005" });
    assert.ok(added.ok);
    const mahesh = added.data.find((x) => x.phone === "9811100005")!;
    const r = await designateCustomerContact(mahesh.id, "primary", true);
    assert.ok(r.ok);
    const after = await record(c.id);
    assert.equal(after.phone, "9811100005");
    assert.equal(after.contactPerson, "Mahesh");
    assert.equal(after.altPhone, "9811100001");
  });

  test("primary cannot be cleared, only moved", async () => {
    const c = await makeCustomer();
    const list = await reconcileContacts(c.id);
    const r = await designateCustomerContact(list[0].id, "primary", false);
    assert.equal(r.ok, false);
  });

  test("a landline cannot get WhatsApp", async () => {
    const c = await makeCustomer();
    const r = await addCustomerContact(c.id, { phone: "022 2345 6789", designations: ["whatsapp"] });
    assert.equal(r.ok, false);
    const added = await addCustomerContact(c.id, { phone: "022 2345 6789" });
    assert.ok(added.ok);
    const landline = added.data.find((x) => x.phone === "02223456789")!;
    assert.equal((await designateCustomerContact(landline.id, "whatsapp", true)).ok, false);
  });

  test("the same number cannot be listed twice", async () => {
    const c = await makeCustomer();
    const r = await addCustomerContact(c.id, { phone: "+919811100001" });
    assert.equal(r.ok, false);
  });

  test("the last number cannot go; a removed primary hands over", async () => {
    const c = await makeCustomer();
    const list = await reconcileContacts(c.id);
    assert.equal((await removeCustomerContact(list[0].id)).ok, false);

    await addCustomerContact(c.id, { name: "Second", phone: "9811100006" });
    const r = await removeCustomerContact(list[0].id);
    assert.ok(r.ok);
    assert.equal(r.data.length, 1);
    assert.ok(r.data[0].isPrimary);
    const after = await record(c.id);
    assert.equal(after.phone, "9811100006");
    assert.equal(after.contactPerson, "Second");
  });

  test("unmarking WhatsApp clears the mirror, and editing a contact's number moves it", async () => {
    const c = await makeCustomer();
    const added = await addCustomerContact(c.id, { phone: "9811100007", designations: ["whatsapp"] });
    assert.ok(added.ok);
    const wa = added.data.find((x) => x.forWhatsapp)!;
    assert.ok((await updateCustomerContact(wa.id, { phone: "9811100008", role: "owner" })).ok);
    assert.equal((await record(c.id)).whatsappPhone, "9811100008");
    assert.ok((await designateCustomerContact(wa.id, "whatsapp", false)).ok);
    assert.equal((await record(c.id)).whatsappPhone, null);
    // and the fold does not put it back
    await reconcileContacts(c.id);
    assert.equal((await record(c.id)).whatsappPhone, null);
  });

  test("a customer out of scope is refused", async () => {
    const c = await makeCustomer({ salesAmId: admin.id, ownerId: admin.id });
    setTestUser(clerk);
    const r = await loadCustomerContacts(c.id);
    assert.equal(r.ok, false);
  });
});

describe("E — the full edit form", () => {
  test("every detail field saves and reads back", async () => {
    const c = await makeCustomer();
    const r = await updateCustomer(c.id, {
      externalCode: "MMI-0042",
      customerType: "dealer",
      potential: "high",
      potentialMonthlyPaise: 5_000_000,
      rating: "A",
      segmentation: "Furniture",
      dealerCode: "D-7",
      customerSince: "2021-04-01",
      specialInstructions: "Ring after 11",
      email: "accounts@shop.in",
      whatsappDest: "both",
      whatsappGroupName: "Shop orders",
      address: "12 Market Road",
      region: "Maharashtra",
      area: "Sitabuldi",
      beat: "Beat 3",
      territoryRegion: "Vidarbha",
      visitFrequencyDays: 14,
      creditLimitPaise: 20_000_000,
      creditBlocked: true,
      creditBlockReason: "Cheque bounced",
      priceTag: "Nagpur",
      freightTerm: "to_pay",
      deliveryType: "Godown Delivery",
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const e = await loadCustomerEditor(c.id);
    assert.ok(e.ok);
    const d = e.data.customer;
    assert.equal(d.externalCode, "MMI-0042");
    assert.equal(d.customerType, "dealer");
    assert.equal(d.potentialMonthlyPaise, 5_000_000);
    assert.equal(d.customerSince, "2021-04-01");
    assert.equal(d.whatsappDest, "both");
    assert.equal(d.visitFrequencyDays, 14);
    assert.equal(d.creditLimitPaise, 20_000_000);
    assert.equal(d.creditBlocked, true);
    assert.equal(d.freightTerm, "to_pay");
    assert.equal(e.data.canDecideCredit, true);
    const after = await record(c.id);
    assert.equal(after.potentialEstimatedById, admin.id);
  });

  test("a blank clears a field, and stopping supply needs a reason", async () => {
    const c = await makeCustomer({ email: "x@y.in" });
    assert.ok((await updateCustomer(c.id, { email: "" })).ok);
    assert.equal((await record(c.id)).email, null);
    assert.equal((await updateCustomer(c.id, { creditBlocked: true })).ok, false);
  });

  test("a group without a name is refused", async () => {
    const c = await makeCustomer();
    assert.equal((await updateCustomer(c.id, { whatsappDest: "group" })).ok, false);
  });

  test("the credit limit is the ledger desk's, but other details are anybody's", async () => {
    const c = await makeCustomer({ salesAmId: clerk.id, ownerId: clerk.id });
    setTestUser(clerk);
    const refused = await updateCustomer(c.id, { creditLimitPaise: 100 });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? "" : refused.code, "not_permitted");
    assert.ok((await updateCustomer(c.id, { email: "shop@x.in", creditLimitPaise: null })).ok);
    const e = await loadCustomerEditor(c.id);
    assert.ok(e.ok);
    assert.equal(e.data.canDecideCredit, false);
  });

  test("a phone sent the old way is folded into the contacts", async () => {
    const c = await makeCustomer();
    await reconcileContacts(c.id);
    assert.ok((await updateCustomer(c.id, { phone: "9811100010", contactPerson: "New owner" })).ok);
    const list = await reconcileContacts(c.id);
    const primary = list.find((x) => x.isPrimary)!;
    assert.equal(primary.phone, "9811100010");
    assert.equal(primary.name, "New owner");
  });
});

describe("W — inbound replies", () => {
  test("a reply from any number on the list is that customer's", async () => {
    const c = await makeCustomer();
    await addCustomerContact(c.id, { phone: "9811100011", role: "accounts" });
    assert.equal(await customerIdForNumber("9811100011"), c.id);
  });
});

describe("B — a contact's birthday", () => {
  test("is saved with the contact, edited, and cleared", async () => {
    const c = await makeCustomer();
    const added = await addCustomerContact(c.id, {
      name: "Sunita",
      phone: "9811100021",
      role: "accounts",
      birthDay: 14,
      birthMonth: 3,
    });
    assert.ok(added.ok, added.ok ? "" : added.error);
    const sunita = added.data.find((x) => x.name === "Sunita")!;
    assert.equal(sunita.birthDay, 14);
    assert.equal(sunita.birthMonth, 3);

    const moved = await updateCustomerContact(sunita.id, { name: "Sunita", phone: "9811100021", birthDay: 29, birthMonth: 2 });
    assert.ok(moved.ok);
    assert.equal(moved.data.find((x) => x.id === sunita.id)!.birthDay, 29);

    const cleared = await updateCustomerContact(sunita.id, { name: "Sunita", phone: "9811100021", birthDay: null, birthMonth: null });
    assert.ok(cleared.ok);
    const row = cleared.data.find((x) => x.id === sunita.id)!;
    assert.equal(row.birthDay, null);
    assert.equal(row.birthMonth, null);
  });

  test("a day without a month, or a day the month cannot hold, is refused", async () => {
    const c = await makeCustomer();
    const half = await addCustomerContact(c.id, { phone: "9811100022", birthDay: 14 });
    assert.equal(half.ok, false);
    const impossible = await addCustomerContact(c.id, { phone: "9811100023", birthDay: 31, birthMonth: 4 });
    assert.equal(impossible.ok, false);
    assert.match(impossible.ok ? "" : impossible.error, /April has only 30 days/);
  });

  test("the database refuses a half birthday written round the service", async () => {
    const c = await makeCustomer();
    await reconcileContacts(c.id);
    await assert.rejects(
      db.update(customerContacts).set({ birthDay: 3 }).where(eq(customerContacts.customerId, c.id)),
    );
  });

  test("the edit form is told today's date and the heads-up window", async () => {
    const c = await makeCustomer();
    const e = await loadCustomerEditor(c.id);
    assert.ok(e.ok);
    assert.match(e.data.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(e.data.birthdayHeadsUpDays, 7);
  });
});
