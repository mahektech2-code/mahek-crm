import "server-only";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpQuoteCells, erpQuoteColumns, erpQuoteRows, erpRawMaterials, erpSuppliers, users } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { erpAudit, nextNumber } from "./server";
import { poLabel } from "./engines/purchase-flow";
import {
  cleanCell,
  isQuoteStatus,
  quoteStatusRefusal,
  ROW_STATUSES,
  MAX_HEADER_CHARS,
  MAX_OPS,
  MAX_PARTY_CHARS,
  parseQuoteDate,
  validQuoteId,
  type QuoteColumnKind,
  type QuoteStatus,
} from "./engines/quotes";

/* ---------------------------------------------------------------------------
 * The Quotation manager's reads and its one write. Every change the grid
 * makes — a typed cell, a paste of two hundred, a colour, a new row, a renamed
 * or moved column — is a list of operations applied in ONE transaction, so a
 * paste is never half written.
 * ------------------------------------------------------------------------- */

export type QuoteColumnView = {
  id: string;
  pack: string;
  name: string;
  brand: string;
  kind: QuoteColumnKind;
  rawMaterialId: string | null;
  rawMaterial: string | null;
};

export type QuoteRowView = {
  id: string;
  date: string;
  party: string;
  supplierId: string | null;
  status: QuoteStatus | null;
  seq: number;
  cells: Record<string, QuoteCellView>;
};

export type QuoteCellView = {
  value: string;
  status: QuoteStatus | null;
  drums: number | null;
  poNo: string | null;
  /** Who bought it, by name, and when (ISO). */
  poBy: string | null;
  poAt: string | null;
};

export type QuoteSheet = {
  columns: QuoteColumnView[];
  archived: QuoteColumnView[];
  rows: QuoteRowView[];
  parties: string[];
  materials: { id: string; name: string }[];
  /** True where the filter cut rows off at the limit. */
  truncated: boolean;
};

const ROW_LIMIT = 3000;

function columnView(c: { id: string; pack: string; name: string; brand: string; kind: string; rawMaterialId: string | null; rawMaterial: string | null }): QuoteColumnView {
  return { ...c, kind: c.kind === "text" ? "text" : "rate" };
}

export async function quoteSheet(f: { from: string | null; to: string | null; q: string }): Promise<QuoteSheet> {
  const cols = await db
    .select({
      id: erpQuoteColumns.id,
      pack: erpQuoteColumns.pack,
      name: erpQuoteColumns.name,
      brand: erpQuoteColumns.brand,
      kind: erpQuoteColumns.kind,
      rawMaterialId: erpQuoteColumns.rawMaterialId,
      rawMaterial: erpRawMaterials.name,
      archivedAt: erpQuoteColumns.archivedAt,
    })
    .from(erpQuoteColumns)
    .leftJoin(erpRawMaterials, eq(erpRawMaterials.id, erpQuoteColumns.rawMaterialId))
    .orderBy(asc(erpQuoteColumns.position), asc(erpQuoteColumns.createdAt));

  const where = [isNull(erpQuoteRows.deletedAt)];
  if (f.from) where.push(gte(erpQuoteRows.quoteDate, f.from));
  if (f.to) where.push(lte(erpQuoteRows.quoteDate, f.to));
  if (f.q) where.push(sql`${erpQuoteRows.party} ilike ${"%" + f.q.replace(/[%_\\]/g, "\\$&") + "%"}`);

  const rowsRaw = await db
    .select({
      id: erpQuoteRows.id,
      date: erpQuoteRows.quoteDate,
      party: erpQuoteRows.party,
      supplierId: erpQuoteRows.supplierId,
      status: erpQuoteRows.status,
    })
    .from(erpQuoteRows)
    .where(and(...where))
    .orderBy(sql`${erpQuoteRows.quoteDate} desc`, sql`${erpQuoteRows.seq} desc`)
    .limit(ROW_LIMIT + 1);
  const truncated = rowsRaw.length > ROW_LIMIT;
  const kept = rowsRaw.slice(0, ROW_LIMIT).reverse();

  const ids = kept.map((r) => r.id);
  const cells = ids.length
    ? await db
        .select({
          rowId: erpQuoteCells.rowId,
          columnId: erpQuoteCells.columnId,
          value: erpQuoteCells.value,
          status: erpQuoteCells.status,
          drums: erpQuoteCells.drums,
          poNo: erpQuoteCells.poNo,
          poBy: users.name,
          poAt: erpQuoteCells.poAt,
        })
        .from(erpQuoteCells)
        .leftJoin(users, eq(users.id, erpQuoteCells.poById))
        .where(inArray(erpQuoteCells.rowId, ids))
    : [];
  const byRow = new Map<string, QuoteRowView["cells"]>();
  for (const c of cells) {
    const m = byRow.get(c.rowId) ?? {};
    m[c.columnId] = {
      value: c.value,
      status: isQuoteStatus(c.status) ? c.status : null,
      drums: c.drums,
      poNo: c.poNo,
      poBy: c.poBy,
      poAt: c.poAt ? c.poAt.toISOString() : null,
    };
    byRow.set(c.rowId, m);
  }

  const [suppliers, materials] = await Promise.all([
    db.select({ name: erpSuppliers.name }).from(erpSuppliers).where(eq(erpSuppliers.active, true)).orderBy(asc(erpSuppliers.name)),
    db.select({ id: erpRawMaterials.id, name: erpRawMaterials.name }).from(erpRawMaterials).orderBy(asc(erpRawMaterials.name)),
  ]);
  const parties = [...new Set([...suppliers.map((s) => s.name), ...kept.map((r) => r.party)].filter(Boolean))].sort((a, b) => a.localeCompare(b));

  return {
    columns: cols.filter((c) => !c.archivedAt).map(columnView),
    archived: cols.filter((c) => c.archivedAt).map(columnView),
    rows: kept.map((r, i) => ({
      id: r.id,
      date: r.date,
      party: r.party,
      supplierId: r.supplierId,
      status: isQuoteStatus(r.status) ? r.status : null,
      seq: i,
      cells: byRow.get(r.id) ?? {},
    })),
    parties,
    materials,
    truncated,
  };
}

