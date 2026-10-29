/**
 * WHO DECIDES WHAT AN ORDER LINE COSTS, end to end.
 *
 *  - B8: a field order's lines are checked against the office whether or not
 *    the payload names a price tag.
 *  - B7: the office's resolved price list is that authority (the handset's tag
 *    table only where no list carries a product), the order is stamped with
 *    the list it was priced from, and the handset's price channel carries the
 *    office's rate under the tag every APK already reads.
 *  - B9: the ERP order form holds a discount — and a typed rate under the
 *    list, which is a discount — to the CRM's ceilings, and records who set a
 *    rate other than the list's.
 *
 * Driven through `ingestSyncBatch` and the ERP screen module, nothing stubbed.
 * Needs `mahekone_test` (npm run test:db); it truncates what it touches.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  erpCustomerProfiles,
  erpOrders,
  erpUserPowers,
  mbosPriceList,
  mbosUserTerritories,
  orders,
  priceListRates,
  priceListScopes,
  priceLists,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { buildBootstrap, type MbosPrincipal } from "@/lib/services/mbos-service";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TAG = "DEALER";

let salesman: typeof users.$inferSelect;
let principal: MbosPrincipal;
let listId: string;
let skuA: string;
let skuB: string;
let skuAName: string;
let skuBName: string;

function orderItem(payload: Record<string, unknown>): SyncItem {
  const entityId = `mbos_order_${randomUUID()}`;
  return {
    queueId: id("q"),
    entityType: "order",
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:create:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: { id: entityId, customerId: "cus_d_shop", orderedAt: Date.now(), ...payload },
  };
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table orders, mbos_sync_receipts, mbos_user_territories, mbos_price_list, timeline_events, audit_log,
      notifications, app_access, erp_orders, erp_customer_profiles, erp_user_powers, erp_order_reviews,
      price_list_rates, price_list_scopes, price_lists, customers, users, app_settings
    restart identity cascade
  `);
  await db.execute(sql`update erp_series set last = 0`);
  invalidateConfig();
  await seedConfig();

  [salesman] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Mahesh", email: `${id("m")}@test.local`, passwordHash: "x", role: "associate", initials: "MP" })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: salesman.id, app: "field" });
  await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "state", region: "Maharashtra" });

  skuAName = `PFD Thinner 5 L ${randomUUID().slice(0, 6)} (Loose)`;
  skuBName = `PFD Thinner 20 L ${randomUUID().slice(0, 6)} (Loose)`;
  const made = await db
    .insert(products)
    .values([
      { id: id("prd"), name: skuAName, packing: "Loose", millilitresPerCan: 5000, cansPerBox: 1 },
      { id: id("prd"), name: skuBName, packing: "Loose", millilitresPerCan: 20000, cansPerBox: 1 },
    ])
    .returning({ id: products.id });
  [skuA, skuB] = made.map((m) => m.id);

  await db.insert(customers).values({
    id: "cus_d_shop",
    name: "Sai Paint Depot",
    phone: "9822200011",
    city: "Nagpur",
    territoryRegion: "Maharashtra",
    kind: "customer",
    ownerId: salesman.id,
    salesAmId: salesman.id,
    priceTag: TAG,
  });
  await db.insert(erpCustomerProfiles).values({ customerId: "cus_d_shop" });

  /* The office's list for this shop carries A only; B is priced by the tag table. */
  listId = id("pl");
  await db.insert(priceLists).values({ id: listId, name: "Vidarbha Paid", effectiveFrom: "2026-01-01", status: "published" });
  await db.insert(priceListScopes).values({ id: id("pls"), priceListId: listId, scopeKind: "customer", scopeValue: "cus_d_shop", scopeLabel: "Sai Paint Depot" });
  await db.insert(priceListRates).values({ id: id("plr"), priceListId: listId, productId: skuA, rateExGstPaise: 10_000, rateInclGstPaise: 11_800 });
  await db.insert(mbosPriceList).values([
    { id: id("mpl"), customerPriceTag: TAG, productId: skuA, ratePaise: 9_000 },
    { id: id("mpl"), customerPriceTag: TAG, productId: skuB, ratePaise: 30_000 },
  ] as never);

  principal = { user: salesman, deviceId: "probe-device", role: "associate", scope: { kind: "own", userIds: [salesman.id] } } as MbosPrincipal;
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("B8 · a field order's price is checked whatever the payload says", () => {
  test("a wrong rate with NO price tag in the payload is refused", async () => {
    const [r] = await ingestSyncBatch(principal, [
      orderItem({ totalAmountPaise: 100, lines: [{ productId: skuA, quantityCans: 1, ratePaise: 100 }] }),
    ]);
    assert.equal(r.status, "rejected", JSON.stringify(r));
    assert.match(JSON.stringify(r), /11,800|118/);
    assert.equal((await db.select().from(orders)).length, 0);
  });

  test("a price tag the payload names is not the basis — the customer row is", async () => {
    const [r] = await ingestSyncBatch(principal, [
      orderItem({ priceTag: "NOBODY", totalAmountPaise: 10_000, lines: [{ productId: skuB, quantityCans: 1, ratePaise: 10_000 }] }),
    ]);
    assert.equal(r.status, "rejected", JSON.stringify(r));
  });

  test("a total above what the lines add up to is refused", async () => {
    const [r] = await ingestSyncBatch(principal, [
      orderItem({ totalAmountPaise: 99_999, lines: [{ productId: skuA, quantityCans: 1, ratePaise: 11_800 }] }),
    ]);
    assert.equal(r.status, "rejected", JSON.stringify(r));
  });

  test("an unvalued order, as every build with no price source sends, still lands", async () => {
    const [r] = await ingestSyncBatch(principal, [
      orderItem({ totalAmountPaise: 0, valueUnavailable: true, lines: [{ productId: skuA, quantityCans: 2 }] }),
    ]);
    assert.equal(r.status, "accepted", JSON.stringify(r));
  });
});

