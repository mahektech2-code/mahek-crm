/**
 * Scrap & empty drums — against a real database through the real handlers:
 * the acceptance tests of the Empty Drum and Scrap Management PRD (§18).
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, erpEmptyDrums, erpInward, erpPurchases, erpRawMaterials, erpScrapReceipts, erpScrapSales, erpSuppliers, erpUserPowers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { lookupDrumLot, recordEmptyDrum, scrapSummary } from "@/lib/erp/scrap";
import { CATEGORY_LABEL, OWNERSHIP_LABEL } from "@/lib/erp/engines/scrap";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const BHW = "erpg_bhiwandi";

async function makeUser(name: string, level: "associate" | "manager" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@scrap.test`, phone: String(9822000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: level });
  return u;
}

async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return erpContext();
}

const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};

let pr = 9000;
/** A GRN lot of `drums` drums, each declared at `tare` kg, owned as given (null: the GRN does not say). */
async function lot(code: string, drums: number, tare: number | null, ownership: "mahek" | "vendor" | null, supplier = "sup_a") {
  pr++;
  const inward = id("inw");
  await db.insert(erpInward).values({ id: inward, prNumber: pr, receivedDate: "2026-09-01", supplierId: supplier, godownId: BHW, materialType: "Chemical", rawMaterialId: "rm_tol", drums, emptyDrumWeight: tare, quantity: drums * 200, unit: "Kg", testingRequired: false });
  await db.insert(erpPurchases).values({ id: id("pur"), prNumber: pr, purchaseDate: "2026-09-01", supplierId: supplier, rawMaterialId: "rm_tol", lotNo: code, quantity: drums * 200, unit: "Kg", drums, godownId: BHW, source: "inward", inwardId: inward, drumOwnership: ownership });
}

const drumsOf = async (code: string) => db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.lotNo, code)).orderBy(erpEmptyDrums.seq);

let admin: typeof users.$inferSelect;
let staff: typeof users.$inferSelect;
let head: typeof users.$inferSelect;
let accountant: typeof users.$inferSelect;

