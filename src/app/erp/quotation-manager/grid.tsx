"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { erpQuoteApply } from "@/lib/actions/erp-quotes";
import type { PurchaseChoices, QuoteOrder, QuoteSheet } from "@/lib/erp/quotes";
import {
  cleanCell,
  columnStats,
  newQuoteId,
  parseQuoteDate,
  parseTsv,
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_SHORT,
  rateNumber,
  type QuoteColumnKind,
  type QuoteStatus,
} from "@/lib/erp/engines/quotes";
import {
  applySheetOps,
  invertSheetOps,
  visibleColumns,
  visibleRows,
  type SheetColumn,
  type SheetOp,
  type SheetRow,
  type SheetState,
} from "@/lib/erp/engines/quote-sheet";
import { Button, Callout, Card, controlClass, cx, Dot, EmptyState, Field, Input, PageHeader, Select, Td, Th } from "@/components/ui/primitives";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { erpLink } from "@/lib/erp/registry";
import { cleanWhole, stamp } from "@/lib/format";
import { BodyPortal } from "@/components/ui/body-portal";
import { RowMenu } from "@/components/ui/overlays";
import { useErpUi } from "../_ui/erp-ui";
import { DialogBody, DialogTitle, DialogFooter, DialogHeader, ErpDialog } from "../_ui/dialog";
import { eyebrowClass, insetClass, LinkButton, popoverClass } from "../_ui/look";

/**
 * The grid. It behaves like the sheet it replaces: click a cell and type,
 * Enter or Tab to move on, arrows to walk, Shift to select a block, Delete to
 * clear it, Ctrl+C / Ctrl+V to copy and paste blocks from Excel or Google
 * Sheets, Ctrl+Z to undo. Every change is shown at once and saved behind it;
 * a change the server refuses is taken back and said.
 *
 * Grid column 0 is the date, 1 the party, and 2 onwards the sheet's own
 * columns in their order.
 */

