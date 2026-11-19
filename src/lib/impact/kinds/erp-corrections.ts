import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpGodowns, erpRawMaterials, erpRecipes, erpTransfers, productFormulations } from "@/db/schema";
import { isErpManager } from "@/lib/erp/screens/common";
import { transferCancelPicture } from "@/lib/erp/screens/movement";
import { inwardVoidPicture, mayVoidInward, VOID_WHY } from "@/lib/erp/screens/purchase";
import { REF_LISTS, refValueUses } from "@/lib/erp/refs";
import { nf, readImpactPart } from "@/lib/erp/ui";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * CORRECTING A MISTAKE WITHOUT EDITING A BALANCE. Stock is read off the
 * documents that move it, so a mistaken transfer or delivery is put right by
 * taking the DOCUMENT back — and only while nothing downstream has read it as
 * stock. Each report names what goes, what moves back, and the one thing that
 * stops it, in the words the act refuses in (the act reads the same picture
 * again under the lots' locks).
 *
 * Retiring a recipe or a list value deletes nothing: it stops being offered,
 * and the records that already carry it keep it — which is the half people
 * get wrong, so it is said.
 * ------------------------------------------------------------------------- */

/* ========================================================== a transfer */

export const transferCancelImpact: ImpactSource = {
  authorize: async (id) => {
    const [t] = await db
      .select({ reserved: erpGodowns.reserved })
      .from(erpTransfers)
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpTransfers.toGodownId))
      .where(eq(erpTransfers.id, id));
    await erpMayDelete(["transfers"], (ctx) => (t?.reserved && !ctx.powers.has("lostStock") ? "Cancelling a write-off to Item Lost Record needs the lost-stock power." : null));
  },

  async report(id) {
    const p = await transferCancelPicture(db, id);
    if (!p) return null;
    const { t } = p;
    const boxes = p.lotFrom === "pack" ? "box" : "labelled can";
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: p.lost ? "write-off to Item Lost Record" : "transfer record",
        effect: "deleted",
        count: 1,
        note: `${nf(t.quantity)} ${p.unit} of ${t.itemName}, lot ${t.lotNo}, ${p.from} → ${p.to}, dated ${t.transferDate}. The audit log keeps it as it was.`,
      },
      {
        app: "ERP",
        label: `stock of lot ${t.lotNo} back at ${p.from}`,
        effect: "changed",
        count: 1,
        note: p.lost
          ? `The ${nf(t.quantity)} ${p.unit} written off are on the shelf at ${p.from} again.`
          : `${nf(t.quantity)} ${p.unit} leave ${p.to} and are at ${p.from} again, as though never moved.`,
      },
      {
        app: "ERP",
        label: `${many(p.units.length, boxes, `${boxes}s`)} back at ${p.from}`,
        effect: "changed",
        count: p.units.length,
        note: "Each gets a further event in its history — nothing it already records is rewritten.",
      },
    ];
    return {
      title: `${t.itemName} · ${nf(t.quantity)} ${p.unit} · ${p.from} → ${p.to}`,
      verb: p.lost ? "Cancel write-off" : "Cancel transfer",
      confirmWord: "CANCEL",
      items: present(items),
      blockers: p.blocker ? [p.blocker] : [],
    };
  },
};

/* ============================================================ an inward line */

export const inwardVoidImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["inward"], (ctx) => (mayVoidInward(ctx) ? null : VOID_WHY));
  },

  async report(id) {
    const p = await inwardVoidPicture(db, id);
    if (!p) return null;
    const { r } = p;
    const lotWords = p.lots.map((l) => `lot ${l.lotNo} · ${nf(l.quantity)} ${l.unit}`);
    const posted = p.lots.filter((l) => l.posted);
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: "goods inward line",
        effect: "deleted",
        count: 1,
        note: `PR ${r.prNumber} · ${p.item} from ${p.supplier}, ${nf(r.quantity)} ${r.unit} at ${p.godown}, received ${r.receivedDate}. The audit log keeps it, with your reason.`,
      },
      {
        app: "ERP",
        label: `purchase register ${many(p.lots.length, "lot")}`,
        effect: "deleted",
        count: p.lots.length,
        examples: lotWords,
        note: "Its rate, drums and bill fields go with it — nothing has been billed against it, or this would be refused.",
      },
      {
        app: "ERP",
        label: `raw-material stock ${many(posted.length, "entry", "entries")} at ${p.godown}`,
        effect: "deleted",
        count: posted.length,
        examples: posted.map((l) => `${nf(l.quantity)} ${l.unit} of lot ${l.lotNo}`),
        note: "The stock this delivery added leaves Stock on hand.",
      },
      {
        app: "ERP",
        label: `lot ${many(p.tests.length, "test")} not yet verified`,
        effect: "deleted",
        count: p.tests.length,
        note: "Any evidence recorded on it goes with it.",
      },
      {
        app: "ERP",
        label: `PO ${many(p.corrections.length, "correction")} this line made`,
        effect: "changed",
        count: p.corrections.length,
        examples: p.corrections.map((c) => `${c.kind === "extra" ? "+" : "−"}${nf(Math.abs(c.quantity))}`),
        note: "Cancelled with your reason and kept struck through; the PO's revision moves on.",
      },
      {
        app: "ERP",
        label: p.poNumber != null ? `received quantity on PO-${p.poNumber}` : "received quantity on its PO",
        effect: "changed",
        count: r.poId ? 1 : 0,
        note: `Falls by ${nf(r.quantity)} ${r.unit}; the PO's status and its requirements are worked out again, so it may be waiting for goods once more.`,
      },
      {
        app: "ERP",
        label: `other ${many(p.siblings, "line")} on PR ${r.prNumber}`,
        effect: "kept",
        count: p.siblings,
        note: p.siblings ? "With the PR's transport and other costs." : undefined,
      },
    ];
    return {
      title: `PR ${r.prNumber} · ${p.item} · ${nf(r.quantity)} ${r.unit}`,
      verb: "Void line",
      confirmWord: "VOID",
      items: present(items),
      blockers: p.blocker ? [p.blocker] : [],
    };
  },
};

