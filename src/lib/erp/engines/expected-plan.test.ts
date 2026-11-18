import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedPlan, stockCheckWords, type DemandLine, type ExpectedSource, type PlanStock } from "./expected-plan";

const nano = (orderNo: number, qtyCans: number, party = "Balaji Colours"): DemandLine => ({
  orderNo,
  skuId: "sku-nano20",
  skuName: "Nano Thinner 20 L (Loose)",
  skuCode: null,
  cansPerBox: 1,
  millilitres: 20000,
  finishedGoodId: "fg-nano20",
  finishedGoodName: "Nano Thinner 20 L",
  qtyCans,
  formulationId: "f-nano",
  formulationName: "Nano base",
  party,
});
const pu = (qtyCans: number): DemandLine => ({ ...nano(0, qtyCans), skuId: "sku-pu5", skuName: "PU Thinner 5 L", cansPerBox: 6, millilitres: 5000, finishedGoodId: "fg-pu5", finishedGoodName: "PU Thinner 5 L", formulationId: "f-pu", formulationName: "PU base" });

const src = (over: Partial<ExpectedSource> & Pick<ExpectedSource, "key" | "stage" | "lines">): ExpectedSource => ({
  orderNo: null,
  toNo: null,
  party: "Om Paints",
  since: "2026-11-18T04:00:00.000Z",
  by: null,
  held: false,
  holdReason: null,
  sentBack: false,
  noGodown: false,
  ...over,
});

const stock = (loose: number, boxes = 0, base = 0): PlanStock => ({
  looseCans: new Map([["fg-nano20", loose]]),
  packedBoxes: new Map([["sku-pu5", boxes]]),
  baseLitres: new Map([["f-nano", base]]),
});

test("confirmed, MRP-waiting and Accounts-waiting are counted in their own columns", () => {
  const e = expectedPlan(
    [nano(8842, 18)],
    [
      src({ key: "o:8843", stage: "mrp", orderNo: 8843, toNo: 1048, lines: [nano(8843, 40)] }),
      src({ key: "t:1051", stage: "accounts", toNo: 1051, since: "2026-11-17T12:40:00.000Z", lines: [nano(0, 20)] }),
      src({ key: "t:1054", stage: "accounts", toNo: 1054, lines: [nano(0, 10)] }),
    ],
    stock(52, 0, 200),
  );
  const row = e.products[0];
  assert.deepEqual([row.confirmed, row.mrp, row.accounts, row.stock], [18, 40, 30, 52]);
  assert.equal(row.verdict.text, "Short 36 cans · 720 L");
  assert.deepEqual(e.counts, { confirmedOrders: 1, mrpOrders: 1, accountsTos: 2, oldestAccounts: "2026-11-17T12:40:00.000Z" });
  assert.deepEqual(e.shortProducts, ["Nano Thinner 20 L"]);
  assert.deepEqual(row.orders.map((o) => `${o.stage} ${o.ref}`), ["confirmed Order 8842", "mrp Order 8843", "accounts TO-1051", "accounts TO-1054"]);
});

test("a held TO and one with no godown are not counted", () => {
  const e = expectedPlan(
    [],
    [src({ key: "t:1", stage: "accounts", toNo: 1, held: true, lines: [nano(0, 99)] }), src({ key: "t:2", stage: "accounts", toNo: 2, noGodown: true, lines: [nano(0, 99)] })],
    stock(0),
  );
  assert.equal(e.products.length, 0);
  assert.equal(e.counts.accountsTos, 0);
});

test("enough stock says the spare; short only on confirmed says so", () => {
  const ok = expectedPlan([{ ...pu(24), orderNo: 8844 }], [src({ key: "o:1", stage: "mrp", orderNo: 1, lines: [pu(36)] })], stock(0, 16));
  assert.equal(ok.products[0].verdict.text, "Enough · 36 spare");
  const short = expectedPlan([nano(8840, 30)], [], stock(10));
  assert.equal(short.products[0].verdict.text, "Short 20 cans · 400 L");
  assert.equal(short.products[0].verdict.note, "(confirmed)");
});

test("the base needed is split confirmed first, and names the expected orders", () => {
  const e = expectedPlan([nano(8842, 18)], [src({ key: "t:1051", stage: "accounts", toNo: 1051, lines: [nano(0, 20)] })], stock(10, 0, 100));
  assert.deepEqual(e.bases[0], { formulationId: "f-nano", name: "Nano base", confirmedLitres: 160, expectedLitres: 400, inTank: 100, shortLitres: 460, expectedFor: ["TO-1051"] });
});

test("stock check words follow the MRP answer", () => {
  const all = stockCheckWords({ lines: [{ lineId: "a", sku: "PU Thinner - 5 L", cans: 6, onShelfCans: 6, toMakeCans: 0, toMakeLitres: 0, boxesToPack: 0 }], bases: [], cans: [], short: [], unknown: [] }, new Map());
  assert.equal(all.lines[0].text, "All in stock");
  const base = stockCheckWords(
    {
      lines: [{ lineId: "a", sku: "Nano Thinner - 20 L", cans: 20, onShelfCans: 0, toMakeCans: 20, toMakeLitres: 400, boxesToPack: 0 }],
      bases: [{ formulationId: "f", formulation: "Nano base", needLitres: 400, inTank: 0, shortLitres: 400, batches: 1, batchGuessed: true, materials: [] }],
      cans: [],
      short: [],
      unknown: [],
    },
    new Map([["a", "f"]]),
  );
  assert.deepEqual(base.lines, [{ tone: "short", text: "Nano Thinner: base short 400 L" }]);
  const mat = stockCheckWords(
    {
      lines: [{ lineId: "a", sku: "X", cans: 1, onShelfCans: 0, toMakeCans: 1, toMakeLitres: 1, boxesToPack: 0 }],
      bases: [{ formulationId: "f", formulation: "B", needLitres: 1, inTank: 0, shortLitres: 1, batches: 1, batchGuessed: false, materials: [{ id: "m", name: "Toluene", unit: "Kg", need: 320, stock: 0, short: 320 }] }],
      cans: [],
      short: [],
      unknown: [],
    },
    new Map(),
  );
  assert.equal(mat.lines[0].text, "Short: Toluene 320 kg");
});

test("filled cans left after the loose orders count towards a boxed product of the same finished good", () => {
  const boxed: DemandLine = { ...nano(0, 12), skuId: "sku-nano-box", skuName: "Nano 20 L (4/box)", cansPerBox: 4 };
  const e = expectedPlan([nano(1, 10)], [src({ key: "t:9", stage: "accounts", toNo: 9, lines: [boxed] })], { looseCans: new Map([["fg-nano20", 30]]), packedBoxes: new Map(), baseLitres: new Map() });
  assert.equal(e.products.find((p) => p.key === "packing:sku-nano-box")?.stock, 12);
  assert.equal(e.products.find((p) => p.key === "loose:fg-nano20")?.stock, 30);
});
