/**
 * PRICE DESK · TODAY — the morning check and the screen's numbers, against the
 * real database and the real actions.
 *
 *   npm run test:integration   (needs mahekone_test — `npm run test:db`)
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  customers,
  finishedGoods,
  priceOverrides,
  priceRequests,
  productBrands,
  productFormulations,
  products,
  sheetOrderRows,
  sheetSyncRuns,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { addScope, createPriceList, publishPriceList, setRate } from "@/lib/actions/price-lists";
import { acknowledgeFlag, checkChange, setChangeCells, setChangeDetails, startChange, submitChange } from "@/lib/actions/price-books";
import { dismissFinding } from "@/lib/actions/price-today";
import { priceDeskToday, runMorningCheck } from "@/lib/services/price-today-service";
import { varianceForRange, varianceReport } from "@/lib/services/price-list-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let desk: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let nano1: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;
let nano20: typeof products.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager", apps: Array<"crm" | "accounts">) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const app of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

async function makeProduct(name: string, millilitres: number, brandId: string, formulationId: string) {
  const fgId = id("fgd");
  await db.insert(finishedGoods).values({ id: fgId, name, slug: id("s"), brandId, formulationId, millilitres });
  const [row] = await db
    .insert(products)
    .values({ id: id("prd"), name, millilitresPerCan: millilitres, cansPerBox: 1, packing: "Loose", finishedGoodId: fgId, brandId, formulationId })
    .returning();
  return row;
}

/** A published standard book over one state, live since 40 days ago, valid for `validityDays`. */
async function book(name: string, state: string, rates: Array<[typeof products.$inferSelect, number]>, validityDays: number) {
  setTestUser(desk);
  const created = await createPriceList({ name, effectiveFrom: addDays(TODAY, -40), freightTerm: "not_stated", deliveryBasis: "for_mumbai" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  await db.execute(sql`update price_lists set validity_days = ${validityDays} where id = ${created.data.id}`);
  for (const [product, incl] of rates) {
    const r = await setRate({ priceListId: created.data.id, productId: product.id, rateInclGstPaise: incl });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
  const scoped = await addScope({ priceListId: created.data.id, scopeKind: "state", scopeValue: key(state), scopeLabel: state });
  assert.ok(scoped.ok, scoped.ok ? "" : scoped.error);
  const published = await publishPriceList(created.data.id);
  assert.ok(published.ok, published.ok ? "" : published.error);
  return created.data.id;
}

async function sheetLine(syncId: string, input: { customerId: string; productId: string; cans: number; ratePaise: number; orderDate: string }) {
  await db.insert(sheetOrderRows).values({
    id: id("sor"),
    syncId,
    rowNumber: 1,
    lineKey: id("lk"),
    orderNumber: id("ORD"),
    raw: {},
    rowHash: randomUUID(),
    status: "present",
    orderDate: input.orderDate,
    cans: input.cans,
    ratePaise: input.ratePaise,
    matchedCustomerId: input.customerId,
    matchedProductId: input.productId,
  });
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
      price_change_events, price_changes, price_ai_runs, price_overrides, price_book_findings,
      price_list_parse_rows, price_list_rates, price_list_scopes,
      price_list_discount_terms, price_requests, price_lists,
      price_list_documents, job_runs,
      audit_log, notifications, attachments, orders, calls, bills,
      interaction_product_lines, sheet_order_rows, sheet_sync_runs,
      app_access, sessions, customers, users,
      products, finished_goods, product_brands, product_formulations,
      app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Deepa", "manager", ["accounts"]);
  telecaller = await makeUser("Priya", "associate", ["crm"]);
  const formulationId = id("fml");
  const brandId = id("brn");
  await db.insert(productFormulations).values({ id: formulationId, name: "F Nano", slug: id("s") });
  await db.insert(productBrands).values({ id: brandId, name: "Nano Thinner", slug: id("s"), formulationId });
  nano1 = await makeProduct("Nano Thinner - 1 Liter", 1000, brandId, formulationId);
  nano5 = await makeProduct("Nano Thinner - 5 Liter", 5000, brandId, formulationId);
  nano20 = await makeProduct("Nano Thinner - 20 Liter", 20000, brandId, formulationId);
  setTestUser(desk);
});

/**
 * Maharashtra: a 5 L dearer a litre than the 1 L (ladder), and a 20 L at a
 * tenth of Gujarat's (typo). Gujarat expires in five days with nothing next.
 */
async function seed() {
  const mh = await book(
    "Maharashtra",
    "Maharashtra",
    [
      [nano1, 23_600], // ₹200 ex
      [nano5, 177_000], // ₹1,500 ex → ₹300 a litre, more than the 1 L
      [nano20, 35_400], // ₹300 ex — ten times under Gujarat
    ],
    365,
  );
  const gj = await book(
    "Gujarat",
    "Gujarat",
    [
      [nano1, 24_780], // ₹210 ex
      [nano5, 106_200], // ₹900 ex
      [nano20, 354_000], // ₹3,000 ex
    ],
    45,
  );
  const [shop] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "Bombay Paints",
      contactPerson: "Contact",
      phone: testPhone(),
      city: "Thane",
      region: "Maharashtra",
      kind: "customer",
      ownerId: telecaller.id,
      salesAmId: telecaller.id,
    })
    .returning();

  const syncId = id("syn");
  await db.insert(sheetSyncRuns).values({ id: syncId, source: "order", spreadsheetId: "test-sheet", tabTitle: "Order Details", mode: "append", status: "ok" });
  // Billed ₹180 against ₹200 this morning, ten cans: ₹200 under the list this week.
  await sheetLine(syncId, { customerId: shop.id, productId: nano1.id, cans: 10, ratePaise: 18_000, orderDate: TODAY });
  // Sixty cans of the 5 L two months ago: ten a month over six.
  const twoMonthsAgo = `${addDays(`${addDays(`${TODAY.slice(0, 7)}-01`, -1).slice(0, 7)}-01`, -1).slice(0, 7)}-10`;
  await sheetLine(syncId, { customerId: shop.id, productId: nano5.id, cans: 60, ratePaise: 150_000, orderDate: twoMonthsAgo });

  // A special price asked for: ₹1,400 against ₹1,500 → ₹100 × 10 cans a month.
  await db.insert(priceRequests).values({
    id: id("prq"),
    customerId: shop.id,
    productId: nano5.id,
    requestedRateExGstPaise: 140_000,
    currentRateExGstPaise: 150_000,
    currentListId: mh,
    reason: "Competitor",
    status: "pending",
    requestedById: telecaller.id,
  });

  // A special price ending in three days.
  await db.insert(priceOverrides).values({
    id: id("pov"),
    customerId: shop.id,
    productId: nano1.id,
    rateExGstPaise: 19_000,
    rateInclGstPaise: 22_420,
    validFrom: addDays(TODAY, -20),
    validTo: addDays(TODAY, 3),
  });

  // A change on Maharashtra, sent for approval, going live in three days.
  const started = await startChange(mh);
  assert.ok(started.ok, started.ok ? "" : started.error);
  const changeId = started.data.changeId;
  assert.ok((await setChangeCells(changeId, [{ productId: nano1.id, minCans: null, inclPaise: 24_190 }])).ok);
  const details = await setChangeDetails(changeId, { reason: "Diwali revision", goLive: addDays(TODAY, 3) });
  assert.ok(details.ok, details.ok ? "" : details.error);
  const checked = await checkChange(changeId, { ai: false });
  assert.ok(checked.ok, checked.ok ? "" : checked.error);
  for (const f of checked.data.flags.filter((f) => !f.blocking)) assert.ok((await acknowledgeFlag(changeId, f.key, "Intended.")).ok);
  const sent = await submitChange(changeId);
  assert.ok(sent.ok, sent.ok ? "" : sent.error);

  return { mh, gj, shop, changeId };
}

