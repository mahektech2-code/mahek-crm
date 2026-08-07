import "server-only";
import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import { helpArticles, products, quickNotes, waTemplates } from "@/db/schema";
import { ENTITY_COLLECTIONS } from "./presentation";

/* ---------------------------------------------------------------------------
 * The rows behind each declared collection.
 *
 * The console renders these; it does not know what any of them are. A
 * collection the CRM declares but does not yet store comes back empty with
 * `built: false`, and the screen says so rather than showing a blank list that
 * reads as a bug.
 * ------------------------------------------------------------------------- */

export type CollectionRow = {
  id: string;
  name: string;
  /** The dot-separated line under the name — pack, code, category, usage. */
  meta: string;
  active: boolean;
};

export type Collection = {
  key: string;
  rows: CollectionRow[];
  total: number;
  built: boolean;
};

/** How many rows a card shows before it stops being a list and becomes a wall. */
const PREVIEW = 8;

export async function listCollections(): Promise<Record<string, Collection>> {
  const [productRows, noteRows, templateRows, articleRows] = await Promise.all([
    db.select().from(products).orderBy(asc(products.displayOrder), asc(products.name)),
    db.select().from(quickNotes).orderBy(asc(quickNotes.interactionType), asc(quickNotes.displayOrder)),
    db.select().from(waTemplates).orderBy(desc(waTemplates.usageCount)),
    db.select().from(helpArticles).orderBy(asc(helpArticles.category), asc(helpArticles.title)),
  ]);

  const built: Record<string, CollectionRow[]> = {
    products: productRows.map((p) => ({
      id: p.id,
      name: p.name,
      meta: [p.packSize, p.externalCode].filter(Boolean).join(" · "),
      active: p.active,
    })),
    notes: noteRows.map((n) => ({
      id: n.id,
      name: n.label,
      meta: [
        n.interactionType.replace(/_/g, " "),
        n.outcome?.replace(/_/g, " "),
        n.usageCount ? `${n.usageCount} uses` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      active: n.active,
    })),
    templates: templateRows.map((t) => ({
      id: t.id,
      name: t.name,
      meta: [
        t.category.replace(/_/g, " "),
        t.escalationStage ? `stage ${t.escalationStage}` : null,
        t.usageCount ? `${t.usageCount} uses` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      active: t.active,
    })),
    help: articleRows.map((a) => ({
      id: a.id,
      name: a.title,
      meta: [a.category, a.type, (a.roles ?? []).join(", ")].filter(Boolean).join(" · "),
      active: a.active,
    })),
  };

  const out: Record<string, Collection> = {};
  for (const c of ENTITY_COLLECTIONS) {
    const rows = built[c.key] ?? [];
    out[c.key] = {
      key: c.key,
      rows: rows.slice(0, PREVIEW),
      total: rows.length,
      built: c.built,
    };
  }
  return out;
}
