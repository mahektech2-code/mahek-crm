"use client";

/* ---------------------------------------------------------------------------
 * THE GRID, typed the way the paper reads.
 *
 * Products down, pack sizes across, one price per cell in the figure the
 * paper prints — GST-inclusive on every list so far. It is shaped like the
 * document on purpose: the office has typed these lists into a spreadsheet
 * for years, so it behaves like one. Enter moves down, the arrows move
 * between cells, and a block copied out of Excel pastes across the grid from
 * the cell it lands in.
 *
 * A CELL SAYS ONE OF FOUR THINGS and each is drawn differently: a price; an
 * empty cell still to be priced; a dash, which is "listed and not sold in this
 * pack" and is a deliberate answer; and a cell the catalogue has no SKU for,
 * which cannot hold a price at all because there would be no can to charge
 * it on. Mixing the last two up is how a list ends up with a price on a pack
 * nobody makes.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Badge, Button, Checkbox, Field, Input, Select, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { RowMenu } from "@/components/ui/overlays";
import { MenuButton } from "@/components/pricing/menu-button";
import {
  columnOf,
  familiesOf,
  groupRupees,
  parseTypedRupees,
  sortColumns,
  type PriceSheet,
  type SheetCell,
  type SheetColumn,
  type SheetProduct,
} from "@/lib/price-sheet";
import { exFromIncl } from "@/lib/engines/price-math";
import {
  addColumns,
  addFamilies,
  applyBulk,
  familyIndex,
  fillFrom,
  moveRow,
  pasteBlock,
  pruneColumns,
  removeColumn,
  removeRows,
  setCell,
  setRowLabel,
  sheetStats,
  sortRows,
  type BulkChange,
} from "@/components/pricing/editor/editor-state";
import type { PricingOptions } from "@/lib/price-list-views";

type Flag = "warn" | "block";

function parseCellText(raw: string): { printedPaise: number | null; offered: boolean } | null {
  const t = raw.trim();
  if (!t) return { printedPaise: null, offered: true };
  if (/^(—|–|-|--|na|n\/a|x)$/i.test(t)) return { printedPaise: null, offered: false };
  const paise = parseTypedRupees(t);
  return paise == null ? null : { printedPaise: paise, offered: true };
}

function display(cell: SheetCell): string {
  if (!cell.offered) return "—";
  return cell.printedPaise == null ? "" : groupRupees(cell.printedPaise);
}

export function RatesPanel({
  sheet,
  onChange,
  products,
  lists,
  baseline,
  flags,
  loadSheet,
}: {
  sheet: PriceSheet;
  onChange: (next: PriceSheet, label: string) => void;
  products: SheetProduct[];
  lists: PricingOptions["lists"];
  /** What each SKU cost on the list this sheet started from, in printed basis. */
  baseline: Record<string, number> | null;
  /** `${rowKey}::${columnKey}` → how the review sees it. */
  flags: Map<string, Flag>;
  loadSheet: (listId: string) => Promise<PriceSheet | null>;
}) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [showEx, setShowEx] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [bulk, setBulk] = React.useState<BulkChange["kind"] | null>(null);
  const [filling, setFilling] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const families = React.useMemo(() => familyIndex(products), [products]);
  const stats = sheetStats(sheet);
  const scope = selected.size ? selected : null;
  const scopeWords = selected.size ? `${selected.size} ticked line${selected.size === 1 ? "" : "s"}` : "every line";

  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sheet.rows.filter((r) => r.label.toLowerCase().includes(q) || r.familyKey.includes(q.replace(/[^a-z0-9]/g, ""))) : sheet.rows;
  }, [sheet.rows, query]);

  /* The packs the lines on this sheet actually sell and the sheet does not show yet. */
  const missingColumns = React.useMemo(() => {
    const on = new Set(sheet.columns.map((c) => c.key));
    const present = new Set(sheet.rows.map((r) => r.familyKey));
    const out = new Map<string, { column: SheetColumn; lines: number }>();
    for (const key of present) {
      const f = families.get(key);
      for (const p of f?.products ?? []) {
        const c = columnOf(p);
        if (on.has(c.key)) continue;
        const hit = out.get(c.key) ?? { column: c, lines: 0 };
        hit.lines++;
        out.set(c.key, hit);
      }
    }
    return sortColumns([...out.values()].map((x) => x.column)).map((c) => out.get(c.key)!);
  }, [sheet.columns, sheet.rows, families]);

  function focusCell(r: number, c: number) {
    const el = document.getElementById(`pl-cell-${r}-${c}`) as HTMLInputElement | null;
    if (el) {
      el.focus();
      el.select();
    }
  }

  function toggleRow(key: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const allTicked = shown.length > 0 && shown.every((r) => selected.has(r.key));

  return (
    <div className="flex h-full flex-col">
      {/* --------------------------------------------------------- toolbar */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-divider px-5 py-3">
        <Button variant="primary" size="sm" onClick={() => setPicking(true)}>
          + Add product lines
        </Button>
        <MenuButton
          size="sm"
          label="+ Pack size"
          width={300}
          align="left"
          items={
            missingColumns.length
              ? missingColumns.map(({ column, lines }) => ({
                  key: column.key,
                  label: `${column.sizeLabel} · ${column.packLabel}`,
                  description: `${lines} line${lines === 1 ? "" : "s"} on this sheet sell${lines === 1 ? "s" : ""} it`,
                  onSelect: () => onChange(addColumns(sheet, [column], families), `Added the ${column.sizeLabel} column`),
                }))
              : [{ key: "none", label: "Every pack these lines sell is already on the sheet", onSelect: () => undefined, disabled: true }]
          }
        />
        <MenuButton
          size="sm"
          label={`Change prices${selected.size ? ` (${selected.size})` : ""}`}
          width={330}
          align="left"
          items={[
            { key: "percent", label: "Raise or lower by a percentage", description: `Every price on ${scopeWords}, e.g. +4% for a revision.`, onSelect: () => setBulk("percent") },
            { key: "per_litre", label: "Add or take off an amount per litre", description: "The Odisha freight rule: +₹12 a litre moves a 20 L can by ₹240.", onSelect: () => setBulk("per_litre") },
            { key: "per_can", label: "Add or take off an amount per can", description: "A flat premium, like the tin can's ₹200.", onSelect: () => setBulk("per_can") },
            { key: "round", label: "Round the prices", description: "To the nearest ₹1, ₹5 or ₹10 — up, down or nearest.", onSelect: () => setBulk("round") },
            { key: "fill", label: "Fill from another list…", description: "Copy prices across for the same SKUs.", onSelect: () => setFilling(true), divider: true },
            { key: "not_sold_empty", label: "Mark every empty cell “not sold”", description: "Prints a dash instead of leaving it for somebody to wonder about.", onSelect: () => setBulk("not_sold_empty") },
            { key: "offer_all", label: "Sell every pack again", description: "Turn every dash back into a cell waiting for a price.", onSelect: () => setBulk("offer_all") },
            { key: "clear", label: "Clear the prices", description: `Empty every cell on ${scopeWords}.`, onSelect: () => setBulk("clear"), destructive: true },
          ]}
        />
        <MenuButton
          size="sm"
          label="Tidy"
          width={300}
          align="left"
          items={[
            { key: "sort", label: "Sort lines A to Z", onSelect: () => onChange(sortRows(sheet), "Sorted the lines") },
            { key: "prune", label: "Remove pack columns nobody sells", onSelect: () => onChange(pruneColumns(sheet), "Removed empty columns") },
            {
              key: "remove",
              label: selected.size ? `Remove ${selected.size} ticked line${selected.size === 1 ? "" : "s"}` : "Tick lines to remove them",
              destructive: true,
              disabled: !selected.size,
              onSelect: () => {
                onChange(removeRows(sheet, selected), `Removed ${selected.size} line${selected.size === 1 ? "" : "s"}`);
                setSelected(new Set());
              },
            },
          ]}
        />
        <div className="ml-auto flex items-center gap-3">
          <Checkbox className="whitespace-nowrap" label={sheet.taxBasis === "inclusive" ? "Show ex-GST" : "Show per litre"} checked={showEx} onChange={(e) => setShowEx(e.target.checked)} />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a line" className="w-[180px]" />
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 text-[12px] text-muted">
        <span>
          <span className="font-medium text-body">{stats.rows}</span> lines × <span className="font-medium text-body">{stats.columns}</span> packs
        </span>
        <span>
          <span className="font-medium text-success">{stats.priced}</span> priced
        </span>
        <span>
          <span className={cx("font-medium", stats.empty ? "text-warn-ink" : "text-body")}>{stats.empty}</span> empty
        </span>
        <span>
          <span className="font-medium text-body">{stats.notSold}</span> not sold (—)
        </span>
        <span title="Cells where the catalogue has no such pack of that product">{stats.impossible} not in the catalogue</span>
        <span className="ml-auto">
          Type a price, <kbd className="rounded border border-line px-1">-</kbd> for not sold, Enter to move down. Paste a block from Excel into any cell.
        </span>
        {notice ? <span className="w-full text-brand">{notice}</span> : null}
      </div>

      {/* ------------------------------------------------------------ grid */}
      {/* No horizontal padding on the scroller: a sticky cell pins to its padding
          edge, so prices scrolled sideways would show through the gutter beside
          the frozen columns. The gutter is the first column's own padding. */}
      <div className="min-h-0 flex-1 overflow-auto pr-5 pb-5">
        {sheet.rows.length === 0 ? (
          <div className="mt-6 ml-5 rounded-[6px] border border-dashed border-line-strong bg-canvas px-6 py-12 text-center">
            <div className="text-[15px] font-semibold text-ink">No product lines yet</div>
            <p className="mx-auto mt-1 max-w-[440px] text-[13px] text-muted">
              Add the lines this list prices. Each one brings the pack sizes the catalogue sells it in, and every cell
              becomes a price on a real SKU.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="primary" onClick={() => setPicking(true)}>
                Add product lines
              </Button>
              <Button
                variant="secondary"
                onClick={() => onChange(addFamilies(sheet, familiesOf(products.filter((p) => p.active))), "Added every active line")}
              >
                Add every active line
              </Button>
            </div>
          </div>
        ) : (
          <table className="border-separate border-spacing-0 text-[13px]" style={{ minWidth: 320 + sheet.columns.length * 118 }}>
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-30 w-[52px] min-w-[52px] border-b border-line bg-surface py-2 pr-2 pl-5 text-left">
                  <input
                    type="checkbox"
                    aria-label="Tick every line"
                    className="h-[15px] w-[15px] accent-[#6835FB]"
                    checked={allTicked}
                    onChange={() => setSelected(allTicked ? new Set() : new Set(shown.map((r) => r.key)))}
                  />
                </th>
                <th className="sticky top-0 left-[52px] z-30 min-w-[260px] border-r border-b border-line bg-surface px-2 py-2 text-left text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  Product, as printed
                </th>
                {sheet.columns.map((c) => (
                  <th key={c.key} className="sticky top-0 z-20 min-w-[118px] border-b border-line bg-surface px-2 py-1.5 text-right">
                    <div className="flex items-start justify-end gap-1">
                      <div>
                        <div className="text-[13px] font-semibold text-ink">{c.sizeLabel}</div>
                        <div className="text-[11px] font-normal text-muted">{c.packLabel}</div>
                      </div>
                      <RowMenu
                        items={[
                          {
                            label: "Clear this pack",
                            onSelect: () =>
                              onChange(
                                {
                                  ...sheet,
                                  rows: sheet.rows.map((r) =>
                                    r.cells[c.key]?.productId ? { ...r, cells: { ...r.cells, [c.key]: { ...r.cells[c.key], printedPaise: null, offered: true } } } : r,
                                  ),
                                },
                                `Cleared the ${c.sizeLabel} column`,
                              ),
                          },
                          {
                            label: "Mark this pack not sold",
                            onSelect: () =>
                              onChange(
                                {
                                  ...sheet,
                                  rows: sheet.rows.map((r) =>
                                    r.cells[c.key]?.productId ? { ...r, cells: { ...r.cells, [c.key]: { ...r.cells[c.key], printedPaise: null, offered: false } } } : r,
                                  ),
                                },
                                `Marked ${c.sizeLabel} not sold`,
                              ),
                          },
                          { label: "Remove this pack from the paper", destructive: true, onSelect: () => onChange(removeColumn(sheet, c.key), `Removed the ${c.sizeLabel} column`) },
                        ]}
                      />
                    </div>
                  </th>
                ))}
                <th className="sticky top-0 z-20 border-b border-line bg-surface" />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const r = sheet.rows.indexOf(row);
                const ticked = selected.has(row.key);
                const family = families.get(row.familyKey);
                return (
                  <tr key={row.key} className={cx("group", ticked && "[&>td]:bg-brand-soft/60")}>
                    <td className="sticky left-0 z-10 w-[52px] min-w-[52px] border-b border-divider bg-surface py-1.5 pr-2 pl-5 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Tick ${row.label}`}
                        className="mt-2 h-[15px] w-[15px] accent-[#6835FB]"
                        checked={ticked}
                        onChange={() => toggleRow(row.key)}
                      />
                    </td>
                    <td className="sticky left-[52px] z-10 border-r border-b border-divider bg-surface px-2 py-1.5 align-top">
                      <LabelInput value={row.label} onCommit={(v) => onChange(setRowLabel(sheet, row.key, v), "Renamed a line")} />
                      <div className="mt-0.5 truncate pl-2 text-[11px] text-muted" title={family?.formulation ?? undefined}>
                        {family ? `${family.name}${family.formulation ? ` · ${family.formulation}` : ""}` : "Not in the catalogue"}
                      </div>
                    </td>
                    {sheet.columns.map((c, ci) => (
                      <td key={c.key} className="border-b border-divider px-1.5 py-1.5 align-top">
                        <PriceCell
                          id={`pl-cell-${r}-${ci}`}
                          cell={row.cells[c.key]}
                          column={c}
                          sheet={sheet}
                          baseline={row.cells[c.key]?.productId && baseline ? baseline[row.cells[c.key].productId!] : undefined}
                          flag={flags.get(`${row.key}::${c.key}`)}
                          showEx={showEx}
                          onCommit={(patch) => onChange(setCell(sheet, row.key, c.key, patch), "Changed a price")}
                          onMove={(dr, dc) => focusCell(r + dr, ci + dc)}
                          onPasteBlock={(block) => {
                            const out = pasteBlock(sheet, { rowKey: row.key, columnKey: c.key }, block, parseCellText);
                            onChange(out.sheet, `Pasted ${out.written} prices`);
                            setNotice(`Pasted ${out.written} price${out.written === 1 ? "" : "s"}. Cells with no such pack were skipped.`);
                          }}
                        />
                      </td>
                    ))}
                    <td className="border-b border-divider px-1 py-1.5 align-top">
                      <RowMenu
                        items={[
                          { label: "Move up", onSelect: () => onChange(moveRow(sheet, row.key, -1), "Moved a line"), disabled: r === 0 },
                          { label: "Move down", onSelect: () => onChange(moveRow(sheet, row.key, 1), "Moved a line"), disabled: r === sheet.rows.length - 1 },
                          {
                            label: "Clear this line's prices",
                            onSelect: () => onChange(applyBulk(sheet, { kind: "clear" }, new Set([row.key])).sheet, `Cleared ${row.label}`),
                          },
                          {
                            label: "Mark its empty cells not sold",
                            onSelect: () => onChange(applyBulk(sheet, { kind: "not_sold_empty" }, new Set([row.key])).sheet, `Dashed ${row.label}`),
                          },
                          {
                            label: "Reset the printed name",
                            onSelect: () => onChange(setRowLabel(sheet, row.key, family?.name ?? row.label), "Reset a name"),
                            disabled: !family || family.name === row.label,
                          },
                          { label: "Remove this line", destructive: true, onSelect: () => onChange(removeRows(sheet, new Set([row.key])), `Removed ${row.label}`) },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {picking ? (
        <FamilyPicker
          products={products}
          present={new Set(sheet.rows.map((r) => r.familyKey))}
          onClose={() => setPicking(false)}
          onAdd={(keys, allPacks) => {
            const chosen = keys.map((k) => families.get(k)!).filter(Boolean);
            onChange(addFamilies(sheet, chosen, { withAllPacks: allPacks }), `Added ${chosen.length} line${chosen.length === 1 ? "" : "s"}`);
            setPicking(false);
          }}
        />
      ) : null}
      {bulk ? (
        <BulkModal
          kind={bulk}
          sheet={sheet}
          scope={scope}
          scopeWords={scopeWords}
          onClose={() => setBulk(null)}
          onApply={(next, n, label) => {
            onChange(next, label);
            setNotice(`${label}: ${n} cell${n === 1 ? "" : "s"} changed.`);
            setBulk(null);
          }}
        />
      ) : null}
      {filling ? (
        <FillModal
          sheet={sheet}
          lists={lists}
          scope={scope}
          scopeWords={scopeWords}
          loadSheet={loadSheet}
          onClose={() => setFilling(false)}
          onApply={(next, n, from) => {
            onChange(next, `Filled from ${from}`);
            setNotice(`${n} price${n === 1 ? "" : "s"} filled from ${from}.`);
            setFilling(false);
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- a cell */

function PriceCell(props: {
  id: string;
  cell: SheetCell | undefined;
  column: SheetColumn;
  sheet: PriceSheet;
  baseline: number | undefined;
  flag: Flag | undefined;
  showEx: boolean;
  onCommit: (patch: Partial<SheetCell>) => void;
  onMove: (dr: number, dc: number) => void;
  onPasteBlock: (block: string[][]) => void;
}) {
  const { cell } = props;
  if (!cell?.productId) {
    return (
      <div
        className="flex h-[30px] items-center justify-end rounded-[4px] bg-canvas px-2 text-[11px] text-line-strong"
        title={`The catalogue has no ${props.column.sizeLabel} ${props.column.packLabel} of this product, so there is no can to price.`}
      >
        n/a
      </div>
    );
  }
  // Keyed on the committed value so an undo, a paste or a bulk change resets the box.
  return <PriceInput key={`${cell.offered}:${cell.printedPaise}`} {...props} cell={cell} />;
}

function PriceInput({
  id,
  cell,
  column,
  sheet,
  baseline,
  flag,
  showEx,
  onCommit,
  onMove,
  onPasteBlock,
}: {
  id: string;
  cell: SheetCell;
  column: SheetColumn;
  sheet: PriceSheet;
  baseline: number | undefined;
  flag: Flag | undefined;
  showEx: boolean;
  onCommit: (patch: Partial<SheetCell>) => void;
  onMove: (dr: number, dc: number) => void;
  onPasteBlock: (block: string[][]) => void;
}) {
  const [text, setText] = React.useState(display(cell));
  const [bad, setBad] = React.useState(false);

  function commit() {
    const v = parseCellText(text);
    if (!v) {
      setBad(true);
      return;
    }
    setBad(false);
    if (v.offered === cell.offered && v.printedPaise === cell.printedPaise) return;
    onCommit(v);
  }

  const delta =
    baseline != null && cell.offered && cell.printedPaise != null && baseline !== cell.printedPaise
      ? (cell.printedPaise - baseline) / baseline
      : null;
  const sub =
    showEx && cell.offered && cell.printedPaise != null
      ? sheet.taxBasis === "inclusive"
        ? `ex ${groupRupees(exFromIncl(cell.printedPaise, sheet.gstBp))}`
        : column.millilitres
          ? `${groupRupees(Math.round((cell.printedPaise * 1000) / column.millilitres))}/L`
          : null
      : null;

  return (
    <div>
      <div
        className={cx(
          "flex h-[30px] items-center rounded-[4px] border bg-surface pr-1 focus-within:border-brand",
          bad || flag === "block" ? "border-danger" : flag === "warn" ? "border-warn" : "border-line",
          !cell.offered && "bg-canvas",
        )}
      >
        <span className="pl-2 text-[11px] text-muted">{cell.offered ? "Rs." : ""}</span>
        <input
          id={id}
          value={text}
          inputMode="decimal"
          aria-label={`${column.sizeLabel} ${column.packLabel}`}
          placeholder={cell.offered ? "price" : ""}
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
          onBlur={commit}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            const input = e.currentTarget;
            if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              commit();
              onMove(e.shiftKey && e.key === "Enter" ? -1 : 1, 0);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              commit();
              onMove(-1, 0);
            } else if (e.key === "ArrowRight" && input.selectionStart === input.value.length) {
              commit();
              onMove(0, 1);
            } else if (e.key === "ArrowLeft" && input.selectionStart === 0 && input.selectionEnd === 0) {
              commit();
              onMove(0, -1);
            } else if (e.key === "Escape") {
              setText(display(cell));
              setBad(false);
            }
          }}
          onPaste={(e) => {
            const data = e.clipboardData.getData("text/plain");
            if (!/[\t\n]/.test(data.trim())) return;
            e.preventDefault();
            const block = data
              .replace(/\r/g, "")
              .split("\n")
              .filter((l, i, all) => l.length || i < all.length - 1)
              .map((l) => l.split("\t"));
            onPasteBlock(block);
          }}
          className={cx(
            "h-full w-full min-w-0 border-none bg-transparent px-1 text-right tabular-nums outline-none",
            cell.offered ? "text-ink" : "text-center text-muted",
          )}
        />
        {cell.offered ? (
          <button
            type="button"
            tabIndex={-1}
            title="Not sold in this pack on this list — prints a dash"
            onClick={() => onCommit({ offered: false, printedPaise: null })}
            className="hidden h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-[12px] text-muted group-hover:flex hover:bg-canvas"
          >
            —
          </button>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            title="Sell this pack again"
            onClick={() => onCommit({ offered: true })}
            className="h-5 flex-none cursor-pointer rounded px-1 text-[11px] text-brand hover:bg-brand-soft"
          >
            sell
          </button>
        )}
      </div>
      {sub || delta != null ? (
        <div className="mt-0.5 flex justify-end gap-1.5 pr-1 text-[10.5px] tabular-nums">
          {sub ? <span className="text-muted">{sub}</span> : null}
          {delta != null ? (
            <span
              className={delta > 0 ? "text-success" : "text-danger"}
              title={`Was Rs.${groupRupees(baseline!)} on the list this started from`}
            >
              {delta > 0 ? "▲" : "▼"}
              {Math.abs(delta * 100).toFixed(1)}%
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LabelInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  return <LabelBox key={value} value={value} onCommit={onCommit} />;
}

function LabelBox({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = React.useState(value);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim();
        if (!t) setText(value);
        else if (t !== value) onCommit(t);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      title="The name printed down the side of the paper"
      className="h-[30px] w-full rounded-[4px] border border-transparent bg-transparent px-2 font-medium text-ink outline-none hover:border-line focus:border-brand focus:bg-surface"
    />
  );
}

/* ------------------------------------------------------------ the picker */

function FamilyPicker({
  products,
  present,
  onClose,
  onAdd,
}: {
  products: SheetProduct[];
  present: Set<string>;
  onClose: () => void;
  onAdd: (keys: string[], allPacks: boolean) => void;
}) {
  const [q, setQ] = React.useState("");
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [allPacks, setAllPacks] = React.useState(true);
  const [showRetired, setShowRetired] = React.useState(false);
  const all = React.useMemo(() => familiesOf(products), [products]);
  const shown = all.filter((f) => {
    if (present.has(f.key)) return false;
    if (!showRetired && !f.active) return false;
    const t = q.trim().toLowerCase();
    return !t || f.name.toLowerCase().includes(t) || (f.formulation ?? "").toLowerCase().includes(t);
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Add product lines"
      width={620}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!chosen.size} onClick={() => onAdd([...chosen], allPacks)}>
            Add {chosen.size || ""} line{chosen.size === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by line or formulation — “Nano”, “PU”" className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setChosen(new Set(shown.map((f) => f.key)))} disabled={!shown.length}>
          Tick all {shown.length}
        </Button>
      </div>
      <div className="mb-3 flex flex-wrap gap-4">
        <Checkbox label="Bring every pack each line sells" checked={allPacks} onChange={(e) => setAllPacks(e.target.checked)} />
        <Checkbox label="Show retired lines" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted">{q ? "No line answers to that." : "Every line is already on the sheet."}</p>
      ) : (
        <ul className="divide-y divide-divider rounded-[4px] border border-line">
          {shown.map((f) => (
            <li key={f.key}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-canvas">
                <input
                  type="checkbox"
                  className="h-[15px] w-[15px] accent-[#6835FB]"
                  checked={chosen.has(f.key)}
                  onChange={() =>
                    setChosen((s) => {
                      const n = new Set(s);
                      if (n.has(f.key)) n.delete(f.key);
                      else n.add(f.key);
                      return n;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{f.name}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {f.formulation ?? "No formulation"} ·{" "}
                    {f.products
                      .filter((p) => p.active || showRetired)
                      .map((p) => columnOf(p).sizeLabel)
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .join(", ")}
                  </span>
                </span>
                {!f.active ? <Badge tone="muted">retired</Badge> : null}
                <span className="text-[12px] text-muted">{f.products.length} SKUs</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------- bulk change */

function BulkModal({
  kind,
  sheet,
  scope,
  scopeWords,
  onClose,
  onApply,
}: {
  kind: BulkChange["kind"];
  sheet: PriceSheet;
  scope: Set<string> | null;
  scopeWords: string;
  onClose: () => void;
  onApply: (next: PriceSheet, changed: number, label: string) => void;
}) {
  const [amount, setAmount] = React.useState("");
  const [step, setStep] = React.useState("100");
  const [mode, setMode] = React.useState<"nearest" | "up" | "down">("nearest");

  const change: BulkChange | null = React.useMemo(() => {
    const n = Number(amount);
    switch (kind) {
      case "percent":
        return amount.trim() && Number.isFinite(n) ? { kind, bp: Math.round(n * 100) } : null;
      case "per_litre":
      case "per_can":
        return amount.trim() && Number.isFinite(n) ? { kind, paise: Math.round(n * 100) } : null;
      case "round":
        return { kind, toPaise: Number(step), mode };
      default:
        return { kind } as BulkChange;
    }
  }, [kind, amount, step, mode]);

  const preview = change ? applyBulk(sheet, change, scope) : null;
  const title: Record<BulkChange["kind"], string> = {
    percent: "Raise or lower by a percentage",
    per_litre: "Add or take off an amount per litre",
    per_can: "Add or take off an amount per can",
    round: "Round the prices",
    clear: "Clear the prices",
    not_sold_empty: "Mark empty cells not sold",
    offer_all: "Sell every pack again",
  };
  const label =
    kind === "percent"
      ? `${Number(amount) >= 0 ? "+" : ""}${amount}% on ${scopeWords}`
      : kind === "per_litre"
        ? `${Number(amount) >= 0 ? "+" : ""}₹${amount}/L on ${scopeWords}`
        : kind === "per_can"
          ? `${Number(amount) >= 0 ? "+" : ""}₹${amount}/can on ${scopeWords}`
          : `${title[kind]} on ${scopeWords}`;

  // A few before/after pairs, so the arithmetic is seen before it is done.
  const samples: Array<{ name: string; before: number; after: number }> = [];
  if (preview && (kind === "percent" || kind === "per_litre" || kind === "per_can" || kind === "round")) {
    outer: for (const row of sheet.rows) {
      if (scope && !scope.has(row.key)) continue;
      const after = preview.sheet.rows.find((r) => r.key === row.key)!;
      for (const c of sheet.columns) {
        const a = row.cells[c.key];
        const b = after.cells[c.key];
        if (a?.printedPaise != null && b?.printedPaise != null && a.printedPaise !== b.printedPaise) {
          samples.push({ name: `${row.label} · ${c.sizeLabel}`, before: a.printedPaise, after: b.printedPaise });
          if (samples.length >= 4) break outer;
        }
      }
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title[kind]}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={kind === "clear" ? "danger" : "primary"}
            disabled={!preview || !preview.changed}
            onClick={() => preview && onApply(preview.sheet, preview.changed, label)}
          >
            {preview?.changed ? `Change ${preview.changed} cell${preview.changed === 1 ? "" : "s"}` : "Nothing to change"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        Applies to {scopeWords}. {sheet.taxBasis === "inclusive" ? "Worked on the ex-GST rate and printed back GST-inclusive to the rupee, exactly as a derived list is." : null} Undo puts it all back.
      </p>
      {kind === "percent" || kind === "per_litre" || kind === "per_can" ? (
        <Field
          label={kind === "percent" ? "Percentage (negative to lower)" : kind === "per_litre" ? "Rupees per litre (negative to take off)" : "Rupees per can (negative to take off)"}
        >
          <Input autoFocus type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={kind === "percent" ? "4" : kind === "per_litre" ? "12" : "200"} />
        </Field>
      ) : null}
      {kind === "round" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="To the nearest">
            <Select value={step} onChange={(e) => setStep(e.target.value)} className="w-full">
              <option value="100">₹1</option>
              <option value="500">₹5</option>
              <option value="1000">₹10</option>
              <option value="5000">₹50</option>
            </Select>
          </Field>
          <Field label="Direction">
            <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="w-full">
              <option value="nearest">Nearest</option>
              <option value="up">Always up</option>
              <option value="down">Always down</option>
            </Select>
          </Field>
        </div>
      ) : null}
      {samples.length ? (
        <div className="mt-4 rounded-[4px] border border-line">
          {samples.map((s) => (
            <div key={s.name} className="flex items-center justify-between border-b border-divider px-3 py-1.5 text-[13px] last:border-b-0">
              <span className="truncate text-body">{s.name}</span>
              <span className="tabular-nums">
                <span className="text-muted line-through">Rs.{groupRupees(s.before)}</span>
                <span className="ml-2 font-medium text-ink">Rs.{groupRupees(s.after)}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------ fill from */

function FillModal({
  sheet,
  lists,
  scope,
  scopeWords,
  loadSheet,
  onClose,
  onApply,
}: {
  sheet: PriceSheet;
  lists: PricingOptions["lists"];
  scope: Set<string> | null;
  scopeWords: string;
  loadSheet: (id: string) => Promise<PriceSheet | null>;
  onClose: () => void;
  onApply: (next: PriceSheet, changed: number, from: string) => void;
}) {
  const [listId, setListId] = React.useState("");
  const [other, setOther] = React.useState<PriceSheet | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [overwrite, setOverwrite] = React.useState(false);

  async function pick(id: string) {
    setListId(id);
    setOther(null);
    if (!id) return;
    setLoading(true);
    setOther(await loadSheet(id));
    setLoading(false);
  }

  const preview = other ? fillFrom(sheet, other, { overwrite, rowKeys: scope }) : null;
  const name = lists.find((l) => l.id === listId)?.name ?? "";

  return (
    <Modal
      open
      onClose={onClose}
      title="Fill prices from another list"
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!preview?.changed} onClick={() => preview && onApply(preview.sheet, preview.changed, name)}>
            {preview ? `Fill ${preview.changed} cell${preview.changed === 1 ? "" : "s"}` : "Fill"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        Copies each SKU&apos;s price across onto {scopeWords}, converted to this sheet&apos;s GST basis. Only the SKUs already on this sheet are touched.
      </p>
      <Field label="From">
        <Select value={listId} onChange={(e) => void pick(e.target.value)} className="w-full">
          <option value="">Choose a list…</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} (v{l.version}, {l.status})
            </option>
          ))}
        </Select>
      </Field>
      <div className="mt-3">
        <Checkbox label="Overwrite prices already typed here" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
      </div>
      {loading ? <p className="mt-3 text-[13px] text-muted">Reading that list…</p> : null}
      {preview && !preview.changed ? <p className="mt-3 text-[13px] text-warn-ink">That list has nothing to fill here — no SKU in common, or every cell is already priced.</p> : null}
    </Modal>
  );
}
