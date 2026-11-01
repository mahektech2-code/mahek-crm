"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Button, controlClass, cx } from "@/components/ui/primitives";
import { erpAddUom } from "@/lib/actions/erp";
import {
  BASE_SHORT,
  baseText,
  findUom,
  measureOfBase,
  tidy,
  unitsFor,
  uomProblems,
  type Measure,
  type Uom,
} from "@/lib/erp/engines/uom";
import { nf } from "@/lib/erp/ui";
import { popoverClass } from "./look";
import { Icon } from "./icons";
import { matchOptions } from "./option-match";

/* ---------------------------------------------------------------------------
 * THE UNIT BESIDE A QUANTITY. Every ERP quantity box that holds a figure in a
 * base unit (kg, litres, pieces) draws a dropdown of the units that measure
 * the same thing — searchable, with "Add a unit" at the foot for one nobody
 * has listed yet. The box hands the form the figure ALREADY IN THE BASE, so a
 * calculator, a min/max check and the server read exactly what they always
 * read; only the typing changed. Rules: `lib/erp/engines/uom.ts`.
 *
 * The units come from the ERP layout (`UnitsProvider`). Outside it — HRMS
 * draws the same fields — there is no context, and a box is the plain number
 * it always was.
 * ------------------------------------------------------------------------- */

type UnitsCtx = { units: Uom[]; canAdd: boolean; add: (u: Uom) => void };
const Units = createContext<UnitsCtx | null>(null);

export function UnitsProvider({ units, canAdd, children }: { units: Uom[]; canAdd: boolean; children: React.ReactNode }) {
  const [added, setAdded] = useState<Uom[]>([]);
  const all = [...units, ...added.filter((a) => !units.some((u) => u.id === a.id))];
  return <Units.Provider value={{ units: all, canAdd, add: (u) => setAdded((x) => [...x, u]) }}>{children}</Units.Provider>;
}

/** The word the base reads as inside its box: L, kg, or what the field counts. */
function baseWord(base: string, measure: Measure): string {
  const w = base.trim().toLowerCase();
  if (measure === "count" && (w === "cans" || w === "boxes" || w === "drums")) return w;
  return BASE_SHORT[measure];
}

const BASE = "__base";

/** A size or a converted figure: grouped where it is large, every decimal where it is small (a Gram is 0.001 kg, not 0). */
function qtyText(n: number): string {
  const t = tidy(n);
  return Math.abs(t) >= 1 || t === 0 ? nf(t) : String(t);
}

/**
 * Whether a quantity box can carry a unit dropdown here: inside the ERP, with
 * a base it recognises. The caller draws its plain box otherwise.
 */
export function useQtyUnits(base: string | undefined): { measure: Measure; ctx: UnitsCtx } | null {
  const ctx = useContext(Units);
  const measure = measureOfBase(base);
  if (!ctx || !measure) return null;
  return { measure, ctx };
}

/**
 * A form's quantity box: the dropdown where the ERP can offer one, and the
 * caller's own plain box (`fallback`) where it cannot — outside the ERP, or a
 * quantity whose item is not picked yet.
 */
export function QtyField(props: React.ComponentProps<typeof QtyUnitInput> & { fallback: React.ReactNode }) {
  const { fallback, ...rest } = props;
  if (!useQtyUnits(rest.base)) return <>{fallback}</>;
  return <QtyUnitInput {...rest} />;
}

