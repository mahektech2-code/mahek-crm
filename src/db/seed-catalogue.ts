import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { products, quickNotes } from "@/db/schema";
import { PRODUCTS, QUICK_NOTES } from "@/db/catalogue";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Seeds the product catalogue and the quick-note lists.
 *
 * Idempotent by design, and deliberately non-destructive: products are matched
 * on their external code and quick notes on (type, outcome, label), so
 * re-running never duplicates and never resets a usage count or wipes a note a
 * manager added. Migrations and `db:seed` both call it.
 */
export async function seedCatalogue(): Promise<{
  productsAdded: number;
  quickNotesAdded: number;
}> {
  const existingProducts = new Set(
    (await db.select({ code: products.externalCode }).from(products))
      .map((r) => r.code)
      .filter(Boolean) as string[],
  );

  let productsAdded = 0;
  for (const [i, p] of PRODUCTS.entries()) {
    if (existingProducts.has(p.externalCode)) continue;
    await db.insert(products).values({
      id: id("prd"),
      name: p.name,
      packSize: p.packSize,
      externalCode: p.externalCode,
      displayOrder: i,
    });
    productsAdded++;
  }

  const existingNotes = new Set(
    (
      await db
        .select({
          t: quickNotes.interactionType,
          o: quickNotes.outcome,
          l: quickNotes.label,
        })
        .from(quickNotes)
    ).map((r) => `${r.t}|${r.o ?? ""}|${r.l}`),
  );

  let quickNotesAdded = 0;
  for (const group of QUICK_NOTES) {
    for (const [i, label] of group.labels.entries()) {
      const key = `${group.interactionType}|${group.outcome ?? ""}|${label}`;
      if (existingNotes.has(key)) continue;
      await db.insert(quickNotes).values({
        id: id("qn"),
        interactionType: group.interactionType,
        outcome: group.outcome,
        label,
        displayOrder: i,
      });
      quickNotesAdded++;
    }
  }

  return { productsAdded, quickNotesAdded };
}

/** Reads the chips for one type and outcome, most-used first. */
export async function quickNotesFor(
  interactionType: "outbound_call" | "inbound_call" | "order_received",
  outcome: string | null,
) {
  return db
    .select()
    .from(quickNotes)
    .where(
      sql`${quickNotes.active} and ${quickNotes.interactionType} = ${interactionType}
          and ${outcome === null ? sql`${quickNotes.outcome} is null` : sql`${quickNotes.outcome} = ${outcome}`}`,
    )
    .orderBy(sql`${quickNotes.usageCount} desc, ${quickNotes.displayOrder} asc`);
}

export async function listActiveProducts() {
  return db
    .select()
    .from(products)
    .where(eq(products.active, true))
    .orderBy(products.displayOrder, products.name);
}
