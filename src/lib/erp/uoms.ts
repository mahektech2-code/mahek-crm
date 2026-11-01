import "server-only";
import { asc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpUoms } from "@/db/schema";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import { cleanUomName, uomProblems, type Measure, type Uom, type UomDraft } from "./engines/uom";
import { erpAudit, erpId } from "./server";
import type { ErpContext } from "./access";

/* ---------------------------------------------------------------------------
 * The units master's reads and writes. The rules are `engines/uom.ts`; this
 * file only reads the table and writes it, audited.
 * ------------------------------------------------------------------------- */

function asUom(r: typeof erpUoms.$inferSelect): Uom {
  return { id: r.id, name: r.name, measure: r.measure as Measure, perBase: r.perBase, builtIn: r.builtIn, active: r.active };
}

/** Every unit, retired ones included — a quantity box hides those itself. */
export async function listUoms(): Promise<Uom[]> {
  const rows = await db.select().from(erpUoms).orderBy(asc(erpUoms.measure), asc(erpUoms.perBase), asc(erpUoms.name));
  return rows.map(asUom);
}

function firstProblem(p: ReturnType<typeof uomProblems>): Result<never> | null {
  const k = (["name", "measure", "perBase"] as const).find((x) => p[x]);
  return k ? fieldErr(k, p[k]!) : null;
}

/** A new unit. Anybody working in the ERP may add one; it is audited. */
export async function addUom(ctx: ErpContext, d: UomDraft): Promise<Result<Uom>> {
  const others = await db.select({ name: erpUoms.name }).from(erpUoms);
  const bad = firstProblem(uomProblems(d, others));
  if (bad) return bad;
  const row = { id: erpId("uom"), name: cleanUomName(d.name), measure: d.measure, perBase: Number(d.perBase), createdById: ctx.actor.id };
  const [made] = await db.insert(erpUoms).values(row).onConflictDoNothing().returning();
  if (!made) return fieldErr("name", "There is already a unit of that name");
  await erpAudit(ctx, "erp.uom.add", "erp_uom", made.id, null, { name: made.name, measure: made.measure, perBase: made.perBase });
  return ok(asUom(made));
}

/**
 * Renaming or re-sizing a unit. It changes nothing already saved: a figure was
 * converted into the base unit the moment it was typed, so a Drum that is now
 * 210 litres leaves last month's drums at 200.
 */
export async function editUom(ctx: ErpContext, id: string, d: UomDraft): Promise<Result<Uom>> {
  const [before] = await db.select().from(erpUoms).where(eq(erpUoms.id, id));
  if (!before) return err("That unit no longer exists.", "not_found");
  if (before.builtIn) return err("A base unit cannot be changed — every figure is kept in it.", "rule_violation");
  const others = await db.select({ name: erpUoms.name }).from(erpUoms).where(ne(erpUoms.id, id));
  const bad = firstProblem(uomProblems(d, others));
  if (bad) return bad;
  const values = { name: cleanUomName(d.name), measure: d.measure, perBase: Number(d.perBase), updatedAt: new Date() };
  const [after] = await db.update(erpUoms).set(values).where(eq(erpUoms.id, id)).returning();
  await erpAudit(ctx, "erp.uom.edit", "erp_uom", id, { name: before.name, measure: before.measure, perBase: before.perBase }, { name: after.name, measure: after.measure, perBase: after.perBase });
  return ok(asUom(after));
}

/** Retiring takes a unit off every dropdown; restoring puts it back. */
export async function setUomActive(ctx: ErpContext, id: string, active: boolean): Promise<Result<Uom>> {
  const [before] = await db.select().from(erpUoms).where(eq(erpUoms.id, id));
  if (!before) return err("That unit no longer exists.", "not_found");
  if (before.builtIn) return err("A base unit cannot be retired — every figure is kept in it.", "rule_violation");
  const [after] = await db.update(erpUoms).set({ active, updatedAt: sql`now()` }).where(eq(erpUoms.id, id)).returning();
  await erpAudit(ctx, active ? "erp.uom.restore" : "erp.uom.retire", "erp_uom", id, null, { name: before.name });
  return ok(asUom(after));
}
