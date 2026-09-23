/* ---------------------------------------------------------------------------
 * WHAT THE EDITOR CAN DO TO A SHEET — every operation, as a pure function.
 *
 * The editor's buttons are thin: each one calls something here and pushes
 * the result onto the undo history. Keeping the operations pure means undo is
 * free (the history is a list of sheets), a bulk change and the preview can
 * never disagree about what a button did, and the arithmetic — which is money
 * — lives somewhere a test can reach without a browser.
 *
 * Every price here is in the SHEET's own tax basis, the figure the paper
 * prints. Derivation rules are stated on ex-GST rates (that is how the Odisha
 * pair is defined), so they convert, apply, and convert back.
 * ------------------------------------------------------------------------- */

import type { PriceDerivation, PriceScopeKind } from "@/db/schema";
import { deriveRate, exFromIncl, inclFromEx } from "@/lib/engines/price-math";
import {
  columnOf,
  defaultTerms,
  familiesOf,
  familyKeyOf,
  familyOf,
  skuFor,
  sortColumns,
  type Family,
  type PriceSheet,
  type SheetCell,
  type SheetColumn,
  type SheetProduct,
  type SheetRow,
} from "@/lib/price-sheet";

export type EditorScope = {
  key: string;
  kind: PriceScopeKind;
  value: string;
  label: string;
  parentKey: string;
  freightTermMatch: "any" | "to_pay" | "paid";
};

export type StartSource = "blank" | "catalogue" | "copy" | "derive" | "csv";

/** A blank sheet with the office's own defaults filled in. */
export function blankSheet(todayIso: string, gstBp: number): PriceSheet {
  const base = {
    effectiveFrom: todayIso,
    gstBp,
    taxBasis: "inclusive" as const,
    deliveryBasis: "for_godown" as const,
    validityDays: 30,
  };
  return {
    name: "",
    refNo: null,
    ...base,
    freightTerm: "paid",
    columns: [],
    rows: [],
    terms: defaultTerms(base),
    discounts: [],
    signatory: null,
    signatoryTitle: null,
  };
}

/* ------------------------------------------------------------------ rows */

/** A row for one catalogue line, with a cell for every column already on the sheet. */
export function rowForFamily(family: Family, columns: SheetColumn[]): SheetRow {
  const cells: Record<string, SheetCell> = {};
  for (const c of columns) {
    const sku = skuFor(family, c);
    cells[c.key] = { productId: sku?.id ?? null, printedPaise: null, offered: !!sku };
  }
  return { key: `${family.key}:${Math.random().toString(36).slice(2, 7)}`, label: family.name, familyKey: family.key, cells };
}

/**
 * Add catalogue lines to the sheet. Their packs join the columns too — a line
 * added with a 210 L drum nobody else sells brings the drum column with it,
 * because a row that could not show its own packs would be a row missing
 * prices nobody can see are missing.
 */
export function addFamilies(sheet: PriceSheet, families: Family[], opts?: { withAllPacks?: boolean }): PriceSheet {
  const present = new Set(sheet.rows.map((r) => r.familyKey));
  const adding = families.filter((f) => !present.has(f.key));
  if (!adding.length) return sheet;
  let columns = sheet.columns;
  if (opts?.withAllPacks ?? true) {
    const byKey = new Map(columns.map((c) => [c.key, c]));
    for (const f of adding) for (const p of f.products) if (p.active) byKey.set(columnOf(p).key, columnOf(p));
    columns = sortColumns([...byKey.values()]);
  }
  const familiesByKey = new Map([...adding].map((f) => [f.key, f]));
  const rows = [...sheet.rows, ...adding.map((f) => rowForFamily(f, columns))];
  return { ...sheet, columns, rows: fillNewCells(rows, columns, familiesByKey) };
}

/** Every cell in every row for every column — a new column gets a cell in the rows already there. */
function fillNewCells(rows: SheetRow[], columns: SheetColumn[], families: Map<string, Family>): SheetRow[] {
  return rows.map((row) => {
    const missing = columns.filter((c) => !row.cells[c.key]);
    if (!missing.length) return row;
    const family = families.get(row.familyKey);
    const cells = { ...row.cells };
    for (const c of missing) {
      const sku = skuFor(family, c);
      cells[c.key] = { productId: sku?.id ?? null, printedPaise: null, offered: !!sku };
    }
    return { ...row, cells };
  });
}

