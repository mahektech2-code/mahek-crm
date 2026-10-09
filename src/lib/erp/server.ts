import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import type { Result } from "@/lib/result";
import type { ErpContext } from "./access";
import type { ListRow, ListSpec, FormSpec, CellValue } from "./ui";

/* ---------------------------------------------------------------------------
 * What every ERP screen module is made of, and the few helpers they share.
 * ------------------------------------------------------------------------- */

export type Values = Record<string, string>;

export type ScreenLoad = {
  spec: ListSpec;
  rows: ListRow[];
};

/** Acting on one record: a button in its drawer, perhaps after a prompt. */
export type ActionHandler = (ctx: ErpContext, id: string, values: Values) => Promise<Result<unknown>>;
/** Acting on many selected records at once. */
export type BulkHandler = (ctx: ErpContext, ids: string[], values: Values) => Promise<Result<unknown>>;
/** Saving a form: a header and, for a multi-line document, its lines. */
export type FormHandler = (
  ctx: ErpContext,
  header: Values,
  lines: Values[],
  recordId?: string,
) => Promise<Result<unknown>>;
/** Building a form on demand (an "Edit" opened from a record). */
export type FormBuilder = (ctx: ErpContext, recordId?: string) => Promise<FormSpec | null>;

export type ScreenModule = {
  key: string;
  load: (ctx: ErpContext) => Promise<ScreenLoad>;
  actions?: Record<string, ActionHandler>;
  bulk?: Record<string, BulkHandler>;
  forms?: Record<string, FormHandler>;
  /** Forms built for one record on demand — keyed by the action id that opens them. */
  formLoaders?: Record<string, (ctx: ErpContext, id: string) => Promise<FormSpec | null>>;
  /** Header buttons that act on the screen rather than a record (`ListSpec.tools`), keyed by the tool's id. */
  tools?: Record<string, (ctx: ErpContext, values: Values) => Promise<Result<unknown>>>;
};

/**
 * The next number in an ERP series (spec §1.3), under a row lock, inside the
 * caller's transaction — so two people saving at once get two numbers.
 */
export async function nextNumber(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  key: "pr" | "sfg" | "fg" | "packBatch" | "order" | "po" | "requirement" | "unit",
): Promise<number> {
  const rows = (await tx.execute(sql`update erp_series set last = last + 1 where key = ${key} returning last`)) as unknown as { last: number }[];
  if (!rows[0]) throw new Error(`No ERP series "${key}"`);
  return Number(rows[0].last);
}

/** `erpgd_3f9c…` — a readable prefix and enough randomness to never collide. */
export function erpId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Every ERP write lands in the audit log with the app it was done in, the
 * level it was done at, and the before and after — the same discipline every
 * other app keeps, so "who changed this lot" is a query rather than a guess.
 */
export async function erpAudit(
  ctx: ErpContext,
  action: string,
  entityType: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    /* The person signed in — never whoever a preview is showing the ERP as. */
    actorId: ctx.actor.id,
    action,
    entityType,
    entityId,
    /* The hat in force is the previewed one while previewing, so it is not the actor's. */
    actorRole: ctx.viewingAs ? null : (ctx.level ?? null),
    actorApp: "erp",
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

/* ------------------------------------------------------------ small parsers */

export function text(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

export function num(v: string | undefined): number | null {
  const t = (v ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function int(v: string | undefined): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

/** Rupees typed on a form → paise, exactly. */
export function paise(v: string | undefined): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n * 100);
}

export function multi(v: string | undefined): string[] {
  return (v ?? "")
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Paise → a rupees string for pre-filling a form. */
export function rupeesField(p: number | null | undefined): string {
  return p == null ? "" : String(p / 100);
}

export function stampLine(by: string | null | undefined, at: Date | string | null | undefined): string {
  if (!at) return by ? `Created by ${by}` : "";
  const d = typeof at === "string" ? new Date(at) : at;
  const when = d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Created ${by ? "by " + by + " · " : ""}${when}`;
}

/** Drop the columns a person's powers do not reveal, and name what was dropped. */
export function visibleCols(
  cols: (ListSpec["cols"][number] & { pw?: string })[],
  has: (p: string) => boolean,
): { cols: ListSpec["cols"]; hidden: ListSpec["hidden"]; hiddenKeys: string[] } {
  const shown = cols.filter((c) => !c.pw || has(c.pw));
  const withheld = cols.filter((c) => c.pw && !has(c.pw));
  return {
    cols: shown.map((c) => ({ k: c.k, l: c.l, t: c.t, u: c.u, w: c.w })),
    hidden: withheld.map((c) => ({ l: c.l, power: c.pw! })),
    hiddenKeys: withheld.map((c) => c.k),
  };
}

/** Strip values of withheld columns from a row, so they never reach the browser. */
export function withoutHidden(v: Record<string, CellValue>, hiddenKeys: string[]): Record<string, CellValue> {
  if (!hiddenKeys.length) return v;
  const out = { ...v };
  for (const k of hiddenKeys) delete out[k];
  return out;
}
