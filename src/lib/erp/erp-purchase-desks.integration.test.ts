/**
 * LOT TESTING, BILLS AND DRUM LABELS as desks, against the database through
 * the real loaders and handlers:
 *
 *   - Lot testing's four sub-tabs, a line routed to testing listed as To test
 *     before any test row exists, To test / To verify read whole whatever the
 *     period, and the Waiting figure turning red past
 *     `erp.purchase.testWaitingHours`;
 *   - Bills grouped by party, its group action Record bill for n lots running
 *     the bulk Record the bill over that party's lots in the open sub-tab;
 *   - Drum labels' print log (`erp_label_prints`, 0373): every print recorded,
 *     reprints flagged, and To print / Printed read from it.
 *
 *   npm run test:integration
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appSettings, erpGodownStaff, erpInward, erpLabelPrints, erpPurchases, erpRawMaterials, erpSuppliers, erpTests, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { applyTicks } from "@/lib/erp/action-ticks";
import { pageOf, parseListQuery, subtabCounts } from "@/lib/erp/list-query";
import { testsAwaitingIds } from "@/lib/erp/counts";
import { invalidateConfig } from "@/lib/config/store";
import { approvedPo } from "@/lib/erp/po-fixture";
import { recordLabelPrints } from "@/lib/erp/screens/purchase";
import { erpRecordLabelPrints } from "@/lib/actions/erp-trace";
import type { ListRow, ListSpec } from "@/lib/erp/ui";
import type { LoadScope } from "@/lib/erp/window";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-11-20";
const NONE = "No Transport Charges";

async function makeUser(name: string, level: "associate" | "manager" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@desks.test`, phone: testPhone(), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
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

/** Goods received against a fresh approved PO from this supplier. */
async function receive(supplier: string, lines: (Record<string, string> & { item: string })[], rates: Record<string, number> = {}, godown = "Bhiwandi") {
  const items = [...new Set(lines.map((l) => l.item))];
  const po = await approvedPo(supplier, items.map((item) => ({ item, quantity: 100000, ratePaise: rates[item] })), { godown });
  const r = await mod("inward").forms!.new(await as(admin), { date: TODAY, godown, po: po.po, transportMode: NONE }, lines.map((l) => ({ ...l, poLine: po.lines[l.item] })));
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}

/** A window far in the past: nothing decided falls in it. */
const PAST: LoadScope = { pd: "custom", window: { from: "2020-01-01", to: "2020-01-02" }, ids: null, open: null };

async function setting(key: string, value: number) {
  await db
    .insert(appSettings)
    .values({ key, value, valueType: "integer", category: "erp", label: key })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  invalidateConfig();
}

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
  await db.execute(
    sql`truncate users, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_label_prints, erp_rm_entries, erp_requisitions, erp_purchase_orders, erp_po_lines, erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`,
  );
  await db.execute(sql`delete from app_settings where key in ('erp.purchase.testWaitingHours', 'erp.stockCheck.onRequirement')`);
  invalidateConfig();
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Deepa Clerk", "associate");
  await db.insert(erpGodownStaff).values({ godownId: "erpg_bhiwandi", userId: clerk.id });
  await db.insert(erpSuppliers).values([
    { id: "sup_a", name: "Asian Solvents", partyCode: "AS", gstin: "27ABCDE1234F1Z5" },
    { id: "sup_k", name: "Kaveri Packaging", partyCode: "KP" },
  ]);
  await db.insert(erpRawMaterials).values([
    { id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: ["Smell", "Density"], purchaseMethod: "quotation" },
    { id: "rm_xyl", serialNo: 2, name: "Xylene", code: "XYL", unit: "Litre", materialType: "Chemical", density: 0.86, testingList: ["Smell"], purchaseMethod: "quotation" },
    { id: "rm_mek", serialNo: 3, name: "MEK", code: "MEK", unit: "Litre", materialType: "Chemical", density: 0.8, testingList: [], purchaseMethod: "quotation" },
    { id: "rm_box", serialNo: 4, name: "Carton 12", code: "BOX12", unit: "Unit", materialType: "Box", testingList: [], purchaseMethod: "direct" },
  ]);
});

after(async () => {
  await db.execute(sql`delete from app_settings where key = 'erp.purchase.testWaitingHours'`);
  invalidateConfig();
  setTestUser(null);
  await db.$client.end();
});

const byBucket = (rows: ListRow[], b: string) => rows.filter((r) => r.v.bucket === b);
const tab = (spec: ListSpec, st: string, rows: ListRow[]) => pageOf(spec, rows, parseListQuery({ st, size: "100" }), {}).rows;

