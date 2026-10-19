import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  erpFgEntries,
  erpFgLevels,
  erpGodowns,
  erpPackEntries,
  erpProductPacking,
  erpRawMaterials,
  erpRmEntries,
  erpRmLevels,
  erpSfgEntries,
  erpTransfers,
  products,
  users,
} from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { getConfig } from "@/lib/config/store";
import type { ErpContext } from "../access";
import { erpAudit, erpId, num, stampLine, text, type ScreenModule } from "../server";
import { tooWide, unscoped, windowWhere } from "../window";
import type { ActionSpec, ColSpec, FormSpec, ListRow } from "../ui";
import { nf } from "../ui";
import { fgReorderPercent, rmReorderPercent, rmRequired } from "../engines/production";
import { fgLevelAvailable, fgLots, lockLot, packLots, rmLevelAvailable, rmLots, sfgLots, type Ex } from "../stock";
import { godownField, godownIdByName, godownOptions, inTx, materials, pair, refuse, today, type Tx } from "./common";
import { requisitionForm } from "./purchase-flow";
import { departmentForCategory, requirementDepartmentsFor } from "../departments";
import { levelSuggestions } from "../suggest";
import { moveUnitsForTransfer, trimLooseUnits } from "../units";
import type { LevelSuggestion } from "../engines/production";

/* ---------------------------------------------------------------------------
 * Item transfer (spec §10.1) and re-order levels (§10.2–§10.3).
 *
 * A transfer is one document that both takes stock out of a lot at one godown
 * (read as an outflow, §6.1) and posts the inflow entry at the destination in
 * the same transaction. Transferring to Item Lost Record writes stock off and
 * needs the lostStock power.
 * ------------------------------------------------------------------------- */

const TYPES = ["Purchase", "Semi Finished", "Finish Goods", "FG Packing"] as const;
type ItemType = (typeof TYPES)[number];

type Avail = { item: string; itemId: string; lot: string; godownId: string; godown: string; stock: number };

/** Every lot with stock, by transfer type, in the shape the transfer form and its validation both read. */
async function transferable(ex?: Ex): Promise<Record<ItemType, Avail[]>> {
  const [rm, sfg, fg, pack] = await Promise.all([rmLots(ex), sfgLots(ex), fgLots(ex), packLots(ex)]);
  return {
    Purchase: rm.map((l) => ({ item: l.item, itemId: l.rawMaterialId, lot: l.lotNo, godownId: l.godownId, godown: l.godown, stock: l.stock })),
    "Semi Finished": sfg.map((l) => ({ item: l.product, itemId: l.formulationId, lot: l.lotCode, godownId: l.godownId, godown: l.godown, stock: l.stock })),
    "Finish Goods": fg.map((l) => ({ item: l.product, itemId: l.finishedGoodId, lot: l.lotCode, godownId: l.godownId, godown: l.godown, stock: l.stock })),
    "FG Packing": pack.map((l) => ({ item: l.sku, itemId: l.skuId, lot: l.batchNo, godownId: l.godownId, godown: l.godown, stock: l.stock })),
  };
}

