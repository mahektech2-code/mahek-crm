import "server-only";
import { isErpManager } from "./common";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { erpRawMaterials, erpRecipes, productFormulations, users } from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { erpAudit, erpId, num, stampLine, text, type ScreenModule } from "../server";
import type { ColSpec, FieldSpec, FormSpec, ListRow } from "../ui";
import { nf } from "../ui";
import { sfgForm } from "./production";
import { confirmImpact } from "@/lib/impact/registry";
import { readConfirmation } from "@/lib/impact/types";

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

/**
 * Each product's recipe as the lines of a new SFG batch, keyed by product name —
 * what picking the product on a blank batch lays out, the same lines "Start a
 * batch" opens with. The lots are still the person's to pick.
 */
export async function recipeLinesByProduct(): Promise<Record<string, Record<string, string>[]>> {
  const out: Record<string, Record<string, string>[]> = {};
  for (const r of await recipeRows()) (out[r.product] ??= []).push({ item: r.item, qty: String(Number(r.r.qtyPerBatch)) });
  return out;
}

const mayWrite = isErpManager;

/* What a recipe's lines are picked from: active raw materials that are not cans or boxes. */
async function recipeChoices() {
  const [forms, mats] = await Promise.all([
    db.select({ name: productFormulations.name }).from(productFormulations).where(eq(productFormulations.active, true)).orderBy(asc(productFormulations.name)),
    db.select({ name: erpRawMaterials.name, type: erpRawMaterials.materialType }).from(erpRawMaterials).where(eq(erpRawMaterials.active, true)).orderBy(asc(erpRawMaterials.name)),
  ]);
  return { products: forms.map((f) => f.name), items: mats.filter((m) => m.type !== "Can" && m.type !== "Box").map((m) => m.name) };
}

function recipeLine(items: string[]): FieldSpec[] {
  return [
    { k: "item", l: "Raw material", t: "select", req: true, hint: "Quantities on a recipe are always litres.", opts: items },
    { k: "qty", l: "Quantity per batch (litres)", t: "num", req: true, min: 0.001 },
    { k: "note", l: "Note", t: "text" },
  ];
}

/**
 * THE WHOLE RECIPE, IN ONE FORM. Changing one used to be a line at a time —
 * Change quantity, Remove from recipe, or Set a recipe again to add one —
 * with nowhere showing the recipe being edited as a whole. This form opens
 * with every line in it: change a quantity, add a material, take one out,
 * and Save writes exactly what the form shows.
 */
async function editForm(id: string): Promise<FormSpec | null> {
  const [x] = await db
    .select({ formulationId: erpRecipes.formulationId, product: productFormulations.name })
    .from(erpRecipes)
    .innerJoin(productFormulations, eq(productFormulations.id, erpRecipes.formulationId))
    .where(eq(erpRecipes.id, id));
  if (!x) return null;
  const [lines, { items }] = await Promise.all([
    db
      .select({ item: erpRawMaterials.name, qty: erpRecipes.qtyPerBatch, note: erpRecipes.note })
      .from(erpRecipes)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRecipes.rawMaterialId))
      .where(eq(erpRecipes.formulationId, x.formulationId))
      .orderBy(asc(erpRecipes.createdAt), asc(erpRawMaterials.name)),
    recipeChoices(),
  ]);
  /* A line on a material since made inactive still opens with its name, or the form would drop it unseen. */
  const opts = [...new Set([...items, ...lines.map((l) => l.item)])];
  return {
    screen: "recipes",
    id: "edit",
    recordId: id,
    title: `Edit recipe · ${x.product}`,
    sub: "Every raw material one batch takes, in litres. Change, add or remove lines — Save writes the recipe exactly as shown here, and the batch sheet on the Factory phones follows it.",
    submit: "Save recipe",
    lineLabel: "Raw material (litres)",
    header: [{ k: "product", l: "SFG product", t: "select", opts: [x.product], readOnly: true }],
    line: recipeLine(opts),
    init: { product: x.product },
    initLines: lines.map((l) => ({ item: l.item, qty: String(Number(l.qty)), note: l.note ?? "" })),
  };
}

