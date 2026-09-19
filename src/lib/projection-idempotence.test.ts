/**
 * PROJECTING THE SAME SOURCE TWICE MUST WRITE THE ROW ONCE.
 *
 *   npm run test:integration
 *
 * The sheet projection and the buying-cycle recompute run together every
 * thirty minutes, and for a long time each rebuilt everything it could see
 * whether or not anything had moved: measured on production, 11,007 bill
 * updates and 6,075 customer cycle updates per cycle, on tables of 10,878 and
 * 5,925 rows, in cycles whose own log reported "0 new, 0 changed". Postgres
 * has no in-place update, so each of those was a new tuple, a WAL record and a
 * dirty page — which on a 961 MB droplet is what evicted the page cache and
 * kept the box in continuous swap while it was 90% idle.
 *
 * `xmin` is what these assert on, and it is the only honest witness: it is the
 * transaction that inserted the tuple the row is currently stored as, so it
 * moves if and only if the row was actually rewritten. A reported count could
 * be right while the write happened anyway, and `updated_at` could be held
 * still by a writer that rewrote everything else.
 *
 * The other half matters just as much and has its own tests below: a change
 * that is REAL must still land. A gate that skips too much is a projection
 * that silently stops projecting, which is worse than the writes it saves.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, orders, sheetOrderRows, sheetSyncRuns, syncConflicts, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { recomputeAllBuyingCycles } from "@/lib/recompute";
import {
  projectBillsFromOrders,
  projectCustomers,
  projectOrders,
} from "@/lib/services/sheet-projection-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let syncId: string;

/**
 * The transaction that wrote the tuple each row is currently stored as.
 *
 * Qualified against the table it belongs to rather than left bare, which is
 * the house rule for raw SQL and is not merely tidiness here: `xmin` is a
 * system column and every table has one.
 */
async function tupleVersions(
  table: "customers" | "bills" | "orders",
): Promise<Map<string, string>> {
  const rows = await db.execute<{ id: string; v: string }>(
    table === "customers"
      ? sql`select customers.id as id, customers.xmin::text as v from customers`
      : table === "bills"
        ? sql`select bills.id as id, bills.xmin::text as v from bills`
        : sql`select orders.id as id, orders.xmin::text as v from orders`,
  );
  return new Map(rows.map((r) => [r.id, r.v]));
}

function assertNoRowRewritten(before: Map<string, string>, after: Map<string, string>) {
  assert.equal(after.size, before.size, "the second pass must create no rows");
  for (const [rowId, version] of after) {
    assert.equal(
      version,
      before.get(rowId),
      `row ${rowId} was rewritten by a pass that had nothing to change`,
    );
  }
}

/** One line of the Order Details tab, landed in staging as the sync would. */
async function stageLine(fields: {
  orderNumber: string;
  party: string;
  area?: string | null;
  orderDate: string;
  amountPaise: number;
  /** What the sheet's Final Amount says, where it is not the Amount itself. */
  finalAmountPaise?: number;
  discountBp?: number;
  gstBp?: number;
  tally?: string;
  rowNumber: number;
}) {
  await db.insert(sheetOrderRows).values({
    id: id("sor"),
    syncId,
    rowNumber: fields.rowNumber,
    lineKey: `${fields.orderNumber}#${fields.rowNumber}`,
    orderNumber: fields.orderNumber,
    raw: {},
    rowHash: randomUUID(),
    status: "present",
    orderDate: fields.orderDate,
    dispatchDate: fields.orderDate,
    billingPartyName: fields.party,
    area: fields.area ?? "Nagpur",
    creditDays: 30,
    description: "Nano Thinner - 20 Liter (Loose)",
    cans: 1,
    finalAmountPaise: fields.finalAmountPaise ?? fields.amountPaise,
    amountPaise: fields.amountPaise,
    discountBp: fields.discountBp ?? null,
    gstBp: fields.gstBp ?? null,
    tallyBillNo: fields.tally ?? `T-${fields.orderNumber}`,
  });
}