async function transferForm(ctx: ErpContext): Promise<FormSpec> {
  const [froms, tos, stock] = await Promise.all([godownOptions(ctx, { lost: false }), godownOptions(ctx), transferable()]);
  const items: Record<string, string[]> = {};
  const lots: Record<string, string[]> = {};
  const avail: Record<string, number> = {};
  for (const t of TYPES)
    for (const l of stock[t]) {
      if (l.stock <= 0) continue;
      const ik = pair(t, l.godown);
      if (!(items[ik] ??= []).includes(l.item)) items[ik].push(l.item);
      (lots[pair(t, l.godown, l.item)] ??= []).push(l.lot);
      avail[pair(t, l.godown, l.lot)] = l.stock;
    }
  const toOf: Record<string, string[]> = {};
  for (const f of froms) toOf[f.name] = tos.filter((g) => g.name !== f.name).map((g) => g.name);
  return {
    screen: "transfers",
    id: "new",
    title: "New item transfer",
    sub: ctx.powers.has("lostStock") ? "Moving to Item Lost Record writes the stock off." : "Stock moved from one godown to another.",
    submit: "Transfer",
    confirm: "Transfer {item} {qty}",
    init: { date: today(), from: ctx.workingGodown?.name ?? "" },
    /* Which godowns write stock off, by the flag rather than by the name. */
    data: { avail, lost: Object.fromEntries(tos.filter((g) => g.reserved).map((g) => [g.name, 1])) },
    header: [
      { k: "date", l: "Transfer date", t: "date", req: true },
      { k: "type", l: "Item type", t: "select", req: true, opts: [...TYPES] },
      { k: "from", l: "From godown", t: "select", req: true, opts: froms.map((g) => g.name), when: { k: "type", notEmpty: true } },
      { k: "item", l: "Item", t: "select", req: true, optsBy: { by: ["type", "from"], map: items }, when: { k: "from", notEmpty: true } },
      { k: "lot", l: "Lot", t: "select", req: true, optsBy: { by: ["type", "from", "item"], map: lots }, when: { k: "item", notEmpty: true } },
      { k: "avail", l: "Lot available", t: "derived", calc: "transfer.avail" },
      { k: "qty", l: "Transfer quantity", t: "num", req: true, min: 0.001, when: { k: "lot", notEmpty: true } },
      { k: "to", l: "Transfer to godown", t: "select", req: true, optsBy: { by: "from", map: toOf }, when: { k: "qty", notEmpty: true } },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

/** Posts the transfer's inflow at the destination, in the ledger of its stage. */
async function postTransferIn(tx: Tx, t: typeof erpTransfers.$inferSelect) {
  const base = { entryDate: t.transferDate, godownId: t.toGodownId, sourceType: "transfer", sourceId: t.id };
  if (t.itemType === "Purchase") {
    await tx.insert(erpRmEntries).values({ id: erpId("rme"), ...base, rawMaterialId: t.itemId, lotNo: t.lotNo, quantity: t.quantity });
  } else if (t.itemType === "Semi Finished") {
    await tx.insert(erpSfgEntries).values({ id: erpId("sfe"), ...base, formulationId: t.itemId, lotCode: t.lotNo, quantity: t.quantity });
  } else if (t.itemType === "Finish Goods") {
    /* A transfer carries the FG product's SKU and packing from the lot it came from (spec §8.2). */
    const [src] = await tx
      .select({ sku: erpFgEntries.skuId, canUse: erpFgEntries.canUseId, packing: erpFgEntries.packingType })
      .from(erpFgEntries)
      .where(eq(erpFgEntries.finishedGoodId, t.itemId))
      .orderBy(desc(erpFgEntries.postedAt))
      .limit(1);
    await tx.insert(erpFgEntries).values({
      id: erpId("fge"),
      ...base,
      finishedGoodId: t.itemId,
      lotCode: t.lotNo,
      quantity: t.quantity,
      skuId: src?.sku ?? null,
      canUseId: src?.canUse ?? null,
      packingType: src?.packing ?? null,
    });
  } else {
    await tx.insert(erpPackEntries).values({ id: erpId("pke"), ...base, skuId: t.itemId, batchNo: t.lotNo, boxes: t.quantity });
  }
}

/**
 * Writes a quantity of one lot off to Item Lost Record: the transfer, its
 * inflow there, and — for boxes and labelled cans — the units going with it,
 * exactly as a transfer to that godown made on the form would. The caller has
 * locked the lot and checked it holds the quantity.
 */
export async function postWriteOff(
  tx: Tx,
  w: { type: "Purchase" | "Semi Finished" | "Finish Goods" | "FG Packing"; itemId: string; item: string; lot: string; fromGodownId: string; qty: number; ledgerStock: number; remark: string; byId: string; day?: string },
): Promise<Result<string>> {
  const [lost] = await tx.select({ id: erpGodowns.id }).from(erpGodowns).where(eq(erpGodowns.reserved, true)).limit(1);
  if (!lost) return err("There is no Item Lost Record godown to write the stock off to.", "rule_violation");
  const id = erpId("TRF");
  const [t] = await tx
    .insert(erpTransfers)
    .values({ id, transferDate: w.day ?? today(), itemType: w.type, fromGodownId: w.fromGodownId, toGodownId: lost.id, itemId: w.itemId, itemName: w.item, lotNo: w.lot, quantity: w.qty, remark: w.remark, createdById: w.byId })
    .returning();
  await postTransferIn(tx, t);
  if (w.type === "FG Packing" || w.type === "Finish Goods") {
    const moved = await moveUnitsForTransfer(tx, { lotFrom: w.type === "FG Packing" ? "pack" : "fg", lotCode: w.lot, fromGodownId: w.fromGodownId, toGodownId: lost.id, qty: w.qty, lost: true, transferId: id, byId: w.byId });
    if (w.type === "Finish Goods" && moved < Math.floor(w.qty))
      await trimLooseUnits(tx, { lotCode: w.lot, finishedGoodId: w.itemId, godownId: w.fromGodownId, ledgerStock: w.ledgerStock - w.qty, byId: w.byId, why: `Stock adjusted (${id})` });
  }
  return ok(id);
}

/* Transfers are a register: read by transfer date, never the whole history (`window.ts`). */
const TRANSFER_WINDOW = { label: "Transfer date", default: "month" } as const;

const transfers: ScreenModule = {
  key: "transfers",
  window: TRANSFER_WINDOW,
  async load(ctx, s) {
    const sc = s ?? unscoped();
    const where = windowWhere(sql`${erpTransfers.transferDate}`, sql`${erpTransfers.id}`, sc);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(erpTransfers).where(where);
    const wide = tooWide(Number(n), sc);
    const [rows, gds] = await Promise.all([
      db.select({ t: erpTransfers, by: users.name }).from(erpTransfers).leftJoin(users, eq(users.id, erpTransfers.createdById)).where(wide ? sql`false` : where).orderBy(desc(erpTransfers.transferDate), asc(erpTransfers.itemType)),
      db.select({ id: erpGodowns.id, name: erpGodowns.name, reserved: erpGodowns.reserved }).from(erpGodowns),
    ]);
    const g = new Map(gds.map((x) => [x.id, x]));
    const now = today();
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "type", l: "Item type", t: "s" },
      { k: "from", l: "From", t: "t" },
      { k: "item", l: "Item", t: "b" },
      { k: "lot", l: "Lot", t: "mono" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "to", l: "To", t: "t" },
      { k: "remark", l: "Remark", t: "t" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "transfers",
        cols,
        hidden: [],
        groups: ["date", "from"],
        godownKey: "from",
        download: true,
        newForm: await transferForm(ctx),
        newLabel: "New transfer",
        noDataLine: "No transfers yet.",
      },
      tooWide: wide,
      rows: rows.map((x): ListRow => {
        const from = g.get(x.t.fromGodownId);
        const to = g.get(x.t.toGodownId);
        const flags: string[] = [];
        if (x.t.transferDate === now) flags.push("today");
        if (from?.reserved || to?.reserved) flags.push("lost");
        return {
          id: x.t.id,
          v: { date: x.t.transferDate, type: x.t.itemType, from: from?.name ?? "", item: x.t.itemName, lot: x.t.lotNo, qty: x.t.quantity, to: to?.name ?? "", remark: x.t.remark },
          flags,
          title: `${x.t.itemName} · ${nf(x.t.quantity)}`,
          header: `${from?.name ?? ""} → ${to?.name ?? ""} · lot ${x.t.lotNo}`,
          by: stampLine(x.by, x.t.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const type = text(h.type) as ItemType | null;
      if (!type || !TYPES.includes(type)) return fieldErr("type", "Item type is required");
      const fromId = await godownIdByName(text(h.from));
      if (!fromId) return fieldErr("from", "From godown is required");
      const toId = await godownIdByName(text(h.to));
      if (!toId) return fieldErr("to", "Transfer to godown is required");
      if (toId === fromId) return fieldErr("to", "You Selected The Same Location, Change To Location");
      const [toG] = await db.select().from(erpGodowns).where(eq(erpGodowns.id, toId));
      const [fromG] = await db.select().from(erpGodowns).where(eq(erpGodowns.id, fromId));
      if (fromG?.reserved) return fieldErr("from", "Stock is never moved out of Item Lost Record");
      if (toG?.reserved && !ctx.powers.has("lostStock")) return fieldErr("to", "Writing stock off to Item Lost Record needs the lost-stock power");
      if (toG?.status !== "active") return fieldErr("to", "That godown is not active");
      const item = text(h.item);
      const lot = text(h.lot);
      if (!item) return fieldErr("item", "Item is required");
      if (!lot) return fieldErr("lot", "Lot is required");
      const qty = num(h.qty);
      if (qty == null || qty <= 0) return fieldErr("qty", "Select Correct Quantity!");
      let id = "";
      const res = await inTx(async (tx) => {
        await lockLot(tx, type, lot, fromId);
        const src = (await transferable(tx))[type].find((l) => l.lot === lot && l.godownId === fromId && l.item === item);
        if (!src) return refuse(fieldErr("lot", "Pick a lot of this item with stock at this godown"));
        if (qty > src.stock + 1e-9) return refuse(fieldErr("qty", "Select Correct Quantity!"));
        id = erpId("TRF");
        const [t] = await tx
          .insert(erpTransfers)
          .values({ id, transferDate: text(h.date) ?? today(), itemType: type, fromGodownId: fromId, toGodownId: toId, itemId: src.itemId, itemName: item, lotNo: lot, quantity: qty, remark: text(h.remark), createdById: ctx.user.id })
          .returning();
        await postTransferIn(tx, t);
        /* The boxes and labelled cans go with the stock: the lowest-numbered still on the shelf. */
        if (type === "FG Packing" || type === "Finish Goods") {
          const moved = await moveUnitsForTransfer(tx, { lotFrom: type === "FG Packing" ? "pack" : "fg", lotCode: lot, fromGodownId: fromId, toGodownId: toId, qty, lost: !!toG?.reserved, transferId: id, byId: ctx.user.id });
          if (type === "Finish Goods" && moved < Math.floor(qty))
            await trimLooseUnits(tx, { lotCode: lot, finishedGoodId: src.itemId, godownId: fromId, ledgerStock: src.stock - qty, byId: ctx.user.id, why: `Transfer ${id}` });
        }
        return okVoid(toG?.reserved ? `${nf(qty)} of ${item} written off` : `Transferred ${nf(qty)} of ${item} to ${toG?.name}`);
      });
      if (!res.ok) return res;
      await erpAudit(ctx, toG?.reserved ? "erp.transfer.writeOff" : "erp.transfer.create", "erp_transfer", id, null, { type, item, lot, qty, from: fromG?.name, to: toG?.name });
      return res;
    },
  },
};

/* =============================================================== levels */

const LEVEL_TYPES = ["Chemical", "Can", "Drum", "Box", "Stationary"];

async function rmLevelForm(ctx: ErpContext, id?: string): Promise<FormSpec | null> {
  const [gds, mats] = await Promise.all([godownOptions(ctx, { lost: false }), materials()]);
  const byType: Record<string, string[]> = {};
  mats.forEach((m) => (byType[m.materialType] ??= []).push(m.name));
  let init: Record<string, string> = { godown: ctx.workingGodown?.name ?? "", status: "Follow" };
  if (id) {
    const [l] = await db
      .select({ l: erpRmLevels, item: erpRawMaterials.name, godown: erpGodowns.name })
      .from(erpRmLevels)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRmLevels.rawMaterialId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpRmLevels.godownId))
      .where(eq(erpRmLevels.id, id));
    if (!l) return null;
    init = { godown: l.godown, type: l.l.materialType, item: l.item, min: String(l.l.minQty), max: String(l.l.maxQty), status: l.l.status };
  }
  return {
    screen: "rmLevels",
    id: id ? "edit" : "new",
    recordId: id,
    title: id ? "Edit raw-material level" : "New raw-material level",
    sub: "One level per item per godown.",
    submit: id ? "Save level" : "Add level",
    init,
    header: [
      godownField(gds, { readOnly: !!id }),
      { k: "type", l: "Material type", t: "select", req: true, opts: LEVEL_TYPES, readOnly: !!id },
      { k: "item", l: "Raw item", t: "select", req: true, optsBy: { by: "type", map: byType }, when: { k: "type", notEmpty: true }, readOnly: !!id },
      { k: "min", l: "Minimum quantity", t: "num", req: true, min: 0 },
      { k: "max", l: "Maximum quantity", t: "num", req: true, min: 0 },
      { k: "status", l: "Status", t: "select", req: true, opts: ["Follow", "UnFollow"] },
    ],
  };
}

type RmPlan = {
  min: number;
  max: number;
  statMin: number;
  statMax: number;
  baseDaily: number;
  basis: string;
  notes: string[];
  confidence: string;
  aiFactor: number;
  aiReason: string | null;
  monthFactor: number[];
  weekOfMonthFactor: number[];
};

type RmLevelRow = { id: string; godown: string; godownId: string; type: string; item: string; itemId: string; min: number; max: number; status: string; available: number | null; required: number | null; pct: number | null; by: string | null; updatedAt: Date; suggestion: LevelSuggestion | null; auto: boolean; plan: RmPlan | null; plannedAt: Date | null; daysCover: number | null };

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The planner's figures as a suggestion the ordinary "Apply suggestion" can set. */
function planSuggestion(p: RmPlan | null): LevelSuggestion | null {
  if (!p) return null;
  return { min: p.min, max: p.max, perDay: p.baseDaily, recentPerDay: p.baseDaily, basis: p.basis, swing: p.notes.length ? p.notes.join(" ") : null };
}

async function rmLevelRows(): Promise<RmLevelRow[]> {
  const [rows, avail, suggest] = await Promise.all([
    db
      .select({ l: erpRmLevels, item: erpRawMaterials.name, unit: erpRawMaterials.unit, godown: erpGodowns.name, by: users.name })
      .from(erpRmLevels)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRmLevels.rawMaterialId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpRmLevels.godownId))
      .leftJoin(users, eq(users.id, erpRmLevels.updatedById)),
    rmLevelAvailable(),
    levelSuggestions(),
  ]);
  return rows.map((x) => {
    const available = avail(x.l.materialType, x.l.rawMaterialId, x.l.godownId);
    const plan = (x.l.plan as RmPlan | null) ?? null;
    /* The planner's figures, where it has read this item; the 90-day suggestion otherwise. */
    const suggestion = planSuggestion(plan) ?? suggest.rm(x.l.materialType, x.l.rawMaterialId, x.l.godownId, x.unit === "Unit" ? "pcs" : "L");
    return {
      id: x.l.id,
      godown: x.godown,
      godownId: x.l.godownId,
      type: x.l.materialType,
      item: x.item,
      itemId: x.l.rawMaterialId,
      min: x.l.minQty,
      max: x.l.maxQty,
      status: x.l.status,
      available,
      required: rmRequired(available, x.l.maxQty),
      pct: rmReorderPercent(available, x.l.minQty, x.l.maxQty),
      by: x.by,
      updatedAt: x.l.updatedAt,
      suggestion,
      auto: x.l.autoManaged,
      plan,
      plannedAt: x.l.plannedAt,
      daysCover: plan && plan.baseDaily > 0 && available != null ? Math.round((available / plan.baseDaily) * 10) / 10 : null,
    };
  });
}

/**
 * Followed levels that need buying (spec §10.2 "Re-Order Raw Items"): stock
 * under the MINIMUM, bought up to the maximum. It used to fire under the
 * maximum, which with planned levels (a week and a half to hold, a week on
 * top) would list nearly every item every day — the screen, the flag and the
 * alert all said "below minimum" and now mean it.
 */
export function rmBelowMin(r: { status: string; available: number | null; min: number; required: number | null }): boolean {
  return r.status === "Follow" && r.available != null && r.available < r.min && (r.required ?? 0) > 0;
}

export async function rmReorderRows(): Promise<RmLevelRow[]> {
  return (await rmLevelRows()).filter(rmBelowMin);
}

async function saveRmLevel(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  const min = num(h.min);
  const max = num(h.max);
  if (min == null || min < 0) return fieldErr("min", "Minimum quantity is required");
  if (max == null || max < 0) return fieldErr("max", "Maximum quantity is required");
  if (max < min) return fieldErr("max", "The maximum is below the minimum");
  const status = text(h.status) === "UnFollow" ? "UnFollow" : "Follow";
  if (id) {
    const [before] = await db.select().from(erpRmLevels).where(eq(erpRmLevels.id, id));
    if (!before) return err("That level no longer exists.", "not_found");
    /* A person setting the figures takes the level off the planner: it never undoes a decision. */
    const moved = before.minQty !== min || before.maxQty !== max;
    await db.update(erpRmLevels).set({ minQty: min, maxQty: max, status, updatedAt: new Date(), updatedById: ctx.user.id, ...(moved ? { autoManaged: false } : {}) }).where(eq(erpRmLevels.id, id));
    await erpAudit(ctx, "erp.rmLevel.edit", "erp_rm_level", id, before, { min, max, status, ...(moved && before.autoManaged ? { autoManaged: false } : {}) });
    return okVoid("Level saved");
  }
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const type = text(h.type);
  const [m] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.name, text(h.item) ?? ""));
  if (!m || !type) return fieldErr("item", "Raw item is required");
  const newId = erpId("rmmq");
  const inserted = await db
    .insert(erpRmLevels)
    .values({ id: newId, godownId, materialType: type, rawMaterialId: m.id, minQty: min, maxQty: max, status, updatedById: ctx.user.id })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return fieldErr("item", "Duplicate Entry!");
  await erpAudit(ctx, "erp.rmLevel.create", "erp_rm_level", newId, null, { item: m.name, min, max });
  return okVoid(`Level set for ${m.name}`);
}

