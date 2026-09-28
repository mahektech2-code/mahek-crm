import "server-only";
import { getConfig } from "@/lib/config/store";
import { recipeMap } from "./recipes";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  erpFgEntries,
  erpFgFills,
  erpGodowns,
  erpPackEntries,
  erpPackLines,
  erpProductPacking,
  erpRawMaterials,
  erpSfgEntries,
  erpSfgLines,
  finishedGoods,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpAudit, erpId, int, nextNumber, num, stampLine, text, visibleCols, withoutHidden, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow } from "../ui";
import { inr, nf } from "../ui";
import {
  batchState,
  boxFigures,
  fgLotCode,
  fillFigures,
  fillRefusal,
  packBatchNo,
  sfgLotCode,
  sfgTotalUse,
  sfgYield,
} from "../engines/production";
import {
  fgLots,
  fgLotStock,
  fgRates,
  lockLot,
  packBatchCosting,
  packLots,
  rmLevelAvailable,
  rmLots,
  rmLotStock,
  sfgLots,
  sfgLotStock,
  sfgRates,
  type Ex,
} from "../stock";
import { godownIdByName, godownOptions, has, inTx, pair, refuse, today, type Col, type Tx } from "./common";

/* ---------------------------------------------------------------------------
 * Production (spec §7–§9): semi-finished batches from raw-material lots, FG
 * filling from SFG lots, packing cans into boxes — and the stock and log
 * screens of each stage.
 *
 * Every consuming save locks the lot it spends, reads its stock inside the
 * same transaction and refuses in the source's words, so two people cannot
 * both spend the last litre. Each document posts its stage's entry itself,
 * once, and the entry follows the document through every edit.
 * ------------------------------------------------------------------------- */

async function formulationByName(name: string | null) {
  if (!name) return null;
  const [f] = await db.select().from(productFormulations).where(eq(productFormulations.name, name));
  return f ?? null;
}

async function godownName(id: string): Promise<string> {
  const [g] = await db.select({ name: erpGodowns.name }).from(erpGodowns).where(eq(erpGodowns.id, id));
  return g?.name ?? "";
}

/* ================================================================== SFG */

type SfgRow = typeof erpSfgLines.$inferSelect;

/** Posts, or re-syncs, a batch line's SFG entry: its yield, under its lot code. */
async function syncSfgEntry(tx: Ex, line: SfgRow) {
  const values = {
    entryDate: line.batchDate,
    formulationId: line.formulationId,
    lotCode: line.lotCode,
    godownId: line.godownId,
    quantity: sfgYield(line.totalUse, line.litresAdjusted),
    batches: line.batches,
  };
  const t = tx as unknown as Tx;
  const [e] = await t.select({ id: erpSfgEntries.id }).from(erpSfgEntries).where(and(eq(erpSfgEntries.sourceType, "sfg"), eq(erpSfgEntries.sourceId, line.id)));
  if (e) await t.update(erpSfgEntries).set(values).where(eq(erpSfgEntries.id, e.id));
  else await t.insert(erpSfgEntries).values({ id: erpId("sfe"), sourceType: "sfg", sourceId: line.id, ...values });
}

export async function sfgForm(ctx: ErpContext, fixed?: { sfgNo: number; date: string; godown: string; product: string; batches: string }): Promise<FormSpec> {
  const [gds, forms, lots] = await Promise.all([
    godownOptions(ctx, { lost: false }),
    db.select({ name: productFormulations.name }).from(productFormulations).where(eq(productFormulations.active, true)).orderBy(asc(productFormulations.name)),
    rmLots(),
  ]);
  const items: Record<string, string[]> = {};
  const lotsOf: Record<string, string[]> = {};
  const avail: Record<string, number> = {};
  const rate: Record<string, number | null> = {};
  for (const l of lots) {
    if (l.stock <= 0 || l.materialType === "Can") continue;
    if (!(items[l.godown] ??= []).includes(l.item)) items[l.godown].push(l.item);
    (lotsOf[pair(l.godown, l.item)] ??= []).push(l.lotNo);
    avail[pair(l.godown, l.lotNo)] = l.stock;
    rate[l.lotNo] = l.ratePaise;
  }
  const cost = ctx.powers.has("viewCost");
  return {
    screen: "sfgBatches",
    id: fixed ? "more" : "new",
    title: fixed ? `Add a lot to SFG ${fixed.sfgNo}` : "New SFG batch",
    sub: "One line per raw-material lot the batch consumes.",
    submit: "Save batch",
    lineLabel: "Raw-material lot",
    init: fixed
      ? { sfgFixed: String(fixed.sfgNo), date: fixed.date, godown: fixed.godown, product: fixed.product, batches: fixed.batches }
      : { date: today(), godown: ctx.workingGodown?.name ?? "" },
    data: { avail, rate: cost ? rate : {} },
    header: [
      { k: "sfgNo", l: "SFG No", t: "derived", calc: "sfg.no" },
      { k: "date", l: "Date", t: "date", req: true, readOnly: !!fixed },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name), readOnly: !!fixed },
      { k: "product", l: "SFG product", t: "select", req: true, opts: forms.map((f) => f.name), readOnly: !!fixed },
      { k: "batches", l: "Number of batches", t: "num", req: true, min: 0.01, readOnly: !!fixed },
    ],
    line: [
      { k: "item", l: "Raw item", t: "select", req: true, optsBy: { by: "godown", map: items }, when: { k: "godown", notEmpty: true }, hint: "Items with stock at this godown. Cans are never consumed here." },
      { k: "lot", l: "Raw-material lot", t: "select", req: true, optsBy: { by: ["godown", "item"], map: lotsOf }, when: { k: "item", notEmpty: true } },
      { k: "avail", l: "Available (litres)", t: "derived", calc: "sfg.avail" },
      { k: "qty", l: "Quantity per batch (litres)", t: "num", req: true, min: 0.001 },
      { k: "total", l: "Total use incl. batches", t: "derived", calc: "sfg.total" },
      { k: "adjusted", l: "Litres adjusted (loss)", t: "num", min: 0 },
      { k: "yield", l: "Available SFG (litres)", t: "derived", calc: "sfg.yield" },
      ...(cost ? ([{ k: "rate", l: "Purchase rate", t: "derived", calc: "sfg.rate" }] as FieldSpec[]) : []),
    ],
  };
}

async function sfgEditForm(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const [l] = await db
    .select({ l: erpSfgLines, item: erpRawMaterials.name, godown: erpGodowns.name, product: productFormulations.name })
    .from(erpSfgLines)
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpSfgLines.rawMaterialId))
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpSfgLines.godownId))
    .innerJoin(productFormulations, eq(productFormulations.id, erpSfgLines.formulationId))
    .where(eq(erpSfgLines.id, id));
  if (!l) return null;
  const own = await rmLotStock(l.l.rmLotNo, l.l.godownId);
  return {
    screen: "sfgBatches",
    id: "edit",
    recordId: id,
    title: `Edit SFG ${l.l.sfgNo} · ${l.item}`,
    sub: `Lot ${l.l.rmLotNo} at ${l.godown}. The lot and item are fixed; add another line to consume a different lot.`,
    submit: "Save line",
    init: { batches: String(l.l.batches), qty: String(l.l.qtyPerBatch), adjusted: String(l.l.litresAdjusted), sfgNo: String(l.l.sfgNo) },
    data: { availOwn: own + l.l.totalUse },
    header: [
      { k: "batches", l: "Number of batches", t: "num", req: true, min: 0.01, hint: "Changing it changes every line of this batch." },
      { k: "qty", l: "Quantity per batch (litres)", t: "num", req: true, min: 0.001 },
      { k: "total", l: "Total use incl. batches", t: "derived", calc: "sfg.editTotal" },
      { k: "adjusted", l: "Litres adjusted (loss)", t: "num", min: 0 },
    ],
  };
}

