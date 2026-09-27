import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { erpGodowns, erpRawMaterials } from "@/db/schema";
import type { ErpContext } from "../access";
import type { ErpPower } from "../powers";
import type { ColSpec } from "../ui";
import { err, type Result } from "@/lib/result";
import { calendarDate } from "@/lib/business-date";

/* Pieces every operations screen reads the same way. */

export type Col = ColSpec & { pw?: ErpPower };

export const has = (ctx: ErpContext) => (p: string) => ctx.powers.has(p as ErpPower);

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Godowns a form may offer: active, and Item Lost Record only with the power
 * to write stock off.
 */
export async function godownOptions(ctx: ErpContext, opts: { lost?: boolean } = {}): Promise<{ id: string; name: string; reserved: boolean }[]> {
  const rows = await db
    .select({ id: erpGodowns.id, name: erpGodowns.name, reserved: erpGodowns.reserved })
    .from(erpGodowns)
    .where(eq(erpGodowns.status, "active"))
    .orderBy(asc(erpGodowns.name));
  return rows.filter((g) => !g.reserved || (opts.lost !== false && ctx.powers.has("lostStock")));
}

export async function godownIdByName(name: string | null): Promise<string | null> {
  if (!name) return null;
  const [g] = await db.select({ id: erpGodowns.id }).from(erpGodowns).where(eq(erpGodowns.name, name));
  return g?.id ?? null;
}

export async function materials() {
  return db.select().from(erpRawMaterials).where(eq(erpRawMaterials.active, true)).orderBy(asc(erpRawMaterials.name));
}

/** Today in the business's zone — never a UTC slice, which is yesterday until 05:30 IST. */
export const today = (): string => calendarDate(new Date());

/** A key for options that depend on two fields at once (`optsBy.by` as a list). */
export const pair = (...parts: string[]) => parts.join("|");

/** Swallows drizzle's rollback so a transaction can refuse with a Result. */
export function rolledBack(e: unknown): null {
  if (e instanceof Error && e.message === "Rollback") return null;
  throw e;
}

/** A refusal thrown out of a transaction, carrying the Result to answer with. */
class Refusal extends Error {
  constructor(public result: Result<unknown>) {
    super("refused");
  }
}

/** Throws a refusal: the transaction rolls back everything it wrote and answers with `r`. */
export const refuse = (r: Result<unknown>): never => {
  throw new Refusal(r);
};

/** Runs a transaction that may `refuse(...)` part-way, rolling back and answering with the refusal. */
export async function inTx(fn: (tx: Tx) => Promise<Result<unknown>>): Promise<Result<unknown>> {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (e instanceof Refusal) return e.result;
    return rolledBack(e) ?? err("Could not save.");
  }
}