type Pos = { r: number; c: number };
type Editing = { r: number; c: number; draft: string; token: number; picker: boolean };
type CellRef = { rowId: string; columnId: string };
type NoteAt = CellRef & { rect: DOMRect; pinned: boolean };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function showDate(d: string): string {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${Number(day)}-${MON[Number(m) - 1]}-${y}` : d;
}

/* The sheet's marks in the design system's tones: the tint of the tone with
   its edge, the same pairing a list row uses for its status. Ready to buy is
   grey — a rate somebody chose, waiting to be bought; bought is yellow. */
const STATUS_CELL: Record<QuoteStatus, string> = {
  ready: "bg-line text-ink shadow-[inset_3px_0_0_var(--color-line-strong)]",
  po: "bg-warn-line text-ink shadow-[inset_3px_0_0_var(--color-warn)]",
  cancel: "bg-danger-soft text-danger line-through decoration-danger/50 shadow-[inset_3px_0_0_var(--color-danger)]",
  pickup: "bg-info-soft text-ink shadow-[inset_3px_0_0_var(--color-info)]",
};

const STATUS_SWATCH: Record<QuoteStatus, string> = {
  ready: "bg-line shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]",
  po: "bg-warn-line shadow-[inset_0_0_0_1.5px_var(--color-warn)]",
  cancel: "bg-danger-soft shadow-[inset_0_0_0_1.5px_var(--color-danger)]",
  pickup: "bg-info-soft shadow-[inset_0_0_0_1.5px_var(--color-info)]",
};

/** When the clock string of a purchase is drawn. */
function stampText(iso: string | null): string {
  return iso ? stamp(iso) : "";
}

/* What the sheet adds to the list screens' header cell (`Th`) and footer cell
   (`Td`). A row is 36px — set as --rowh on the table, which `Td` reads. */
const HEAD = "border-r border-r-divider align-bottom";
const FOOT = "sticky bg-canvas";
const FROZEN_EDGE = "shadow-[inset_-1px_0_0_var(--color-line)]";

const FIXED = 2;

function toState(sheet: QuoteSheet): SheetState {
  return {
    columns: [...sheet.columns.map((c) => ({ ...c, archived: false })), ...sheet.archived.map((c) => ({ ...c, archived: true }))].map(
      ({ id, pack, name, brand, kind, rawMaterialId, archived }) => ({ id, pack, name, brand, kind, rawMaterialId, archived }),
    ),
    rows: sheet.rows.map((r) => ({ id: r.id, date: r.date, party: r.party, status: r.status, seq: r.seq, deleted: false, cells: { ...r.cells } })),
  };
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function QuoteGrid({
  title,
  sub,
  sheet,
  choices,
  today,
  filter,
  sixMonths,
  threeMonths,
  readOnly,
  canReady,
  me,
}: {
  title: string;
  sub: string;
  sheet: QuoteSheet;
  /** What Purchase it offers: godowns, units, and the requirements waiting for a PO. */
  choices: PurchaseChoices;
  today: string;
  filter: { from: string | null; to: string | null; q: string; all: boolean };
  sixMonths: string;
  threeMonths: string;
  readOnly: boolean;
  /** An ERP manager or administrator: may mark a rate Ready to buy. */
  canReady: boolean;
  /** The signed-in person's name, shown on a purchase until the page reloads. */
  me: string;
}) {
  const router = useRouter();
  const ui = useErpUi();
  const [state, setState] = useState<SheetState>(() => toState(sheet));
  const stateRef = useRef(state);
  const [focus, setFocus] = useState<Pos>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState(false);
  const [undo, setUndo] = useState<SheetOp[][]>([]);
  const [colEdit, setColEdit] = useState<{ id: string | null; at: number } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState(filter.q);
  const dragging = useRef(false);
  /* Where an open option picker sits (the rectangle of its cell). */
  const [pickerAt, setPickerAt] = useState<DOMRect | null>(null);
  /* The cell a Purchase it dialog is open for, the PO note showing, and the right-click menu. */
  const [purchase, setPurchase] = useState<CellRef | null>(null);
  const [note, setNote] = useState<NoteAt | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /* An edit is closed once: Enter, Tab and Escape all move focus off the input, and its blur must not save it a second time. */
  const closedToken = useRef(0);
  const nextToken = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const gridRef = useRef<HTMLDivElement>(null);

  const cols = useMemo(() => visibleColumns(state), [state]);
  const rows = useMemo(() => visibleRows(state), [state]);
  const archived = state.columns.filter((c) => c.archived);
  const width = FIXED + cols.length;
  const parties = useMemo(() => [...new Set([...sheet.parties, ...state.rows.map((r) => r.party)].filter(Boolean))].sort(), [sheet.parties, state.rows]);

  /* ---------------------------------------------------------- saving */

  function setBoth(next: SheetState) {
    stateRef.current = next;
    setState(next);
  }

  /** Show `ops`, save them behind, and take them back if the server refuses. */
  function commit(ops: SheetOp[], opts: { recordUndo?: boolean } = {}) {
    if (!ops.length || readOnly) {
      if (readOnly) ui.toast("You are previewing the ERP as somebody else, so nothing can be saved.", "error");
      return;
    }
    const before = stateRef.current;
    const inverse = invertSheetOps(before, ops);
    setBoth(applySheetOps(before, ops));
    if (opts.recordUndo !== false) setUndo((u) => [...u.slice(-49), inverse]);
    setSaving((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        const res = await erpQuoteApply(ops);
        if (!res.ok) {
          setBoth(applySheetOps(stateRef.current, inverse));
          if (opts.recordUndo !== false) setUndo((u) => u.filter((x) => x !== inverse));
          ui.toast(res.error, "error");
          setFailed(true);
        } else {
          setFailed(false);
          /* A purchase's PO number is made by the server; show it once it is. */
          const made = res.data.minted ?? [];
          if (made.length) {
            setBoth(applySheetOps(stateRef.current, made.map((m) => ({ op: "cell" as const, rowId: m.rowId, columnId: m.columnId, poNo: m.poNo }))));
            if (made.length === 1)
              ui.toast(
                made[0].ordered
                  ? `Bought on ${made[0].poNo}. Its purchase order is in Purchase orders, ready to receive.`
                  : `Bought on ${made[0].poNo}. Enter this PO number on the purchase requirement.`,
              );
            else ui.toast(`Bought on ${made.length} new PO numbers.`);
            /* The requirements a purchase took are no longer waiting, and the PO it made can take the vendor's next
               material: fetch the dialog's choices afresh. */
            if (made.some((m) => m.ordered)) router.refresh();
          }
        }
      } catch {
        setBoth(applySheetOps(stateRef.current, inverse));
        ui.toast("That change could not be saved. Check the connection and try again.", "error");
        setFailed(true);
      } finally {
        setSaving((n) => n - 1);
      }
    });
  }

  function doUndo() {
    const last = undo[undo.length - 1];
    if (!last) return;
    setUndo((u) => u.slice(0, -1));
    commit(last, { recordUndo: false });
  }

  /* ---------------------------------------------------------- reading */

  function cellText(row: SheetRow, c: number): string {
    if (c === 0) return row.date;
    if (c === 1) return row.party;
    const col = cols[c - FIXED];
    return col ? (row.cells[col.id]?.value ?? "") : "";
  }

  function cellStatus(row: SheetRow, c: number): QuoteStatus | null {
    if (c < FIXED) return row.status;
    const col = cols[c - FIXED];
    return (col && row.cells[col.id]?.status) || null;
  }

  const sel = {
    r0: Math.min(anchor.r, focus.r),
    r1: Math.max(anchor.r, focus.r),
    c0: Math.min(anchor.c, focus.c),
    c1: Math.max(anchor.c, focus.c),
  };
  const inSel = (r: number, c: number) => r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;

  /* ---------------------------------------------------------- writing */

  /** One value into one cell, as an op — or an error sentence. */
  function writeOp(row: SheetRow, c: number, raw: string): SheetOp | string | null {
    if (c === 0) {
      const d = parseQuoteDate(raw);
      if (!d) return `“${raw}” is not a date. Type it as 14-Oct-2026 or 14/10/2026.`;
      return d === row.date ? null : { op: "row", rowId: row.id, date: d };
    }
    if (c === 1) {
      const p = raw.replace(/\s+/g, " ").trim();
      return p === row.party ? null : { op: "row", rowId: row.id, party: p };
    }
    const col = cols[c - FIXED];
    if (!col) return null;
    const v = cleanCell(col.kind, raw);
    if (!v.ok) return v.error;
    return v.value === (row.cells[col.id]?.value ?? "") ? null : { op: "cell", rowId: row.id, columnId: col.id, value: v.value };
  }

  function move(r: number, c: number, extend = false) {
    const nr = Math.max(0, Math.min(rows.length - 1, r));
    const nc = Math.max(0, Math.min(width - 1, c));
    setFocus({ r: nr, c: nc });
    if (!extend) setAnchor({ r: nr, c: nc });
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-cell="${nr}:${nc}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  /** The party and every text column are picked from a list; dates and rates are typed. */
  function isPickerCell(c: number): boolean {
    return c === 1 || (c >= FIXED && cols[c - FIXED]?.kind === "text");
  }

  function cellRect(r: number, c: number): DOMRect | null {
    return gridRef.current?.querySelector(`[data-cell="${r}:${c}"]`)?.getBoundingClientRect() ?? null;
  }

  function startEdit(r: number, c: number, initial?: string) {
    if (readOnly || !rows[r]) return;
    const row = rows[r];
    const picker = isPickerCell(c);
    const base = c === 0 ? showDate(row.date) : cellText(row, c);
    nextToken.current += 1;
    setNote(null);
    if (picker) setPickerAt(cellRect(r, c));
    setEditing({ r, c, draft: picker ? (initial ?? "") : (initial ?? base), token: nextToken.current, picker });
  }

  /** Picking the party of a row just added, before the rows above have re-rendered. */
  function startEditAt(r: number) {
    nextToken.current += 1;
    requestAnimationFrame(() => setPickerAt(cellRect(r, 1)));
    setEditing({ r, c: 1, draft: "", token: nextToken.current, picker: true });
  }

  function cancelEdit() {
    if (editing) closedToken.current = editing.token;
    setEditing(null);
    setPickerAt(null);
    gridRef.current?.focus();
  }

  function finishEdit(then?: Pos, picked?: string) {
    if (!editing || closedToken.current === editing.token) return;
    closedToken.current = editing.token;
    const row = rows[editing.r];
    setEditing(null);
    setPickerAt(null);
    if (row) {
      const op = writeOp(row, editing.c, picked ?? editing.draft);
      if (typeof op === "string") ui.toast(op, "error");
      else if (op) commit([op]);
    }
    if (then) move(then.r, then.c);
    gridRef.current?.focus();
  }

  function addRow(after?: SheetRow, copyFrom?: SheetRow) {
    const id = newQuoteId("eqr");
    const ops: SheetOp[] = [{ op: "row", rowId: id, create: true, date: after?.date ?? today, party: copyFrom?.party ?? "" }];
    if (copyFrom)
      for (const col of cols) {
        const c = copyFrom.cells[col.id];
        if (c?.value) ops.push({ op: "cell", rowId: id, columnId: col.id, value: c.value });
      }
    commit(ops);
    /* The new row sorts in by date; find where it landed. */
    const next = visibleRows(applySheetOps(stateRef.current, []));
    const at = next.findIndex((r) => r.id === id);
    if (at >= 0) {
      setFocus({ r: at, c: 1 });
      setAnchor({ r: at, c: 1 });
      if (!copyFrom) setTimeout(() => startEditAt(at), 0);
    }
  }

  function clearSelection() {
    const ops: SheetOp[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = Math.max(sel.c0, 1); c <= sel.c1; c++) {
        const op = writeOp(row, c, "");
        if (op && typeof op !== "string") ops.push(op);
      }
    }
    commit(ops);
  }

  /**
   * Put a mark on the selection. The buying rule (quoteStatusRefusal) is the
   * server's, and it refuses a whole save for one wrong cell — so cells the
   * rule would refuse are left as they are here and counted, rather than
   * sinking the rest: a rate with nothing in it is not Ready to buy, a bought
   * rate is changed only by Purchase it, and only a manager marks or unmarks
   * Ready to buy.
   */
  function colour(status: QuoteStatus | null) {
    const ops: SheetOp[] = [];
    let skipped = 0;
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row = rows[r];
      if (!row) continue;
      if (sel.c0 < FIXED && status !== "ready" && row.status !== status) ops.push({ op: "row", rowId: row.id, status });
      for (let c = Math.max(sel.c0, FIXED); c <= sel.c1; c++) {
        const col = cols[c - FIXED];
        if (!col) continue;
        const cell = row.cells[col.id];
        const prev = cell?.status ?? null;
        if (prev === status) continue;
        const blocked =
          (status === "ready" && (!canReady || col.kind !== "rate" || !cell?.value)) ||
          (prev === "po" && !(canReady || status === "ready")) ||
          (prev === "ready" && !canReady);
        if (blocked) {
          skipped++;
          continue;
        }
        ops.push({ op: "cell", rowId: row.id, columnId: col.id, status });
      }
    }
    commit(ops);
    if (skipped)
      ui.toast(
        status === "ready" && !canReady
          ? "Only a manager or an administrator marks a rate Ready to buy."
          : `${skipped} cell${skipped === 1 ? " was" : "s were"} left as ${skipped === 1 ? "it was" : "they were"}: an empty cell cannot be Ready to buy, a bought rate changes through Purchase it, and only a manager takes off Ready to buy.`,
        "error",
      );
    gridRef.current?.focus();
  }

  /* ---------------------------------------------------------- buying */

  function cellAt(ref: CellRef | null) {
    if (!ref) return null;
    const r = rows.findIndex((x) => x.id === ref.rowId);
    const ci = cols.findIndex((x) => x.id === ref.columnId);
    if (r < 0 || ci < 0) return null;
    const row = rows[r];
    const col = cols[ci];
    return { r, c: ci + FIXED, row, col, cell: row.cells[col.id] ?? null };
  }

  function focusedRef(): CellRef | null {
    const row = rows[focus.r];
    const col = focus.c >= FIXED ? cols[focus.c - FIXED] : null;
    return row && col ? { rowId: row.id, columnId: col.id } : null;
  }

  const focusedCell = cellAt(focusedRef());
  const focusedStatus = focusedCell?.cell?.status ?? null;

  function openPurchase(ref: CellRef | null) {
    const at = cellAt(ref);
    if (!at) return;
    const st = at.cell?.status ?? null;
    if (st !== "ready" && st !== "po") {
      ui.toast(canReady ? "Mark the rate Ready to buy first." : "Only a rate a manager has marked Ready to buy can be bought.", "error");
      return;
    }
    setNote(null);
    setMenu(null);
    setPurchase(ref);
  }

  function savePurchase(ref: CellRef, drums: number, order: QuoteOrder | null) {
    commit([{ op: "cell", ...ref, status: "po", drums, poBy: me, poAt: new Date().toISOString(), ...(order ? { order } : {}) }]);
    setPurchase(null);
    gridRef.current?.focus();
  }

  function undoPurchase(ref: CellRef) {
    commit([{ op: "cell", ...ref, status: "ready", drums: null, poNo: null, poBy: null, poAt: null }]);
    setNote(null);
    gridRef.current?.focus();
  }

  function showNote(ref: CellRef, el: HTMLElement, pinned: boolean) {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    const rect = el.getBoundingClientRect();
    if (pinned) setNote({ ...ref, rect, pinned: true });
    else noteTimer.current = setTimeout(() => setNote((n) => (n?.pinned ? n : { ...ref, rect, pinned: false })), 350);
  }

  function hideHoverNote() {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setNote((n) => (n?.pinned ? n : null));
  }

  function copySelection() {
    const lines: string[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row = rows[r];
      if (!row) continue;
      const cells: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) cells.push(c === 0 ? showDate(row.date) : cellText(row, c));
      lines.push(cells.join("\t"));
    }
    void navigator.clipboard?.writeText(lines.join("\n")).then(
      () => ui.toast(`Copied ${lines.length} row${lines.length === 1 ? "" : "s"}.`),
      () => ui.toast("The browser would not let the sheet copy. Use your browser's Copy instead.", "error"),
    );
  }

  function paste(text: string) {
    if (readOnly) return;
    const block = parseTsv(text).filter((l, i, a) => !(i === a.length - 1 && l.length === 1 && l[0] === ""));
    if (!block.length) return;
    const ops: SheetOp[] = [];
    const errors: string[] = [];
    const created: SheetRow[] = [];
    const lastDate = rows.length ? rows[rows.length - 1].date : today;
    for (let i = 0; i < block.length; i++) {
      const r = focus.r + i;
      let row: SheetRow | undefined = rows[r];
      if (!row) {
        const dateCell = focus.c === 0 ? parseQuoteDate(block[i][0] ?? "") : null;
        row = { id: newQuoteId("eqr"), date: dateCell ?? lastDate, party: "", status: null, seq: 0, deleted: false, cells: {} };
        ops.push({ op: "row", rowId: row.id, create: true, date: row.date });
        created.push(row);
      }
      for (let j = 0; j < block[i].length; j++) {
        const c = focus.c + j;
        if (c >= width) break;
        const raw = block[i][j];
        if (c === 0 && !raw.trim()) continue;
        const op = writeOp(row, c, raw);
        if (typeof op === "string") errors.push(op);
        else if (op) ops.push(op);
      }
    }
    commit(ops);
    const extra = block[0].length > width - focus.c ? ` ${block[0].length - (width - focus.c)} column(s) past the last were left out.` : "";
    if (errors.length) ui.toast(`${errors.length} cell(s) were not pasted: ${errors[0]}${extra}`, "error");
    else ui.toast(`Pasted ${block.length} row${block.length === 1 ? "" : "s"}${created.length ? `, ${created.length} of them new` : ""}.${extra}`);
    setAnchor({ r: focus.r, c: focus.c });
    setFocus({ r: focus.r + block.length - 1, c: Math.min(width - 1, focus.c + block[0].length - 1) });
  }

  /* ---------------------------------------------------------- columns */

  function moveColumn(id: string, by: number) {
    const ids = state.columns.map((c) => c.id);
    const vis = cols.map((c) => c.id);
    const i = vis.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= vis.length) return;
    [vis[i], vis[j]] = [vis[j], vis[i]];
    commit([{ op: "order", columnIds: [...vis, ...ids.filter((x) => !vis.includes(x))] }]);
  }

  function saveColumn(id: string | null, at: number, v: { pack: string; name: string; brand: string; kind: QuoteColumnKind; rawMaterialId: string | null }) {
    if (!v.name.trim() && !v.pack.trim()) {
      ui.toast("Give the column a name.", "error");
      return false;
    }
    if (id) {
      commit([{ op: "column", columnId: id, ...v }]);
    } else {
      const nid = newQuoteId("eqc");
      const vis = cols.map((c) => c.id);
      vis.splice(Math.max(0, Math.min(vis.length, at)), 0, nid);
      const rest = state.columns.filter((c) => c.archived).map((c) => c.id);
      commit([{ op: "column", columnId: nid, create: true, ...v }, { op: "order", columnIds: [...vis, ...rest] }]);
    }
    return true;
  }

  /* ---------------------------------------------------------- keyboard */

  function onKey(e: React.KeyboardEvent) {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "z") {
      e.preventDefault();
      doUndo();
      return;
    }
    if (mod && k.toLowerCase() === "c") {
      e.preventDefault();
      copySelection();
      return;
    }
    if (mod && k.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setFocus({ r: rows.length - 1, c: width - 1 });
      return;
    }
    if (mod) return;
    const ext = e.shiftKey;
    switch (k) {
      case "ArrowUp":
        e.preventDefault();
        return move(focus.r - 1, focus.c, ext);
      case "ArrowDown":
        e.preventDefault();
        return move(focus.r + 1, focus.c, ext);
      case "ArrowLeft":
        e.preventDefault();
        return move(focus.r, focus.c - 1, ext);
      case "ArrowRight":
        e.preventDefault();
        return move(focus.r, focus.c + 1, ext);
      case "Tab":
        e.preventDefault();
        return move(focus.r, focus.c + (e.shiftKey ? -1 : 1));
      case "Home":
        e.preventDefault();
        return move(focus.r, 0, ext);
      case "End":
        e.preventDefault();
        return move(focus.r, width - 1, ext);
      case "Enter":
      case "F2":
        e.preventDefault();
        return startEdit(focus.r, focus.c);
      case "ContextMenu": {
        e.preventDefault();
        const rect = cellRect(focus.r, focus.c);
        if (rect) setMenu({ x: rect.left + 8, y: rect.bottom });
        return;
      }
      case "Delete":
      case "Backspace":
        e.preventDefault();
        return clearSelection();
      case "Escape":
        setAnchor(focus);
        return;
    }
    if (k.length === 1 && !e.altKey) {
      e.preventDefault();
      startEdit(focus.r, focus.c, k);
    }
  }

  function onEditKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!editing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finishEdit({ r: editing.r + (e.shiftKey ? -1 : 1), c: editing.c });
    } else if (e.key === "Tab") {
      e.preventDefault();
      finishEdit({ r: editing.r, c: editing.c + (e.shiftKey ? -1 : 1) });
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }

  /* ---------------------------------------------------------- filter */

  function go(next: { from?: string | null; to?: string | null; q?: string }) {
    const p = new URLSearchParams();
    const from = next.from !== undefined ? next.from : filter.all ? "all" : filter.from;
    const to = next.to !== undefined ? next.to : filter.to;
    const q = next.q !== undefined ? next.q : filter.q;
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (q) p.set("q", q);
    router.push(erpLink("quoteManager", Object.fromEntries(p)));
  }

  function exportCsv() {
    const head = ["Date", "Party", ...cols.map((c) => [c.pack, c.name, c.brand].filter(Boolean).join(" · ")), "Colours"];
    const lines = [head.map(csvCell).join(",")];
    for (const r of rows) {
      const marks = [r.status ? `Row: ${QUOTE_STATUS_SHORT[r.status]}` : "", ...cols.map((c) => (r.cells[c.id]?.status ? `${c.name || c.pack}: ${QUOTE_STATUS_SHORT[r.cells[c.id]!.status!]}` : ""))].filter(Boolean);
      lines.push([showDate(r.date), r.party, ...cols.map((c) => r.cells[c.id]?.value ?? ""), marks.join("; ")].map(csvCell).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `quotations-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------------------------------------------------- stats */

  const stats = useMemo(() => {
    /* Oldest first, so the latest rate on a date is the one entered last. */
    const like = [...rows].reverse().map((r) => ({ id: r.id, date: r.date, status: r.status, cells: r.cells }));
    return new Map(cols.filter((c) => c.kind === "rate").map((c) => [c.id, columnStats(like, c.id)]));
  }, [rows, cols]);

  const focusRow = rows[focus.r];
  const editingCol = editing && editing.c >= FIXED ? cols[editing.c - FIXED] : null;
  const columnValues = useMemo(() => {
    if (!editingCol || editingCol.kind !== "text") return [];
    return [...new Set(state.rows.map((r) => r.cells[editingCol.id]?.value ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [editingCol, state.rows]);
  const pickerOptions = !editing?.picker ? [] : editing.c === 1 ? parties : columnValues;
  const pickerCol = editing?.picker && editing.c >= FIXED ? cols[editing.c - FIXED] : null;

  const preset = filter.all ? "all" : filter.from === sixMonths && !filter.to ? "6" : filter.from === threeMonths && !filter.to ? "3" : "custom";

  return (
    <>
      <PageHeader
        title={title}
        subtitle={sub}
        actions={
          <>
            <Button onClick={exportCsv}>Export CSV</Button>
            <Button onClick={() => setColEdit({ id: null, at: cols.length })} disabled={readOnly}>
              Add column
            </Button>
            <Button variant="primary" onClick={() => addRow()} disabled={readOnly}>
              Add row
            </Button>
          </>
        }
      />

      {sheet.truncated ? (
        <Callout>
          <span className="text-sm text-warn-ink">Only the newest 3,000 rows of this period are shown. Narrow the dates to see older ones.</span>
        </Callout>
      ) : null}

      <Card className="relative">
        {saving ? <span aria-hidden className="absolute inset-x-0 top-0 z-40 h-0.5 animate-pulse rounded-t-card bg-brand" /> : null}

        {/* Toolbar — the list screens' own: search, period, then what the sheet can do. */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3">
          <form
            className="relative w-[260px] max-w-full"
            onSubmit={(e) => {
              e.preventDefault();
              go({ q: search.trim() });
            }}
          >
            <ShellIcon name="search" size={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party" aria-label="Search party" className="pr-7 pl-7.5" />
            {search ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  if (filter.q) go({ q: "" });
                }}
                aria-label="Clear search"
                className="absolute top-[7px] right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center text-muted hover:text-body"
              >
                <ShellIcon name="close" size={14} />
              </button>
            ) : null}
          </form>
          <Select
            value={preset}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "all") go({ from: "all", to: null });
              else if (v === "6") go({ from: sixMonths, to: null });
              else if (v === "3") go({ from: threeMonths, to: null });
            }}
            aria-label="Period"
          >
            <option value="3">Last 3 months</option>
            <option value="6">Last 6 months</option>
            <option value="all">Every date</option>
            {preset === "custom" ? <option value="custom">Chosen dates</option> : null}
          </Select>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-[136px]">
              <Input type="date" value={filter.all ? "" : (filter.from ?? "")} onChange={(e) => e.target.value && go({ from: e.target.value })} aria-label="From" />
            </span>
            <span className="text-meta text-muted">to</span>
            <span className="w-[136px]">
              <Input type="date" value={filter.to ?? ""} onChange={(e) => go({ to: e.target.value || null })} aria-label="To" />
            </span>
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5 text-meta text-muted" aria-live="polite">
            <Dot tone={failed ? "danger" : saving ? "brand" : readOnly ? "muted" : "success"} />
            {saving ? "Saving…" : failed ? "Last change not saved" : readOnly ? "Preview — read only" : "All changes saved"}
          </span>
          <Button size="sm" variant="ghost" onClick={doUndo} disabled={!undo.length || readOnly} title="Undo (Ctrl+Z)">
            Undo
          </Button>
          {archived.length ? (
            <Button size="sm" variant="ghost" onClick={() => setShowArchived(true)}>
              Removed columns · {archived.length}
            </Button>
          ) : null}
        </div>

        {/* Marking — the sheet's legend, and the way a mark is put on. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-canvas px-4 py-2">
          <span className={cx("mr-1", eyebrowClass)}>Mark selected</span>
          {canReady ? (
            <MarkButton status="ready" disabled={readOnly} onClick={() => colour("ready")} title="Choose this rate to buy — the cell turns grey and the team can buy it" />
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={readOnly || (focusedStatus !== "ready" && focusedStatus !== "po")}
            onClick={() => openPurchase(focusedRef())}
            title={focusedStatus === "ready" || focusedStatus === "po" ? "Record the drums for this rate; the PO number is made for you" : "Select a grey (Ready to buy) rate to buy it"}
          >
            <span aria-hidden className={cx("h-3 w-3 rounded-[3px]", STATUS_SWATCH.po)} />
            {focusedStatus === "po" ? "Edit purchase" : "Purchase it"}
          </Button>
          <MarkButton status="cancel" disabled={readOnly} onClick={() => colour("cancel")} />
          <MarkButton status="pickup" disabled={readOnly} onClick={() => colour("pickup")} />
          <LinkButton tone="muted" disabled={readOnly} onClick={() => colour(null)} className="px-2 text-meta">
            Clear mark
          </LinkButton>
          <span className="ml-auto text-xs text-muted">Right-click a cell for more · Ctrl+V pastes from Excel · Ctrl+Z undoes</span>
        </div>

        <div
          ref={gridRef}
          tabIndex={0}
          onKeyDown={onKey}
          onPaste={(e) => {
            if (editing) return;
            e.preventDefault();
            paste(e.clipboardData.getData("text/plain"));
          }}
          onScroll={() => {
            if (note) setNote(null);
            if (menu) setMenu(null);
          }}
          onMouseUp={() => (dragging.current = false)}
          onMouseLeave={() => (dragging.current = false)}
          className="max-h-[calc(100vh-300px)] overflow-auto rounded-b-card outline-none"
        >
          <table className="border-separate border-spacing-0 [--rowh:36px]" style={{ minWidth: "100%" }}>
            <thead>
              <tr>
                <Th className={cx(HEAD, "left-0 z-30 w-[52px] min-w-[52px] tabular-nums")} title="Rows shown">
                  <span className="block text-center">{rows.length}</span>
                </Th>
                <Th className={cx(HEAD, "left-[52px] z-30 w-[124px] min-w-[124px]")}>Date</Th>
                <Th className={cx(HEAD, FROZEN_EDGE, "left-[176px] z-30 w-[220px] min-w-[220px]")}>Party</Th>
                {cols.map((c, i) => {
                  const colSelected = sel.c0 <= FIXED + i && FIXED + i <= sel.c1;
                  return (
                    <Th
                      key={c.id}
                      align={c.kind === "text" ? "left" : "right"}
                      onClick={(e) => {
                        if (e.shiftKey) setFocus({ r: rows.length - 1, c: FIXED + i });
                        else {
                          setAnchor({ r: 0, c: FIXED + i });
                          setFocus({ r: Math.max(0, rows.length - 1), c: FIXED + i });
                        }
                        gridRef.current?.focus();
                      }}
                      onDoubleClick={() => !readOnly && setColEdit({ id: c.id, at: i })}
                      className={cx(HEAD, "group z-20 cursor-pointer pt-2 pb-1.5 font-normal hover:bg-divider", c.kind === "text" ? "min-w-[160px]" : "min-w-[128px]")}
                      title={`${[c.pack, c.name, c.brand].filter(Boolean).join(" · ")}\nClick to select the column · double-click to edit it`}
                    >
                      {/* A selected column is tinted over the cell, since `Th` carries its own ground. */}
                      {colSelected ? <span aria-hidden className="pointer-events-none absolute inset-0 bg-brand-soft" /> : null}
                      <div className={cx("relative h-4 truncate leading-4", eyebrowClass)}>{c.pack}</div>
                      <div className="relative text-meta leading-tight font-semibold tracking-normal whitespace-normal text-ink normal-case">{c.name || <span className="font-normal text-muted">Untitled</span>}</div>
                      <div className="relative h-4 truncate text-2xs leading-4 tracking-normal text-muted normal-case">{c.brand}</div>
                      {!readOnly ? (
                        <span className={cx("relative mt-1 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100", c.kind === "text" ? "justify-start" : "justify-end")}>
                          <HeadBtn label="Move left" onClick={() => moveColumn(c.id, -1)} disabled={i === 0}>
                            <ShellIcon name="chevron" size={12} className="rotate-180" />
                          </HeadBtn>
                          <HeadBtn label="Move right" onClick={() => moveColumn(c.id, 1)} disabled={i === cols.length - 1}>
                            <ShellIcon name="chevron" size={12} />
                          </HeadBtn>
                          <HeadBtn label="Insert a column after" onClick={() => setColEdit({ id: null, at: i + 1 })}>
                            <ShellIcon name="plus" size={12} />
                          </HeadBtn>
                          <HeadBtn label="Edit column" onClick={() => setColEdit({ id: c.id, at: i })}>
                            <ShellIcon name="settings" size={12} />
                          </HeadBtn>
                        </span>
                      ) : null}
                    </Th>
                  );
                })}
                <Th className="z-20 w-full" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => {
                const rowSelected = sel.r0 <= r && r <= sel.r1;
                return (
                  <tr key={row.id} className="group/row">
                    <Td className={cx("sticky left-0 z-10 border-r border-b border-divider", rowSelected ? "bg-brand-soft" : "bg-canvas")}>
                      {/* `Td` pads 12px a side; the 52px number column wants 4. */}
                      <span className="-mx-2 flex items-center justify-between gap-0.5">
                        <button
                          type="button"
                          className={cx("min-w-[22px] cursor-pointer text-2xs tabular-nums", rowSelected ? "font-medium text-brand-hover" : "text-muted hover:text-body")}
                          onClick={(e) => {
                            if (e.shiftKey) setFocus({ r, c: width - 1 });
                            else {
                              setAnchor({ r, c: 0 });
                              setFocus({ r, c: width - 1 });
                            }
                            gridRef.current?.focus();
                          }}
                          title="Select the row"
                        >
                          {r + 1}
                        </button>
                        {!readOnly ? (
                          <span className="opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
                            <RowMenu
                              items={[
                                { label: "Add a row, same date", onSelect: () => addRow(row) },
                                { label: "Duplicate this row", onSelect: () => addRow(row, row) },
                                { label: "Delete this row", destructive: true, onSelect: () => commit([{ op: "deleteRow", rowId: row.id }]) },
                              ]}
                            />
                          </span>
                        ) : null}
                      </span>
                    </Td>
                    {Array.from({ length: width }, (_, c) => {
                      const st = cellStatus(row, c);
                      const isFocus = focus.r === r && focus.c === c;
                      const isEdit = editing?.r === r && editing.c === c;
                      const col = c >= FIXED ? cols[c - FIXED] : null;
                      const val = c === 0 ? showDate(row.date) : cellText(row, c);
                      const rate = col?.kind === "rate";
                      const s = col && rate ? stats.get(col.id) : null;
                      const n = rate ? rateNumber(val) : null;
                      const lowest = s && n != null && s.count > 1 && n === s.lowest && st !== "cancel";
                      return (
                        <Td
                          key={c}
                          align={rate ? "right" : "left"}
                          data-cell={`${r}:${c}`}
                          onMouseDown={(e) => {
                            if (isEdit) return;
                            if (e.shiftKey) setFocus({ r, c });
                            else {
                              setFocus({ r, c });
                              setAnchor({ r, c });
                            }
                            dragging.current = true;
                            gridRef.current?.focus();
                          }}
                          onMouseEnter={(e) => {
                            if (dragging.current) setFocus({ r, c });
                            else if (st === "po" && col && !isEdit) showNote({ rowId: row.id, columnId: col.id }, e.currentTarget, false);
                          }}
                          onMouseLeave={() => st === "po" && hideHoverNote()}
                          onClick={(e) => {
                            if (st === "po" && col && !e.shiftKey && !isEdit) showNote({ rowId: row.id, columnId: col.id }, e.currentTarget, true);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (!inSel(r, c)) {
                              setFocus({ r, c });
                              setAnchor({ r, c });
                            } else setFocus({ r, c });
                            hideHoverNote();
                            setMenu({ x: e.clientX, y: e.clientY });
                          }}
                          onDoubleClick={() => startEdit(r, c)}
                          className={cx(
                            "relative border-r border-b border-divider",
                            c === 0 && "sticky left-[52px] z-10 text-body",
                            c === 1 && cx("sticky left-[176px] z-10 max-w-[220px] truncate font-medium text-ink", FROZEN_EDGE),
                            c >= FIXED && "text-body",
                            rate && "tabular-nums",
                            st ? STATUS_CELL[st] : "bg-surface",
                            lowest && "font-semibold text-success",
                          )}
                          title={st === "po" ? undefined : st ? QUOTE_STATUS_LABEL[st] : lowest ? "Lowest rate in this column for the rows shown" : c === 1 && val ? val : undefined}
                        >
                          {inSel(r, c) && !isFocus ? <span className="pointer-events-none absolute inset-0 bg-brand/8" /> : null}
                          {isFocus ? <span className="pointer-events-none absolute inset-0 z-[1] outline-2 -outline-offset-2 outline-brand" /> : null}
                          {st === "po" ? <span aria-hidden className="pointer-events-none absolute top-0 right-0 z-[1] border-t-[7px] border-l-[7px] border-t-warn border-l-transparent" /> : null}
                          {isEdit && editing.picker ? (
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate">{val || <span className="text-muted">Choose…</span>}</span>
                              <ShellIcon name="chevron" size={14} className="shrink-0 rotate-90 text-brand" />
                            </span>
                          ) : isEdit ? (
                            <input
                              autoFocus
                              value={editing.draft}
                              autoComplete="off"
                              inputMode={rate ? "decimal" : undefined}
                              onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                              onKeyDown={onEditKey}
                              onBlur={() => finishEdit()}
                              className={cx("absolute inset-0 z-[2] w-full rounded-[2px] border-2 border-brand bg-surface px-[10px] text-sm text-ink outline-none", rate && "text-right tabular-nums")}
                            />
                          ) : (
                            val
                          )}
                        </Td>
                      );
                    })}
                    <Td className="border-b border-divider bg-surface" />
                  </tr>
                );
              })}
            </tbody>
            {rows.length ? (
              <tfoot>
                {(["latest", "lowest"] as const).map((k, fi) => (
                  /* Both rows stay in view: the first sits one row-height above the second. */
                  <tr key={k} className={fi === 0 ? "[&>td]:bottom-9" : "[&>td]:bottom-0"}>
                    <Td className={cx(FOOT, "left-0 z-20", fi === 0 && "border-t border-line")} />
                    <Td colSpan={2} className={cx(FOOT, FROZEN_EDGE, "left-[52px] z-20", fi === 0 && "border-t border-line")}>
                      <span className={eyebrowClass}>{k === "latest" ? "Latest rate" : "Lowest rate"}</span>
                    </Td>
                    {cols.map((c) => {
                      const s = stats.get(c.id);
                      return (
                        <Td
                          key={c.id}
                          align="right"
                          className={cx(FOOT, "border-r border-divider font-semibold text-ink tabular-nums", fi === 0 && "border-t border-line")}
                          title={k === "latest" && s?.latestDate ? `Quoted ${showDate(s.latestDate)}` : undefined}
                        >
                          <span className="text-meta">{s ? (k === "latest" ? (s.latest ?? "—") : (s.lowest ?? "—")) : ""}</span>
                        </Td>
                      );
                    })}
                    <Td className={cx(FOOT, fi === 0 && "border-t border-line")} />
                  </tr>
                ))}
              </tfoot>
            ) : null}
          </table>
          {!rows.length ? (
            <EmptyState
              title={filter.q || filter.to || !filter.all ? "No quotations in this period" : "No quotations yet"}
              body="Add a row for each quotation, or select a cell and paste a block straight from your sheet."
              action={!readOnly ? <Button variant="primary" onClick={() => addRow()}>Add row</Button> : undefined}
            />
          ) : null}
        </div>
      </Card>

      {editing?.picker && pickerAt ? (
        <OptionPicker
          key={editing.token}
          anchor={pickerAt}
          title={editing.c === 1 ? "Party" : pickerCol?.name || "Value"}
          noun={editing.c === 1 ? "parties" : "values"}
          options={pickerOptions}
          value={rows[editing.r] ? cellText(rows[editing.r], editing.c) : ""}
          initialQuery={editing.draft}
          onPick={(v) => finishEdit(undefined, v)}
          onClose={cancelEdit}
        />
      ) : null}

      {note
        ? (() => {
            const at = cellAt(note);
            if (!at || at.cell?.status !== "po") return null;
            return (
              <PoNote
                at={note.rect}
                pinned={note.pinned}
                rowNo={at.r + 1}
                date={showDate(at.row.date)}
                party={at.row.party}
                column={[at.col.pack, at.col.name, at.col.brand].filter(Boolean).join(" · ")}
                rate={at.cell.value}
                drums={at.cell.drums}
                poNo={at.cell.poNo}
                by={at.cell.poBy}
                when={stampText(at.cell.poAt)}
                readOnly={readOnly}
                onClose={() => setNote(null)}
                onEdit={() => openPurchase(note)}
                onUndo={() => undoPurchase(note)}
              />
            );
          })()
        : null}

      {menu ? (
        <CellMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            gridRef.current?.focus();
          }}
          items={[
            { label: "Edit cell", hint: "Enter", onSelect: () => startEdit(focus.r, focus.c), disabled: readOnly },
            ...(focusedCell
              ? focusedStatus === "po"
                ? [
                    { label: "View PO note", onSelect: () => { const el = gridRef.current?.querySelector(`[data-cell="${focus.r}:${focus.c}"]`); if (el instanceof HTMLElement) showNote(focusedRef()!, el, true); } },
                    { label: "Edit purchase…", onSelect: () => openPurchase(focusedRef()), disabled: readOnly },
                    { label: "Undo purchase (back to Ready to buy)", onSelect: () => undoPurchase(focusedRef()!), disabled: readOnly },
                  ]
                : focusedStatus === "ready"
                  ? [
                      { label: "Purchase it…", onSelect: () => openPurchase(focusedRef()), disabled: readOnly, strong: true },
                      ...(canReady ? [{ label: "Remove Ready to buy", onSelect: () => colour(null), disabled: readOnly }] : []),
                    ]
                  : canReady && focusedCell.col.kind === "rate"
                    ? [{ label: "Mark Ready to buy", onSelect: () => colour("ready"), disabled: readOnly || !focusedCell.cell?.value }]
                    : []
              : []),
            { label: "Mark cancelled", onSelect: () => colour("cancel"), disabled: readOnly, divider: true },
            { label: "Mark picked up", onSelect: () => colour("pickup"), disabled: readOnly },
            { label: "Clear mark", onSelect: () => colour(null), disabled: readOnly },
            { label: "Copy", hint: "Ctrl+C", onSelect: copySelection, divider: true },
          ]}
        />
      ) : null}

      {purchase
        ? (() => {
            const at = cellAt(purchase);
            if (!at) return null;
            return (
              <PurchaseDialog
                key={`${purchase.rowId}:${purchase.columnId}`}
                rowNo={at.r + 1}
                date={showDate(at.row.date)}
                party={at.row.party}
                column={[at.col.pack, at.col.name, at.col.brand].filter(Boolean).join(" · ")}
                rate={at.cell?.value ?? ""}
                drums={at.cell?.drums ?? null}
                poNo={at.cell?.poNo ?? ""}
                editing={at.cell?.status === "po"}
                materialId={at.col.rawMaterialId}
                choices={choices}
                today={today}
                onClose={() => setPurchase(null)}
                onSave={(d, order) => savePurchase(purchase, d, order)}
              />
            );
          })()
        : null}

      {focusRow ? (
        <div className="mt-2 flex flex-wrap gap-x-3 text-xs text-muted">
          <span>
            Row {focus.r + 1} · {showDate(focusRow.date)} · {focusRow.party || "no party"}
            {focus.c >= FIXED && cols[focus.c - FIXED] ? ` · ${[cols[focus.c - FIXED].pack, cols[focus.c - FIXED].name].filter(Boolean).join(" ")}` : ""}
          </span>
          {sel.r1 > sel.r0 || sel.c1 > sel.c0 ? <span>{(sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1)} cells selected</span> : null}
        </div>
      ) : null}

      {colEdit ? (
        <ColumnDialog
          key={`${colEdit.id ?? "new"}-${colEdit.at}`}
          column={colEdit.id ? (state.columns.find((c) => c.id === colEdit.id) ?? null) : null}
          materials={sheet.materials}
          onClose={() => setColEdit(null)}
          onSave={(v) => saveColumn(colEdit.id, colEdit.at, v) && setColEdit(null)}
          onRemove={
            colEdit.id
              ? () => {
                  const id = colEdit.id!;
                  ui.confirm("Remove this column? Its rates are kept, and Removed columns brings it back.", () => {
                    commit([{ op: "archiveColumn", columnId: id }]);
                    setColEdit(null);
                    setFocus({ r: focus.r, c: Math.min(focus.c, width - 2) });
                    setAnchor({ r: focus.r, c: Math.min(focus.c, width - 2) });
                  });
                }
              : undefined
          }
        />
      ) : null}

      {showArchived ? (
        <ErpDialog onClose={() => setShowArchived(false)} label="Removed columns" size="sm" tall={false}>
          <DialogHeader onClose={() => setShowArchived(false)}>
            <DialogTitle>Removed columns</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {archived.length ? (
              <ul className="divide-y divide-divider">
                {archived.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span>
                      <span className="font-medium text-ink">{c.name || "Untitled"}</span>
                      {c.pack || c.brand ? <span className="ml-1.5 text-muted">{[c.pack, c.brand].filter(Boolean).join(" · ")}</span> : null}
                    </span>
                    <Button size="sm" onClick={() => commit([{ op: "restoreColumn", columnId: c.id }])}>
                      Bring back
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No column has been removed.</p>
            )}
          </DialogBody>
        </ErpDialog>
      ) : null}
    </>
  );
}

function HeadBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] text-muted hover:bg-surface hover:text-ink disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ColumnDialog({
  column,
  materials,
  onClose,
  onSave,
  onRemove,
}: {
  column: SheetColumn | null;
  materials: { id: string; name: string }[];
  onClose: () => void;
  onSave: (v: { pack: string; name: string; brand: string; kind: QuoteColumnKind; rawMaterialId: string | null }) => void;
  onRemove?: () => void;
}) {
  const [pack, setPack] = useState(column?.pack ?? "");
  const [name, setName] = useState(column?.name ?? "");
  const [brand, setBrand] = useState(column?.brand ?? "");
  const [kind, setKind] = useState<QuoteColumnKind>(column?.kind ?? "rate");
  const [rm, setRm] = useState(column?.rawMaterialId ?? "");
  return (
    <ErpDialog onClose={onClose} label={column ? "Edit column" : "Add a column"} size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{column ? "Edit column" : "Add a column"}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ pack, name, brand, kind, rawMaterialId: rm || null });
          }}
        >
          <Field label="Pack (top line)" hint="185/180 KGS NET, 200 LITER">
            <Input value={pack} onChange={(e) => setPack(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Material (middle line)">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <Field label="Brand (bottom line)" hint="Mahek">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Holds">
            <Select value={kind} onChange={(e) => setKind(e.target.value === "text" ? "text" : "rate")} className="w-full">
              <option value="rate">Rates (numbers)</option>
              <option value="text">Text (a broker, a note)</option>
            </Select>
          </Field>
          <Field label="Raw material" hint="Optional — which item in the master this column is for">
            <Select value={rm} onChange={(e) => setRm(e.target.value)} className="w-full">
              <option value="">Not linked</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <button type="submit" className="hidden" />
        </form>
      </DialogBody>
      <DialogFooter
        left={
          onRemove ? (
            <Button variant="danger" onClick={onRemove}>
              Remove column
            </Button>
          ) : undefined
        }
      >
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave({ pack, name, brand, kind, rawMaterialId: rm || null })}>
          {column ? "Save" : "Add column"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

function MarkButton({ status, disabled, onClick, title }: { status: QuoteStatus; disabled: boolean; onClick: () => void; title?: string }) {
  return (
    <Button size="sm" variant="ghost" disabled={disabled} onClick={onClick} title={title ?? QUOTE_STATUS_LABEL[status]}>
      <span aria-hidden className={cx("h-3 w-3 rounded-[3px]", STATUS_SWATCH[status])} />
      {QUOTE_STATUS_LABEL[status]}
    </Button>
  );
}

/** Where a floating panel goes beside a cell: below it, or above where there is no room. */
function placeBy(anchor: DOMRect, height: number, width: number): React.CSSProperties {
  const below = anchor.bottom + height + 8 < window.innerHeight || anchor.top < height + 8;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  return below ? { left, top: anchor.bottom + 4 } : { left, bottom: window.innerHeight - anchor.top + 4 };
}

const PAGE = 10;

/**
 * THE OPTION PICKER — a select menu in the app's own surface, not a list of
 * suggestions. It names what is being chosen and how many there are, marks
 * the current value, and shows ten at a time: past ten options it carries a
 * search box, and "Show more" brings the next ten. A name that is not on the
 * list is added from the same box. ↑ ↓ Enter work it; Esc or a click outside
 * closes it without changing anything.
 */
function OptionPicker({
  anchor,
  title,
  noun,
  options,
  value,
  initialQuery,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  title: string;
  noun: string;
  options: string[];
  value: string;
  initialQuery: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const searchable = options.length > PAGE;
  const [query, setQuery] = useState(initialQuery);
  const [adding, setAdding] = useState(!searchable && !!initialQuery);
  const [limit, setLimit] = useState(PAGE);
  const [hl, setHl] = useState(0);
  const q = query.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!q || (!searchable && !adding)) return options;
    const starts: string[] = [];
    const has: string[] = [];
    for (const v of options) {
      const l = v.toLowerCase();
      if (l.startsWith(q)) starts.push(v);
      else if (l.includes(q)) has.push(v);
    }
    return [...starts, ...has];
  }, [options, q, searchable, adding]);
  const shown = matched.slice(0, limit);
  const canAdd = !!q && !options.some((v) => v.toLowerCase() === q);
  /* The rows the keyboard walks: the shown options, then "Add". */
  const total = shown.length + (canAdd ? 1 : 0);
  const pick = (i: number) => (i < shown.length ? onPick(shown[i]) : canAdd ? onPick(query.trim()) : undefined);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHl((h) => Math.min(total - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (total) pick(Math.min(hl, total - 1));
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  }

  const showInput = searchable || adding;
  return (
    <BodyPortal>
      <div className="fixed inset-0 z-[94]" onMouseDown={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={`Choose ${title}`}
        tabIndex={-1}
        ref={(el) => {
          if (el && !showInput && document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
        }}
        onKeyDown={onKey}
        style={{ ...placeBy(anchor, 380, 300), width: Math.max(anchor.width, 300) }}
        className={cx("animate-fade-in fixed z-[95] flex max-h-[380px] flex-col overflow-hidden outline-none", popoverClass)}
      >
        <div className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
          <span className={eyebrowClass}>{title}</span>
          <span className="text-xs text-muted">
            {q && showInput ? `${matched.length} of ${options.length}` : `${options.length} ${noun}`}
          </span>
        </div>
        {showInput ? (
          <div className="relative border-b border-divider p-2">
            <ShellIcon name="search" size={15} className="pointer-events-none absolute top-[17px] left-4.5 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
                setHl(0);
              }}
              placeholder={searchable ? `Search ${noun}, or type a new one` : "Type a new name"}
              className={controlClass({ className: "h-8 pr-2 pl-7.5" })}
            />
          </div>
        ) : null}
        <div role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.map((v, i) => {
            const at = q && showInput ? v.toLowerCase().indexOf(q) : -1;
            const current = v === value;
            return (
              <div
                key={v}
                role="option"
                aria-selected={current}
                ref={(el) => {
                  if (el && i === hl) el.scrollIntoView({ block: "nearest" });
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(v);
                }}
                onMouseEnter={() => setHl(i)}
                title={v}
                className={cx("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", i === hl ? "bg-canvas text-ink" : "text-body")}
              >
                <span className="w-4 shrink-0 text-brand">{current ? <ShellIcon name="tick" size={14} /> : null}</span>
                <span className={cx("truncate", current && "font-medium text-ink")}>
                  {at >= 0 ? (
                    <>
                      {v.slice(0, at)}
                      <span className="font-semibold text-ink">{v.slice(at, at + q.length)}</span>
                      {v.slice(at + q.length)}
                    </>
                  ) : (
                    v
                  )}
                </span>
              </div>
            );
          })}
          {!shown.length && !canAdd ? <div className="px-3 py-3 text-sm text-muted">No {noun} match “{query.trim()}”.</div> : null}
          {canAdd ? (
            <div
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(query.trim());
              }}
              onMouseEnter={() => setHl(shown.length)}
              className={cx("flex cursor-pointer items-center gap-2 border-t border-divider px-3 py-2 text-sm text-brand-hover", hl === shown.length ? "bg-brand-soft" : "")}
            >
              <ShellIcon name="plus" size={14} className="w-4 shrink-0" />
              <span className="truncate">
                Add “<span className="font-medium">{query.trim()}</span>”
              </span>
            </div>
          ) : null}
        </div>
        {matched.length > limit || (!showInput && !adding) || value ? (
          <div className="flex items-center gap-2 border-t border-divider bg-canvas px-3 py-1.5">
            {matched.length > limit ? (
              <LinkButton onMouseDown={(e) => e.preventDefault()} onClick={() => setLimit((l) => l + PAGE)} className="text-meta">
                Show {Math.min(PAGE, matched.length - limit)} more · {matched.length - limit} left
              </LinkButton>
            ) : !showInput ? (
              <LinkButton onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-meta">
                <ShellIcon name="plus" size={13} /> Add new
              </LinkButton>
            ) : null}
            <span className="flex-1" />
            {value ? (
              <LinkButton tone="muted" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick("")} className="text-meta">
                Clear
              </LinkButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </BodyPortal>
  );
}

/**
 * THE PO NOTE — Excel's cell comment for a bought rate. Hovering a yellow
 * cell shows it; clicking pins it with its actions; the small corner mark on
 * the cell says a note is there.
 */
function PoNote({
  at,
  pinned,
  rowNo,
  date,
  party,
  column,
  rate,
  drums,
  poNo,
  by,
  when,
  readOnly,
  onClose,
  onEdit,
  onUndo,
}: {
  at: DOMRect;
  pinned: boolean;
  rowNo: number;
  date: string;
  party: string;
  column: string;
  rate: string;
  drums: number | null;
  poNo: string | null;
  by: string | null;
  when: string;
  readOnly: boolean;
  onClose: () => void;
  onEdit: () => void;
  onUndo: () => void;
}) {
  const W = 300;
  const right = at.right + W + 12 < window.innerWidth;
  const style: React.CSSProperties = right
    ? { left: at.right + 6, top: Math.min(at.top - 4, window.innerHeight - 280) }
    : { left: Math.max(8, at.left - W - 6), top: Math.min(at.top - 4, window.innerHeight - 280) };
  return (
    <BodyPortal>
      {pinned ? <div className="fixed inset-0 z-[94]" onMouseDown={onClose} aria-hidden /> : null}
      <div
        role="note"
        style={{ ...style, width: W }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className={cx(
          "animate-fade-in fixed z-[95] overflow-hidden rounded-card border border-warn-line bg-surface shadow-pop",
          !pinned && "pointer-events-none",
        )}
      >
        <div className="flex items-start justify-between gap-2 border-b border-warn-line bg-warn-soft px-3.5 py-2.5 shadow-[inset_3px_0_0_var(--color-warn)]">
          <div>
            <div className={eyebrowClass}>PO made in Tally &amp; mailed</div>
            <div className="mt-0.5 font-mono text-md font-semibold text-ink">{poNo || "—"}</div>
          </div>
          <span className="rounded-control bg-surface px-1.5 py-0.5 text-2xs font-medium text-body tabular-nums">Row {rowNo}</span>
        </div>
        <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-1.5 px-3.5 py-3 text-meta">
          <dt className="text-muted">Drums</dt>
          <dd className="font-semibold text-ink tabular-nums">{drums ?? "—"}</dd>
          <dt className="text-muted">Rate</dt>
          <dd className="text-ink tabular-nums">{rate || "—"}</dd>
          <dt className="text-muted">Material</dt>
          <dd className="text-ink">{column}</dd>
          <dt className="text-muted">Party</dt>
          <dd className="text-ink">{party || "—"}</dd>
          <dt className="text-muted">Quoted</dt>
          <dd className="text-ink">{date}</dd>
        </dl>
        <div className="border-t border-divider px-3.5 py-2 text-xs text-muted">
          {by ? `Bought by ${by}` : "Bought"}
          {when ? ` · ${when}` : ""}
        </div>
        {pinned && !readOnly ? (
          <div className="flex items-center justify-end gap-2 border-t border-divider bg-canvas px-3.5 py-2">
            <Button size="sm" variant="ghost" onClick={onUndo}>
              Undo purchase
            </Button>
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
          </div>
        ) : null}
      </div>
    </BodyPortal>
  );
}

type CellMenuItem = { label: string; onSelect: () => void; disabled?: boolean; hint?: string; divider?: boolean; strong?: boolean };

/** The right-click menu on a cell, in the row menu's surface. */
function CellMenu({ x, y, items, onClose }: { x: number; y: number; items: CellMenuItem[]; onClose: () => void }) {
  const W = 260;
  const H = items.length * 32 + 16;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(x, window.innerWidth - W - 8)),
    top: y + H + 8 < window.innerHeight ? y : Math.max(8, y - H),
    width: W,
  };
  return (
    <BodyPortal>
      <div
        className="fixed inset-0 z-[94]"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        aria-hidden
      />
      <div
        role="menu"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        style={style}
        className={cx("animate-fade-in fixed z-[95] flex flex-col overflow-hidden py-1 outline-none", popoverClass)}
      >
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className={cx(
              "flex items-center justify-between gap-3 px-3 py-1.5 text-left text-sm",
              it.divider && i > 0 && "mt-1 border-t border-divider pt-2",
              it.disabled ? "cursor-default text-line-strong" : it.strong ? "cursor-pointer font-medium text-brand-hover hover:bg-brand-soft" : "cursor-pointer text-body hover:bg-canvas",
            )}
          >
            <span className="truncate">{it.label}</span>
            {it.hint ? <span className="shrink-0 text-xs text-muted">{it.hint}</span> : null}
          </button>
        ))}
      </div>
    </BodyPortal>
  );
}

