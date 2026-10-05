import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { erpRawMaterials, erpRecipes, productFormulations, users } from "@/db/schema";
import { err, fieldErr, okVoid } from "@/lib/result";
import { erpAudit, erpId, num, stampLine, text, type ScreenModule } from "../server";
import type { ColSpec, ListRow } from "../ui";
import { nf } from "../ui";
import { sfgForm } from "./production";

/* ---------------------------------------------------------------------------
 * RECIPES: how much of each raw material one batch of an SFG product takes.
 *
 * New — Mahek Plus had none, so every batch was typed from scratch and nothing
 * could say one had used more than it should. A recipe does two things and
 * refuses nothing: "Start a batch" opens a new SFG batch with its lines already
 * listed (the lots are still picked by the person, from what is at the
 * godown), and the SFG batches list flags a line that used more than the
 * recipe allows. Writing one is a production decision, so it needs the ERP's
 * manager level; reading it is open to whoever holds the screen.
 *
 * A recipe is in LITRES, whatever unit the raw material is bought in. It is
 * compared against SFG batch lines and prefills them, and those are litres —
 * so a recipe line shown in the material's own Kg would be a number in one
 * unit flagged against a number in another.
 * ------------------------------------------------------------------------- */

type Row = { r: typeof erpRecipes.$inferSelect; product: string; item: string; by: string | null };

async function recipeRows(): Promise<Row[]> {
  return db
    .select({ r: erpRecipes, product: productFormulations.name, item: erpRawMaterials.name, by: users.name })
    .from(erpRecipes)
    .innerJoin(productFormulations, eq(productFormulations.id, erpRecipes.formulationId))
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRecipes.rawMaterialId))
    .leftJoin(users, eq(users.id, erpRecipes.updatedById))
    .orderBy(asc(productFormulations.name), asc(erpRawMaterials.name));
}

/** Every recipe line, keyed `formulationId|rawMaterialId` — what the batches list checks against. */
export async function recipeMap(): Promise<Map<string, number>> {
  const rows = await db.select().from(erpRecipes);
  return new Map(rows.map((r) => [`${r.formulationId}|${r.rawMaterialId}`, Number(r.qtyPerBatch)]));
}

/** Litres per batch keyed `product name|raw material name` — what a new SFG batch line fills its quantity from. */
export async function recipeQtyByName(): Promise<Record<string, string>> {
  const rows = await recipeRows();
  return Object.fromEntries(rows.map((r) => [`${r.product}|${r.item}`, String(Number(r.r.qtyPerBatch))]));
}

const mayWrite = (ctx: { administrator: boolean; level: string | null }) => ctx.administrator || ctx.level === "manager";

