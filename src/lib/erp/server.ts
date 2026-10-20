import "server-only";
import { APP_TIMEZONE } from "@/lib/business-date";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import type { Result } from "@/lib/result";
import type { ErpContext } from "./access";
import type { ListRow, ListSpec, FormSpec, CellValue } from "./ui";
import type { LoadScope, ScreenWindow } from "./window";

/* ---------------------------------------------------------------------------
 * What every ERP screen module is made of, and the few helpers they share.
 * ------------------------------------------------------------------------- */

export type Values = Record<string, string>;

export type ScreenLoad = {
  spec: ListSpec;
  rows: ListRow[];
  /** Set by a windowed register whose window holds more than `ROW_CAP` rows: nothing was built. */
  tooWide?: { n: number; cap: number } | null;
};

/** Acting on one record: a button in its record, perhaps after a prompt. */
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
/** A header button that acts on the screen rather than on a record (ToolSpec). */
export type ToolHandler = (ctx: ErpContext, values: Values) => Promise<Result<unknown>>;
/** Building a form on demand (an "Edit" opened from a record). */
export type FormBuilder = (ctx: ErpContext, recordId?: string) => Promise<FormSpec | null>;

export type ScreenModule = {
  key: string;
  /**
   * The screen's rows. A REGISTER — a list that grows with history — declares
   * `window` and reads `scope.window` IN SQL (`window.ts`), so it builds only
   * what the period holds; a list of open work reads only open work. Neither
   * may read a whole history table into memory: that is what took the server
   * past its heap with 22,154 order lines (`erp-scale.test.ts` holds the line).
   * Called without a scope it reads its default window.
   */
  load: (ctx: ErpContext, scope?: LoadScope) => Promise<ScreenLoad>;
  /** A register's window: the date it is cut by and the period it opens on. */
  window?: ScreenWindow;
  actions?: Record<string, ActionHandler>;
  bulk?: Record<string, BulkHandler>;
  forms?: Record<string, FormHandler>;
  /** Header buttons (ToolSpec) that act on the screen as a whole. */
  tools?: Record<string, ToolHandler>;
  /** Forms built for one record on demand — keyed by the action id that opens them. */
  formLoaders?: Record<string, (ctx: ErpContext, id: string) => Promise<FormSpec | null>>;
};

/**
 * The next number in an ERP series (spec §1.3), under a row lock, inside the
 * caller's transaction — so two people saving at once get two numbers.
 */
export async function nextNumber(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  key: "pr" | "sfg" | "fg" | "packBatch" | "order" | "po" | "requirement" | "unit" | "stockCount" | "emptyDrum" | "scrapSale" | "drumReturn" | "cashReceipt" | "purchaseReturn" | "debitNote" | "returnOutward" | "customerReturn" | "reworkOrder" | "wasteDisposal" | "moneyTxn" | "advance",
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

/* Client-safe, so a client form pre-fills a figure the same way a server form does. */
export { rupeesField } from "./ui";

/* Built once: a formatter per call was most of the cost of a long list. */
const STAMP = new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function stampLine(by: string | null | undefined, at: Date | string | null | undefined): string {
  if (!at) return by ? `Created by ${by}` : "";
  const d = typeof at === "string" ? new Date(at) : at;
  const when = STAMP.format(d);
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