/** What the drawer says about how a level was worked out. */
function planFields(r: RmLevelRow): { l: string; v: string; der: boolean }[] {
  const p = r.plan;
  if (!p) {
    return r.suggestion
      ? [{ l: "Suggestion basis", v: r.suggestion.basis, der: true }, ...(r.suggestion.swing ? [{ l: "Recent use", v: r.suggestion.swing, der: true }] : [])]
      : [{ l: "Plan", v: "No use or purchases recorded for this item at this godown yet.", der: true }];
  }
  const seasons = p.monthFactor.map((f, i) => `${MONTH_SHORT[i]} ${f.toFixed(2)}`).join(" · ");
  const weeks = p.weekOfMonthFactor.map((f, i) => `${["1–7", "8–14", "15–21", "22–28", "29–31"][i]}: ${f.toFixed(2)}`).join(" · ");
  return [
    { l: "Set by", v: r.auto ? "The planner, every night" : "By hand — the planner's figures are shown beside it and never applied", der: true },
    { l: "How it was worked out", v: p.basis, der: true },
    { l: "Statistical level", v: `min ${p.statMin} · max ${p.statMax} (${p.confidence} confidence)`, der: true },
    ...(p.aiReason ? [{ l: p.aiFactor === 1 ? "AI review" : `AI review (×${p.aiFactor})`, v: p.aiReason, der: true }] : []),
    ...(p.notes.length ? [{ l: "Pattern", v: p.notes.join(" "), der: true }] : []),
    { l: "Month factors", v: seasons, der: true },
    { l: "Week of month", v: weeks, der: true },
    ...(r.daysCover != null ? [{ l: "Days of stock now", v: `${r.daysCover} days at today's rate`, der: true }] : []),
    ...(r.plannedAt ? [{ l: "Planned", v: stampLine(null, r.plannedAt).replace(/^Created/, "Planned"), der: true }] : []),
  ];
}

