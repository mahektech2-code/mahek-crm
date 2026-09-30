import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { err, type Result } from "@/lib/result";
export { fieldErr, ok, okVoid, err } from "@/lib/result";
import type { ListRow, FormSpec } from "@/lib/erp/ui";
import type { HrmsListSpec } from "./extras";
import type { HrmsContext } from "./access";
import { nowHM, todayIST } from "./time";

export { text, num, int, paise, multi, rupeesField, stampLine, visibleCols, withoutHidden } from "@/lib/erp/server";

/* ---------------------------------------------------------------------------
 * What every HRMS screen module is made of, and the few helpers they share.
 * The contract with the generic screens is the ERP's (`lib/erp/ui.ts`).
 * ------------------------------------------------------------------------- */

export type Values = Record<string, string>;

export type ScreenLoad = { spec: HrmsListSpec; rows: ListRow[] };

/** Query parameters a screen reads (a date for Absentees, a period for Performance points). */
export type ScreenQuery = Record<string, string | undefined>;

export type ActionHandler = (ctx: HrmsContext, id: string, values: Values) => Promise<Result<unknown>>;
export type BulkHandler = (ctx: HrmsContext, ids: string[], values: Values) => Promise<Result<unknown>>;
export type FormHandler = (ctx: HrmsContext, header: Values, lines: Values[], recordId?: string) => Promise<Result<unknown>>;

export type HrmsScreenModule = {
  key: string;
  load: (ctx: HrmsContext, query: ScreenQuery) => Promise<ScreenLoad>;
  actions?: Record<string, ActionHandler>;
  bulk?: Record<string, BulkHandler>;
  forms?: Record<string, FormHandler>;
  /** Forms built for one record on demand — keyed by the action id that opens them. */
  formLoaders?: Record<string, (ctx: HrmsContext, id: string) => Promise<FormSpec | null>>;
  /** Header tools (ToolSpec), keyed by tool id. May answer with a ToolResult as data. */
  tools?: Record<string, (ctx: HrmsContext, values: Values) => Promise<Result<unknown>>>;
};

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `hatt_3f9c…` — a readable prefix and enough randomness to never collide. */
export function hrmsId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Today and the wall clock in the business's zone. */
export const today = (): string => todayIST();
export const now = (): string => nowHM();

/**
 * The next number in an HRMS series, under a row lock, inside the caller's
 * transaction — two people saving at once get two numbers (spec §1.3).
 */
export async function nextSeries(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }, key: string): Promise<number> {
  const rows = (await tx.execute(
    sql`insert into hrms_series (key, last) values (${key}, 1) on conflict (key) do update set last = hrms_series.last + 1 returning last`,
  )) as unknown as { last: number }[];
  return Number(rows[0].last);
}

/** Every HRMS write lands in the audit log with the app and the level it was done at. */
export async function hrmsAudit(
  ctx: HrmsContext,
  action: string,
  entityType: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: ctx.user.id,
    action,
    entityType,
    entityId,
    actorRole: ctx.level ?? null,
    actorApp: "hrms",
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

/** Swallows drizzle's rollback so a transaction can refuse with a Result. */
function rolledBack(e: unknown): null {
  if (e instanceof Error && e.message === "Rollback") return null;
  throw e;
}

class Refusal extends Error {
  constructor(public result: Result<unknown>) {
    super("refused");
  }
}

/** Throws a refusal: the transaction rolls back everything it wrote and answers with `r`. */
export const refuse = (r: Result<unknown>): never => {
  throw new Refusal(r);
};

/** Runs a transaction that may `refuse(...)` part-way. */
export async function inTx(fn: (tx: Tx) => Promise<Result<unknown>>): Promise<Result<unknown>> {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (e instanceof Refusal) return e.result;
    return rolledBack(e) ?? err("Could not save.");
  }
}

/** The first name, the way the design addresses people ("Pooja Wait For Admin Approval"). */
export function first(name: string | null | undefined): string {
  return String(name ?? "").trim().split(/\s+/)[0] ?? "";
}
