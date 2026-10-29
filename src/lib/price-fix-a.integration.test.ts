/**
 * PRICE-LIST WRITE PATHS, held to what they promise.
 *
 * A version dated for later leaves the old list in force until then; a
 * special price is written only into the shop's own agreed list and layers
 * over the list it is assigned; a published list's prices and discounts are
 * not edited in place; and the decisions that race (two publishes, two
 * approvals) land once.
 *
 *   npm run test:integration   (needs mahekone_test — `npm run test:db`)
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  finishedGoods,
  priceListRates,
  priceListScopes,
  priceLists,
  priceRequests,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import {
  addScope,
  assignCustomerList,
  bulkRevise,
  createPriceList,
  decidePriceRequest,
  newVersion,
  publishPriceList,
  requestSpecialPrice,
  setDiscountTerm,
  setRate,
  updateScope,
  withdrawPriceList,
} from "@/lib/actions/price-lists";
import { listRequests, ratesForCustomer, resolveForCustomer } from "@/lib/services/price-list-service";
import { supersedeEndedPriceLists } from "@/lib/services/price-supersede";
import { AGREED_SCOPE_PRIORITY } from "@/lib/engines/price-resolution";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let manager: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
let nano20: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager", apps: Array<"crm" | "sales" | "accounts">) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const app of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

async function makeProduct(name: string, millilitres: number, cansPerBox: number, packing: string) {
  const formulationId = id("fml");
  const brandId = id("brn");
  const fgId = id("fgd");
  await db.insert(productFormulations).values({ id: formulationId, name: `F ${name}`, slug: id("s") });
  await db.insert(productBrands).values({ id: brandId, name: name.split(" - ")[0], slug: id("s"), formulationId });
  await db.insert(finishedGoods).values({ id: fgId, name: name.split(" (")[0], slug: id("s"), brandId, formulationId, millilitres });
  const [row] = await db
    .insert(products)
    .values({ id: id("prd"), name, millilitresPerCan: millilitres, cansPerBox, packing, finishedGoodId: fgId, brandId, formulationId })
    .returning();
  return row;
}

async function makeCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: over.name ?? `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Thane",
      region: "Maharashtra",
      kind: "customer",
      ownerId: telecaller.id,
      salesAmId: telecaller.id,
      ...over,
    })
    .returning();
  return row;
}

/** A draft with both Nano rates; `scope` adds who it applies to. */
async function draftList(name: string, effectiveFrom: string, inclTwenty = 228_600) {
  setTestUser(manager);
  const created = await createPriceList({ name, effectiveFrom, freightTerm: "not_stated", deliveryBasis: "for_mumbai" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  for (const [product, incl] of [
    [nano20, inclTwenty],
    [nano5, 58_400],
  ] as const) {
    const r = await setRate({ priceListId: created.data.id, productId: product.id, rateInclGstPaise: incl });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
  return created.data.id;
}

async function stateList(name: string, effectiveFrom: string, inclTwenty = 228_600) {
  const listId = await draftList(name, effectiveFrom, inclTwenty);
  const scoped = await addScope({ priceListId: listId, scopeKind: "state", scopeValue: key("Maharashtra"), scopeLabel: "Maharashtra" });
  assert.ok(scoped.ok, scoped.ok ? "" : scoped.error);
  const published = await publishPriceList(listId);
  assert.ok(published.ok, published.ok ? "" : published.error);
  return listId;
}

async function listOf(listId: string) {
  const [row] = await db.select().from(priceLists).where(eq(priceLists.id, listId));
  return row;
}

before(async () => {
  await seedConfig();
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      price_list_parse_rows, price_list_rates, price_list_scopes,
      price_list_discount_terms, price_requests, price_lists,
      price_list_documents,
      audit_log, notifications, attachments, orders, calls,
      interaction_product_lines, sheet_order_rows, sheet_sync_runs,
      app_access, sessions, customers, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Vikram", "manager", ["sales", "accounts"]);
  telecaller = await makeUser("Priya", "associate", ["crm"]);
  clerk = await makeUser("Deepa", "associate", ["accounts"]);
  await db.update(users).set({ reportsToId: manager.id }).where(eq(users.id, telecaller.id));
  nano20 = await makeProduct("Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2, "2 Can/Box");
  nano5 = await makeProduct("Nano Thinner - 5 Liter (6 Can/Box)", 5000, 6, "6 Can/Box");
  setTestUser(manager);
});

describe("a version dated for later", () => {
  test("leaves the old list in force until the new one starts, then the job files it as superseded", async () => {
    const shop = await makeCustomer();
    const v1 = await stateList("Maharashtra", addDays(TODAY, -40));
    const v2 = await draftList("Maharashtra v2", addDays(TODAY, 10), 240_000);
    const published = await publishPriceList(v2, { supersedesId: v1 });
    assert.ok(published.ok, published.ok ? "" : published.error);

    const old = await listOf(v1);
    assert.equal(old.status, "published", "still the list shops are priced from");
    assert.equal(old.effectiveTo, addDays(TODAY, 9));
    assert.equal((await resolveForCustomer(shop.id, TODAY))?.listId, v1);
    assert.equal((await ratesForCustomer(shop.id, [nano20.id], TODAY))[nano20.id].rateInclGstPaise, 228_600);

    // The scopes came over once, and nothing ends early.
    const carried = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, v2));
    assert.equal(carried.length, 1);
    assert.equal(await supersedeEndedPriceLists(TODAY), 0);
    assert.equal((await listOf(v1)).status, "published");

    // From the new version's first day the old one has ended.
    assert.equal((await resolveForCustomer(shop.id, addDays(TODAY, 10)))?.listId, v2);
    assert.equal(await supersedeEndedPriceLists(addDays(TODAY, 10)), 1);
    assert.equal((await listOf(v1)).status, "superseded");
    assert.equal(await supersedeEndedPriceLists(addDays(TODAY, 10)), 0, "idempotent");
  });

  test("a list has one successor, and withdrawing it before it starts gives the old list back its open end", async () => {
    const v1 = await stateList("Maharashtra", addDays(TODAY, -40));
    const v2 = await draftList("Maharashtra v2", addDays(TODAY, 10));
    assert.ok((await publishPriceList(v2, { supersedesId: v1 })).ok);

    const v3 = await draftList("Maharashtra v3", addDays(TODAY, 20));
    const second = await publishPriceList(v3, { supersedesId: v1 });
    assert.equal(second.ok, false);
    assert.match(second.ok ? "" : second.error, /already being replaced/);

    const report = await import("@/lib/impact/registry").then((m) => m.impactReport("price-list-withdrawal", v2));
    assert.ok(report.ok, report.ok ? "" : report.error);
    const withdrawn = await withdrawPriceList(v2, "Issued too early", {
      typed: report.data.confirmWord,
      fingerprint: report.data.fingerprint,
    });
    assert.ok(withdrawn.ok, withdrawn.ok ? "" : withdrawn.error);
    const old = await listOf(v1);
    assert.equal(old.status, "published");
    assert.equal(old.effectiveTo, null);
  });

  test("a version published for today supersedes at once, as before", async () => {
    const v1 = await stateList("Maharashtra", addDays(TODAY, -40));
    const v2 = await draftList("Maharashtra v2", TODAY);
    assert.ok((await publishPriceList(v2, { supersedesId: v1 })).ok);
    const old = await listOf(v1);
    assert.equal(old.status, "superseded");
    assert.equal(old.effectiveTo, addDays(TODAY, -1));
  });

  test("two publishes of one draft at once publish it once and copy its scopes once", async () => {
    const v1 = await stateList("Maharashtra", addDays(TODAY, -40));
    const v2 = await draftList("Maharashtra v2", TODAY);
    const results = await Promise.all([
      publishPriceList(v2, { supersedesId: v1 }),
      publishPriceList(v2, { supersedesId: v1 }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    const carried = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, v2));
    assert.equal(carried.length, 1);
  });
});

describe("a published list is not edited in place", () => {
  test("a rate cannot be set on a list in force", async () => {
    const listId = await stateList("Maharashtra", addDays(TODAY, -40));
    const r = await setRate({ priceListId: listId, productId: nano20.id, rateInclGstPaise: 100_000 });
    assert.equal(!r.ok && r.code, "rule_violation");
    const [rate] = await db.select().from(priceListRates).where(eq(priceListRates.priceListId, listId)).limit(1);
    assert.ok(rate);
  });

  test("a discount is set only on a draft, and only a term of the list named", async () => {
    const published = await stateList("Maharashtra", addDays(TODAY, -40));
    assert.equal((await setDiscountTerm({ priceListId: published, kind: "advance_payment", percentBp: 300 })).ok, false);

    const a = await draftList("Draft A", TODAY);
    const b = await draftList("Draft B", TODAY);
    const term = await setDiscountTerm({ priceListId: a, kind: "advance_payment", percentBp: 300 });
    assert.ok(term.ok, term.ok ? "" : term.error);
    const cross = await setDiscountTerm({ id: term.data.id, priceListId: b, kind: "advance_payment", percentBp: 900 });
    assert.equal(cross.ok, false);
  });

  test("withdraw takes a published list only, and a scope cannot end before it starts", async () => {
    const draft = await draftList("Draft", TODAY);
    const w = await withdrawPriceList(draft, "Never mind");
    assert.equal(!w.ok && w.code, "rule_violation");

    const bad = await addScope({ priceListId: draft, scopeKind: "state", scopeValue: "Maharashtra", validFrom: TODAY, validTo: addDays(TODAY, -1) });
    assert.equal(bad.ok, false);
    const good = await addScope({ priceListId: draft, scopeKind: "state", scopeValue: "Maharashtra", validFrom: TODAY });
    assert.ok(good.ok);
    const moved = await updateScope(good.data.id, { validTo: addDays(TODAY, -3) });
    assert.equal(moved.ok, false);
  });
});

describe("versions", () => {
  test("a second new version opens the draft already there, and an ended list makes none", async () => {
    const v1 = await stateList("Maharashtra", addDays(TODAY, -40));
    const first = await newVersion(v1, { effectiveFrom: addDays(TODAY, 5) });
    const second = await newVersion(v1, { effectiveFrom: addDays(TODAY, 6) });
    assert.ok(first.ok && second.ok);
    assert.equal(first.data.id, second.data.id);
    const [{ n }] = await db.execute<{ n: number }>(sql`select count(*)::int as n from price_lists where supersedes_id = ${v1}`);
    assert.equal(Number(n), 1);

    const revise = await bulkRevise(v1, { derivation: { kind: "percent_bp", bp: 500 }, effectiveFrom: addDays(TODAY, 5), roundToRupee: true });
    assert.equal(revise.ok, false, "it would move a draft's rates a second time");

    await db.update(priceLists).set({ status: "superseded" }).where(eq(priceLists.id, v1));
    const ended = await newVersion(v1, { effectiveFrom: addDays(TODAY, 5) });
    assert.equal(!ended.ok && ended.code, "rule_violation");
  });
});

describe("a special price", () => {
  async function ask(customerId: string, incl: number) {
    setTestUser(telecaller);
    const asked = await requestSpecialPrice({ customerId, productId: nano20.id, requestedRateInclGstPaise: incl, reason: "Taking a hundred cans" });
    assert.ok(asked.ok, asked.ok ? "" : asked.error);
    setTestUser(manager);
    return asked.data.id;
  }

  test("is never written into a shared list the shop is assigned, and layers over it", async () => {
    await stateList("Maharashtra", addDays(TODAY, -40));
    const shop = await makeCustomer({ name: "Kamal Hardware" });
    const neighbour = await makeCustomer({ name: "Shree Paints" });
    const shared = await draftList("Western dealers", addDays(TODAY, -30), 220_000);
    assert.ok((await publishPriceList(shared)).ok);
    assert.ok((await assignCustomerList({ customerId: shop.id, priceListId: shared })).ok);
    assert.ok((await assignCustomerList({ customerId: neighbour.id, priceListId: shared })).ok);

    const decided = await decidePriceRequest(await ask(shop.id, 210_000), { decision: "approved" });
    assert.ok(decided.ok, decided.ok ? "" : decided.error);
    assert.notEqual(decided.data.listId, shared);
    const agreed = await listOf(decided.data.listId!);
    assert.equal(agreed.kind, "agreed");

    // The shared list still charges what it always did, to both shops.
    const [sharedRate] = await db.execute<{ incl: number }>(sql`
      select rate_incl_gst_paise as incl from price_list_rates where price_list_id = ${shared} and product_id = ${nano20.id}
    `);
    assert.equal(Number(sharedRate.incl), 220_000);
    assert.equal((await ratesForCustomer(neighbour.id, [nano20.id], TODAY))[nano20.id].rateInclGstPaise, 220_000);
    // And the shop gets its agreed price.
    assert.equal((await ratesForCustomer(shop.id, [nano20.id], TODAY))[nano20.id].rateInclGstPaise, 210_000);
    const [agreedScope] = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, agreed.id));
    assert.equal(agreedScope.priority, AGREED_SCOPE_PRIORITY);

    // A second approval joins the same agreed list.
    const again = await decidePriceRequest(await ask(shop.id, 205_000), { decision: "approved" });
    assert.ok(again.ok);
    assert.equal(again.data.listId, agreed.id);

    // Reassigning the shop leaves its agreed prices where they are.
    assert.ok((await assignCustomerList({ customerId: shop.id, priceListId: null })).ok);
    const kept = await db.select().from(priceListScopes).where(eq(priceListScopes.priceListId, agreed.id));
    assert.equal(kept.length, 1);
    const refused = await assignCustomerList({ customerId: neighbour.id, priceListId: agreed.id });
    assert.equal(refused.ok, false, "an agreed list is not assigned to another shop");
  });

  test("two people deciding one request at once: one decides it, the other is told", async () => {
    await stateList("Maharashtra", addDays(TODAY, -40));
    const shop = await makeCustomer();
    const requestId = await ask(shop.id, 210_000);
    const results = await Promise.all([
      decidePriceRequest(requestId, { decision: "approved" }),
      decidePriceRequest(requestId, { decision: "refused", note: "No" }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    const loser = results.find((r) => !r.ok);
    assert.match(loser && !loser.ok ? loser.error : "", /already|just been/);
    const [{ n }] = await db.execute<{ n: number }>(sql`select count(*)::int as n from price_lists where kind = 'agreed'`);
    const [request] = await db.select().from(priceRequests).where(eq(priceRequests.id, requestId));
    assert.equal(Number(n), request.status === "approved" ? 1 : 0);
  });

  test("the price desk sees the whole queue; anybody else sees their own", async () => {
    await stateList("Maharashtra", addDays(TODAY, -40));
    const shop = await makeCustomer();
    await ask(shop.id, 210_000);

    setTestUser(clerk);
    assert.equal((await listRequests()).length, 1, "an Accounts associate decides prices");
    setTestUser(telecaller);
    assert.equal((await listRequests()).length, 1, "her own");
    const other = await makeUser("Rakesh", "associate", ["crm"]);
    setTestUser(other);
    assert.equal((await listRequests()).length, 0);
  });
});