function rmLevelList(key: "rmLevels" | "reorderRm"): ScreenModule {
  return {
    key,
    async load(ctx) {
      const reorder = key === "reorderRm";
      const [rows, cfg] = await Promise.all([reorder ? rmReorderRows() : rmLevelRows(), getConfig()]);
      const planCover = cfg["erp.levels.coverDays"];
      const cols: ColSpec[] = [
        { k: "item", l: "Item", t: "b" },
        ...(reorder ? [] : ([{ k: "required", l: "Required", t: "n" }] as ColSpec[])),
        { k: "available", l: "Available", t: "n" },
        { k: "days", l: "Days of stock", t: "n" },
        { k: "pct", l: "Re-order %", t: "n" },
        { k: "min", l: "Min", t: "n" },
        ...(reorder ? [] : ([{ k: "max", l: "Max", t: "n" }, { k: "managed", l: "Set by", t: "s" }, { k: "status", l: "Status", t: "s" }] as ColSpec[])),
        ...(reorder ? [] : ([{ k: "sMin", l: "Planned min", t: "n" }, { k: "sMax", l: "Planned max", t: "n" }] as ColSpec[])),
        { k: "godown", l: "Godown", t: "t" },
        { k: "type", l: "Material type", t: "s" },
        { k: "f", l: "Flags", t: "f" },
      ];
      return {
        spec: {
          screen: key,
          cols,
          hidden: [],
          groups: ["godown", "type"],
          godownKey: "godown",
          sortDefault: ["pct", 1],
          readOnly: reorder,
          bulk: reorder ? undefined : [{ id: "apply", l: "Apply suggestions", confirm: "Set every selected level to its suggested minimum and maximum?" }],
          newForm: reorder ? undefined : ((await rmLevelForm(ctx)) ?? undefined),
          newLabel: "New level",
          tools: reorder
            ? undefined
            : [
                {
                  id: "planNow",
                  l: "Plan levels now",
                  confirm: `Work out every raw material's level again from its use and purchase history, so each godown holds ${planCover} days of stock? Levels somebody set by hand keep their figures.`,
                },
              ],
          noDataLine: reorder ? "Nothing to re-order. Every followed item is at or above its level." : "No levels set yet.",
        },
        rows: rows
          .sort((a, b) => (a.pct ?? Infinity) - (b.pct ?? Infinity))
          .map((r): ListRow => {
            const actions: ActionSpec[] = [];
            /* Topping up is offered whenever there is room under the maximum; only under the minimum is it flagged. */
            if (reorder || (r.required ?? 0) > 0)
              actions.push({ id: "raise", l: "Raise requirement", primary: true, loadsForm: true });
            if (!reorder && !r.auto && r.plan)
              actions.push({ id: "autoOn", l: "Let the planner keep it", confirm: `Hand ${r.item} at ${r.godown} to the planner? It is set to min ${r.plan.min}, max ${r.plan.max} now and re-planned every night.` });
            else if (!reorder && !r.auto && r.suggestion && (r.suggestion.min !== r.min || r.suggestion.max !== r.max))
              actions.push({ id: "apply", l: "Apply suggestion", confirm: `Set ${r.item} at ${r.godown} to min ${r.suggestion.min}, max ${r.suggestion.max}? ${r.suggestion.basis}` });
            if (!reorder) {
              actions.push({ id: "edit", l: "Edit", loadsForm: true });
              actions.push({ id: "copy", l: "Add another", loadsForm: true });
              actions.push({ id: "delete", l: "Delete", confirm: `Remove the level for ${r.item} at ${r.godown}?` });
            }
            return {
              id: r.id,
              v: { item: r.item, required: r.required, available: r.available, days: r.daysCover, pct: r.pct, min: r.min, max: r.max, managed: r.auto ? "Planner" : "By hand", status: r.status, godown: r.godown, type: r.type, sMin: r.suggestion?.min ?? null, sMax: r.suggestion?.max ?? null },
              fields: planFields(r),
              flags: [
                ...(rmBelowMin(r) ? ["below"] : []),
                ...(r.auto ? ["autoLevel"] : []),
                ...(r.plan && r.plan.aiFactor !== 1 ? ["aiAdjusted"] : []),
              ],
              title: r.item,
              header: `${r.godown} · ${r.type}${r.required ? ` · buy ${nf(r.required)} to reach the maximum` : ""}`,
              actions,
              by: stampLine(r.by, r.updatedAt).replace(/^Created/, "Updated"),
            };
          }),
      };
    },
    formLoaders: {
      async raise(ctx, id) {
        const [r] = (await rmLevelRows()).filter((x) => x.id === id);
        if (!r) return null;
        return requisitionForm(ctx, { godown: r.godown, type: r.type, item: r.item, required: r.required == null ? "" : String(r.required), priority: "For Stock", department: reorderDepartment(ctx, r.type) });
      },
      ...(key === "rmLevels"
        ? {
            edit: (ctx: ErpContext, id: string) => rmLevelForm(ctx, id),
            async copy(ctx: ErpContext, id: string) {
              const f = await rmLevelForm(ctx, id);
              const base = await rmLevelForm(ctx);
              return f && base ? { ...base, title: "Add another level", init: { ...base.init, godown: f.init?.godown ?? "", type: f.init?.type ?? "" } } : null;
            },
          }
        : {}),
    },
    forms: key === "rmLevels" ? { new: (ctx, h) => saveRmLevel(ctx, h), edit: (ctx, h, _l, id) => saveRmLevel(ctx, h, id) } : undefined,
    tools:
      key === "rmLevels"
        ? {
            async planNow(ctx) {
              const { runLevelPlanner, plannerLine } = await import("../level-planner");
              const r = await runLevelPlanner({ force: true, userId: ctx.user.id });
              if (r.skipped) return err(`Not planned: ${r.skipped}.`, "rule_violation");
              return okVoid(plannerLine(r));
            },
          }
        : undefined,
    bulk: key === "rmLevels" ? { apply: (ctx, ids) => applyRm(ctx, ids) } : undefined,
    actions:
      key === "rmLevels"
        ? {
            apply: (ctx, id) => applyRm(ctx, [id]),
            async autoOn(ctx, id) {
              const [l] = await db.select().from(erpRmLevels).where(eq(erpRmLevels.id, id));
              if (!l) return err("That level no longer exists.", "not_found");
              const p = (l.plan as RmPlan | null) ?? null;
              if (!p) return err("The planner has not read this item yet. Use “Plan levels now” first.", "rule_violation");
              await db.update(erpRmLevels).set({ autoManaged: true, minQty: p.min, maxQty: p.max, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRmLevels.id, id));
              await erpAudit(ctx, "erp.rmLevel.autoOn", "erp_rm_level", id, l, { min: p.min, max: p.max, autoManaged: true });
              return okVoid("The planner keeps this level now");
            },
            async delete(ctx, id) {
              const [before] = await db.select().from(erpRmLevels).where(eq(erpRmLevels.id, id));
              if (!before) return err("That level no longer exists.", "not_found");
              await db.delete(erpRmLevels).where(eq(erpRmLevels.id, id));
              await erpAudit(ctx, "erp.rmLevel.delete", "erp_rm_level", id, before, null);
              return okVoid("Level removed");
            },
          }
        : undefined,
  };
}