export function QtyUnitInput({
  base,
  value,
  onChange,
  error,
  readOnly,
  min,
  max,
  compact,
  inputRef,
  onKeyDown,
  placeholder,
  className,
}: {
  /** The base word the figure is kept in ("Kg", "Litre", "cans"…). */
  base: string;
  /** The figure in the base, as the form holds it. */
  value: string;
  onChange: (base: string) => void;
  error?: boolean;
  readOnly?: boolean;
  min?: number;
  max?: number;
  /** A table cell: no line under the box; the conversion rides on the title. */
  compact?: boolean;
  inputRef?: (el: HTMLInputElement | null) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  className?: string;
}) {
  const q = useQtyUnits(base)!;
  const { measure, ctx } = q;
  /* What was typed and in which unit, kept only while the form still holds the
     figure this box last handed it: a value filled in from elsewhere (an item
     picked, a recipe laid out) is shown as it came, in the base. */
  const [st, setSt] = useState<{ text: string; unit: string; emitted: string }>({ text: value, unit: BASE, emitted: value });
  const live = st.emitted === value;
  const unitId = live ? st.unit : BASE;
  const text = live ? st.text : value;
  const options = unitsFor(ctx.units, measure).filter((u) => !u.builtIn);
  const chosen = unitId === BASE ? null : (ctx.units.find((u) => u.id === unitId) ?? null);
  const per = chosen?.perBase ?? 1;
  const word = baseWord(base, measure);

  const emit = (t: string, id: string, p: number) => {
    const b = baseText(t, p);
    setSt({ text: t, unit: id, emitted: b });
    onChange(b);
  };

  const n = Number(text);
  const converted = chosen && text.trim() && Number.isFinite(n) ? `= ${qtyText(n * per)} ${word}` : "";

  return (
    <span className={cx("block", className)}>
      <span className="flex min-w-0 items-stretch">
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          step="any"
          value={text}
          readOnly={readOnly}
          /* The bounds are on the BASE figure; the browser's own check would
             read them against the typed amount, so they are left to the form. */
          min={chosen ? undefined : min}
          max={chosen ? undefined : max}
          placeholder={placeholder}
          title={converted || undefined}
          onChange={(e) => emit(e.target.value, unitId, per)}
          onKeyDown={onKeyDown}
          className={cx(
            compact ? "" : controlClass({ invalid: !!error, className: "h-8.5" }),
            "min-w-0 flex-1 rounded-r-none",
            readOnly && "bg-canvas text-muted",
            compact && "w-full bg-transparent px-2 py-1.5 text-right tabular-nums outline-none",
          )}
        />
        <UnitPicker
          measure={measure}
          baseLabel={word}
          options={options}
          chosen={chosen}
          disabled={readOnly}
          compact={compact}
          error={error}
          ctx={ctx}
          onPick={(u) => emit(text, u ? u.id : BASE, u ? u.perBase : 1)}
        />
      </span>
      {converted && !compact ? <span className="mt-0.5 block text-meta text-muted tabular-nums">{converted}</span> : null}
    </span>
  );
}