type Parsed = { id: string; name: string; qty: number; note: string | null };

/** A recipe's lines as typed: each a known raw material, once, with litres above zero. */
async function parseLines(ls: Record<string, string>[]): Promise<Result<Parsed[]>> {
  if (!ls.length) return err("Add at least one raw material.");
  const mats = await db.select({ id: erpRawMaterials.id, name: erpRawMaterials.name }).from(erpRawMaterials);
  const out: Parsed[] = [];
  for (let i = 0; i < ls.length; i++) {
    const m = mats.find((x) => x.name === ls[i].item);
    if (!m) return fieldErr(`l${i}.item`, "Pick a raw material");
    if (out.some((p) => p.id === m.id)) return fieldErr(`l${i}.item`, `${m.name} is already on this recipe — one line per raw material`);
    const qty = num(ls[i].qty);
    if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, "Quantity per batch, in litres, is required");
    out.push({ id: m.id, name: m.name, qty, note: text(ls[i].note) });
  }
  return ok(out);
}

export const recipesScreen: ScreenModule = {
  key: "recipes",
  async load(ctx) {
    const [rows, choices] = await Promise.all([recipeRows(), recipeChoices()]);
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
        filters: ["product", "item"],
        hidden: [],
        groups: ["product"],
        readOnly: !writer,
        newForm: writer
          ? {
              screen: "recipes",
              id: "new",
              title: "Set a recipe",
              sub: "What one batch takes, in litres, for every raw material.",
              submit: "Save recipe",
              lineLabel: "Raw material (litres)",
              header: [{ k: "product", l: "SFG product", t: "select", req: true, opts: choices.products }],
              line: recipeLine(choices.items),
            }
          : undefined,
        newLabel: "Set a recipe",
        noDataLine: "No recipes yet. A recipe is what one batch of an SFG product takes, in litres.",
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
            { id: "edit", l: "Edit recipe", why, loadsForm: true },
            {
              id: "qty",
              l: "Change quantity",
              why,
              prompt: { title: "Quantity per batch (litres)", sub: `${x.product} · ${x.item} · in litres`, submit: "Save", fields: [{ k: "qty", l: "Quantity per batch (litres)", t: "num", req: true, min: 0.001 }], init: { qty: String(x.r.qtyPerBatch) } },
            },
            { id: "remove", l: "Remove from recipe", why, impact: { kind: "erp-recipe-line", id: x.r.id } },
          ],
          fields: [{ l: "Unit", v: "Litres (Ltr)" }, { l: "The whole recipe (litres per batch)", v: (byProduct.get(x.product) ?? []).map((y) => `${y.item} ${nf(Number(y.r.qtyPerBatch))} Ltr`).join(" · ") }],
          by: stampLine(x.by, x.r.updatedAt).replace(/^Created/, "Set"),
        }),
      ),
    };
  },
  formLoaders: {
    edit: async (ctx, id) => (mayWrite(ctx) ? editForm(id) : null),
    /* The SFG batch form, with the product and the recipe's lines in it. */
    async start(ctx, id) {
      const [x] = (await recipeRows()).filter((r) => r.r.id === id);
      if (!x) return null;
      const lines = (await recipeRows()).filter((r) => r.r.formulationId === x.r.formulationId);
      const base = await sfgForm(ctx);
      return {
        ...base,
        title: `New SFG batch · ${x.product}`,
        sub: "Quantities come from the recipe, in litres. Pick a lot for each raw material.",
        init: { ...base.init, product: x.product, batches: "1" },
        initLines: lines.map((r) => ({ item: r.item, qty: String(Number(r.r.qtyPerBatch)) })),
      };
    },
  },
  forms: {
    async new(ctx, h, ls) {
      if (!mayWrite(ctx)) return err("A manager sets a recipe.", "not_permitted");
      const [f] = await db.select({ id: productFormulations.id }).from(productFormulations).where(eq(productFormulations.name, text(h.product) ?? ""));
      if (!f) return fieldErr("product", "Pick the SFG product");
      const lines = await parseLines(ls);
      if (!lines.ok) return lines;
      const parsed = lines.data;
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
    /* The whole recipe as the form shows it: lines kept or changed, lines added, and the lines no longer in the form taken out. */
    async edit(ctx, _h, ls, id) {
      if (!mayWrite(ctx)) return err("A manager sets a recipe.", "not_permitted");
      if (!id) return err("That recipe no longer exists.", "not_found");
      const [anchor] = await db
        .select({ formulationId: erpRecipes.formulationId, product: productFormulations.name })
        .from(erpRecipes)
        .innerJoin(productFormulations, eq(productFormulations.id, erpRecipes.formulationId))
        .where(eq(erpRecipes.id, id));
      if (!anchor) return err("That recipe line was removed while the form was open. Close it and open the recipe again.", "not_found");
      const lines = await parseLines(ls);
      if (!lines.ok) return lines;
      const parsed = lines.data;
      const before = await db
        .select({ id: erpRecipes.id, rawMaterialId: erpRecipes.rawMaterialId, item: erpRawMaterials.name, qty: erpRecipes.qtyPerBatch, note: erpRecipes.note })
        .from(erpRecipes)
        .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRecipes.rawMaterialId))
        .where(eq(erpRecipes.formulationId, anchor.formulationId));
      const keep = parsed.map((p) => p.id);
      const removed = before.filter((b) => !keep.includes(b.rawMaterialId));
      const added = parsed.filter((p) => !before.some((b) => b.rawMaterialId === p.id));
      const changed = parsed.filter((p) => before.some((b) => b.rawMaterialId === p.id && (Number(b.qty) !== p.qty || (b.note ?? null) !== p.note)));
      if (!removed.length && !added.length && !changed.length) return okVoid("Nothing changed");
      await db.transaction(async (tx) => {
        if (removed.length) await tx.delete(erpRecipes).where(and(eq(erpRecipes.formulationId, anchor.formulationId), inArray(erpRecipes.id, removed.map((r) => r.id)), notInArray(erpRecipes.rawMaterialId, keep)));
        for (const p of parsed)
          await tx
            .insert(erpRecipes)
            .values({ id: erpId("rcp"), formulationId: anchor.formulationId, rawMaterialId: p.id, qtyPerBatch: p.qty, note: p.note, createdById: ctx.user.id, updatedById: ctx.user.id })
            .onConflictDoUpdate({ target: [erpRecipes.formulationId, erpRecipes.rawMaterialId], set: { qtyPerBatch: p.qty, note: p.note, updatedAt: new Date(), updatedById: ctx.user.id } });
      });
      await erpAudit(
        ctx,
        "erp.recipe.edit",
        "erp_recipe",
        anchor.formulationId,
        { product: anchor.product, lines: before.map((b) => ({ item: b.item, qty: Number(b.qty), note: b.note })) },
        { product: anchor.product, lines: parsed.map((p) => ({ item: p.name, qty: p.qty, note: p.note })) },
      );
      const said = [
        changed.length ? `${changed.length} changed` : "",
        added.length ? `${added.map((a) => a.name).join(", ")} added` : "",
        removed.length ? `${removed.map((r) => r.item).join(", ")} taken out` : "",
      ].filter(Boolean);
      return okVoid(`Recipe for ${anchor.product} saved · ${said.join(" · ")}`);
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
    async remove(ctx, id, values) {
      if (!mayWrite(ctx)) return err("A manager sets a recipe.", "not_permitted");
      const [r] = await db.select().from(erpRecipes).where(and(eq(erpRecipes.id, id)));
      if (!r) return err("That recipe line no longer exists.", "not_found");
      /* A recipe line is the batch sheet on the Factory phones too: the modal says what that changes. */
      const refusal = await confirmImpact("erp-recipe-line", id, readConfirmation(values));
      if (refusal) return refusal;
      await db.delete(erpRecipes).where(eq(erpRecipes.id, id));
      await erpAudit(ctx, "erp.recipe.remove", "erp_recipe", id, r, null);
      return okVoid("Taken out of the recipe");
    },
  },
};