/** AI-7: sets levels to their suggestion. Nothing moves without this press. */
async function applyRm(ctx: ErpContext, ids: string[]): Promise<Result<unknown>> {
  const rows = (await rmLevelRows()).filter((r) => ids.includes(r.id) && r.suggestion);
  if (!rows.length) return err("No suggestion to apply: no use was recorded for these items.", "rule_violation");
  for (const r of rows) await db.update(erpRmLevels).set({ minQty: r.suggestion!.min, maxQty: r.suggestion!.max, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRmLevels.id, r.id));
  await erpAudit(ctx, "erp.rmLevel.applySuggestion", "erp_rm_level", rows.map((r) => r.id).join(","), null, Object.fromEntries(rows.map((r) => [r.id, r.suggestion])));
  return okVoid(`${rows.length} level${rows.length === 1 ? "" : "s"} set to the suggestion`);
}

async function applyFg(ctx: ErpContext, ids: string[]): Promise<Result<unknown>> {
  const rows = (await fgLevelRows()).filter((r) => ids.includes(r.id) && r.suggestion);
  if (!rows.length) return err("No suggestion to apply: nothing was dispatched for these SKUs.", "rule_violation");
  for (const r of rows) await db.update(erpFgLevels).set({ minQty: r.suggestion!.min, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpFgLevels.id, r.id));
  await erpAudit(ctx, "erp.fgLevel.applySuggestion", "erp_fg_level", rows.map((r) => r.id).join(","), null, Object.fromEntries(rows.map((r) => [r.id, r.suggestion])));
  return okVoid(`${rows.length} level${rows.length === 1 ? "" : "s"} set to the suggestion`);
}