function UnitPicker({
  measure,
  baseLabel,
  options,
  chosen,
  disabled,
  compact,
  error,
  ctx,
  onPick,
}: {
  measure: Measure;
  baseLabel: string;
  options: Uom[];
  chosen: Uom | null;
  disabled?: boolean;
  compact?: boolean;
  error?: boolean;
  ctx: UnitsCtx;
  onPick: (u: Uom | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<{ name: string; per: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ name?: string; perBase?: string; other?: string }>({});
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);

  /* Fixed to the viewport, so a table that scrolls sideways or a dialog body
     that clips cannot cut the list off. It closes on a click elsewhere and on
     a scroll, which would leave it floating away from its box. */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const scrolled = (e: Event) => {
      if (!pop.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", scrolled);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", scrolled);
    };
  }, [open]);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = 260;
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), width });
    setQ("");
    setAdding(null);
    setProblem({});
    setOpen(true);
  };

  const names = [baseLabel, ...options.map((o) => o.name)];
  const shown = q.trim() ? matchOptions(names, q) : names;
  const exact = !!findUom(ctx.units, q) || q.trim().toLowerCase() === baseLabel;

  const save = async () => {
    if (!adding) return;
    const draft = { name: adding.name, measure, perBase: adding.per };
    const p = uomProblems(draft, ctx.units);
    if (p.name || p.perBase) return setProblem(p);
    setBusy(true);
    const res = await erpAddUom(draft);
    setBusy(false);
    if (!res.ok) {
      const f = res.fieldErrors?.[0];
      return setProblem(f && (f.field === "name" || f.field === "perBase") ? { [f.field]: f.message } : { other: res.error });
    }
    ctx.add(res.data);
    onPick(res.data);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="The unit you are typing in"
        onClick={() => (open ? setOpen(false) : show())}
        className={cx(
          "flex flex-none cursor-pointer items-center gap-1 whitespace-nowrap border text-sm",
          compact ? "border-transparent px-1.5 text-meta text-muted hover:text-ink" : "-ml-px h-8.5 rounded-r-control bg-canvas px-2.5 text-body hover:bg-surface",
          !compact && (error ? "border-danger" : "border-line"),
          chosen && "font-medium text-brand-hover",
          disabled && "cursor-default opacity-60",
        )}
      >
        <span className="max-w-[120px] truncate">{chosen ? chosen.name : baseLabel}</span>
        <Icon n="down" s={12} />
      </button>
      {open && at ? (
        <span ref={pop} style={{ top: at.top, left: at.left, width: at.width }} className={cx(popoverClass, "fixed z-[80] block p-1.5")}>
          {adding ? (
            <span className="block p-1.5">
              <span className="mb-2 block text-sm font-semibold text-ink">Add a unit</span>
              <label className="mb-2 block">
                <span className="mb-1 block text-meta text-muted">Name</span>
                <input
                  autoFocus
                  value={adding.name}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                  placeholder={measure === "volume" ? "Drum (200 L)" : measure === "weight" ? "Bag (25 kg)" : "Box of 6"}
                  className={controlClass({ invalid: !!problem.name, className: "h-8" })}
                />
                {problem.name ? <span className="mt-0.5 block text-meta text-danger">{problem.name}</span> : null}
              </label>
              <label className="mb-2 block">
                <span className="mb-1 block text-meta text-muted">One of it is</span>
                <span className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={adding.per}
                    onChange={(e) => setAdding({ ...adding, per: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void save();
                      }
                    }}
                    className={controlClass({ invalid: !!problem.perBase, className: "h-8 flex-1" })}
                  />
                  <span className="text-sm text-muted">{BASE_SHORT[measure]}</span>
                </span>
                {problem.perBase ? <span className="mt-0.5 block text-meta text-danger">{problem.perBase}</span> : null}
              </label>
              {problem.other ? <span className="mb-2 block text-meta text-danger">{problem.other}</span> : null}
              <span className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
                  Back
                </Button>
                <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                  {busy ? "Adding…" : "Add unit"}
                </Button>
              </span>
            </span>
          ) : (
            <>
              <span className="relative mb-1 block">
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setOpen(false);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const first = shown[0];
                      if (first) onPick(first === baseLabel ? null : (options.find((o) => o.name === first) ?? null));
                      else if (ctx.canAdd && q.trim()) return setAdding({ name: q.trim(), per: "" });
                      setOpen(false);
                    }
                  }}
                  placeholder="Search units"
                  className={controlClass({ className: "h-8 pr-8" })}
                />
                <span className="pointer-events-none absolute top-2 right-2.5 flex text-muted">
                  <Icon n="search" s={14} />
                </span>
              </span>
              <span role="listbox" className="block max-h-[240px] overflow-y-auto">
                {shown.map((name) => {
                  const u = name === baseLabel ? null : (options.find((o) => o.name === name) ?? null);
                  const on = (u?.id ?? null) === (chosen?.id ?? null);
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      key={name}
                      onClick={() => {
                        onPick(u);
                        setOpen(false);
                      }}
                      className={cx("flex w-full cursor-pointer items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-sm hover:bg-canvas", on && "bg-brand-soft text-brand-hover")}
                    >
                      <span className="truncate">{name}</span>
                      <span className="flex-none text-meta text-muted">{u ? `${qtyText(u.perBase)} ${baseLabel}` : "as kept"}</span>
                    </button>
                  );
                })}
                {!shown.length ? <span className="block px-2 py-1.5 text-meta text-muted">No unit called that yet</span> : null}
              </span>
              {ctx.canAdd ? (
                <button
                  type="button"
                  onClick={() => setAdding({ name: exact ? "" : q.trim(), per: "" })}
                  className="mt-1 flex w-full cursor-pointer items-center gap-1.5 rounded-control border-t border-divider px-2 pt-2 pb-1.5 text-left text-sm font-medium text-brand-hover hover:bg-canvas"
                >
                  <Icon n="plus" s={14} />
                  {q.trim() && !exact ? `Add “${q.trim()}”` : "Add a unit"}
                </button>
              ) : null}
            </>
          )}
        </span>
      ) : null}
    </>
  );
}
