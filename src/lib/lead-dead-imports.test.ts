/**
 * A PERMANENTLY DEAD LEAD DOES NOT STOP AN IMPORT.
 *
 * The database refuses every write to a Dead lead (migration 0189). Left alone,
 * one refused row inside a batch statement fails the whole batch and leaves
 * the rest of the run half applied. So every import that could meet one asks
 * first, SKIPS the record, SAYS so (the run's own report, and one audit row
 * naming what was skipped), and carries on with everything else.
 *
 *   A  the sheet projection: customer updates and orders, in one run
 *   B  the EMP 2.0 shop master
 *   C  the field pin import
 *   D  the Sales Party projection
 *
 * The ERP's own copy of its orders is in `erp/erp-book.test.ts`, which owns the
 * fixtures for it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  auditLog,
  customers,
  fieldCustomerPins,
  leadDeadRequests,
  orders,
  sheetCustomerMasterRows,
  sheetOrderRows,
  sheetPartyRows,
  sheetSyncRuns,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { DEAD_SKIP_REASON } from "@/lib/services/lead-dead-service";
import { applyMatchedGps } from "@/lib/services/customer-location-import-service";
import { projectCustomerMaster } from "@/lib/services/customer-master-projection-service";
import { projectParties } from "@/lib/services/party-projection-service";
import { projectSheet } from "@/lib/services/sheet-projection-service";
import { partyNameKey } from "@/lib/sheet-parse";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let requester: typeof users.$inferSelect;
let syncId: string;

async function makeUser(name: string, role: "associate" | "manager") {
  const [u] = await db
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
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role });
  return u;
}

/** Turns an existing customer row into an approved Dead lead, the way the approval would have. */
async function makeDead(customerId: string) {
  await db.update(customers).set({ kind: "lead", leadStage: "lost", leadLostReason: "price" }).where(eq(customers.id, customerId));
  const rid = id("ldr");
  await db.insert(leadDeadRequests).values({
    id: rid,
    customerId,
    requestedById: requester.id,
    reasonCode: "no_response",
    approverId: manager.id,
  });
  await db
    .update(leadDeadRequests)
    .set({ state: "approved", decidedById: manager.id, decidedAt: new Date() })
    .where(eq(leadDeadRequests.id, rid));
  await db
    .update(customers)
    .set({ leadDeadAt: new Date(), leadDeadById: manager.id, leadDeadRequestId: rid })
    .where(eq(customers.id, customerId));
}

async function stageLine(f: { orderNumber: string; party: string; area: string; orderDate: string; amountPaise: number; rowNumber: number }) {
  await db.insert(sheetOrderRows).values({
    id: id("sor"),
    syncId,
    rowNumber: f.rowNumber,
    lineKey: `${f.orderNumber}#${f.rowNumber}`,
    orderNumber: f.orderNumber,
    raw: {},
    rowHash: randomUUID(),
    status: "present",
    orderDate: f.orderDate,
    dispatchDate: f.orderDate,
    billingPartyName: f.party,
    area: f.area,
    creditDays: 30,
    description: "Nano Thinner - 20 Liter (Loose)",
    cans: 1,
    finalAmountPaise: f.amountPaise,
    amountPaise: f.amountPaise,
    tallyBillNo: `T-${f.orderNumber}`,
  });
}

