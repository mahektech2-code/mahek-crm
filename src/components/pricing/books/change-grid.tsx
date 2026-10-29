"use client";

/* ---------------------------------------------------------------------------
 * EDITING A CHANGE — the live price struck through beside the new one.
 *
 * Every cell saves as it is committed (Enter or leaving the box), so there is
 * no Save button to forget and nothing lost to a closed tab. Undo and redo
 * replay the previous figure through the same save. A figure ten times off
 * the live one is caught in the cell, with the likely intended figure offered
 * as one click — ₹625 typed for ₹6,258 is the commonest slip there is.
 *
 * The bulk tools, paste-from-Excel and the instruction box all compute their
 * prices with the same pure engine the server re-runs (`price-instruction`),
 * so the preview and what is written cannot disagree.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, Select, Td, Textarea, Th, Tr, checkboxClass, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { ChangeView } from "@/lib/price-book-views";
import type { CellDiff, ChangeFlag } from "@/lib/engines/price-change";
import { cellKey, suggestTypoFix } from "@/lib/engines/price-change";
import { applyInstruction, EMPTY_TARGET, type InstructionOp, type InstructionRounding, type InstructionRule } from "@/lib/engines/price-instruction";
import { money, parseRupees, rupeesFromPaise } from "@/lib/format";
import {
  applyInstructionRule,
  copyFromBook,
  previewInstruction,
  setChangeCells,
  type ChangeCellInput,
  type InstructionPreview,
} from "@/lib/actions/price-books";
import { packWords, pctWords } from "@/components/pricing/books/stage-labels";

/** "Nano Thinner - 20 Liter (2 Can/Box)" under the Nano Thinner heading reads as "20 Liter (2 Can/Box)". */
function variantOf(name: string, family: string): string {
  const cut = name.indexOf(" - ");
  if (cut > 0 && name.slice(0, cut).trim().toLowerCase() === family.trim().toLowerCase()) return name.slice(cut + 3);
  return name;
}

type Edit = { productId: string; minCans: number | null; before: { incl: number; offered: boolean } | null; after: { incl: number; offered: boolean } | null };

type Filter = "all" | "changed" | "flagged";

