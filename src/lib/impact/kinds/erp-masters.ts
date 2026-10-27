import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  erpFgLevels,
  erpGodowns,
  erpMaterialGroups,
  erpRawMaterials,
  erpRecipes,
  erpRmLevels,
  erpVideos,
  productFormulations,
  products,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { addDaysIso } from "@/lib/erp/engines/sales";
import { isErpManager, today } from "@/lib/erp/screens/common";
import { fgReorderRows, rmReorderRows } from "@/lib/erp/screens/movement";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * The ERP's reference rows: re-order levels, can groups, recipe lines and help
 * videos. None of these moves stock, which is exactly why a delete of one is
 * pressed lightly — and each still reaches further than its row: a level is
 * what an open requirement's "present quantity" is read against and what the
 * nightly planner rewrites; a can group carries the photos the floor
 * recognises cans by; a recipe line is the batch sheet on the Factory phones.
 * ------------------------------------------------------------------------- */

/** Requirements still being bought — the ones whose "present quantity" a level answers. */
const OPEN_REQUIREMENT = sql`status in ('Pending', 'Order Placed', 'Booked')`;

/* ================================================================ levels */

export const rmLevelImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["rmLevels"]);
  },

  async report(id) {
    const [x] = await db
      .select({ l: erpRmLevels, item: erpRawMaterials.name, itemActive: erpRawMaterials.active, type: erpRawMaterials.materialType, godown: erpGodowns.name, godownActive: erpGodowns.status, reserved: erpGodowns.reserved })
      .from(erpRmLevels)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRmLevels.rawMaterialId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpRmLevels.godownId))
      .where(eq(erpRmLevels.id, id));
    if (!x) return null;
    const l = x.l;
    const c = await getConfig();
    const since = addDaysIso(today(), -365 * c["erp.levels.historyYears"]);
    const [reorder, reqs, history] = await Promise.all([
      rmReorderRows(),
      db.execute<{ n: number; nos: string[] | null }>(sql`
        select count(*)::int as n, (array_agg(coalesce(req_no::text, '—') order by req_date desc))[1:5] as nos
          from erp_requisitions
         where raw_material_id = ${l.rawMaterialId} and godown_id = ${l.godownId} and ${OPEN_REQUIREMENT}`),
      /* The planner's own reading of "used or bought here" (`level-planner.ts` history()). */
      db.execute<{ yes: boolean }>(sql`
        select (
          exists (select 1 from erp_sfg_lines where raw_material_id = ${l.rawMaterialId} and godown_id = ${l.godownId} and batch_date >= ${since})
          or exists (select 1 from erp_fg_fills where can_use_id = ${l.rawMaterialId} and godown_id = ${l.godownId} and fill_date >= ${since})
          or exists (select 1 from erp_rm_entries where source_type = 'purchase' and raw_material_id = ${l.rawMaterialId} and godown_id = ${l.godownId} and entry_date >= ${since})
          or exists (
            select 1 from erp_pack_lines pl
              join erp_product_packing pk on pk.product_id = pl.sku_id
              join erp_raw_materials m on lower(m.name) = lower(pk.box_type)
             where m.id = ${l.rawMaterialId} and pl.godown_id = ${l.godownId} and pl.pack_date >= ${since})
        ) as yes`),
    ]);
    const onList = reorder.some((r) => r.id === id);
    const open = Number(reqs[0]?.n ?? 0);
    const replanned =
      c["erp.levels.autoPlan"] && x.itemActive && x.type !== "Drum" && x.godownActive === "active" && !x.reserved && Boolean(history[0]?.yes);

    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `line on Re-order raw items`,
        effect: "deleted",
        count: onList ? 1 : 0,
        note: `${x.item} is below its minimum at ${x.godown} today; with no level it leaves the list and the dashboard's count of items to re-order.`,
      },
      {
        app: "ERP",
        label: `open ${many(open, "requirement")} for ${x.item} at ${x.godown}`,
        effect: "changed",
        count: open,
        examples: (reqs[0]?.nos ?? []).map((n) => `Requirement ${n}`),
        note: "Their present quantity reads “no level set”, and a stock check reads no level beside the count.",
      },
    ];
    if (replanned) {
      items.push({
        app: "ERP",
        label: "level set again by tonight's planner",
        effect: "changed",
        count: 1,
        note: `${x.item} is used or bought at ${x.godown}, so the nightly level planner creates a level for it again. To stop re-ordering it, set this level's status to UnFollow instead of deleting it.`,
      });
    }

    return {
      title: `the level for ${x.item} at ${x.godown} (min ${l.minQty}, max ${l.maxQty})`,
      verb: "Delete",
      confirmWord: x.item,
      items: present(items),
      blockers: [],
    };
  },
};