/* ---- finished goods ---- */

async function fgLevelForm(ctx: ErpContext, id?: string): Promise<FormSpec | null> {
  const [gds, skus] = await Promise.all([
    godownOptions(ctx, { lost: false }),
    db.select({ name: products.name }).from(products).where(eq(products.active, true)).orderBy(asc(products.name)),
  ]);
  let init: Record<string, string> = { godown: ctx.workingGodown?.name ?? "", status: "Follow" };
  if (id) {
    const [l] = await db
      .select({ l: erpFgLevels, sku: products.name, godown: erpGodowns.name })
      .from(erpFgLevels)
      .innerJoin(products, eq(products.id, erpFgLevels.productId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpFgLevels.godownId))
      .where(eq(erpFgLevels.id, id));
    if (!l) return null;
    init = { godown: l.godown, sku: l.sku, min: String(l.l.minQty), status: l.l.status };
  }
  return {
    screen: "fgLevels",
    id: id ? "edit" : "new",
    recordId: id,
    title: id ? "Edit finished-goods level" : "New finished-goods level",
    sub: "A loose SKU is counted in cans from FG stock; a boxed SKU in boxes from packing stock.",
    submit: id ? "Save level" : "Add level",
    init,
    header: [
      godownField(gds, { readOnly: !!id }),
      { k: "sku", l: "Product (SKU)", t: "select", req: true, opts: skus.map((s) => s.name), readOnly: !!id },
      { k: "min", l: "Minimum quantity", t: "num", req: true, min: 0 },
      { k: "status", l: "Status", t: "select", req: true, opts: ["Follow", "UnFollow"] },
    ],
  };
}

