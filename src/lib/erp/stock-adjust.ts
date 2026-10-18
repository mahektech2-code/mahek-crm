import "server-only";
import { sql } from "drizzle-orm";
import { erpFgEntries, erpManualAdjustments, erpPackEntries, erpRmEntries, erpSfgEntries } from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { erpAudit, erpId } from "./server";
import { nf, type ActionSpec, type PromptSpec } from "./ui";
import { fgLots, lockLot, packLots, rmLots, sfgLots, type Ex } from "./stock";
import { inTx, refuse, today, type Tx } from "./screens/common";
import { postWriteOff } from "./screens/movement";
import { ADJUST_DIRECTIONS, ADJUST_REASONS, adjustReasonText, readAdjust, stockAfter, type AdjustStage } from "./engines/stock-adjust";
import { erpStockInquiryHref } from "./stock-links";

/* ---------------------------------------------------------------------------
 * STOCK IS ADJUSTED FROM ITS ROW. Every row of Stock on hand — raw material,
 * semi-finished, finished goods, packed — carries a ⋯ menu with Stock inquiry
 * and Adjust stock. Adjusting is Add or Remove, a quantity and a reason, and
 * it takes effect on save:
 *
 *   Add    → an inflow entry on the same lot in the stage's own ledger,
 *            `source_type = 'adjustment'`, `source_id` the adjustment.
 *   Remove → the quantity written off to Item Lost Record as a transfer,
 *            exactly what the transfer form does, boxes and labels included.
 *
 * Nothing is ever taken below zero. The adjustment row keeps who, when, why
 * and what it posted; the stock inquiry shows it beside the movement.
 * ------------------------------------------------------------------------- */

/** One lot of one stage, as the stock screens name it in a row id. */
type LotRef = { stage: AdjustStage; itemId: string; item: string; lot: string; godownId: string; godown: string; stock: number; unit: string };

const TRANSFER_TYPE = { rm: "Purchase", sfg: "Semi Finished", fg: "Finish Goods", pack: "FG Packing" } as const;
/** Both spellings each stage's consumers lock under. */
const LOCKS: Record<AdjustStage, string[]> = { rm: ["rm", "Purchase"], sfg: ["sfg", "Semi Finished"], fg: ["fg", "Finish Goods"], pack: ["pack", "FG Packing"] };

/** The lot a stock row's id names, with its stock now. Ids: rm/sfg/pack `lot|godown`, fg `fg|lot|godown`. */
export async function lotForRow(stage: AdjustStage, rowId: string, ex?: Ex): Promise<LotRef | null> {
  const parts = rowId.split("|");
  if (stage === "fg") {
    const [fg, lot, godownId] = parts;
    if (!fg || !lot || !godownId) return null;
    const l = (await fgLots(ex, { lots: [lot] })).find((x) => x.finishedGoodId === fg && x.lotCode === lot && x.godownId === godownId);
    return l ? { stage, itemId: l.finishedGoodId, item: l.product, lot, godownId, godown: l.godown, stock: l.stock, unit: "cans" } : null;
  }
  const [lot, godownId] = parts;
  if (!lot || !godownId) return null;
  if (stage === "rm") {
    const l = (await rmLots(ex, { lots: [lot] })).find((x) => x.lotNo === lot && x.godownId === godownId);
    return l ? { stage, itemId: l.rawMaterialId, item: l.item, lot, godownId, godown: l.godown, stock: l.stock, unit: l.unit } : null;
  }
  if (stage === "sfg") {
    const l = (await sfgLots(ex, { lots: [lot] })).find((x) => x.lotCode === lot && x.godownId === godownId);
    return l ? { stage, itemId: l.formulationId, item: l.product, lot, godownId, godown: l.godown, stock: l.stock, unit: "Ltr" } : null;
  }
  const l = (await packLots(ex, { lots: [lot] })).find((x) => x.batchNo === lot && x.godownId === godownId);
  return l ? { stage, itemId: l.skuId, item: l.sku, lot, godownId, godown: l.godown, stock: l.stock, unit: "boxes" } : null;
}

/** Who may adjust: whoever holds the stock-control power (an ERP administrator always does). */
export function mayAdjust(ctx: ErpContext): boolean {
  return ctx.powers.has("stockControl");
}

/** The row's ⋯ menu: Stock inquiry always, Adjust stock for whoever may. */
export function stockRowActions(
  ctx: ErpContext,
  r: { stage: AdjustStage; itemId: string; item: string; lot: string; godownId: string; godown: string; stock: number; unit: string },
): ActionSpec[] {
  const out: ActionSpec[] = [{ id: "inquiry", l: "Stock inquiry", href: erpStockInquiryHref({ stage: r.stage, item: r.itemId, godown: r.godownId }) }];
  if (mayAdjust(ctx)) out.push({ id: "adjust", l: "Adjust stock", prompt: adjustPrompt(r) });
  return out;
}

