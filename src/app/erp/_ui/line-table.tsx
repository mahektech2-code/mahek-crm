"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cx } from "@/components/ui/primitives";
import type { FieldSpec, FormSpec } from "@/lib/erp/ui";
import { whenHolds } from "@/lib/erp/ui";
import { runCalc } from "@/lib/erp/calc";
import { parsePastedLines } from "@/lib/erp/engines/purchase-flow";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * A document's lines as ONE TABLE, for documents that run to hundreds of
 * lines — a requirement of every item a department needs. The card-per-line
 * layout is right for an SFG batch of four lines and unusable at a hundred:
 * each line is a block of five fields, and the hundredth is a long scroll
 * from the header it shares.
 *
 * So a line is a row. Items arrive three ways, all from the same options the
 * server will check: a search box that adds the item picked (and puts the
 * cursor in its quantity), a box a list is pasted into — "Toluene, 200" a
 * row, straight from Excel — and the row's own cells. Enter in a quantity
 * goes back to the search, so a list can be keyed without the mouse. An item
 * already on the list is never added twice: the search jumps to its row.
 * ------------------------------------------------------------------------- */

type Line = Record<string, string>;

const CELL = "h-8 w-full rounded-[4px] border bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

export function LineTable({
  spec,
  h,
  lines,
  setLines,
  errs,
  clearErr,
  options,
}: {
  spec: FormSpec;
  h: Record<string, string>;
  lines: Line[];
  setLines: (fn: (s: Line[]) => Line[]) => void;
  errs: Record<string, string>;
  clearErr: (key: string) => void;
  /** A field's options for these values — the drawer's own `optsFor`. */
  options: (f: FieldSpec, values: Record<string, string>) => string[] | undefined;
}) {
  const data = spec.data ?? {};
  const fields = spec.line ?? [];
  const add = spec.lineAdd;
  const pickField = fields.find((f) => f.k === add?.field) ?? fields[0];
  const qtyKey = add?.qty ?? fields.find((f) => f.t === "num")?.k;
  const offered = useMemo(() => options(pickField, h) ?? [], [options, pickField, h]);
  /* Everything the field offers under ANY header — so a pasted name that exists but is not offered here is said as that, not as unknown. */
  const everywhere = useMemo(() => new Set(Object.values(pickField.optsBy?.map ?? {}).flat().map((x) => x.toLowerCase())), [pickField]);
  const noun = (spec.lineLabel ?? "Line").toLowerCase();

  const [paste, setPaste] = useState<{ open: boolean; text: string; note: string }>({ open: false, text: "", note: "" });
  const [find, setFind] = useState("");
  const [flash, setFlash] = useState<number | null>(null);
  const qtyRefs = useRef<(HTMLInputElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusQty = useRef<number | null>(null);

  /* After a line is added, its quantity takes the cursor. */
  useEffect(() => {
    if (focusQty.current == null) return;
    const el = qtyRefs.current[focusQty.current];
    focusQty.current = null;
    el?.focus();
    el?.select();
  });

  const picked = new Set(lines.map((l) => l[pickField.k]).filter(Boolean));

  const addItem = (item: string) => {
    const at = lines.findIndex((l) => l[pickField.k] === item);
    if (at >= 0) {
      focusQty.current = at;
      setFlash(at);
      setTimeout(() => setFlash(null), 1200);
      setLines((s) => [...s]);
      return;
    }
    const blank: Line = {};
    fields.forEach((f) => (blank[f.k] = f.def ?? ""));
    focusQty.current = lines.length;
    setLines((s) => [...s, { ...blank, [pickField.k]: item }]);
  };

  const applyPaste = () => {
    const r = parsePastedLines(paste.text, offered, [...picked]);
    if (r.lines.length) {
      const blank: Line = {};
      fields.forEach((f) => (blank[f.k] = f.def ?? ""));
      setLines((s) => [...s, ...r.lines.map((x) => ({ ...blank, [pickField.k]: x.item, ...(qtyKey ? { [qtyKey]: x.qty } : {}) }))]);
    }
    const nameOf = (row: string) => row.replace(/[\s,;\t]+-?\d+(?:[.,]\d+)?\s*[A-Za-z.]*\s*$/, "").trim().toLowerCase();
    const elsewhere = r.unmatched.filter((x) => everywhere.has(nameOf(x)));
    const unknown = r.unmatched.length - elsewhere.length;
    const by = pickField.optsBy ? (Array.isArray(pickField.optsBy.by) ? pickField.optsBy.by : [pickField.optsBy.by]).map((k) => h[k]).filter(Boolean).join(" · ") : "";
    const said = [
      r.lines.length ? `Added ${r.lines.length} ${noun}${r.lines.length === 1 ? "" : "s"}.` : "Nothing added.",
      r.duplicates.length ? `${r.duplicates.length} already on the list: ${r.duplicates.slice(0, 5).join(", ")}${r.duplicates.length > 5 ? "…" : ""}.` : "",
      elsewhere.length ? `${elsewhere.length} ${elsewhere.length === 1 ? "is not one" : "are not ones"} ${by || "this form"} asks for.` : "",
      unknown ? `${unknown} not recognised.` : "",
      r.unmatched.length ? "Those rows are left below — fix them and add again, or clear them." : "",
    ]
      .filter(Boolean)
      .join(" ");
    setPaste({ open: r.unmatched.length > 0, text: r.unmatched.join("\n"), note: said });
  };

  const remove = (i: number) => setLines((s) => s.filter((_, j) => j !== i));
  const set = (i: number, k: string, v: string) => {
    setLines((s) => s.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
    clearErr(`l${i}.${k}`);
  };

  const fl = find.trim().toLowerCase();
  const shown = lines.map((l, i) => ({ l, i })).filter(({ l }) => !fl || (l[pickField.k] ?? "").toLowerCase().includes(fl));
  const missingQty = qtyKey ? lines.filter((l) => l[pickField.k] && !l[qtyKey]).length : 0;
  const lineErrors = Object.keys(errs).filter((k) => /^l\d+\./.test(k) && errs[k]).length;

  return (
    <section className="grid min-w-0 gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[260px] flex-1">
          <ItemSearch inputRef={searchRef} offered={offered} picked={picked} placeholder={add?.placeholder ?? `Add a ${noun}`} onPick={addItem} />
        </div>
        <Button variant="secondary" onClick={() => setPaste((p) => ({ ...p, open: !p.open, note: "" }))}>
          {paste.open ? "Close paste" : "Paste a list"}
        </Button>
      </div>

      {paste.open ? (
        <div className="grid gap-2 rounded-[6px] border border-brand-softer bg-brand-soft/40 p-3">
          <span className="text-[13px] text-body">{add?.pasteHint ?? `One ${noun} a row, its quantity last.`}</span>
          {paste.note ? <span className="text-[13px] font-medium text-ink">{paste.note}</span> : null}
          <textarea
            value={paste.text}
            onChange={(e) => setPaste((p) => ({ ...p, text: e.target.value }))}
            rows={6}
            placeholder={"Toluene, 200\nMEK\t50\nTin can 5L 120"}
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 font-mono text-[13px] text-ink outline-none focus:border-brand"
          />
          <div className="flex gap-2">
            <Button variant="primary" onClick={applyPaste} disabled={!paste.text.trim()}>
              Add to the list
            </Button>
            <span className="self-center text-xs text-muted">Names are matched to the items you may ask for; nothing is guessed.</span>
          </div>
        </div>
      ) : paste.note ? (
        <span className="text-[13px] text-success">{paste.note}</span>
      ) : null}

      <div className="min-w-0 overflow-hidden rounded-[6px] border border-line">
        <div className="flex items-center justify-between gap-3 border-b border-divider bg-canvas px-3 py-2">
          <span className="text-[13px] font-semibold text-ink">
            {lines.length ? `${lines.length.toLocaleString("en-IN")} ${noun}${lines.length === 1 ? "" : "s"}` : `No ${noun}s yet`}
            {missingQty ? <span className="ml-2 font-normal text-warn-ink">· {missingQty} without a quantity</span> : null}
            {lineErrors ? <span className="ml-2 font-normal text-danger">· {lineErrors} to fix</span> : null}
          </span>
          {lines.length > 12 ? (
            <span className="relative w-56">
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find in this list" className={cx(CELL, "h-7 border-line pr-7 text-[13px]")} />
              <span className="pointer-events-none absolute top-1.5 right-2 flex text-muted">
                <Icon n="search" s={14} />
              </span>
            </span>
          ) : null}
        </div>
        {lines.length === 0 ? (
          <div className="grid place-items-center gap-1 px-4 py-10 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-brand-soft text-[#5223E0]">
              <Icon n="cart" />
            </span>
            <span className="text-sm font-medium text-ink">Search above to add the first {noun}</span>
            <span className="text-[13px] text-muted">or paste a whole list from a spreadsheet — a hundred items take the same few seconds as one.</span>
          </div>
        ) : (
          <div className="max-h-[52vh] overflow-y-auto">
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col style={{ width: 44 }} />
                {fields.map((f) => (
                  <col key={f.k} style={{ width: f.k === pickField.k ? undefined : f.t === "num" ? 120 : f.t === "derived" && f.k === "unit" ? 64 : 170 }} />
                ))}
                <col style={{ width: 40 }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-divider text-left text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
                  <th className="px-3 py-2 font-semibold">#</th>
                  {fields.map((f) => (
                    <th key={f.k} className={cx("px-2 py-2 font-semibold", f.t === "num" && "text-right")}>
                      {f.l}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map(({ l, i }) => (
                  <tr key={i} className={cx("border-b border-divider last:border-b-0 align-middle", flash === i ? "bg-brand-soft" : "hover:bg-canvas/60")}>
                    <td className="px-3 py-2 text-[13px] text-muted tabular-nums">{i + 1}</td>
                    {fields.map((f) => {
                      const err = errs[`l${i}.${f.k}`];
                      const values = { ...h, ...l };
                      if (!whenHolds(f.when, values, data)) return <td key={f.k} />;
                      let cell: React.ReactNode;
                      if (f.k === pickField.k) {
                        const known = offered.includes(l[f.k] ?? "");
                        cell = (
                          <span className="block py-1.5">
                            <span className={cx("block truncate font-medium", known ? "text-ink" : "text-danger")} title={l[f.k]}>
                              {l[f.k] || "—"}
                            </span>
                            {!known && l[f.k] ? <span className="block text-xs text-danger">Not one you may ask for here</span> : null}
                          </span>
                        );
                      } else if (f.t === "derived") {
                        const v = runCalc(f.calc, { h, l, lines, i, data });
                        cell = (
                          <span className="block truncate py-1.5 text-[13px] text-body" title={v}>
                            {v || "—"}
                          </span>
                        );
                      } else if (f.t === "num") {
                        cell = (
                          <input
                            ref={f.k === qtyKey ? (el) => void (qtyRefs.current[i] = el) : undefined}
                            type="number"
                            inputMode="decimal"
                            step="any"
                            min={f.min}
                            value={l[f.k] ?? ""}
                            onChange={(e) => set(i, f.k, e.target.value)}
                            onKeyDown={(e) => {
                              if (f.k !== qtyKey) return;
                              if (e.key === "Enter") {
                                e.preventDefault();
                                searchRef.current?.focus();
                              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                                e.preventDefault();
                                qtyRefs.current[i + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
                              }
                            }}
                            placeholder="0"
                            className={cx(CELL, "text-right tabular-nums", err ? "border-danger" : "border-line")}
                          />
                        );
                      } else if (f.t === "select") {
                        const opts = options(f, values) ?? [];
                        cell = (
                          <select value={l[f.k] ?? ""} onChange={(e) => set(i, f.k, e.target.value)} className={cx(CELL, "cursor-pointer", err ? "border-danger" : "border-line")}>
                            <option value="">Choose…</option>
                            {opts.map((o) => (
                              <option key={o}>{o}</option>
                            ))}
                          </select>
                        );
                      } else {
                        cell = <input value={l[f.k] ?? ""} onChange={(e) => set(i, f.k, e.target.value)} className={cx(CELL, err ? "border-danger" : "border-line")} />;
                      }
                      return (
                        <td key={f.k} className="px-2 py-1.5">
                          {cell}
                          {err ? <span className="mt-0.5 block text-xs text-danger">{err}</span> : null}
                        </td>
                      );
                    })}
                    <td className="py-1.5 pr-2 text-right">
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        title={`Remove ${l[pickField.k] || "this line"}`}
                        aria-label={`Remove ${l[pickField.k] || "this line"}`}
                        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-danger-soft hover:text-danger"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
                {fl && !shown.length ? (
                  <tr>
                    <td colSpan={fields.length + 2} className="px-3 py-4 text-center text-[13px] text-muted">
                      Nothing on the list matches “{find}”
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The search that adds a line. Arrow keys move through the matches and Enter
 * adds the highlighted one; an item already on the list is marked and picking
 * it jumps to its row rather than adding it twice.
 */
function ItemSearch({
  offered,
  picked,
  placeholder,
  onPick,
  inputRef,
}: {
  offered: string[];
  picked: Set<string>;
  placeholder: string;
  onPick: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ql = q.trim().toLowerCase();
  const matches = (ql ? offered.filter((x) => x.toLowerCase().includes(ql)) : offered).slice(0, 50);
  const choose = (v: string) => {
    onPick(v);
    setQ("");
    setHi(0);
    setOpen(false);
  };
  return (
    <span className="relative block">
      <span className="pointer-events-none absolute top-2.5 left-2.5 flex text-[#5223E0]">
        <Icon n="plus" s={15} />
      </span>
      <input
        ref={inputRef}
        value={q}
        placeholder={offered.length ? `${placeholder} (${offered.length.toLocaleString("en-IN")} items)` : "Choose the department first"}
        disabled={!offered.length}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((x) => Math.min(x + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((x) => Math.max(x - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (matches[hi]) choose(matches[hi]);
          } else if (e.key === "Escape") setOpen(false);
        }}
        className="h-9 w-full rounded-[4px] border border-brand-softer bg-surface pr-3 pl-8 text-sm text-ink outline-none placeholder:text-muted focus:border-brand disabled:bg-canvas"
      />
      {open && offered.length ? (
        <span className="absolute top-10 right-0 left-0 z-30 block max-h-[280px] overflow-y-auto rounded-[6px] border border-line bg-surface py-1 shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
          {matches.map((x, i) => (
            <button
              type="button"
              key={x}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(x);
              }}
              onMouseEnter={() => setHi(i)}
              className={cx("flex min-h-8.5 w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left text-sm text-ink", i === hi && "bg-brand-soft")}
            >
              <span className="truncate">{x}</span>
              {picked.has(x) ? <span className="flex-none text-xs text-muted">on the list · jump to it</span> : null}
            </button>
          ))}
          {!matches.length ? <span className="block px-3 py-2.5 text-[13px] text-muted">Nothing matches “{q}”</span> : null}
          {ql && offered.filter((x) => x.toLowerCase().includes(ql)).length > 50 ? (
            <span className="block border-t border-divider px-3 py-2 text-xs text-muted">More match — keep typing</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