type FgLevelRow = { id: string; godown: string; sku: string; kind: string; min: number; status: string; available: number; pct: number | null; by: string | null; updatedAt: Date; suggestion: LevelSuggestion | null };

async function fgLevelRows(): Promise<FgLevelRow[]> {
  const [rows, avail, suggest] = await Promise.all([
    db
      .select({ l: erpFgLevels, sku: products.name, godown: erpGodowns.name, empty: erpProductPacking.emptyBoxesRequired, by: users.name })
      .from(erpFgLevels)
      .innerJoin(products, eq(products.id, erpFgLevels.productId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpFgLevels.godownId))
      .leftJoin(erpProductPacking, eq(erpProductPacking.productId, erpFgLevels.productId))
      .leftJoin(users, eq(users.id, erpFgLevels.updatedById)),
    fgLevelAvailable(),
    levelSuggestions(),
  ]);
  return rows.map((x) => {
    const boxed = (x.empty ?? 0) > 0;
    const suggestion = suggest.fg(x.l.productId, x.l.godownId, boxed);
    const available = avail(x.l.productId, boxed, x.l.godownId);
    return {
      id: x.l.id,
      godown: x.godown,
      sku: x.sku,
      kind: boxed ? "FG Packing Inventory" : "Finish Goods Inventory",
      min: x.l.minQty,
      status: x.l.status,
      available,
      pct: fgReorderPercent(available, x.l.minQty),
      by: x.by,
      updatedAt: x.l.updatedAt,
      suggestion,
    };
  });
}

/** Followed SKUs below their minimum (spec §10.3 "Re-Order Finish Goods"). */
export async function fgReorderRows(): Promise<FgLevelRow[]> {
  return (await fgLevelRows()).filter((r) => r.status === "Follow" && r.min > r.available);
}

async function saveFgLevel(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  const min = num(h.min);
  if (min == null || min < 0) return fieldErr("min", "Minimum quantity is required");
  const status = text(h.status) === "UnFollow" ? "UnFollow" : "Follow";
  if (id) {
    const [before] = await db.select().from(erpFgLevels).where(eq(erpFgLevels.id, id));
    if (!before) return err("That level no longer exists.", "not_found");
    await db.update(erpFgLevels).set({ minQty: min, status, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpFgLevels.id, id));
    await erpAudit(ctx, "erp.fgLevel.edit", "erp_fg_level", id, before, { min, status });
    return okVoid("Level saved");
  }
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const [p] = await db.select({ id: products.id, name: products.name }).from(products).where(eq(products.name, text(h.sku) ?? ""));
  if (!p) return fieldErr("sku", "Product is required");
  const newId = erpId("fgmq");
  const inserted = await db.insert(erpFgLevels).values({ id: newId, godownId, productId: p.id, minQty: min, status, updatedById: ctx.user.id }).onConflictDoNothing().returning();
  if (!inserted.length) return fieldErr("sku", "Duplicate Entry!");
  await erpAudit(ctx, "erp.fgLevel.create", "erp_fg_level", newId, null, { sku: p.name, min });
  return okVoid(`Level set for ${p.name}`);
}