/**
 * Purchase it: the drums for one Ready to buy rate, and the purchase order it
 * makes — how much, the requirement it answers (or one raised with it), where
 * it is delivered and by when. The PO number is made by the server, never
 * typed. Editing a purchase already made changes only its drums.
 */
function PurchaseDialog({
  rowNo,
  date,
  party,
  column,
  rate,
  drums,
  poNo,
  editing,
  materialId,
  choices,
  today,
  onClose,
  onSave,
}: {
  rowNo: number;
  date: string;
  party: string;
  column: string;
  rate: string;
  drums: number | null;
  poNo: string;
  editing: boolean;
  materialId: string | null;
  choices: PurchaseChoices;
  today: string;
  onClose: () => void;
  onSave: (drums: number, order: QuoteOrder | null) => void;
}) {
  const reqs = useMemo(() => choices.openRequirements.filter((r) => r.materialId === materialId), [choices, materialId]);
  const first = reqs[0] ?? null;
  /* The party's open POs from here that do not already carry this material — newest first. A purchase
     defaults to the one made today, so several materials bought from one party in a sitting are one PO.
     Matched by the party's name, as the server finds the vendor; the server checks the vendor again. */
  const joinable = useMemo(() => {
    const who = party.trim().toLowerCase();
    return who ? choices.openPos.filter((p) => p.vendor.trim().toLowerCase() === who && !(materialId && p.materialIds.includes(materialId))) : [];
  }, [choices, party, materialId]);
  const [addTo, setAddTo] = useState(joinable.find((p) => p.date === today)?.poNo ?? "");
  const unit = (materialId && choices.units[materialId]) || "";
  const [d, setD] = useState(drums ? String(drums) : "");
  const [reqId, setReqId] = useState(first?.id ?? "");
  const [qty, setQty] = useState(first ? String(first.qty) : "");
  const [godown, setGodown] = useState(first?.godown ?? choices.defaultGodown ?? choices.godowns[0] ?? "");
  const [due, setDue] = useState(first?.requiredBy && first.requiredBy > today ? first.requiredBy : today);
  const [tried, setTried] = useState(false);
  const n = Number(d);
  const drumsBad = !d.trim() || !Number.isInteger(n) || n < 1;
  const q = Number(qty);
  const ordering = !editing;
  const noMaterial = ordering && !materialId;
  const qtyBad = ordering && (!qty.trim() || !Number.isFinite(q) || q <= 0);
  const godownBad = ordering && !godown;
  const dueBad = ordering && (!due || due < today);
  function pickReq(id: string) {
    setReqId(id);
    const r = reqs.find((x) => x.id === id);
    if (r) {
      setQty(String(r.qty));
      setGodown(r.godown);
      if (r.requiredBy && r.requiredBy > today) setDue(r.requiredBy);
    }
  }
  function save() {
    setTried(true);
    if (drumsBad || noMaterial || qtyBad || godownBad || dueBad) return;
    onSave(n, ordering ? { requisitionId: reqId || null, qty: q, godown, deliveryDate: due, addTo: addTo || null } : null);
  }
  return (
    <ErpDialog onClose={onClose} label={editing ? "Edit purchase" : "Purchase it"} width={540} tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{editing ? "Edit purchase" : "Purchase it"}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className={cx("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 bg-canvas text-meta", insetClass)}>
          <span className="text-muted">Material</span>
          <span className="font-medium text-ink">{column}</span>
          <span className="text-muted">Party</span>
          <span className="text-ink">{party || "—"}</span>
          <span className="text-muted">Quoted</span>
          <span className="text-ink">
            {date} · row {rowNo}
          </span>
          <span className="text-muted">Rate</span>
          <span className="font-semibold text-ink tabular-nums">{rate || "—"}</span>
        </div>
        {noMaterial ? (
          <Callout tone="warn" className="mb-0 text-sm">
            This column is not linked to a raw material, so no purchase order can be made for it. Edit the column (right-click its heading) and pick the raw material first.
          </Callout>
        ) : null}
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="Number of drums">
            <Input autoFocus inputMode="numeric" value={d} onChange={(e) => setD(cleanWhole(e.target.value))} invalid={tried && drumsBad} placeholder="e.g. 4" />
            {tried && drumsBad ? <span className="text-meta text-danger">Enter how many drums, a whole number.</span> : null}
          </Field>
          <Field label="PO number">
            {ordering && joinable.length ? (
              <Select value={addTo} onChange={(e) => setAddTo(e.target.value)} className="w-full">
                <option value="">New PO number</option>
                {joinable.map((p) => (
                  <option key={p.poNo} value={p.poNo}>
                    Add to {p.poNo}
                    {p.items.length ? ` · ${p.items.join(", ")}` : ""}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="flex h-8.5 items-center rounded-control border border-line bg-canvas px-2.5 font-mono text-sm text-ink">
                {poNo || <span className="font-sans text-muted">Made when you save</span>}
              </div>
            )}
          </Field>
          {ordering && !noMaterial ? (
            <>
              <div className="col-span-2">
                <Field label="For requirement">
                  <Select value={reqId} onChange={(e) => pickReq(e.target.value)} className="w-full">
                    {reqs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                    <option value="">None waiting — raise one with this purchase</option>
                  </Select>
                </Field>
              </div>
              <Field label={`Quantity${unit ? ` (${unit})` : ""}`}>
                <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} invalid={tried && qtyBad} placeholder="e.g. 800" />
                {tried && qtyBad ? <span className="text-meta text-danger">Enter the quantity bought.</span> : null}
              </Field>
              <Field label="Deliver to">
                <Select value={godown} onChange={(e) => setGodown(e.target.value)} className="w-full">
                  {choices.godowns.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </Select>
                {tried && godownBad ? <span className="text-meta text-danger">Pick the godown.</span> : null}
              </Field>
              <Field label="Delivery by">
                <Input type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} invalid={tried && dueBad} />
                {tried && dueBad ? <span className="text-meta text-danger">A delivery date, today or later.</span> : null}
              </Field>
            </>
          ) : null}
          <p className="col-span-2 text-meta text-muted">
            {editing
              ? "This purchase keeps its PO number and its purchase order; changing the drums changes the order's line too."
              : addTo
                ? `Saving adds this purchase to ${addTo} as another line and turns the cell yellow — one PO for the vendor, ready for goods to be received against it.`
                : "Saving gives this purchase the next PO number, turns the cell yellow and puts the purchase order in Purchase orders — sent, ready for goods to be received against it."}
          </p>
          <button type="submit" className="hidden" />
        </form>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={noMaterial}>
          {editing ? "Save purchase" : "Buy and make the PO"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
