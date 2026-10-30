/**
 * PRICE BOOKS — a change, from the first edit to the day it goes live,
 * against the real database and the real actions.
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
  priceChanges,
  priceLists,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { addDays } from "@/lib/business-date";
import { addScope, createPriceList, deleteDraftPriceList, publishPriceList, setRate } from "@/lib/actions/price-lists";
import {
  acknowledgeFlag,
  applyInstructionRule,
  approveChange,
  cancelChange,
  checkChange,
  moveGoLive,
  previewInstruction,
  sendBackChange,
  setChangeCells,
  setChangeDetails,
  startChange,
  submitChange,
  takeOverChange,
} from "@/lib/actions/price-books";
import { bookDetail, changeDetail, listBooks } from "@/lib/services/price-book-service";
import { ratesForCustomer, resolveForCustomer } from "@/lib/services/price-list-service";
import { supersedeEndedPriceLists } from "@/lib/services/price-supersede";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let TODAY: string;
let maker: typeof users.$inferSelect;
let approver: typeof users.$inferSelect;
let third: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let nano20: typeof products.$inferSelect;
let nano5: typeof products.$inferSelect;

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

async function makeProduct(name: string, millilitres: number, cansPerBox: number) {
  const formulationId = id("fml");
  const brandId = id("brn");
  const fgId = id("fgd");
  await db.insert(productFormulations).values({ id: formulationId, name: `F ${name}`, slug: id("s") });
  await db.insert(productBrands).values({ id: brandId, name: "Nano Thinner", slug: id("s"), formulationId });
  await db.insert(finishedGoods).values({ id: fgId, name: name.split(" (")[0], slug: id("s"), brandId, formulationId, millilitres });
  const [row] = await db
    .insert(products)
    .values({ id: id("prd"), name, millilitresPerCan: millilitres, cansPerBox, packing: `${cansPerBox} Can/Box`, finishedGoodId: fgId, brandId, formulationId })
    .returning();
  return row;
}

async function makeShop() {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: testPhone(),
      city: "Thane",
      region: "Maharashtra",
      kind: "customer",
      ownerId: telecaller.id,
      salesAmId: telecaller.id,
    })
    .returning();
  return row;
}

/** A published Maharashtra book, live since 40 days ago. */
async function liveBook(): Promise<string> {
  setTestUser(maker);
  const created = await createPriceList({ name: "Maharashtra", effectiveFrom: addDays(TODAY, -40), freightTerm: "not_stated", deliveryBasis: "for_mumbai" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  for (const [product, incl] of [
    [nano20, 228_600],
    [nano5, 58_400],
  ] as const) {
    const r = await setRate({ priceListId: created.data.id, productId: product.id, rateInclGstPaise: incl });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
  const scoped = await addScope({ priceListId: created.data.id, scopeKind: "state", scopeValue: key("Maharashtra"), scopeLabel: "Maharashtra" });
  assert.ok(scoped.ok, scoped.ok ? "" : scoped.error);
  const published = await publishPriceList(created.data.id);
  assert.ok(published.ok, published.ok ? "" : published.error);
  return created.data.id;
}

async function listOf(listId: string) {
  const [row] = await db.select().from(priceLists).where(eq(priceLists.id, listId));
  return row;
}

/** Edit, check (rules only), acknowledge every non-blocking flag, give a reason, and send. */
async function readyAndSend(changeId: string, cells: Parameters<typeof setChangeCells>[1], goLive: string) {
  setTestUser(maker);
  assert.ok((await setChangeCells(changeId, cells)).ok);
  const details = await setChangeDetails(changeId, { reason: "Diwali revision", goLive });
  assert.ok(details.ok, details.ok ? "" : details.error);
  const checked = await checkChange(changeId, { ai: false });
  assert.ok(checked.ok, checked.ok ? "" : checked.error);
  for (const f of checked.data.flags.filter((f) => !f.blocking)) assert.ok((await acknowledgeFlag(changeId, f.key, "Intended.")).ok);
  const sent = await submitChange(changeId);
  assert.ok(sent.ok, sent.ok ? "" : sent.error);
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
  maker = await makeUser("Deepa", "manager", ["accounts"]);
  approver = await makeUser("Vikram", "manager", ["accounts"]);
  third = await makeUser("Asha", "associate", ["accounts"]);
  telecaller = await makeUser("Priya", "associate", ["crm"]);
  nano20 = await makeProduct("Nano Thinner - 20 Liter (2 Can/Box)", 20000, 2);
  nano5 = await makeProduct("Nano Thinner - 5 Liter (6 Can/Box)", 5000, 6);
  setTestUser(maker);
});

describe("a book is a lineage", () => {
  test("a version inherits its predecessor's book; a list on its own starts one", async () => {
    const v1 = await liveBook();
    assert.equal((await listOf(v1)).bookId, v1);
    const started = await startChange(v1);
    assert.ok(started.ok, started.ok ? "" : started.error);
    const [change] = await db.select().from(priceChanges).where(eq(priceChanges.id, started.data.changeId));
    assert.equal((await listOf(change.draftListId)).bookId, v1);
    const books = await listBooks();
    assert.equal(books.length, 1, "the change's draft is not a second book");
    assert.equal(books[0].state, "change_waiting");
  });
});

describe("a change, end to end", () => {
  test("edited, checked, sent, approved by somebody else, live on its date", async () => {
    const shop = await makeShop();
    const v1 = await liveBook();
    const started = await startChange(v1);
    assert.ok(started.ok);
    const changeId = started.data.changeId;
    const again = await startChange(v1);
    assert.ok(again.ok && again.data.existing && again.data.changeId === changeId, "one open change per book");

    // The list screens cannot publish or delete a change's draft.
    const [row] = await db.select().from(priceChanges).where(eq(priceChanges.id, changeId));
    assert.equal((await publishPriceList(row.draftListId)).ok, false);
    assert.equal((await deleteDraftPriceList(row.draftListId)).ok, false);

    const goLive = addDays(TODAY, 7);
    await readyAndSend(changeId, [{ productId: nano20.id, minCans: null, inclPaise: 240_000 }], goLive);

    // The maker cannot approve.
    const self = await approveChange(changeId);
    assert.equal(self.ok, false);
    assert.match(self.ok ? "" : self.error, /somebody else/);

    setTestUser(approver);
    const approved = await approveChange(changeId, { note: "OK" });
    assert.ok(approved.ok, approved.ok ? "" : approved.error);
    assert.equal(approved.data.published, true);

    // Until the date the shop pays today's price; from it, the new one.
    assert.equal((await ratesForCustomer(shop.id, [nano20.id], TODAY))[nano20.id].rateInclGstPaise, 228_600);
    assert.equal((await ratesForCustomer(shop.id, [nano20.id], goLive))[nano20.id].rateInclGstPaise, 240_000);
    assert.equal((await listOf(v1)).effectiveTo, addDays(goLive, -1));
    const detail = await bookDetail(v1);
    assert.equal(detail?.book.state, "scheduled");
    assert.equal(detail?.revisions.find((r) => r.role === "scheduled")?.change?.approverName, "Vikram");

    // Moving the date moves the old revision's end with it.
    const moved = await moveGoLive(changeId, addDays(TODAY, 3));
    assert.ok(moved.ok, moved.ok ? "" : moved.error);
    assert.equal((await listOf(v1)).effectiveTo, addDays(TODAY, 2));
    assert.equal(await supersedeEndedPriceLists(addDays(TODAY, 3)), 1);
    assert.equal((await resolveForCustomer(shop.id, addDays(TODAY, 3)))?.listId, row.draftListId);
  });

  test("a scheduled change can be taken off before it starts; the current revision stays", async () => {
    const shop = await makeShop();
    const v1 = await liveBook();
    const { changeId } = ((await startChange(v1)) as { ok: true; data: { changeId: string } }).data;
    await readyAndSend(changeId, [{ productId: nano20.id, minCans: null, inclPaise: 235_000 }], addDays(TODAY, 5));
    setTestUser(approver);
    assert.ok((await approveChange(changeId)).ok);
    assert.ok((await cancelChange(changeId, "Wrong month")).ok);
    assert.equal((await listOf(v1)).effectiveTo, null, "the old revision is open-ended again");
    assert.equal((await resolveForCustomer(shop.id, addDays(TODAY, 10)))?.listId, v1);
  });

  test("an edit after the check makes it stale; sending back needs a reason", async () => {
    const v1 = await liveBook();
    const { changeId } = ((await startChange(v1)) as { ok: true; data: { changeId: string } }).data;
    await readyAndSend(changeId, [{ productId: nano20.id, minCans: null, inclPaise: 232_000 }], addDays(TODAY, 4));
    setTestUser(approver);
    assert.equal((await sendBackChange(changeId, " ")).ok, false);
    assert.ok((await sendBackChange(changeId, "Round 20 L to a hundred")).ok);
    setTestUser(maker);
    assert.ok((await setChangeCells(changeId, [{ productId: nano20.id, minCans: null, inclPaise: 232_100 }])).ok);
    const sent = await submitChange(changeId);
    assert.equal(sent.ok, false);
    assert.match(sent.ok ? "" : sent.error, /check/i);
    const view = await changeDetail(changeId);
    assert.equal(view?.stage, "sent_back", "it keeps saying it was sent back until it is sent again");
    assert.equal(view?.checkStale, false, "the edit cleared the check rather than leaving a stale one");
  });

  test("a deep cut needs two approvers, neither of them the maker", async () => {
    const v1 = await liveBook();
    const { changeId } = ((await startChange(v1)) as { ok: true; data: { changeId: string } }).data;
    await readyAndSend(changeId, [{ productId: nano5.id, minCans: null, inclPaise: 45_000 }], addDays(TODAY, 2));
    const [row] = await db.select().from(priceChanges).where(eq(priceChanges.id, changeId));
    assert.equal(row.needsSecond, true);
    setTestUser(approver);
    const first = await approveChange(changeId);
    assert.ok(first.ok && !first.data.published, "the first approval does not publish");
    assert.equal((await approveChange(changeId)).ok, false, "the same person twice is refused");
    setTestUser(third);
    const second = await approveChange(changeId);
    assert.ok(second.ok && second.data.published, second.ok ? "" : second.error);
  });

  test("maker-checker can be switched off for a desk of one", async () => {
    assert.ok((await updateSetting("pricing.changes.makerChecker", false, maker.id)).ok);
    invalidateConfig();
    const v1 = await liveBook();
    const { changeId } = ((await startChange(v1)) as { ok: true; data: { changeId: string } }).data;
    await readyAndSend(changeId, [{ productId: nano20.id, minCans: null, inclPaise: 230_000 }], addDays(TODAY, 1));
    const own = await approveChange(changeId);
    assert.ok(own.ok, own.ok ? "" : own.error);
  });

  test("taking a change over makes you its maker", async () => {
    const v1 = await liveBook();
    const { changeId } = ((await startChange(v1)) as { ok: true; data: { changeId: string } }).data;
    setTestUser(approver);
    assert.equal((await setChangeCells(changeId, [{ productId: nano20.id, minCans: null, inclPaise: 230_000 }])).ok, false);
    assert.ok((await takeOverChange(changeId)).ok);
    assert.ok((await setChangeCells(changeId, [{ productId: nano20.id, minCans: null, inclPaise: 230_000 }])).ok);
  });
});

describe("describe the change", () => {
  test("a plain sentence is read by code, previewed without writing, and applied by recomputing", async () => {
    const v1 = await liveBook();
    const { changeId } = ((await startChange(v1)) as { ok: true; data: { changeId: string } }).data;
    const preview = await previewInstruction(changeId, "everything up 5% round to the rupee");
    assert.ok(preview.ok, preview.ok ? "" : preview.error);
    assert.equal(preview.data.by, "MahekOne");
    assert.equal(preview.data.proposals.length, 2);
    const twenty = preview.data.proposals.find((p) => p.productId === nano20.id)!;
    assert.equal(twenty.afterInclPaise, Math.round((228_600 * 1.05) / 100) * 100);
    const before = await changeDetail(changeId);
    assert.equal(before?.counts.changed, 0, "a preview writes nothing");
    const applied = await applyInstructionRule(changeId, preview.data.rule, "everything up 5%");
    assert.ok(applied.ok, applied.ok ? "" : applied.error);
    const after = await changeDetail(changeId);
    assert.equal(after?.counts.up, 2);
    assert.equal(after?.draft.find((r) => r.productId === nano20.id)?.rateInclGstPaise, twenty.afterInclPaise);
  });
});

describe("the check", () => {
  test("a zero price blocks and cannot be acknowledged", async () => {
    const v1 = await liveBook();
    const { changeId } = ((await startChange(v1)) as { ok: true; data: { changeId: string } }).data;
    assert.ok((await setChangeCells(changeId, [{ productId: nano5.id, minCans: null, inclPaise: 0 }])).ok);
    const checked = await checkChange(changeId, { ai: false });
    assert.ok(checked.ok);
    const zero = checked.data.flags.find((f) => f.kind === "zero_or_negative")!;
    assert.ok(zero);
    assert.equal((await acknowledgeFlag(changeId, zero.key, "fine")).ok, false);
    await setChangeDetails(changeId, { reason: "x", goLive: addDays(TODAY, 2) });
    assert.equal((await submitChange(changeId)).ok, false);
  });
});
