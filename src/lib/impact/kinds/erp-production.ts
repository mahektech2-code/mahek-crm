import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
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
  erpSfgQc,
  finishedGoods,
  productFormulations,
  products,
} from "@/db/schema";
import { batchState } from "@/lib/erp/engines/production";
import { fgLotStock, packLotStock, sfgLotStock } from "@/lib/erp/stock";
import { looseHeadroom } from "@/lib/erp/units";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present, qty } from "./erp-common";

/* ---------------------------------------------------------------------------
 * DELETING A PRODUCTION DOCUMENT moves stock in two stages at once: what it
 * consumed goes back, and what it made leaves. An SFG batch line consumed a
 * raw-material lot and made SFG; a filling consumed SFG and empty cans and
 * made FG cans; a packing line consumed FG cans and, with the rest of its
 * batch, made boxes with ids on them.
 *
 * Until this was written the SFG line and the filling gave their input back
 * and LEFT their output in stock — an "orphaned" log entry the dashboard
 * counted, so the deleted document's stock was counted in both stages until
 * somebody noticed. The deletes now take their own entry out with them, and
 * where that output has already been used (filled, packed, allocated, moved)
 * they are refused: a document whose product has moved on cannot be taken
 * back without taking back what was made from it first. That refusal is the
 * report's blocker, worked out with the same stock read the act uses.
 * ------------------------------------------------------------------------- */

const onlyAdmin = (what: string) => (ctx: { administrator: boolean }) =>
  ctx.administrator ? null : `Only an administrator deletes a ${what}.`;

/* ================================================================ SFG line */

export const sfgLineImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["sfgBatches"], onlyAdmin("posted batch line"));
  },

  async report(id) {
    const [x] = await db
      .select({ l: erpSfgLines, product: productFormulations.name, item: erpRawMaterials.name, godown: erpGodowns.name })
      .from(erpSfgLines)
      .innerJoin(productFormulations, eq(productFormulations.id, erpSfgLines.formulationId))
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpSfgLines.rawMaterialId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpSfgLines.godownId))
      .where(eq(erpSfgLines.id, id));
    if (!x) return null;
    const l = x.l;
    const [[entry], siblings, [verdict], fills, jobs] = await Promise.all([
      db.select().from(erpSfgEntries).where(and(eq(erpSfgEntries.sourceType, "sfg"), eq(erpSfgEntries.sourceId, id))),
      db
        .select({ id: erpSfgLines.id, item: erpRawMaterials.name, lot: erpSfgLines.rmLotNo })
        .from(erpSfgLines)
        .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpSfgLines.rawMaterialId))
        .where(eq(erpSfgLines.lotCode, l.lotCode))
        .orderBy(asc(erpRawMaterials.name)),
      db.select({ status: erpSfgQc.status }).from(erpSfgQc).where(eq(erpSfgQc.lotCode, l.lotCode)),
      db.execute<{ n: number }>(sql`select count(*)::int as n from erp_fg_fills where sfg_lot_code = ${l.lotCode} and godown_id = ${l.godownId}`),
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from factory_tasks where proc = 'filling' and status = 'ready' and sfg_lot = ${l.lotCode}`,
      ),
    ]);
    const others = siblings.filter((s) => s.id !== id);
    const made = entry ? qty(Number(entry.quantity)) : 0;
    const stock = entry ? qty(await sfgLotStock(l.lotCode, l.godownId)) : 0;
    const left = qty(stock - made);

    const blockers: string[] = [];
    if (entry && left < -1e-9) {
      blockers.push(
        `${qty(-left).toLocaleString("en-IN")} L of SFG lot ${l.lotCode} has already been filled into cans or moved on, so this line can no longer be taken back. Delete or correct those fillings and transfers first.`,
      );
    }

    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `litres of ${x.item} (lot ${l.rmLotNo}) go back into raw-material stock`,
        effect: "changed",
        count: qty(l.totalUse),
        note: `What this line consumed at ${x.godown} is counted as on the shelf again.`,
      },
    ];
    if (entry) {
      items.push({
        app: "ERP",
        label: `litres leave SFG lot ${l.lotCode} — its entry in the SFG log goes with the line`,
        effect: "deleted",
        count: made,
        note: blockers.length
          ? undefined
          : left > 0
            ? `${left.toLocaleString("en-IN")} L of the lot stays in SFG stock from its other lines.`
            : "The lot holds nothing at this godown afterwards.",
      });
    }
    items.push({
      app: "ERP",
      label: `other ${many(others.length, "line")} of SFG ${l.sfgNo}`,
      effect: "kept",
      count: others.length,
      examples: others.slice(0, 5).map((o) => `${o.item} · ${o.lot}`),
    });
    if (!others.length && verdict && verdict.status !== "Pending") {
      items.push({
        app: "ERP",
        label: `QC verdict on SFG lot ${l.lotCode}`,
        effect: "kept",
        count: 1,
        note: `${verdict.status}. It stays as the record of what was decided, though no batch line will carry the lot any more.`,
      });
    }
    const filled = Number(fills[0]?.n ?? 0);
    if (filled) {
      items.push({
        app: "ERP",
        label: `${many(filled, "filling")} made from this lot`,
        effect: "kept",
        count: filled,
        note: "They stay traceable to the lot.",
      });
    }
    const waiting = Number(jobs[0]?.n ?? 0);
    if (waiting) {
      items.push({
        app: "Factory",
        label: `filling ${many(waiting, "job")} waiting on this lot`,
        effect: "kept",
        count: waiting,
        note: left > 0 ? `They stay on the floor's list; the lot will hold ${left.toLocaleString("en-IN")} L.` : "They stay on the floor's list, with nothing left in the lot to fill from.",
      });
    }

    return {
      title: `SFG ${l.sfgNo} · ${x.product} · ${x.item} lot ${l.rmLotNo}`,
      verb: "Delete",
      confirmWord: `SFG ${l.sfgNo}`,
      items: present(items),
      blockers,
    };
  },
};

