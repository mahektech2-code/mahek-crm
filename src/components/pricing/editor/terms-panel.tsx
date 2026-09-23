"use client";

/* ---------------------------------------------------------------------------
 * THE NUMBERED CLAUSES, and the discounts said in words beneath them.
 *
 * Clauses are free text because they are the office's own sentences; the
 * DISCOUNTS are structured, because a discount is a number the order screen
 * and the variance report act on, and a percentage buried in a sentence is a
 * percentage nothing can read. The paper prints both — the clauses first, then
 * one clause per discount, worded so the importer reads the same discount
 * back.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Button, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import type { PriceDiscountKind } from "@/db/schema";
import { DISCOUNT_KIND_LABEL } from "@/lib/price-list-labels";
import { defaultTerms, discountClause, printedClauses, type PriceSheet, type SheetDiscount } from "@/lib/price-sheet";

const KINDS: PriceDiscountKind[] = ["advance_payment", "prompt_payment", "quantity", "other"];

export function TermsPanel({ sheet, onChange }: { sheet: PriceSheet; onChange: (next: PriceSheet, label: string) => void }) {
  const setTerms = (terms: string[], label: string) => onChange({ ...sheet, terms }, label);
  const setDiscounts = (discounts: SheetDiscount[], label: string) => onChange({ ...sheet, discounts }, label);

  return (
    <div className="mx-auto grid max-w-[1100px] gap-6 lg:grid-cols-[1fr_380px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink">Terms &amp; conditions</h3>
            <p className="text-[13px] text-muted">Numbered for you in the order shown. Printed under the grid.</p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTerms(defaultTerms(sheet), "Reset the terms to Mahek's standard")}
              title="Replace these clauses with the office's standard ones, filled in with this list's date, GST and delivery basis"
            >
              Use Mahek&apos;s standard terms
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setTerms([...sheet.terms, ""], "Added a clause")}>
              + Clause
            </Button>
          </div>
        </div>
        {sheet.terms.length === 0 ? (
          <p className="rounded-[6px] border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-muted">
            No clauses. A list with no terms prints straight from the grid to the signature.
          </p>
        ) : (
          <ol className="space-y-2">
            {sheet.terms.map((t, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-2 w-6 flex-none text-right text-[13px] font-medium text-muted">{i + 1}.</span>
                <ClauseBox
                  key={`${i}:${t}`}
                  value={t}
                  onCommit={(v) => setTerms(sheet.terms.map((x, j) => (j === i ? v : x)), "Edited a clause")}
                />
                <div className="flex flex-none flex-col gap-0.5 pt-1">
                  <IconButton
                    label="Move up"
                    disabled={i === 0}
                    onClick={() => {
                      const next = [...sheet.terms];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      setTerms(next, "Moved a clause");
                    }}
                  >
                    ↑
                  </IconButton>
                  <IconButton
                    label="Move down"
                    disabled={i === sheet.terms.length - 1}
                    onClick={() => {
                      const next = [...sheet.terms];
                      [next[i + 1], next[i]] = [next[i], next[i + 1]];
                      setTerms(next, "Moved a clause");
                    }}
                  >
                    ↓
                  </IconButton>
                  <IconButton label="Remove" onClick={() => setTerms(sheet.terms.filter((_, j) => j !== i), "Removed a clause")}>
                    ×
                  </IconButton>
                </div>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-8 mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Discounts</h3>
            <p className="text-[13px] text-muted">Stored as figures, printed as clauses after the terms above.</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDiscounts([...sheet.discounts, { kind: "advance_payment", percentBp: 200, thresholdLitres: null, thresholdPaise: null }], "Added a discount")}
          >
            + Discount
          </Button>
        </div>
        {sheet.discounts.length === 0 ? (
          <p className="text-[13px] text-muted">None. Most of Mahek&apos;s lists carry none; the advance-payment discount is the usual exception.</p>
        ) : (
          <div className="space-y-2">
            {sheet.discounts.map((d, i) => {
              const patch = (p: Partial<SheetDiscount>) => setDiscounts(sheet.discounts.map((x, j) => (j === i ? { ...x, ...p } : x)), "Changed a discount");
              return (
                <div key={i} className="rounded-[6px] border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={d.kind} onChange={(e) => patch({ kind: e.target.value as PriceDiscountKind })}>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {DISCOUNT_KIND_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                    <span className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="0.25"
                        min={0}
                        className="w-[84px]"
                        value={d.percentBp / 100}
                        onChange={(e) => patch({ percentBp: Math.max(1, Math.round(Number(e.target.value || 0) * 100)) })}
                      />
                      <span className="text-[13px] text-muted">%</span>
                    </span>
                    {d.kind === "quantity" ? (
                      <>
                        <span className="text-[13px] text-muted">from</span>
                        <Input
                          type="number"
                          min={0}
                          className="w-[96px]"
                          placeholder="litres"
                          value={d.thresholdLitres ?? ""}
                          onChange={(e) => patch({ thresholdLitres: e.target.value ? Number(e.target.value) : null, thresholdPaise: null })}
                        />
                        <span className="text-[13px] text-muted">litres, or ₹</span>
                        <Input
                          type="number"
                          min={0}
                          className="w-[110px]"
                          placeholder="order value"
                          value={d.thresholdPaise == null ? "" : d.thresholdPaise / 100}
                          onChange={(e) => patch({ thresholdPaise: e.target.value ? Math.round(Number(e.target.value) * 100) : null, thresholdLitres: null })}
                        />
                      </>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setDiscounts(sheet.discounts.filter((_, j) => j !== i), "Removed a discount")}
                      className="ml-auto cursor-pointer text-[13px] text-danger hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <p className="mt-2 text-[12px] text-muted">Prints as: “{discountClause(d)}”</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <aside className="rounded-[6px] border border-line bg-canvas p-4">
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">On the paper</div>
        <div className="mt-2 text-[12px] font-semibold tracking-[0.1em] text-ink">TERMS &amp; CONDITIONS</div>
        <ol className="mt-1.5 space-y-1 text-[11.5px] leading-[17px] text-body">
          {printedClauses(sheet).map((c, i) => (
            <li key={i} className={cx(!c.trim() && "text-danger")}>
              {i + 1}. {c.trim() || "(empty clause — will be left out)"}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

function ClauseBox({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = React.useState(value);
  return (
    <Textarea
      rows={Math.min(5, Math.max(2, Math.ceil(text.length / 95)))}
      value={text}
      placeholder="Type the clause as it should be printed"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
      className="flex-1 text-[13px]"
    />
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[13px] text-muted hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