/* -------------------------------------------------------------- the write */

export type QuoteOp =
  | { op: "cell"; rowId: string; columnId: string; value?: string; status?: QuoteStatus | null; drums?: number | null; poNo?: string | null }
  | { op: "row"; rowId: string; create?: boolean; date?: string; party?: string; status?: QuoteStatus | null }
  | { op: "deleteRow"; rowId: string }
  | { op: "restoreRow"; rowId: string }
  | { op: "column"; columnId: string; create?: boolean; pack?: string; name?: string; brand?: string; kind?: QuoteColumnKind; rawMaterialId?: string | null }
  | { op: "order"; columnIds: string[] }
  | { op: "archiveColumn"; columnId: string }
  | { op: "restoreColumn"; columnId: string };

function header(v: unknown, what: string): string {
  if (typeof v !== "string") throw new QuoteRefusal(`${what} must be text.`);
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length > MAX_HEADER_CHARS) throw new QuoteRefusal(`${what} is longer than ${MAX_HEADER_CHARS} characters.`);
  return s;
}

function statusOf(v: unknown): QuoteStatus | null {
  if (v === null) return null;
  if (!isQuoteStatus(v)) throw new QuoteRefusal("That colour is not one of the sheet's three.");
  return v;
}

class QuoteRefusal extends Error {}

/** Who chooses the rate to buy: an ERP manager or administrator. */
export function quoteManagerOf(ctx: ErpContext): boolean {
  return ctx.administrator || ctx.level === "manager" || ctx.level === "admin";
}

/** A PO number the server made while saving, so the grid can show it. */
export type MintedPo = { rowId: string; columnId: string; poNo: string };