/** Exactly what the half-hourly `project` mode runs, minus the recomputes. */
async function project() {
  const customers = await projectCustomers({ assignToUserId: manager.id });
  const { orders } = await projectOrders({ assignToUserId: manager.id });
  const bills = await projectBillsFromOrders({ assignToUserId: manager.id });
  return { customers, orders, bills };
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table sheet_order_rows, sheet_sync_runs, bills, orders, calls,
                   customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Manager",
      email: `manager-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "manager",
      initials: "MG",
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "manager" });
  manager = row;
  setTestUser(manager);

  const [run] = await db
    .insert(sheetSyncRuns)
    .values({
      id: id("shs"),
      source: "orders",
      spreadsheetId: "test-sheet",
      tabTitle: "Order Details",
      mode: "reconcile",
      status: "ok",
    })
    .returning();
  syncId = run.id;

  await stageLine({ orderNumber: "1001", party: "Deep Paints", orderDate: "2026-07-01", amountPaise: 250_000, rowNumber: 2 });
  await stageLine({ orderNumber: "1001", party: "Deep Paints", orderDate: "2026-07-01", amountPaise: 150_000, rowNumber: 3 });
  await stageLine({ orderNumber: "1002", party: "Shree Hardware", orderDate: "2026-07-20", amountPaise: 900_000, rowNumber: 4 });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("a second projection of an unchanged sheet rewrites no customer, order or bill", async () => {
  const first = await project();
  assert.ok(first.customers.created > 0, "the first pass has to create the book");
  assert.ok(first.bills.created > 0, "the first pass has to create the bills");

  const customersBefore = await tupleVersions("customers");
  const billsBefore = await tupleVersions("bills");
  const ordersBefore = await tupleVersions("orders");

  const second = await project();

  // The counts are the report a person reads, so they have to agree with the
  // tuples. "565 updated" on a pass that wrote nothing is what let the real
  // thing run for as long as it did.
  assert.equal(second.customers.updated, 0);
  assert.equal(second.customers.created, 0);
  assert.equal(second.bills.updated, 0);
  assert.equal(second.bills.created, 0);
  assert.equal(second.orders.updated, 0);
  assert.equal(second.orders.created, 0);

  assertNoRowRewritten(customersBefore, await tupleVersions("customers"));
  assertNoRowRewritten(billsBefore, await tupleVersions("bills"));
  assertNoRowRewritten(ordersBefore, await tupleVersions("orders"));
});

test("a third and fourth pass are the same — this is a cadence, not a warm-up", async () => {
  await project();
  await project();
  const customersBefore = await tupleVersions("customers");
  const billsBefore = await tupleVersions("bills");
  const ordersBefore = await tupleVersions("orders");

  await project();
  await project();

  assertNoRowRewritten(customersBefore, await tupleVersions("customers"));
  assertNoRowRewritten(billsBefore, await tupleVersions("bills"));
  assertNoRowRewritten(ordersBefore, await tupleVersions("orders"));
});

test("a recompute of an unchanged book rewrites no cycle", async () => {
  await project();
  // Once to settle the cycles, then the reading that matters.
  await recomputeAllBuyingCycles();

  const before = await tupleVersions("customers");
  const written = await recomputeAllBuyingCycles();

  assert.equal(written, 0, "nothing moved, so nothing should have been written");
  assertNoRowRewritten(before, await tupleVersions("customers"));
});

test("a sheet that DID change still lands — the gate skips writes, never work", async () => {
  await project();
  await recomputeAllBuyingCycles();

  // The area is the customer's city, and the amount is the bill's value: one
  // change on each of the two writers, in one pass.
  await db
    .update(sheetOrderRows)
    .set({ area: "Wardha" })
    .where(sql`sheet_order_rows.billing_party_name = 'Shree Hardware'`);
  await db
    .update(sheetOrderRows)
    .set({ finalAmountPaise: 250_001 })
    .where(sql`sheet_order_rows.order_number = '1001' and sheet_order_rows.row_number = 2`);

  const report = await project();
  assert.equal(report.customers.updated, 1, "the city moved on exactly one customer");
  assert.equal(report.bills.updated, 1, "the value moved on exactly one bill");
  assert.equal(report.orders.updated, 1, "the value moved on exactly one order");

  const [city] = await db.execute<{ city: string }>(
    sql`select customers.city as city from customers where customers.name = 'Shree Hardware'`,
  );
  assert.equal(city.city, "Wardha");

  const [amount] = await db.execute<{ amount: string }>(
    sql`select bills.amount as amount from bills where bills.external_ref = 'SHEETPAY-1001'`,
  );
  assert.equal(Number(amount.amount), 400_001);
});

test("an order that MOVED still moves the cycle — the recompute's gate is on values, not on a hash", async () => {
  await project();
  await recomputeAllBuyingCycles();

  // A later order for the same customer. `last_order_date` is one of the six
  // columns the gate compares, so this has to be written.
  await stageLine({ orderNumber: "1003", party: "Deep Paints", orderDate: "2026-08-15", amountPaise: 300_000, rowNumber: 5 });
  await project();

  const written = await recomputeAllBuyingCycles();
  assert.ok(written > 0, "a new order must move at least one customer's cycle");

  const [row] = await db.execute<{ d: string }>(
    sql`select customers.last_order_date::text as d
          from customers where customers.name = 'Deep Paints'`,
  );
  assert.equal(row.d, "2026-08-15");
});

test("a DECIDED order is still left alone, and the disagreement is still written down", async () => {
  await project();

  // Accounts confirm the order in the app. `approved_at` is the mark of a
  // decision, and the sheet goes on saying `dispatched` for ever after.
  await db
    .update(orders)
    .set({ status: "confirmed", approvedAt: new Date() })
    .where(sql`orders.external_ref = 'SHEET-1001'`);

  const before = await tupleVersions("orders");
  await project();

  const [kept] = await db.execute<{ status: string }>(
    sql`select orders.status as status from orders where orders.external_ref = 'SHEET-1001'`,
  );
  assert.equal(kept.status, "confirmed", "the sheet must not undo a decision");

  // AND THE SKIP MUST NOT SWALLOW THE CONFLICT. The guard keeps the app's
  // status, so the row comes out unchanged either way — which is exactly why a
  // skip here could hide a disagreement nobody would ever see again.
  const conflicts = await db.select().from(syncConflicts);
  assert.ok(
    conflicts.length > 0,
    "the sheet still says dispatched, and somebody has to reconcile the two",
  );

  // The row itself was not rewritten: it agreed with what the pass would have
  // written, decision and all.
  assertNoRowRewritten(before, await tupleVersions("orders"));
});

test("the projection writes BOTH figures: what the customer owes, and the sale under it", async () => {
  /*
   * `Final Amount = Amount × (1 − discount) × (1 + GST)`, so the sheet states
   * the same sale twice in two units. The bill and the credit limit want the
   * first; a sales target is written in the second. Reading one for the other
   * scored everybody about 18% ahead of where they were.
   */
  await stageLine({
    orderNumber: "2001",
    party: "Deep Paints",
    orderDate: "2026-07-05",
    amountPaise: 20_000_00, // list
    discountBp: 400, // 4% off → ₹19,200 of sale
    gstBp: 1800,
    finalAmountPaise: 22_656_00, // ₹19,200 + 18%
    rowNumber: 20,
  });
  await project();

  const [row] = await db.execute<{ total: string; net: string }>(
    sql`select orders.total_amount::text as total,
               orders.net_amount_paise::text as net
          from orders where orders.external_ref = 'SHEET-2001'`,
  );
  assert.equal(row.total, String(22_656_00), "the customer's own figure, tax in");
  assert.equal(row.net, String(19_200_00), "Amount AFTER the discount, tax out");
  // And not the list figure: a salesman must not be scored on money nobody was
  // billed.
  assert.notEqual(row.net, String(20_000_00));
});

test("a second pass over the same rows rewrites nothing, net included", async () => {
  // The idempotence this whole file exists for. A column added to the upsert
  // that is left out of `setWhere` is a row rewritten on every thirty-minute
  // pass for ever.
  await stageLine({
    orderNumber: "2002",
    party: "Deep Paints",
    orderDate: "2026-07-06",
    amountPaise: 10_000_00,
    discountBp: 250,
    gstBp: 1800,
    finalAmountPaise: 11_505_00,
    rowNumber: 21,
  });
  await project();

  const before = await tupleVersions("orders");
  await project();
  assertNoRowRewritten(before, await tupleVersions("orders"));
});
