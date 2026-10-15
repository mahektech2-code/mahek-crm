import "server-only";
import QRCode from "qrcode";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpPurchases, erpRawMaterials } from "@/db/schema";
import { lotSize, productLine, shortRef, type BoxLabel, type DispatchLabel, type PurchaseLabel, type Qr, type SfgLabel } from "./engines/labels";
import { purchaseFigures, shortLabel } from "./engines/purchase";
import { packLabel } from "./engines/trace";
import { refValues } from "./refs";
import { orderLines } from "./screens/sales";
import { sfgLots } from "./stock";

/* ---------------------------------------------------------------------------
 * WHAT EACH LABEL SAYS, read from the record. A label is never typed: every
 * word on it is a column of the row it was printed from, read here by the same
 * functions the screens read, so a drum and the list it came from cannot
 * disagree about a lot.
 * ------------------------------------------------------------------------- */

/**
 * Error level M, as the box labels have always been: a quarter of the code can
 * be scuffed away and it still reads. A box id and a lot code are both short
 * enough to stay the smallest code there is (21 modules) at that level.
 */
export function qrFor(text: string): Qr {
  const m = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
  let bits = "";
  for (let i = 0; i < m.size * m.size; i++) bits += m.data[i] ? "1" : "0";
  return { n: m.size, bits };
}

type UnitRow = {
  id: string;
  kind: string;
  sku: string;
  product: string | null;
  litres: number | null;
  cans: number;
  lotFrom: string;
  lotCode: string;
  seq: number;
};

export type BoxLabelRow = { label: BoxLabel; qr: Qr };

export type BoxQuery = { batch: string } | { lot: string } | { ids: string[] };

/** Box labels for a packing batch, the labelled loose units of an FG lot still on the shelf, or a selection. */
export async function boxLabels(q: BoxQuery): Promise<BoxLabelRow[]> {
  const where =
    "batch" in q
      ? sql`u.lot_from = 'pack' and u.lot_code = ${q.batch} and u.status <> 'cancelled'`
      : "lot" in q
        ? sql`u.lot_from = 'fg' and u.lot_code = ${q.lot} and u.status in ('available', 'hold')`
        : sql`u.id in ${q.ids}`;
  const units = (await db.execute(sql`
    select u.id, u.kind, p.name as sku, b.name as product, coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as litres,
           u.cans, u.lot_from as "lotFrom", u.lot_code as "lotCode", u.seq
      from erp_units u
      join products p on p.id = u.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join product_brands b on b.id = fg.brand_id
     where ${where}
     order by u.lot_code, u.seq
     limit 2000
  `)) as unknown as UnitRow[];
  if (!units.length) return [];

  /* When each packing batch was packed and how many boxes it made — the first line of the batch, as it always was. */
  const batches = [...new Set(units.filter((u) => u.lotFrom === "pack").map((u) => u.lotCode))];
  const lots = [...new Set(units.filter((u) => u.lotFrom === "fg").map((u) => u.lotCode))];
  const [packs, fills] = await Promise.all([
    batches.length
      ? (db.execute(sql`select batch_no as code, pack_date::text as date, boxes from erp_pack_lines where batch_no in ${batches} order by created_at`) as unknown as Promise<{ code: string; date: string; boxes: number }[]>)
      : Promise.resolve([]),
    lots.length
      ? (db.execute(sql`select lot_code as code, min(fill_date)::text as date from erp_fg_fills where lot_code in ${lots} group by lot_code`) as unknown as Promise<{ code: string; date: string }[]>)
      : Promise.resolve([]),
  ]);
  const packOf = new Map<string, { date: string; boxes: number }>();
  for (const p of packs) if (!packOf.has(p.code)) packOf.set(p.code, { date: p.date, boxes: Number(p.boxes) });
  const fillOf = new Map(fills.map((f) => [f.code, f.date]));

  return units.map((u) => {
    const box = u.kind === "box";
    const pack = u.lotFrom === "pack" ? packOf.get(u.lotCode) : undefined;
    return {
      label: {
        kind: "box",
        id: u.id,
        size: packLabel(u.litres),
        cans: box ? Number(u.cans) : null,
        name: productLine(u.product ?? u.sku),
        lotWord: u.lotFrom === "pack" ? "Batch" : "Lot",
        lot: u.lotCode,
        unitWord: box ? "Box" : "Unit",
        seq: Number(u.seq),
        of: box && pack?.boxes ? pack.boxes : null,
        date: pack?.date ?? fillOf.get(u.lotCode) ?? null,
      },
      qr: qrFor(u.id),
    };
  });
}