describe("lot testing", () => {
  let tolLine: string;
  let xylLine: string;

  test("a line routed to testing is To test before any test row exists, and Record test opens the form on it", async () => {
    await receive("Asian Solvents", [
      { type: "Chemical", item: "Toluene", drums: "2", qty: "360" },
      { type: "Chemical", item: "Xylene", drums: "1", qty: "180" },
    ]);
    const lines = await db.select().from(erpInward);
    tolLine = lines.find((l) => l.rawMaterialId === "rm_tol")!.id;
    xylLine = lines.find((l) => l.rawMaterialId === "rm_xyl")!.id;
    assert.equal((await db.select().from(erpTests)).length, 0, "nothing recorded yet");

    const ctx = await as(admin);
    const { spec, rows } = await mod("testing").load(ctx);
    assert.deepEqual(spec.subtabs?.map((t) => t.l), ["To test", "To verify", "Verified", "Failed"]);
    assert.equal(spec.subtabs?.[0].allTime, true, "To test is read whole");
    const toTest = byBucket(rows, "toTest");
    assert.deepEqual(toTest.map((r) => r.id).sort(), [tolLine, xylLine].sort(), "the inward lines are the rows");
    const tol = toTest.find((r) => r.id === tolLine)!;
    assert.equal(tol.v.lot, "ASTOL" + lines.find((l) => l.id === tolLine)!.prNumber, "the lot it will be");
    assert.match(String(tol.v.line), /^PR-\d+ · PO-\d+ · Asian Solvents$/);
    assert.equal(tol.v.tests, "Smell, Density");
    assert.equal(tol.v.stock, "Held until tested");
    assert.equal(tol.actions?.find((a) => a.primary)?.id, "record");
    assert.deepEqual(subtabCounts(spec, rows).find((c) => c.id === "toTest"), { id: "toTest", n: 2 });

    const form = await mod("testing").formLoaders!.record(ctx, tolLine);
    assert.equal(form?.id, "new", "the ordinary new-test form");
    assert.match(String(form?.init?.line), /Toluene$/, "already on that line");
    assert.equal(form?.init?.godown, "Bhiwandi");
    assert.ok((await testsAwaitingIds()).includes(tolLine), "the badge counts a lot nobody has tested yet");
  });

  test("recording moves it to To verify; verifying to Verified; not verified to Failed", async () => {
    const ctx = await as(admin);
    const f = await mod("testing").formLoaders!.record(ctx, tolLine);
    const saved = await mod("testing").forms!.new(ctx, { ...f!.init, smell: "Good", density: "0.87", tester: admin.id, date: TODAY }, []);
    assert.ok(saved.ok, JSON.stringify(saved));
    const f2 = await mod("testing").formLoaders!.record(ctx, xylLine);
    assert.ok((await mod("testing").forms!.new(ctx, { ...f2!.init, smell: "Off", tester: admin.id, date: TODAY }, [])).ok);

    let { spec, rows } = await mod("testing").load(ctx);
    assert.equal(byBucket(rows, "toTest").length, 0, "a recorded line leaves To test");
    const waiting = byBucket(rows, "toVerify");
    assert.equal(waiting.length, 2);
    const tolTest = waiting.find((r) => r.v.item === "Toluene")!;
    assert.equal(tolTest.actions?.find((a) => a.primary)?.id, "edit", "evidence still missing: Record evidence is the next step");
    await db.update(erpTests).set({ densityPhotoId: "att_fake" }).where(eq(erpTests.id, tolTest.id));
    ({ spec, rows } = await mod("testing").load(ctx));
    assert.equal(rows.find((r) => r.id === tolTest.id)!.actions?.find((a) => a.primary)?.id, "verify", "then Verify");

    assert.ok((await mod("testing").actions!.verify(ctx, tolTest.id, {})).ok);
    const xylTest = waiting.find((r) => r.v.item === "Xylene")!;
    assert.ok((await mod("testing").actions!.unverify(ctx, xylTest.id, {})).ok);
    ({ spec, rows } = await mod("testing").load(ctx));
    const counts = Object.fromEntries(subtabCounts(spec, rows).map((c) => [c.id, c.n]));
    assert.deepEqual(counts, { toTest: 0, toVerify: 0, verified: 1, failed: 1 });
    assert.equal(rows.find((r) => r.id === tolTest.id)!.v.waiting, null, "a decided lot is a record, not a wait");
    assert.deepEqual(tab(spec, "failed", rows).map((r) => r.id), [xylTest.id]);
  });

  test("To test and To verify ignore the period; Verified and Failed follow it", async () => {
    await receive("Asian Solvents", [{ type: "Chemical", item: "Toluene", drums: "1", qty: "180" }]);
    const ctx = await as(admin);
    const { rows } = await mod("testing").load(ctx, PAST);
    assert.equal(byBucket(rows, "toTest").length, 1, "the new lot is waiting, whatever the period");
    assert.equal(byBucket(rows, "verified").length + byBucket(rows, "failed").length, 0, "decided tests are cut by the period");
  });

  test("Waiting turns red past the configured hours, and the threshold is configuration", async () => {
    const ctx = await as(admin);
    const [line] = await db.select().from(erpInward).where(sql`not exists (select 1 from erp_tests t where t.inward_id = ${erpInward.id}) and ${erpInward.routed} = 'Testing'`);
    await db.update(erpInward).set({ createdAt: new Date(Date.now() - 50 * 3_600_000) }).where(eq(erpInward.id, line.id));
    let row = (await mod("testing").load(ctx)).rows.find((r) => r.id === line.id)!;
    assert.equal(row.v.waiting, "2 days");
    assert.equal(row.v.late, "late", "50 hours is past the default 24");
    const col = (await mod("testing").load(ctx)).spec.cols.find((c) => c.k === "waiting");
    assert.equal(col?.alert, "late", "the column draws it red");
    await setting("erp.purchase.testWaitingHours", 72);
    row = (await mod("testing").load(ctx)).rows.find((r) => r.id === line.id)!;
    assert.equal(row.v.late, null, "under 72 hours it is not late");
    await setting("erp.purchase.testWaitingHours", 24);
  });
});

