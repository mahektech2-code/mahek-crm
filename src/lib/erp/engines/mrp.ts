/* ---------------------------------------------------------------------------
 * THE MRP CHECK — pure. What an approved order needs before production may
 * start, against what the godown holds now: finished goods on the shelf, the
 * base (SFG) in the tank, the raw materials a batch of that base takes by its
 * recipe, and empty cans and boxes. Capacity is not modelled anywhere in
 * MahekOne, so it is the Production Head's tick, never a figure here.
 *
 * Stock is shared with every other order: this says what is there NOW, not
 * what is promised elsewhere — the Production Head reads it with that in mind.
 * ------------------------------------------------------------------------- */

export type MrpLine = {
  lineId: string;
  sku: string;
  skuId: string;
  cans: number;
  litresPerCan: number;
  boxed: boolean;
  cansPerBox: number;
  finishedGoodId: string | null;
  formulationId: string | null;
  formulation: string | null;
  canMaterialId: string | null;
  canMaterial: string | null;
};

export type MrpStock = {
  /** Packed boxes on the shelf, by SKU. */
  packedBoxes: Map<string, number>;
  /** Loose filled cans, by finished good (and SKU where a lot names one). */
  looseCans: Map<string, number>;
  /** QC-approved base in the tank, litres, by formulation. */
  baseLitres: Map<string, number>;
  /** A batch's size in litres, by formulation, where a past batch says. */
  batchLitres: Map<string, number>;
  /** Raw-material stock, by material id. */
  material: Map<string, number>;
  materialName: Map<string, string>;
  materialUnit: Map<string, string>;
  /** The recipe of one batch, by formulation: material id → quantity. */
  recipe: Map<string, Map<string, number>>;
};

export type MrpLineAnswer = {
  lineId: string;
  sku: string;
  cans: number;
  onShelfCans: number;
  toMakeCans: number;
  toMakeLitres: number;
  /** Boxes to pack (boxed SKUs), from shelf cans or freshly filled. */
  boxesToPack: number;
};

export type MrpMaterial = { id: string; name: string; unit: string; need: number; stock: number; short: number };

export type MrpBase = {
  formulationId: string;
  formulation: string;
  needLitres: number;
  inTank: number;
  shortLitres: number;
  batches: number;
  /** A batch's size was not known, so one batch is assumed and said. */
  batchGuessed: boolean;
  materials: MrpMaterial[];
};

export type MrpAnswer = {
  lines: MrpLineAnswer[];
  bases: MrpBase[];
  cans: MrpMaterial[];
  /** Plain sentences naming everything short; empty when it can all be made. */
  short: string[];
  /** A line whose product names no base: nothing about making it can be said. */
  unknown: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function mrpCheck(lines: MrpLine[], stock: MrpStock): MrpAnswer {
  /* Shelf stock is spent across this order's lines in order, so two lines of one SKU do not both claim the same box. */
  const packed = new Map(stock.packedBoxes);
  const loose = new Map(stock.looseCans);
  const answers: MrpLineAnswer[] = [];
  const baseNeed = new Map<string, { name: string; litres: number }>();
  const canNeed = new Map<string, { name: string; cans: number }>();
  const unknown: string[] = [];
  for (const l of lines) {
    let need = l.cans;
    let onShelf = 0;
    let packedCans = 0;
    if (l.boxed && l.cansPerBox > 0) {
      const boxes = packed.get(l.skuId) ?? 0;
      const useBoxes = Math.min(boxes, Math.floor(need / l.cansPerBox));
      packed.set(l.skuId, boxes - useBoxes);
      packedCans = useBoxes * l.cansPerBox;
      onShelf += packedCans;
      need -= packedCans;
    }
    const looseKey = l.finishedGoodId ?? l.skuId;
    const cans = loose.get(looseKey) ?? 0;
    const useCans = Math.min(cans, need);
    loose.set(looseKey, cans - useCans);
    onShelf += useCans;
    need -= useCans;
    const boxesToPack = l.boxed && l.cansPerBox > 0 ? Math.ceil((l.cans - packedCans) / l.cansPerBox) : 0;
    const litres = r2(need * l.litresPerCan);
    if (need > 0) {
      if (l.formulationId) {
        const b = baseNeed.get(l.formulationId) ?? { name: l.formulation ?? "Base", litres: 0 };
        b.litres = r2(b.litres + litres);
        baseNeed.set(l.formulationId, b);
      } else unknown.push(l.sku);
      if (l.canMaterialId) {
        const c = canNeed.get(l.canMaterialId) ?? { name: l.canMaterial ?? "Empty can", cans: 0 };
        c.cans += need;
        canNeed.set(l.canMaterialId, c);
      }
    }
    answers.push({ lineId: l.lineId, sku: l.sku, cans: l.cans, onShelfCans: onShelf, toMakeCans: need, toMakeLitres: litres, boxesToPack: Math.max(0, boxesToPack) });
  }

  const short: string[] = [];
  const bases: MrpBase[] = [];
  const used = new Map<string, number>();
  for (const [fid, b] of baseNeed) {
    const inTank = r2(stock.baseLitres.get(fid) ?? 0);
    const shortLitres = r2(Math.max(0, b.litres - inTank));
    const size = stock.batchLitres.get(fid) ?? null;
    const batches = shortLitres > 0 ? (size && size > 0 ? Math.ceil(shortLitres / size) : 1) : 0;
    const materials: MrpMaterial[] = [];
    if (batches > 0) {
      const recipe = stock.recipe.get(fid);
      if (!recipe || !recipe.size) short.push(`${b.name}: ${shortLitres} L to make and no recipe is recorded`);
      for (const [mid, perBatch] of recipe ?? []) {
        const needQty = r2(perBatch * batches);
        const have = r2((stock.material.get(mid) ?? 0) - (used.get(mid) ?? 0));
        used.set(mid, (used.get(mid) ?? 0) + needQty);
        const m = { id: mid, name: stock.materialName.get(mid) ?? mid, unit: stock.materialUnit.get(mid) ?? "", need: needQty, stock: Math.max(0, have), short: r2(Math.max(0, needQty - Math.max(0, have))) };
        if (m.short > 0) short.push(`${m.name} short by ${m.short}${m.unit ? ` ${m.unit}` : ""}`);
        materials.push(m);
      }
    }
    bases.push({ formulationId: fid, formulation: b.name, needLitres: b.litres, inTank, shortLitres, batches, batchGuessed: batches > 0 && !(stock.batchLitres.get(fid) ?? 0), materials });
  }
  const cansOut: MrpMaterial[] = [];
  for (const [mid, c] of canNeed) {
    const have = r2((stock.material.get(mid) ?? 0) - (used.get(mid) ?? 0));
    const m = { id: mid, name: c.name, unit: stock.materialUnit.get(mid) ?? "pcs", need: c.cans, stock: Math.max(0, have), short: r2(Math.max(0, c.cans - Math.max(0, have))) };
    if (m.short > 0) short.push(`${m.name} short by ${m.short}`);
    cansOut.push(m);
  }
  return { lines: answers, bases, cans: cansOut, short, unknown };
}