const sfgBatches: ScreenModule = {
  key: "sfgBatches",
  async load(ctx) {
    const [rows, rates, rm] = await Promise.all([
      db
        .select({ l: erpSfgLines, item: erpRawMaterials.name, godown: erpGodowns.name, product: productFormulations.name, by: users.name })
        .from(erpSfgLines)
        .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpSfgLines.rawMaterialId))
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpSfgLines.godownId))
        .innerJoin(productFormulations, eq(productFormulations.id, erpSfgLines.formulationId))
        .leftJoin(users, eq(users.id, erpSfgLines.createdById))
        .orderBy(desc(erpSfgLines.batchDate), desc(erpSfgLines.sfgNo), asc(erpSfgLines.createdAt)),
      sfgRates(),
      rmLots(),
    ]);
    const rmRate = new Map(rm.map((l) => [l.lotNo, l.ratePaise]));
    /*
     * ABOVE THE RECIPE: what a batch used of each raw material, across its
     * lots, against the product's recipe times its batches. A flag for
     * somebody to look at, never a refusal — a batch can need more.
     */
    const [recipes, config] = await Promise.all([recipeMap(), getConfig()]);
    const tolerance = config["erp.production.recipeTolerancePercent"] / 100;
    const usedBy = new Map<string, number>();
    rows.forEach((x) => usedBy.set(`${x.l.sfgNo}|${x.l.rawMaterialId}`, (usedBy.get(`${x.l.sfgNo}|${x.l.rawMaterialId}`) ?? 0) + Number(x.l.totalUse)));
    const recipeFor = (x: (typeof rows)[number]) => recipes.get(`${x.l.formulationId}|${x.l.rawMaterialId}`) ?? null;
    const overRecipe = (x: (typeof rows)[number]) => {
      const per = recipeFor(x);
      if (per == null) return false;
      return (usedBy.get(`${x.l.sfgNo}|${x.l.rawMaterialId}`) ?? 0) > per * Number(x.l.batches) * (1 + tolerance) + 1e-9;
    };
    const posted = new Set(
      (await db.select({ id: erpSfgEntries.sourceId }).from(erpSfgEntries).where(eq(erpSfgEntries.sourceType, "sfg"))).map((x) => x.id),
    );
    const all: Col[] = [
      { k: "sfgNo", l: "SFG no", t: "mono" },
      { k: "date", l: "Date", t: "d" },
      { k: "product", l: "SFG product", t: "b" },
      { k: "batches", l: "Batches", t: "n" },
      { k: "item", l: "Raw item", t: "t" },
      { k: "lot", l: "RM lot", t: "mono" },
      { k: "qty", l: "Qty per batch", t: "n" },
      { k: "total", l: "Total use", t: "n" },
      { k: "adjusted", l: "Litres adjusted", t: "n" },
      { k: "lotCode", l: "SFG lot code", t: "mono" },
      { k: "rate", l: "Purchase rate", t: "m", pw: "viewCost" },
      { k: "costing", l: "Purchase costing", t: "m", pw: "viewCost" },
      { k: "sfgRate", l: "SFG rate", t: "m", pw: "viewCost" },
      { k: "godown", l: "Godown", t: "t" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "sfgBatches",
        cols,
        hidden,
        groups: ["godown"],
        agg: { k: "total", l: "litres used" },
        godownKey: "godown",
        newForm: await sfgForm(ctx),
        newLabel: "New SFG batch",
        noDataLine: "No SFG batches yet. A batch consumes raw-material lots at one godown.",
      },
      rows: rows.map((x): ListRow => {
        const rate = rmRate.get(x.l.rmLotNo) ?? null;
        const actions: ActionSpec[] = [
          { id: "more", l: "ADD More SFG", primary: true, loadsForm: true },
          { id: "edit", l: "Edit", loadsForm: true },
          { id: "select", l: "Select SFG", href: `?f=${encodeURIComponent(rows.filter((y) => y.l.sfgNo === x.l.sfgNo).map((y) => y.l.id).join(","))}&fl=${encodeURIComponent(`SFG ${x.l.sfgNo}`)}` },
          {
            id: "delete",
            l: "Delete",
            why: ctx.administrator ? "" : "Only an administrator deletes a posted batch line",
            confirm: `Delete this line of SFG ${x.l.sfgNo}? Its stock entry stays in the log, flagged as deleted.`,
          },
        ];
        if (!posted.has(x.l.id)) actions.unshift({ id: "post", l: "Post to inventory", primary: true });
        return {
          id: x.l.id,
          v: withoutHidden(
            {
              sfgNo: String(x.l.sfgNo),
              date: x.l.batchDate,
              product: x.product,
              batches: x.l.batches,
              item: x.item,
              lot: x.l.rmLotNo,
              qty: x.l.qtyPerBatch,
              total: x.l.totalUse,
              adjusted: x.l.litresAdjusted,
              lotCode: x.l.lotCode,
              rate,
              costing: rate == null ? null : Math.round(rate * x.l.totalUse),
              sfgRate: rates.get(x.l.lotCode) ?? null,
              godown: x.godown,
            },
            hiddenKeys,
          ),
          flags: [...(posted.has(x.l.id) ? [] : ["notPosted"]), ...(overRecipe(x) ? ["overRecipe"] : [])],
          title: `${x.product} · SFG ${x.l.sfgNo}`,
          header: `${x.item} lot ${x.l.rmLotNo} · ${nf(x.l.totalUse)} Ltr used · ${nf(sfgYield(x.l.totalUse, x.l.litresAdjusted))} Ltr made`,
          fields: [
            { l: "Available SFG (litres)", v: nf(sfgYield(x.l.totalUse, x.l.litresAdjusted)), der: true },
            ...(recipeFor(x) != null
              ? [{ l: "Recipe", v: `${nf(recipeFor(x)! * Number(x.l.batches))} for ${nf(Number(x.l.batches))} batch${Number(x.l.batches) === 1 ? "" : "es"} · this batch used ${nf(usedBy.get(`${x.l.sfgNo}|${x.l.rawMaterialId}`) ?? 0)}`, der: true }]
              : []),
          ],
          actions,
          by: stampLine(x.by, x.l.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    edit: sfgEditForm,
    async more(ctx, id) {
      const [l] = await db
        .select({ l: erpSfgLines, godown: erpGodowns.name, product: productFormulations.name })
        .from(erpSfgLines)
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpSfgLines.godownId))
        .innerJoin(productFormulations, eq(productFormulations.id, erpSfgLines.formulationId))
        .where(eq(erpSfgLines.id, id));
      if (!l) return null;
      return sfgForm(ctx, { sfgNo: l.l.sfgNo, date: l.l.batchDate, godown: l.godown, product: l.product, batches: String(l.l.batches) });
    },
  },
  forms: {
    new: (ctx, h, lines) => saveSfg(ctx, h, lines),
    more: (ctx, h, lines) => saveSfg(ctx, h, lines),
    async edit(ctx, h, _l, id) {
      if (!id) return err("No line named.", "not_found");
      const batches = num(h.batches);
      const qty = num(h.qty);
      const adjusted = num(h.adjusted) ?? 0;
      if (batches == null || batches <= 0) return fieldErr("batches", "Number of batches is required");
      if (qty == null || qty <= 0) return fieldErr("qty", "Minus Quantity Not Allowed");
      if (adjusted < 0) return fieldErr("adjusted", "Minus Quantity Not Allowed");
      const total = sfgTotalUse(batches, qty);
      if (adjusted > total) return fieldErr("adjusted", "More litres adjusted than the line uses");
      return inTx(async (tx) => {
        const [before] = await tx.select().from(erpSfgLines).where(eq(erpSfgLines.id, id));
        if (!before) return refuse(err("That line no longer exists.", "not_found"));
        await lockLot(tx, "rm", before.rmLotNo, before.godownId);
        await lockLot(tx, "sfg", before.lotCode, before.godownId);
        const rmAvail = (await rmLotStock(before.rmLotNo, before.godownId, tx)) + before.totalUse;
        if (total > rmAvail + 1e-9) return refuse(fieldErr("qty", "Low Stock!"));
        const sfgNow = await sfgLotStock(before.lotCode, before.godownId, tx);
        const newYield = sfgYield(total, adjusted);
        if (sfgNow - sfgYield(before.totalUse, before.litresAdjusted) + newYield < -1e-9)
          return refuse(err("This SFG has already been filled or moved; the line cannot shrink below what was used.", "rule_violation"));
        /* The number of batches belongs to the whole batch. */
        if (batches !== before.batches) {
          const others = await tx.select().from(erpSfgLines).where(eq(erpSfgLines.sfgNo, before.sfgNo));
          for (const o of others) {
            if (o.id === id) continue;
            const t = sfgTotalUse(batches, o.qtyPerBatch);
            await lockLot(tx, "rm", o.rmLotNo, o.godownId);
            if (t > (await rmLotStock(o.rmLotNo, o.godownId, tx)) + o.totalUse + 1e-9)
              return refuse(fieldErr("batches", `Low Stock! on lot ${o.rmLotNo}`));
            const [after] = await tx.update(erpSfgLines).set({ batches, totalUse: t, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpSfgLines.id, o.id)).returning();
            await syncSfgEntry(tx, after);
          }
        }
        const [after] = await tx
          .update(erpSfgLines)
          .set({ batches, qtyPerBatch: qty, totalUse: total, litresAdjusted: adjusted, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(erpSfgLines.id, id))
          .returning();
        await syncSfgEntry(tx, after);
        await erpAudit(ctx, "erp.sfg.edit", "erp_sfg_line", id, before, after);
        return okVoid("Line saved");
      });
    },
  },
  actions: {
    async post(ctx, id) {
      const [l] = await db.select().from(erpSfgLines).where(eq(erpSfgLines.id, id));
      if (!l) return err("That line no longer exists.", "not_found");
      await db.transaction((tx) => syncSfgEntry(tx, l));
      await erpAudit(ctx, "erp.sfg.post", "erp_sfg_line", id);
      return okVoid("Posted to SFG inventory");
    },
    async delete(ctx, id) {
      if (!ctx.administrator) return err("Only an administrator deletes a posted batch line.", "not_permitted");
      const [before] = await db.select().from(erpSfgLines).where(eq(erpSfgLines.id, id));
      if (!before) return err("That line no longer exists.", "not_found");
      await db.delete(erpSfgLines).where(eq(erpSfgLines.id, id));
      await erpAudit(ctx, "erp.sfg.delete", "erp_sfg_line", id, before, null);
      return okVoid("Line deleted · its entry stays in the SFG log, flagged");
    },
  },
};

async function saveSfg(ctx: ErpContext, h: Record<string, string>, lines: Record<string, string>[]): Promise<Result<unknown>> {
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const f = await formulationByName(text(h.product));
  if (!f) return fieldErr("product", "SFG product is required");
  const batches = num(h.batches);
  if (batches == null || batches <= 0) return fieldErr("batches", "Number of batches is required");
  if (!lines.length) return err("Add at least one raw-material lot.");
  const date = text(h.date) ?? today();
  const fixed = int(h.sfgFixed);
  const mats = await db.select().from(erpRawMaterials);
  const parsed: { i: number; m: (typeof mats)[number]; lot: string; qty: number; adjusted: number; total: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = mats.find((x) => x.name === l.item);
    if (!m) return fieldErr(`l${i}.item`, "Raw item is required");
    if (m.materialType === "Can") return fieldErr(`l${i}.item`, "Cans are not consumed in an SFG batch");
    const lot = text(l.lot);
    if (!lot) return fieldErr(`l${i}.lot`, "Raw-material lot is required");
    const qty = num(l.qty);
    if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, "Minus Quantity Not Allowed");
    const adjusted = num(l.adjusted) ?? 0;
    if (adjusted < 0) return fieldErr(`l${i}.adjusted`, "Minus Quantity Not Allowed");
    const total = sfgTotalUse(batches, qty);
    if (adjusted > total) return fieldErr(`l${i}.adjusted`, "More litres adjusted than the line uses");
    parsed.push({ i, m, lot, qty, adjusted, total });
  }
  let sfgNo = 0;
  const res = await inTx(async (tx) => {
    /* A-09: what a line may use is the lot's stock now, less what the lines
       before it in this same save already take from that lot. */
    const taking = new Map<string, number>();
    for (const p of parsed) {
      await lockLot(tx, "rm", p.lot, godownId);
      const lots = await rmLots(tx);
      const lot = lots.find((x) => x.lotNo === p.lot && x.godownId === godownId);
      if (!lot || lot.rawMaterialId !== p.m.id) return refuse(fieldErr(`l${p.i}.lot`, "Pick a lot of this item with stock at this godown"));
      const avail = lot.stock - (taking.get(p.lot) ?? 0);
      if (p.total > avail + 1e-9) return refuse(fieldErr(`l${p.i}.qty`, "Low Stock!"));
      taking.set(p.lot, (taking.get(p.lot) ?? 0) + p.total);
    }
    sfgNo = fixed ?? (await nextNumber(tx, "sfg"));
    /* A batch's lot code is named by its first line, and later lines copy it. */
    const [first] = await tx.select({ lotCode: erpSfgLines.lotCode }).from(erpSfgLines).where(eq(erpSfgLines.sfgNo, sfgNo)).orderBy(asc(erpSfgLines.createdAt)).limit(1);
    const lotCode = first?.lotCode ?? sfgLotCode(sfgNo, parsed[0].lot);
    for (const p of parsed) {
      const [line] = await tx
        .insert(erpSfgLines)
        .values({
          id: erpId("sfg"),
          sfgNo,
          batchDate: date,
          godownId,
          formulationId: f.id,
          batches,
          rawMaterialId: p.m.id,
          rmLotNo: p.lot,
          qtyPerBatch: p.qty,
          totalUse: p.total,
          litresAdjusted: p.adjusted,
          lotCode,
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        })
        .returning();
      await syncSfgEntry(tx, line);
    }
    return okVoid(`SFG ${sfgNo} saved · ${nf(parsed.reduce((a, p) => a + sfgYield(p.total, p.adjusted), 0))} Ltr of ${f.name} in stock`);
  });
  if (res.ok) await erpAudit(ctx, "erp.sfg.create", "erp_sfg_line", String(sfgNo), null, { lines: parsed.length, product: f.name });
  return res;
}

/* =================================================================== FG */

type FillRow = typeof erpFgFills.$inferSelect;

/** The loose SKU a fill's cans sell as: this FG product, one can a box, no empty box, same packing item where one matches. */
async function looseSku(tx: Ex, finishedGoodId: string, canUseId: string | null): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select p.id, pk.can_use_material_id as can
      from products p left join erp_product_packing pk on pk.product_id = p.id
     where p.finished_good_id = ${finishedGoodId} and p.cans_per_box = 1 and coalesce(pk.empty_boxes_required, 0) = 0
     order by (pk.can_use_material_id is not distinct from ${canUseId}) desc, p.name
     limit 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/** Posts, or re-syncs, a fill's FG entry: the cans it put in stock, net of cans lost (A-12). */
async function syncFgEntry(tx: Ex, f: FillRow) {
  const t = tx as unknown as Tx;
  const values = {
    entryDate: f.fillDate,
    finishedGoodId: f.finishedGoodId,
    lotCode: f.lotCode,
    godownId: f.godownId,
    quantity: f.cans - f.canAdjusted,
    canUseId: f.canUseId,
    packingType: f.packingType,
    skuId: await looseSku(tx, f.finishedGoodId, f.canUseId),
  };
  const [e] = await t.select({ id: erpFgEntries.id }).from(erpFgEntries).where(and(eq(erpFgEntries.sourceType, "fill"), eq(erpFgEntries.sourceId, f.id)));
  if (e) await t.update(erpFgEntries).set(values).where(eq(erpFgEntries.id, e.id));
  else await t.insert(erpFgEntries).values({ id: erpId("fge"), sourceType: "fill", sourceId: f.id, ...values });
}

/** FG products, their can sizes and the packing items each size fills into. */
async function fgCatalogue() {
  const rows = (await db.execute(sql`
    select fg.id as fg, fg.name as "fgName", f.name as sfg, fg.millilitres as "fgMl", p.millilitres_per_can as ml,
           m.id as "canUseId", m.name as "canUse", m.material_type as "canType"
      from finished_goods fg
      join product_formulations f on f.id = fg.formulation_id
      left join products p on p.finished_good_id = fg.id and p.active
      left join erp_product_packing pk on pk.product_id = p.id
      left join erp_raw_materials m on m.id = pk.can_use_material_id
     where fg.active
     order by fg.name
  `)) as unknown as { fg: string; fgName: string; sfg: string; fgMl: number; ml: number | null; canUseId: string | null; canUse: string | null; canType: string | null }[];
  const fgOf: Record<string, string[]> = {};
  const sizesOf: Record<string, string[]> = {};
  const canUseOf: Record<string, string[]> = {};
  const typeOf: Record<string, string> = {};
  const fgId: Record<string, string> = {};
  for (const r of rows) {
    fgId[r.fgName] = r.fg;
    if (!(fgOf[r.sfg] ??= []).includes(r.fgName)) fgOf[r.sfg].push(r.fgName);
    const size = String(Number(r.ml ?? r.fgMl) / 1000);
    if (!(sizesOf[r.fgName] ??= []).includes(size)) sizesOf[r.fgName].push(size);
    const k = pair(r.fgName, size);
    canUseOf[k] ??= [];
    if (r.canUse && !canUseOf[k].includes(r.canUse)) canUseOf[k].push(r.canUse);
    if (r.canUse) typeOf[r.canUse] = r.canType === "Can" || r.canType === "Drum" ? r.canType : "Naket";
  }
  return { fgOf, sizesOf, canUseOf, typeOf, fgId };
}

async function fillForm(ctx: ErpContext, fixed?: { fgNum: number; date: string; godown: string }): Promise<FormSpec> {
  const [gds, sfg, cat, levelAvail, rates, mats] = await Promise.all([
    godownOptions(ctx, { lost: false }),
    sfgLots(),
    fgCatalogue(),
    rmLevelAvailable(),
    sfgRates(),
    db.select({ id: erpRawMaterials.id, name: erpRawMaterials.name, price: erpRawMaterials.pricePaise, type: erpRawMaterials.materialType }).from(erpRawMaterials),
  ]);
  const products: Record<string, string[]> = {};
  const lotsOf: Record<string, string[]> = {};
  const avail: Record<string, number> = {};
  const sfgRate: Record<string, number | null> = {};
  for (const l of sfg) {
    if (l.stock <= 0) continue;
    if (!(products[l.godown] ??= []).includes(l.product)) products[l.godown].push(l.product);
    (lotsOf[pair(l.godown, l.product)] ??= []).push(l.lotCode);
    avail[pair(l.godown, l.lotCode)] = l.stock;
    sfgRate[l.lotCode] = rates.get(l.lotCode) ?? null;
  }
  const packAvail: Record<string, number> = {};
  const packRate: Record<string, number | null> = {};
  for (const g of gds) for (const m of mats) if (m.type === "Can" || m.type === "Drum") packAvail[pair(g.name, m.name)] = levelAvail(m.type, m.id, g.id);
  mats.forEach((m) => (packRate[m.name] = m.price));
  const cost = ctx.powers.has("viewCost");
  return {
    screen: "fgFill",
    id: fixed ? "more" : "new",
    title: fixed ? `Add to FG run ${fixed.fgNum}` : "New FG filling",
    sub: "SFG from one lot, filled into cans or drums of one FG product.",
    submit: "Save filling",
    init: fixed ? { fgFixed: String(fixed.fgNum), date: fixed.date, godown: fixed.godown } : { date: today(), godown: ctx.workingGodown?.name ?? "" },
    data: { avail, packAvail, typeOf: cat.typeOf, ...(cost ? { sfgRate, packRate } : {}) },
    header: [
      { k: "fgNum", l: "FG num", t: "derived", calc: "fg.num" },
      { k: "date", l: "Date", t: "date", req: true, readOnly: !!fixed },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name), readOnly: !!fixed },
      { k: "sfg", l: "SFG product", t: "select", req: true, optsBy: { by: "godown", map: products }, when: { k: "godown", notEmpty: true } },
      { k: "sfgLot", l: "SFG lot code", t: "select", req: true, optsBy: { by: ["godown", "sfg"], map: lotsOf }, when: { k: "sfg", notEmpty: true } },
      { k: "sfgAvail", l: "SFG available (litres)", t: "derived", calc: "fg.sfgAvail" },
      { k: "fg", l: "FG product", t: "select", req: true, optsBy: { by: "sfg", map: cat.fgOf }, when: { k: "sfg", notEmpty: true } },
      { k: "size", l: "Can size (litres)", t: "select", req: true, optsBy: { by: "fg", map: cat.sizesOf }, when: { k: "fg", notEmpty: true } },
      { k: "canUse", l: "Can use", t: "select", optsBy: { by: ["fg", "size"], map: cat.canUseOf }, when: { k: "size", notEmpty: true }, hint: "Leave blank for a Naket fill, which takes no packing." },
      { k: "packAvail", l: "Available packing", t: "derived", calc: "fg.packAvail" },
      { k: "cans", l: "Cans or drums filled", t: "num", req: true, min: 1 },
      { k: "litres", l: "Use quantity (litres)", t: "derived", calc: "fg.litres" },
      { k: "adjusted", l: "Cans adjusted (lost)", t: "num", min: 0 },
      { k: "net", l: "FG cans available", t: "derived", calc: "fg.net" },
      { k: "lotCode", l: "Finished lot code", t: "derived", calc: "fg.lotCode" },
      ...(cost ? ([{ k: "costing", l: "FG costing", t: "derived", calc: "fg.costing" }] as FieldSpec[]) : []),
    ],
  };
}

