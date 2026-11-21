"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { erpQuoteApply } from "@/lib/actions/erp-quotes";
import type { PurchaseChoices, QuoteOrder, QuoteSheet } from "@/lib/erp/quotes";
import { cleanCell, newQuoteId, parseQuoteDate, parseTsv, QUOTE_STATUS_LABEL, QUOTE_STATUS_SHORT, rateNumber, type QuoteStatus } from "@/lib/erp/engines/quotes";
import {
  applySheetOps,
  impactAsks,
  invertSheetOps,
  visibleColumns,
  visibleRows,
  type SheetColumn,
  type SheetOp,
  type SheetRow,
  type SheetState,
} from "@/lib/erp/engines/quote-sheet";
import { cheapestByColumn, latestByParty, selectionFigures, sortRows, waitingBadge, waitingByColumn, type RowSort } from "@/lib/erp/engines/quote-panel";
import { quoteOpTick, tickWhy, type Tick } from "@/lib/erp/action-ticks";
import { Button, Callout, controlClass, cx, Dot, EmptyState, Input, PageHeader, Select, Td, Th } from "@/components/ui/primitives";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { erpLink } from "@/lib/erp/registry";
import { stamp } from "@/lib/format";
import { RowMenu } from "@/components/ui/overlays";
import { useErpUi } from "../_ui/erp-ui";
import { ErpImpactDialog } from "../_ui/impact-confirm";
import type { ImpactConfirmation } from "@/lib/impact/types";
import { DialogBody, DialogHeader, DialogTitle, ErpDialog } from "../_ui/dialog";
import { fieldLabelClass } from "../_ui/look";
import { ContextMenu, MARK_DOT, MARK_EDGE, MenuChoice, OptionPicker, PoNote, Swatch, ToolButton, ToolIcon, ToolMenu, type MenuItem } from "./menus";
import { PurchaseDialog } from "./purchase-dialog";
import { ColumnDialog, type ColumnValues } from "./column-dialog";
import { SidePanel } from "./side-panel";
import { columnName, columnTitle, longDate, rateText, rupees, shortDate } from "./words";

/**
 * THE TABLE. It behaves like the desk's own spreadsheet: click a cell and
 * type, Enter or Tab to move on, arrows to walk, Shift to select a block,
 * Delete to clear it, Ctrl+C / Ctrl+V to copy and paste blocks from Excel,
 * Ctrl+Z to undo and Ctrl+Y to redo. Every change is shown at once and saved
 * behind it; a change the server refuses is taken back and said.
 *
 * Grid column 0 is the date, 1 the party, and 2 onwards the table's own
 * columns in their order. Beside it the side panel reads the selected rate;
 * under it the footer adds up the selection.
 */

type Pos = { r: number; c: number };
type Editing = {
  r: number;
  c: number;
  draft: string;
  token: number;
  picker: boolean;
};
type CellRef = { rowId: string; columnId: string };
type NoteAt = CellRef & { rect: DOMRect; pinned: boolean };
type Hist = "do" | "undo" | "redo";
type Freeze = "none" | "fixed" | { upto: string };
type Menu = { kind: "cell"; x: number; y: number } | { kind: "column"; x: number; y: number; columnId: string };

const FIXED = 2;
/* Widths, so a frozen column knows where it sits. The row number, the date and the party, then a rate or a text column. */
const W_RN = 48;
const W_DATE = 84;
const W_PARTY = 176;
const W_RATE = 112;
const W_TEXT = 150;
const W_ADD = 128;
const colWidth = (c: SheetColumn) => (c.kind === "text" ? W_TEXT : W_RATE);

const HEAD = "border-r border-r-white/10 align-bottom";
const FROZEN_EDGE = "shadow-[inset_-2px_0_0_var(--color-line-strong)]";

const SORT_LABEL: Record<RowSort, string> = {
  latest: "Latest first",
  oldest: "Oldest first",
  party: "Party A–Z",
  cheapest: "Cheapest first",
};

