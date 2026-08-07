import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { quickNotes } from "@/db/schema";
import { QUICK_NOTES } from "@/db/catalogue";
import { importCatalogue } from "@/lib/services/catalogue-import";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Seeds the product catalogue and the quick-note lists.
 *
 * Idempotent by design, and deliberately non-destructive: the catalogue import
 * matches on the canonical SKU name and quick notes on (type, outcome, label),
 * so re-running never duplicates and never resets a usage count or wipes a
 * note a manager added. Migrations and `db:seed` both call it.
 *
 * The products come from the real product master — four levels, 213 SKUs — via
 * the same import the Admin Console runs, so a seeded database and a migrated
 * one hold the same catalogue rather than two versions of it.
 */
export async function seedCatalogue(): Promise<{
  productsAdded: number;
  quickNotesAdded: number;
}> {
  const report = await importCatalogue();
  const productsAdded = report.created;

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