export function familyIndex(products: SheetProduct[]): Map<string, Family> {
  return new Map(familiesOf(products).map((f) => [f.key, f]));
}

export function addColumns(sheet: PriceSheet, added: SheetColumn[], families: Map<string, Family>): PriceSheet {
  const byKey = new Map(sheet.columns.map((c) => [c.key, c]));
  for (const c of added) byKey.set(c.key, c);
  const columns = sortColumns([...byKey.values()]);
  return { ...sheet, columns, rows: fillNewCells(sheet.rows, columns, families) };
}

export function removeColumn(sheet: PriceSheet, key: string): PriceSheet {
  return {
    ...sheet,
    columns: sheet.columns.filter((c) => c.key !== key),
    rows: sheet.rows.map((r) => {
      const cells = { ...r.cells };
      delete cells[key];
      return { ...r, cells };
    }),
  };
}

export function removeRows(sheet: PriceSheet, keys: Set<string>): PriceSheet {
  return { ...sheet, rows: sheet.rows.filter((r) => !keys.has(r.key)) };
}

export function moveRow(sheet: PriceSheet, key: string, by: -1 | 1): PriceSheet {
  const i = sheet.rows.findIndex((r) => r.key === key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= sheet.rows.length) return sheet;
  const rows = [...sheet.rows];
  [rows[i], rows[j]] = [rows[j], rows[i]];
  return { ...sheet, rows };
}

export function sortRows(sheet: PriceSheet): PriceSheet {
  return { ...sheet, rows: [...sheet.rows].sort((a, b) => a.label.localeCompare(b.label)) };
}

/** Drop the columns no row sells in — what is left after lines were removed. */
export function pruneColumns(sheet: PriceSheet): PriceSheet {
  const used = new Set<string>();
  for (const r of sheet.rows) for (const [k, c] of Object.entries(r.cells)) if (c.productId) used.add(k);
  return { ...sheet, columns: sheet.columns.filter((c) => used.has(c.key)) };
}

export function setCell(sheet: PriceSheet, rowKey: string, columnKey: string, patch: Partial<SheetCell>): PriceSheet {
  return {
    ...sheet,
    rows: sheet.rows.map((r) =>
      r.key !== rowKey ? r : { ...r, cells: { ...r.cells, [columnKey]: { ...r.cells[columnKey], ...patch } } },
    ),
  };
}

export function setRowLabel(sheet: PriceSheet, rowKey: string, label: string): PriceSheet {
  return { ...sheet, rows: sheet.rows.map((r) => (r.key === rowKey ? { ...r, label } : r)) };
}

/**
 * A block pasted from a spreadsheet, spread from the cell it was pasted into:
 * rows down, columns across. Cells with no SKU are skipped over rather than
 * written, so a pasted row lines up with the packs the product actually sells
 * — which is how the office's own spreadsheets are laid out.
 */
export function pasteBlock(
  sheet: PriceSheet,
  at: { rowKey: string; columnKey: string },
  block: string[][],
  parse: (raw: string) => { printedPaise: number | null; offered: boolean } | null,
): { sheet: PriceSheet; written: number } {
  const r0 = sheet.rows.findIndex((r) => r.key === at.rowKey);
  const c0 = sheet.columns.findIndex((c) => c.key === at.columnKey);
  if (r0 < 0 || c0 < 0) return { sheet, written: 0 };
  let written = 0;
  const rows = sheet.rows.map((row, ri) => {
    const line = block[ri - r0];
    if (!line) return row;
    const cells = { ...row.cells };
    line.forEach((raw, j) => {
      const column = sheet.columns[c0 + j];
      if (!column) return;
      const cell = cells[column.key];
      if (!cell?.productId) return;
      const v = parse(raw);
      if (!v) return;
      cells[column.key] = { ...cell, ...v };
      written++;
    });
    return { ...row, cells };
  });
  return { sheet: { ...sheet, rows }, written };
}

/* ------------------------------------------------------------ bulk changes */

export type BulkChange =
  | { kind: "percent"; bp: number }
  | { kind: "per_litre"; paise: number }
  | { kind: "per_can"; paise: number }
  | { kind: "round"; toPaise: number; mode: "nearest" | "up" | "down" }
  | { kind: "clear" }
  | { kind: "not_sold_empty" }
  | { kind: "offer_all" };

function roundTo(paise: number, step: number, mode: "nearest" | "up" | "down"): number {
  const f = mode === "up" ? Math.ceil : mode === "down" ? Math.floor : Math.round;
  return f(paise / step) * step;
}