export async function applyQuoteOps(ctx: ErpContext, ops: QuoteOp[]): Promise<Result<{ applied: number; minted: MintedPo[] }>> {
  if (!Array.isArray(ops) || !ops.length) return ok({ applied: 0, minted: [] });
  if (ops.length > MAX_OPS) return err(`At most ${MAX_OPS} changes go in one save. Paste in smaller blocks.`, "validation");
  const who = ctx.actor.id;
  const manager = quoteManagerOf(ctx);
  const minted: MintedPo[] = [];
  try {
    await db.transaction(async (tx) => {
      const kinds = new Map<string, QuoteColumnKind>();
      for (const c of await tx.select({ id: erpQuoteColumns.id, kind: erpQuoteColumns.kind }).from(erpQuoteColumns))
        kinds.set(c.id, c.kind === "text" ? "text" : "rate");
      const knownRows = new Set<string>();
      const rowIds = [...new Set(ops.flatMap((o) => ("rowId" in o ? [o.rowId] : [])))].filter((id) => validQuoteId("eqr", id));
      for (let i = 0; i < rowIds.length; i += 1000) {
        const part = rowIds.slice(i, i + 1000);
        for (const r of await tx.select({ id: erpQuoteRows.id }).from(erpQuoteRows).where(inArray(erpQuoteRows.id, part))) knownRows.add(r.id);
      }
      let nextPos: number | null = null;
      const supplierIdFor = async (party: string): Promise<string | null> => {
        if (!party) return null;
        const hit = await tx
          .select({ id: erpSuppliers.id })
          .from(erpSuppliers)
          .where(sql`lower(trim(${erpSuppliers.name})) = lower(${party})`)
          .limit(2);
        return hit.length === 1 ? hit[0].id : null;
      };

      for (const o of ops) {
        switch (o?.op) {
          case "row": {
            if (!validQuoteId("eqr", o.rowId)) throw new QuoteRefusal("That row id is not one the sheet made.");
            const set: Partial<typeof erpQuoteRows.$inferInsert> = {};
            if (o.date !== undefined) {
              const d = parseQuoteDate(String(o.date));
              if (!d) throw new QuoteRefusal(`“${o.date}” is not a date.`);
              set.quoteDate = d;
            }
            if (o.party !== undefined) {
              const p = String(o.party).replace(/\s+/g, " ").trim();
              if (p.length > MAX_PARTY_CHARS) throw new QuoteRefusal(`A party name is at most ${MAX_PARTY_CHARS} characters.`);
              set.party = p;
              set.supplierId = await supplierIdFor(p);
            }
            if (o.status !== undefined) {
              set.status = statusOf(o.status);
              if (set.status && !ROW_STATUSES.includes(set.status as QuoteStatus)) throw new QuoteRefusal("Ready to buy marks a rate, not a whole row.");
            }
            if (!knownRows.has(o.rowId)) {
              if (!o.create) throw new QuoteRefusal("That row is no longer on the sheet. Refresh the page.");
              if (!set.quoteDate) throw new QuoteRefusal("A new row needs its date.");
              await tx
                .insert(erpQuoteRows)
                .values({ id: o.rowId, quoteDate: set.quoteDate, party: set.party ?? "", supplierId: set.supplierId ?? null, status: set.status ?? null, createdById: who, updatedById: who })
                .onConflictDoNothing();
              knownRows.add(o.rowId);
            } else if (Object.keys(set).length) {
              await tx.update(erpQuoteRows).set({ ...set, updatedById: who, updatedAt: new Date() }).where(eq(erpQuoteRows.id, o.rowId));
            }
            break;
          }
          case "cell": {
            if (!knownRows.has(o.rowId)) throw new QuoteRefusal("That row is no longer on the sheet. Refresh the page.");
            const kind = kinds.get(o.columnId);
            if (!kind) throw new QuoteRefusal("That column is no longer on the sheet. Refresh the page.");
            const set: Partial<typeof erpQuoteCells.$inferInsert> = {};
            if (o.value !== undefined) {
              const c = cleanCell(kind, String(o.value));
              if (!c.ok) throw new QuoteRefusal(c.error);
              set.value = c.value;
            }
            if (o.drums !== undefined) {
              if (o.drums !== null && (typeof o.drums !== "number" || !Number.isFinite(o.drums))) throw new QuoteRefusal("The number of drums must be a number.");
              set.drums = o.drums;
            }
            /* The PO number is MADE here, never typed: a purchase takes the
               next number of the ERP's own PO series. The only thing the
               screen may say about it is to clear it, which undoing a
               purchase does. */
            if (o.poNo === null) set.poNo = null;
            if (o.status !== undefined) set.status = statusOf(o.status);
            if (!Object.keys(set).length) break;
            const [prev] = await tx
              .select({ status: erpQuoteCells.status, drums: erpQuoteCells.drums, poNo: erpQuoteCells.poNo })
              .from(erpQuoteCells)
              .where(and(eq(erpQuoteCells.rowId, o.rowId), eq(erpQuoteCells.columnId, o.columnId)))
              .limit(1);
            const before = isQuoteStatus(prev?.status) ? prev!.status : null;
            const after = set.status !== undefined ? set.status : before;
            if (set.status !== undefined || after === "po") {
              const refusal = quoteStatusRefusal(
                before as QuoteStatus | null,
                { status: after as QuoteStatus | null, drums: set.drums !== undefined ? set.drums : (prev?.drums ?? null) },
                manager,
              );
              if (refusal) throw new QuoteRefusal(refusal);
            }
            if (after === "po" && !(set.poNo !== undefined ? set.poNo : prev?.poNo)) {
              set.poNo = poLabel(await nextNumber(tx, "po"));
              minted.push({ rowId: o.rowId, columnId: o.columnId, poNo: set.poNo });
            }
            if (after === "po" && (before !== "po" || set.drums !== undefined || set.poNo !== undefined)) {
              set.poById = who;
              set.poAt = new Date();
            }
            if (set.status === "ready" && before !== "ready") {
              set.readyById = who;
              set.readyAt = new Date();
            }
            await tx
              .insert(erpQuoteCells)
              .values({ rowId: o.rowId, columnId: o.columnId, value: "", ...set, updatedById: who })
              .onConflictDoUpdate({
                target: [erpQuoteCells.rowId, erpQuoteCells.columnId],
                set: { ...set, updatedById: who, updatedAt: new Date() },
              });
            break;
          }
          case "deleteRow":
          case "restoreRow":
            await tx
              .update(erpQuoteRows)
              .set({ deletedAt: o.op === "deleteRow" ? new Date() : null, updatedById: who, updatedAt: new Date() })
              .where(eq(erpQuoteRows.id, o.rowId));
            break;
          case "column": {
            if (!validQuoteId("eqc", o.columnId) && !kinds.has(o.columnId)) throw new QuoteRefusal("That column id is not one the sheet made.");
            const set: Partial<typeof erpQuoteColumns.$inferInsert> = {};
            if (o.pack !== undefined) set.pack = header(o.pack, "The pack line");
            if (o.name !== undefined) set.name = header(o.name, "The name");
            if (o.brand !== undefined) set.brand = header(o.brand, "The brand line");
            if (o.kind !== undefined) {
              if (o.kind !== "rate" && o.kind !== "text") throw new QuoteRefusal("A column holds rates or text.");
              set.kind = o.kind;
            }
            if (o.rawMaterialId !== undefined) {
              if (o.rawMaterialId) {
                const m = await tx.select({ id: erpRawMaterials.id }).from(erpRawMaterials).where(eq(erpRawMaterials.id, o.rawMaterialId)).limit(1);
                if (!m.length) throw new QuoteRefusal("That raw material is not in the master.");
              }
              set.rawMaterialId = o.rawMaterialId || null;
            }
            if (!kinds.has(o.columnId)) {
              if (!o.create) throw new QuoteRefusal("That column is no longer on the sheet. Refresh the page.");
              if (nextPos == null) {
                const [m] = await tx.select({ m: sql<number>`coalesce(max(${erpQuoteColumns.position}), 0)` }).from(erpQuoteColumns);
                nextPos = Number(m?.m ?? 0);
              }
              nextPos += 1;
              await tx.insert(erpQuoteColumns).values({ id: o.columnId, position: nextPos, kind: "rate", ...set });
              kinds.set(o.columnId, (set.kind as QuoteColumnKind | undefined) ?? "rate");
            } else if (Object.keys(set).length) {
              await tx.update(erpQuoteColumns).set({ ...set, updatedAt: new Date() }).where(eq(erpQuoteColumns.id, o.columnId));
              if (set.kind) kinds.set(o.columnId, set.kind as QuoteColumnKind);
            }
            break;
          }
          case "order": {
            if (!Array.isArray(o.columnIds)) throw new QuoteRefusal("The column order did not arrive.");
            let i = 0;
            for (const id of o.columnIds) {
              if (!kinds.has(id)) continue;
              i++;
              await tx.update(erpQuoteColumns).set({ position: i }).where(eq(erpQuoteColumns.id, id));
            }
            nextPos = null;
            break;
          }
          case "archiveColumn":
          case "restoreColumn":
            if (!kinds.has(o.columnId)) throw new QuoteRefusal("That column is no longer on the sheet. Refresh the page.");
            await tx
              .update(erpQuoteColumns)
              .set({ archivedAt: o.op === "archiveColumn" ? new Date() : null, updatedAt: new Date() })
              .where(eq(erpQuoteColumns.id, o.columnId));
            break;
          default:
            throw new QuoteRefusal("The sheet sent a change it does not know.");
        }
      }
    });
  } catch (e) {
    if (e instanceof QuoteRefusal) return err(e.message, "validation");
    throw e;
  }
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
  await erpAudit(ctx, "erp.quotes.edit", "erp_quote_sheet", null, null, { counts, sample: ops.slice(0, 20) });
  return ok({ applied: ops.length, minted });
}