export function ChangeGrid({
  change,
  editable,
  addable,
}: {
  change: ChangeView;
  editable: boolean;
  addable: Array<{ id: string; name: string; millilitresPerCan: number | null; family: string }>;
}) {
  const router = useRouter();
  const { run, push } = useToast();
  const [typed, setTyped] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<string | null>(null);
  const [undo, setUndo] = React.useState<Edit[]>([]);
  const [redo, setRedo] = React.useState<Edit[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [filter, setFilter] = React.useState<Filter>("all");
  const [q, setQ] = React.useState("");
  const [tool, setTool] = React.useState<null | "bulk" | "paste" | "copy" | "instruction" | "add">(null);

  const flagsByCell = React.useMemo(() => {
    const out = new Map<string, ChangeFlag[]>();
    for (const f of change.flags) if (f.cellKey) out.set(f.cellKey, [...(out.get(f.cellKey) ?? []), f]);
    return out;
  }, [change.flags]);

  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return change.diffs.filter((d) => {
      if (filter === "changed" && d.kind === "same") return false;
      if (filter === "flagged" && !flagsByCell.has(d.key)) return false;
      if (needle && !d.productName.toLowerCase().includes(needle) && !d.family.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [change.diffs, filter, q, flagsByCell]);

  const families = React.useMemo(() => {
    const out: Array<{ family: string; rows: CellDiff[] }> = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.family === r.family) last.rows.push(r);
      else out.push({ family: r.family, rows: [r] });
    }
    return out;
  }, [rows]);

  async function save(cells: ChangeCellInput[], edits: Edit[], label?: string) {
    if (!cells.length) return true;
    setSaving(label ?? cells[0].productId);
    try {
      const r = await setChangeCells(change.id, cells);
      if (!r.ok) {
        push(r.error, "error");
        return false;
      }
      setUndo((u) => [...u, ...edits].slice(-200));
      setRedo([]);
      router.refresh();
      return true;
    } finally {
      setSaving(null);
    }
  }

  async function commit(d: CellDiff) {
    const text = typed[d.key];
    if (text == null) return;
    const incl = parseRupees(text);
    setTyped((t) => {
      const n = { ...t };
      delete n[d.key];
      return n;
    });
    if (incl == null) return;
    if (d.after && incl === d.after.rateInclGstPaise) return;
    await save(
      [{ productId: d.productId, minCans: d.minCans, inclPaise: incl, offered: d.after?.offered ?? true }],
      [{ productId: d.productId, minCans: d.minCans, before: d.after ? { incl: d.after.rateInclGstPaise, offered: d.after.offered } : null, after: { incl, offered: true } }],
    );
  }

  async function replay(e: Edit, direction: "undo" | "redo") {
    const target = direction === "undo" ? e.before : e.after;
    const cell: ChangeCellInput = target
      ? { productId: e.productId, minCans: e.minCans, inclPaise: target.incl, offered: target.offered }
      : { productId: e.productId, minCans: e.minCans, remove: true };
    setSaving(e.productId);
    try {
      const r = await setChangeCells(change.id, [cell]);
      if (!r.ok) return push(r.error, "error");
      if (direction === "undo") {
        setUndo((u) => u.slice(0, -1));
        setRedo((x) => [...x, e]);
      } else {
        setRedo((x) => x.slice(0, -1));
        setUndo((u) => [...u, e]);
      }
      router.refresh();
    } finally {
      setSaving(null);
    }
  }

  const selectedRates = change.draft.filter((r) => selected.has(cellKey(r.productId, r.minCans)));

  return (
    <Card className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-3">
        <div className="flex items-center gap-1">
          {(["all", "changed", "flagged"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cx(
                "h-7 rounded-control px-2.5 text-[13px]",
                filter === f ? "bg-brand-soft font-medium text-brand-hover" : "text-muted hover:text-body",
              )}
            >
              {f === "all" ? `All ${change.diffs.length}` : f === "changed" ? `Changed ${change.counts.changed}` : `Flagged ${flagsByCell.size}`}
            </button>
          ))}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product" className="h-7 w-48 text-[13px]" />
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {editable ? (
            <>
              <Button size="sm" variant="ghost" disabled={!undo.length || !!saving} onClick={() => replay(undo[undo.length - 1], "undo")} title="Undo the last edit">
                ↶ Undo
              </Button>
              <Button size="sm" variant="ghost" disabled={!redo.length || !!saving} onClick={() => replay(redo[redo.length - 1], "redo")} title="Redo">
                ↷ Redo
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setTool("bulk")} disabled={!selected.size} title={selected.size ? "" : "Tick the rows to change first"}>
                Bulk change {selected.size ? `(${selected.size})` : ""}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setTool("paste")}>
                Paste from Excel
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setTool("copy")}>
                Copy from a book
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setTool("add")}>
                Add a product
              </Button>
              <Button size="sm" variant="primary" onClick={() => setTool("instruction")}>
                ✦ Describe the change
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="max-h-[680px] overflow-auto">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            {editable ? <col style={{ width: 36 }} /> : null}
            <col />
            <col style={{ width: 100 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 96 }} />
          </colgroup>
          <thead>
            <tr>
              {editable ? (
                <Th>
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    aria-label="Select every row shown"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r.key))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.filter((r) => r.after).map((r) => r.key)) : new Set())}
                  />
                </Th>
              ) : null}
              <Th>Pack</Th>
              <Th align="right">Live</Th>
              <Th align="right">New (with GST)</Th>
              <Th align="right">Move</Th>
              <Th align="right">A litre</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {families.map((fam) => (
              <React.Fragment key={fam.family}>
                <tr className="bg-canvas">
                  <td colSpan={editable ? 7 : 6} className="px-3 py-1.5 text-xs font-semibold tracking-label text-muted uppercase">
                    {fam.family}
                  </td>
                </tr>
                {fam.rows.map((d) => {
                  const flags = flagsByCell.get(d.key) ?? [];
                  const typedValue = typed[d.key];
                  const pending = typedValue != null ? parseRupees(typedValue) : null;
                  const live = d.before?.rateInclGstPaise ?? null;
                  const guess = pending != null && live ? (pending * 5 <= live || pending >= live * 5 ? suggestTypoFix(pending, live) : null) : null;
                  const shownNew = d.after ? d.after.rateInclGstPaise : null;
                  const perLitre = d.after && d.millilitresPerCan ? Math.round((d.after.rateInclGstPaise * 1000) / d.millilitresPerCan) : null;
                  return (
                    <Tr
                      key={d.key}
                      className={cx(
                        d.kind === "up" && "bg-warn-soft/40",
                        d.kind === "down" && "bg-success-soft/40",
                        flags.some((f) => f.severity === "high") && "bg-danger-soft/40",
                      )}
                    >
                      {editable ? (
                        <Td>
                          {d.after ? (
                            <input
                              type="checkbox"
                              className={checkboxClass}
                              aria-label={`Select ${d.productName}`}
                              checked={selected.has(d.key)}
                              onChange={(e) =>
                                setSelected((s) => {
                                  const n = new Set(s);
                                  if (e.target.checked) n.add(d.key);
                                  else n.delete(d.key);
                                  return n;
                                })
                              }
                            />
                          ) : null}
                        </Td>
                      ) : null}
                      <Td className="truncate" title={d.productName}>
                        <span className="text-ink">{variantOf(d.productName, d.family) || packWords(d.millilitresPerCan)}</span>
                        {d.minCans ? <span className="ml-1 text-xs text-muted">from {d.minCans} cans</span> : null}
                      </Td>
                      <Td align="right">
                        {live != null ? (
                          <span className={cx(d.kind !== "same" ? "text-muted line-through" : "text-body")}>{money(live)}</span>
                        ) : (
                          <Badge tone="brand">new</Badge>
                        )}
                      </Td>
                      <Td align="right" className="py-1">
                        {d.after ? (
                          editable ? (
                            <div>
                              <input
                                inputMode="decimal"
                                aria-label={`New price for ${d.productName}`}
                                className={cx(
                                  "h-8 w-[120px] rounded-control border bg-surface px-2 text-right text-sm text-ink focus:border-brand focus:outline-none",
                                  guess ? "border-danger" : "border-line",
                                  saving === d.productId && "opacity-60",
                                )}
                                value={typedValue ?? (shownNew != null ? rupeesFromPaise(shownNew) : "")}
                                onChange={(e) => setTyped((t) => ({ ...t, [d.key]: e.target.value }))}
                                onBlur={() => commit(d)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                  /* Escape abandons the typing in THIS cell and keeps the editor open. */
                                  if (e.key === "Escape") {
                                    e.stopPropagation();
                                    setTyped((t) => {
                                      const n = { ...t };
                                      delete n[d.key];
                                      return n;
                                    });
                                  }
                                }}
                              />
                              {guess ? (
                                <button
                                  type="button"
                                  className="mt-0.5 block w-full text-right text-[11px] text-danger hover:underline"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setTyped((t) => ({ ...t, [d.key]: rupeesFromPaise(guess) }));
                                  }}
                                >
                                  {money(pending!)} is far from {money(live!)} — use {money(guess)}?
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <span className={cx("font-medium", d.kind === "up" ? "text-warn-ink" : d.kind === "down" ? "text-success" : "text-ink")}>
                              {d.after.offered ? money(d.after.rateInclGstPaise) : "not offered"}
                            </span>
                          )
                        ) : (
                          <span className="text-[13px] text-danger">Removed</span>
                        )}
                      </Td>
                      <Td align="right" className={cx("text-[13px]", d.kind === "up" ? "text-warn-ink" : d.kind === "down" ? "text-success" : "text-muted")}>
                        {d.kind === "added" ? "added" : d.kind === "removed" ? "—" : d.kind === "offer_changed" ? (d.after?.offered ? "on sale" : "off sale") : pctWords(d.changeBp)}
                      </Td>
                      <Td align="right" className="text-[13px] text-muted">
                        {perLitre != null ? money(perLitre) : "—"}
                      </Td>
                      <Td align="right">
                        <div className="flex items-center justify-end gap-2">
                          {flags.length ? (
                            <span title={flags.map((f) => `${f.by}: ${f.message}`).join("\n")}>
                              <Badge tone={flags.some((f) => f.severity === "high") ? "danger" : "warn"}>{flags.length} flag{flags.length === 1 ? "" : "s"}</Badge>
                            </span>
                          ) : null}
                          {editable && d.after ? (
                            <button
                              type="button"
                              className="text-[12px] text-muted hover:text-danger"
                              title={d.before ? "Take it off this change (shops fall to a wider book for it)" : "Remove the added product"}
                              onClick={() =>
                                save(
                                  [{ productId: d.productId, minCans: d.minCans, remove: true }],
                                  [{ productId: d.productId, minCans: d.minCans, before: { incl: d.after!.rateInclGstPaise, offered: d.after!.offered }, after: null }],
                                )
                              }
                            >
                              ✕
                            </button>
                          ) : null}
                          {editable && !d.after && d.before ? (
                            <button
                              type="button"
                              className="text-[12px] text-brand hover:underline"
                              onClick={() =>
                                save(
                                  [{ productId: d.productId, minCans: d.minCans, inclPaise: d.before!.rateInclGstPaise, offered: d.before!.offered }],
                                  [{ productId: d.productId, minCans: d.minCans, before: null, after: { incl: d.before!.rateInclGstPaise, offered: d.before!.offered } }],
                                )
                              }
                            >
                              Restore
                            </button>
                          ) : null}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="px-5 py-6 text-center text-[13px] text-muted">Nothing to show with this filter.</p> : null}
      </div>

      {tool === "bulk" ? (
        <BulkModal
          change={change}
          rows={selectedRates}
          onClose={() => setTool(null)}
          onApply={async (cells, edits) => {
            if (await save(cells, edits, "bulk")) {
              setTool(null);
              setSelected(new Set());
            }
          }}
        />
      ) : null}
      {tool === "paste" ? (
        <PasteModal
          change={change}
          addable={addable}
          onClose={() => setTool(null)}
          onApply={async (cells, edits) => {
            if (await save(cells, edits, "paste")) setTool(null);
          }}
        />
      ) : null}
      {tool === "copy" ? <CopyModal change={change} onClose={() => setTool(null)} onDone={() => router.refresh()} run={run} /> : null}
      {tool === "add" ? (
        <AddModal
          addable={addable}
          onClose={() => setTool(null)}
          onApply={async (cells, edits) => {
            if (await save(cells, edits, "add")) setTool(null);
          }}
        />
      ) : null}
      {tool === "instruction" ? <InstructionModal change={change} onClose={() => setTool(null)} onDone={() => router.refresh()} /> : null}
    </Card>
  );
}

/* ---------------------------------------------------------------- tools */

type ApplyFn = (cells: ChangeCellInput[], edits: Edit[]) => Promise<void>;

function proposalsToCells(change: ChangeView, proposals: ReturnType<typeof applyInstruction>): { cells: ChangeCellInput[]; edits: Edit[] } {
  const now = new Map(change.draft.map((r) => [cellKey(r.productId, r.minCans), r]));
  return {
    cells: proposals.map((p) => ({ productId: p.productId, minCans: p.minCans, inclPaise: p.afterInclPaise, offered: true })),
    edits: proposals.map((p) => {
      const r = now.get(p.key);
      return { productId: p.productId, minCans: p.minCans, before: r ? { incl: r.rateInclGstPaise, offered: r.offered } : null, after: { incl: p.afterInclPaise, offered: true } };
    }),
  };
}

function BulkModal({ change, rows, onClose, onApply }: { change: ChangeView; rows: ChangeView["draft"]; onClose: () => void; onApply: ApplyFn }) {
  const [op, setOp] = React.useState<InstructionOp>("percent");
  const [value, setValue] = React.useState("");
  const [basis, setBasis] = React.useState<"incl" | "ex">("incl");
  const [rounding, setRounding] = React.useState<InstructionRounding>("rupee");
  const n = Number(value);
  const rule: InstructionRule | null =
    value.trim() && Number.isFinite(n)
      ? {
          op,
          valueBp: op === "percent" ? Math.round(n * 100) : null,
          valuePaise: op === "percent" ? null : Math.round(n * 100),
          basis,
          target: { ...EMPTY_TARGET, productIds: [...new Set(rows.map((r) => r.productId))] },
          rounding,
          exceptions: [],
        }
      : null;
  const proposals = rule ? applyInstruction(rows, rule, change.gstBp) : [];
  return (
    <Modal
      open
      onClose={onClose}
      title={`Change ${rows.length} price${rows.length === 1 ? "" : "s"} at once`}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!proposals.length} onClick={() => { const c = proposalsToCells(change, proposals); void onApply(c.cells, c.edits); }}>
            Apply to {proposals.length}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="text-[13px] text-body">
          How
          <Select value={op} onChange={(e) => setOp(e.target.value as InstructionOp)} className="mt-1 w-full">
            <option value="percent">By a percent (−3 for a cut)</option>
            <option value="per_litre">By rupees a litre</option>
            <option value="per_can">By rupees a can</option>
            <option value="set">Set every one to</option>
          </Select>
        </label>
        <label className="text-[13px] text-body">
          {op === "percent" ? "Percent" : "Rupees"}
          <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder={op === "percent" ? "5" : "2"} className="mt-1 w-full" />
        </label>
        <label className="text-[13px] text-body">
          Measured on
          <Select value={basis} onChange={(e) => setBasis(e.target.value as "incl" | "ex")} className="mt-1 w-full">
            <option value="incl">The price with GST (as printed)</option>
            <option value="ex">The price before GST</option>
          </Select>
        </label>
        <label className="text-[13px] text-body">
          Round to
          <Select value={rounding} onChange={(e) => setRounding(e.target.value as InstructionRounding)} className="mt-1 w-full">
            <option value="none">No rounding</option>
            <option value="rupee">The rupee</option>
            <option value="five">₹5</option>
            <option value="ten">₹10</option>
          </Select>
        </label>
      </div>
      <ProposalTable proposals={proposals} />
    </Modal>
  );
}

function ProposalTable({ proposals }: { proposals: ReturnType<typeof applyInstruction> }) {
  if (!proposals.length) return <p className="mt-4 text-[13px] text-muted">No price would change.</p>;
  return (
    <div className="mt-4 max-h-[320px] overflow-auto rounded-control border border-line">
      <table className="w-full table-fixed">
        <colgroup>
          <col />
          <col style={{ width: 110 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 80 }} />
        </colgroup>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th align="right">Now</Th>
            <Th align="right">Becomes</Th>
            <Th align="right">Move</Th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((p) => (
            <Tr key={p.key}>
              <Td className="truncate" title={`${p.productName} — ${p.why}`}>
                {p.productName}
              </Td>
              <Td align="right" className="text-muted">
                {money(p.beforeInclPaise)}
              </Td>
              <Td align="right" className="font-medium text-ink">
                {money(p.afterInclPaise)}
              </Td>
              <Td align="right" className={p.afterExPaise > p.beforeExPaise ? "text-warn-ink" : "text-success"}>
                {pctWords(Math.round(((p.afterExPaise - p.beforeExPaise) * 10000) / p.beforeExPaise))}
              </Td>
            </Tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Two columns out of a spreadsheet: a product name and a price with GST.
 * Matched by the product's own name, exactly (case and spacing aside), on
 * this book first and then the catalogue. Anything else is listed, not guessed.
 */
function PasteModal({
  change,
  addable,
  onClose,
  onApply,
}: {
  change: ChangeView;
  addable: Array<{ id: string; name: string }>;
  onClose: () => void;
  onApply: ApplyFn;
}) {
  const [text, setText] = React.useState("");
  const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const byName = new Map<string, { id: string; name: string }>();
  for (const p of addable) byName.set(fold(p.name), { id: p.id, name: p.name });
  for (const r of change.draft) if ((r.minCans ?? 0) === 0) byName.set(fold(r.productName), { id: r.productId, name: r.productName });
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes("\t") ? line.split("\t") : line.split(/\s{2,}|,(?=[^,]*$)/);
      const name = (parts[0] ?? "").trim();
      const price = parseRupees(parts.slice(1).join(" "));
      const match = byName.get(fold(name)) ?? null;
      return { line, name, price, match };
    });
  const good = lines.filter((l) => l.match && l.price != null && l.price > 0);
  const now = new Map(change.draft.filter((r) => (r.minCans ?? 0) === 0).map((r) => [r.productId, r]));
  return (
    <Modal
      open
      onClose={onClose}
      title="Paste prices from Excel"
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!good.length}
            onClick={() =>
              void onApply(
                good.map((l) => ({ productId: l.match!.id, minCans: null, inclPaise: l.price!, offered: true })),
                good.map((l) => {
                  const r = now.get(l.match!.id);
                  return { productId: l.match!.id, minCans: null, before: r ? { incl: r.rateInclGstPaise, offered: r.offered } : null, after: { incl: l.price!, offered: true } };
                }),
              )
            }
          >
            Use {good.length} price{good.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px] text-muted">
        Copy two columns — the product name as MahekOne spells it, and the price with GST — and paste them here. One product a line.
      </p>
      <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Nano Thinner - 20 Liter (2 Can/Box)\t2400\nNano Thinner - 5 Liter (6 Can/Box)\t615"} className="w-full font-mono text-[12px]" />
      {lines.length ? (
        <div className="mt-3 max-h-[220px] overflow-auto text-[13px]">
          {lines.map((l, i) => (
            <div key={i} className={cx("flex justify-between gap-3 border-b border-divider py-1", !l.match || l.price == null ? "text-danger" : "text-body")}>
              <span className="truncate">{l.match ? l.match.name : `Not recognised: ${l.name || l.line}`}</span>
              <span className="flex-none">{l.price != null ? money(l.price) : "no price"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

function CopyModal({
  change,
  onClose,
  onDone,
  run,
}: {
  change: ChangeView;
  onClose: () => void;
  onDone: () => void;
  run: ReturnType<typeof useToast>["run"];
}) {
  const [source, setSource] = React.useState("");
  const [mode, setMode] = React.useState<"missing" | "all">("missing");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="Copy prices from another book"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!source || busy}
            onClick={async () => {
              setBusy(true);
              const r = await run(copyFromBook(change.id, source, mode));
              setBusy(false);
              if (r.ok) {
                onDone();
                onClose();
              }
            }}
          >
            Copy
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-[13px] text-body">
          From
          <Select value={source} onChange={(e) => setSource(e.target.value)} className="mt-1 w-full">
            <option value="">Choose a book…</option>
            {change.otherBooks.map((b) => (
              <option key={b.id} value={b.listId}>
                {b.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="radio" checked={mode === "missing"} onChange={() => setMode("missing")} /> Only products this book does not price yet
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="radio" checked={mode === "all"} onChange={() => setMode("all")} /> Every price (overwrites this change&apos;s prices for the same products)
        </label>
      </div>
    </Modal>
  );
}

function AddModal({
  addable,
  onClose,
  onApply,
}: {
  addable: Array<{ id: string; name: string; millilitresPerCan: number | null; family: string }>;
  onClose: () => void;
  onApply: ApplyFn;
}) {
  const [q, setQ] = React.useState("");
  const [productId, setProductId] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [minCans, setMinCans] = React.useState("");
  const needle = q.trim().toLowerCase();
  const found = addable.filter((p) => !needle || p.name.toLowerCase().includes(needle)).slice(0, 40);
  const incl = parseRupees(price);
  const slab = minCans.trim() ? Number(minCans) : null;
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a product or a quantity price"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!productId || !incl || (slab != null && (!Number.isInteger(slab) || slab <= 0))}
            onClick={() => void onApply([{ productId, minCans: slab, inclPaise: incl!, offered: true }], [{ productId, minCans: slab, before: null, after: { incl: incl!, offered: true } }])}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalogue" className="w-full" />
        <div className="max-h-[220px] overflow-auto rounded-control border border-line">
          {found.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setProductId(p.id)}
              className={cx("block w-full px-3 py-1.5 text-left text-[13px] hover:bg-canvas", productId === p.id && "bg-brand-soft")}
            >
              {p.name} <span className="text-muted">· {packWords(p.millilitresPerCan)}</span>
            </button>
          ))}
          {!found.length ? <p className="px-3 py-2 text-[13px] text-muted">Every product matching that is already on this book.</p> : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-[13px]">
            Price with GST
            <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className="mt-1 w-full" />
          </label>
          <label className="text-[13px]">
            From how many cans (leave empty for the plain price)
            <Input value={minCans} onChange={(e) => setMinCans(e.target.value)} inputMode="numeric" className="mt-1 w-full" />
          </label>
        </div>
      </div>
    </Modal>
  );
}

/**
 * "DESCRIBE THE CHANGE." The sentence is read into a rule — by code where it
 * is plain, by a model where it is not — and the rule is shown in words with
 * every price it produces BEFORE anything is written. Apply re-computes on
 * the server from the draft as it then stands.
 */
function InstructionModal({ change, onClose, onDone }: { change: ChangeView; onClose: () => void; onDone: () => void }) {
  const { run, push } = useToast();
  const [text, setText] = React.useState("");
  const [preview, setPreview] = React.useState<InstructionPreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="Describe the change"
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {preview ? (
            <Button
              variant="primary"
              disabled={busy || !preview.proposals.length}
              onClick={async () => {
                setBusy(true);
                const r = await run(applyInstructionRule(change.id, preview.rule, text));
                setBusy(false);
                if (r.ok) {
                  onDone();
                  onClose();
                }
              }}
            >
              Apply {preview.proposals.length} price{preview.proposals.length === 1 ? "" : "s"} to the draft
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || !text.trim()}
              onClick={async () => {
                setBusy(true);
                const r = await previewInstruction(change.id, text);
                setBusy(false);
                if (r.ok) setPreview(r.data);
                else push(r.error, "error");
              }}
            >
              {busy ? "Reading…" : "Show me what it does"}
            </Button>
          )}
        </>
      }
    >
      <p className="mb-2 text-[13px] text-muted">
        Say it the way you would to a colleague — “everything up 5%, Nano held, round to the rupee” or “₹2 a litre more on the 20 L packs”. Nothing is
        written until you press Apply.
      </p>
      <Textarea
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        className="w-full"
        placeholder="Describe the change"
      />
      {preview ? (
        <div className="mt-4">
          <div className="rounded-control border border-brand-softer bg-brand-soft px-3 py-2 text-[13px] text-body">
            <b>Understood{preview.by !== "MahekOne" ? ` by ${preview.by}` : ""}:</b> {preview.words}
            <div className="mt-0.5 text-[12px] text-muted">Every price below is computed by MahekOne from this change's current prices; the reader only described the rule.</div>
          </div>
          {preview.questions.length ? (
            <div className="mt-2 space-y-1">
              {preview.questions.map((q, i) => (
                <div key={i} className="rounded-control border border-warn-line bg-warn-soft px-3 py-1.5 text-[13px] text-warn-ink">
                  {q}
                </div>
              ))}
            </div>
          ) : null}
          <ProposalTable proposals={preview.proposals} />
        </div>
      ) : null}
    </Modal>
  );
}