/* ================================================================ FG fill */

export const fgFillImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["fgFill"], onlyAdmin("posted filling"));
  },

  async report(id) {
    const [x] = await db
      .select({ f: erpFgFills, fg: finishedGoods.name, godown: erpGodowns.name, can: erpRawMaterials.name })
      .from(erpFgFills)
      .innerJoin(finishedGoods, eq(finishedGoods.id, erpFgFills.finishedGoodId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpFgFills.godownId))
      .leftJoin(erpRawMaterials, eq(erpRawMaterials.id, erpFgFills.canUseId))
      .where(eq(erpFgFills.id, id));
    if (!x) return null;
    const f = x.f;
    const [[entry], run] = await Promise.all([
      db.select().from(erpFgEntries).where(and(eq(erpFgEntries.sourceType, "fill"), eq(erpFgEntries.sourceId, id))),
      db
        .select({ id: erpFgFills.id, fg: finishedGoods.name, cans: erpFgFills.cans })
        .from(erpFgFills)
        .innerJoin(finishedGoods, eq(finishedGoods.id, erpFgFills.finishedGoodId))
        .where(eq(erpFgFills.fgNum, f.fgNum)),
    ]);
    const others = run.filter((r) => r.id !== id);
    const made = entry ? qty(Number(entry.quantity)) : 0;
    const stock = entry ? qty(await fgLotStock(f.finishedGoodId, f.lotCode, f.godownId)) : 0;
    const left = qty(stock - made);

    const blockers: string[] = [];
    if (entry && left < -1e-9) {
      blockers.push(
        `${qty(-left).toLocaleString("en-IN")} ${many(-left, "can")} of FG lot ${f.lotCode} ${-left === 1 ? "has" : "have"} already been packed into boxes, allocated to an order or moved on, so this filling can no longer be taken back. Undo those first.`,
      );
    }
    /* Loose-can labels the lot could no longer cover — `trimLooseUnits` cancels exactly these. */
    let labels = 0;
    if (entry && !blockers.length) {
      const h = await looseHeadroom(db, { lotCode: f.lotCode, finishedGoodId: f.finishedGoodId, godownId: f.godownId, ledgerStock: left });
      labels = Math.max(0, h.labelled - h.cover);
    }

    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `litres go back into SFG lot ${f.sfgLotCode}`,
        effect: "changed",
        count: qty(f.canSize * f.cans),
      },
    ];
    if (f.packingType === "Can" && f.canUseId) {
      items.push({
        app: "ERP",
        label: `empty ${x.can ?? "cans"} go back into packing-material stock`,
        effect: "changed",
        count: f.cans,
      });
    }
    if (entry) {
      items.push({
        app: "ERP",
        label: `cans of ${x.fg} leave FG lot ${f.lotCode} — its entry in the FG log goes with the filling`,
        effect: "deleted",
        count: made,
      });
    }
    items.push({
      app: "ERP",
      label: `loose-can ${many(labels, "label")} on lot ${f.lotCode} cancelled`,
      effect: "changed",
      count: labels,
      note: "The newest labels the lot can no longer cover; a cancelled label cannot be scanned at dispatch.",
    });
    items.push({
      app: "ERP",
      label: `other ${many(others.length, "filling")} of FG run ${f.fgNum}`,
      effect: "kept",
      count: others.length,
      examples: others.slice(0, 5).map((o) => `${o.fg} · ${o.cans} cans`),
    });

    return {
      title: `FG filling ${f.lotCode} · ${x.fg} at ${x.godown}`,
      verb: "Delete",
      confirmWord: f.lotCode,
      items: present(items),
      blockers,
    };
  },
};

