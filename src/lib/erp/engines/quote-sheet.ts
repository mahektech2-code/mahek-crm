/* ---------------------------------------------------------------------------
 * The Quotation manager's grid, as STATE: what an operation does to the sheet
 * on the screen, and the operation that undoes it. Pure, so the grid can show
 * a change before the server has answered, take it back if the server
 * refuses, and offer Undo — all with one function each, and tested.
 *
 * The operations are the server's own (`QuoteOp` in lib/erp/quotes.ts),
 * declared again here because that file is server-only. Nothing is ever
 * removed from local state: a deleted row or a removed column carries a flag,
 * so undoing it is flipping the flag back.
 * ------------------------------------------------------------------------- */

import type { QuoteColumnKind, QuoteStatus } from "./quotes";
import type { ImpactConfirmation } from "@/lib/impact/types";

export type SheetOp =
  | {
      op: "cell";
      rowId: string;
      columnId: string;
      value?: string;
      status?: QuoteStatus | null;
      /** The purchase: drums and the PO number. Set together with `status: "po"`. */
      drums?: number | null;
      poNo?: string | null;
      /** Who bought it and when — written by the server; carried here only so the screen can show it at once. */
      poBy?: string | null;
      poAt?: string | null;
      /** Purchase it: how much, where and by when — the server writes the ERP purchase order with it. */
      order?: { requisitionId?: string | null; qty: number; godown: string; deliveryDate: string };
      /** The impact modal's confirmation, where this takes a bought rate off. */
      impact?: ImpactConfirmation;
    }
  | { op: "row"; rowId: string; create?: boolean; date?: string; party?: string; status?: QuoteStatus | null }
  | { op: "deleteRow"; rowId: string; impact?: ImpactConfirmation }
  | { op: "restoreRow"; rowId: string }
  | { op: "column"; columnId: string; create?: boolean; pack?: string; name?: string; brand?: string; kind?: QuoteColumnKind; rawMaterialId?: string | null }
  | { op: "order"; columnIds: string[] }
  | { op: "archiveColumn"; columnId: string }
  | { op: "restoreColumn"; columnId: string };

/**
 * The change in `ops` the server will not take without the impact modal: a
 * bought rate taken off (it withdraws its ERP purchase order line) or a row
 * deleted while it holds one — the same two `applyQuoteOps` checks. Whatever
 * else is in the save is the spreadsheet's own and asks nothing.
 */
export function impactAsks(s: SheetState, ops: SheetOp[]): { kind: "erp-quote-purchase" | "erp-quote-row"; id: string; op: number }[] {
  const rows = new Map(s.rows.map((r) => [r.id, r]));
  const out: { kind: "erp-quote-purchase" | "erp-quote-row"; id: string; op: number }[] = [];
  ops.forEach((o, i) => {
    if (o.op === "deleteRow") {
      const r = rows.get(o.rowId);
      if (r && !r.deleted && Object.values(r.cells).some((c) => c.status === "po" || c.status === "pickup")) out.push({ kind: "erp-quote-row", id: o.rowId, op: i });
    } else if (o.op === "cell" && o.status !== undefined && o.status !== "po" && o.status !== "pickup") {
      if (rows.get(o.rowId)?.cells[o.columnId]?.status === "po") out.push({ kind: "erp-quote-purchase", id: `${o.rowId}:${o.columnId}`, op: i });
    }
  });
  return out;
}

export type SheetColumn = {
  id: string;
  pack: string;
  name: string;
  brand: string;
  kind: QuoteColumnKind;
  rawMaterialId: string | null;
  archived: boolean;
};

export type SheetCell = {
  value: string;
  status: QuoteStatus | null;
  drums: number | null;
  poNo: string | null;
  poBy: string | null;
  poAt: string | null;
};

export type SheetRow = {
  id: string;
  date: string;
  party: string;
  status: QuoteStatus | null;
  seq: number;
  deleted: boolean;
  cells: Record<string, SheetCell>;
};

export type SheetState = { columns: SheetColumn[]; rows: SheetRow[] };

const EMPTY: SheetCell = { value: "", status: null, drums: null, poNo: null, poBy: null, poAt: null };

const PURCHASE_KEYS = ["drums", "poNo", "poBy", "poAt"] as const;