const fgFill: ScreenModule = {
  key: "fgFill",
  async load(ctx) {
    const [rows, rates, sfg] = await Promise.all([
      db
        .select({ f: erpFgFills, fg: finishedGoods.name, sfg: productFormulations.name, godown: erpGodowns.name, canUse: erpRawMaterials.name, packPrice: erpRawMaterials.pricePaise, by: users.name })
        .from(erpFgFills)
        .innerJoin(finishedGoods, eq(finishedGoods.id, erpFgFills.finishedGoodId))
        .innerJoin(productFormulations, eq(productFormulations.id, erpFgFills.formulationId))
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpFgFills.godownId))
        .leftJoin(erpRawMaterials, eq(erpRawMaterials.id, erpFgFills.canUseId))
        .leftJoin(users, eq(users.id, erpFgFills.createdById))
        .orderBy(desc(erpFgFills.fillDate), desc(erpFgFills.fgNum)),
      fgRates(),
      sfgRates(),
    ]);
    void rates;
    const posted = new Set((await db.select({ id: erpFgEntries.sourceId }).from(erpFgEntries).where(eq(erpFgEntries.sourceType, "fill"))).map((x) => x.id));
    const all: Col[] = [
      { k: "fgNum", l: "FG num", t: "mono" },
      { k: "date", l: "Date", t: "d" },
      { k: "fg", l: "FG product", t: "b" },
      { k: "sfg", l: "SFG product", t: "t" },
      { k: "sfgLot", l: "SFG lot", t: "mono" },
      { k: "size", l: "Can size", t: "n" },
      { k: "canUse", l: "Can use", t: "t" },
      { k: "cans", l: "Cans", t: "n" },
      { k: "litres", l: "Litres used", t: "n" },
      { k: "adjusted", l: "Cans adjusted", t: "n" },
      { k: "net", l: "Cans available", t: "n" },
      { k: "lotCode", l: "Finished lot", t: "mono" },
      { k: "packing", l: "Packing", t: "s" },
      { k: "costing", l: "FG costing", t: "m", pw: "viewCost" },
      { k: "godown", l: "Godown", t: "t" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "fgFill",
        cols,
        hidden,
        groups: ["godown", "date"],
        godownKey: "godown",
        newForm: await fillForm(ctx),
        newLabel: "New FG filling",
        noDataLine: "No FG filling yet. A filling draws SFG from one lot into cans or drums.",
      },
      rows: rows.map((x): ListRow => {
        const fig = fillFigures({
          canSize: x.f.canSize,
          cans: x.f.cans,
          canAdjusted: x.f.canAdjusted,
          packingType: x.f.packingType,
          sfgRatePaise: sfg.get(x.f.sfgLotCode) ?? null,
          packingRatePaise: x.packPrice ?? null,
        });
        const actions: ActionSpec[] = [
          { id: "more", l: "Add to this run", loadsForm: true },
          { id: "select", l: "Select SFG 2", href: `?f=${encodeURIComponent(rows.filter((y) => y.f.fgNum === x.f.fgNum).map((y) => y.f.id).join(","))}&fl=${encodeURIComponent(`FG ${x.f.fgNum}`)}` },
          { id: "adjust", l: "Edit cans adjusted", prompt: { title: "Cans adjusted", sub: `${x.fg} · ${x.f.lotCode}`, submit: "Save", fields: [{ k: "adjusted", l: "Cans lost or adjusted", t: "num", req: true, min: 0, max: x.f.cans }], init: { adjusted: String(x.f.canAdjusted) } } },
          { id: "delete", l: "Delete", why: ctx.administrator ? "" : "Only an administrator deletes a posted filling", confirm: `Delete FG filling ${x.f.lotCode}? Its stock entry stays in the log, flagged as deleted.` },
        ];
        if (!posted.has(x.f.id)) actions.unshift({ id: "post", l: "Post to inventory", primary: true });
        return {
          id: x.f.id,
          v: withoutHidden(
            {
              fgNum: String(x.f.fgNum),
              date: x.f.fillDate,
              fg: x.fg,
              sfg: x.sfg,
              sfgLot: x.f.sfgLotCode,
              size: x.f.canSize,
              canUse: x.canUse,
              cans: x.f.cans,
              litres: fig.useLitres,
              adjusted: x.f.canAdjusted,
              net: fig.cansAvailable,
              lotCode: x.f.lotCode,
              packing: x.f.packingType,
              costing: fig.costingPaise,
              godown: x.godown,
            },
            hiddenKeys,
          ),
          flags: posted.has(x.f.id) ? [] : ["notPosted"],
          title: `${x.fg} · ${x.f.lotCode}`,
          header: `${nf(x.f.cans)} × ${nf(x.f.canSize)} L from SFG ${x.f.sfgLotCode} · ${x.godown}`,
          fields: ctx.powers.has("viewCost")
            ? [{ l: fig.rateBasis === "can" ? "Rate per can" : "Rate per litre", v: fig.ratePaise == null ? "—" : inr(fig.ratePaise), der: true }]
            : [],
          actions,
          by: stampLine(x.by, x.f.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    async more(ctx, id) {
      const [f] = await db.select({ f: erpFgFills, godown: erpGodowns.name }).from(erpFgFills).innerJoin(erpGodowns, eq(erpGodowns.id, erpFgFills.godownId)).where(eq(erpFgFills.id, id));
      return f ? fillForm(ctx, { fgNum: f.f.fgNum, date: f.f.fillDate, godown: f.godown }) : null;
    },
  },
  forms: {
    new: (ctx, h) => saveFill(ctx, h),
    more: (ctx, h) => saveFill(ctx, h),
  },
  actions: {
    async post(ctx, id) {
      const [f] = await db.select().from(erpFgFills).where(eq(erpFgFills.id, id));
      if (!f) return err("That filling no longer exists.", "not_found");
      await db.transaction((tx) => syncFgEntry(tx, f));
      await erpAudit(ctx, "erp.fg.post", "erp_fg_fill", id);
      return okVoid("Posted to FG inventory");
    },
    async adjust(ctx, id, values) {
      const adjusted = int(values.adjusted);
      if (adjusted == null || adjusted < 0) return fieldErr("adjusted", "Minus Quantity Not Allowed");
      return inTx(async (tx) => {
        const [before] = await tx.select().from(erpFgFills).where(eq(erpFgFills.id, id));
        if (!before) return refuse(err("That filling no longer exists.", "not_found"));
        if (adjusted > before.cans) return refuse(fieldErr("adjusted", "More cans adjusted than were filled"));
        await lockLot(tx, "fg", before.lotCode, before.godownId);
        const now = await fgLotStock(before.finishedGoodId, before.lotCode, before.godownId, tx);
        if (now - (adjusted - before.canAdjusted) < -1e-9) return refuse(fieldErr("adjusted", "Those cans have already been packed or moved"));
        const [after] = await tx.update(erpFgFills).set({ canAdjusted: adjusted, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpFgFills.id, id)).returning();
        await syncFgEntry(tx, after);
        await erpAudit(ctx, "erp.fg.adjust", "erp_fg_fill", id, { canAdjusted: before.canAdjusted }, { canAdjusted: adjusted });
        return okVoid(`${nf(after.cans - adjusted)} cans in stock`);
      });
    },
    async delete(ctx, id) {
      if (!ctx.administrator) return err("Only an administrator deletes a posted filling.", "not_permitted");
      const [before] = await db.select().from(erpFgFills).where(eq(erpFgFills.id, id));
      if (!before) return err("That filling no longer exists.", "not_found");
      await db.delete(erpFgFills).where(eq(erpFgFills.id, id));
      await erpAudit(ctx, "erp.fg.delete", "erp_fg_fill", id, before, null);
      return okVoid("Filling deleted · its entry stays in the FG log, flagged");
    },
  },
};

async function saveFill(ctx: ErpContext, h: Record<string, string>): Promise<Result<unknown>> {
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const f = await formulationByName(text(h.sfg));
  if (!f) return fieldErr("sfg", "SFG product is required");
  const sfgLot = text(h.sfgLot);
  if (!sfgLot) return fieldErr("sfgLot", "SFG lot code is required");
  const cat = await fgCatalogue();
  const fgName = text(h.fg);
  const fgId = fgName ? cat.fgId[fgName] : undefined;
  if (!fgName || !fgId || !(cat.fgOf[f.name] ?? []).includes(fgName)) return fieldErr("fg", "Pick an FG product of this SFG");
  const size = num(h.size);
  if (size == null || !(cat.sizesOf[fgName] ?? []).includes(String(size))) return fieldErr("size", "Pick one of this product's can sizes");
  const canUseName = text(h.canUse);
  const allowed = cat.canUseOf[pair(fgName, String(size))] ?? [];
  if (canUseName && !allowed.includes(canUseName)) return fieldErr("canUse", "Pick one of this product's packing items");
  const [canUse] = canUseName ? await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.name, canUseName)) : [];
  const packingType = canUse ? (canUse.materialType === "Can" || canUse.materialType === "Drum" ? canUse.materialType : "Naket") : "Naket";
  const cans = int(h.cans);
  if (cans == null || cans <= 0) return fieldErr("cans", "Minus Quantity Not Allowed");
  const adjusted = int(h.adjusted) ?? 0;
  if (adjusted < 0 || adjusted > cans) return fieldErr("adjusted", "Cans adjusted must be between 0 and the cans filled");
  const date = text(h.date) ?? today();
  const fixed = int(h.fgFixed);
  const gname = await godownName(godownId);
  let lotCode = "";
  const res = await inTx(async (tx) => {
    await lockLot(tx, "sfg", sfgLot, godownId);
    const lot = (await sfgLots(tx)).find((l) => l.lotCode === sfgLot && l.godownId === godownId);
    if (!lot || lot.formulationId !== f.id) return refuse(fieldErr("sfgLot", "Pick a lot of this SFG with stock at this godown"));
    const levelAvail = await rmLevelAvailable();
    const refusal = fillRefusal({
      useLitres: size * cans,
      sfgAvailable: lot.stock,
      cans,
      packingAvailable: canUse ? levelAvail(canUse.materialType, canUse.id, godownId) : null,
      packingType,
    });
    if (refusal) return refuse(fieldErr("cans", refusal));
    const fgNum = fixed ?? (await nextNumber(tx, "fg"));
    lotCode = fgLotCode(fgNum, gname);
    const [row] = await tx
      .insert(erpFgFills)
      .values({
        id: erpId("fin"),
        fgNum,
        fillDate: date,
        godownId,
        formulationId: f.id,
        sfgLotCode: sfgLot,
        finishedGoodId: fgId,
        canSize: size,
        canUseId: canUse?.id ?? null,
        packingType,
        cans,
        canAdjusted: adjusted,
        lotCode,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      })
      .returning();
    await syncFgEntry(tx, row);
    return okVoid(`Filled ${nf(cans)} × ${nf(size)} L · lot ${lotCode} · ${nf(cans - adjusted)} cans in stock`);
  });
  if (res.ok) await erpAudit(ctx, "erp.fg.create", "erp_fg_fill", lotCode, null, { fg: fgName, cans });
  return res;
}

/* ============================================================= packing */

type SkuInfo = { id: string; name: string; fg: string; fgName: string; cpb: number; empty: number; boxType: string | null; boxRate: number | null };

/** Whether the raw-material master names this box type — only then is its stock counted and checked. */
async function boxItemExists(ex: Tx, boxType: string): Promise<boolean> {
  const rows = (await ex.execute(sql`select 1 from erp_raw_materials where lower(name) = lower(${boxType}) limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

async function boxedSkus(): Promise<SkuInfo[]> {
  return (await db.execute(sql`
    select p.id, p.name, fg.id as fg, fg.name as "fgName", p.cans_per_box as cpb, pk.empty_boxes_required as empty,
           pk.box_type as "boxType", pk.box_rate_paise::float8 as "boxRate"
      from products p
      join finished_goods fg on fg.id = p.finished_good_id
      join erp_product_packing pk on pk.product_id = p.id
     where p.active and pk.empty_boxes_required > 0
     order by p.name
  `)) as unknown as SkuInfo[];
}

/** Posts the batch's one entry once its lines draw exactly its cans; takes it back if an edit un-completes it. */
async function syncPackEntry(tx: Tx, batchNo: string) {
  const lines = await tx.select().from(erpPackLines).where(eq(erpPackLines.batchNo, batchNo)).orderBy(asc(erpPackLines.createdAt));
  const [entry] = await tx.select().from(erpPackEntries).where(and(eq(erpPackEntries.sourceType, "batch"), eq(erpPackEntries.sourceId, batchNo)));
  if (!lines.length) return;
  const first = lines[0];
  const [sku] = await tx.select({ cpb: products.cansPerBox }).from(products).where(eq(products.id, first.skuId));
  const st = batchState(first.boxes, sku?.cpb ?? 1, lines.map((l) => ({ id: l.id, cans: l.cans })));
  if (!st.complete) {
    if (entry) await tx.delete(erpPackEntries).where(eq(erpPackEntries.id, entry.id));
    return;
  }
  const values = { entryDate: first.packDate, skuId: first.skuId, batchNo, godownId: first.godownId, boxes: first.boxes };
  if (entry) await tx.update(erpPackEntries).set(values).where(eq(erpPackEntries.id, entry.id));
  else await tx.insert(erpPackEntries).values({ id: erpId("pke"), sourceType: "batch", sourceId: batchNo, ...values });
}

async function packForm(ctx: ErpContext, fixed?: { serial: number; batchNo: string; date: string; godown: string; fg: string; sku: string; boxes: number; remaining: number }): Promise<FormSpec> {
  const [gds, fg, skus] = await Promise.all([godownOptions(ctx, { lost: false }), fgLots(), boxedSkus()]);
  const productsAt: Record<string, string[]> = {};
  const lotsOf: Record<string, string[]> = {};
  const avail: Record<string, number> = {};
  for (const l of fg) {
    if (l.stock <= 0) continue;
    if (!(productsAt[l.godown] ??= []).includes(l.product)) productsAt[l.godown].push(l.product);
    (lotsOf[pair(l.godown, l.product)] ??= []).push(l.lotCode);
    avail[pair(l.godown, l.product, l.lotCode)] = l.stock;
  }
  const skusOf: Record<string, string[]> = {};
  const cpb: Record<string, number> = {};
  for (const s of skus) {
    (skusOf[s.fgName] ??= []).push(s.name);
    cpb[s.name] = s.cpb;
  }
  return {
    screen: "packBatches",
    id: fixed ? "more" : "new",
    title: fixed ? `Add a lot to batch ${fixed.batchNo}` : "New packing batch",
    sub: fixed ? `${fixed.remaining} cans still to draw for ${fixed.boxes} boxes.` : "Loose cans packed into boxes of one SKU. Take the cans from one or more FG lots.",
    submit: "Save packing",
    init: fixed
      ? { serialFixed: String(fixed.serial), date: fixed.date, godown: fixed.godown, fg: fixed.fg, sku: fixed.sku, boxes: String(fixed.boxes), remaining: String(fixed.remaining) }
      : { date: today(), godown: ctx.workingGodown?.name ?? "" },
    data: { avail, cpb },
    header: [
      { k: "batchNo", l: "Batch no", t: "derived", calc: "pack.batchNo" },
      { k: "date", l: "Date", t: "date", req: true, readOnly: !!fixed },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name), readOnly: !!fixed },
      { k: "fg", l: "FG product", t: "select", req: true, optsBy: { by: "godown", map: productsAt }, when: { k: "godown", notEmpty: true }, readOnly: !!fixed },
      { k: "sku", l: "Description of goods (boxed SKU)", t: "select", req: true, optsBy: { by: "fg", map: skusOf }, when: { k: "fg", notEmpty: true }, readOnly: !!fixed },
      { k: "boxes", l: "Boxes in the whole batch", t: "num", req: true, min: 1, readOnly: !!fixed },
      { k: "totalCans", l: "Total cans", t: "derived", calc: "pack.totalCans" },
      { k: "lot", l: "Finished lot", t: "select", req: true, optsBy: { by: ["godown", "fg"], map: lotsOf }, when: { k: "fg", notEmpty: true } },
      { k: "lotAvail", l: "Available FG (cans)", t: "derived", calc: "pack.lotAvail" },
      { k: "cans", l: "Cans from this lot", t: "num", min: 1, hint: "Blank takes as many as the batch still needs." },
      { k: "remarks", l: "Remarks", t: "area", mic: true },
    ],
  };
}

const packBatches: ScreenModule = {
  key: "packBatches",
  async load(ctx) {
    const [rows, costing, posted] = await Promise.all([
      db
        .select({ l: erpPackLines, fg: finishedGoods.name, sku: products.name, cpb: products.cansPerBox, godown: erpGodowns.name, empty: erpProductPacking.emptyBoxesRequired, boxType: erpProductPacking.boxType, by: users.name })
        .from(erpPackLines)
        .innerJoin(finishedGoods, eq(finishedGoods.id, erpPackLines.finishedGoodId))
        .innerJoin(products, eq(products.id, erpPackLines.skuId))
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpPackLines.godownId))
        .leftJoin(erpProductPacking, eq(erpProductPacking.productId, erpPackLines.skuId))
        .leftJoin(users, eq(users.id, erpPackLines.createdById))
        .orderBy(desc(erpPackLines.packDate), desc(erpPackLines.batchSerial), asc(erpPackLines.createdAt)),
      packBatchCosting(),
      db.select({ id: erpPackEntries.sourceId }).from(erpPackEntries).where(eq(erpPackEntries.sourceType, "batch")),
    ]);
    const postedSet = new Set(posted.map((p) => p.id));
    const byBatch = new Map<string, typeof rows>();
    rows.forEach((r) => byBatch.set(r.l.batchNo, [...(byBatch.get(r.l.batchNo) ?? []), r]));
    const all: Col[] = [
      { k: "batchNo", l: "Batch no", t: "mono" },
      { k: "date", l: "Date", t: "d" },
      { k: "sku", l: "Description of goods", t: "b", w: 260 },
      { k: "boxes", l: "Boxes", t: "n" },
      { k: "lot", l: "FG lot", t: "mono" },
      { k: "cans", l: "Cans", t: "n" },
      { k: "remaining", l: "Remaining cans", t: "n" },
      { k: "match", l: "Validation", t: "s" },
      { k: "boxType", l: "Box type", t: "t" },
      { k: "emptyBoxes", l: "Empty boxes", t: "n" },
      { k: "costing", l: "Packing costing", t: "m", pw: "viewCost" },
      { k: "godown", l: "Godown", t: "t" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "packBatches",
        cols,
        hidden,
        groups: ["godown", "date"],
        godownKey: "godown",
        newForm: await packForm(ctx),
        newLabel: "New packing batch",
        noDataLine: "No packing yet. A batch boxes loose cans of one SKU.",
      },
      rows: rows.map((x): ListRow => {
        const batch = byBatch.get(x.l.batchNo) ?? [x];
        const st = batchState(x.l.boxes, x.cpb, batch.map((b) => ({ id: b.l.id, cans: b.l.cans })));
        const box = boxFigures(x.l.boxes, x.empty ?? 0, null);
        const actions: ActionSpec[] = [];
        if (st.remaining > 0) actions.push({ id: "more", l: "Add More", primary: true, loadsForm: true });
        actions.push({ id: "select", l: "Select Batch", href: `?f=${encodeURIComponent(batch.map((b) => b.l.id).join(","))}&fl=${encodeURIComponent(x.l.batchNo)}` });
        actions.push({
          id: "delete",
          l: "Delete",
          why: ctx.administrator ? "" : "Only an administrator deletes a packing line",
          confirm: `Delete this line of ${x.l.batchNo}? The batch stops being complete and its boxes leave stock.`,
        });
        return {
          id: x.l.id,
          v: withoutHidden(
            {
              batchNo: x.l.batchNo,
              date: x.l.packDate,
              sku: x.sku,
              boxes: x.l.boxes,
              lot: x.l.fgLotCode,
              cans: x.l.cans,
              remaining: st.remaining,
              match: st.complete ? "Match" : "Not Match",
              boxType: x.boxType,
              emptyBoxes: box.emptyBoxes,
              costing: costing.get(x.l.batchNo)?.lines.get(x.l.id) ?? null,
              godown: x.godown,
            },
            hiddenKeys,
          ),
          flags: st.complete ? (postedSet.has(x.l.batchNo) ? [] : ["notPosted"]) : ["incomplete"],
          title: `${x.l.batchNo} · ${x.sku}`,
          header: `${nf(x.l.boxes)} boxes · ${nf(st.usedCans)} of ${nf(st.totalCans)} cans drawn${st.complete ? " · in packing stock" : ""}`,
          fields: [{ l: "Total cans", v: nf(st.totalCans), der: true }, { l: "Remarks", v: x.l.remarks || "—" }],
          actions,
          by: stampLine(x.by, x.l.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    async more(ctx, id) {
      const [l] = await db
        .select({ l: erpPackLines, godown: erpGodowns.name, fg: finishedGoods.name, sku: products.name, cpb: products.cansPerBox })
        .from(erpPackLines)
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpPackLines.godownId))
        .innerJoin(finishedGoods, eq(finishedGoods.id, erpPackLines.finishedGoodId))
        .innerJoin(products, eq(products.id, erpPackLines.skuId))
        .where(eq(erpPackLines.id, id));
      if (!l) return null;
      const lines = await db.select({ id: erpPackLines.id, cans: erpPackLines.cans }).from(erpPackLines).where(eq(erpPackLines.batchNo, l.l.batchNo));
      const st = batchState(l.l.boxes, l.cpb, lines);
      return packForm(ctx, { serial: l.l.batchSerial, batchNo: l.l.batchNo, date: l.l.packDate, godown: l.godown, fg: l.fg, sku: l.sku, boxes: l.l.boxes, remaining: st.remaining });
    },
  },
  forms: {
    new: (ctx, h) => savePack(ctx, h),
    more: (ctx, h) => savePack(ctx, h),
  },
  actions: {
    async delete(ctx, id) {
      if (!ctx.administrator) return err("Only an administrator deletes a packing line.", "not_permitted");
      return inTx(async (tx) => {
        const [before] = await tx.select().from(erpPackLines).where(eq(erpPackLines.id, id));
        if (!before) return refuse(err("That line no longer exists.", "not_found"));
        await lockLot(tx, "pack", before.batchNo, before.godownId);
        const [entry] = await tx.select().from(erpPackEntries).where(and(eq(erpPackEntries.sourceType, "batch"), eq(erpPackEntries.sourceId, before.batchNo)));
        if (entry) {
          const stock = (await packLots(tx)).find((l) => l.batchNo === before.batchNo && l.godownId === before.godownId)?.stock ?? 0;
          if (stock < entry.boxes - 1e-9) return refuse(err("Boxes of this batch have already moved on; the batch can no longer be taken apart.", "rule_violation"));
        }
        await tx.delete(erpPackLines).where(eq(erpPackLines.id, id));
        await syncPackEntry(tx, before.batchNo);
        await erpAudit(ctx, "erp.pack.delete", "erp_pack_line", id, before, null);
        return okVoid("Line deleted · the batch is no longer complete");
      });
    },
  },
};

async function savePack(ctx: ErpContext, h: Record<string, string>): Promise<Result<unknown>> {
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const skus = await boxedSkus();
  const sku = skus.find((s) => s.name === text(h.sku) && s.fgName === text(h.fg));
  if (!sku) return fieldErr("sku", "Pick a boxed SKU of this FG product");
  const boxes = int(h.boxes);
  if (boxes == null || boxes <= 0) return fieldErr("boxes", "Minus Quantity Not Allowed");
  const lot = text(h.lot);
  if (!lot) return fieldErr("lot", "Finished lot is required");
  const typed = int(h.cans);
  if (typed != null && typed <= 0) return fieldErr("cans", "Minus Quantity Not Allowed");
  const date = text(h.date) ?? today();
  const fixed = int(h.serialFixed);
  const gname = await godownName(godownId);
  let batchNo = "";
  let complete = false;
  const res = await inTx(async (tx) => {
    const serial = fixed ?? (await nextNumber(tx, "packBatch"));
    batchNo = packBatchNo(serial, gname);
    await lockLot(tx, "pack", batchNo, godownId);
    await lockLot(tx, "fg", lot, godownId);
    const lines = await tx.select().from(erpPackLines).where(eq(erpPackLines.batchNo, batchNo));
    if (lines.length && (lines[0].skuId !== sku.id || lines[0].boxes !== boxes)) return refuse(err("This batch is for a different SKU or box count.", "conflict"));
    const st = batchState(boxes, sku.cpb, lines.map((l) => ({ id: l.id, cans: l.cans })));
    const cans = typed ?? st.remaining;
    if (cans > st.remaining) return refuse(fieldErr("cans", `You Cant Select More Than ${st.remaining} Can`));
    const avail = await fgLotStock(sku.fg, lot, godownId, tx);
    if (cans > avail + 1e-9) return refuse(fieldErr("cans", "Low Stock"));
    /*
     * THE EMPTY BOXES HAVE TO BE THERE (spec §14 A-30). A batch uses its boxes
     * once, on its first line, and they come out of the box item's stock at the
     * godown; Mahek Plus never checked, so a batch could be packed into boxes
     * nobody had bought. A box type the raw-material master does not name is
     * not counted anywhere, so it is not refused here either.
     */
    if (!lines.length && sku.boxType && Number(sku.empty) > 0) {
      const need = boxes * Number(sku.empty);
      const boxLots = (await rmLots(tx)).filter((l) => l.item.toLowerCase() === sku.boxType!.toLowerCase() && l.godownId === godownId);
      if (boxLots.length || (await boxItemExists(tx, sku.boxType))) {
        const have = boxLots.reduce((n, l) => n + l.stock, 0);
        if (need > have + 1e-9) return refuse(fieldErr("boxes", `Low Box Quantity · ${nf(need)} ${sku.boxType} needed, ${nf(Math.max(have, 0))} at ${gname}`));
      }
    }
    await tx.insert(erpPackLines).values({
      id: erpId("fgp"),
      batchSerial: serial,
      batchNo,
      packDate: lines[0]?.packDate ?? date,
      godownId,
      finishedGoodId: sku.fg,
      skuId: sku.id,
      boxes,
      fgLotCode: lot,
      cans,
      remarks: text(h.remarks),
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    await syncPackEntry(tx, batchNo);
    const after = batchState(boxes, sku.cpb, [...lines.map((l) => ({ id: l.id, cans: l.cans })), { id: "new", cans }]);
    complete = after.complete;
    return okVoid(
      complete
        ? `${batchNo} complete · ${nf(boxes)} boxes of ${sku.name} in packing stock`
        : `${batchNo} saved · ${nf(after.remaining)} cans still to draw from another lot`,
    );
  });
  if (res.ok) await erpAudit(ctx, "erp.pack.create", "erp_pack_line", batchNo, null, { sku: sku.name, boxes, complete });
  return res;
}

/* ========================================================= stock screens */

async function entryOrphans(table: "sfg" | "fg" | "pack"): Promise<Set<string>> {
  const q =
    table === "sfg"
      ? sql`select e.id from erp_sfg_entries e where (e.source_type = 'sfg' and not exists (select 1 from erp_sfg_lines l where l.id = e.source_id)) or (e.source_type = 'transfer' and not exists (select 1 from erp_transfers t where t.id = e.source_id))`
      : table === "fg"
        ? sql`select e.id from erp_fg_entries e where (e.source_type = 'fill' and not exists (select 1 from erp_fg_fills f where f.id = e.source_id)) or (e.source_type = 'transfer' and not exists (select 1 from erp_transfers t where t.id = e.source_id))`
        : sql`select e.id from erp_pack_entries e where (e.source_type = 'batch' and not exists (select 1 from erp_pack_lines l where l.batch_no = e.source_id)) or (e.source_type = 'transfer' and not exists (select 1 from erp_transfers t where t.id = e.source_id))`;
  return new Set(((await db.execute(q)) as unknown as { id: string }[]).map((r) => r.id));
}

const sfgStock: ScreenModule = {
  key: "sfgStock",
  async load(ctx) {
    const lots = (await sfgLots()).filter((l) => l.stock > 0);
    const all: Col[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "product", l: "SFG product", t: "b" },
      { k: "stock", l: "Current stock (Ltr)", t: "n" },
      { k: "lot", l: "Lot code", t: "mono" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "batchSize", l: "Batch size", t: "n" },
      { k: "type", l: "Type", t: "s" },
      { k: "rate", l: "SFG rate", t: "m", pw: "viewCost" },
      { k: "value", l: "Stock value", t: "m", pw: "viewCost" },
      { k: "entry", l: "Entry id", t: "mono" },
      { k: "batches", l: "Batches", t: "n" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: { screen: "sfgStock", cols, hidden, groups: ["godown", "lot"], agg: { k: "stock", l: "litres" }, godownKey: "godown", readOnly: true, download: true, noDataLine: "No SFG in stock. Stock appears as SFG batches are saved." },
      rows: lots.map((l) => ({
        id: `${l.lotCode}|${l.godownId}`,
        v: withoutHidden(
          {
            date: l.latestDate,
            product: l.product,
            stock: l.stock,
            lot: l.lotCode,
            godown: l.godown,
            batchSize: l.batchSize,
            type: l.latestType,
            rate: l.ratePaise,
            value: l.ratePaise == null ? null : Math.round(l.ratePaise * l.stock),
            entry: l.latestEntryId,
            batches: l.batches,
          },
          hiddenKeys,
        ),
        flags: [],
        title: `${l.product} · ${l.lotCode}`,
        header: `${nf(l.stock)} Ltr at ${l.godown}`,
      })),
    };
  },
};

const fgStock: ScreenModule = {
  key: "fgStock",
  async load(ctx) {
    const lots = (await fgLots()).filter((l) => l.stock > 0);
    const all: Col[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "product", l: "FG product", t: "b" },
      { k: "stock", l: "Current stock (cans)", t: "n" },
      { k: "lot", l: "Finished lot", t: "mono" },
      { k: "sku", l: "Description of goods", t: "t", w: 240 },
      { k: "packing", l: "Packing", t: "s" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "rate", l: "Rate", t: "m", pw: "viewCost" },
      { k: "value", l: "Stock value", t: "m", pw: "viewCost" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: { screen: "fgStock", cols, hidden, groups: ["godown"], agg: { k: "stock", l: "cans" }, godownKey: "godown", readOnly: true, noDataLine: "No finished goods in stock. Stock appears as filling is saved." },
      rows: lots.map((l) => ({
        id: `${l.finishedGoodId}|${l.lotCode}|${l.godownId}`,
        v: withoutHidden(
          {
            date: l.latestDate,
            product: l.product,
            stock: l.stock,
            lot: l.lotCode,
            sku: l.sku,
            packing: l.packingType,
            godown: l.godown,
            rate: l.ratePaise,
            value: l.perCanPaise == null ? null : Math.round(l.perCanPaise * l.stock),
          },
          hiddenKeys,
        ),
        flags: [],
        title: `${l.product} · ${l.lotCode}`,
        header: `${nf(l.stock)} cans at ${l.godown}`,
      })),
    };
  },
};

const packStock: ScreenModule = {
  key: "packStock",
  async load(ctx) {
    const lots = (await packLots()).filter((l) => l.stock > 0);
    const all: Col[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "batch", l: "Batch no", t: "mono" },
      { k: "sku", l: "Description of goods", t: "b", w: 260 },
      { k: "stock", l: "Current stock (boxes)", t: "n" },
      { k: "rate", l: "Rate per can", t: "m", pw: "viewCost" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "amount", l: "Stock value", t: "m", pw: "viewCost" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: { screen: "packStock", cols, hidden, groups: ["sku"], agg: { k: "stock", l: "boxes" }, godownKey: "godown", readOnly: true, noDataLine: "No boxed stock. A packing batch reaches stock once its cans match its boxes." },
      rows: lots.map((l) => ({
        id: `${l.batchNo}|${l.godownId}`,
        v: withoutHidden(
          {
            date: l.latestDate,
            batch: l.batchNo,
            sku: l.sku,
            stock: l.stock,
            rate: l.perCanPaise,
            godown: l.godown,
            amount: l.perBoxPaise == null ? null : Math.round(l.perBoxPaise * l.stock),
          },
          hiddenKeys,
        ),
        flags: [],
        title: `${l.sku} · ${l.batchNo}`,
        header: `${nf(l.stock)} boxes at ${l.godown}`,
      })),
    };
  },
};

function logScreen(key: "sfgLog" | "fgLog" | "packLog"): ScreenModule {
  return {
    key,
    async load() {
      const table = key === "sfgLog" ? "sfg" : key === "fgLog" ? "fg" : "pack";
      const orphans = await entryOrphans(table);
      const q =
        table === "sfg"
          ? sql`select e.id, e.entry_date::text as date, e.source_type as type, e.source_id as source, f.name as item, e.lot_code as lot, e.quantity::float8 as qty, g.name as godown, e.posted_at as "postedAt"
                  from erp_sfg_entries e join product_formulations f on f.id = e.formulation_id join erp_godowns g on g.id = e.godown_id order by e.entry_date desc, e.posted_at desc, e.id desc`
          : table === "fg"
            ? sql`select e.id, e.entry_date::text as date, e.source_type as type, e.source_id as source, fg.name as item, e.lot_code as lot, e.quantity::float8 as qty, g.name as godown, e.posted_at as "postedAt"
                    from erp_fg_entries e join finished_goods fg on fg.id = e.finished_good_id join erp_godowns g on g.id = e.godown_id order by e.entry_date desc, e.posted_at desc, e.id desc`
            : sql`select e.id, e.entry_date::text as date, e.source_type as type, e.source_id as source, p.name as item, e.batch_no as lot, e.boxes::float8 as qty, g.name as godown, e.posted_at as "postedAt"
                    from erp_pack_entries e join products p on p.id = e.sku_id join erp_godowns g on g.id = e.godown_id order by e.entry_date desc, e.posted_at desc, e.id desc`;
      const rows = (await db.execute(q)) as unknown as { id: string; date: string; type: string; source: string; item: string; lot: string; qty: number; godown: string; postedAt: Date }[];
      const typeLabel = (t: string) => (t === "transfer" ? "Transfer" : table === "sfg" ? "Semi Finished" : table === "fg" ? "Finish Goods" : "FG Packing");
      const cols: ColSpec[] = [
        { k: "date", l: "Date", t: "d" },
        { k: "type", l: "Entry", t: "s" },
        { k: "item", l: table === "pack" ? "Description of goods" : "Product", t: "b" },
        { k: "lot", l: table === "pack" ? "Batch" : "Lot", t: "mono" },
        { k: "qty", l: table === "sfg" ? "Litres" : table === "fg" ? "Cans" : "Boxes", t: "n" },
        { k: "godown", l: "Godown", t: "t" },
        { k: "source", l: "Source", t: "mono" },
        { k: "f", l: "Flags", t: "f" },
      ];
      return {
        spec: { screen: key, cols, hidden: [], groups: ["godown"], godownKey: "godown", readOnly: true, sortDefault: ["date", -1], noDataLine: "Nothing here yet. Entries appear on their own as documents post." },
        rows: rows.map((r) => ({
          id: r.id,
          v: { date: r.date, type: typeLabel(r.type), item: r.item, lot: r.lot, qty: Number(r.qty), godown: r.godown, source: r.source },
          flags: orphans.has(r.id) ? ["orphan"] : [],
          title: `${r.item} · ${r.lot}`,
          by: `Posted ${stampLine(null, r.postedAt).replace(/^Created /, "")}`,
        })),
      };
    },
  };
}

export const PRODUCTION_SCREENS: ScreenModule[] = [sfgBatches, sfgStock, logScreen("sfgLog"), fgFill, fgStock, logScreen("fgLog"), packBatches, packStock, logScreen("packLog")];
