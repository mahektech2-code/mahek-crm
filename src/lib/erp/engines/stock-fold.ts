/* ---------------------------------------------------------------------------
 * RAW-MATERIAL STOCK: A CHEMICAL BY ITS LOT, EVERYTHING ELSE BY ITS ITEM.
 *
 * A chemical's lot is a real thing: it was tested as a lot, and every SFG
 * batch names the lot it drew. Two lots of Toluene are two rows because they
 * are two different drums of evidence.
 *
 * A can, a box, a drum or a roll of stationery has no such life. Filling and
 * packing do not record which lot of cans or boxes they used, so `rmLots`
 * draws them down OLDEST FIRST — the per-lot figure is the system's estimate
 * and only the item's total is a fact. So these are read as one row per item
 * per godown, with their lots folded underneath for when somebody needs one.
 *
 * PURE: lots in, rows out.
 * ------------------------------------------------------------------------- */

export type FoldLot = {
  rawMaterialId: string;
  materialType: string;
  lotNo: string;
  godownId: string;
  stock: number;
  firstDate: string;
  ratePaise: number | null;
};

/** The one type read lot by lot. Anything else — Can, Box, Drum, Stationary, a type added later — is totalled by item. */
export const LOT_BY_LOT_TYPES: readonly string[] = ["Chemical"];

export function readsByLot(materialType: string): boolean {
  return LOT_BY_LOT_TYPES.includes(materialType);
}

/** The id a lot's row has always had, so `?open=` links and dashboard filters keep finding it. */
export const lotRowId = (l: Pick<FoldLot, "lotNo" | "godownId">) => `${l.lotNo}|${l.godownId}`;
/** The id of an item's total at one godown. */
export const itemRowId = (l: Pick<FoldLot, "rawMaterialId" | "godownId">) => `item|${l.rawMaterialId}|${l.godownId}`;

export type FoldedRow<L extends FoldLot> =
  | { kind: "lot"; id: string; lot: L }
  | {
      kind: "item";
      id: string;
      /** Its lots, oldest first — the order they are drawn down in. */
      lots: L[];
      stock: number;
      /** Null when any lot has no rate yet: a part-sum would read as the whole. */
      valuePaise: number | null;
      /** The value over the stock — the lots' weighted rate — where both mean something. */
      ratePaise: number | null;
    };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The rows the Raw material tab draws, in the lots' own order: a chemical lot
 * where it stood, an item's total where its first lot stood.
 */
export function foldRmLots<L extends FoldLot>(lots: L[]): FoldedRow<L>[] {
  const out: FoldedRow<L>[] = [];
  const at = new Map<string, Extract<FoldedRow<L>, { kind: "item" }>>();
  for (const l of lots) {
    if (readsByLot(l.materialType)) {
      out.push({ kind: "lot", id: lotRowId(l), lot: l });
      continue;
    }
    const id = itemRowId(l);
    let row = at.get(id);
    if (!row) {
      row = { kind: "item", id, lots: [], stock: 0, valuePaise: 0, ratePaise: null };
      at.set(id, row);
      out.push(row);
    }
    row.lots.push(l);
  }
  for (const row of at.values()) {
    row.lots.sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.lotNo.localeCompare(b.lotNo));
    row.stock = r3(row.lots.reduce((t, l) => t + l.stock, 0));
    row.valuePaise = row.lots.some((l) => l.ratePaise == null) ? null : Math.round(row.lots.reduce((t, l) => t + (l.ratePaise ?? 0) * l.stock, 0));
    row.ratePaise = row.valuePaise != null && row.stock > 0 ? Math.round(row.valuePaise / row.stock) : null;
  }
  return out;
}