export type SfgLabelRow = { label: SfgLabel; qr: Qr };

/**
 * The label for an SFG lot at a godown: the row the Semi-finished stock list
 * shows for it, read by the same function, so the batches and the batch size
 * on the drum are the ones on the screen.
 */
export async function sfgLabel(lotCode: string, godownId: string | null): Promise<SfgLabelRow | null> {
  const lots = (await sfgLots()).filter((l) => l.lotCode === lotCode);
  const l = lots.find((x) => x.godownId === godownId) ?? (godownId ? undefined : lots.find((x) => x.stock > 0) ?? lots[0]);
  if (!l) return null;
  return {
    label: {
      kind: "sfg",
      type: l.latestType === "Transfer" ? "Transfer" : "Semi finished",
      product: l.product,
      lot: l.lotCode,
      batches: l.batches,
      batchSizeLitres: l.batchSize,
      date: l.latestDate,
      location: l.godown,
      inventoryId: l.latestEntryId,
    },
    qr: qrFor(l.lotCode),
  };
}

export type PurchaseLabelRow = { label: PurchaseLabel; qr: Qr; godownId: string };

/** The label for a purchased lot: the row the Purchase barcode list shows for it. */
export async function purchaseLabel(id: string): Promise<PurchaseLabelRow | null> {
  const [[r], pairs] = await Promise.all([
    db
      .select({ p: erpPurchases, item: erpRawMaterials.name })
      .from(erpPurchases)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpPurchases.rawMaterialId))
      .where(eq(erpPurchases.id, id)),
    refValues("shortLabel"),
  ]);
  if (!r) return null;
  const p = r.p;
  const f = purchaseFigures({
    quantity: p.quantity,
    unit: p.unit,
    ratePaise: p.ratePaise,
    density: p.density,
    feedAdjustedLitre: p.feedAdjustedLitre,
    feedAdjustedAmountPaise: p.feedAdjustedAmountPaise,
    gstBp: p.gstBp,
    drums: p.drums,
  });
  return {
    label: {
      kind: "purchase",
      item: shortLabel(r.item, pairs),
      lot: p.lotNo,
      date: p.purchaseDate,
      quantity: p.quantity,
      unit: p.unit,
      inLitre: f.inLitre,
      density: p.density,
      drums: p.drums,
      litresPerDrum: f.litresPerDrum,
      prNumber: p.prNumber,
      prBillNo: p.id,
      testingId: p.testId,
      remark: p.remark?.trim() || null,
    },
    qr: qrFor(p.lotNo),
    godownId: p.godownId,
  };
}

export type DispatchLabelRow = { label: DispatchLabel; lineId: string; copies: number };

/**
 * Dispatch labels for an order: one for every box or can on every line that is
 * still going, each carrying the LOT SIZE — the labels on the whole order —
 * so the pieces can be counted on and off the lorry. Read through the order
 * lines every sales list shares, so the type, the label count and the weight
 * are the ones on the Labels tab.
 */
export async function dispatchLabels(orderNo: number): Promise<DispatchLabelRow[]> {
  const lines = (await orderLines()).filter((l) => l.o.orderNo === orderNo && l.o.status !== "Cancel");
  if (!lines.length) return [];
  /* Entered order, not newest first: the labels come off the roll as the order was written. */
  lines.sort((a, b) => a.o.createdAt.getTime() - b.o.createdAt.getTime());
  const size = lotSize(lines);
  return lines.map((l) => ({
    lineId: l.o.id,
    copies: Math.max(0, Math.round(l.labels)),
    label: {
      kind: "dispatch",
      orderNo: l.o.orderNo,
      date: l.o.orderDate,
      lineRef: shortRef(l.o.id),
      delivery: l.delivery.name,
      area: l.delivery.area?.trim() || l.delivery.city?.trim() || null,
      billing: l.billing.name,
      sku: l.sku.name,
      qty: l.o.qtyCans,
      type: l.type,
      weightKg: l.sku.weightKg == null ? null : Number(l.sku.weightKg),
      lotSize: size,
      remark: l.o.remark?.trim() || null,
      transporter: (l.o.transporter ?? l.delivery.p?.transporter ?? "").trim() || null,
    },
  }));
}
