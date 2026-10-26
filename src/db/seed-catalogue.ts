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
export async function seedCatalogue(): Promise<SeedResult> {
  if (process.env.NODE_ENV !== "test") return seedFromSource();

  const empty = await seededTablesEmpty();
  if (empty && testSnapshot) {
    await restoreSnapshot(testSnapshot.rows);
    return { ...testSnapshot.result };
  }
  const result = await seedFromSource();
  if (empty) testSnapshot = { rows: await takeSnapshot(), result };
  return result;
}

type SeedResult = { productsAdded: number; quickNotesAdded: number };

/*
 * THE INTEGRATION SUITES RE-SEED BEFORE EVERY TEST, and this was the slow half.
 *
 * journeys.test.ts truncates the catalogue and calls this in its `beforeEach`,
 * so the 213-SKU import — four levels, one round trip per row — ran 398 times
 * per CI run, about a quarter of a second each, for a result that is the same
 * every time: the same source file into the same empty tables.
 *
 * So under `NODE_ENV=test` (the integration runner sets it), the first import
 * into EMPTY tables is done for real and its rows are kept in memory; the next
 * time the tables are empty again, the rows are copied back in one statement
 * per table instead. It is the same rows, ids included, so a test cannot tell
 * which happened — and `importCatalogue()` run afterwards finds every SKU
 * unchanged, exactly as it would after a real import.
 *
 * Only when ALL of these tables are empty. A suite that empties some of them
 * and not others, or none, gets the real import, which is what keeps this an
 * optimisation and never a different answer. The snapshot lives in the process
 * and the runner starts one process per file, so it cannot outlive the source
 * it was taken from. Production and development never reach any of this.
 */
const SEEDED_TABLES = [
  // In foreign-key order: each references only those before it.
  "product_formulations",
  "product_brands",
  "finished_goods",
  "products",
  "product_aliases",
  "catalogue_exceptions",
  "quick_notes",
] as const;

let testSnapshot: { rows: Record<string, string>; result: SeedResult } | null = null;

async function seededTablesEmpty(): Promise<boolean> {
  const any = SEEDED_TABLES.map((t) => `exists (select 1 from ${t})`).join(" or ");
  const [row] = (await db.execute(sql.raw(`select (${any}) as any`))) as unknown as Array<{ any: boolean }>;
  return !row.any;
}

async function takeSnapshot(): Promise<Record<string, string>> {
  const rows: Record<string, string> = {};
  for (const t of SEEDED_TABLES) {
    const [row] = (await db.execute(
      sql.raw(`select coalesce(json_agg(t), '[]')::text as rows from ${t} t`),
    )) as unknown as Array<{ rows: string }>;
    rows[t] = row.rows;
  }
  return rows;
}

async function restoreSnapshot(rows: Record<string, string>): Promise<void> {
  await db.transaction(async (tx) => {
    for (const t of SEEDED_TABLES) {
      await tx.execute(
        sql`insert into ${sql.identifier(t)} select * from json_populate_recordset(null::${sql.identifier(t)}, ${rows[t]}::json)`,
      );
    }
  });
}

/** The import itself, from the source document — what every caller got before the test snapshot existed. */
async function seedFromSource(): Promise<SeedResult> {
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