/* ============================================================ a whole recipe */

export const recipeRetireImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["recipes"], (ctx) => (isErpManager(ctx) ? null : "A manager sets a recipe."));
  },

  async report(id) {
    const [x] = await db
      .select({ f: erpRecipes.formulationId, product: productFormulations.name, retired: erpRecipes.retiredAt })
      .from(erpRecipes)
      .innerJoin(productFormulations, eq(productFormulations.id, erpRecipes.formulationId))
      .where(eq(erpRecipes.id, id));
    if (!x) return null;
    const [lines, used, jobs] = await Promise.all([
      db
        .select({ item: erpRawMaterials.name, qty: erpRecipes.qtyPerBatch })
        .from(erpRecipes)
        .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRecipes.rawMaterialId))
        .where(and(eq(erpRecipes.formulationId, x.f), isNull(erpRecipes.retiredAt)))
        .orderBy(asc(erpRawMaterials.name)),
      db.execute<{ n: number }>(sql`select count(distinct sfg_no)::int as n from erp_sfg_lines where formulation_id = ${x.f}`),
      db.execute<{ n: number }>(sql`select count(*)::int as n from factory_tasks where proc = 'mixing' and status = 'ready' and item = ${x.f}`),
    ]);
    const batches = Number(used[0]?.n ?? 0);
    const waiting = Number(jobs[0]?.n ?? 0);
    return {
      title: `The recipe for ${x.product}`,
      verb: "Retire",
      confirmWord: x.product.length <= 40 ? x.product : "RETIRE",
      items: present([
        {
          app: "ERP",
          label: `recipe ${many(lines.length, "line")}, kept as they are`,
          effect: "changed",
          count: lines.length,
          examples: lines.slice(0, 5).map((l) => `${l.item} ${nf(Number(l.qty))} L`),
          note: "No longer prefill a new SFG batch, flag a line above them, or count in the MRP check. Restore brings them back unchanged.",
        },
        {
          app: "Factory",
          label: `batch sheet for ${x.product} on the floor's phones`,
          effect: "changed",
          count: lines.length ? 1 : 0,
          note: `It leaves the phones: no new mixing batch of ${x.product} can be started there until it is restored.`,
        },
        {
          app: "Factory",
          label: `mixing ${many(waiting, "job")} for ${x.product} waiting to start`,
          effect: "kept",
          count: waiting,
          note: "They stay on the list, with no batch sheet to mix from — finish or cancel them.",
        },
        {
          app: "ERP",
          label: `SFG ${many(batches, "batch", "batches")} of ${x.product} already made`,
          effect: "kept",
          count: batches,
          note: "Their lines stay exactly as made; they are simply no longer checked against a recipe.",
        },
      ]),
      blockers: x.retired ? ["That recipe is already retired."] : [],
    };
  },
};

/* ============================================================ a list value */

export const refValueRetireImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["refLists"]);
  },

  async report(id) {
    const part = readImpactPart(id);
    if (!part) return null;
    const [listKey, value] = part;
    const list = REF_LISTS.find((l) => l.key === listKey);
    if (!list || !value) return null;
    const [row] = (await db.execute(sql`select active from erp_ref_values where list_key = ${listKey} and value = ${value}`)) as unknown as { active: boolean }[];
    if (!row) return null;
    const uses = await refValueUses(listKey, value);
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `value stops being offered on new forms that pick a ${list.label.toLowerCase()}`,
        effect: "changed",
        count: row.active ? 1 : 0,
        note: "Restore a value brings it back.",
      },
      ...(uses ?? []).map(
        (u): ImpactItem => ({
          app: u.app,
          label: `${u.what} that carry “${value}”`,
          effect: "kept",
          count: u.n,
          note: "They keep it exactly as saved; an edit of one still shows it.",
        }),
      ),
    ];
    if (!uses)
      items.push({ app: "ERP", label: "records that already picked it", effect: "kept", count: 0, note: "Nothing reads this list's values off records by name; whatever carries it keeps it." });
    return {
      title: `“${value}” in ${list.label}`,
      verb: "Retire",
      confirmWord: value.length <= 40 ? value : "RETIRE",
      items: items.filter((i) => i.count > 0 || (i.effect === "kept" && !uses)),
      blockers: row.active ? [] : ["That value is already retired."],
    };
  },
};
