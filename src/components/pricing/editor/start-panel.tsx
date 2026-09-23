"use client";

/* ---------------------------------------------------------------------------
 * WHERE A NEW LIST STARTS FROM.
 *
 * Almost no price list is made from nothing. Next month's list is this
 * month's with a few figures moved; "Odisha Paid" is "Odisha To Pay" plus
 * twelve rupees a litre; the office already has most lists in a spreadsheet.
 * So the first step offers those starting points, and each one arrives at the
 * same editor with the grid already filled — the difference between a blank
 * grid and a copied one is only how much typing is left.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Button, Callout, Field, Input, Select, cx } from "@/components/ui/primitives";
import type { PriceDerivation } from "@/db/schema";
import { parseCsv } from "@/lib/csv";
import { csvToCells, type CsvImport, type PriceSheet, type SheetProduct } from "@/lib/price-sheet";
import type { PricingOptions } from "@/lib/price-list-views";
import type { StartSource } from "@/components/pricing/editor/editor-state";

export type StartChoice =
  | { source: "blank" }
  | { source: "catalogue" }
  | { source: "copy"; listId: string }
  | { source: "derive"; listId: string; rule: PriceDerivation }
  | { source: "csv"; cells: CsvImport["cells"]; filename: string };

const CARDS: Array<{ source: StartSource; title: string; body: string }> = [
  { source: "copy", title: "Copy a list", body: "Start from an existing list — every price, clause and discount — and change what has moved." },
  { source: "derive", title: "Derive from a list", body: "Every price moved by one rule: +₹12 a litre, +4%, +₹200 a can. How Odisha Paid is made from Odisha To Pay." },
  { source: "csv", title: "From a spreadsheet", body: "A CSV with a product and a price per row. The export of any list here reads straight back in." },
  { source: "catalogue", title: "Every active product", body: "Every line the catalogue sells, in every pack, waiting for prices." },
  { source: "blank", title: "Blank sheet", body: "Pick the product lines yourself and type the prices." },
];

export function StartPanel({
  initial,
  lists,
  products,
  taxBasis,
  gstBp,
  onStart,
  busy,
}: {
  initial: StartSource;
  lists: PricingOptions["lists"];
  products: SheetProduct[];
  taxBasis: PriceSheet["taxBasis"];
  gstBp: number;
  onStart: (choice: StartChoice) => void;
  busy: boolean;
}) {
  const [source, setSource] = React.useState<StartSource>(initial);
  const [listId, setListId] = React.useState("");
  const [ruleKind, setRuleKind] = React.useState<PriceDerivation["kind"]>("per_litre_paise");
  const [amount, setAmount] = React.useState("12");
  const [csv, setCsv] = React.useState<(CsvImport & { filename: string }) | null>(null);
  const [csvError, setCsvError] = React.useState<string | null>(null);

  async function readFile(file: File | undefined) {
    if (!file) return;
    setCsvError(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) throw new Error("That file has no rows under its header.");
      setCsv({ ...csvToCells(rows, products, taxBasis, gstBp), filename: file.name });
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : "That file could not be read.");
    }
  }

  const n = Number(amount);
  const rule: PriceDerivation | null =
    !amount.trim() || !Number.isFinite(n)
      ? null
      : ruleKind === "percent_bp"
        ? { kind: "percent_bp", bp: Math.round(n * 100) }
        : ruleKind === "per_litre_paise"
          ? { kind: "per_litre_paise", paise: Math.round(n * 100) }
          : { kind: "per_can_paise", paise: Math.round(n * 100) };

  const ready =
    source === "blank" ||
    source === "catalogue" ||
    (source === "copy" && !!listId) ||
    (source === "derive" && !!listId && !!rule) ||
    (source === "csv" && !!csv?.cells.length);

  function go() {
    if (!ready) return;
    if (source === "copy") onStart({ source, listId });
    else if (source === "derive") onStart({ source, listId, rule: rule! });
    else if (source === "csv") onStart({ source, cells: csv!.cells, filename: csv!.filename });
    else onStart({ source } as StartChoice);
  }

  return (
    <div className="mx-auto max-w-[980px]">
      <h3 className="text-[15px] font-semibold text-ink">Where should this list start from?</h3>
      <p className="mt-1 text-[13px] text-muted">Every start leads to the same editor. You can change any price, line or pack afterwards.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <button
            key={c.source}
            type="button"
            onClick={() => setSource(c.source)}
            className={cx(
              "cursor-pointer rounded-[8px] border p-4 text-left transition-colors",
              source === c.source ? "border-brand bg-brand-soft" : "border-line bg-surface hover:border-line-strong",
            )}
          >
            <div className="text-sm font-semibold text-ink">{c.title}</div>
            <div className="mt-1 text-[12.5px] leading-[18px] text-muted">{c.body}</div>
          </button>
        ))}
      </div>

      <div className="mt-5 rounded-[8px] border border-line bg-canvas p-4">
        {source === "copy" || source === "derive" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={source === "copy" ? "Copy" : "Derive from"}>
              <Select value={listId} onChange={(e) => setListId(e.target.value)} className="w-full">
                <option value="">Choose a list…</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} — v{l.version}, {l.status}
                  </option>
                ))}
              </Select>
            </Field>
            {source === "derive" ? (
              <Field
                label="By the rule"
                hint={
                  ruleKind === "per_litre_paise"
                    ? `A 20 L can moves by ₹${Number.isFinite(n) ? n * 20 : "—"}, a 1 L can by ₹${Number.isFinite(n) ? n : "—"}. Worked ex-GST.`
                    : ruleKind === "percent_bp"
                      ? "Every price moves by the same share. Negative lowers."
                      : "The same amount on every can, whatever its size."
                }
              >
                <div className="flex gap-2">
                  <Select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as PriceDerivation["kind"])}>
                    <option value="per_litre_paise">₹ per litre</option>
                    <option value="percent_bp">% on every price</option>
                    <option value="per_can_paise">₹ per can</option>
                  </Select>
                  <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-[110px]" />
                </div>
              </Field>
            ) : null}
            {source === "derive" ? (
              <p className="text-[12.5px] text-muted sm:col-span-2">
                The new list remembers its parent and the rule, so on publish it is checked against both — a price typed
                over the rule afterwards is allowed, and flagged.
              </p>
            ) : null}
          </div>
        ) : source === "csv" ? (
          <div>
            <Field label="Spreadsheet (CSV)" hint="Columns: Product ID or Product (the catalogue name), and Rate incl GST (Rs) or Rate ex GST (Rs). Optional: Offered, Printed name.">
              <input type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} className="block text-[13px]" />
            </Field>
            {csvError ? <Callout tone="danger" className="mt-3">{csvError}</Callout> : null}
            {csv ? (
              <div className="mt-3 text-[13px]">
                <p className="text-body">
                  Read <span className="font-medium">{csv.read}</span> rows from {csv.filename}:{" "}
                  <span className="font-medium text-success">{csv.cells.length} matched</span>
                  {csv.unmatched.length ? (
                    <>
                      , <span className="font-medium text-danger">{csv.unmatched.length} not matched</span> and left out
                    </>
                  ) : null}
                  .
                </p>
                {csv.unmatched.length ? (
                  <ul className="mt-2 max-h-[160px] overflow-auto rounded-[4px] border border-line bg-surface text-[12px]">
                    {csv.unmatched.map((u) => (
                      <li key={u.line} className="border-b border-divider px-2.5 py-1 last:border-b-0">
                        Line {u.line}: <span className="font-medium">{u.product}</span> — {u.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : source === "catalogue" ? (
          <p className="text-[13px] text-body">
            Every active line in the catalogue, {products.filter((p) => p.active).length} SKUs in all, laid out as the
            paper lays them out. Remove what this list does not carry.
          </p>
        ) : (
          <p className="text-[13px] text-body">An empty grid. Add the product lines this list prices from the Rates step.</p>
        )}
      </div>

      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={go} disabled={!ready || busy}>
          {busy ? "Preparing…" : "Continue to the details"}
        </Button>
      </div>
    </div>
  );
}
