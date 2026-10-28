/**
 * Empty drums, scrap sale and vendor-returnable drums — against a real
 * database through the real service and screen handlers. Each test is one of
 * the PRD's acceptance scenarios (§18), in its order.
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
import { appAccess, appSettings, erpEmptyDrums, erpInward, erpPurchases, erpRawMaterials, erpScrapBuyers, erpSuppliers, erpUserPowers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import {
  allocateReceipt,
  decideDrumAdjustment,
  drumHistory,
  findDrumLot,
  recordEmptyDrum,
  recordReceipt,
  requestDrumAdjustment,
  returnDrums,
  saleRows,
  sellScrap,
  voidAllocation,
  type Actor,
} from "@/lib/erp/drums";
import { DRUM_CATEGORY, RETURNABLE_NOT_FOR_SALE } from "@/lib/erp/engines/drums";
import { impactPart } from "@/lib/erp/ui";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD, type ImpactReport } from "@/lib/impact/types";

/** The report the impact modal shows to `u`, and the payload it sends back with the act — typed exactly as asked. */
async function confirmed(u: typeof users.$inferSelect, kind: string, recordId: string): Promise<{ report: ImpactReport; values: Record<string, string> }> {
  setTestUser(u);
  const r = await impactReport(kind, recordId);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { report: r.data, values: { [IMPACT_FIELD]: JSON.stringify({ typed: r.data.confirmWord, fingerprint: r.data.fingerprint }) } };
}
const ctxOf = async (u: typeof users.$inferSelect) => (setTestUser(u), erpContext());

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

const actor = (u: typeof users.$inferSelect): Actor => ({ id: u.id, name: u.name, app: "erp", level: "associate" });