export const fgLevelImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["fgLevels"]);
  },

  async report(id) {
    const [x] = await db
      .select({ l: erpFgLevels, sku: products.name, godown: erpGodowns.name })
      .from(erpFgLevels)
      .innerJoin(products, eq(products.id, erpFgLevels.productId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpFgLevels.godownId))
      .where(eq(erpFgLevels.id, id));
    if (!x) return null;
    const l = x.l;
    const [reorder, reqs] = await Promise.all([
      fgReorderRows(),
      db.execute<{ n: number; nos: string[] | null }>(sql`
        select count(*)::int as n, (array_agg(coalesce(req_no::text, '—') order by req_date desc))[1:5] as nos
          from erp_requisitions
         where product_id = ${l.productId} and godown_id = ${l.godownId} and ${OPEN_REQUIREMENT}`),
    ]);
    const open = Number(reqs[0]?.n ?? 0);
    return {
      title: `the level for ${x.sku} at ${x.godown} (min ${l.minQty})`,
      verb: "Delete",
      confirmWord: x.sku,
      items: present([
        {
          app: "ERP",
          label: "line on Re-order finished goods",
          effect: "deleted",
          count: reorder.some((r) => r.id === id) ? 1 : 0,
          note: `${x.sku} is below its minimum at ${x.godown} today; with no level it leaves the list and the dashboard's count of goods below minimum.`,
        },
        {
          app: "ERP",
          label: `open ${many(open, "requirement")} for ${x.sku} at ${x.godown}`,
          effect: "changed",
          count: open,
          examples: (reqs[0]?.nos ?? []).map((n) => `Requirement ${n}`),
          note: "Their present quantity reads “no level set”.",
        },
      ]),
      blockers: [],
    };
  },
};

/* ============================================================= can group */

export const canGroupImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["canGroups", "rawMaterials"]);
  },

  async report(id) {
    const [g] = await db.select().from(erpMaterialGroups).where(eq(erpMaterialGroups.id, id));
    if (!g) return null;
    const members = await db
      .select({ id: erpRawMaterials.id, name: erpRawMaterials.name })
      .from(erpRawMaterials)
      .where(eq(erpRawMaterials.groupId, id))
      .orderBy(asc(erpRawMaterials.name));
    const ids = members.map((m) => m.id);
    const [photos, own, reqs] = await Promise.all([
      db.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.parentType, "erp_material_group"), eq(attachments.parentId, id), eq(attachments.status, "available"))),
      ids.length
        ? db.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.parentType, "erp_raw_material"), inArray(attachments.parentId, ids), eq(attachments.status, "available")))
        : Promise.resolve([]),
      ids.length
        ? db.execute<{ n: number }>(sql`select count(*)::int as n from erp_requisitions where raw_material_id in ${ids} and ${OPEN_REQUIREMENT}`)
        : Promise.resolve([{ n: 0 }]),
    ]);
    const open = Number(reqs[0]?.n ?? 0);
    return {
      title: `can group ${g.name}`,
      verb: "Delete",
      confirmWord: g.name,
      items: present([
        {
          app: "ERP",
          label: `group ${many(photos.length, "photo")} taken off`,
          effect: "deleted",
          count: photos.length,
          note: "Marked removed, like every photo taken off a record — the floor stops seeing them on the group's card.",
        },
        {
          app: "ERP",
          label: many(members.length, "can"),
          effect: "unlinked",
          count: members.length,
          examples: members.slice(0, 5).map((m) => m.name),
          note: "They stay on the books, just not in a group. “Group cans by name” may put them into a new one.",
        },
        {
          app: "ERP",
          label: `${many(own.length, "photo")} on the cans themselves`,
          effect: "kept",
          count: own.length,
        },
        {
          app: "ERP",
          label: `open ${many(open, "requirement")} for these cans`,
          effect: "kept",
          count: open,
          note: "Requirements and purchase orders name the can, never its group, so nothing being bought changes.",
        },
      ]),
      blockers: [],
    };
  },
};