/**
 * A change to many prices at once — every row, or the rows ticked.
 *
 * The three rules are the derivation rules the module already stores
 * (`percent_bp`, `per_litre_paise`, `per_can_paise`), applied on the ex-GST
 * figure exactly as a derived list is, then printed back at the rupee. A
 * percentage typed as "5" means 5%, so the Odisha "+₹12 a litre" and a
 * price revision of 4% are the same act here as they are anywhere else.
 */
export function applyBulk(
  sheet: PriceSheet,
  change: BulkChange,
  rowKeys: Set<string> | null,
): { sheet: PriceSheet; changed: number } {
  let changed = 0;
  const toEx = (printed: number) => (sheet.taxBasis === "inclusive" ? exFromIncl(printed, sheet.gstBp) : printed);
  const fromEx = (ex: number) => (sheet.taxBasis === "inclusive" ? inclFromEx(ex, sheet.gstBp) : ex);
  const rows = sheet.rows.map((row) => {
    if (rowKeys && !rowKeys.has(row.key)) return row;
    const cells = { ...row.cells };
    for (const column of sheet.columns) {
      const cell = cells[column.key];
      if (!cell?.productId) continue;
      let next: SheetCell = cell;
      switch (change.kind) {
        case "percent":
        case "per_litre":
        case "per_can": {
          if (!cell.offered || cell.printedPaise == null) break;
          const rule: PriceDerivation =
            change.kind === "percent"
              ? { kind: "percent_bp", bp: change.bp }
              : change.kind === "per_litre"
                ? { kind: "per_litre_paise", paise: change.paise }
                : { kind: "per_can_paise", paise: change.paise };
          const ex = deriveRate(toEx(cell.printedPaise), column.millilitres, rule);
          if (ex == null || ex <= 0) break;
          next = { ...cell, printedPaise: fromEx(ex) };
          break;
        }
        case "round":
          if (cell.printedPaise == null) break;
          next = { ...cell, printedPaise: roundTo(cell.printedPaise, change.toPaise, change.mode) };
          break;
        case "clear":
          next = { ...cell, printedPaise: null, offered: true };
          break;
        case "not_sold_empty":
          if (cell.offered && cell.printedPaise == null) next = { ...cell, offered: false };
          break;
        case "offer_all":
          if (!cell.offered) next = { ...cell, offered: true };
          break;
      }
      if (next !== cell) {
        cells[column.key] = next;
        changed++;
      }
    }
    return { ...row, cells };
  });
  return { sheet: { ...sheet, rows }, changed };
}

/**
 * Prices from another list, for the SKUs this sheet already has. Only empty
 * cells unless told to overwrite — "fill from last month" should not undo the
 * prices somebody has spent an hour typing.
 */
export function fillFrom(
  sheet: PriceSheet,
  other: PriceSheet,
  opts: { overwrite: boolean; rowKeys: Set<string> | null },
): { sheet: PriceSheet; changed: number } {
  const byProduct = new Map<string, { printed: number | null; offered: boolean }>();
  for (const r of other.rows) {
    for (const c of other.columns) {
      const cell = r.cells[c.key];
      if (!cell?.productId) continue;
      // Converted into THIS sheet's tax basis, which need not be the other's.
      let printed = cell.printedPaise;
      if (printed != null && other.taxBasis !== sheet.taxBasis) {
        const ex = other.taxBasis === "inclusive" ? exFromIncl(printed, other.gstBp) : printed;
        printed = sheet.taxBasis === "inclusive" ? inclFromEx(ex, sheet.gstBp) : ex;
      }
      byProduct.set(cell.productId, { printed, offered: cell.offered });
    }
  }
  let changed = 0;
  const rows = sheet.rows.map((row) => {
    if (opts.rowKeys && !opts.rowKeys.has(row.key)) return row;
    const cells = { ...row.cells };
    for (const [k, cell] of Object.entries(cells)) {
      if (!cell.productId) continue;
      const hit = byProduct.get(cell.productId);
      if (!hit) continue;
      if (!opts.overwrite && cell.printedPaise != null) continue;
      cells[k] = { ...cell, printedPaise: hit.printed, offered: hit.offered };
      changed++;
    }
    return { ...row, cells };
  });
  return { sheet: { ...sheet, rows }, changed };
}