async function setting(key: string, value: unknown, valueType: "boolean" | "integer" | "decimal" | "text") {
  await db.insert(appSettings).values({ key, value, valueType, category: "erp", label: key }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  invalidateConfig();
}

/** A GRN line and its register lot: `drums` drums declared at `tare` kg each. */
async function grn(lot: string, supplier: string, drums: number | null, tare: number | null, ownership: "mahek" | "returnable" | null) {
  const inward = id("pin");
  await db.insert(erpInward).values({ id: inward, prNumber: 100 + Math.floor(Math.random() * 1000), receivedDate: "2026-09-01", supplierId: supplier, godownId: BHW, materialType: "Chemical", rawMaterialId: "rm_tol", drums, weightWithDrum: 1000, emptyDrumWeight: tare, quantity: 900, unit: "Kg", testingRequired: false, drumOwnership: ownership });
  await db.insert(erpPurchases).values({ id: id("pur"), prNumber: 1, purchaseDate: "2026-09-01", supplierId: supplier, rawMaterialId: "rm_tol", lotNo: lot, quantity: 900, unit: "Kg", drums, godownId: BHW, inwardId: inward, source: "inward" });
}

/** Registers `n` emptied drums of a lot, a second apart so FIFO has an order to follow. */
async function empties(u: typeof users.$inferSelect, lot: string, n: number, kg = 8.2, godownId?: string) {
  for (let i = 0; i < n; i++) {
    const r = await recordEmptyDrum(actor(u), { code: lot, kg, source: "desk", confirmDifferent: true, godownId }, { mayApproveWeight: false });
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
}

let admin: typeof users.$inferSelect;
let staff: typeof users.$inferSelect;
let head: typeof users.$inferSelect;
let accountant: typeof users.$inferSelect;

before(async () => {
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_purchases, erp_user_powers, erp_empty_drums, erp_drum_events,
        erp_drum_adjustments, erp_drum_returns, erp_scrap_sales, erp_scrap_buyers, erp_scrap_entries, erp_cash_receipts, erp_scrap_allocations,
        audit_log restart identity cascade`,
  );
  await setting("erp.drums.minEmptyKg", 2, "decimal");
  await setting("erp.drums.maxEmptyKg", 40, "decimal");
  await setting("erp.drums.sameLotMinutes", 120, "integer");
  admin = await makeUser("Asha Admin", "admin");
  staff = await makeUser("Ravi Floor", "associate");
  head = await makeUser("Pooja Head", "manager");
  accountant = await makeUser("Deepa Books", "associate");
  await db.insert(erpUserPowers).values([
    { userId: head.id, power: "scrapSale", grantedById: admin.id },
    { userId: head.id, power: "scrapApprove", grantedById: admin.id },
    { userId: accountant.id, power: "scrapAccounts", grantedById: admin.id },
  ]);
  await db.insert(erpSuppliers).values([
    { id: "sup_own", name: "Own Drums Co", partyCode: "OD", drumOwnership: "mahek" },
    { id: "sup_ret", name: "Returnable Solvents", partyCode: "RS", drumOwnership: "returnable" },
    { id: "sup_unk", name: "Unknown Terms", partyCode: "UT" },
  ]);
  await db.insert(erpRawMaterials).values({ id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Kg", materialType: "Chemical", density: 0.87 });
  await db.insert(erpScrapBuyers).values({ id: "buyer_a", name: "Scrap Buyer A" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("the PRD's acceptance tests", () => {
  test("Test 1 — a Mahek-owned drum emptied: GRN details, variance, stock +1, who and when", async () => {
    await grn("OD-TOL-1", "sup_own", 4, 8, null);
    const lot = await findDrumLot("od-tol-1");
    assert.equal(lot?.supplier, "Own Drums Co");
    assert.equal(lot?.ownership, "mahek", "the supplier's master answers where the GRN line is silent");
    const r = await recordEmptyDrum(actor(staff), { code: "OD-TOL-1", kg: 10, source: "scan", clientKey: "DRM-test-1" }, { mayApproveWeight: false });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.data.status, "available");
    assert.equal(r.data.seq, 1);
    assert.equal(r.data.material, "Toluene");
    assert.equal(r.data.varianceKg, 2, "Test 8 — declared 8 kg, actual 10 kg is +2 kg");
    const [row] = await db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.id, r.data.id));
    assert.equal(row.recordedById, staff.id);
    assert.equal(row.declaredTareKg, 8, "the GRN's own figure is copied, never moved");
    const [inw] = await db.select({ w: erpInward.emptyDrumWeight }).from(erpInward).where(eq(erpInward.id, row.inwardId!));
    assert.equal(inw.w, 8);
    /* A resend of the same phone save is answered from the first. */
    const again = await recordEmptyDrum(actor(staff), { code: "OD-TOL-1", kg: 10, source: "scan", clientKey: "DRM-test-1" }, { mayApproveWeight: false });
    assert.ok(again.ok && again.data.replay && again.data.id === r.data.id);
  });

  test("Test 2 — the same drum scanned again moments later is asked about, and a full lot is refused", async () => {
    const asked = await recordEmptyDrum(actor(staff), { code: "OD-TOL-1", kg: 9, source: "scan" }, { mayApproveWeight: false });
    assert.equal(asked.ok, false);
    assert.equal(asked.refusal?.kind, "confirm");
    assert.equal(asked.refusal?.existing?.length, 1, "the existing record is shown");
    await empties(staff, "OD-TOL-1", 3);
    const fifth = await recordEmptyDrum(actor(staff), { code: "OD-TOL-1", kg: 9, source: "scan", confirmDifferent: true }, { mayApproveWeight: false });
    assert.equal(fifth.ok, false);
    assert.equal(fifth.refusal?.kind, "lot");
    assert.equal(fifth.refusal?.existing?.length, 4);
    const n = await db.$count(erpEmptyDrums, sql`lot_no = 'OD-TOL-1'`);
    assert.equal(n, 4);
  });

  test("a missing or unbelievable weight is not saved; an unknown label is never recorded", async () => {
    await grn("OD-TOL-2", "sup_own", 60, 8, null);
    const none = await recordEmptyDrum(actor(staff), { code: "OD-TOL-2", kg: null, source: "desk" }, { mayApproveWeight: false });
    assert.equal(none.refusal?.kind, "weight");
    const heavy = await recordEmptyDrum(actor(staff), { code: "OD-TOL-2", kg: 95, source: "desk" }, { mayApproveWeight: false });
    assert.equal(heavy.refusal?.kind, "weight");
    const unknown = await recordEmptyDrum(actor(staff), { code: "NOPE-1", kg: 9, source: "desk" }, { mayApproveWeight: false });
    assert.equal(unknown.refusal?.kind, "notFound");
    /* Only an approver may accept an outside weight, and only with a reason. */
    const approved = await recordEmptyDrum(actor(head), { code: "OD-TOL-2", kg: 45, source: "desk", weightException: "Drum has a fixed steel base ring" }, { mayApproveWeight: true });
    assert.ok(approved.ok);
  });

  test("Test 3 and 4 — 53 eligible drums, sell 20: 33 left, the 20 oldest allocated with their GRN links", async () => {
    /* 53 at Ambernath, apart from the drums the tests above left at Bhiwandi. */
    const AMB = "erpg_ambernath";
    await empties(staff, "OD-TOL-2", 53, 8.2, AMB);
    const oldest = await db.select({ id: erpEmptyDrums.id }).from(erpEmptyDrums).where(sql`godown_id = ${AMB}`).orderBy(erpEmptyDrums.recordedAt, erpEmptyDrums.drumNo).limit(20);
    const sale = await sellScrap(actor(head), { date: "2026-10-10", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 20, unit: "Pcs", ratePaise: 50_000, refKind: "invoice", externalRef: "INV-9", dueDate: null, remark: null, godownId: AMB });
    assert.ok(sale.ok, sale.ok ? "" : sale.error);
    const left = await db.$count(erpEmptyDrums, sql`status = 'available' and godown_id = ${AMB}`);
    assert.equal(left, 33);
    const sold = await db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.scrapSaleId, sale.data.id));
    assert.deepEqual(sold.map((d) => d.id).sort(), oldest.map((d) => d.id).sort());
    assert.ok(sold.every((d) => d.purchaseId && d.lotNo === "OD-TOL-2" && d.supplierId === "sup_own"), "label lost or not, the GRN link is in the record");
    const hist = await drumHistory(sold[0].id);
    assert.match(hist.at(-1)!.text, /allocated oldest first/);
    /* Never more than the stock, and a drum is never sold twice. */
    const over = await sellScrap(actor(head), { date: "2026-10-10", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 34, unit: "Pcs", ratePaise: 50_000, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: AMB });
    assert.equal(over.ok, false);
    const twice = await sellScrap(actor(head), { date: "2026-10-10", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 1, unit: "Pcs", ratePaise: 50_000, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: null, drumIds: [sold[0].id] });
    assert.equal(twice.ok, false);
  });

  test("Test 5 — a vendor-returnable drum emptied: returnable stock up, Mahek stock unchanged", async () => {
    const before = await db.$count(erpEmptyDrums, sql`status = 'available'`);
    await grn("RS-TOL-1", "sup_ret", 30, 8, null);
    await empties(staff, "RS-TOL-1", 20);
    assert.equal(await db.$count(erpEmptyDrums, sql`status = 'available'`), before);
    assert.equal(await db.$count(erpEmptyDrums, sql`status = 'returnable' and supplier_id = 'sup_ret'`), 20);
  });

  test("Test 6 — 20 pending, return 10: 10 left, oldest first, history kept", async () => {
    const r = await returnDrums(actor(head), { supplierId: "sup_ret", date: "2026-10-11", quantity: 10, challanRef: "CH-1", remark: null });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(await db.$count(erpEmptyDrums, sql`status = 'returnable' and supplier_id = 'sup_ret'`), 10);
    assert.equal(await db.$count(erpEmptyDrums, sql`status = 'returned' and return_id = ${r.data.id}`), 10);
    const over = await returnDrums(actor(head), { supplierId: "sup_ret", date: "2026-10-11", quantity: 11, challanRef: null, remark: null });
    assert.equal(over.ok, false);
  });

  test("Test 7 — a vendor-returnable drum offered for sale is refused with the returnable warning", async () => {
    const [ret] = await db.select().from(erpEmptyDrums).where(sql`status = 'returnable'`).limit(1);
    const r = await sellScrap(actor(head), { date: "2026-10-11", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 1, unit: "Pcs", ratePaise: 1000, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: null, drumIds: [ret.id] });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, RETURNABLE_NOT_FOR_SALE);
    const viaScreen = await screenModule("drumReturnable")!.actions!.sellReturnable(await (setTestUser(head), erpContext()), ret.id, {});
    assert.equal(!viaScreen.ok && viaScreen.error, RETURNABLE_NOT_FOR_SALE);
  });

  test("Tests 9 and 10 — ₹10,000 sale, ₹6,000 matched leaves ₹4,000; ₹4,000 more closes it", async () => {
    const sale = await sellScrap(actor(head), { date: "2026-10-01", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 20, unit: "Pcs", ratePaise: 50_000, refKind: "challan", externalRef: "CH-77", dueDate: "2026-10-05", remark: null, godownId: null });
    assert.ok(sale.ok, sale.ok ? "" : sale.error);
    const r1 = await recordReceipt(actor(accountant), { date: "2026-10-06", mode: "Bank transfer", amountPaise: 600_000, buyerId: "buyer_a", payer: null, reference: "UTR1", note: null, into: "Kotak Bank" });
    assert.ok(r1.ok);
    const m1 = await allocateReceipt(actor(accountant), r1.data.id, sale.data.id, 600_000);
    assert.ok(m1.ok, m1.ok ? "" : m1.error);
    let row = (await saleRows()).find((s) => s.id === sale.data.id)!;
    assert.equal(row.outstandingPaise, 400_000);
    /* Never more than the sale owes. */
    const r2 = await recordReceipt(actor(accountant), { date: "2026-10-09", mode: "UPI", amountPaise: 500_000, buyerId: "buyer_a", payer: null, reference: null, note: null, into: "Kotak Bank" });
    assert.ok(r2.ok);
    const tooMuch = await allocateReceipt(actor(accountant), r2.data.id, sale.data.id, 500_000);
    assert.equal(tooMuch.ok, false);
    const m2 = await allocateReceipt(actor(accountant), r2.data.id, sale.data.id, 400_000);
    assert.ok(m2.ok);
    row = (await saleRows()).find((s) => s.id === sale.data.id)!;
    assert.equal(row.outstandingPaise, 0);
    /* And never more than the receipt has left. */
    const sale2 = await sellScrap(actor(head), { date: "2026-10-09", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 2, unit: "Pcs", ratePaise: 100_000, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: null });
    assert.ok(sale2.ok);
    const overReceipt = await allocateReceipt(actor(accountant), r2.data.id, sale2.data.id, 150_000);
    assert.equal(overReceipt.ok, false);
    /* Undoing a match puts the money back on the sale, and keeps the match. */
    const [a] = (await db.execute(sql`select id from erp_scrap_allocations where receipt_id = ${r2.data.id}`)) as unknown as { id: string }[];
    assert.ok((await voidAllocation(actor(accountant), a.id, "Matched to the wrong sale by mistake")).ok);
    row = (await saleRows()).find((s) => s.id === sale.data.id)!;
    assert.equal(row.outstandingPaise, 400_000);
  });

  test("Test 11 — a sale with no external invoice carries no invoice number, and is traced by its own", async () => {
    const r = await sellScrap(actor(head), { date: "2026-10-11", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 1, unit: "Pcs", ratePaise: 40_000, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: null });
    assert.ok(r.ok);
    const row = (await saleRows()).find((s) => s.id === r.data.id)!;
    assert.equal(row.externalRef, null);
    assert.ok(row.saleNo > 0);
    const fake = await sellScrap(actor(head), { date: "2026-10-11", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 1, unit: "Pcs", ratePaise: 40_000, refKind: "none", externalRef: "MADE-UP", dueDate: null, remark: null, godownId: null });
    assert.equal(fake.ok, false);
  });
});

describe("ownership, review and corrections", () => {
  test("an unknown owner is never guessed: the drum waits for review", async () => {
    await grn("UT-TOL-1", "sup_unk", 2, 8, null);
    const r = await recordEmptyDrum(actor(staff), { code: "UT-TOL-1", kg: 8, source: "desk" }, { mayApproveWeight: false });
    assert.ok(r.ok);
    assert.equal(r.data.status, "review");
    assert.equal(r.data.ownership, null);
    setTestUser(head);
    const ctx = await erpContext();
    const done = await screenModule("drumReview")!.actions!.classify(ctx, r.data.id, { ownership: "Vendor returnable", note: "Purchase terms say drums go back" });
    assert.ok(done.ok, done.ok ? "" : done.error);
    const [d] = await db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.id, r.data.id));
    assert.equal(d.status, "returnable");
  });

  test("the GRN line wins over the supplier's master", async () => {
    await grn("OD-TOL-9", "sup_own", 1, 8, "returnable");
    const r = await recordEmptyDrum(actor(staff), { code: "OD-TOL-9", kg: 8, source: "desk" }, { mayApproveWeight: false });
    assert.ok(r.ok && r.data.status === "returnable");
  });

  test("a change of owner is approved by somebody else, never by whoever asked", async () => {
    const [d] = await db.select().from(erpEmptyDrums).where(sql`status = 'available'`).limit(1);
    assert.ok((await requestDrumAdjustment(actor(head), { kind: "ownership", drumId: d.id, newOwnership: "returnable", reason: "Supplier confirmed these are theirs" })).ok);
    const [adj] = (await db.execute(sql`select id from erp_drum_adjustments where drum_id = ${d.id} and status = 'pending'`)) as unknown as { id: string }[];
    const self = await decideDrumAdjustment(actor(head), adj.id, true, "", { administrator: false });
    assert.equal(self.ok, false);
    const ok = await decideDrumAdjustment(actor(admin), adj.id, true, "Checked the PO", { administrator: true });
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    const [after] = await db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.id, d.id));
    assert.equal(after.status, "returnable");
    assert.equal(after.ownership, "returnable");
  });

  test("opening stock adds drums only once approved", async () => {
    const before = await db.$count(erpEmptyDrums, sql`status = 'available'`);
    assert.ok((await requestDrumAdjustment(actor(head), { kind: "opening", ownership: "mahek", supplierId: null, godownId: BHW, quantity: 5, reason: "Drums already in the yard before go-live" })).ok);
    assert.equal(await db.$count(erpEmptyDrums, sql`status = 'available'`), before);
    const [adj] = (await db.execute(sql`select id from erp_drum_adjustments where kind = 'opening' and status = 'pending'`)) as unknown as { id: string }[];
    assert.ok((await decideDrumAdjustment(actor(admin), adj.id, true, "", { administrator: true })).ok);
    assert.equal(await db.$count(erpEmptyDrums, sql`status = 'available'`), before + 5);
  });

  test("a drum's history cannot be rewritten", async () => {
    await assert.rejects(db.execute(sql`delete from erp_drum_events`), (e: unknown) => /append-only/.test(String((e as { cause?: unknown }).cause ?? e)));
  });

  test("every scrap screen loads for an administrator", async () => {
    setTestUser(admin);
    const ctx = await erpContext();
    for (const k of ["emptyDrums", "drumReturnable", "drumReview", "drumVariance", "drumAdjustments", "drumRegister", "drumReturns", "drumPending", "scrapSales", "scrapReceivables", "scrapStock", "scrapEntries", "scrapBuyers", "cashReceipts"]) {
      const l = await screenModule(k)!.load(ctx);
      assert.equal(l.spec.screen, k);
    }
    const recv = await screenModule("scrapReceivables")!.load(ctx);
    assert.ok(recv.rows.length >= 1, "an unpaid sale is a receivable");
  });

  test("non-drum scrap is sold only from what was recorded", async () => {
    setTestUser(head);
    const ctx = await erpContext();
    assert.ok((await screenModule("scrapStock")!.forms!.new(ctx, { date: "2026-10-11", category: "Plastic Scrap", godown: "Bhiwandi", quantity: "120", unit: "Kg" }, [])).ok);
    const over = await sellScrap(actor(head), { date: "2026-10-11", buyerId: "buyer_a", category: "Plastic Scrap", quantity: 150, unit: "Kg", ratePaise: 1500, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: null });
    assert.equal(over.ok, false);
    const ok = await sellScrap(actor(head), { date: "2026-10-11", buyerId: "buyer_a", category: "Plastic Scrap", quantity: 100, unit: "Kg", ratePaise: 1500, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: null });
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
  });
});

describe("a cancel or a void says what moves before it is confirmed", () => {
  const why = { reason: "Recorded against the wrong lot by mistake" };

  test("a drum's entry: it leaves the stock it was counted in, and the bare act is refused", async () => {
    await grn("OD-VOID-1", "sup_own", 4, 8, null);
    await empties(staff, "OD-VOID-1", 3);
    const [d] = await db.select().from(erpEmptyDrums).where(sql`status = 'available' and lot_no = 'OD-VOID-1'`).limit(1);
    const bare = await screenModule("emptyDrums")!.actions!.cancel(await ctxOf(head), d.id, why);
    assert.ok(!bare.ok && /Check what this affects/.test(bare.error));
    const { report, values } = await confirmed(head, "erp-drum-entry", d.id);
    assert.equal(report.confirmWord, `DRM-${d.drumNo}`);
    assert.ok(report.items.some((i) => i.effect === "changed" && /comes out of Mahek's empty drums in stock/.test(i.label)), JSON.stringify(report.items));
    const r = await screenModule("emptyDrums")!.actions!.cancel(await ctxOf(head), d.id, { ...why, ...values });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal((await db.select().from(erpEmptyDrums).where(eq(erpEmptyDrums.id, d.id)))[0].status, "cancelled");
  });

  test("a scrap sale: its drums go back; one with money matched to it is refused in the modal", async () => {
    const sale = await sellScrap(actor(head), { date: "2026-10-12", buyerId: "buyer_a", category: DRUM_CATEGORY, quantity: 2, unit: "Pcs", ratePaise: 30_000, refKind: "none", externalRef: null, dueDate: null, remark: null, godownId: null });
    assert.ok(sale.ok, sale.ok ? "" : sale.error);
    const { report, values } = await confirmed(head, "erp-scrap-sale", sale.data.id);
    assert.equal(report.items.find((i) => /sold drums go back/.test(i.label))?.count, 2);
    assert.ok(report.items.some((i) => /scrap receivable closed/.test(i.label)));
    const r = await screenModule("scrapSales")!.actions!.cancel(await ctxOf(head), sale.data.id, { ...why, ...values });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(await db.$count(erpEmptyDrums, sql`scrap_sale_id = ${sale.data.id}`), 0, "the drums are back in stock");
    const [paid] = (await db.execute(sql`select id from erp_scrap_sales where external_ref = 'CH-77'`)) as unknown as { id: string }[];
    const matched = await confirmed(head, "erp-scrap-sale", paid.id);
    assert.deepEqual(matched.report.blockers, ["Money is matched to this sale. The accountant undoes the match first."]);
  });

  test("a receipt: the same money in Petty Cash is cancelled with it", async () => {
    const rc = await recordReceipt(actor(accountant), { date: "2026-10-12", mode: "Bank transfer", amountPaise: 70_000, buyerId: "buyer_a", payer: null, reference: "UTR-VOID", note: null, into: "Kotak Bank" });
    assert.ok(rc.ok, rc.ok ? "" : rc.error);
    const bare = await screenModule("cashReceipts")!.actions!.void(await ctxOf(accountant), rc.data.id, why);
    assert.ok(!bare.ok && /Check what this affects/.test(bare.error));
    const { report, values } = await confirmed(accountant, "erp-scrap-receipt", rc.data.id);
    assert.ok(report.items.some((i) => /receipt in Petty Cash cancelled — Kotak Bank's balance drops/.test(i.label)), JSON.stringify(report.items));
    const r = await screenModule("cashReceipts")!.actions!.void(await ctxOf(accountant), rc.data.id, { ...why, ...values });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [m] = (await db.execute(sql`select status from erp_money_txns where scrap_receipt_id = ${rc.data.id}`)) as unknown as { status: string }[];
    assert.equal(m.status, "cancelled");
  });

  test("undoing one match: the modal is about the match the prompt picked", async () => {
    const [r1] = (await db.execute(sql`select id from erp_cash_receipts where reference = 'UTR1'`)) as unknown as { id: string }[];
    const row = (await screenModule("cashReceipts")!.load(await ctxOf(accountant))).rows.find((r) => r.id === r1.id)!;
    const spec = row.actions!.find((a) => a.id === "unmatch")!;
    assert.equal(spec.impact?.withValue, "alloc");
    const line = spec.prompt!.fields[0].opts![0];
    const values = { alloc: line, reason: "Matched to the wrong sale by mistake" };
    const bare = await screenModule("cashReceipts")!.actions!.unmatch(await ctxOf(accountant), r1.id, values);
    assert.ok(!bare.ok && /Check what this affects/.test(bare.error));
    const undo = await confirmed(accountant, "erp-scrap-match", impactPart(r1.id, line));
    assert.ok(undo.report.items.some((i) => /is owed ₹6,000 again/.test(i.label)), JSON.stringify(undo.report.items));
    const r = await screenModule("cashReceipts")!.actions!.unmatch(await ctxOf(accountant), r1.id, { ...values, ...undo.values });
    assert.ok(r.ok, r.ok ? "" : r.error);
  });

  test("a buyer retired keeps what they owe, and the modal says so", async () => {
    const { report, values } = await confirmed(head, "erp-scrap-buyer", "buyer_a");
    assert.equal(report.confirmWord, "Scrap Buyer A");
    assert.ok(report.items.some((i) => i.effect === "kept" && /open receivable/.test(i.label)), JSON.stringify(report.items));
    const r = await screenModule("scrapBuyers")!.actions!.retire(await ctxOf(head), "buyer_a", values);
    assert.ok(r.ok, r.ok ? "" : r.error);
    await db.update(erpScrapBuyers).set({ active: true }).where(eq(erpScrapBuyers.id, "buyer_a"));
  });
});