/* ============================================================== packing line */

export const packLineImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["packBatches"], onlyAdmin("packing line"));
  },

  async report(id) {
    const [x] = await db
      .select({ l: erpPackLines, sku: products.name, cpb: products.cansPerBox, godown: erpGodowns.name, empty: erpProductPacking.emptyBoxesRequired, boxType: erpProductPacking.boxType })
      .from(erpPackLines)
      .innerJoin(products, eq(products.id, erpPackLines.skuId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpPackLines.godownId))
      .leftJoin(erpProductPacking, eq(erpProductPacking.productId, erpPackLines.skuId))
      .where(eq(erpPackLines.id, id));
    if (!x) return null;
    const l = x.l;
    const [lines, [entry], [units]] = await Promise.all([
      db.select({ id: erpPackLines.id, cans: erpPackLines.cans, lot: erpPackLines.fgLotCode }).from(erpPackLines).where(eq(erpPackLines.batchNo, l.batchNo)).orderBy(asc(erpPackLines.createdAt)),
      db.select().from(erpPackEntries).where(and(eq(erpPackEntries.sourceType, "batch"), eq(erpPackEntries.sourceId, l.batchNo))),
      db.execute<{ n: number }>(sql`select count(*)::int as n from erp_units where lot_from = 'pack' and lot_code = ${l.batchNo} and status = 'available'`),
    ]);
    const others = lines.filter((o) => o.id !== id);
    const blockers: string[] = [];
    if (entry) {
      const stock = await packLotStock(l.batchNo, l.godownId);
      if (stock < Number(entry.boxes) - 1e-9) {
        blockers.push("Boxes of this batch have already moved on; the batch can no longer be taken apart.");
      }
    }
    const stillComplete = others.length > 0 && batchState(l.boxes, x.cpb ?? 1, others).complete;

    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `cans go back into FG lot ${l.fgLotCode}`,
        effect: "changed",
        count: l.cans,
      },
    ];
    if (entry && !stillComplete) {
      items.push({
        app: "ERP",
        label: `boxes of ${l.batchNo} leave packing stock — the batch is no longer complete`,
        effect: "deleted",
        count: Number(entry.boxes),
      });
      items.push({
        app: "ERP",
        label: `box ${many(Number(units?.n ?? 0), "id")} of ${l.batchNo} cancelled`,
        effect: "changed",
        count: Number(units?.n ?? 0),
        note: "A cancelled box label cannot be scanned at dispatch. Completing the batch again brings them back.",
      });
    }
    if (!others.length && (x.empty ?? 0) > 0 && x.boxType) {
      items.push({
        app: "ERP",
        label: `empty ${x.boxType} boxes go back into packing-material stock`,
        effect: "changed",
        count: l.boxes * (x.empty ?? 0),
      });
    }
    items.push({
      app: "ERP",
      label: `other ${many(others.length, "line")} of ${l.batchNo}`,
      effect: "kept",
      count: others.length,
      examples: others.slice(0, 5).map((o) => `${o.lot} · ${o.cans} cans`),
    });

    return {
      title: `${l.batchNo} · ${x.sku} · ${l.cans} cans from FG lot ${l.fgLotCode}`,
      verb: "Delete",
      confirmWord: l.batchNo,
      items: present(items),
      blockers,
    };
  },
};