export const recipesScreen: ScreenModule = {
  key: "recipes",
  async load(ctx) {
    const [rows, forms, mats] = await Promise.all([
      recipeRows(),
      db.select({ name: productFormulations.name }).from(productFormulations).where(eq(productFormulations.active, true)).orderBy(asc(productFormulations.name)),
      db.select({ name: erpRawMaterials.name, type: erpRawMaterials.materialType }).from(erpRawMaterials).where(eq(erpRawMaterials.active, true)).orderBy(asc(erpRawMaterials.name)),
    ]);
    const writer = mayWrite(ctx);
    const why = writer ? "" : "A manager sets a recipe";
    const cols: ColSpec[] = [
      { k: "product", l: "SFG product", t: "b" },
      { k: "item", l: "Raw material", t: "t" },
      { k: "qty", l: "Per batch (Ltr)", t: "n" },
      { k: "note", l: "Note", t: "t" },
    ];
    const byProduct = new Map<string, Row[]>();
    rows.forEach((x) => byProduct.set(x.product, [...(byProduct.get(x.product) ?? []), x]));
    return {
      spec: {
        screen: "recipes",
        cols,
        hidden: [],
        groups: ["product"],
        readOnly: !writer,
        newForm: writer
          ? {
              screen: "recipes",
              id: "new",
              title: "Set a recipe",
              sub: "What one batch of the product takes, in litres — every raw material, including one bought in Kg. Saving a raw material the product already has replaces its quantity.",
              submit: "Save recipe",
              lineLabel: "Raw material (litres)",
              header: [{ k: "product", l: "SFG product", t: "select", req: true, opts: forms.map((f) => f.name) }],
              line: [
                { k: "item", l: "Raw material", t: "select", req: true, hint: "Quantities on a recipe are always litres.", opts: mats.filter((m) => m.type !== "Can" && m.type !== "Box").map((m) => m.name) },
                { k: "qty", l: "Quantity per batch (litres)", t: "num", req: true, min: 0.001 },
                { k: "note", l: "Note", t: "text" },
              ],
            }
          : undefined,
        newLabel: "Set a recipe",
        noDataLine: "No recipes yet. A recipe lists, in litres, what one batch of an SFG product takes, so a batch can start from it and a heavy one is noticed.",
      },
      rows: rows.map(
        (x): ListRow => ({
          id: x.r.id,
          v: { product: x.product, item: x.item, qty: Number(x.r.qtyPerBatch), note: x.r.note },
          flags: [],
          title: `${x.product} · ${x.item}`,
          header: `${nf(Number(x.r.qtyPerBatch))} Ltr per batch`,
          actions: [
            { id: "start", l: "Start a batch", primary: true, loadsForm: true },
            {
              id: "qty",
              l: "Change quantity",
              why,
              prompt: { title: "Quantity per batch (litres)", sub: `${x.product} · ${x.item} · in litres`, submit: "Save", fields: [{ k: "qty", l: "Quantity per batch (litres)", t: "num", req: true, min: 0.001 }], init: { qty: String(x.r.qtyPerBatch) } },
            },
            { id: "remove", l: "Remove from recipe", why, confirm: `Take ${x.item} out of ${x.product}'s recipe?` },
          ],
          fields: [{ l: "Unit", v: "Litres (Ltr)" }, { l: "The whole recipe (litres per batch)", v: (byProduct.get(x.product) ?? []).map((y) => `${y.item} ${nf(Number(y.r.qtyPerBatch))} Ltr`).join(" · ") }],
          by: stampLine(x.by, x.r.updatedAt).replace(/^Created/, "Set"),
        }),
      ),
    };
  },
  formLoaders: {
    /* The SFG batch form, with the product and the recipe's lines in it. */
    async start(ctx, id) {
      const [x] = (await recipeRows()).filter((r) => r.r.id === id);
      if (!x) return null;
      const lines = (await recipeRows()).filter((r) => r.r.formulationId === x.r.formulationId);
      const base = await sfgForm(ctx);
      return {
        ...base,
        title: `New SFG batch · ${x.product}`,
        sub: "From the recipe, in litres. Pick the lot for each raw material from what is at the godown; change a quantity if this batch is different.",
        init: { ...base.init, product: x.product, batches: "1" },
        initLines: lines.map((r) => ({ item: r.item, qty: String(r.r.qtyPerBatch) })),
      };
    },
  },
  forms: {
    async new(ctx, h, ls) {
      if (!mayWrite(ctx)) return err("A manager sets a recipe.", "not_permitted");
      const [f] = await db.select({ id: productFormulations.id }).from(productFormulations).where(eq(productFormulations.name, text(h.product) ?? ""));
      if (!f) return fieldErr("product", "Pick the SFG product");
      if (!ls.length) return err("Add at least one raw material.");
      const mats = await db.select({ id: erpRawMaterials.id, name: erpRawMaterials.name }).from(erpRawMaterials);
      const parsed: { id: string; qty: number; note: string | null }[] = [];
      for (let i = 0; i < ls.length; i++) {
        const m = mats.find((x) => x.name === ls[i].item);
        if (!m) return fieldErr(`l${i}.item`, "Pick a raw material");
        const qty = num(ls[i].qty);
        if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, "Quantity per batch, in litres, is required");
        parsed.push({ id: m.id, qty, note: text(ls[i].note) });
      }
      await db.transaction(async (tx) => {
        for (const p of parsed)
          await tx
            .insert(erpRecipes)
            .values({ id: erpId("rcp"), formulationId: f.id, rawMaterialId: p.id, qtyPerBatch: p.qty, note: p.note, createdById: ctx.user.id, updatedById: ctx.user.id })
            .onConflictDoUpdate({ target: [erpRecipes.formulationId, erpRecipes.rawMaterialId], set: { qtyPerBatch: p.qty, note: p.note, updatedAt: new Date(), updatedById: ctx.user.id } });
      });
      await erpAudit(ctx, "erp.recipe.set", "erp_recipe", f.id, null, { product: h.product, lines: parsed.length });
      return okVoid(`Recipe for ${h.product} saved in litres · ${parsed.length} raw material${parsed.length === 1 ? "" : "s"}`);
    },
  },
  actions: {
    async qty(ctx, id, v) {
      if (!mayWrite(ctx)) return err("A manager sets a recipe.", "not_permitted");
      const qty = num(v.qty);
      if (qty == null || qty <= 0) return fieldErr("qty", "Quantity per batch, in litres, is required");
      const res = await db.update(erpRecipes).set({ qtyPerBatch: qty, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRecipes.id, id)).returning({ id: erpRecipes.id });
      if (!res.length) return err("That recipe line no longer exists.", "not_found");
      await erpAudit(ctx, "erp.recipe.qty", "erp_recipe", id, null, { qty });
      return okVoid(`Recipe updated · ${nf(qty)} Ltr per batch`);
    },
    async remove(ctx, id) {
      if (!mayWrite(ctx)) return err("A manager sets a recipe.", "not_permitted");
      const [r] = await db.select().from(erpRecipes).where(and(eq(erpRecipes.id, id)));
      if (!r) return err("That recipe line no longer exists.", "not_found");
      await db.delete(erpRecipes).where(eq(erpRecipes.id, id));
      await erpAudit(ctx, "erp.recipe.remove", "erp_recipe", id, r, null);
      return okVoid("Taken out of the recipe");
    },
  },
};