function toState(sheet: QuoteSheet): SheetState {
  return {
    columns: [...sheet.columns.map((c) => ({ ...c, archived: false })), ...sheet.archived.map((c) => ({ ...c, archived: true }))].map(
      ({ id, pack, name, brand, kind, rawMaterialId, archived }) => ({
        id,
        pack,
        name,
        brand,
        kind,
        rawMaterialId,
        archived,
      }),
    ),
    rows: sheet.rows.map((r) => ({
      id: r.id,
      date: r.date,
      party: r.party,
      status: r.status,
      seq: r.seq,
      deleted: false,
      cells: { ...r.cells },
    })),
  };
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function QuoteGrid({
  title,
  sheet,
  choices,
  today,
  filter,
  sixMonths,
  threeMonths,
  readOnly,
  canReady,
  ticks,
  me,
}: {
  title: string;
  sheet: QuoteSheet;
  /** What Purchase it offers: godowns, units, GST, and the requirements waiting for a PO. */
  choices: PurchaseChoices;
  today: string;
  filter: { from: string | null; to: string | null; q: string; all: boolean };
  sixMonths: string;
  threeMonths: string;
  readOnly: boolean;
  /** An ERP manager or administrator: may mark a rate Ready to buy. */
  canReady: boolean;
  /** Edit and Delete on the Quotation manager (Manage access): every change is Edit; a take-back is Delete. */
  ticks: { edit: boolean; delete: boolean };
  /** The signed-in person's name, shown on a purchase until the page reloads. */
  me: string;
}) {
  const router = useRouter();
  const ui = useErpUi();
  const canEdit = ticks.edit && !readOnly;
  const canDelete = ticks.delete && !readOnly;
  const [state, setState] = useState<SheetState>(() => toState(sheet));
  const stateRef = useRef(state);
  const [focus, setFocus] = useState<Pos>({ r: 0, c: FIXED });
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: FIXED });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState(false);
  const [undo, setUndo] = useState<SheetOp[][]>([]);
  const [redo, setRedo] = useState<SheetOp[][]>([]);
  const [colEdit, setColEdit] = useState<{
    id: string | null;
    at: number;
  } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<{ by: RowSort; columnId: string | null }>({
    by: "latest",
    columnId: null,
  });
  const [freeze, setFreeze] = useState<Freeze>("fixed");
  const [panelOpen, setPanelOpen] = useState(true);
  const dragging = useRef(false);
  /* Where an open option picker sits (the rectangle of its cell). */
  const [pickerAt, setPickerAt] = useState<DOMRect | null>(null);
  /* The cell a Purchase it dialog is open for (and the requirement it starts on), the PO note showing, and the right-click menu. */
  const [purchase, setPurchase] = useState<(CellRef & { reqId?: string | null }) | null>(null);
  const [note, setNote] = useState<NoteAt | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  /* A save that reaches past the table, held until the impact modal is answered: `op` is the change it confirms. */
  const [asking, setAsking] = useState<{
    kind: string;
    id: string;
    ops: SheetOp[];
    op: number;
    hist: Hist;
    label: string;
  } | null>(null);
  /* An edit is closed once: Enter, Tab and Escape all move focus off the input, and its blur must not save it a second time. */
  const closedToken = useRef(0);
  const nextToken = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const gridRef = useRef<HTMLDivElement>(null);
  const othersRef = useRef<HTMLDivElement>(null);

  const cols = useMemo(() => visibleColumns(state), [state]);
  const rows = useMemo(() => sortRows(visibleRows(state), sort.by, sort.columnId), [state, sort]);
  const archived = state.columns.filter((c) => c.archived);
  const width = FIXED + cols.length;
  const parties = useMemo(() => [...new Set([...sheet.parties, ...state.rows.map((r) => r.party)].filter(Boolean))].sort(), [sheet.parties, state.rows]);
  const cheapest = useMemo(
    () =>
      cheapestByColumn(
        rows,
        cols.filter((c) => c.kind === "rate").map((c) => c.id),
      ),
    [rows, cols],
  );
  const waiting = useMemo(() => waitingByColumn(cols, choices.openRequirements), [cols, choices.openRequirements]);

  /* Where each column sits when frozen, and which are. */
  const frozenThrough = freeze === "none" ? -1 : freeze === "fixed" ? 1 : Math.max(1, FIXED + cols.findIndex((c) => c.id === freeze.upto));
  const lefts = useMemo(() => {
    const out = [W_RN, W_RN + W_DATE];
    let x = W_RN + W_DATE + W_PARTY;
    for (const c of cols) {
      out.push(x);
      x += colWidth(c);
    }
    return out;
  }, [cols]);
  const tableWidth = W_RN + W_DATE + W_PARTY + cols.reduce((s, c) => s + colWidth(c), 0) + W_ADD;
  const frozen = (c: number) => c <= frozenThrough;
  const stickyStyle = (c: number): React.CSSProperties | undefined => (frozen(c) ? { position: "sticky", left: lefts[c] } : undefined);

  /* ---------------------------------------------------------- saving */

  function setBoth(next: SheetState) {
    stateRef.current = next;
    setState(next);
  }

  function record(hist: Hist, inverse: SheetOp[]) {
    if (hist === "undo") setRedo((r) => [...r.slice(-49), inverse]);
    else {
      setUndo((u) => [...u.slice(-49), inverse]);
      if (hist === "do") setRedo([]);
    }
  }

  function unrecord(hist: Hist, inverse: SheetOp[]) {
    if (hist === "undo") setRedo((r) => r.filter((x) => x !== inverse));
    else setUndo((u) => u.filter((x) => x !== inverse));
  }

  /** The tick a list of ops needs, the same way the server reads it: a take-back of a bought rate or a row that holds one is Delete. */
  function tickNeeded(ops: SheetOp[]): Tick | null {
    const asks = new Set(impactAsks(stateRef.current, ops).map((a) => a.op));
    let need: Tick | null = null;
    ops.forEach((o, i) => {
      const t = asks.has(i) ? "delete" : quoteOpTick(o);
      if (t === "delete") need = "delete";
      else if (!need) need = t;
    });
    return need;
  }

  /** Show `ops`, save them behind, and take them back if the server refuses. */
  function commit(ops: SheetOp[], opts: { hist?: Hist } = {}) {
    const hist = opts.hist ?? "do";
    if (!ops.length) return;
    if (readOnly) {
      ui.toast("You are previewing the ERP as somebody else, so nothing can be saved.", "error");
      return;
    }
    const need = tickNeeded(ops);
    if (need && !(need === "delete" ? ticks.delete : ticks.edit)) {
      ui.toast(tickWhy("quoteManager", need), "error");
      return;
    }
    /* Undoing a purchase, or deleting a row that holds one, reaches the ERP's
       purchase orders — whichever way it was asked for (the menu, a mark,
       Ctrl+Z) it waits for the impact modal, and is saved only once answered. */
    const asks = impactAsks(stateRef.current, ops);
    if (asks.length > 1) {
      ui.toast("Undo those purchases one at a time — each takes its purchase order line with it.", "error");
      return;
    }
    if (asks.length === 1) {
      const a = asks[0];
      setAsking({
        ...a,
        ops,
        hist,
        label: a.kind === "erp-quote-row" ? "Delete the row" : "Undo purchase",
      });
      return;
    }
    const before = stateRef.current;
    const inverse = invertSheetOps(before, ops);
    setBoth(applySheetOps(before, ops));
    record(hist, inverse);
    setSaving((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        const res = await erpQuoteApply(ops);
        if (!res.ok) {
          setBoth(applySheetOps(stateRef.current, inverse));
          unrecord(hist, inverse);
          ui.toast(res.error, "error");
          setFailed(true);
        } else {
          setFailed(false);
          /* A purchase's PO number is made by the server; show it once it is. */
          const made = res.data.minted ?? [];
          if (made.length) {
            setBoth(
              applySheetOps(
                stateRef.current,
                made.map((m) => ({
                  op: "cell" as const,
                  rowId: m.rowId,
                  columnId: m.columnId,
                  poNo: m.poNo,
                })),
              ),
            );
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
        unrecord(hist, inverse);
        ui.toast("That change could not be saved. Check the connection and try again.", "error");
        setFailed(true);
      } finally {
        setSaving((n) => n - 1);
      }
    });
  }

  /**
   * The held save, with the modal's confirmation on the change it confirms.
   * Not shown before the server answers, unlike every other save: the modal
   * waits for the answer, and a `conflict` there shows the new picture.
   */
  async function commitConfirmed(held: { ops: SheetOp[]; op: number; hist: Hist }, confirmation: ImpactConfirmation) {
    await queue.current;
    const ops = held.ops.map((o, i) => (i === held.op && (o.op === "cell" || o.op === "deleteRow") ? { ...o, impact: confirmation } : o));
    const inverse = invertSheetOps(stateRef.current, ops);
    let res: Awaited<ReturnType<typeof erpQuoteApply>>;
    try {
      res = await erpQuoteApply(ops);
    } catch {
      return {
        ok: false as const,
        error: "That change could not be saved. Check the connection and try again.",
      };
    }
    if (res.ok) {
      setBoth(applySheetOps(stateRef.current, ops));
      record(held.hist, inverse);
      setFailed(false);
      setNote(null);
      router.refresh();
    }
    return res;
  }

  function doUndo() {
    const last = undo[undo.length - 1];
    if (!last) return;
    setUndo((u) => u.slice(0, -1));
    commit(last, { hist: "undo" });
  }

  function doRedo() {
    const last = redo[redo.length - 1];
    if (!last) return;
    setRedo((r) => r.slice(0, -1));
    commit(last, { hist: "redo" });
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

  function jumpTo(rowId: string, columnId: string) {
    const r = rows.findIndex((x) => x.id === rowId);
    const ci = cols.findIndex((x) => x.id === columnId);
    if (r >= 0 && ci >= 0) move(r, ci + FIXED);
    gridRef.current?.focus();
  }

  /** The party and every text column are picked from a list; dates and rates are typed. */
  function isPickerCell(c: number): boolean {
    return c === 1 || (c >= FIXED && cols[c - FIXED]?.kind === "text");
  }

  function cellRect(r: number, c: number): DOMRect | null {
    return gridRef.current?.querySelector(`[data-cell="${r}:${c}"]`)?.getBoundingClientRect() ?? null;
  }

  function startEdit(r: number, c: number, initial?: string) {
    if (!rows[r]) return;
    if (!canEdit) {
      if (!readOnly) ui.toast(tickWhy("quoteManager", "edit"), "error");
      return;
    }
    const row = rows[r];
    const picker = isPickerCell(c);
    const base = c === 0 ? longDate(row.date) : cellText(row, c);
    nextToken.current += 1;
    setNote(null);
    if (picker) setPickerAt(cellRect(r, c));
    setEditing({
      r,
      c,
      draft: picker ? (initial ?? "") : (initial ?? base),
      token: nextToken.current,
      picker,
    });
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
    if (!canEdit) {
      if (!readOnly) ui.toast(tickWhy("quoteManager", "edit"), "error");
      return;
    }
    const id = newQuoteId("eqr");
    const ops: SheetOp[] = [
      {
        op: "row",
        rowId: id,
        create: true,
        date: after?.date ?? today,
        party: copyFrom?.party ?? "",
      },
    ];
    if (copyFrom)
      for (const col of cols) {
        const c = copyFrom.cells[col.id];
        if (c?.value) ops.push({ op: "cell", rowId: id, columnId: col.id, value: c.value });
      }
    commit(ops);
    /* The new row sorts in by date; find where it landed. */
    const next = sortRows(visibleRows(stateRef.current), sort.by, sort.columnId);
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
          (status === "ready" && (!canReady || col.kind !== "rate" || !cell?.value)) || (prev === "po" && !(canReady || status === "ready")) || (prev === "ready" && !canReady);
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

  /** Whether a cell may be bought from here, and the sentence where it may not — the same rule the server applies. */
  function buyable(at: ReturnType<typeof cellAt>): {
    allowed: boolean;
    why?: string;
  } {
    if (readOnly) return { allowed: false, why: "Preview — read only." };
    if (!ticks.edit) return { allowed: false, why: tickWhy("quoteManager", "edit") };
    if (!at || at.col.kind !== "rate") return { allowed: false, why: "Select a rate to buy it." };
    if (rateNumber(at.cell?.value ?? "") == null) return { allowed: false, why: "There is no rate in this cell." };
    const st = at.cell?.status ?? null;
    if (st === "ready" || st === "po" || canReady) return { allowed: true };
    return {
      allowed: false,
      why: "Only a rate a manager has marked Ready to buy can be bought.",
    };
  }

  function openPurchase(ref: CellRef | null, reqId?: string | null) {
    const at = cellAt(ref);
    const b = buyable(at);
    if (!at || !b.allowed) {
      ui.toast(b.why ?? "Select a rate to buy it.", "error");
      return;
    }
    setNote(null);
    setMenu(null);
    setPurchase({ ...ref!, reqId });
  }

  function savePurchase(ref: CellRef, drums: number, order: QuoteOrder | null) {
    commit([
      {
        op: "cell",
        ...ref,
        status: "po",
        drums,
        poBy: me,
        poAt: new Date().toISOString(),
        ...(order ? { order } : {}),
      },
    ]);
    setPurchase(null);
    gridRef.current?.focus();
  }

  function undoPurchase(ref: CellRef) {
    commit([
      {
        op: "cell",
        ...ref,
        status: "ready",
        drums: null,
        poNo: null,
        poBy: null,
        poAt: null,
      },
    ]);
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
      for (let c = sel.c0; c <= sel.c1; c++) cells.push(c === 0 ? longDate(row.date) : cellText(row, c));
      lines.push(cells.join("\t"));
    }
    void navigator.clipboard?.writeText(lines.join("\n")).then(
      () => ui.toast(`Copied ${lines.length} row${lines.length === 1 ? "" : "s"}.`),
      () => ui.toast("The browser would not let the table copy. Use your browser's Copy instead.", "error"),
    );
  }

  function paste(text: string) {
    if (!canEdit) {
      if (!readOnly) ui.toast(tickWhy("quoteManager", "edit"), "error");
      return;
    }
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
        row = {
          id: newQuoteId("eqr"),
          date: dateCell ?? lastDate,
          party: "",
          status: null,
          seq: 0,
          deleted: false,
          cells: {},
        };
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
    setFocus({
      r: focus.r + block.length - 1,
      c: Math.min(width - 1, focus.c + block[0].length - 1),
    });
  }

  /* ---------------------------------------------------------- columns */

  function moveColumn(id: string, by: number) {
    const ids = state.columns.map((c) => c.id);
    const vis = cols.map((c) => c.id);
    const i = vis.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= vis.length) return;
    [vis[i], vis[j]] = [vis[j], vis[i]];
    commit([
      {
        op: "order",
        columnIds: [...vis, ...ids.filter((x) => !vis.includes(x))],
      },
    ]);
  }

  function saveColumn(id: string | null, v: ColumnValues) {
    if (!v.name.trim() && !v.pack.trim()) {
      ui.toast("Give the column a name.", "error");
      return false;
    }
    const { at, ...fields } = v;
    const rest = state.columns.filter((c) => c.archived).map((c) => c.id);
    if (id) {
      const vis = cols.map((c) => c.id).filter((x) => x !== id);
      vis.splice(Math.max(0, Math.min(vis.length, at)), 0, id);
      const moved = vis.join() !== cols.map((c) => c.id).join();
      commit([{ op: "column", columnId: id, ...fields }, ...(moved ? [{ op: "order" as const, columnIds: [...vis, ...rest] }] : [])]);
    } else {
      const nid = newQuoteId("eqc");
      const vis = cols.map((c) => c.id);
      vis.splice(Math.max(0, Math.min(vis.length, at)), 0, nid);
      commit([
        { op: "column", columnId: nid, create: true, ...fields },
        { op: "order", columnIds: [...vis, ...rest] },
      ]);
    }
    return true;
  }

  function removeColumn(id: string) {
    ui.confirm("Remove this column? Its rates are kept, and Removed columns brings it back.", () => {
      commit([{ op: "archiveColumn", columnId: id }]);
      setColEdit(null);
      const c = Math.max(0, Math.min(focus.c, width - 2));
      setFocus({ r: focus.r, c });
      setAnchor({ r: focus.r, c });
    });
  }

  function selectColumn(c: number, extend = false) {
    if (extend) setFocus({ r: rows.length - 1, c });
    else {
      setAnchor({ r: 0, c });
      setFocus({ r: Math.max(0, rows.length - 1), c });
    }
    gridRef.current?.focus();
  }

  /* ---------------------------------------------------------- keyboard */

  function onKey(e: React.KeyboardEvent) {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && (k.toLowerCase() === "y" || (k.toLowerCase() === "z" && e.shiftKey))) {
      e.preventDefault();
      doRedo();
      return;
    }
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
        if (rect) setMenu({ kind: "cell", x: rect.left + 8, y: rect.bottom });
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
    const head = ["Date", "Party", ...cols.map((c) => columnTitle(c)), "Colours"];
    const lines = [head.map(csvCell).join(",")];
    for (const r of rows) {
      const marks = [
        r.status ? `Row: ${QUOTE_STATUS_SHORT[r.status]}` : "",
        ...cols.map((c) => (r.cells[c.id]?.status ? `${c.name || c.pack}: ${QUOTE_STATUS_SHORT[r.cells[c.id]!.status!]}` : "")),
      ].filter(Boolean);
      lines.push([longDate(r.date), r.party, ...cols.map((c) => r.cells[c.id]?.value ?? ""), marks.join("; ")].map(csvCell).join(","));
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `quotations-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------------------------------------------------- what is read */

  const editingCol = editing && editing.c >= FIXED ? cols[editing.c - FIXED] : null;
  const columnValues = useMemo(() => {
    if (!editingCol || editingCol.kind !== "text") return [];
    return [...new Set(state.rows.map((r) => r.cells[editingCol.id]?.value ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [editingCol, state.rows]);
  const pickerOptions = !editing?.picker ? [] : editing.c === 1 ? parties : columnValues;
  const pickerCol = editing?.picker && editing.c >= FIXED ? cols[editing.c - FIXED] : null;

  const preset = filter.all ? "all" : filter.from === sixMonths && !filter.to ? "6" : filter.from === threeMonths && !filter.to ? "3" : "custom";
  const filtered = !!filter.q || preset === "custom";

  /* The footer's figures: every rate in the selection. */
  const figures = (() => {
    const vals: string[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = Math.max(sel.c0, FIXED); c <= sel.c1; c++) {
        const col = cols[c - FIXED];
        if (col?.kind === "rate") vals.push(row.cells[col.id]?.value ?? "");
      }
    }
    return selectionFigures(vals);
  })();
  const selectedCells = (sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1);

  const focusRow = rows[focus.r] ?? null;
  const focusCol = focus.c >= FIXED ? (cols[focus.c - FIXED] ?? null) : null;
  const unitOf = (col: SheetColumn | null) => (col?.rawMaterialId ? (choices.units[col.rawMaterialId] ?? "") : "");
  const buyFocused = buyable(focusedCell);

  /** The editing bar: which material, party, date and rate the selected cell is — said in words, never a cell code. */
  function editingBar(): React.ReactNode {
    if (!focusRow) return <span className="text-muted">Select a cell to see what it is.</span>;
    const when = shortDate(focusRow.date, today);
    if (!focusCol)
      return (
        <>
          <b className="font-semibold text-ink">{focus.c === 0 ? "Date" : "Party"}</b>
          <span className="text-muted">
            {focusRow.party || "No party"} · {when}
          </span>
        </>
      );
    const v = focusRow.cells[focusCol.id]?.value ?? "";
    const unit = unitOf(focusCol);
    return (
      <>
        <b className="font-semibold text-ink">
          {columnName(focusCol)} · {focusRow.party || "No party"}
        </b>
        <span className="text-muted">
          {when}
          {focusCol.kind === "rate" && unit ? ` · per ${unit}` : ""}
        </span>
        <b className="font-semibold text-ink tabular-nums">{v ? focusCol.kind === "rate" ? rateText(v) : v : <span className="font-normal text-muted">empty</span>}</b>
      </>
    );
  }

  /* ---------------------------------------------------------- the menus */

  /* The right-click menus are DATA — each item names an act, and `runMenu` does it — so building them reads no ref. */
  function cellMenuGroups(): { title?: string; sub?: string; groups: MenuItem[][] } {
    const row = focusRow;
    if (!row) return { groups: [] };
    const st = focusCol ? focusedStatus : row.status;
    const view: MenuItem[] = [];
    const change: MenuItem[] = [];
    const back: MenuItem[] = [];
    if (focusCol && focusedCell) {
      if (st === "po") view.push({ id: "note", label: "View PO note" });
      if (focusCol.kind === "rate") view.push({ id: "compare", label: "Compare this material", hint: "→ panel" });
    }
    view.push({ id: "copy", label: "Copy", hint: "Ctrl+C" });
    if (canEdit) {
      if (focusCol && focusedCell && focusCol.kind === "rate" && buyFocused.allowed) change.push({ id: "buy", label: st === "po" ? "Edit purchase…" : "Purchase it…", strong: true });
      change.push({ id: "edit", label: focusCol ? (focusCol.kind === "rate" ? "Edit rate" : "Edit cell") : focus.c === 0 ? "Edit date" : "Edit party", hint: "F2" });
      if (focusCol && canReady && focusCol.kind === "rate") {
        if (st === "ready") change.push({ id: "unready", label: "Remove Ready to buy", swatch: "ready" });
        else if (st !== "po")
          change.push({ id: "ready", label: "Mark Ready to buy", swatch: "ready", disabled: !focusedCell?.cell?.value, title: focusedCell?.cell?.value ? undefined : "There is no rate in this cell." });
      }
      /* Cancelling a bought rate takes its PO line back — a take-back, so it needs Delete. */
      if (st !== "cancel" && (st !== "po" || canDelete)) change.push({ id: "cancel", label: "Mark PO / order cancelled", swatch: "cancel" });
      if (st !== "pickup") change.push({ id: "pickup", label: "Mark picked up by transporter", swatch: "pickup" });
      if (st && st !== "ready" && st !== "po") change.push({ id: "clear", label: "Clear mark" });
      change.push({ id: "addRow", label: "Add a row, same date" });
      change.push({ id: "dupRow", label: "Duplicate this row" });
    }
    if (canDelete) {
      if (focusCol && st === "po") back.push({ id: "undoBuy", label: "Undo purchase", danger: true });
      back.push({ id: "deleteRow", label: "Delete this row", danger: true });
    }
    const v = focusCol ? (row.cells[focusCol.id]?.value ?? "") : "";
    return {
      title: focusCol ? `${v ? (focusCol.kind === "rate" ? rateText(v) : v) + " · " : ""}${columnName(focusCol)}` : row.party || "No party",
      sub: [focusCol ? row.party || "No party" : null, shortDate(row.date, today), st ? QUOTE_STATUS_SHORT[st] : null].filter(Boolean).join(" · "),
      groups: [view, change, back],
    };
  }

  function columnMenuGroups(id: string): { title?: string; sub?: string; groups: MenuItem[][] } {
    const i = cols.findIndex((c) => c.id === id);
    const col = cols[i];
    if (!col) return { groups: [] };
    const isFrozen = frozenThrough >= FIXED + i;
    const view: MenuItem[] = [
      { id: "colSelect", label: "Select the column" },
      { id: "colFreeze", label: isFrozen ? "Unfreeze" : "Freeze up to here" },
    ];
    if (col.kind === "rate") view.push({ id: "colCheapest", label: "Cheapest first" });
    const change: MenuItem[] = canEdit
      ? [
          { id: "colEdit", label: "Edit material…", strong: true },
          { id: "colInsert", label: "Insert a material after…" },
          { id: "colLeft", label: "Move left", disabled: i === 0 },
          { id: "colRight", label: "Move right", disabled: i === cols.length - 1 },
        ]
      : [];
    const back: MenuItem[] = canDelete ? [{ id: "colRemove", label: "Remove column", danger: true }] : [];
    return { title: columnName(col), sub: [col.pack, col.brand].filter(Boolean).join(" · ") || undefined, groups: [view, change, back] };
  }

  /** Does what a menu item names. */
  function runMenu(id: string, m: Menu) {
    const row = focusRow;
    if (m.kind === "column") {
      const i = cols.findIndex((c) => c.id === m.columnId);
      if (i < 0) return;
      if (id === "colSelect") selectColumn(FIXED + i);
      else if (id === "colFreeze") setFreeze(frozenThrough >= FIXED + i ? "fixed" : { upto: m.columnId });
      else if (id === "colCheapest") setSort({ by: "cheapest", columnId: m.columnId });
      else if (id === "colEdit") setColEdit({ id: m.columnId, at: i });
      else if (id === "colInsert") setColEdit({ id: null, at: i + 1 });
      else if (id === "colLeft") moveColumn(m.columnId, -1);
      else if (id === "colRight") moveColumn(m.columnId, 1);
      else if (id === "colRemove") removeColumn(m.columnId);
      return;
    }
    switch (id) {
      case "note": {
        const el = gridRef.current?.querySelector(`[data-cell="${focus.r}:${focus.c}"]`);
        const ref = focusedRef();
        if (el instanceof HTMLElement && ref) showNote(ref, el, true);
        return;
      }
      case "compare":
        setPanelOpen(true);
        requestAnimationFrame(() => othersRef.current?.scrollIntoView({ block: "nearest" }));
        return;
      case "copy":
        return copySelection();
      case "buy":
        return openPurchase(focusedRef());
      case "edit":
        return startEdit(focus.r, focus.c);
      case "ready":
        return colour("ready");
      case "unready":
      case "clear":
        return colour(null);
      case "cancel":
        return colour("cancel");
      case "pickup":
        return colour("pickup");
      case "addRow":
        return row ? addRow(row) : undefined;
      case "dupRow":
        return row ? addRow(row, row) : undefined;
      case "undoBuy": {
        const ref = focusedRef();
        return ref ? undoPurchase(ref) : undefined;
      }
      case "deleteRow":
        /* Always through the modal: a deleted row is gone once the page closes. */
        if (row) setAsking({ kind: "erp-quote-row", id: row.id, ops: [{ op: "deleteRow", rowId: row.id }], op: 0, hist: "do", label: "Delete the row" });
        return;
    }
  }

  const ro = readOnly ? "Preview — read only." : !ticks.edit ? tickWhy("quoteManager", "edit") : undefined;

  /* ---------------------------------------------------------- drawing */

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <>
            <span className="mr-1 flex items-center gap-1.5 text-meta text-body" aria-live="polite">
              <Dot tone={failed ? "danger" : saving ? "brand" : readOnly ? "muted" : "success"} />
              {saving ? "Saving…" : failed ? "Last change not saved" : readOnly ? "Preview — read only" : "All changes saved"}
            </span>
            <Select
              value={preset}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "all") go({ from: "all", to: null });
                else if (v === "6") go({ from: sixMonths, to: null });
                else if (v === "3") go({ from: threeMonths, to: null });
              }}
              aria-label="Period"
              className="h-9"
            >
              <option value="3">Last 3 months</option>
              <option value="6">Last 6 months</option>
              <option value="all">All time</option>
              {preset === "custom" ? <option value="custom">Chosen dates</option> : null}
            </Select>
            <Button onClick={exportCsv}>Export CSV</Button>
            <Button variant="primary" disabled={!buyFocused.allowed} title={buyFocused.allowed ? undefined : buyFocused.why} onClick={() => openPurchase(focusedRef())}>
              {focusedStatus === "po" ? "Edit purchase" : "Purchase it"}
            </Button>
          </>
        }
      />

      {sheet.truncated ? (
        <Callout>
          <span className="text-sm text-warn-ink">Only the newest 3,000 rows of this period are shown. Narrow the dates to see older ones.</span>
        </Callout>
      ) : null}

      <div className={cx("grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3", panelOpen && "xl:grid-cols-[minmax(0,1fr)_300px]")}>
        <section aria-label="Quotation table" className="relative flex min-h-0 flex-col overflow-hidden rounded-t-card border border-b-0 border-line bg-surface">
          {saving ? <span aria-hidden className="absolute inset-x-0 top-0 z-40 h-0.5 animate-pulse bg-brand" /> : null}

          {/* The toolbar. */}
          <div className="flex h-11 flex-none items-center gap-0.5 border-b border-divider bg-canvas px-2.5">
            <ToolButton aria-label="Undo" title={ro ?? "Undo (Ctrl+Z)"} disabled={!undo.length || !canEdit} onClick={doUndo}>
              <ToolIcon name="undo" />
            </ToolButton>
            <ToolButton aria-label="Redo" title={ro ?? "Redo (Ctrl+Y)"} disabled={!redo.length || !canEdit} onClick={doRedo}>
              <ToolIcon name="redo" />
            </ToolButton>
            <span aria-hidden className="mx-1.5 h-5 w-px bg-line" />
            <ToolMenu
              label="Mark"
              disabled={!canEdit}
              title={ro ?? "Put a mark on the selected cells"}
              badge={
                <span className="flex gap-0.5">
                  {(["ready", "po", "cancel", "pickup"] as const).map((s) => (
                    <span key={s} aria-hidden className={cx("h-3 w-3 rounded-[3px]", MARK_DOT[s])} />
                  ))}
                </span>
              }
              width={300}
            >
              {(close) => (
                <div role="menu" aria-label="Mark">
                  {canReady ? (
                    <MenuChoice
                      onClick={() => {
                        close();
                        colour("ready");
                      }}
                    >
                      <Swatch status="ready" /> {QUOTE_STATUS_LABEL.ready}
                    </MenuChoice>
                  ) : null}
                  <MenuChoice
                    disabled={!buyFocused.allowed}
                    title={buyFocused.allowed ? undefined : buyFocused.why}
                    onClick={() => {
                      close();
                      openPurchase(focusedRef());
                    }}
                  >
                    <Swatch status="po" /> {focusedStatus === "po" ? "Edit purchase…" : "Purchase it…"}
                  </MenuChoice>
                  <MenuChoice
                    onClick={() => {
                      close();
                      colour("cancel");
                    }}
                  >
                    <Swatch status="cancel" /> {QUOTE_STATUS_LABEL.cancel}
                  </MenuChoice>
                  <MenuChoice
                    onClick={() => {
                      close();
                      colour("pickup");
                    }}
                  >
                    <Swatch status="pickup" /> {QUOTE_STATUS_LABEL.pickup}
                  </MenuChoice>
                  <div className="mt-1 border-t border-divider pt-1">
                    <MenuChoice
                      onClick={() => {
                        close();
                        colour(null);
                      }}
                    >
                      Clear mark
                    </MenuChoice>
                  </div>
                </div>
              )}
            </ToolMenu>
            <span aria-hidden className="mx-1.5 h-5 w-px bg-line" />
            <ToolMenu
              label="Filter"
              icon={<ToolIcon name="filter" />}
              badge={filtered ? <span className="rounded-full bg-brand px-1.5 text-2xs font-semibold text-white">{(filter.q ? 1 : 0) + (preset === "custom" ? 1 : 0)}</span> : null}
              width={320}
            >
              {(close) => (
                <FilterPanel
                  filter={filter}
                  sixMonths={sixMonths}
                  onApply={(f) => {
                    close();
                    go(f);
                  }}
                />
              )}
            </ToolMenu>
            <ToolMenu label={sort.by === "latest" ? "Sort" : SORT_LABEL[sort.by]} icon={<ToolIcon name="sort" />} width={280}>
              {(close) => (
                <div role="menu" aria-label="Sort">
                  {(["latest", "oldest", "party"] as const).map((k) => (
                    <MenuChoice
                      key={k}
                      on={sort.by === k}
                      onClick={() => {
                        close();
                        setSort({ by: k, columnId: null });
                      }}
                    >
                      {SORT_LABEL[k]}
                    </MenuChoice>
                  ))}
                  <MenuChoice
                    on={sort.by === "cheapest"}
                    disabled={focusCol?.kind !== "rate" && sort.by !== "cheapest"}
                    title={focusCol?.kind === "rate" || sort.by === "cheapest" ? undefined : "Select a cell in a rate column first."}
                    onClick={() => {
                      close();
                      setSort({
                        by: "cheapest",
                        columnId: focusCol?.kind === "rate" ? focusCol.id : sort.columnId,
                      });
                    }}
                  >
                    Cheapest first in{" "}
                    {columnName(
                      (focusCol?.kind === "rate" ? focusCol : cols.find((c) => c.id === sort.columnId)) ?? {
                        pack: "",
                        name: "a column",
                      },
                    )}
                  </MenuChoice>
                </div>
              )}
            </ToolMenu>
            <ToolMenu label="Freeze" icon={<ToolIcon name="freeze" />} width={280}>
              {(close) => (
                <div role="menu" aria-label="Freeze">
                  <MenuChoice
                    on={freeze === "none"}
                    onClick={() => {
                      close();
                      setFreeze("none");
                    }}
                  >
                    Nothing
                  </MenuChoice>
                  <MenuChoice
                    on={freeze === "fixed"}
                    onClick={() => {
                      close();
                      setFreeze("fixed");
                    }}
                  >
                    Date and party
                  </MenuChoice>
                  <MenuChoice
                    on={typeof freeze === "object"}
                    disabled={!focusCol && typeof freeze !== "object"}
                    title={focusCol || typeof freeze === "object" ? undefined : "Select a cell in a material column first."}
                    onClick={() => {
                      close();
                      setFreeze({
                        upto: focusCol?.id ?? (typeof freeze === "object" ? freeze.upto : ""),
                      });
                    }}
                  >
                    Up to {columnName(focusCol ?? cols.find((c) => typeof freeze === "object" && c.id === freeze.upto) ?? { pack: "", name: "the selected column" })}
                  </MenuChoice>
                </div>
              )}
            </ToolMenu>
            <span aria-hidden className="mx-1.5 h-5 w-px bg-line" />
            <ToolButton className="font-semibold text-brand-hover" disabled={!canEdit} title={ro ?? "Add a quotation dated today"} onClick={() => addRow()}>
              + Row
            </ToolButton>
            <ToolButton
              className="font-semibold text-brand-hover"
              disabled={!canEdit}
              title={ro ?? "Add a material to quote for"}
              onClick={() => setColEdit({ id: null, at: cols.length })}
            >
              + Material
            </ToolButton>
            <span className="flex-1" />
            <span className="mr-1 hidden truncate text-xs text-muted 2xl:inline">Ctrl+V pastes from Excel · right-click a cell for more</span>
            <ToolButton
              aria-label={panelOpen ? "Hide the side panel" : "Show the side panel"}
              title={panelOpen ? "Hide the side panel" : "Show the side panel"}
              pressed={panelOpen}
              onClick={() => setPanelOpen((o) => !o)}
              className="hidden xl:inline-flex"
            >
              <ToolIcon name="panel" />
            </ToolButton>
          </div>

          {/* The editing bar: what the selected cell is, in words. */}
          <div className="flex h-9 flex-none items-center border-b border-divider text-meta">
            <span className={cx("flex h-full w-24 flex-none items-center border-r border-divider px-3", fieldLabelClass)}>{editing ? "Typing" : "Editing"}</span>
            <span className="flex min-w-0 flex-1 items-center gap-3 truncate px-3">{editingBar()}</span>
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
            className="min-h-0 flex-1 overflow-auto outline-none"
          >
            <table className="w-full border-separate border-spacing-0 [--rowh:34px]" style={{ tableLayout: "fixed", minWidth: tableWidth }}>
              <colgroup>
                <col style={{ width: W_RN }} />
                <col style={{ width: W_DATE }} />
                <col style={{ width: W_PARTY }} />
                {cols.map((c) => (
                  <col key={c.id} style={{ width: colWidth(c) }} />
                ))}
                <col style={{ width: W_ADD }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <Th className={cx(HEAD, "left-0 z-30 px-0 tabular-nums")} title="Rows shown">
                    <span className="block text-center font-normal text-white/70">{rows.length}</span>
                  </Th>
                  <Th className={cx(HEAD, "z-30", frozenThrough === 0 && FROZEN_EDGE)} style={stickyStyle(0)}>
                    Date
                  </Th>
                  <Th className={cx(HEAD, "z-30", frozenThrough === 1 && FROZEN_EDGE)} style={stickyStyle(1)}>
                    Party
                  </Th>
                  {cols.map((c, i) => {
                    const ci = FIXED + i;
                    /* Tinted only while the whole column is selected — a single cell says itself in the editing bar. */
                    const colSelected = sel.c0 <= ci && ci <= sel.c1 && sel.r0 === 0 && sel.r1 >= rows.length - 1 && rows.length > 1;
                    const badge = waitingBadge(waiting.get(c.id) ?? []);
                    return (
                      <Th
                        key={c.id}
                        align={c.kind === "text" ? "left" : "right"}
                        onClick={(e) => selectColumn(ci, e.shiftKey)}
                        onDoubleClick={() => canEdit && setColEdit({ id: c.id, at: i })}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({
                            kind: "column",
                            x: e.clientX,
                            y: e.clientY,
                            columnId: c.id,
                          });
                        }}
                        style={stickyStyle(ci)}
                        className={cx(
                          HEAD,
                          "group cursor-pointer px-2.5 pt-2 pb-1.5 font-normal hover:bg-brand-deep",
                          frozen(ci) ? "z-30" : "z-20",
                          frozenThrough === ci && FROZEN_EDGE,
                        )}
                        title={`${columnTitle(c)}${c.rawMaterialId ? "" : "\nNot linked to a raw material"}\nClick to select the column · double-click to edit it · right-click for more`}
                      >
                        {/* A selected column is tinted over the cell, since `Th` carries its own ground.
                            The head is navy, so its words are white — and turn to ink only on that lavender tint. */}
                        {colSelected ? <span aria-hidden className="pointer-events-none absolute inset-0 bg-brand-soft" /> : null}
                        <div className={cx("relative min-h-4 text-2xs leading-4 font-medium tracking-label break-words whitespace-normal uppercase", colSelected ? "text-muted" : "text-white/70")}>
                          {c.pack}
                        </div>
                        <div
                          className={cx("relative text-meta leading-tight font-semibold tracking-normal whitespace-normal normal-case", colSelected ? "text-ink" : "text-white")}
                        >
                          {c.name || <span className={cx("font-normal", colSelected ? "text-muted" : "text-white/60")}>Untitled</span>}
                        </div>
                        <div className={cx("relative h-4 truncate text-2xs leading-4 tracking-normal normal-case", colSelected ? "text-muted" : "text-white/70")}>{c.brand}</div>
                        {badge ? (
                          <span className="relative mt-1 inline-block rounded-[4px] bg-warn-line px-1.5 text-2xs leading-4 font-semibold tracking-normal text-warn-ink normal-case">
                            {badge}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`More for ${columnName(c)}`}
                          title="Edit, move or remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            const r = e.currentTarget.getBoundingClientRect();
                            setMenu({
                              kind: "column",
                              x: r.left,
                              y: r.bottom + 2,
                              columnId: c.id,
                            });
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          className={cx(
                            "absolute top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] opacity-0 group-hover:opacity-100 focus:opacity-100",
                            c.kind === "text" ? "right-1" : "left-1",
                            colSelected ? "text-ink hover:bg-surface" : "text-white hover:bg-white/15",
                          )}
                        >
                          <ToolIcon name="more" size={14} />
                        </button>
                      </Th>
                    );
                  })}
                  <Th className="z-20 border-r-0 bg-canvas p-0 align-middle">
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => setColEdit({ id: null, at: cols.length })}
                        className="flex h-full min-h-14 w-full cursor-pointer items-center justify-center text-meta font-semibold tracking-normal text-brand-hover normal-case hover:bg-brand-soft"
                      >
                        + Add material
                      </button>
                    ) : null}
                  </Th>
                  <Th className="z-20 bg-canvas" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => {
                  const rowSelected = sel.r0 <= r && r <= sel.r1;
                  return (
                    <tr key={row.id} className="group/row">
                      <Td className={cx("sticky left-0 z-10 border-r border-b border-divider px-1", rowSelected ? "bg-brand-soft" : "bg-canvas")}>
                        <span className="flex items-center justify-between gap-0.5">
                          <button
                            type="button"
                            className={cx("min-w-[20px] cursor-pointer text-2xs tabular-nums", rowSelected ? "font-semibold text-brand-hover" : "text-muted hover:text-body")}
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
                          {canEdit ? (
                            <span className="opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
                              <RowMenu
                                items={[
                                  {
                                    label: "Add a row, same date",
                                    onSelect: () => addRow(row),
                                  },
                                  {
                                    label: "Duplicate this row",
                                    onSelect: () => addRow(row, row),
                                  },
                                  ...(canDelete
                                    ? [
                                        {
                                          label: "Delete this row",
                                          destructive: true,
                                          onSelect: () =>
                                            setAsking({
                                              kind: "erp-quote-row",
                                              id: row.id,
                                              ops: [
                                                {
                                                  op: "deleteRow",
                                                  rowId: row.id,
                                                },
                                              ],
                                              op: 0,
                                              hist: "do",
                                              label: "Delete the row",
                                            }),
                                        },
                                      ]
                                    : []),
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
                        const raw = cellText(row, c);
                        const rate = col?.kind === "rate";
                        const n = rate ? rateNumber(raw) : null;
                        const low = col ? cheapest.get(col.id) : undefined;
                        const lowest = low != null && n === low && st !== "cancel" && row.status !== "cancel";
                        const shown = c === 0 ? shortDate(row.date, today) : rate ? rateText(raw) : raw;
                        return (
                          <Td
                            key={c}
                            align={rate ? "right" : "left"}
                            data-cell={`${r}:${c}`}
                            style={stickyStyle(c)}
                            onMouseDown={(e) => {
                              if (isEdit || e.button !== 0) return;
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
                              setMenu({
                                kind: "cell",
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                            onDoubleClick={() => startEdit(r, c)}
                            className={cx(
                              "relative border-r border-b border-divider",
                              frozen(c) ? "z-10 bg-canvas" : "bg-surface",
                              frozenThrough === c && FROZEN_EDGE,
                              c === 0 && "text-meta text-muted",
                              c === 1 && "font-semibold whitespace-normal text-ink",
                              c >= FIXED && "text-body",
                              rate && "tabular-nums",
                              st && MARK_EDGE[st],
                              !raw && rate && "text-line-strong",
                              lowest && "font-bold text-success",
                            )}
                            title={st === "po" ? undefined : st ? QUOTE_STATUS_LABEL[st] : lowest ? "Cheapest in this column for the rows shown" : undefined}
                          >
                            {inSel(r, c) && !isFocus ? <span className="pointer-events-none absolute inset-0 bg-brand/8" /> : null}
                            {isFocus ? <span className="pointer-events-none absolute inset-0 z-[1] outline-2 -outline-offset-2 outline-brand" /> : null}
                            {st === "po" ? (
                              <span aria-hidden className="pointer-events-none absolute top-0 right-0 z-[1] border-t-[7px] border-l-[7px] border-t-warn border-l-transparent" />
                            ) : null}
                            {isEdit && editing.picker ? (
                              <span className="flex items-center justify-between gap-2">
                                <span className="truncate">{raw || <span className="text-muted">Choose…</span>}</span>
                                <ShellIcon name="chevron" size={14} className="shrink-0 rotate-90 text-brand" />
                              </span>
                            ) : isEdit ? (
                              <input
                                autoFocus
                                value={editing.draft}
                                autoComplete="off"
                                inputMode={rate ? "decimal" : undefined}
                                aria-label={col ? `${columnName(col)}, ${row.party}` : c === 0 ? "Date" : "Party"}
                                onChange={(e) =>
                                  setEditing({
                                    ...editing,
                                    draft: e.target.value,
                                  })
                                }
                                onKeyDown={onEditKey}
                                onBlur={() => finishEdit()}
                                className={cx(
                                  "absolute inset-0 z-[2] w-full rounded-[2px] border-2 border-brand bg-surface px-[10px] text-sm text-ink outline-none",
                                  rate && "text-right tabular-nums",
                                )}
                              />
                            ) : shown ? (
                              shown
                            ) : rate ? (
                              "—"
                            ) : null}
                          </Td>
                        );
                      })}
                      <Td className="border-r border-b border-divider bg-surface" />
                      <Td className="border-b border-divider bg-surface" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length ? (
              <EmptyState
                title={filtered || !filter.all ? "No quotations in this period" : "No quotations yet"}
                body="Add a row for each quotation, or select a cell and paste a block straight from Excel."
                action={
                  canEdit ? (
                    <Button variant="primary" onClick={() => addRow()}>
                      Add row
                    </Button>
                  ) : undefined
                }
              />
            ) : null}
          </div>

          {/* The footer: what the table holds, and the figures of the selection. */}
          <div className="flex h-10 flex-none items-center gap-3 border-t border-line bg-canvas px-3 text-meta text-body">
            <span className="text-muted tabular-nums">
              {rows.length} row{rows.length === 1 ? "" : "s"} · {cols.length} column{cols.length === 1 ? "" : "s"}
            </span>
            {archived.length ? (
              <ToolButton onClick={() => setShowArchived(true)} className="text-muted">
                Removed columns · {archived.length}
              </ToolButton>
            ) : null}
            <span className="flex-1" />
            {figures.count ? (
              <span className="rounded-control border border-line bg-surface px-2.5 py-1 tabular-nums">
                Selected {figures.count}
                {figures.count > 1 ? ` · Min ${rupees(figures.min)} · Avg ${rupees(figures.avg)}` : ` · ${rupees(figures.min)}`}
              </span>
            ) : selectedCells > 1 ? (
              <span className="text-muted">{selectedCells} cells selected</span>
            ) : null}
          </div>
        </section>

        {panelOpen ? (
          <SidePanel
            rows={rows}
            focus={
              focusedCell
                ? {
                    row: focusedCell.row,
                    col: focusedCell.col,
                    cell: focusedCell.cell,
                  }
                : null
            }
            waiting={focusedCell ? (waiting.get(focusedCell.col.id) ?? []) : []}
            unit={unitOf(focusCol)}
            today={today}
            buy={buyFocused}
            othersRef={othersRef}
            onJump={jumpTo}
            onPurchase={(reqId) => openPurchase(focusedRef(), reqId)}
          />
        ) : null}
      </div>

      {asking ? (
        <ErpImpactDialog
          kind={asking.kind}
          id={asking.id}
          confirmLabel={asking.label}
          doneMessage={asking.kind === "erp-quote-row" ? "Row deleted · Ctrl+Z brings it back" : "Purchase undone"}
          onClose={() => {
            setAsking(null);
            gridRef.current?.focus();
          }}
          act={(confirmation) => commitConfirmed(asking, confirmation)}
        />
      ) : null}

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
                date={longDate(at.row.date)}
                party={at.row.party}
                column={columnTitle(at.col)}
                rate={rateText(at.cell.value)}
                drums={at.cell.drums}
                poNo={at.cell.poNo}
                by={at.cell.poBy}
                when={at.cell.poAt ? stamp(at.cell.poAt) : ""}
                canEdit={canEdit}
                canUndo={canDelete}
                onClose={() => setNote(null)}
                onEdit={() => openPurchase(note)}
                onUndo={() => undoPurchase(note)}
              />
            );
          })()
        : null}

      {menu
        ? (() => {
            const m = menu.kind === "cell" ? cellMenuGroups() : columnMenuGroups(menu.columnId);
            return (
              <ContextMenu
                x={menu.x}
                y={menu.y}
                title={m.title}
                sub={m.sub}
                groups={m.groups}
                onPick={(id) => runMenu(id, menu)}
                onClose={() => {
                  setMenu(null);
                  gridRef.current?.focus();
                }}
              />
            );
          })()
        : null}

      {purchase
        ? (() => {
            const at = cellAt(purchase);
            if (!at) return null;
            const parties = latestByParty(rows, at.col.id);
            const n = rateNumber(at.cell?.value ?? "");
            return (
              <PurchaseDialog
                key={`${purchase.rowId}:${purchase.columnId}`}
                material={columnName(at.col)}
                party={at.row.party}
                date={shortDate(at.row.date, today)}
                pack={at.col.pack}
                rate={at.cell?.value ?? ""}
                status={at.cell?.status ?? null}
                cheapest={n != null && parties.length ? { is: n <= parties[0].rate, of: parties.length } : null}
                drums={at.cell?.drums ?? null}
                poNo={at.cell?.poNo ?? ""}
                editing={at.cell?.status === "po"}
                materialId={at.col.rawMaterialId}
                choices={choices}
                initialReq={purchase.reqId}
                today={today}
                onClose={() => setPurchase(null)}
                onSave={(d, order) => savePurchase(purchase, d, order)}
              />
            );
          })()
        : null}

      {colEdit ? (
        <ColumnDialog
          key={`${colEdit.id ?? "new"}-${colEdit.at}`}
          column={colEdit.id ? (state.columns.find((c) => c.id === colEdit.id) ?? null) : null}
          at={colEdit.at}
          columns={cols}
          materials={sheet.materials}
          onClose={() => setColEdit(null)}
          onSave={(v) => saveColumn(colEdit.id, v) && setColEdit(null)}
          onRemove={colEdit.id && canDelete ? () => removeColumn(colEdit.id!) : undefined}
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
                    {canEdit ? (
                      <Button size="sm" onClick={() => commit([{ op: "restoreColumn", columnId: c.id }])}>
                        Bring back
                      </Button>
                    ) : null}
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

/** The Filter drop-down: the party search and the dates, applied together. */
function FilterPanel({
  filter,
  sixMonths,
  onApply,
}: {
  filter: { from: string | null; to: string | null; q: string; all: boolean };
  sixMonths: string;
  onApply: (f: { from?: string | null; to?: string | null; q?: string }) => void;
}) {
  const [q, setQ] = useState(filter.q);
  const [from, setFrom] = useState(filter.all ? "" : (filter.from ?? ""));
  const [to, setTo] = useState(filter.to ?? "");
  return (
    <form
      className="grid gap-3 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({
          q: q.trim(),
          from: from || (filter.all ? "all" : filter.from),
          to: to || null,
        });
      }}
    >
      <label className="grid min-w-0 gap-1">
        <span className={fieldLabelClass}>Party</span>
        <span className="relative block">
          <ShellIcon name="search" size={15} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search party" aria-label="Search party" className="pl-7.5" />
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid min-w-0 gap-1">
          <span className={fieldLabelClass}>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={controlClass({ className: "h-8.5 min-w-0 px-2" })} />
        </label>
        <label className="grid min-w-0 gap-1">
          <span className={fieldLabelClass}>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={controlClass({ className: "h-8.5 min-w-0 px-2" })} />
        </label>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={() => onApply({ q: "", from: sixMonths, to: null })}>
          Clear
        </Button>
        <Button size="sm" variant="primary" type="submit">
          Apply
        </Button>
      </div>
    </form>
  );
}