const skipAudits = (source: string) =>
  db.select().from(auditLog).where(sql`${auditLog.action} = 'lead.import.skipped_dead' and ${auditLog.entityId} = ${source}`);

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_dead_requests, field_customer_pins, sheet_customer_master_rows, sheet_party_rows,
      sheet_order_rows, sheet_sync_runs, bills, orders, calls, notifications, audit_log, timeline_events,
      app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Manoj Manager", "manager");
  requester = await makeUser("Rina Requester", "associate");
  setTestUser(manager);
  const [run] = await db
    .insert(sheetSyncRuns)
    .values({ id: id("shs"), source: "orders", spreadsheetId: "test-sheet", tabTitle: "Order Details", mode: "reconcile", status: "ok" })
    .returning();
  syncId = run.id;
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A — the sheet projection", () => {
  test("a Dead lead's customer update and order are skipped and said so — every other record still lands", async () => {
    await stageLine({ orderNumber: "1001", party: "Deep Paints", area: "Nagpur", orderDate: "2026-07-01", amountPaise: 250_000, rowNumber: 2 });
    await stageLine({ orderNumber: "1002", party: "Shree Hardware", area: "Nagpur", orderDate: "2026-07-02", amountPaise: 900_000, rowNumber: 3 });
    await projectSheet({ assignToUserId: manager.id });

    const [deep] = await db.select().from(customers).where(eq(customers.name, "Deep Paints"));
    await makeDead(deep.id);
    const deepBefore = (await db.select().from(customers).where(eq(customers.id, deep.id)))[0];

    // New sheet content: the Dead lead's party moved town and ordered again;
    // the ordinary customer ordered again and moved town too.
    await db.delete(sheetOrderRows);
    await stageLine({ orderNumber: "1001", party: "Deep Paints", area: "Pune", orderDate: "2026-07-01", amountPaise: 250_000, rowNumber: 2 });
    await stageLine({ orderNumber: "1003", party: "Deep Paints", area: "Pune", orderDate: "2026-08-01", amountPaise: 400_000, rowNumber: 3 });
    await stageLine({ orderNumber: "1002", party: "Shree Hardware", area: "Mumbai", orderDate: "2026-07-02", amountPaise: 900_000, rowNumber: 4 });
    await stageLine({ orderNumber: "1004", party: "Shree Hardware", area: "Mumbai", orderDate: "2026-08-02", amountPaise: 300_000, rowNumber: 5 });

    // It must not throw — that is the whole requirement.
    const report = await projectSheet({ assignToUserId: manager.id });

    // The Dead lead is exactly as it was, and has no new order.
    const deepAfter = (await db.select().from(customers).where(eq(customers.id, deep.id)))[0];
    assert.equal(deepAfter.city, deepBefore.city, "its town was not rewritten");
    assert.equal(deepAfter.leadStage, "lost");
    assert.ok(deepAfter.leadDeadAt);
    const deepOrders = await db.select().from(orders).where(eq(orders.customerId, deep.id));
    assert.deepEqual(deepOrders.map((o) => o.externalRef).sort(), ["SHEET-1001"], "only the order it already had");

    // Everything else carried on.
    const [shree] = await db.select().from(customers).where(eq(customers.name, "Shree Hardware"));
    assert.equal(shree.city, "Mumbai", "the other customer's update landed");
    const shreeRefs = (await db.select().from(orders).where(eq(orders.customerId, shree.id))).map((o) => o.externalRef).sort();
    assert.deepEqual(shreeRefs, ["SHEET-1002", "SHEET-1004"], "the other customer's new order landed");

    // Reported clearly: in the run's own report and in the audit log.
    assert.equal(report.customers.skippedDead, 1);
    const reasons = report.skipped.map((s) => s.reason);
    assert.ok(reasons.some((r) => r.startsWith(DEAD_SKIP_REASON)), JSON.stringify(report.skipped));
    const orderAudit = await skipAudits("sheet.orders");
    assert.equal(orderAudit.length, 1);
    assert.match(JSON.stringify(orderAudit[0].afterState), /sheet order 1003/);
    assert.equal((await skipAudits("sheet.customers")).length, 1);

    // And the run is repeatable: a second pass neither throws nor writes more.
    const again = await projectSheet({ assignToUserId: manager.id });
    assert.equal(again.orders.created, 0);
  });
});