export function applySheetOps(s: SheetState, ops: SheetOp[]): SheetState {
  let columns = s.columns;
  let rows = s.rows;
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
  const touchRow = (id: string, f: (r: SheetRow) => SheetRow) => {
    const i = rowIndex.get(id);
    if (i == null) return;
    if (rows === s.rows) rows = [...rows];
    rows[i] = f(rows[i]);
  };
  const touchCol = (id: string, f: (c: SheetColumn) => SheetColumn) => {
    columns = columns.map((c) => (c.id === id ? f(c) : c));
  };
  for (const o of ops) {
    switch (o.op) {
      case "cell":
        touchRow(o.rowId, (r) => {
          const prev = r.cells[o.columnId] ?? EMPTY;
          const next: SheetCell = {
            value: o.value !== undefined ? o.value : prev.value,
            status: o.status !== undefined ? o.status : prev.status,
            drums: o.drums !== undefined ? o.drums : prev.drums,
            poNo: o.poNo !== undefined ? o.poNo : prev.poNo,
            poBy: o.poBy !== undefined ? o.poBy : prev.poBy,
            poAt: o.poAt !== undefined ? o.poAt : prev.poAt,
          };
          return { ...r, cells: { ...r.cells, [o.columnId]: next } };
        });
        break;
      case "row":
        if (!rowIndex.has(o.rowId)) {
          if (!o.create || !o.date) break;
          const seq = rows.reduce((m, r) => Math.max(m, r.seq), -1) + 1;
          rows = [...rows, { id: o.rowId, date: o.date, party: o.party ?? "", status: o.status ?? null, seq, deleted: false, cells: {} }];
          rowIndex.set(o.rowId, rows.length - 1);
        } else
          touchRow(o.rowId, (r) => ({
            ...r,
            deleted: false,
            ...(o.date !== undefined ? { date: o.date } : {}),
            ...(o.party !== undefined ? { party: o.party } : {}),
            ...(o.status !== undefined ? { status: o.status } : {}),
          }));
        break;
      case "deleteRow":
      case "restoreRow":
        touchRow(o.rowId, (r) => ({ ...r, deleted: o.op === "deleteRow" }));
        break;
      case "column":
        if (!columns.some((c) => c.id === o.columnId)) {
          if (!o.create) break;
          columns = [
            ...columns,
            { id: o.columnId, pack: o.pack ?? "", name: o.name ?? "", brand: o.brand ?? "", kind: o.kind ?? "rate", rawMaterialId: o.rawMaterialId ?? null, archived: false },
          ];
        } else
          touchCol(o.columnId, (c) => ({
            ...c,
            archived: false,
            ...(o.pack !== undefined ? { pack: o.pack } : {}),
            ...(o.name !== undefined ? { name: o.name } : {}),
            ...(o.brand !== undefined ? { brand: o.brand } : {}),
            ...(o.kind !== undefined ? { kind: o.kind } : {}),
            ...(o.rawMaterialId !== undefined ? { rawMaterialId: o.rawMaterialId } : {}),
          }));
        break;
      case "order": {
        const pos = new Map(o.columnIds.map((id, i) => [id, i]));
        columns = [...columns].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
        break;
      }
      case "archiveColumn":
      case "restoreColumn":
        touchCol(o.columnId, (c) => ({ ...c, archived: o.op === "archiveColumn" }));
        break;
    }
  }
  return { columns, rows };
}

/**
 * The operations that put `s` back the way it was before `ops`. Read off the
 * state BEFORE the ops are applied, and in reverse, so a list that touches one
 * cell twice is undone to its first value. Every inverse is one the server
 * accepts: a created row is undone by deleting it, a created column by
 * removing it.
 */
export function invertSheetOps(s: SheetState, ops: SheetOp[]): SheetOp[] {
  const out: SheetOp[] = [];
  let cur = s;
  for (const o of ops) {
    const rows = new Map(cur.rows.map((r) => [r.id, r]));
    const cols = new Map(cur.columns.map((c) => [c.id, c]));
    switch (o.op) {
      case "cell": {
        const r = rows.get(o.rowId);
        const prev = r?.cells[o.columnId] ?? EMPTY;
        const back: SheetOp = { op: "cell", rowId: o.rowId, columnId: o.columnId };
        if (o.value !== undefined) back.value = prev.value;
        if (o.status !== undefined) back.status = prev.status;
        for (const k of PURCHASE_KEYS) if (o[k] !== undefined) (back as Record<string, unknown>)[k] = prev[k];
        out.push(back);
        break;
      }
      case "row": {
        const r = rows.get(o.rowId);
        if (!r) {
          if (o.create) out.push({ op: "deleteRow", rowId: o.rowId });
          break;
        }
        const back: SheetOp = { op: "row", rowId: o.rowId };
        if (o.date !== undefined) back.date = r.date;
        if (o.party !== undefined) back.party = r.party;
        if (o.status !== undefined) back.status = r.status;
        out.push(back);
        if (r.deleted) out.push({ op: "deleteRow", rowId: o.rowId });
        break;
      }
      case "deleteRow":
      case "restoreRow": {
        const r = rows.get(o.rowId);
        if (r) out.push({ op: r.deleted ? "deleteRow" : "restoreRow", rowId: o.rowId });
        break;
      }
      case "column": {
        const c = cols.get(o.columnId);
        if (!c) {
          if (o.create) out.push({ op: "archiveColumn", columnId: o.columnId });
          break;
        }
        const back: SheetOp = { op: "column", columnId: o.columnId };
        if (o.pack !== undefined) back.pack = c.pack;
        if (o.name !== undefined) back.name = c.name;
        if (o.brand !== undefined) back.brand = c.brand;
        if (o.kind !== undefined) back.kind = c.kind;
        if (o.rawMaterialId !== undefined) back.rawMaterialId = c.rawMaterialId;
        out.push(back);
        if (c.archived) out.push({ op: "archiveColumn", columnId: o.columnId });
        break;
      }
      case "order":
        out.push({ op: "order", columnIds: cur.columns.map((c) => c.id) });
        break;
      case "archiveColumn":
      case "restoreColumn": {
        const c = cols.get(o.columnId);
        if (c) out.push({ op: c.archived ? "archiveColumn" : "restoreColumn", columnId: o.columnId });
        break;
      }
    }
    cur = applySheetOps(cur, [o]);
  }
  return out.reverse();
}

/** The rows on the screen: not deleted, latest first — newest date on top, and the last entered first within a date. */
export function visibleRows(s: SheetState): SheetRow[] {
  return s.rows
    .filter((r) => !r.deleted)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : b.seq - a.seq));
}

export function visibleColumns(s: SheetState): SheetColumn[] {
  return s.columns.filter((c) => !c.archived);
}