describe("the morning check", () => {
  test("finds the ladder, the typo, the expiring book and the ending override; a dismissal survives a re-run", async () => {
    const { mh, gj } = await seed();
    const first = await runMorningCheck(TODAY);
    assert.ok(first.written > 0, first.detail);
    const rows = async () =>
      [
        ...(await db.execute<{ id: string; kind: string; bookId: string | null; productId: string | null; dismissed: boolean }>(sql`
          select id, kind, book_id as "bookId", product_id as "productId", dismissed_at is not null as dismissed
            from price_book_findings where run_day = ${TODAY}::date
        `)),
      ];
    const found = await rows();
    const ladder = found.find((f) => f.kind === "ladder" && f.bookId === mh && f.productId === nano5.id);
    assert.ok(ladder, "Maharashtra's 5 L is dearer a litre than its 1 L");
    assert.ok(found.some((f) => f.kind === "typo" && f.bookId === mh && f.productId === nano20.id), "₹300 against ₹3,000");
    assert.ok(found.some((f) => f.kind === "expiring_unscheduled" && f.bookId === gj), "Gujarat runs out in five days");
    assert.ok(!found.some((f) => f.kind === "expiring_unscheduled" && f.bookId === mh));
    assert.ok(found.some((f) => f.kind === "override_ending"));
    assert.ok(!found.some((f) => f.kind === "names_nobody"), "both books name a state");
    assert.ok(!found.some((f) => f.kind === "gst_mismatch"), "every inclusive figure was built from its rate");

    // Re-running replaces, never doubles.
    await runMorningCheck(TODAY);
    assert.equal((await rows()).length, found.length);

    // Dismissed: stays dismissed, is not raised beside itself.
    assert.equal((await dismissFinding(ladder.id, "")).ok, false, "a note is required");
    const dismissed = await dismissFinding(ladder.id, "The 5 L is a premium pack.");
    assert.ok(dismissed.ok, dismissed.ok ? "" : dismissed.error);
    await runMorningCheck(TODAY);
    const after = await rows();
    const ladders = after.filter((f) => f.kind === "ladder" && f.bookId === mh && f.productId === nano5.id);
    assert.equal(ladders.length, 1);
    assert.equal(ladders[0].id, ladder.id);
    assert.equal(ladders[0].dismissed, true);
    assert.equal(after.length, found.length);

    // Somebody off the desk cannot dismiss.
    setTestUser(telecaller);
    const typo = after.find((f) => f.kind === "typo")!;
    assert.equal((await dismissFinding(typo.id, "nope")).ok, false);
    setTestUser(desk);
  });
});