before(async () => {
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_purchases, erp_user_powers, erp_empty_drums, erp_scrap_sales,
        erp_scrap_buyers, erp_drum_returns, erp_scrap_receipts, erp_scrap_allocations, erp_scrap_collections, audit_log restart identity cascade`,
  );
  await db.execute(sql`update erp_series set last = 0 where key in ('emptyDrum', 'scrapSale', 'drumReturn', 'scrapReceipt')`);
  admin = await makeUser("Asha Admin", "admin");
  staff = await makeUser("Ravi Scale", "associate");
  head = await makeUser("Meera Head", "manager");
  accountant = await makeUser("Kiran Accounts", "associate");
  for (const power of ["scrapSell", "scrapControl"] as const) await db.insert(erpUserPowers).values({ userId: head.id, power, grantedById: admin.id });
  await db.insert(erpUserPowers).values({ userId: accountant.id, power: "scrapReceipts", grantedById: admin.id });
  await db.insert(erpSuppliers).values([
    { id: "sup_a", name: "Asian Solvents", partyCode: "AS" },
    { id: "sup_v", name: "Vendor Drums Ltd", partyCode: "VD" },
  ]);
  await db.insert(erpRawMaterials).values({ id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Kg", materialType: "Chemical" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("weighing an empty drum", () => {
  test("Test 1 & 8: a Mahek-owned drum lands in Mahek stock with its variance", async () => {
    await lot("ASTOL1", 3, 8, "mahek");
    const look = await lookupDrumLot("astol1");
    assert.ok(look.ok);
    assert.equal(look.data.supplier, "Asian Solvents");
    assert.deepEqual(look.data.next, { seq: 1 });
    const r = await recordEmptyDrum(await as(staff), { code: "ASTOL1", weightKg: 10 });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.data.status, "available");
    assert.equal(r.data.varianceKg, 2);
    const [d] = await drumsOf("ASTOL1");
    assert.equal(d.emptiedById, staff.id);
    assert.equal(d.declaredTareKg, 8);
    assert.equal((await scrapSummary()).mahekAvailable, 1);
  });

  test("Test 2: the same drum scanned again adds nothing", async () => {
    const r = await recordEmptyDrum(await as(staff), { code: "ASTOL1/1", weightKg: 10 });
    assert.ok(!r.ok);
    assert.match(r.error, /already recorded/);
    const look = await lookupDrumLot("ASTOL1/1");
    assert.ok(look.ok && "refusal" in look.data.next && look.data.next.existing === 1);
    assert.equal((await drumsOf("ASTOL1")).length, 1);
  });

  test("a lot can never have more empty drums than it came in", async () => {
    assert.ok((await recordEmptyDrum(await as(staff), { code: "ASTOL1", weightKg: 9 })).ok);
    assert.ok((await recordEmptyDrum(await as(staff), { code: "ASTOL1", weightKg: 9 })).ok);
    const r = await recordEmptyDrum(await as(staff), { code: "ASTOL1", weightKg: 9 });
    assert.ok(!r.ok);
    assert.match(r.error, /All 3 drums/);
  });

  test("an unknown label creates nothing", async () => {
    const r = await recordEmptyDrum(await as(staff), { code: "NOPE99", weightKg: 9 });
    assert.ok(!r.ok);
    assert.match(r.error, /Production Head/);
  });

  test("a weight outside the limits needs the Production Head and a reason", async () => {
    await lot("ASTOL2", 2, 8, "mahek");
    const r = await recordEmptyDrum(await as(staff), { code: "ASTOL2", weightKg: 90 });
    assert.ok(!r.ok);
    assert.ok(!(await recordEmptyDrum(await as(head), { code: "ASTOL2", weightKg: 90 })).ok);
    const ok = await recordEmptyDrum(await as(head), { code: "ASTOL2", weightKg: 90, exceptionNote: "Heavy residue drum, checked twice" });
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    assert.equal((await drumsOf("ASTOL2"))[0].weightNote, "Heavy residue drum, checked twice");
  });

  test("an unrecorded owner waits for the Production Head, whose answer routes the whole lot", async () => {
    await lot("ASTOL3", 2, 8, null);
    const r = await recordEmptyDrum(await as(staff), { code: "ASTOL3", weightKg: 9 });
    assert.ok(r.ok);
    assert.equal(r.data.status, "review");
    const [d] = await drumsOf("ASTOL3");
    assert.ok(!(await mod("emptyDrums").actions!.ownership(await as(staff), d.id, { ownership: OWNERSHIP_LABEL.mahek })).ok);
    const dec = await mod("emptyDrums").actions!.ownership(await as(head), d.id, { ownership: OWNERSHIP_LABEL.mahek });
    assert.ok(dec.ok, dec.ok ? "" : dec.error);
    assert.equal((await drumsOf("ASTOL3"))[0].status, "available");
    const next = await recordEmptyDrum(await as(staff), { code: "ASTOL3", weightKg: 9 });
    assert.ok(next.ok && next.data.status === "available");
  });
});

describe("vendor-returnable drums", () => {
  test("Tests 5 & 6: they never touch Mahek stock, and return oldest first", async () => {
    const before = (await scrapSummary()).mahekAvailable;
    await lot("VDTOL1", 3, 10, "vendor", "sup_v");
    for (let i = 0; i < 3; i++) assert.ok((await recordEmptyDrum(await as(staff), { code: "VDTOL1", weightKg: 10 })).ok);
    const sum = await scrapSummary();
    assert.equal(sum.mahekAvailable, before);
    assert.equal(sum.vendorPending, 3);
    assert.ok(!(await mod("returnableDrums").actions!.return(await as(staff), "sup_v", { quantity: "2" })).ok);
    assert.ok(!(await mod("returnableDrums").actions!.return(await as(head), "sup_v", { quantity: "4" })).ok);
    const r = await mod("returnableDrums").actions!.return(await as(head), "sup_v", { quantity: "2", challan: "CH-7" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const drums = await drumsOf("VDTOL1");
    assert.deepEqual(
      drums.map((d) => d.status),
      ["returned", "returned", "returnable"],
    );
    assert.equal((await scrapSummary()).vendorPending, 1);
  });
});

describe("selling scrap and being paid", () => {
  const sell = async (u: typeof users.$inferSelect, extra: Record<string, string>) =>
    mod("scrapSales").forms!.new(await as(u), { date: "2026-10-01", buyer: "Shree Scrap Co", category: CATEGORY_LABEL.drum, unit: "Drums", rate: "500", invoice: "No external invoice", ...extra }, []);

  test("Tests 4 & 7: a sale takes the oldest Mahek drums and cannot take a vendor's", async () => {
    const avail = (await scrapSummary()).mahekAvailable;
    assert.ok(!(await sell(staff, { quantity: "2" })).ok, "selling needs the power");
    const over = await sell(head, { quantity: String(avail + 1) });
    assert.ok(!over.ok);
    assert.match(over.error, /vendor-returnable/);
    const r = await sell(head, { quantity: "2" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const sold = (await db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.status, "sold"))).map((d) => d.drumNo).sort((a, b) => a - b);
    assert.deepEqual(sold, [1, 2], "the two drums emptied first");
    assert.equal((await scrapSummary()).mahekAvailable, avail - 2);
  });

  test("Test 11: no invoice, no invoice number; an invoiced sale must name its invoice", async () => {
    const [s] = await db.select().from(erpScrapSales).where(eq(erpScrapSales.saleNo, 1));
    assert.equal(s.invoiceKind, "none");
    assert.equal(s.externalRef, null);
    assert.equal(s.amountPaise, 100000);
    const bad = await sell(head, { quantity: "1", invoice: "External invoice issued" });
    assert.ok(!bad.ok);
  });

  test("Tests 9 & 10: partial then final payment through matched receipts", async () => {
    await sell(head, { quantity: "4", rate: "2500" }); // SS-2: ₹10,000
    const receipt = async (u: typeof users.$inferSelect, amount: string) =>
      mod("scrapReceipts").forms!.new(await as(u), { date: "2026-10-05", buyer: "Shree Scrap Co", mode: "Bank", amount, apply: "Leave unmatched for now" }, []);
    assert.ok(!(await receipt(head, "6000")).ok, "only the accountant records receipts");
    assert.ok((await receipt(accountant, "6000")).ok);
    const [r1] = await db.select().from(erpScrapReceipts).orderBy(sql`receipt_no desc`).limit(1);
    const ctx = await as(accountant);
    assert.ok(!(await mod("scrapReceipts").actions!.allocate(ctx, r1.id, { sale: "SS-2", amount: "7000" })).ok, "more than the receipt");
    assert.ok((await mod("scrapReceipts").actions!.allocate(ctx, r1.id, { sale: "SS-2", amount: "6000" })).ok);
    let owed = (await mod("scrapSales").load(ctx)).rows.find((x) => x.id === "sale:2")!;
    assert.equal(owed.v.owed, 400000);
    assert.equal(owed.v.status, "Partially paid");
    assert.ok((await receipt(accountant, "4000")).ok);
    const [r2] = await db.select().from(erpScrapReceipts).orderBy(sql`receipt_no desc`).limit(1);
    assert.ok(!(await mod("scrapReceipts").actions!.allocate(ctx, r2.id, { sale: "SS-2", amount: "4000.01" })).ok, "more than the sale owes");
    assert.ok((await mod("scrapReceipts").actions!.allocate(ctx, r2.id, { sale: "SS-2", amount: "4000" })).ok);
    owed = (await mod("scrapSales").load(ctx)).rows.find((x) => x.id === "sale:2")!;
    assert.equal(owed.v.owed, 0);
    assert.equal(owed.v.status, "Paid");
  });

  test("a paid sale cannot be cancelled; an unpaid one gives its drums back", async () => {
    const ctx = await as(head);
    assert.ok(!(await mod("scrapSales").actions!.cancel(ctx, "sale:2", { reason: "Mistake" })).ok);
    const before = (await scrapSummary()).mahekAvailable;
    const r = await mod("scrapSales").actions!.cancel(ctx, "sale:1", { reason: "Buyer backed out" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal((await scrapSummary()).mahekAvailable, before + 2);
  });

  test("other scrap sells only what was collected", async () => {
    const ctx = await as(head);
    const plastic = { category: CATEGORY_LABEL.plastic, unit: "Kg" };
    assert.ok(!(await sell(head, { ...plastic, quantity: "10" })).ok);
    assert.ok((await mod("otherScrap").forms!.collect(ctx, { date: "2026-10-01", ...plastic, quantity: "25" }, [])).ok);
    assert.ok(!(await sell(head, { ...plastic, quantity: "30" })).ok);
    assert.ok((await sell(head, { ...plastic, quantity: "20" })).ok);
  });
});
