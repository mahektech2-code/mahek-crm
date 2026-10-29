import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { places } from "@/db/schema";
import { placeKey, type PlaceKind } from "@/lib/place-parse";
import type { PlaceOption, ResolvedRung } from "@/lib/erp/transporter-godowns";

/* ---------------------------------------------------------------------------
 * The reviewed place tree, read and added to — shared by the two forms that
 * pick a place on it: a transporter's godown (ERP → Logistics) and a
 * customer's address (Accounts). The rules for WHAT may be picked are pure,
 * in `lib/erp/transporter-godowns.ts`; this file only reads and writes.
 * ------------------------------------------------------------------------- */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The whole tree, for a picker. A few thousand rows of four columns. */
export async function placeOptions(): Promise<PlaceOption[]> {
  const rows = await db.select({ id: places.id, kind: places.kind, name: places.name, parentId: places.parentId }).from(places);
  return rows.map((r) => ({ ...r, kind: r.kind as PlaceKind }));
}

/**
 * The deepest place a resolved pick names, adding the rungs somebody typed
 * because they were not listed. Each is looked for under its parent first —
 * another save may have added it a moment ago — and a race between two
 * inserts is settled by the unique index rather than by a second copy.
 * Returns the id of every rung, coarsest first.
 */
export async function placeIdsFor(tx: Tx, rungs: ResolvedRung[]): Promise<{ kind: PlaceKind; id: string | null }[]> {
  const out: { kind: PlaceKind; id: string | null }[] = [];
  let parentId: string | null = null;
  for (const r of rungs) {
    if (r.id) {
      parentId = r.id;
      out.push({ kind: r.kind, id: r.id });
      continue;
    }
    const key = placeKey(r.name);
    const find = async () =>
      ((await tx.execute(sql`select id from places where kind = ${r.kind} and key = ${key} and parent_id is not distinct from ${parentId} limit 1`)) as unknown as { id: string }[])[0]?.id;
    let id = await find();
    if (!id) {
      await tx.execute(sql`insert into places (id, kind, name, key, parent_id, shops) values (${`pl_${randomUUID().slice(0, 12)}`}, ${r.kind}, ${r.name}, ${key}, ${parentId}, 0) on conflict do nothing`);
      id = await find();
    }
    parentId = id ?? null;
    out.push({ kind: r.kind, id: parentId });
  }
  return out;
}