describe("the Today screen", () => {
  test("five numbers, and Needs you ordered by money at stake", async () => {
    const { mh, changeId } = await seed();
    await runMorningCheck(TODAY);
    const t = await priceDeskToday(TODAY, desk.id);

    assert.equal(t.counts.booksInForce, 2);
    assert.equal(t.counts.changesWaiting, 1);
    assert.equal(t.counts.goingLiveThisWeek, 0, "submitted is not approved");
    assert.equal(t.counts.specialPricesWaiting, 1);
    assert.equal(t.counts.billedBelowPaise, 2_000 * 10);

    const kinds = t.needs.map((n) => n.kind);
    const request = t.needs.find((n) => n.kind === "special_price")!;
    assert.equal(request.moneyPaise, 10_000 * 10);
    const below = t.needs.find((n) => n.kind === "billed_below")!;
    assert.equal(below.moneyPaise, Math.round((20_000 * 30) / 7));
    const change = t.needs.find((n) => n.kind === "change_to_approve")!;
    assert.equal(change.href, `/books/${mh}/changes/${changeId}`);
    assert.equal(change.raisedByYou, true, "Deepa made it — someone else approves");
    assert.ok(kinds.indexOf("special_price") < kinds.indexOf("billed_below"), "₹1,000 a month before ₹857");
    assert.ok(kinds.indexOf("billed_below") < kinds.indexOf("book_expiring"), "priced rows before unpriced");
    assert.ok(t.needs.some((n) => n.kind === "book_expiring" && n.title.startsWith("Gujarat")));
    assert.ok(t.needs.some((n) => n.kind === "finding" && n.findingKind === "typo"));
    assert.ok(!t.needs.some((n) => n.kind === "finding" && n.findingKind === "expiring_unscheduled"), "said once, as the book row");

    // The week: seven days, the change waiting on its go-live day, Gujarat ending.
    assert.equal(t.week.length, 7);
    const goLive = t.week.find((d) => d.day === addDays(TODAY, 3))!;
    assert.ok(goLive.events.some((e) => e.kind === "waiting_approval"));
    assert.ok(t.week.find((d) => d.day === addDays(TODAY, 5))!.events.some((e) => e.kind === "expiring"));
    assert.ok(t.checkedAt == null, "the service ran, not the job — no job row today");
    assert.ok(t.findings.length > 0);
  });

  test("varianceReport reads the same as a range over its month", async () => {
    await seed();
    const month = TODAY.slice(0, 7);
    const byMonth = await varianceReport(month);
    const byRange = await varianceForRange(`${month}-01`, addDays(`${month}-01`, 31).slice(0, 8) + "01");
    assert.equal(byMonth.month, month);
    assert.deepEqual(byMonth.rows, byRange.rows);
    assert.deepEqual(byMonth.summary, byRange.summary);
  });
});
