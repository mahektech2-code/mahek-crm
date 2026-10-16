"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { erpQuoteApply } from "@/lib/actions/erp-quotes";
import type { QuoteSheet } from "@/lib/erp/quotes";
import {
  cleanCell,
  columnStats,
  newQuoteId,
  parseQuoteDate,
  parseTsv,
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_SHORT,
  QUOTE_STATUSES,
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
import { Button, Callout, Card, cx, Dot, EmptyState, Input, PageHeader, Select } from "@/components/ui/primitives";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { Modal } from "@/components/ui/modal";
import { BodyPortal } from "@/components/ui/body-portal";
import { RowMenu } from "@/components/ui/overlays";
import { useErpUi } from "../_ui/erp-ui";

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
type Editing = { r: number; c: number; draft: string; token: number };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function showDate(d: string): string {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${Number(day)}-${MON[Number(m) - 1]}-${y}` : d;
}

/* The sheet's three marks in the design system's tones: the soft tint of the
   tone with its edge, the same pairing a list row uses for its status. */
const STATUS_CELL: Record<QuoteStatus, string> = {
  po: "bg-warn-soft text-ink shadow-[inset_3px_0_0_var(--color-warn)]",
  cancel: "bg-danger-soft text-danger line-through decoration-danger/50 shadow-[inset_3px_0_0_var(--color-danger)]",
  pickup: "bg-info-soft text-ink shadow-[inset_3px_0_0_var(--color-info)]",
};

const STATUS_SWATCH: Record<QuoteStatus, string> = {
  po: "bg-warn-soft shadow-[inset_0_0_0_1.5px_var(--color-warn)]",
  cancel: "bg-danger-soft shadow-[inset_0_0_0_1.5px_var(--color-danger)]",
  pickup: "bg-info-soft shadow-[inset_0_0_0_1.5px_var(--color-info)]",
};

/* The list screens' header cell, and the toolbar's control. */
const HEAD = "sticky top-0 border-r border-b border-divider border-b-line bg-canvas px-3 py-2 align-bottom text-xs font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase";
const FOOT = "sticky h-9 bg-canvas px-3";
const FROZEN_EDGE = "shadow-[inset_-1px_0_0_var(--color-line)]";
const TOOL = "h-8 rounded-control border border-line bg-surface px-2.5 text-meta text-body outline-none focus:border-brand";

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
  today,
  filter,
  sixMonths,
  threeMonths,
  readOnly,
}: {
  title: string;
  sub: string;
  sheet: QuoteSheet;
  today: string;
  filter: { from: string | null; to: string | null; q: string; all: boolean };
  sixMonths: string;
  threeMonths: string;
  readOnly: boolean;
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
  /* The open suggestion list: where its cell is on screen, and the highlighted row (-1: none). */
  const [suggestAt, setSuggestAt] = useState<DOMRect | null>(null);
  const [hl, setHl] = useState(-1);
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
        } else setFailed(false);
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

  function startEdit(r: number, c: number, initial?: string) {
    if (readOnly || !rows[r]) return;
    const row = rows[r];
    const base = c === 0 ? showDate(row.date) : cellText(row, c);
    nextToken.current += 1;
    setEditing({ r, c, draft: initial ?? base, token: nextToken.current });
  }

  /** Editing the party of a row just added, before the rows above have re-rendered. */
  function startEditAt(r: number, draft: string) {
    nextToken.current += 1;
    setEditing({ r, c: 1, draft, token: nextToken.current });
  }

  function finishEdit(then?: Pos, picked?: string) {
    if (!editing || closedToken.current === editing.token) return;
    closedToken.current = editing.token;
    const row = rows[editing.r];
    setEditing(null);
    setSuggestAt(null);
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
      setTimeout(() => startEditAt(at, copyFrom?.party ?? ""), 0);
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

  function colour(status: QuoteStatus | null) {
    const ops: SheetOp[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const row = rows[r];
      if (!row) continue;
      if (sel.c0 < FIXED && row.status !== status) ops.push({ op: "row", rowId: row.id, status });
      for (let c = Math.max(sel.c0, FIXED); c <= sel.c1; c++) {
        const col = cols[c - FIXED];
        if (col && (row.cells[col.id]?.status ?? null) !== status) ops.push({ op: "cell", rowId: row.id, columnId: col.id, status });
      }
    }
    commit(ops);
    gridRef.current?.focus();
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
    const picked = hl >= 0 ? suggestions[hl] : undefined;
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setHl((h) => Math.min(suggestions.length - 1, h + 1));
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setHl((h) => Math.max(-1, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      finishEdit({ r: editing.r + (e.shiftKey ? -1 : 1), c: editing.c }, picked);
    } else if (e.key === "Tab") {
      e.preventDefault();
      finishEdit({ r: editing.r, c: editing.c + (e.shiftKey ? -1 : 1) }, picked);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (hl >= 0) {
        setHl(-1);
        return;
      }
      closedToken.current = editing.token;
      setEditing(null);
      setSuggestAt(null);
      gridRef.current?.focus();
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
    router.push(`/erp/quotation-manager${p.size ? `?${p}` : ""}`);
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
    const like = rows.map((r) => ({ id: r.id, date: r.date, status: r.status, cells: r.cells }));
    return new Map(cols.filter((c) => c.kind === "rate").map((c) => [c.id, columnStats(like, c.id)]));
  }, [rows, cols]);

  const focusRow = rows[focus.r];
  const editingCol = editing && editing.c >= FIXED ? cols[editing.c - FIXED] : null;
  const columnValues = useMemo(() => {
    if (!editingCol || editingCol.kind !== "text") return [];
    return [...new Set(state.rows.map((r) => r.cells[editingCol.id]?.value ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [editingCol, state.rows]);
  const suggestions = !editing ? [] : suggestFor(editing.c === 1 ? parties : editingCol?.kind === "text" ? columnValues : [], editing.draft);

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
        {saving ? <span aria-hidden className="absolute inset-x-0 top-0 z-40 h-0.5 animate-pulse rounded-t-[6px] bg-brand" /> : null}

        {/* Toolbar — the list screens' own: search, period, then what the sheet can do. */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3">
          <form
            className="relative w-[260px] max-w-full"
            onSubmit={(e) => {
              e.preventDefault();
              go({ q: search.trim() });
            }}
          >
            <ShellIcon name="search" size={16} className="pointer-events-none absolute top-2 left-2.5 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search party"
              aria-label="Search party"
              className="h-8 w-full rounded-control border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
            />
            {search ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  if (filter.q) go({ q: "" });
                }}
                aria-label="Clear search"
                className="absolute top-1.5 right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center text-muted hover:text-body"
              >
                <ShellIcon name="close" size={14} />
              </button>
            ) : null}
          </form>
          <select
            value={preset}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "all") go({ from: "all", to: null });
              else if (v === "6") go({ from: sixMonths, to: null });
              else if (v === "3") go({ from: threeMonths, to: null });
            }}
            aria-label="Period"
            className={TOOL}
          >
            <option value="3">Last 3 months</option>
            <option value="6">Last 6 months</option>
            <option value="all">Every date</option>
            {preset === "custom" ? <option value="custom">Chosen dates</option> : null}
          </select>
          <span className="inline-flex items-center gap-1.5">
            <input type="date" value={filter.all ? "" : (filter.from ?? "")} onChange={(e) => e.target.value && go({ from: e.target.value })} aria-label="From" className={cx(TOOL, "w-[136px]")} />
            <span className="text-meta text-muted">to</span>
            <input type="date" value={filter.to ?? ""} onChange={(e) => go({ to: e.target.value || null })} aria-label="To" className={cx(TOOL, "w-[136px]")} />
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5 text-meta text-muted" aria-live="polite">
            <Dot tone={failed ? "danger" : saving ? "brand" : readOnly ? "muted" : "success"} />
            {saving ? "Saving…" : failed ? "Last change not saved" : readOnly ? "Preview — read only" : "All changes saved"}
          </span>
          <button type="button" onClick={doUndo} disabled={!undo.length || readOnly} title="Undo (Ctrl+Z)" className={cx(TOOL, "cursor-pointer hover:bg-canvas disabled:cursor-default disabled:text-line-strong disabled:hover:bg-surface")}>
            Undo
          </button>
          {archived.length ? (
            <button type="button" onClick={() => setShowArchived(true)} className={cx(TOOL, "cursor-pointer hover:bg-canvas")}>
              Removed columns · {archived.length}
            </button>
          ) : null}
        </div>

        {/* Marking — the sheet's legend, and the way a mark is put on. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-canvas px-4 py-2">
          <span className="mr-1 text-2xs font-medium tracking-[0.04em] text-muted uppercase">Mark selected</span>
          {QUOTE_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={readOnly}
              onClick={() => colour(s)}
              title={QUOTE_STATUS_LABEL[s]}
              className="inline-flex h-7 cursor-pointer items-center gap-2 rounded-control border border-line bg-surface px-2.5 text-meta text-body hover:border-line-strong disabled:cursor-default"
            >
              <span aria-hidden className={cx("h-3 w-3 rounded-[3px]", STATUS_SWATCH[s])} />
              {QUOTE_STATUS_LABEL[s]}
            </button>
          ))}
          <button
            type="button"
            disabled={readOnly}
            onClick={() => colour(null)}
            className="inline-flex h-7 cursor-pointer items-center rounded-control px-2 text-meta text-muted hover:text-body disabled:cursor-default"
          >
            Clear mark
          </button>
          <span className="ml-auto text-xs text-muted">Type to edit · Enter or Tab to move · Shift to select · Ctrl+V pastes from Excel · Ctrl+Z undoes</span>
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
            if (!editing) return;
            const el = document.activeElement;
            if (el instanceof HTMLInputElement && gridRef.current?.contains(el)) setSuggestAt(el.getBoundingClientRect());
          }}
          onMouseUp={() => (dragging.current = false)}
          onMouseLeave={() => (dragging.current = false)}
          className="max-h-[calc(100vh-300px)] overflow-auto rounded-b-[6px] outline-none"
        >
          <table className="border-separate border-spacing-0" style={{ minWidth: "100%" }}>
            <thead>
              <tr>
                <th className={cx(HEAD, "left-0 z-30 w-[52px] min-w-[52px] text-center tabular-nums")} title="Rows shown">
                  {rows.length}
                </th>
                <th className={cx(HEAD, "left-[52px] z-30 w-[124px] min-w-[124px] text-left")}>Date</th>
                <th className={cx(HEAD, FROZEN_EDGE, "left-[176px] z-30 w-[220px] min-w-[220px] text-left")}>Party</th>
                {cols.map((c, i) => {
                  const colSelected = sel.c0 <= FIXED + i && FIXED + i <= sel.c1;
                  return (
                    <th
                      key={c.id}
                      onClick={(e) => {
                        if (e.shiftKey) setFocus({ r: rows.length - 1, c: FIXED + i });
                        else {
                          setAnchor({ r: 0, c: FIXED + i });
                          setFocus({ r: Math.max(0, rows.length - 1), c: FIXED + i });
                        }
                        gridRef.current?.focus();
                      }}
                      onDoubleClick={() => !readOnly && setColEdit({ id: c.id, at: i })}
                      className={cx(
                        "group sticky top-0 z-20 cursor-pointer border-r border-b border-divider border-b-line px-3 pt-2 pb-1.5 align-bottom font-normal",
                        colSelected ? "bg-brand-soft" : "bg-canvas hover:bg-divider",
                        c.kind === "text" ? "min-w-[160px] text-left" : "min-w-[128px] text-right",
                      )}
                      title={`${[c.pack, c.name, c.brand].filter(Boolean).join(" · ")}\nClick to select the column · double-click to edit it`}
                    >
                      <div className="h-4 truncate text-2xs leading-4 font-medium tracking-[0.04em] text-muted uppercase">{c.pack}</div>
                      <div className="text-meta leading-tight font-semibold whitespace-normal text-ink">{c.name || <span className="font-normal text-muted">Untitled</span>}</div>
                      <div className="h-4 truncate text-2xs leading-4 text-muted">{c.brand}</div>
                      {!readOnly ? (
                        <span className={cx("mt-1 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100", c.kind === "text" ? "justify-start" : "justify-end")}>
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
                    </th>
                  );
                })}
                <th className="sticky top-0 z-20 w-full border-b border-line bg-canvas" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => {
                const rowSelected = sel.r0 <= r && r <= sel.r1;
                return (
                  <tr key={row.id} className="group/row">
                    <td className={cx("sticky left-0 z-10 border-r border-b border-divider px-1 text-center", rowSelected ? "bg-brand-soft" : "bg-canvas")}>
                      <span className="flex items-center justify-between gap-0.5">
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
                                { label: "Add a row below, same date", onSelect: () => addRow(row) },
                                { label: "Duplicate this row", onSelect: () => addRow(row, row) },
                                { label: "Delete this row", destructive: true, onSelect: () => commit([{ op: "deleteRow", rowId: row.id }]) },
                              ]}
                            />
                          </span>
                        ) : null}
                      </span>
                    </td>
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
                        <td
                          key={c}
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
                          onMouseEnter={() => dragging.current && setFocus({ r, c })}
                          onDoubleClick={() => startEdit(r, c)}
                          className={cx(
                            "relative h-9 border-r border-b border-divider px-3 text-sm whitespace-nowrap",
                            c === 0 && "sticky left-[52px] z-10 text-body",
                            c === 1 && cx("sticky left-[176px] z-10 max-w-[220px] truncate font-medium text-ink", FROZEN_EDGE),
                            c >= FIXED && "text-body",
                            rate ? "text-right tabular-nums" : "text-left",
                            st ? STATUS_CELL[st] : "bg-surface",
                            lowest && "font-semibold text-success",
                          )}
                          title={st ? QUOTE_STATUS_LABEL[st] : lowest ? "Lowest rate in this column for the rows shown" : c === 1 && val ? val : undefined}
                        >
                          {inSel(r, c) && !isFocus ? <span className="pointer-events-none absolute inset-0 bg-brand/8" /> : null}
                          {isFocus ? <span className="pointer-events-none absolute inset-0 z-[1] outline-2 -outline-offset-2 outline-brand" /> : null}
                          {isEdit ? (
                            <input
                              autoFocus
                              value={editing.draft}
                              autoComplete="off"
                              role={c === 1 || col?.kind === "text" ? "combobox" : undefined}
                              aria-expanded={c === 1 || col?.kind === "text" ? suggestions.length > 0 : undefined}
                              aria-controls={c === 1 || col?.kind === "text" ? "quote-suggest" : undefined}
                              onFocus={(e) => setSuggestAt(e.currentTarget.getBoundingClientRect())}
                              inputMode={rate ? "decimal" : undefined}
                              onChange={(e) => {
                                setEditing({ ...editing, draft: e.target.value });
                                setHl(-1);
                              }}
                              onKeyDown={onEditKey}
                              onBlur={() => finishEdit()}
                              className={cx("absolute inset-0 z-[2] w-full rounded-[2px] border-2 border-brand bg-surface px-[10px] text-sm text-ink outline-none", rate && "text-right tabular-nums")}
                            />
                          ) : (
                            val
                          )}
                        </td>
                      );
                    })}
                    <td className="border-b border-divider bg-surface" />
                  </tr>
                );
              })}
            </tbody>
            {rows.length ? (
              <tfoot>
                {(["latest", "lowest"] as const).map((k, fi) => (
                  /* Both rows stay in view: the first sits one row-height above the second. */
                  <tr key={k} className={fi === 0 ? "[&>td]:bottom-9" : "[&>td]:bottom-0"}>
                    <td className={cx(FOOT, "left-0 z-20", fi === 0 && "border-t border-line")} />
                    <td colSpan={2} className={cx(FOOT, FROZEN_EDGE, "left-[52px] z-20 text-left", fi === 0 && "border-t border-line")}>
                      <span className="text-2xs font-medium tracking-[0.04em] text-muted uppercase">{k === "latest" ? "Latest rate" : "Lowest rate"}</span>
                    </td>
                    {cols.map((c) => {
                      const s = stats.get(c.id);
                      return (
                        <td
                          key={c.id}
                          className={cx(FOOT, "border-r border-divider text-right text-meta font-semibold text-ink tabular-nums", fi === 0 && "border-t border-line")}
                          title={k === "latest" && s?.latestDate ? `Quoted ${showDate(s.latestDate)}` : undefined}
                        >
                          {s ? (k === "latest" ? (s.latest ?? "—") : (s.lowest ?? "—")) : ""}
                        </td>
                      );
                    })}
                    <td className={cx(FOOT, fi === 0 && "border-t border-line")} />
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

      {editing && suggestAt && suggestions.length ? (
        <SuggestList
          anchor={suggestAt}
          items={suggestions}
          draft={editing.draft}
          active={hl}
          onHover={setHl}
          onPick={(v) => finishEdit(undefined, v)}
        />
      ) : null}

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

      <Modal open={showArchived} onClose={() => setShowArchived(false)} title="Removed columns">
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
      </Modal>
    </>
  );
}

/** What the list offers for what is typed: names starting with it first, then names containing it. */
function suggestFor(all: string[], draft: string): string[] {
  const q = draft.trim().toLowerCase();
  if (!q) return all.slice(0, 50);
  const starts: string[] = [];
  const has: string[] = [];
  for (const v of all) {
    const l = v.toLowerCase();
    if (l === q) continue;
    if (l.startsWith(q)) starts.push(v);
    else if (l.includes(q)) has.push(v);
  }
  return [...starts, ...has].slice(0, 50);
}

/**
 * The suggestion list under a cell being edited — the app's own menu surface
 * rather than the browser's datalist, which cannot be styled. It sits on the
 * page (fixed, through a portal) so the grid's scroll box cannot clip it, and
 * opens upwards where there is no room below. Pressing an item keeps focus in
 * the cell (mousedown is prevented) and saves it.
 */
function SuggestList({
  anchor,
  items,
  draft,
  active,
  onHover,
  onPick,
}: {
  anchor: DOMRect;
  items: string[];
  draft: string;
  active: number;
  onHover: (i: number) => void;
  onPick: (v: string) => void;
}) {
  const MAX = 264;
  const below = typeof window === "undefined" || anchor.bottom + MAX + 8 < window.innerHeight || anchor.top < MAX + 8;
  const q = draft.trim().toLowerCase();
  return (
    <BodyPortal>
      <div
        id="quote-suggest"
        role="listbox"
        style={{
          left: anchor.left,
          minWidth: Math.max(anchor.width, 220),
          maxWidth: 420,
          maxHeight: MAX,
          ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
        }}
        className="animate-fade-in fixed z-[95] overflow-y-auto rounded-card border border-line bg-surface py-1 shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        {items.map((v, i) => {
          const at = q ? v.toLowerCase().indexOf(q) : -1;
          return (
            <div
              key={v}
              role="option"
              aria-selected={i === active}
              ref={(el) => {
                if (el && i === active) el.scrollIntoView({ block: "nearest" });
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(v);
              }}
              onMouseEnter={() => onHover(i)}
              className={cx("cursor-pointer truncate px-3 py-1.5 text-sm", i === active ? "bg-brand-soft text-brand-hover" : "text-body hover:bg-canvas")}
              title={v}
            >
              {at >= 0 ? (
                <>
                  {v.slice(0, at)}
                  <span className="font-semibold text-ink">{v.slice(at, at + q.length)}</span>
                  {v.slice(at + q.length)}
                </>
              ) : (
                v
              )}
            </div>
          );
        })}
      </div>
    </BodyPortal>
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
    <Modal
      open
      onClose={onClose}
      title={column ? "Edit column" : "Add a column"}
      footer={
        <div className="flex w-full items-center gap-2">
          {onRemove ? (
            <Button variant="danger" onClick={onRemove}>
              Remove column
            </Button>
          ) : null}
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave({ pack, name, brand, kind, rawMaterialId: rm || null })}>
            {column ? "Save" : "Add column"}
          </Button>
        </div>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ pack, name, brand, kind, rawMaterialId: rm || null });
        }}
      >
        <Labelled label="Pack (top line)" hint="185/180 KGS NET, 200 LITER">
          <Input value={pack} onChange={(e) => setPack(e.target.value)} maxLength={80} />
        </Labelled>
        <Labelled label="Material (middle line)">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        </Labelled>
        <Labelled label="Brand (bottom line)" hint="Mahek">
          <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
        </Labelled>
        <Labelled label="Holds">
          <Select value={kind} onChange={(e) => setKind(e.target.value === "text" ? "text" : "rate")} className="w-full">
            <option value="rate">Rates (numbers)</option>
            <option value="text">Text (a broker, a note)</option>
          </Select>
        </Labelled>
        <Labelled label="Raw material" hint="Optional — which item in the master this column is for">
          <Select value={rm} onChange={(e) => setRm(e.target.value)} className="w-full">
            <option value="">Not linked</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Labelled>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

function Labelled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium text-body">
        {label}
        {hint ? <span className="ml-1 font-normal text-muted">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