function fgLevelList(key: "fgLevels" | "reorderFg"): ScreenModule {
  return {
    key,
    async load(ctx) {
      const reorder = key === "reorderFg";
      const rows = reorder ? await fgReorderRows() : await fgLevelRows();
      const cols: ColSpec[] = reorder
        ? [
            { k: "pct", l: "Re-order %", t: "n" },
            { k: "sku", l: "Product", t: "b", w: 260 },
            { k: "available", l: "Available", t: "n" },
            { k: "godown", l: "Godown", t: "t" },
            { k: "kind", l: "Type", t: "s" },
            { k: "min", l: "Min", t: "n" },
            { k: "f", l: "Flags", t: "f" },
          ]
        : [
            { k: "sku", l: "Product", t: "b", w: 260 },
            { k: "min", l: "Min", t: "n" },
            { k: "available", l: "Available", t: "n" },
            { k: "godown", l: "Godown", t: "t" },
            { k: "pct", l: "Re-order %", t: "n" },
            { k: "status", l: "Status", t: "s" },
            { k: "sMin", l: "Suggested min", t: "n" },
            { k: "kind", l: "Type", t: "s" },
            { k: "f", l: "Flags", t: "f" },
          ];
      return {
        spec: {
          screen: key,
          cols,
          hidden: [],
          groups: reorder ? ["godown", "kind"] : ["godown", "status", "kind"],
          godownKey: "godown",
          sortDefault: reorder ? ["pct", -1] : ["sku", 1],
          readOnly: reorder,
          bulk: reorder ? undefined : [{ id: "apply", l: "Apply suggestions", confirm: "Set every selected minimum to its suggestion?" }],
          newForm: reorder ? undefined : ((await fgLevelForm(ctx)) ?? undefined),
          newLabel: "New level",
          noDataLine: reorder ? "Nothing to re-order. Every followed SKU is at or above its minimum." : "No levels set yet.",
        },
        rows: rows.map((r): ListRow => ({
          id: r.id,
          v: { sku: r.sku, min: r.min, available: r.available, godown: r.godown, pct: r.pct, status: r.status, kind: r.kind, sMin: r.suggestion?.min ?? null },
          fields: r.suggestion ? [{ l: "Suggestion basis", v: r.suggestion.basis, der: true }, ...(r.suggestion.swing ? [{ l: "Recent use", v: r.suggestion.swing, der: true }] : [])] : [{ l: "Suggestion", v: "Nothing dispatched from this godown in the look-back yet.", der: true }],
          flags: r.status === "Follow" && r.min > r.available ? ["below"] : [],
          title: r.sku,
          header: `${r.godown} · ${nf(r.available)} of ${nf(r.min)} ${r.kind === "FG Packing Inventory" ? "boxes" : "cans"}`,
          actions: reorder
            ? []
            : [
                ...(r.suggestion && r.suggestion.min !== r.min ? [{ id: "apply", l: "Apply suggestion", confirm: `Set the minimum for ${r.sku} at ${r.godown} to ${r.suggestion.min}? ${r.suggestion.basis}` }] : []),
                { id: "edit", l: "Edit", loadsForm: true },
                { id: "copy", l: "Add another", loadsForm: true },
                { id: "delete", l: "Delete", confirm: `Remove the level for ${r.sku} at ${r.godown}?` },
              ],
          by: stampLine(r.by, r.updatedAt).replace(/^Created/, "Updated"),
        })),
      };
    },
    formLoaders:
      key === "fgLevels"
        ? {
            edit: (ctx, id) => fgLevelForm(ctx, id),
            async copy(ctx, id) {
              const f = await fgLevelForm(ctx, id);
              const base = await fgLevelForm(ctx);
              return f && base ? { ...base, title: "Add another level", init: { ...base.init, godown: f.init?.godown ?? "" } } : null;
            },
          }
        : undefined,
    forms: key === "fgLevels" ? { new: (ctx, h) => saveFgLevel(ctx, h), edit: (ctx, h, _l, id) => saveFgLevel(ctx, h, id) } : undefined,
    bulk: key === "fgLevels" ? { apply: (ctx, ids) => applyFg(ctx, ids) } : undefined,
    actions:
      key === "fgLevels"
        ? {
            apply: (ctx, id) => applyFg(ctx, [id]),
            async delete(ctx, id) {
              const [before] = await db.select().from(erpFgLevels).where(eq(erpFgLevels.id, id));
              if (!before) return err("That level no longer exists.", "not_found");
              await db.delete(erpFgLevels).where(eq(erpFgLevels.id, id));
              await erpAudit(ctx, "erp.fgLevel.delete", "erp_fg_level", id, before, null);
              return okVoid("Level removed");
            },
          }
        : undefined,
  };
}

export const MOVEMENT_SCREENS: ScreenModule[] = [transfers, rmLevelList("rmLevels"), fgLevelList("fgLevels"), rmLevelList("reorderRm"), fgLevelList("reorderFg")];

/** The team a re-order from the store is raised under: the one that asks for the category, or the person's own where they raise for one team only. */
function reorderDepartment(ctx: ErpContext, materialType: string): string {
  const offered = requirementDepartmentsFor(ctx.department);
  return offered.length === 1 ? offered[0] : departmentForCategory(materialType);
}
