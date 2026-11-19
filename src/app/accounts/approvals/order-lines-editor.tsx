"use client";

import * as React from "react";
import { Button, DecimalInput, PaiseInput, controlClass, cx } from "@/components/ui/primitives";
import { money } from "@/lib/format";
import { plural } from "../parts";

/* ---------------------------------------------------------------------------
 * THE LINES ACCOUNTS MAY CHANGE while approving (Option A): product, cans,
 * rate, discount, a line added or taken off. One table for the TO review and
 * for Edit order on a numbered order, so the two cannot drift apart. Parties
 * and the godown are drawn by the caller, read-only.
 * ------------------------------------------------------------------------- */

export type EditLine = {
  key: string;
  /** The order line it was — null for a line added here. TOs carry none. */
  lineId?: string | null;
  skuId: string;
  qtyCans: number | null;
  ratePaise: number | null;
  discountPct: number | null;
};

export type OriginalLine = { skuId: string; qtyCans: number; ratePaise: number | null; discountBp: number | null; lineId?: string | null };

export const lineAmount = (l: EditLine) => (l.ratePaise == null || l.qtyCans == null ? null : Math.round(l.ratePaise * l.qtyCans * (1 - (l.discountPct ?? 0) / 100)));

export const discountBpOf = (l: EditLine) => (l.discountPct == null ? null : Math.round(l.discountPct * 100));

/** Whether the lines differ from what was loaded. */
export function linesEdited(lines: EditLine[], original: OriginalLine[]): boolean {
  return (
    lines.length !== original.length ||
    lines.some((l, i) => {
      const o = original[i];
      return !o || (l.lineId ?? null) !== (o.lineId ?? null) || l.skuId !== o.skuId || l.qtyCans !== o.qtyCans || l.ratePaise !== o.ratePaise || discountBpOf(l) !== (o.discountBp ?? null);
    })
  );
}

/** What is wrong with the lines, keyed as the server keys its field errors. A rate is required only to approve. */
export function lineErrors(lines: EditLine[], opts: { rateRequired: boolean }): Record<string, string> {
  const e: Record<string, string> = {};
  lines.forEach((l, i) => {
    if (!l.skuId) e[`l${i}.skuId`] = "Pick the product";
    if (!l.qtyCans || l.qtyCans <= 0 || !Number.isInteger(l.qtyCans)) e[`l${i}.qtyCans`] = "Whole cans above 0";
    if (opts.rateRequired && l.ratePaise == null) e[`l${i}.ratePaise`] = "No rate - add it to approve";
    if (l.discountPct != null && (l.discountPct < 0 || l.discountPct > 100)) e[`l${i}.discountBp`] = "0 to 100";
  });
  if (!lines.length) e.lines = "An order needs at least one line.";
  return e;
}

export function OrderLinesEditor({
  lines,
  setLines,
  products,
  errs,
  editable,
}: {
  lines: EditLine[];
  setLines: React.Dispatch<React.SetStateAction<EditLine[]>>;
  products: { id: string; name: string }[];
  errs: Record<string, string>;
  editable: boolean;
}) {
  const seq = React.useRef(0);
  const total = lines.reduce((n, l) => n + (lineAmount(l) ?? 0), 0);
  const noRate = lines.filter((l) => l.ratePaise == null).length;

  function patch(key: string, p: Partial<EditLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-ink text-left text-[11px] font-semibold tracking-[0.05em] text-white uppercase">
              <th className="px-2.5 py-2">Product</th>
              <th className="px-2.5 py-2">Cans</th>
              <th className="px-2.5 py-2">Rate</th>
              <th className="px-2.5 py-2">Disc. %</th>
              <th className="px-2.5 py-2 text-right">Amount</th>
              {editable ? (
                <th className="px-1 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const amt = lineAmount(l);
              return (
                <tr key={l.key} className="border-b border-divider align-top">
                  <td className="px-1.5 py-1.5">
                    <select aria-label="Product" disabled={!editable} value={l.skuId} onChange={(e) => patch(l.key, { skuId: e.target.value })} className={controlClass({ invalid: !!errs[`l${i}.skuId`], className: "h-8 w-full text-[13px]" })}>
                      <option value="">Pick a product</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {l.ratePaise == null ? <div className="mt-0.5 text-[11.5px] font-semibold text-danger">No rate - add it to approve</div> : null}
                    {errs[`l${i}.skuId`] || errs[`l${i}.qtyCans`] ? <div className="mt-0.5 text-[11.5px] text-danger">{errs[`l${i}.skuId`] ?? errs[`l${i}.qtyCans`]}</div> : null}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <input
                      aria-label="Cans"
                      inputMode="numeric"
                      disabled={!editable}
                      value={l.qtyCans ?? ""}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "");
                        patch(l.key, { qtyCans: v ? Number(v) : null });
                      }}
                      className={controlClass({ invalid: !!errs[`l${i}.qtyCans`], className: "h-8 w-16 text-[13px]" })}
                    />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <PaiseInput aria-label="Rate" disabled={!editable} paise={l.ratePaise} onPaise={(p) => patch(l.key, { ratePaise: p })} placeholder="₹" className={controlClass({ invalid: !!errs[`l${i}.ratePaise`] || l.ratePaise == null, className: cx("h-8 w-24 text-[13px]", l.ratePaise == null ? "border-2 border-brand" : "") })} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <DecimalInput aria-label="Discount" disabled={!editable} value={l.discountPct} onValue={(v) => patch(l.key, { discountPct: v })} invalid={!!errs[`l${i}.discountBp`]} className="h-8 w-16 text-[13px]" />
                  </td>
                  <td className={cx("px-2.5 py-2.5 text-right text-[13px] tabular-nums", amt == null ? "text-faint" : "")}>{amt == null ? "-" : money(amt)}</td>
                  {editable ? (
                    <td className="px-1 py-1.5">
                      <button type="button" aria-label="Remove line" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="cursor-pointer rounded px-1.5 py-1 text-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-40">
                        ×
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {errs.lines ? <p className="text-[12.5px] text-danger">{errs.lines}</p> : null}
      <div className="flex items-center justify-between">
        {editable ? (
          <Button size="sm" onClick={() => setLines((ls) => [...ls, { key: `n${seq.current++}`, lineId: null, skuId: "", qtyCans: null, ratePaise: null, discountPct: null }])}>
            + Add a line
          </Button>
        ) : (
          <span />
        )}
        <div className="text-sm">
          {noRate ? "Total so far " : "Total "}
          <strong>{money(total)}</strong>
          {noRate ? (
            <span className="text-[12.5px] text-muted">
              {" "}
              ({plural(noRate, "line")} {noRate === 1 ? "has" : "have"} no rate)
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}
