/**
 * Production & dispatch traceability, end to end, against a real database
 * through the real handlers:
 *
 *   SFG lot → QC → refill (FG lot) → packing batch → box ids → order
 *     → scan at the dispatch desk (match, duplicate, lot swap, pack-size
 *       mismatch, override) → Do Verified → dispatched → trace both ways
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { attachInvoicePdf } from "@/lib/erp/invoice-fixture";
import { db } from "@/db";
import { allPassValues } from "@/lib/erp/engines/sfg-tests";
import { refValues } from "@/lib/erp/refs";
import { appAccess, customers, erpProductPacking, erpRawMaterials, erpSfgEntries, erpSfgLines, finishedGoods, productBrands, productFormulations, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { calendarDate } from "@/lib/business-date";
import { erpContext } from "@/lib/erp/access";
import { screenModule } from "@/lib/erp/screens";
import { decideOverride, dispatchBoard, dispatchQueue, pickableBoxes, requestOverride, scanOntoOrder, unscanUnit } from "@/lib/erp/dispatch";
import { traceCode, traceDashboard } from "@/lib/erp/traceability";
import { boxLabels, unlabelledStock } from "@/lib/erp/label-data";
import { erpGiveIds } from "@/lib/actions/erp-trace";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD } from "@/lib/impact/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
/* The dashboard counts the real today, so the documents are dated it too. */
const TODAY = calendarDate(new Date());
const tag = randomUUID().slice(0, 6);
const SFG = `ERPX Nano ${tag}`;
const FG1 = `ERPX Nano 1 L ${tag}`;
const FG5 = `ERPX Nano 500 ml ${tag}`;
const BOX1 = `ERPX Nano ${tag} - 1 Liter (4 Can/Box)`;
const LOOSE1 = `ERPX Nano ${tag} - 1 Liter (Loose)`;
const BOX5 = `ERPX Nano ${tag} - 500 ml (4 Can/Box)`;