describe("B — the EMP 2.0 shop master", () => {
  test("a Dead lead is held and named; the other shops are still created", async () => {
    const [dead] = await db
      .insert(customers)
      .values({ id: id("cus"), name: "Kale Traders", phone: "9000000001", city: "Nashik", kind: "lead", leadStage: "lost", ownerId: requester.id })
      .returning();
    await makeDead(dead.id);

    const master = (name: string, mobile: string, n: number) =>
      db.insert(sheetCustomerMasterRows).values({
        id: id("scm"),
        syncId,
        rowNumber: n,
        raw: {},
        rowHash: randomUUID(),
        status: "present",
        customerName: name,
        nameKey: name.toLowerCase(),
        mobile,
        altMobile: "9111111111",
        address: "1 Market Road",
        locationText: "Nashik",
      });
    await master("Kale Traders", "9222222221", 2);
    await master("Fresh Shop One", "9222222222", 3);
    await master("Fresh Shop Two", "9222222223", 4);

    const result = await projectCustomerMaster({});
    assert.equal(result.created, 2, "both other shops were created");
    assert.equal(result.updated, 0, "the Dead lead was not enriched");
    assert.ok(result.heldReasons[DEAD_SKIP_REASON] === 1, JSON.stringify(result.heldReasons));
    assert.match(result.detail, /permanently Dead/);

    const after = (await db.select().from(customers).where(eq(customers.id, dead.id)))[0];
    assert.equal(after.altPhone, null, "nothing was written onto it");
    assert.equal((await skipAudits("sheet.customer-master")).length, 1);
  });
});

describe("C — the field pin import", () => {
  test("a pin matched to a Dead lead is not applied and is counted; every other pin is", async () => {
    const mk = async (name: string, dead: boolean) => {
      const [c] = await db
        .insert(customers)
        .values({ id: id("cus"), name, phone: String(9000000000 + Math.floor(Math.random() * 9999999)), city: "Nashik", kind: "lead", leadStage: "lost" })
        .returning();
      if (dead) await makeDead(c.id);
      await db.insert(fieldCustomerPins).values({
        id: id("pin"),
        rowHash: randomUUID(),
        raw: {},
        name,
        lat: 21.1458,
        lng: 79.0882,
        matchedCustomerId: c.id,
        customerMatchStatus: "matched",
      });
      return c;
    };
    const dead = await mk("Dead Pin Shop", true);
    const live1 = await mk("Live Pin Shop One", false);
    const live2 = await mk("Live Pin Shop Two", false);

    const out = await applyMatchedGps();
    assert.deepEqual([out.applied, out.skippedDead], [2, 1]);
    const rows = await db.select({ id: customers.id, lat: customers.gpsLat }).from(customers);
    const lat = new Map(rows.map((r) => [r.id, r.lat]));
    assert.equal(lat.get(dead.id), null, "the Dead lead was not pinned");
    assert.notEqual(lat.get(live1.id), null);
    assert.notEqual(lat.get(live2.id), null);
    assert.equal((await skipAudits("sheet.field-pins")).length, 1);
  });
});

describe("D — the Sales Party projection", () => {
  test("a Dead lead's party row changes nothing on it, and the others are still projected", async () => {
    const [dead] = await db
      .insert(customers)
      .values({ id: id("cus"), name: "Mule Dealers", phone: "9000000007", city: "Dhule", kind: "lead", leadStage: "lost", salesPersonName: "Old Name" })
      .returning();
    const [live] = await db
      .insert(customers)
      .values({ id: id("cus"), name: "Pawar Stores", phone: "9000000008", city: "", kind: "customer" })
      .returning();
    await makeDead(dead.id);

    const party = (name: string, n: number) =>
      db.insert(sheetPartyRows).values({
        id: id("spr"),
        syncId,
        rowNumber: n,
        partyName: name,
        partyKey: partyNameKey(name),
        raw: {},
        rowHash: randomUUID(),
        status: "present",
        area: "Surat",
        salesPerson: "New Seller",
      } as never);
    await party("Mule Dealers", 2);
    await party("Pawar Stores", 3);

    const report = await projectParties({});
    assert.ok(report.skippedDeadLeads.includes(dead.id), "the Dead lead is named in the report");

    const after = (await db.select().from(customers).where(eq(customers.id, dead.id)))[0];
    assert.equal(after.city, "Dhule");
    assert.ok(after.leadDeadAt);
    assert.equal((await skipAudits("sheet.parties")).length, 1);
    const stillLive = (await db.select().from(customers).where(eq(customers.id, live.id)))[0];
    assert.equal(stillLive.name, "Pawar Stores");
  });
});
