/**
 * A LEAD MAY NOT SIT BESIDE A CUSTOMER OF THE SAME NAME.
 *
 *   npm run test:integration
 *
 * A customer only ever comes from a lead, so the two carrying one name are one
 * shop written down twice. Two halves, both against the real services:
 *
 *   - the order-sheet projection ADOPTS a same-name lead and converts it,
 *     rather than writing a fresh customer beside it (and refuses to guess
 *     when two leads carry the name);
 *   - `trashLeadTwins` moves the twins already on the book to the Lead Trash —
 *     never a lead with orders of its own, never on a dry run, never twice.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, leadTrashEvents, mbosDeletions, orders, sheetOrderRows, sheetSyncRuns, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { projectCustomers } from "@/lib/services/sheet-projection-service";
import { trashLeadTwins } from "@/lib/services/lead-twin-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let syncId: string;
let row = 2;

async function stageLine(party: string, orderNumber: string) {
  await db.insert(sheetOrderRows).values({
    id: id("sor"),
    syncId,
    rowNumber: row,
    lineKey: `${orderNumber}#${row++}`,
    orderNumber,
    raw: {},
    rowHash: randomUUID(),
    status: "present",
    orderDate: "2026-07-01",
    dispatchDate: "2026-07-01",
    billingPartyName: party,
    area: "Nagpur",
    creditDays: 45,
    description: "Nano Thinner - 20 Liter (Loose)",
    cans: 1,
    finalAmountPaise: 100_000,
    amountPaise: 100_000,
    tallyBillNo: `T-${orderNumber}`,
  });
}

async function shop(name: string, kind: "lead" | "customer", city = "Nagpur") {
  const cid = id("cus");
  await db.insert(customers).values({ id: cid, name, kind, ownerId: manager.id, contactPerson: "", phone: "", city });
  return cid;
}

const row$ = async (cid: string) => (await db.select().from(customers).where(eq(customers.id, cid)))[0];

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table sheet_order_rows, sheet_sync_runs, lead_trash_events, mbos_deletions, timeline_events,
                   audit_log, bills, orders, calls, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Manager", email: `m-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "manager", initials: "MG" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role: "manager" });
  manager = u;
  setTestUser(manager);
  const [run] = await db
    .insert(sheetSyncRuns)
    .values({ id: id("shs"), source: "orders", spreadsheetId: "t", tabTitle: "Order Details", mode: "reconcile", status: "ok" })
    .returning();
  syncId = run.id;
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("the sheet converts the lead the field raised instead of writing a twin beside it", async () => {
  const leadId = await shop("Shree  Paints", "lead");
  await stageLine("SHREE PAINTS", "1001");

  const report = await projectCustomers({ assignToUserId: manager.id });
  assert.equal(report.adoptedLeads, 1);
  assert.equal(report.created, 0, "no second row for the same shop");

  const all = await db.select().from(customers);
  assert.equal(all.length, 1);
  const lead = await row$(leadId);
  assert.equal(lead.kind, "customer");
  assert.equal(lead.externalCode, "SHEET:SHREE PAINTS");
  assert.equal(lead.leadStage, "won");
  assert.equal(lead.creditDays, 45);

  // And the next pass finds it by its code, like any other sheet customer.
  const again = await projectCustomers({ assignToUserId: manager.id });
  assert.equal(again.adoptedLeads, 0);
  assert.equal(again.created, 0);
});

test("two leads with the party's name are two shops, and the sheet does not guess between them", async () => {
  await shop("Shree Paints", "lead", "Nagpur");
  await shop("Shree Paints", "lead", "Wardha");
  await stageLine("Shree Paints", "1001");

  const report = await projectCustomers({ assignToUserId: manager.id });
  assert.equal(report.adoptedLeads, 0);
  assert.equal(report.created, 1);
  const kinds = (await db.select({ kind: customers.kind }).from(customers)).map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["customer", "lead", "lead"]);
});

test("a dry run adopts nothing", async () => {
  const leadId = await shop("Deep Paints", "lead");
  await stageLine("Deep Paints", "1001");
  const report = await projectCustomers({ assignToUserId: manager.id, dryRun: true });
  assert.equal(report.adoptedLeads, 1);
  assert.equal((await row$(leadId)).kind, "lead");
});

test("twins already on the book go to the trash, with the customer named; a lead with orders is left", async () => {
  const twin = await shop("deep  paints", "lead");
  const customer = await shop("Deep Paints", "customer");
  const withOrders = await shop("Ravi Traders", "lead");
  await shop("Ravi Traders", "customer");
  const unrelated = await shop("Someone Else", "lead");
  await db.insert(orders).values({ id: id("ord"), customerId: withOrders, orderedAt: new Date(), totalAmount: 1 });

  const dry = await trashLeadTwins({ dryRun: true });
  assert.equal(dry.twins.length, 2);
  assert.equal(dry.trashed, 0);
  assert.equal((await row$(twin)).deletedAt, null, "a dry run moves nothing");

  const real = await trashLeadTwins();
  assert.equal(real.trashed, 1);
  assert.deepEqual(real.keptWithOrders.map((t) => t.leadId), [withOrders]);

  const gone = await row$(twin);
  assert.ok(gone.deletedAt);
  assert.match(gone.deletedReason ?? "", new RegExp(customer));
  assert.equal((await row$(withOrders)).deletedAt, null);
  assert.equal((await row$(unrelated)).deletedAt, null);
  assert.equal((await row$(customer)).deletedAt, null);

  const events = await db.select().from(leadTrashEvents).where(eq(leadTrashEvents.customerId, twin));
  assert.equal(events.length, 1);
  const tombstones = await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, twin));
  assert.ok(tombstones.length > 0, "the handsets are told");

  const rerun = await trashLeadTwins();
  assert.equal(rerun.trashed, 0, "a second run finds nothing left to move");
});