async function makeUser(name: string, level: "associate" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\s/g, ".")}@erp.test`, phone: String(9820000000 + Math.floor(Math.random() * 999999)), passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase() })
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
const msg = (r: { ok: boolean; fieldErrors?: { message: string }[]; error?: string; message?: string }) => (r.ok ? (r.message ?? "ok") : (r.fieldErrors?.[0]?.message ?? r.error ?? "?"));
const unitsOf = async (lot: string) => (await db.execute(sql`select id, status, order_id as "order", godown_id as godown from erp_units where lot_code = ${lot} order by seq`)) as unknown as { id: string; status: string; order: string | null; godown: string }[];

let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;
let orderNo = 0;
let lineId = "";

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_orders, erp_batch_codes, erp_order_details, erp_fg_entries, erp_sfg_lines, erp_sfg_entries,
             erp_pack_entries, erp_pack_lines, erp_fg_fills, erp_transfers, erp_user_powers, erp_godown_staff, erp_user_settings, erp_transports,
             erp_units, erp_unit_events, erp_dispatch_scans, erp_dispatch_overrides, erp_sfg_qc, erp_raw_materials, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  admin = await makeUser("Kavita Admin", "admin");
  clerk = await makeUser("Gupta Dispatch", "associate");

  const fId = id("form");
  const bId = id("brand");
  const fg1 = id("fg");
  const fg5 = id("fg");
  await db.insert(productFormulations).values({ id: fId, name: SFG, slug: `erpx-${tag}` });
  await db.insert(productBrands).values({ id: bId, name: `ERPX Nano ${tag}`, slug: `erpx-b-${tag}`, formulationId: fId });
  await db.insert(finishedGoods).values([
    { id: fg1, name: FG1, slug: `erpx-fg1-${tag}`, brandId: bId, formulationId: fId, millilitres: 1000 },
    { id: fg5, name: FG5, slug: `erpx-fg5-${tag}`, brandId: bId, formulationId: fId, millilitres: 500 },
  ]);
  const box1 = id("sku");
  const loose1 = id("sku");
  const box5 = id("sku");
  await db.insert(products).values([
    { id: box1, name: BOX1, finishedGoodId: fg1, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 4 },
    { id: loose1, name: LOOSE1, finishedGoodId: fg1, brandId: bId, formulationId: fId, millilitresPerCan: 1000, cansPerBox: 1 },
    { id: box5, name: BOX5, finishedGoodId: fg5, brandId: bId, formulationId: fId, millilitresPerCan: 500, cansPerBox: 4 },
  ]);
  await db.insert(erpProductPacking).values([
    { productId: box1, emptyBoxesRequired: 1, boxType: "Carton 1L" },
    { productId: loose1, emptyBoxesRequired: 0 },
    { productId: box5, emptyBoxesRequired: 1, boxType: "Carton 500" },
  ]);
  await db.insert(customers).values({ id: "cus_abc", name: "ABC Paints", city: "Pune", phone: "9876500101", kind: "customer", area: "Pune" });

  /* An SFG lot of 100 L, made from a drum the test does not buy. The raw-material
     master is truncated above: an earlier file in the same database can leave a
     row with this serial number or code under another id, and `onConflictDoNothing`
     would then skip this insert and fail the foreign key a line later. Which file
     ran before this one depends on how the shards are balanced. */
  await db.insert(erpRawMaterials).values({ id: "rm_tol", serialNo: 1, name: "Toluene", code: "TOL", unit: "Litre", materialType: "Chemical", testingList: [] }).onConflictDoNothing();
  const lineIdSfg = id("sfg");
  await db.insert(erpSfgLines).values({ id: lineIdSfg, sfgNo: 1, batchDate: TODAY, godownId: "erpg_bhiwandi", formulationId: fId, batches: 1, rawMaterialId: "rm_tol", rmLotNo: "DRUM1", qtyPerBatch: 100, totalUse: 100, lotCode: "S1DRUM1" });
  await db.insert(erpSfgEntries).values({ id: id("sfe"), sourceType: "sfg", sourceId: lineIdSfg, entryDate: TODAY, formulationId: fId, lotCode: "S1DRUM1", godownId: "erpg_bhiwandi", quantity: 100 });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("production makes boxes with ids", () => {
  test("QC first, then refill, then a complete packing batch mints one id per box", async () => {
    const a = await as(admin);
    const [sfgLine] = await db.select().from(erpSfgLines);
    const fill = (fg: string, size: string, cans: string) => mod("fgFill").forms!.new(a, { date: TODAY, godown: "Bhiwandi", sfg: SFG, sfgLot: "S1DRUM1", fg, size, cans }, []);
    assert.match(msg(await fill(FG1, "1", "40")), /waiting for QC/);
    assert.ok((await mod("sfgBatches").actions!.qcApprove(a, sfgLine.id, allPassValues(await refValues("testingList")))).ok);
    assert.ok((await fill(FG1, "1", "40")).ok); // FG1BH
    assert.ok((await fill(FG1, "1", "8")).ok); // FG2BH
    assert.ok((await fill(FG5, "0.5", "8")).ok); // FG3BH

    const pack = (sku: string, fg: string, boxes: string, lot: string) => mod("packBatches").forms!.new(a, { date: TODAY, godown: "Bhiwandi", fg, sku, boxes, lot }, []);
    assert.ok((await pack(BOX1, FG1, "5", "FG1BH")).ok, "FP1BH: 5 boxes of 1 L");
    assert.ok((await pack(BOX1, FG1, "2", "FG2BH")).ok, "FP2BH: 2 boxes of 1 L");
    assert.ok((await pack(BOX5, FG5, "2", "FG3BH")).ok, "FP3BH: 2 boxes of 500 ml");
    assert.equal((await unitsOf("FP1BH")).length, 5);
    assert.equal((await unitsOf("FP3BH")).length, 2);
  });

  test("loose labels: no more than the lot's cans, and packing cancels the ones its cans can no longer be", async () => {
    const a = await as(admin);
    const fgId = ((await db.execute(sql`select finished_good_id as fg from erp_fg_fills where lot_code = 'FG1BH'`)) as unknown as { fg: string }[])[0].fg;
    const key = `${fgId}|FG1BH|erpg_bhiwandi`;
    assert.match(msg(await mod("fgStock").actions!.labelLoose(a, key, { count: "21" })), /Only 20 more/);
    assert.ok((await mod("fgStock").actions!.labelLoose(a, key, { count: "20" })).ok);
    assert.ok((await mod("packBatches").forms!.new(a, { date: TODAY, godown: "Bhiwandi", fg: FG1, sku: BOX1, boxes: "2", lot: "FG1BH" }, [])).ok, "FP4BH takes 8 cans");
    const loose = await unitsOf("FG1BH");
    assert.equal(loose.filter((u) => u.status === "available").length, 12);
    assert.equal(loose.filter((u) => u.status === "cancelled").length, 8, "the labels its cans can no longer be are cancelled, not deleted");
  });
});

describe("the dispatch desk", () => {
  test("an order for 3 boxes of Nano 1 L, Ready and allocated to FP1BH", async () => {
    const a = await as(admin);
    assert.ok((await mod("orders").forms!.new(a, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "ABC Paints" }, [{ sku: BOX1, qty: "12", rate: "100" }])).ok);
    const [o] = (await db.execute(sql`select id, order_no as no from erp_orders`)) as unknown as { id: string; no: number }[];
    orderNo = Number(o.no);
    lineId = o.id;
    assert.ok((await mod("orders").actions!.verifyOrder(a, lineId, {})).ok);
    assert.ok((await mod("orders").actions!.ready(a, lineId, {})).ok);
    assert.ok((await mod("orders").forms!.allocate(a, { lot: "FP1BH", qty: "3" }, [], lineId)).ok);
    assert.ok((await mod("orders").actions!.bill(a, lineId, { invoiceNo: "INV-261008-00456", invoiceDate: TODAY })).ok);
    await attachInvoicePdf(lineId, a.user.id);
    assert.ok((await mod("orders").actions!.approveInvoice(a, lineId, {})).ok);
  });

  test("Do Verified waits for every box to be scanned", async () => {
    const a = await as(admin);
    const r = await mod("orderDetails").bulk!.verify(a, [lineId], { date: TODAY });
    assert.match(msg(r), /still to scan at the Dispatch desk/);
  });

  test("the queue carries what it is found by, and the box list offers only boxes this order could take", async () => {
    const q = (await dispatchQueue()).find((o) => o.orderNo === orderNo);
    assert.ok(q, "the order is on the queue");
    assert.equal(q.billing, "ABC Paints");
    assert.deepEqual(q.products, [BOX1]);
    const board = await dispatchBoard(orderNo);
    assert.ok(board);
    const boxes = await pickableBoxes(board);
    const lots = new Set(boxes.map((b) => b.lotCode));
    assert.ok(lots.has("FP1BH") && lots.has("FP2BH"), `both 1 L lots are offered: ${[...lots]}`);
    assert.ok(!lots.has("FP3BH"), "a 500 ml box is never offered for a 1 L line");
    assert.ok(boxes.every((b) => b.sku === BOX1 && b.lineId === lineId));
    assert.equal(boxes[0].lotCode, "FP1BH", "the allocated lot comes first");
    assert.ok(boxes.findIndex((b) => !b.allocated) > boxes.findLastIndex((b) => b.allocated), "allocated before the rest");
  });

  test("a matching box counts; the same box again, an unknown code and a box of the wrong pack size are stopped", async () => {
    const c = await as(clerk);
    const [b1, b2] = await unitsOf("FP1BH");
    const ok1 = await scanOntoOrder(c, orderNo, ` ${b1.id.toLowerCase()} `);
    assert.ok(ok1.ok && ok1.data.verdict.ok && ok1.data.verdict.allocation === "matched", JSON.stringify(ok1));
    const dup = await scanOntoOrder(c, orderNo, b1.id);
    assert.ok(dup.ok && !dup.data.verdict.ok && dup.data.verdict.result === "duplicate");
    const unknown = await scanOntoOrder(c, orderNo, "BX-000000-999999");
    assert.ok(unknown.ok && !unknown.data.verdict.ok && unknown.data.verdict.result === "unknown");
    const [half] = await unitsOf("FP3BH");
    const wrong = await scanOntoOrder(c, orderNo, half.id);
    assert.ok(wrong.ok && !wrong.data.verdict.ok && wrong.data.verdict.result === "mismatch");
    assert.match(wrong.ok && !wrong.data.verdict.ok ? wrong.data.verdict.message : "", /Pack size mismatch\. Ordered: .* – 1 L\. Scanned: .* – 500 ml/);
    assert.equal((await unitsOf("FP3BH"))[0].status, "available", "a stopped box is not touched");
    assert.ok((await scanOntoOrder(c, orderNo, b2.id)).ok);
    const scans = (await db.execute(sql`select result, count(*)::int as n from erp_dispatch_scans group by 1 order by 1`)) as unknown as { result: string; n: number }[];
    assert.deepEqual(scans.map((s) => [s.result, Number(s.n)]), [["duplicate", 1], ["mismatch", 1], ["ok", 2], ["unknown", 1]], "every scan is a row, refused ones included");
  });

  test("a box of another lot of the same SKU takes that lot's place on the allocation", async () => {
    const c = await as(clerk);
    const [other] = await unitsOf("FP2BH");
    const r = await scanOntoOrder(c, orderNo, other.id);
    assert.ok(r.ok && r.data.verdict.ok && r.data.verdict.allocation === "swap", JSON.stringify(r));
    const alloc = (await db.execute(sql`select lot_code as lot, quantity::float8 as q from erp_batch_codes where order_id = ${lineId} order by lot_code`)) as unknown as { lot: string; q: number }[];
    assert.deepEqual(alloc.map((x) => [x.lot, Number(x.q)]), [["FP1BH", 2], ["FP2BH", 1]]);
    /* Take it off again, and put the mismatched box on with an override instead. */
    assert.ok((await unscanUnit(c, other.id)).ok);
  });

  test("an override is asked for with a reason, decided by somebody else with the power, and used once", async () => {
    const c = await as(clerk);
    const [half] = await unitsOf("FP3BH");
    assert.match(msg(await requestOverride(c, orderNo, half.id, "short")), /Say why/);
    assert.ok((await requestOverride(c, orderNo, half.id, "Customer agreed on the phone to take 2 x 500 ml for one 1 L box")).ok);
    const [o] = (await db.execute(sql`select id from erp_dispatch_overrides`)) as unknown as { id: string }[];
    assert.equal((await decideOverride(c, o.id, true, null)).ok, false, "the clerk holds no override power");
    assert.ok((await decideOverride(await as(admin), o.id, true, "OK — note on the bill")).ok);
    const r = await scanOntoOrder(await as(clerk), orderNo, half.id);
    assert.ok(r.ok && r.data.verdict.ok && r.data.verdict.substituted, JSON.stringify(r));
    const [after] = (await db.execute(sql`select status from erp_dispatch_overrides where id = ${o.id}`)) as unknown as { status: string }[];
    assert.equal(after.status, "Used");
  });

  test("once all are scanned Do Verified goes, and the boxes become dispatched", async () => {
    const a = await as(admin);
    const r = await mod("orderDetails").bulk!.verify(a, [lineId], { date: TODAY });
    assert.ok(r.ok, JSON.stringify(r));
    const gone = (await db.execute(sql`select count(*)::int as n from erp_units where order_id = ${lineId} and status = 'dispatched'`)) as unknown as { n: number }[];
    assert.equal(Number(gone[0].n), 3);
    const [b1] = await unitsOf("FP1BH");
    const again = await scanOntoOrder(await as(clerk), orderNo, b1.id);
    assert.ok(again.ok && !again.data.verdict.ok && again.data.verdict.result === "duplicate", "a dispatched box cannot go twice");
  });
});

describe("a lot label at the desk (stock packed before box ids)", () => {
  test("the lot's QR allocates and then matches; a lot with box labels and a base-liquid lot are refused", async () => {
    const a = await as(admin);
    /* FP5BH stands for stock packed before box ids: its units are taken away, so the lot label is the only QR on it. */
    assert.ok((await mod("packBatches").forms!.new(a, { date: TODAY, godown: "Bhiwandi", fg: FG1, sku: BOX1, boxes: "2", lot: "FG1BH" }, [])).ok);
    await db.execute(sql`delete from erp_unit_events where unit_id in (select id from erp_units where lot_code = 'FP5BH')`);
    await db.execute(sql`delete from erp_units where lot_code = 'FP5BH'`);
    assert.ok((await mod("orders").forms!.new(a, { source: "Phone", date: TODAY, godown: "Bhiwandi", billing: "ABC Paints" }, [{ sku: BOX1, qty: "8", rate: "100" }])).ok);
    const [o] = (await db.execute(sql`select id, order_no as no from erp_orders order by order_no desc limit 1`)) as unknown as { id: string; no: number }[];
    assert.ok((await mod("orders").actions!.verifyOrder(a, o.id, {})).ok);
    assert.ok((await mod("orders").actions!.ready(a, o.id, {})).ok);

    const c = await as(clerk);
    const first = await scanOntoOrder(c, Number(o.no), "fp5bh");
    assert.ok(first.ok && first.data.verdict.ok && first.data.verdict.allocation === "allocate" && first.data.verdict.qty === 2, JSON.stringify(first));
    const alloc = (await db.execute(sql`select lot_code as lot, quantity::float8 as q from erp_batch_codes where order_id = ${o.id}`)) as unknown as { lot: string; q: number }[];
    assert.deepEqual(alloc.map((x) => [x.lot, Number(x.q)]), [["FP5BH", 2]]);
    const again = await scanOntoOrder(c, Number(o.no), "FP5BH");
    assert.ok(again.ok && again.data.verdict.ok && again.data.verdict.allocation === "matched", JSON.stringify(again));

    const labelled = await scanOntoOrder(c, Number(o.no), "FP1BH");
    assert.match(labelled.ok && !labelled.data.verdict.ok ? labelled.data.verdict.message : "", /scan each box/);
    const base = await scanOntoOrder(c, Number(o.no), "S1DRUM1");
    assert.match(base.ok && !base.data.verdict.ok ? base.data.verdict.message : "", /base-liquid lot/);
    const nothing = await scanOntoOrder(c, Number(o.no), "ZZ9NOPE");
    assert.ok(nothing.ok && !nothing.data.verdict.ok && nothing.data.verdict.result === "unknown");
  });
});

describe("tracing", () => {
  test("a box traces back to its batch, refill lot and SFG QC, and forward to the customer", async () => {
    const [b1] = await unitsOf("FP1BH");
    const t = await traceCode(b1.id);
    assert.ok(t);
    assert.deepEqual(t!.back.map((s) => s.stage).slice(0, 4), ["Packing", "Refill (FG filling)", "SFG QC", "SFG batch"]);
    assert.equal(t!.customers[0].customer, "ABC Paints");
    assert.ok(t!.facts.some((f) => f.l === "Refill lot" && f.v === "FG1BH"));
    assert.ok(t!.history.some((h) => h.text.startsWith("dispatched")));
  });

  test("an SFG lot traces forward to every refill lot, batch and customer it reached", async () => {
    const t = await traceCode("s1drum1");
    assert.ok(t && t.kind === "sfg");
    assert.deepEqual(t!.forward[0].rows.map((r) => r.text.split(" · ")[0]).sort(), ["FG1BH", "FG2BH", "FG3BH"]);
    assert.ok(t!.customers.some((c) => c.customer === "ABC Paints" && c.lots.includes("FP1BH")));
    assert.ok(t!.stock.length > 0, "and says what is still on a shelf");
  });

  test("an order and its bill trace back to their lots", async () => {
    const byOrder = await traceCode(`ORDER-${orderNo}`);
    const byBill = await traceCode("inv-261008-00456");
    assert.equal(byOrder?.kind, "order");
    assert.equal(byBill?.kind, "bill");
    assert.ok(byOrder!.back.some((s) => s.stage === "Packing"));
    assert.equal(await traceCode("NOTHING-LIKE-THIS"), null);
  });

  test("the dashboard counts today's production, scans and exceptions", async () => {
    const d = await traceDashboard();
    const today = Object.fromEntries(d.today.map((x) => [x.l, x.v]));
    assert.equal(today["Refilled"], "56 cans");
    assert.equal(today["Boxes dispatched"], "3");
    const ex = Object.fromEntries(d.exceptions.map((x) => [x.l, x.n]));
    assert.equal(ex["Pack-size / product mismatches today"], 1);
    assert.equal(ex["Duplicate scans today"], 2);
  });
});

/* After the tracing tests, whose counts of today's refills and lots this would change. */
describe("ids for stock packed or filled before box ids", () => {
  const BHW = "erpg_bhiwandi";
  const seqs = async (lot: string) => ((await db.execute(sql`select seq from erp_units where lot_code = ${lot} and status = 'available' order by seq`)) as unknown as { seq: number }[]).map((r) => Number(r.seq));
  const packRow = async (batch: string) => {
    const { rows } = await mod("packStock").load(await as(admin));
    return rows.find((r) => r.id === `${batch}|${BHW}`)!;
  };

  before(async () => {
    const a = await as(admin);
    assert.ok((await mod("fgFill").forms!.new(a, { date: TODAY, godown: "Bhiwandi", sfg: SFG, sfgLot: "S1DRUM1", fg: FG1, size: "1", cans: "24" }, [])).ok); // FG4BH
    const pack = (boxes: string) => mod("packBatches").forms!.new(a, { date: TODAY, godown: "Bhiwandi", fg: FG1, sku: BOX1, boxes, lot: "FG4BH" }, []);
    assert.ok((await pack("3")).ok, "FP6BH");
    assert.ok((await pack("2")).ok, "FP7BH");
    /* Both stand for batches imported from before box ids: nothing ever minted theirs. */
    await db.execute(sql`delete from erp_unit_events where unit_id in (select id from erp_units where lot_code in ('FP6BH', 'FP7BH'))`);
    await db.execute(sql`delete from erp_units where lot_code in ('FP6BH', 'FP7BH')`);
  });

  test("such a batch prints nothing, says so, and its boxes are given ids once, numbered from one", async () => {
    const a = await as(admin);
    assert.deepEqual(await boxLabels({ batch: "FP6BH" }), []);
    assert.deepEqual((await unlabelledStock({ batch: "FP6BH" })).map((u) => [u.godownId, u.room]), [[BHW, 3]]);
    const before = await packRow("FP6BH");
    assert.deepEqual(before.actions!.slice(0, 2).map((x) => [x.id, !!x.primary]), [["labelBoxes", true], ["labels", false]]);

    assert.ok((await mod("packStock").actions!.labelBoxes(a, `FP6BH|${BHW}`, {})).ok);
    assert.deepEqual(await seqs("FP6BH"), [1, 2, 3]);
    assert.match(msg(await mod("packStock").actions!.labelBoxes(a, `FP6BH|${BHW}`, {})), /already carries an id/);

    const labels = await boxLabels({ batch: "FP6BH" });
    assert.deepEqual(labels.map((l) => [l.label.seq, l.label.of]), [[1, 3], [2, 3], [3, 3]]);
    assert.deepEqual(await unlabelledStock({ batch: "FP6BH" }), []);
    assert.deepEqual((await packRow("FP6BH")).actions!.slice(0, 1).map((x) => [x.id, !!x.primary]), [["labels", true]]);
  });

  test("only the boxes still on the shelf get one, asked from the label sheet", async () => {
    const a = await as(admin);
    assert.ok((await mod("packStock").actions!.adjust(a, `FP7BH|${BHW}`, { dir: "Remove", qty: "1", reason: "Damaged" })).ok);
    assert.deepEqual((await unlabelledStock({ batch: "FP7BH" })).map((u) => u.room), [1]);
    const given = await erpGiveIds({ batch: "FP7BH", godownId: BHW });
    assert.ok(given.ok, msg(given));
    assert.deepEqual(await seqs("FP7BH"), [1]);
    assert.deepEqual((await boxLabels({ batch: "FP7BH" })).map((l) => [l.label.seq, l.label.of]), [[1, 2]]);
  });

  test("an FG lot's cans are labelled loose from the label sheet, within the lot's headroom", async () => {
    const [u] = await unlabelledStock({ lot: "FG4BH" });
    assert.equal(u.room, 4, "24 cans filled, 20 boxed");
    assert.equal(u.sku, LOOSE1);
    const give = (count: number) => erpGiveIds({ lot: "FG4BH", finishedGoodId: u.finishedGoodId!, godownId: BHW, count });
    assert.match(msg(await give(5)), /Only 4 more/);
    assert.ok((await give(3)).ok);
    assert.equal((await boxLabels({ lot: "FG4BH" })).length, 3);
    assert.deepEqual((await unlabelledStock({ lot: "FG4BH" })).map((x) => x.room), [1]);
  });
});

const unitsStatus = async (unit: string) => ((await db.execute(sql`select status from erp_units where id = ${unit}`)) as unknown as { status: string }[])[0]?.status;

describe("a box released from hold", () => {
  test("is confirmed through the impact modal, which says it can be scanned again", async () => {
    const [box] = (await db.execute(sql`select id from erp_units where status = 'available' order by created_at, id limit 1`)) as unknown as { id: string }[];
    const ctx = await as(admin);
    assert.ok((await mod("units").actions!.hold(ctx, box.id, { note: "Dented on the shelf" })).ok);
    assert.match(msg(await mod("units").actions!.release(ctx, box.id, {})), /Check what this affects/, "the bare act is refused");
    setTestUser(admin);
    const report = await impactReport("erp-unit-release", box.id);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.equal(report.data.confirmWord, box.id);
    assert.ok(report.data.items.some((i) => /on hold can be scanned for dispatch again/.test(i.label)), JSON.stringify(report.data.items));
    const done = await mod("units").actions!.release(ctx, box.id, { [IMPACT_FIELD]: JSON.stringify({ typed: box.id, fingerprint: report.data.fingerprint }) });
    assert.ok(done.ok, msg(done));
    assert.equal((await unitsStatus(box.id)), "available");
  });
});