function adjustPrompt(r: { item: string; lot: string; godown: string; stock: number; unit: string }): PromptSpec {
  return {
    title: "Adjust stock",
    sub: `${r.item} · ${r.lot} · ${r.godown} — ${nf(r.stock)} ${r.unit} in stock now.`,
    submit: "Save",
    fields: [
      { k: "dir", l: "Add or remove", t: "pick", req: true, opts: [...ADJUST_DIRECTIONS] },
      { k: "qty", l: `Quantity (${r.unit})`, t: "num", req: true, min: 0.001 },
      { k: "reason", l: "Reason", t: "pick", req: true, opts: ADJUST_REASONS.map((x) => x.label) },
      { k: "note", l: "Write the reason", t: "area", req: true, when: { k: "reason", eq: "Other" } },
    ],
  };
}

/** The `adjust` action every stock screen answers with. */
export async function adjustStockRow(ctx: ErpContext, stage: AdjustStage, rowId: string, values: Record<string, string | undefined>): Promise<Result<unknown>> {
  if (!mayAdjust(ctx)) return err("Adjusting stock needs the stock-control power.", "not_permitted");
  let made: { id: string; lot: LotRef; signed: number; after: number; reason: string } | null = null;
  const res = await inTx(async (tx) => {
    const first = await lotForRow(stage, rowId, tx);
    if (!first) return refuse(err("That lot has no stock record here any more.", "not_found"));
    for (const k of LOCKS[stage]) await lockLot(tx, k, first.lot, first.godownId);
    /* Read again under the locks: the stock to adjust is what is there now. */
    const lot = (await lotForRow(stage, rowId, tx))!;
    const read = readAdjust(values, lot.stock);
    if (!read.ok) return refuse(fieldErr(read.field, read.error));
    const a = read.value;
    const id = erpId("ADJ");
    const reason = adjustReasonText(a.reasonCode, a.note);
    const day = today();
    const posted = a.dir === "add" ? { entry: await postAddition(tx, lot, a.qty, id, day) } : { transfer: await postRemoval(tx, lot, a.qty, `Stock adjusted ${id} — ${reason}`, ctx.user.id, day) };
    const signed = a.dir === "add" ? a.qty : -a.qty;
    await tx.insert(erpManualAdjustments).values({
      id,
      stage,
      itemId: lot.itemId,
      itemName: lot.item,
      lot: lot.lot,
      godownId: lot.godownId,
      quantity: signed,
      unit: lot.unit,
      stockBefore: lot.stock,
      reasonCode: a.reasonCode,
      note: a.note,
      posted,
      createdById: ctx.user.id,
    });
    made = { id, lot, signed, after: stockAfter(lot.stock, a), reason };
    return okVoid(`${lot.item} · ${lot.lot}: ${nf(lot.stock)} → ${nf(stockAfter(lot.stock, a))} ${lot.unit}`);
  });
  if (res.ok && made) {
    const m = made as { id: string; lot: LotRef; signed: number; after: number; reason: string };
    await erpAudit(ctx, "erp.stock.adjust", "erp_manual_adjustment", m.id, { stock: m.lot.stock }, { stage, item: m.lot.item, lot: m.lot.lot, godown: m.lot.godown, change: m.signed, after: m.after, reason: m.reason });
  }
  return res;
}

async function postAddition(tx: Tx, lot: LotRef, qty: number, id: string, day: string): Promise<string> {
  const base = { sourceType: "adjustment", sourceId: id, entryDate: day, godownId: lot.godownId };
  if (lot.stage === "rm") {
    const entry = erpId("rme");
    await tx.insert(erpRmEntries).values({ id: entry, ...base, rawMaterialId: lot.itemId, lotNo: lot.lot, quantity: qty });
    return entry;
  }
  if (lot.stage === "sfg") {
    const entry = erpId("sfe");
    await tx.insert(erpSfgEntries).values({ id: entry, ...base, formulationId: lot.itemId, lotCode: lot.lot, quantity: qty, remark: "Stock adjusted" });
    return entry;
  }
  if (lot.stage === "fg") {
    /* The lot's SKU and packing come with it, as a transfer in carries them. */
    const [src] = (await tx.execute(
      sql`select sku_id, can_use_id, packing_type from erp_fg_entries where finished_good_id = ${lot.itemId} and lot_code = ${lot.lot} order by posted_at desc limit 1`,
    )) as unknown as { sku_id: string | null; can_use_id: string | null; packing_type: string | null }[];
    const entry = erpId("fge");
    await tx.insert(erpFgEntries).values({ id: entry, ...base, finishedGoodId: lot.itemId, lotCode: lot.lot, quantity: qty, skuId: src?.sku_id ?? null, canUseId: src?.can_use_id ?? null, packingType: src?.packing_type ?? null });
    return entry;
  }
  const entry = erpId("pke");
  await tx.insert(erpPackEntries).values({ id: entry, ...base, skuId: lot.itemId, batchNo: lot.lot, boxes: qty });
  return entry;
}

async function postRemoval(tx: Tx, lot: LotRef, qty: number, remark: string, byId: string, day: string): Promise<string> {
  const r = await postWriteOff(tx, { type: TRANSFER_TYPE[lot.stage], itemId: lot.itemId, item: lot.item, lot: lot.lot, fromGodownId: lot.godownId, qty, ledgerStock: lot.stock, remark, byId, day });
  if (!r.ok) return refuse(r);
  return r.data;
}

/** The stage a stock screen key is. */
export const SCREEN_STAGE: Record<string, AdjustStage> = { rmStock: "rm", sfgStock: "sfg", fgStock: "fg", packStock: "pack" };