describe("B7 · the office's list is the authority, and the handset is told it", () => {
  test("the list rate passes, the tag rate does not, and the order names its list", async () => {
    const [stale] = await ingestSyncBatch(principal, [
      orderItem({ totalAmountPaise: 9_000, lines: [{ productId: skuA, quantityCans: 1, ratePaise: 9_000 }] }),
    ]);
    assert.equal(stale.status, "rejected", "the tag table's rate is not the office's for a listed product");

    const [ok] = await ingestSyncBatch(principal, [
      orderItem({ totalAmountPaise: 23_600, lines: [{ productId: skuA, quantityCans: 2, ratePaise: 11_800 }] }),
    ]);
    assert.equal(ok.status, "accepted", JSON.stringify(ok));
    const [o] = await db.select().from(orders);
    assert.equal(o.priceListId, listId);
  });

  test("a product no list carries falls back to the tag table", async () => {
    const [r] = await ingestSyncBatch(principal, [
      orderItem({ totalAmountPaise: 30_000, lines: [{ productId: skuB, quantityCans: 1, ratePaise: 30_000 }] }),
    ]);
    assert.equal(r.status, "accepted", JSON.stringify(r));
    const [o] = await db.select().from(orders);
    assert.equal(o.priceListId, null, "nothing on it came from a list");
  });

  test("the price channel carries the office's rate under the shop's own tag", async () => {
    const boot = await buildBootstrap(principal);
    const rows = boot.priceList as { priceTag: string; productId: string; ratePaise: number }[];
    assert.equal(rows.find((r) => r.priceTag === TAG && r.productId === skuA)?.ratePaise, 11_800);
    assert.equal(rows.find((r) => r.priceTag === TAG && r.productId === skuB)?.ratePaise, 30_000);
    assert.equal(rows.filter((r) => r.priceTag === TAG && r.productId === skuA).length, 1);
  });
});

describe("B9 · the ERP order form holds discounts and typed rates to the ceilings", () => {
  async function erpUser(level: "associate" | "manager") {
    const [u] = await db
      .insert(users)
      .values({ id: id("usr"), name: `ERP ${level}`, email: `${id(level)}@erp.test`, passwordHash: "x", role: level, initials: "EU" })
      .returning();
    await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
    await db.insert(erpUserPowers).values([
      { userId: u.id, power: "viewSalesRate" },
      { userId: u.id, power: "viewSalesAmounts" },
    ]);
    setTestUser(u);
    return { u, ctx: await erpContext() };
  }
  const head = { source: "Phone", date: "2026-10-01", godown: "Bhiwandi", billing: "Sai Paint Depot" };
  const newOrder = async (ctx: Awaited<ReturnType<typeof erpContext>>, line: Record<string, string>) =>
    screenModule("orders")!.forms!.new(ctx, head, [{ sku: skuAName, qty: "2", ...line }]);
  const reason = (r: { ok: boolean; fieldErrors?: { field: string; message: string }[]; error?: string }) =>
    r.ok ? "ok" : `${r.fieldErrors?.[0]?.field ?? ""}: ${r.fieldErrors?.[0]?.message ?? r.error}`;

  test("an associate may give no discount by default, on the box or through the rate", async () => {
    const { ctx } = await erpUser("associate");
    assert.match(reason(await newOrder(ctx, { discount: "5" })), /^l0\.discount: .*manager/);
    assert.match(reason(await newOrder(ctx, { rate: "90" })), /^l0\.rate: .*under the list/);
    assert.equal(reason(await newOrder(ctx, { rate: "100" })), "ok", "the list's own rate needs nobody");
  });

  test("a manager may give up to the manager ceiling, and is recorded as the authority", async () => {
    const { u, ctx } = await erpUser("manager");
    assert.equal(reason(await newOrder(ctx, { discount: "10" })), "ok");
    assert.notEqual(reason(await newOrder(ctx, { discount: "11" })), "ok");
    assert.notEqual(reason(await newOrder(ctx, { rate: "95", discount: "6" })), "ok", "rate and discount together are 10.6%");
    const [line] = await db.select().from(erpOrders).where(eq(erpOrders.discountBp, 1000));
    assert.equal(line.discountAuthorisedById, u.id);
    assert.equal(line.listRatePaise, 10_000);
    assert.equal(line.rateSetById, null, "the list's rate was not overridden");
  });

  test("a rate other than the list's is recorded with who set it", async () => {
    const { u, ctx } = await erpUser("manager");
    assert.equal(reason(await newOrder(ctx, { rate: "120" })), "ok");
    const [line] = await db.select().from(erpOrders).where(eq(erpOrders.ratePaise, 12_000));
    assert.equal(line.rateSetById, u.id);
    assert.ok(line.rateSetAt);
    assert.equal(line.listRatePaise, 10_000);
  });

  test("an edit that moves the discount is decided again", async () => {
    const { ctx } = await erpUser("associate");
    assert.equal(reason(await newOrder(ctx, {})), "ok");
    const [line] = await db.select().from(erpOrders);
    const edit = await screenModule("orders")!.forms!.edit(ctx, { status: "Under Process", delivery: "Sai Paint Depot", qty: "2", rate: "100", discount: "3", transport: "0" }, [], line.id);
    assert.match(reason(edit), /discount/);
    const quantity = await screenModule("orders")!.forms!.edit(ctx, { status: "Under Process", delivery: "Sai Paint Depot", qty: "3", rate: "100", transport: "0" }, [], line.id);
    assert.equal(reason(quantity), "ok", "a line whose price did not move is not re-decided");
  });
});