/** A whole sheet derived from a parent by a rule — the editor's "derive" start. */
export function deriveSheet(parent: PriceSheet, rule: PriceDerivation): PriceSheet {
  const change: BulkChange =
    rule.kind === "percent_bp"
      ? { kind: "percent", bp: rule.bp }
      : rule.kind === "per_litre_paise"
        ? { kind: "per_litre", paise: rule.paise }
        : { kind: "per_can", paise: rule.paise };
  return applyBulk(parent, change, null).sheet;
}

/* ------------------------------------------------------- building a grid */

/**
 * Cells keyed by product id become a grid — one row per PRINTED name where the
 * spreadsheet gives one (the export always does), one per catalogue line
 * where it does not. The same rule `sheetFromRates` follows, for the same
 * reason: a line the office prints once must not come back as two rows.
 */
export function sheetFromProductCells(
  base: PriceSheet,
  cells: Array<{ productId: string; printedPaise: number | null; offered: boolean; printedName?: string | null }>,
  products: SheetProduct[],
): PriceSheet {
  const byId = new Map(products.map((p) => [p.id, p]));
  const families = familyIndex(products);
  const columns = new Map<string, SheetColumn>();
  const rows = new Map<string, SheetRow & { counts: Map<string, number> }>();
  for (const c of cells) {
    const p = byId.get(c.productId);
    if (!p) continue;
    const column = columnOf(p);
    columns.set(column.key, column);
    const family = familyKeyOf(p);
    const printed = c.printedName?.trim() || null;
    const key = printed ? `p:${printed.toLowerCase().replace(/\s+/g, " ")}` : `f:${family}`;
    const row = rows.get(key) ?? { key, label: printed ?? families.get(family)?.name ?? p.name, familyKey: family, cells: {} as Record<string, SheetCell>, counts: new Map<string, number>() };
    row.cells[column.key] = { productId: p.id, printedPaise: c.printedPaise, offered: c.offered };
    row.counts.set(family, (row.counts.get(family) ?? 0) + 1);
    rows.set(key, row);
  }
  const sorted = sortColumns([...columns.values()]);
  const built: SheetRow[] = [...rows.values()].map(({ counts, ...row }) => ({
    ...row,
    familyKey: [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? row.familyKey,
  }));
  // Every row gets a cell for every column: its own family's SKU where the
  // catalogue has one for that pack, an impossible cell where it does not.
  const sheet: PriceSheet = { ...base, columns: sorted, rows: built };
  return addColumns(sheet, [], families);
}

/* --------------------------------------------------------------- summary */

export type SheetStats = {
  rows: number;
  columns: number;
  priced: number;
  notSold: number;
  empty: number;
  impossible: number;
};

export function sheetStats(sheet: PriceSheet): SheetStats {
  let priced = 0;
  let notSold = 0;
  let empty = 0;
  let impossible = 0;
  for (const r of sheet.rows) {
    for (const c of sheet.columns) {
      const cell = r.cells[c.key];
      if (!cell?.productId) impossible++;
      else if (!cell.offered) notSold++;
      else if (cell.printedPaise == null) empty++;
      else priced++;
    }
  }
  return { rows: sheet.rows.length, columns: sheet.columns.length, priced, notSold, empty, impossible };
}

export type ChangeSummary = { up: number; down: number; same: number; added: number; removed: number; biggest: Array<{ productId: string; before: number; after: number }> };

/** Against the list this sheet started from: what went up, what came down, what is new. */
export function changeSummary(sheet: PriceSheet, baseline: Record<string, number> | null): ChangeSummary | null {
  if (!baseline) return null;
  const now = new Map<string, number>();
  for (const r of sheet.rows) for (const c of Object.values(r.cells)) if (c.productId && c.offered && c.printedPaise != null) now.set(c.productId, c.printedPaise);
  let up = 0;
  let down = 0;
  let same = 0;
  let added = 0;
  const moves: ChangeSummary["biggest"] = [];
  for (const [id, after] of now) {
    const before = baseline[id];
    if (before == null) added++;
    else if (after > before) up++;
    else if (after < before) down++;
    else same++;
    if (before != null && before !== after) moves.push({ productId: id, before, after });
  }
  const removed = Object.keys(baseline).filter((id) => !now.has(id)).length;
  moves.sort((a, b) => Math.abs(b.after - b.before) / b.before - Math.abs(a.after - a.before) / a.before);
  return { up, down, same, added, removed, biggest: moves.slice(0, 8) };
}

export { familyOf };