/* =========================================================== recipe line */

export const recipeLineImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["recipes"], (ctx) => (isErpManager(ctx) ? null : "A manager sets a recipe."));
  },

  async report(id) {
    const [x] = await db
      .select({ r: erpRecipes, product: productFormulations.name, item: erpRawMaterials.name })
      .from(erpRecipes)
      .innerJoin(productFormulations, eq(productFormulations.id, erpRecipes.formulationId))
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRecipes.rawMaterialId))
      .where(eq(erpRecipes.id, id));
    if (!x) return null;
    const r = x.r;
    const [rest, used, jobs] = await Promise.all([
      db
        .select({ item: erpRawMaterials.name, qty: erpRecipes.qtyPerBatch })
        .from(erpRecipes)
        .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRecipes.rawMaterialId))
        .where(and(eq(erpRecipes.formulationId, r.formulationId), ne(erpRecipes.id, id)))
        .orderBy(asc(erpRawMaterials.name)),
      db.execute<{ n: number }>(
        sql`select count(distinct sfg_no)::int as n from erp_sfg_lines where formulation_id = ${r.formulationId} and raw_material_id = ${r.rawMaterialId}`,
      ),
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from factory_tasks where proc = 'mixing' and status = 'ready' and item = ${r.formulationId}`,
      ),
    ]);
    const last = rest.length === 0;
    const batches = Number(used[0]?.n ?? 0);
    const waiting = Number(jobs[0]?.n ?? 0);
    const items: ImpactItem[] = [
      {
        app: "Factory",
        label: `batch sheet for ${x.product} on the floor's phones`,
        effect: "changed",
        count: 1,
        note: last
          ? `${x.item} was its only line: with no recipe left the floor can no longer start a mixing batch of ${x.product}.`
          : `It no longer lists ${x.item}; the other ${rest.length} ${many(rest.length, "line")} stay.`,
      },
      {
        app: "Factory",
        label: `mixing ${many(waiting, "job")} for ${x.product} waiting to start`,
        effect: "changed",
        count: waiting,
        note: `They are mixed from the batch sheet as it stands when they start, without ${x.item}.`,
      },
      {
        app: "ERP",
        label: `SFG ${many(batches, "batch", "batches")} of ${x.product} that used ${x.item}`,
        effect: "kept",
        count: batches,
        note: "Their lines stay exactly as made; they are simply no longer checked against a recipe quantity for it.",
      },
      {
        app: "ERP",
        label: `other ${many(rest.length, "line")} of ${x.product}'s recipe`,
        effect: "kept",
        count: rest.length,
        examples: rest.slice(0, 5).map((o) => `${o.item} ${Number(o.qty)} L`),
      },
    ];
    return {
      title: `${x.item} from ${x.product}'s recipe (${Number(r.qtyPerBatch)} L per batch)`,
      verb: "Remove",
      confirmWord: x.item,
      items: present(items),
      blockers: [],
    };
  },
};

/* ================================================================= video */

export const videoImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["videos"], (ctx) => (isErpManager(ctx) ? null : "A manager removes help videos."));
  },

  async report(id) {
    const [v] = await db.select().from(erpVideos).where(eq(erpVideos.id, id));
    if (!v) return null;
    const [file] = v.fileId
      ? await db.select({ id: attachments.id, name: attachments.filename }).from(attachments).where(and(eq(attachments.id, v.fileId), eq(attachments.status, "available")))
      : [];
    return {
      title: `help video “${v.title}”`,
      verb: "Remove",
      confirmWord: v.title,
      items: present([
        {
          app: "ERP",
          label: "uploaded video file taken off",
          effect: "deleted",
          count: file ? 1 : 0,
          examples: file ? [file.name] : undefined,
          note: "Marked removed with the video, so it is not left behind with nothing pointing at it.",
        },
        ...(v.source === "youtube"
          ? [{ app: "ERP", label: "video on YouTube", effect: "kept" as const, count: 1, note: "Only the link here goes; the video itself stays wherever it is published." }]
          : []),
      ]),
      blockers: [],
    };
  },
};