describe("bills", () => {
  test("grouped by party, Record bill for n lots records one party's lots in the open sub-tab", async () => {
    await receive("Asian Solvents", [{ type: "Box", item: "Carton 12", qty: "100" }], { "Carton 12": 1000 });
    await receive("Asian Solvents", [{ type: "Box", item: "Carton 12", qty: "50" }], { "Carton 12": 1000 });
    await receive("Kaveri Packaging", [{ type: "Box", item: "Carton 12", qty: "20" }], { "Carton 12": 900 });
    const ctx = await as(admin);
    const { spec, rows } = await mod("register").load(ctx);
    assert.deepEqual(spec.subtabs?.map((t) => t.l), ["Bill to come", "Rate missing", "Rate differs", "Matched", "Every lot"]);
    assert.deepEqual(spec.groups, ["party"]);
    assert.deepEqual(spec.groupHead, ["gstin"]);
    assert.equal(spec.groupBulk?.id, "billReceived");
    const asian = rows.filter((r) => r.v.party === "Asian Solvents");
    assert.equal(asian[0].v.gstin, "27ABCDE1234F1Z5", "the party's GSTIN, for its heading");
    assert.match(String(asian[0].v.prPo), /^PR-\d+ · PO-\d+$/);
    assert.equal(asian[0].v.poRate, 1000);

    const page = pageOf(spec, rows, parseListQuery({ st: "billToCome", size: "100" }), {});
    const g = page.groups["Asian Solvents"];
    assert.ok(g, JSON.stringify(Object.keys(page.groups)));
    /* Two cartons and the Toluene the verifier passed above: every Asian Solvents lot with no bill, and none of Kaveri's. */
    const owed = rows.filter((r) => r.v.party === "Asian Solvents" && (r.v.stage === "Arrived" || r.v.stage === "Tested")).map((r) => r.id);
    assert.equal(owed.length, 3);
    assert.deepEqual([...g.bulkIds!].sort(), owed.sort());
    assert.equal(spec.groupBulk?.l, "Record bill for {n} {noun}");
    assert.deepEqual(spec.groupNoun, ["lot", "lots"]);

    /* The button runs the bulk act — the same handler the selection bar's Record the bill runs. */
    const done = await mod("register").bulk!.billReceived(ctx, g.bulkIds!, { billNo: "AS/26/118" });
    assert.ok(done.ok, JSON.stringify(done));
    const after = await db.select().from(erpPurchases).where(eq(erpPurchases.billNumber, "AS/26/118"));
    assert.equal(after.length, 3);
    assert.ok(after.every((p) => p.supplierId === "sup_a" && p.status === "Invoice Received"));
    const reread = await mod("register").load(ctx);
    const counts = Object.fromEntries(subtabCounts(reread.spec, reread.rows).map((c) => [c.id, c.n]));
    assert.equal(counts.matched, 3, "bill in hand and the rate agrees with the PO: Matched");
    const again = pageOf(reread.spec, reread.rows, parseListQuery({ st: "billToCome", size: "100" }), {});
    assert.equal(again.groups["Asian Solvents"], undefined, "nothing of theirs is waiting for a bill");
    assert.equal(again.groups["Kaveri Packaging"]?.bulkIds?.length, 1);
  });

  test("without purchase money there is no Bill to come, no Matched and no group action; without Edit no group action", async () => {
    const c = await as(clerk);
    const { spec } = await mod("register").load(c);
    assert.deepEqual(spec.subtabs?.map((t) => t.id), ["rateMissing", "rateOff", "all"]);
    assert.equal(spec.groupBulk, undefined);

    const ctx = await as(admin);
    const read = await mod("register").load(ctx);
    const noEdit = applyTicks({ administrator: false, ticks: new Map([["register", { edit: false, delete: false }]]) }, "register", read);
    const page = pageOf(noEdit.spec, noEdit.rows, parseListQuery({ st: "all", size: "100" }), {});
    assert.ok(Object.values(page.groups).every((g) => !g.bulkIds), "the bulk act is gone, so is its group button");
  });
});

describe("drum labels", () => {
  let lot: string;

  test("a chemical lot never printed is To print, at every godown the person works", async () => {
    await receive("Asian Solvents", [{ type: "Chemical", item: "MEK", drums: "3", qty: "540" }]);
    await receive("Asian Solvents", [{ type: "Chemical", item: "MEK", drums: "2", qty: "360" }], {}, "Ambernath");
    const [p] = await db.select().from(erpPurchases).where(sql`${erpPurchases.drums} = 3`);
    lot = p.id;
    const ctx = await as(admin);
    const { spec, rows } = await mod("barcode").load(ctx);
    assert.deepEqual(spec.subtabs?.map((t) => t.l), ["To print", "Printed"]);
    assert.equal(spec.bulk?.[0].href, "/erp/print-labels?purchases=", "Print n labels opens the label page over the ticked lots");
    assert.ok(rows.every((r) => r.v.printed === "no"));
    assert.deepEqual([...new Set(rows.map((r) => r.v.godown))].sort(), ["Ambernath", "Bhiwandi"], "an administrator works every godown");
    const row = rows.find((r) => r.id === lot)!;
    assert.equal(row.v.labels, 3, "one a drum");
    assert.equal(row.actions?.find((a) => a.primary)?.short, "Print 3");
    assert.ok(row.actions?.every((a) => a.id === "label" || a.id === "trace"), "print-only: no Edit or Delete acts");

    const c = await as(clerk);
    const mine = await mod("barcode").load(c);
    assert.deepEqual([...new Set(mine.rows.map((r) => r.v.godown))], ["Bhiwandi"], "a person sees the godowns they are assigned to");
  });

  test("every print is recorded, reprints flagged, and the lot moves to Printed", async () => {
    const ctx = await as(admin);
    const first = await recordLabelPrints(ctx, [{ id: lot, copies: 3 }, { id: "prb_nosuchlot", copies: 1 }]);
    assert.deepEqual(first, { ok: true, data: { recorded: 1, reprints: 0 } }, "a lot that is not a purchase is skipped");
    /* The label page's own server action, as the person signed in. */
    setTestUser(admin);
    const second = await erpRecordLabelPrints([{ id: lot, copies: 2 }]);
    assert.deepEqual(second, { ok: true, data: { recorded: 1, reprints: 1 } });
    const log = await db.select().from(erpLabelPrints).where(eq(erpLabelPrints.purchaseId, lot));
    assert.deepEqual(log.map((l) => [l.copies, l.reprint]).sort(), [[2, true], [3, false]]);
    assert.ok(log.every((l) => l.printedById === admin.id));

    const { spec, rows } = await mod("barcode").load(ctx);
    const row = rows.find((r) => r.id === lot)!;
    assert.equal(row.v.printed, "yes");
    assert.equal(row.v.prints, 2);
    assert.equal(row.v.printedBy, "Kavita Admin");
    assert.equal(row.v.printedLine, "Kavita Admin · 2 prints", "said under Last printed");
    assert.ok(row.v.lastPrinted);
    const counts = Object.fromEntries(subtabCounts(spec, rows).map((c) => [c.id, c.n]));
    assert.deepEqual(counts, { toPrint: rows.length - 1, printed: 1 });
  });

  test("a person who holds none of the label screens cannot record a print", async () => {
    const outsider = await makeUser("No Labels", "associate");
    /* A converted grant that holds only Requirements. */
    await db.update(appAccess).set({ position: "associate" }).where(eq(appAccess.userId, outsider.id));
    await db.execute(sql`insert into app_module_access (id, user_id, app, module) select ${id("mod")}, ${outsider.id}, app, 'erp.requisitions' from app_access where user_id = ${outsider.id}`);
    setTestUser(outsider);
    const r = await erpRecordLabelPrints([{ id: lot, copies: 1 }]);
    assert.equal(r.ok, false);
    assert.equal((await db.select().from(erpLabelPrints).where(eq(erpLabelPrints.purchaseId, lot))).length, 2);
  });
});
